package dao

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/common"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
)

var ErrChatMediaReclaimed = errors.New("media resource is being reclaimed")

// LockChatMediaAssets is the shared reference/deletion barrier. Callers lock
// sessions and tasks first, then all required assets in ID order, then refs.
// The state is read under the lock, never from a prior snapshot.
func LockChatMediaAssets(tx *gorm.DB, ids ...string) (map[string]*entity.ChatMediaAsset, error) {
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	assets := make(map[string]*entity.ChatMediaAsset, len(ids))
	for _, id := range ids {
		if id == "" || assets[id] != nil {
			continue
		}
		var asset entity.ChatMediaAsset
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&asset, "id = ?", id).Error; err != nil {
			return nil, err
		}
		assets[id] = &asset
	}
	return assets, nil
}

// ReferenceChatMedia must run in the transaction that owns the message/task.
// Existing references do not authorize resurrecting a deleting object.
func ReferenceChatMedia(tx *gorm.DB, refs ...entity.ChatMediaReference) error {
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.AssetID)
	}
	assets, err := LockChatMediaAssets(tx, ids...)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		asset := assets[ref.AssetID]
		if asset == nil || (asset.State != "committed" && (asset.State != "staging" || ref.OwnerKind != "task")) {
			return ErrChatMediaReclaimed
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ref).Error; err != nil {
			return err
		}
	}
	return nil
}

func journalChatMedia(tx *gorm.DB, asset *entity.ChatMediaAsset, now int64) error {
	record := entity.ChatMediaCleanup{
		ID: common.GenerateToken(), AssetID: asset.ID, Bucket: asset.Bucket,
		ObjectKey: asset.ObjectKey, StoreScope: asset.Bucket, State: "pending",
		NextRunAt: now, CreatedAt: now,
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&record).Error
}

// The caller holds the session row, as do task output commits.
func unlinkChatMedia(tx *gorm.DB, sessionID, turnID string) error {
	now, err := databaseTime(tx)
	if err != nil {
		return err
	}
	query := tx.Where("session_id = ?", sessionID)
	if turnID != "" {
		query = query.Where("turn_id = ?", turnID)
	}
	var tasks []entity.ChatTask
	if err := query.Session(&gorm.Session{}).Clauses(clause.Locking{Strength: "UPDATE"}).
		Order("id").Find(&tasks).Error; err != nil {
		return err
	}
	for i := range tasks {
		task := &tasks[i]
		if err := cancelChatTask(tx, task, now); err != nil {
			return err
		}
	}
	var refs []entity.ChatMediaReference
	refQuery := tx.Where("owner_kind = ?", "message")
	if turnID == "" {
		// Compare the session prefix, without interpreting caller text as LIKE.
		refQuery = refQuery.Where("owner_id IN (?)", tx.Model(&entity.ConversationMessage{}).
			Select("DISTINCT "+chatMediaOwnerExpression(tx)).Where("conversation_id = ? AND message_id IS NOT NULL", sessionID))
	} else {
		refQuery = refQuery.Where("owner_id = ?", sessionID+":"+turnID)
	}
	if err := refQuery.Find(&refs).Error; err != nil {
		return err
	}
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.AssetID)
	}
	var assets []entity.ChatMediaAsset
	if err := query.Session(&gorm.Session{}).Find(&assets).Error; err != nil {
		return err
	}
	for _, asset := range assets {
		ids = append(ids, asset.ID)
	}
	locked, err := LockChatMediaAssets(tx, ids...)
	if err != nil {
		return err
	}
	for _, asset := range locked {
		if err := journalChatMedia(tx, asset, now); err != nil {
			return err
		}
	}
	for _, ref := range refs {
		if err := tx.Delete(&ref).Error; err != nil {
			return err
		}
	}
	return nil
}

func chatMediaOwnerExpression(tx *gorm.DB) string {
	if tx.Dialector.Name() == "mysql" {
		return "CONCAT(conversation_id, ':', message_id)"
	}
	return "conversation_id || ':' || message_id"
}

func registerChatUploads(ctx context.Context, tx *gorm.DB, sessionID string, message map[string]interface{}) error {
	return RegisterChatMediaInputs(ctx, tx, sessionID, message)
}

// RegisterChatMediaInputs locks the union of uploaded and existing inputs in
// one order. Splitting these into separate reference batches can deadlock.
func RegisterChatMediaInputs(ctx context.Context, tx *gorm.DB, sessionID string, message map[string]interface{}, refs ...entity.ChatMediaReference) error {
	turnID, _ := message["id"].(string)
	raw, err := json.Marshal(message["files"])
	if err != nil {
		return err
	}
	var files []struct {
		ID        string `json:"id"`
		CreatedBy string `json:"created_by"`
		MIMEType  string `json:"mime_type"`
	}
	if message["role"] == "user" && turnID != "" {
		_ = json.Unmarshal(raw, &files)
	}
	uploads := make(map[string]entity.ChatMediaAsset, len(files))
	refs = append([]entity.ChatMediaReference(nil), refs...)
	ids := make([]string, 0, len(files)+len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.AssetID)
	}
	for i, file := range files {
		if file.ID == "" || file.CreatedBy == "" || file.CreatedBy != permission.UserIDFromContext(ctx) {
			continue
		}
		bucket := file.CreatedBy + "-downloads"
		sum := sha256.Sum256([]byte(bucket + "\x00" + file.ID))
		id := hex.EncodeToString(sum[:16])
		asset := entity.ChatMediaAsset{ID: id, SourceKey: "upload:" + hex.EncodeToString(sum[:]),
			TenantID: permission.TenantIDFromContext(ctx), SessionID: sessionID, TurnID: turnID,
			Kind: "upload", Bucket: bucket, ObjectKey: file.ID, MIMEType: file.MIMEType,
			State: "committed", CreatedAt: time.Now().UnixMilli()}
		uploads[id] = asset
		ids = append(ids, id)
		refs = append(refs, entity.ChatMediaReference{
			AssetID: id, OwnerKind: "message", OwnerID: sessionID + ":" + turnID, Position: i})
	}
	sort.Strings(ids)
	for i, id := range ids {
		if id == "" || i > 0 && id == ids[i-1] {
			continue
		}
		if upload, ok := uploads[id]; ok {
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&upload).Error; err != nil {
				return err
			}
		}
		assets, err := LockChatMediaAssets(tx, id)
		if err != nil {
			return err
		}
		if _, upload := uploads[id]; upload && assets[id].State != "committed" {
			return ErrChatMediaReclaimed
		}
	}
	return ReferenceChatMedia(tx, refs...)
}

// CleanupMedia retains objects while any message, child version or live task
// needs them. Storage removal and journal updates are retried together.
func (d *ChatTaskDAO) CleanupMedia(ctx context.Context, store storage.Storage, grace time.Duration, limit int) error {
	if store == nil || grace < 0 || limit < 1 || limit > 1000 {
		return errors.New("invalid media cleanup configuration")
	}
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return err
	}
	// Discover every journaled staging object, including a crash immediately
	// after Put and before a message reference was committed.
	var staging []entity.ChatMediaAsset
	if err := d.db.WithContext(ctx).Where("state = ? AND created_at <= ?", "staging", now-grace.Milliseconds()).
		Order("created_at").Limit(limit).Find(&staging).Error; err != nil {
		return err
	}
	for i := range staging {
		if err := journalChatMedia(d.db.WithContext(ctx), &staging[i], now); err != nil {
			return err
		}
	}
	var records []entity.ChatMediaCleanup
	if err := d.db.WithContext(ctx).Where("state <> ? AND next_run_at <= ? AND created_at <= ?", "done", now, now-grace.Milliseconds()).
		Order("next_run_at").Order("id").Limit(limit).Find(&records).Error; err != nil {
		return err
	}
	for _, record := range records {
		if err := d.cleanupMediaObject(ctx, store, record.ID); err != nil {
			return err
		}
	}
	return nil
}

func (d *ChatTaskDAO) cleanupMediaObject(ctx context.Context, store storage.Storage, id string) error {
	var record entity.ChatMediaCleanup
	remove := false
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Take(&record, "id = ?", id).Error; err != nil {
			return err
		}
		var snapshot entity.ChatMediaAsset
		if err := tx.Take(&snapshot, "id = ?", record.AssetID).Error; err != nil {
			return err
		}
		var discovered []entity.ChatMediaReference
		if err := tx.Where("asset_id = ? AND owner_kind = ?", snapshot.ID, "task").Find(&discovered).Error; err != nil {
			return err
		}
		taskIDs := []string{snapshot.TaskID}
		for _, ref := range discovered {
			taskIDs = append(taskIDs, ref.OwnerID)
		}
		sort.Strings(taskIDs)
		tasks := map[string]*entity.ChatTask{}
		for _, taskID := range taskIDs {
			if taskID == "" || tasks[taskID] != nil {
				continue
			}
			var task entity.ChatTask
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&task, "id = ?", taskID).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			tasks[taskID] = &task
		}
		now, err := databaseTime(tx)
		if err != nil {
			return err
		}
		var asset entity.ChatMediaAsset
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&asset, "id = ?", record.AssetID).Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&record, "id = ?", id).Error; err != nil {
			return err
		}
		if record.State == "done" || record.NextRunAt > now {
			return nil
		}
		var refs []entity.ChatMediaReference
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("asset_id = ?", asset.ID).Find(&refs).Error; err != nil {
			return err
		}
		retained := false
		for _, ref := range refs {
			if ref.OwnerKind != "task" {
				retained = true
				continue
			}
			task := tasks[ref.OwnerID]
			// A new ref committed between discovery and the asset lock. Retain
			// it this pass instead of reversing task -> asset lock order.
			if task == nil || task.ID != "" && chatTaskRetainsMedia(task) {
				retained = true
			} else if err := tx.Delete(&ref).Error; err != nil {
				return err
			}
		}
		if asset.TaskID != "" {
			task := tasks[asset.TaskID]
			retained = retained || task != nil && task.ID != "" && chatTaskRetainsMedia(task)
		}
		record.NextRunAt = now + time.Minute.Milliseconds()
		if retained {
			return tx.Save(&record).Error
		}
		asset.State = "deleting"
		if err := tx.Save(&asset).Error; err != nil {
			return err
		}
		record.Attempts++
		record.State = "removing"
		// A bounded ownership window prevents another scanner duplicating a
		// slow removal. A crash leaves deleting + a retryable journal.
		remove = true
		return tx.Save(&record).Error
	})
	if err != nil || !remove {
		return err
	}
	removeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	removeErr := store.Remove(removeCtx, record.Bucket, record.ObjectKey)
	cancel()
	finishCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	return d.db.WithContext(finishCtx).Transaction(func(tx *gorm.DB) error {
		// Parent locks use the same sorted order as output commits.
		var parents []entity.ChatMediaReference
		if err := tx.Where("owner_kind = ? AND owner_id = ?", "parent", record.AssetID).Find(&parents).Error; err != nil {
			return err
		}
		ids := []string{record.AssetID}
		for _, ref := range parents {
			ids = append(ids, ref.AssetID)
		}
		assets, err := LockChatMediaAssets(tx, ids...)
		if err != nil {
			return err
		}
		var current entity.ChatMediaCleanup
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&current, "id = ?", id).Error; err != nil {
			return err
		}
		if current.Attempts != record.Attempts || current.State != "removing" {
			return nil
		}
		now, err := databaseTime(tx)
		if err != nil {
			return err
		}
		if removeErr != nil {
			current.State, current.LastError = "retry", "storage_remove_failed"
			current.NextRunAt = now + min(time.Hour, time.Second*time.Duration(1<<min(current.Attempts, 12))).Milliseconds()
			return tx.Save(&current).Error
		}
		asset := assets[record.AssetID]
		asset.State, current.State, current.LastError = "deleted", "done", ""
		for _, ref := range parents {
			if err := journalChatMedia(tx, assets[ref.AssetID], now); err != nil {
				return err
			}
			if err := tx.Delete(&ref).Error; err != nil {
				return err
			}
		}
		if err := tx.Save(asset).Error; err != nil {
			return err
		}
		return tx.Save(&current).Error
	})
}

func chatTaskRetainsMedia(task *entity.ChatTask) bool {
	return !IsChatTaskTerminal(task.State) || task.UpstreamStatus == "running" || task.UpstreamStatus == "unknown"
}
