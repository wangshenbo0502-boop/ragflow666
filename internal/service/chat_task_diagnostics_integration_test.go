//go:build integration

package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/storage"
)

type chatDiagnosticSnapshotKey struct{}

func verifyChatTaskDiagnosticsSnapshot(t *testing.T, ctx context.Context, db *gorm.DB, svc *ChatSessionService, d *dao.ChatTaskDAO) {
	t.Helper()
	chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	id := common.GenerateToken()
	task, _, err := d.Submit(ctx, &entity.ChatTask{
		ID: id, TenantID: "owner", UserID: "owner", ChatID: chat.ID, SessionID: session.ID,
		TurnID: id, Kind: "voice", Input: "{}", InputHash: strings.Repeat("d", 64), IdempotencyKey: id,
		MaxCalls: 8, MaxStageCalls: 4, MaxSwitches: 1,
		QueueDeadline: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(2 * time.Minute).UnixMilli(),
	}, 1000, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err = d.Claim(ctx, id, "diagnostics", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	callback := "diagnostics_" + id
	if err := db.Callback().Query().Before("gorm:query").Register(callback, func(query *gorm.DB) {
		if query.Statement.Table == "chat_task_attempt" && query.Statement.Context.Value(chatDiagnosticSnapshotKey{}) == id {
			close(entered)
			select {
			case <-release:
			case <-query.Statement.Context.Done():
				query.AddError(query.Statement.Context.Err())
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove(callback)
	type readResult struct {
		details *dao.ChatTaskDetails
		err     error
	}
	done := make(chan readResult, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		details, err := d.Details(context.WithValue(ctx, chatDiagnosticSnapshotKey{}, id), id)
		done <- readResult{details, err}
	}()
	released := false
	defer func() {
		if !released {
			close(release)
		}
		<-finished
	}()
	select {
	case <-entered:
	case result := <-done:
		t.Fatalf("snapshot ended before the attempt read: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	attempt, err := d.ReserveCall(ctx, id, task.LeaseOwner, task.LeaseEpoch,
		dao.ChatTaskCall{Stage: "language", Model: "qualified-backup", Reason: "service_unavailable", Switch: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SettleCall(ctx, id, task.LeaseOwner, task.LeaseEpoch, attempt.ID, "succeeded", "stopped", 0,
		entity.JSONMap{"input_tokens": 17, "output_tokens": 3, "total_tokens": 20}, ""); err != nil {
		t.Fatal(err)
	}
	phaseCtx := context.WithValue(ctx, chatTaskExecutionKey{}, &chatTaskExecution{
		dao: d, task: task, owner: task.LeaseOwner,
	})
	finishRetrieval := measureChatTaskPhase(phaseCtx, "retrieval")
	finishRetrieval()
	finishRetrieval()
	close(release)
	released = true
	snapshot := <-done
	if snapshot.err != nil {
		t.Fatal(snapshot.err)
	}
	if snapshot.details.Task.Calls != 0 || len(snapshot.details.Attempts) != 0 ||
		snapshot.details.Task.EventSeq != task.EventSeq {
		t.Fatal("snapshot mixed the old task with a newly committed attempt")
	}
	old := describeChatTask(snapshot.details)
	if !old.EventHistoryComplete || old.Switches != 0 || len(old.Stages) != 0 || len(old.Phases) != 0 {
		t.Fatal("old snapshot included a later switch/attempt event")
	}
	result, err := svc.GetChatTask(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	latest := result["diagnostics"].(chatTaskDiagnostics)
	language := latest.Stages["language"]
	if latest.Switches != 1 || latest.SwitchedSucceeded != 1 || !latest.SwitchDetailsComplete ||
		!latest.EventHistoryComplete || language == nil || language.Attempts != 1 || language.Succeeded != 1 ||
		language.Usage["total_tokens"] != 20 || latest.FirstTextMs != nil ||
		latest.Phases["retrieval"] == nil || latest.Phases["retrieval"].Samples != 1 {
		t.Fatalf("fresh real MySQL diagnostics missed the committed attempt: %+v", latest)
	}
	if err := d.Mutate(ctx, id, task.LeaseOwner, task.LeaseEpoch, "task_terminal",
		func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
			current.State = "succeeded"
			return entity.JSONMap{"state": current.State}, nil
		}); err != nil {
		t.Fatal(err)
	}
	t.Logf("task=%s old_seq=%d old_calls=0 fresh_calls=1 switched_succeeded=%d tokens=%d",
		id, snapshot.details.Task.EventSeq, latest.SwitchedSucceeded, language.Usage["total_tokens"])
}

func verifyChatTaskOperationalStatistics(t *testing.T, ctx context.Context, db *gorm.DB, store storage.Storage, d *dao.ChatTaskDAO) {
	t.Helper()
	before, err := d.Statistics(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	id := common.GenerateToken()
	asset := &entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: "owner", SessionID: id,
		TurnID: id, Kind: "audio", Bucket: chatMediaBucket, ObjectKey: id + "/statistics.wav",
		State: "staging", CreatedAt: before.ObservedAt - time.Hour.Milliseconds()}
	if err := db.Create(asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, []byte("statistics-owned-object")); err != nil {
		t.Fatal("cannot create real cleanup statistics object")
	}
	staged, err := d.Statistics(ctx, 0)
	if err != nil || staged.UnreferencedMedia != before.UnreferencedMedia+1 ||
		staged.ReclaimableMedia != before.ReclaimableMedia+1 || staged.CleanupPending != before.CleanupPending {
		t.Fatalf("unjournaled orphan was hidden or reported as journaled: %+v %v", staged, err)
	}
	record := entity.ChatMediaCleanup{ID: id, AssetID: id, Bucket: asset.Bucket,
		ObjectKey: asset.ObjectKey, StoreScope: asset.Bucket, State: "retry", Attempts: 1,
		LastError: "storage_remove_failed", CreatedAt: asset.CreatedAt}
	if err := db.Create(&record).Error; err != nil {
		t.Fatal(err)
	}
	retry, err := d.Statistics(ctx, 0)
	if err != nil || retry.CleanupPending != before.CleanupPending+1 || retry.CleanupRetries != before.CleanupRetries+1 ||
		retry.CleanupOldestMs < time.Hour.Milliseconds() {
		t.Fatalf("real cleanup retry missing from backlog: %+v %v", retry, err)
	}
	if err := d.CleanupMedia(ctx, store, 0, 1000); err != nil {
		t.Fatal(err)
	}
	cleaned, err := d.Statistics(ctx, 0)
	if err != nil || cleaned.UnreferencedMedia > before.UnreferencedMedia ||
		cleaned.ReclaimableMedia > before.ReclaimableMedia {
		t.Fatalf("successful real removal did not clear its backlog: %+v %v", cleaned, err)
	}
	if db.Take(asset, "id = ?", id).Error != nil || asset.State != "deleted" ||
		db.Take(&record, "id = ?", id).Error != nil || record.State != "done" || record.LastError != "" {
		t.Fatal("real cleanup did not settle its asset and journal")
	}
	exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	if err != nil || exists {
		t.Fatal("statistics reported cleanup success while the real object remained")
	}
	t.Logf("real MySQL/MinIO: orphan +1, journal backlog +1/retry +1; object removed and journal settled; observed_at=%d", cleaned.ObservedAt)
}
