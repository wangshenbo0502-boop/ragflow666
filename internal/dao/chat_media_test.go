package dao

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
)

func TestChatMediaStagingReferencesStayInternal(t *testing.T) {
	_, db := setupChatTaskTest(t)
	ctx := permission.WithIdentity(t.Context(), "user", "tenant")
	for _, state := range []string{"staging", "committed", "deleting", "deleted"} {
		for _, owner := range []string{"task", "message", "parent"} {
			t.Run(state+"/"+owner, func(t *testing.T) {
				id := state + "-" + owner
				asset := entity.ChatMediaAsset{ID: id, SourceKey: id, State: state}
				if err := db.Create(&asset).Error; err != nil {
					t.Fatal(err)
				}
				ref := entity.ChatMediaReference{AssetID: id, OwnerKind: owner, OwnerID: "owner"}
				err := db.Transaction(func(tx *gorm.DB) error {
					return RegisterChatMediaInputs(ctx, tx, "session", nil, ref)
				})
				allowed := state == "committed" || state == "staging" && owner == "task"
				if allowed && err != nil || !allowed && !errors.Is(err, ErrChatMediaReclaimed) {
					t.Fatalf("reference permission: allowed=%t error=%v", allowed, err)
				}
				var count int64
				if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", id).Count(&count).Error; err != nil {
					t.Fatal(err)
				}
				if allowed && count != 1 || !allowed && count != 0 {
					t.Fatalf("unexpected persisted references: %d", count)
				}
			})
		}
	}
	t.Run("upload_cannot_publish_staging", func(t *testing.T) {
		sum := sha256.Sum256([]byte("user-downloads\x00file"))
		id := hex.EncodeToString(sum[:16])
		asset := entity.ChatMediaAsset{ID: id, SourceKey: "upload-staging", State: "staging"}
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
		message := map[string]interface{}{"id": "turn", "role": "user",
			"files": []map[string]interface{}{{"id": "file", "created_by": "user"}}}
		err := db.Transaction(func(tx *gorm.DB) error {
			return RegisterChatMediaInputs(ctx, tx, "session", message,
				entity.ChatMediaReference{AssetID: id, OwnerKind: "task", OwnerID: "task"})
		})
		if !errors.Is(err, ErrChatMediaReclaimed) {
			t.Fatalf("staging upload accepted: %v", err)
		}
		var count int64
		if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", id).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("staging upload became visible")
		}
	})
}

func TestChatMediaSharedUploadsSurviveUntilLastReference(t *testing.T) {
	_, db := setupChatTaskTest(t)
	ctx := permission.WithIdentity(t.Context(), "user", "tenant")
	store := storage.NewMemoryStorage()
	if err := store.Put(ctx, "user-downloads", "file", []byte("source")); err != nil {
		t.Fatal(err)
	}
	sessions := NewChatSessionDAO()
	for _, id := range []string{"first-session", "second-session"} {
		session := &entity.ChatSession{ID: id, DialogID: "chat",
			Message: json.RawMessage(`[{"id":"question","role":"user","files":[{"id":"file","created_by":"user","mime_type":"text/plain"}]}]`)}
		if err := sessions.Create(ctx, db, session); err != nil {
			t.Fatal(err)
		}
	}
	d := NewChatTaskDAO(db)
	if err := sessions.DeleteByID(ctx, db, "first-session"); err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(ctx, store, 0, 100); err != nil {
		t.Fatal(err)
	}
	if !store.ObjExist(ctx, "user-downloads", "file") {
		t.Fatal("deleting one session removed another session's attachment")
	}
	if err := sessions.DeleteByID(ctx, db, "second-session"); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatMediaCleanup{}).Where("state = ?", "pending").Update("next_run_at", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(ctx, store, 0, 100); err != nil {
		t.Fatal(err)
	}
	if store.ObjExist(ctx, "user-downloads", "file") {
		t.Fatal("unreferenced attachment was not collected")
	}
}

func TestChatMediaDeletionCancelsAndFencesLateWrites(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "task")
	task := claimTaskForTest(t, d, "task")
	attempt, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch,
		ChatTaskCall{Stage: "image", Model: "image", Resources: []string{"gpu"}})
	if err != nil {
		t.Fatal(err)
	}
	asset := entity.ChatMediaAsset{ID: "asset", SourceKey: "source", TenantID: task.TenantID,
		SessionID: task.SessionID, TurnID: task.TurnID, TaskID: task.ID, State: "staging",
		Bucket: "chat-media", ObjectKey: "asset", CreatedAt: 1}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	store := storage.NewMemoryStorage()
	if err := store.Put(t.Context(), asset.Bucket, asset.ObjectKey, []byte("result")); err != nil {
		t.Fatal(err)
	}
	if err := NewChatSessionDAO().DeleteByID(t.Context(), db, task.SessionID); err != nil {
		t.Fatal(err)
	}
	called := false
	err = d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "output_committed",
		func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error) {
			called = true
			return nil, nil
		})
	if err == nil || called {
		t.Fatal("deleted session accepted a late output")
	}
	if err := d.CleanupMedia(t.Context(), store, 0, 100); err != nil {
		t.Fatal(err)
	}
	if !store.ObjExist(t.Context(), asset.Bucket, asset.ObjectKey) {
		t.Fatal("cleanup removed an object while its upstream was unknown")
	}
	if err := d.SettleCall(t.Context(), task.ID, "worker", task.LeaseEpoch, attempt.ID, "failed", "stopped", 0, nil, "cancelled"); err != nil {
		t.Fatal(err)
	}
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "task_terminal",
		func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			task.State = "cancelled"
			return nil, nil
		}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatMediaCleanup{}).Where("state = ?", "pending").Update("next_run_at", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(t.Context(), store, 0, 100); err != nil {
		t.Fatal(err)
	}
	if store.ObjExist(t.Context(), asset.Bucket, asset.ObjectKey) {
		t.Fatal("orphaned staging output was not collected after cancellation")
	}
}

type failingMediaRemover struct {
	storage.Storage
	fail bool
}

func (s *failingMediaRemover) Remove(ctx context.Context, bucket, key string, tenantID ...string) error {
	if s.fail {
		return errors.New("unavailable")
	}
	return s.Storage.Remove(ctx, bucket, key, tenantID...)
}

func TestChatMediaCleanupRetriesAndRetainsEditParents(t *testing.T) {
	d, db := setupChatTaskTest(t)
	store := &failingMediaRemover{Storage: storage.NewMemoryStorage(), fail: true}
	for _, id := range []string{"parent", "child"} {
		asset := entity.ChatMediaAsset{ID: id, SourceKey: id, Bucket: "media", ObjectKey: id, State: "committed"}
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
		if err := journalChatMedia(db, &asset, 1); err != nil {
			t.Fatal(err)
		}
		if err := store.Put(t.Context(), "media", id, []byte(id)); err != nil {
			t.Fatal(err)
		}
	}
	ref := entity.ChatMediaReference{AssetID: "parent", OwnerKind: "parent", OwnerID: "child"}
	if err := db.Create(&ref).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(t.Context(), store, 0, 100); err != nil {
		t.Fatal(err)
	}
	var child entity.ChatMediaCleanup
	if err := db.Take(&child, "asset_id = ?", "child").Error; err != nil {
		t.Fatal(err)
	}
	if child.State != "retry" || child.Attempts != 1 || !store.ObjExist(t.Context(), "media", "parent") {
		t.Fatalf("incorrect cleanup state: %+v", child)
	}
	store.fail = false
	for i := 0; i < 2; i++ {
		if err := db.Model(&entity.ChatMediaCleanup{}).Where("state <> ?", "done").Update("next_run_at", 0).Error; err != nil {
			t.Fatal(err)
		}
		if err := d.CleanupMedia(t.Context(), store, 0, 100); err != nil {
			t.Fatal(err)
		}
	}
	if store.ObjExist(t.Context(), "media", "parent") || store.ObjExist(t.Context(), "media", "child") {
		t.Fatal("child and unreferenced parent were not collected")
	}
	if err := d.CleanupMedia(t.Context(), store, time.Second, 100); err != nil {
		t.Fatal(err)
	}
}
