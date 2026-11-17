package dao

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/entity"
)

func setupChatTaskTest(t *testing.T) (*ChatTaskDAO, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&entity.Tenant{}, &entity.ChatSession{}, &entity.ConversationMessage{},
		&entity.ConversationReference{}, &entity.ChatTask{}, &entity.ChatTaskEvent{},
		&entity.ChatMediaAsset{}, &entity.ChatMediaReference{}, &entity.ChatMediaCleanup{},
		&entity.ChatTaskAttempt{}, &entity.ChatTaskResource{}, &entity.ChatTaskResourceLease{}); err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&entity.Tenant{ID: "tenant"},
		&entity.ChatSession{ID: "session", DialogID: "chat"},
		&entity.ChatTaskResource{ID: "gpu", Capacity: 1},
		&entity.ChatTaskResource{ID: "provider", Capacity: 1},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	return NewChatTaskDAO(db), db
}

func taskForTest(id string) *entity.ChatTask {
	now := time.Now().UnixMilli()
	return &entity.ChatTask{
		ID: id, TenantID: "tenant", UserID: "user", ChatID: "chat", SessionID: "session",
		TurnID: "turn-" + id, IdempotencyKey: id, InputHash: strings.Repeat("a", 64), Input: `{}`,
		Kind: "speech", MaxCalls: 4, MaxStageCalls: 2, MaxSwitches: 1,
		QueueDeadline: now + 60000, Deadline: now + 120000,
	}
}

func TestChatTaskResourceCapacityMismatchPreservesExistingLimit(t *testing.T) {
	d, db := setupChatTaskTest(t)
	if err := d.EnsureResource(t.Context(), "gpu", 2); !errors.Is(err, ErrChatTaskResourceConfig) {
		t.Fatalf("capacity mismatch: %v", err)
	}
	var resource entity.ChatTaskResource
	if err := db.Take(&resource, "id = ?", "gpu").Error; err != nil || resource.Capacity != 1 {
		t.Fatalf("existing capacity changed: %d, %v", resource.Capacity, err)
	}
}

func submitTaskForTest(t *testing.T, d *ChatTaskDAO, id string) *entity.ChatTask {
	t.Helper()
	task, replay, err := d.Submit(t.Context(), taskForTest(id), 10, 20, nil)
	if err != nil || replay {
		t.Fatalf("submit: replay=%v err=%v", replay, err)
	}
	return task
}

func claimTaskForTest(t *testing.T, d *ChatTaskDAO, id string) *entity.ChatTask {
	t.Helper()
	task, err := d.Claim(t.Context(), id, "worker", time.Minute)
	if err != nil || task == nil {
		t.Fatalf("claim: task=%v err=%v", task, err)
	}
	return task
}

func TestChatTaskSubmissionReplayConflictAndRollback(t *testing.T) {
	d, db := setupChatTaskTest(t)
	task := submitTaskForTest(t, d, "first")
	called := false
	replay, replayed, err := d.Submit(t.Context(), taskForTest("first"), 10, 20, func(*gorm.DB) error {
		called = true
		return nil
	})
	if err != nil || !replayed || replay.ID != task.ID || called {
		t.Fatalf("replay=%+v replayed=%v called=%v err=%v", replay, replayed, called, err)
	}
	different := taskForTest("first")
	different.InputHash = strings.Repeat("b", 64)
	if _, _, err := d.Submit(t.Context(), different, 10, 20, nil); !errors.Is(err, ErrChatTaskConflict) {
		t.Fatalf("conflicting input: %v", err)
	}
	sentinel := errors.New("message commit failed")
	if _, _, err := d.Submit(t.Context(), taskForTest("rollback"), 10, 20, func(*gorm.DB) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	var count int64
	db.Model(&entity.ChatTask{}).Count(&count)
	if count != 1 {
		t.Fatalf("task survived failed message transaction: %d", count)
	}
	events, err := d.Events(t.Context(), task.ID, 0, 10)
	if err != nil || len(events) != 1 || events[0].Type != "accepted" || events[0].TaskRevision != task.Revision {
		t.Fatalf("accepted event: %+v err=%v", events, err)
	}
}

func TestChatTaskLeaseAndTerminalAreAuthoritative(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	submitTaskForTest(t, d, "one")
	task := claimTaskForTest(t, d, "one")
	if _, err := d.Claim(t.Context(), task.ID, "other", time.Minute); !errors.Is(err, ErrChatTaskState) {
		t.Fatalf("duplicate executor: %v", err)
	}
	commit := func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
		task.State, task.UpstreamStatus = "succeeded", "stopped"
		task.Outputs = entity.JSONMap{"answer": "persisted"}
		return task.Outputs, nil
	}
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch-1, "task_terminal", commit); !errors.Is(err, ErrChatTaskLease) {
		t.Fatalf("stale epoch committed: %v", err)
	}
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "task_terminal", commit); err != nil {
		t.Fatal(err)
	}
	cancelled, err := d.Cancel(t.Context(), task.ID)
	if err != nil || cancelled.State != "succeeded" {
		t.Fatalf("cancel rewrote terminal: %+v %v", cancelled, err)
	}
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "output_committed", commit); !errors.Is(err, ErrChatTaskLease) {
		t.Fatalf("terminal executor committed: %v", err)
	}
	events, _ := d.Events(t.Context(), task.ID, 0, 10)
	if len(events) != 3 || events[2].Seq != 3 || events[2].TaskRevision != 3 {
		t.Fatalf("event ordering/revisions: %+v", events)
	}
}

func TestChatTaskCancellationRejectsLateOutput(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	queued := submitTaskForTest(t, d, "queued")
	cancelled, err := d.Cancel(t.Context(), queued.ID)
	if err != nil || cancelled.State != "cancelled" {
		t.Fatalf("queued cancel: %+v %v", cancelled, err)
	}
	submitTaskForTest(t, d, "running")
	task := claimTaskForTest(t, d, "running")
	cancelled, err = d.Cancel(t.Context(), task.ID)
	if err != nil || cancelled.State != "cancel_requested" {
		t.Fatalf("running cancel: %+v %v", cancelled, err)
	}
	called := false
	err = d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "output_committed", func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error) {
		called = true
		return nil, nil
	})
	if !errors.Is(err, ErrChatTaskState) || called {
		t.Fatalf("late output callback ran: called=%v err=%v", called, err)
	}
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "task_terminal", func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
		task.State = "succeeded"
		return nil, nil
	}); !errors.Is(err, ErrChatTaskState) {
		t.Fatalf("cancel_requested -> succeeded accepted: %v", err)
	}
}

func TestChatTaskOutputAndEventRollbackTogether(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "one")
	task := claimTaskForTest(t, d, "one")
	err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "output_committed", func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
		task.Outputs = entity.JSONMap{"answer": "uncommitted"}
		if err := tx.Create(&entity.ChatTaskResource{ID: "transient", Capacity: 1}).Error; err != nil {
			return nil, err
		}
		return nil, errors.New("failed output")
	})
	if err == nil {
		t.Fatal("expected callback failure")
	}
	current, _ := d.Get(t.Context(), task.ID)
	var count int64
	db.Model(&entity.ChatTaskResource{}).Where("id = ?", "transient").Count(&count)
	if len(current.Outputs) != 0 || current.EventSeq != 2 || count != 0 {
		t.Fatalf("partial transaction escaped: task=%+v count=%d", current, count)
	}
}

func TestChatTaskResourcesAndSharedCallBudget(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	for _, id := range []string{"first", "second"} {
		submitTaskForTest(t, d, id)
	}
	first, second := claimTaskForTest(t, d, "first"), claimTaskForTest(t, d, "second")
	call := ChatTaskCall{Stage: "speech", Model: "tts", Resources: []string{"provider", "gpu"}, CostKnown: true}
	attempt, err := d.ReserveCall(t.Context(), first.ID, "worker", first.LeaseEpoch, call)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReserveCall(t.Context(), second.ID, "worker", second.LeaseEpoch, call); !errors.Is(err, ErrChatTaskQuota) {
		t.Fatalf("shared hardware overcommitted: %v", err)
	}
	secondNow, _ := d.Get(t.Context(), second.ID)
	if secondNow.Calls != 0 {
		t.Fatal("quota rejection consumed a call")
	}
	if err := d.SettleCall(t.Context(), first.ID, "worker", first.LeaseEpoch, attempt.ID, "failed", "stopped", 1, nil, "service_unavailable"); err != nil {
		t.Fatal(err)
	}
	call.Switch = true
	alternate, err := d.ReserveCall(t.Context(), first.ID, "worker", first.LeaseEpoch, call)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SettleCall(t.Context(), first.ID, "worker", first.LeaseEpoch, alternate.ID, "failed", "stopped", 2, nil, "service_unavailable"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReserveCall(t.Context(), first.ID, "worker", first.LeaseEpoch, call); !errors.Is(err, ErrChatTaskBudget) {
		t.Fatalf("stage/switch budget reset: %v", err)
	}
	if _, err := d.ReserveCall(t.Context(), second.ID, "worker", second.LeaseEpoch, call); err != nil {
		t.Fatalf("settled resource not released: %v", err)
	}
}

func TestChatTaskStrictCostExcludesUnknownAndSettlesFailures(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	input := taskForTest("strict")
	input.StrictCost, input.CostLimit = true, 10
	if _, _, err := d.Submit(t.Context(), input, 10, 20, nil); err != nil {
		t.Fatal(err)
	}
	task := claimTaskForTest(t, d, input.ID)
	call := ChatTaskCall{Stage: "image", Model: "image", EstimatedCost: 6}
	if _, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch, call); !errors.Is(err, ErrChatTaskBudget) {
		t.Fatalf("unknown price accepted under strict budget: %v", err)
	}
	call.CostKnown = true
	first, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch, call)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch, call); !errors.Is(err, ErrChatTaskBudget) {
		t.Fatalf("reserved cost ignored: %v", err)
	}
	if err := d.SettleCall(t.Context(), task.ID, "worker", task.LeaseEpoch, first.ID, "failed", "stopped", 5, nil, "provider_error"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch, call); !errors.Is(err, ErrChatTaskBudget) {
		t.Fatalf("failed charged call ignored: %v", err)
	}
}

func TestChatTaskRecoveryRetainsUnknownHardwareAndFencesOldWorker(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "lost")
	task := claimTaskForTest(t, d, "lost")
	call := ChatTaskCall{Stage: "image", Model: "image", Resources: []string{"gpu"}}
	if _, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch, call); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.RecoverExpired(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	current, _ := d.Get(t.Context(), task.ID)
	if current.State != "failed" || current.UpstreamStatus != "unknown" || current.LeaseEpoch <= task.LeaseEpoch {
		t.Fatalf("lost work was not isolated: %+v", current)
	}
	var leases int64
	db.Model(&entity.ChatTaskResourceLease{}).Count(&leases)
	if leases != 1 {
		t.Fatal("uncertain upstream released hardware")
	}
	ok, err := d.Renew(t.Context(), task.ID, "worker", task.LeaseEpoch, time.Minute)
	if err != nil || ok {
		t.Fatalf("old worker renewed: ok=%v err=%v", ok, err)
	}
}

func TestChatTaskQuotaAndQueueExpiry(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "first")
	if _, _, err := d.Submit(t.Context(), taskForTest("second"), 1, 20, nil); !errors.Is(err, ErrChatTaskQuota) {
		t.Fatalf("pending limit ignored: %v", err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", "first").Update("queue_deadline", 1).Error; err != nil {
		t.Fatal(err)
	}
	task, err := d.Claim(t.Context(), "first", "worker", time.Minute)
	if err != nil || task != nil {
		t.Fatalf("expired task dispatched: %+v %v", task, err)
	}
	expired, _ := d.Get(t.Context(), "first")
	if expired.State != "failed" || expired.ErrorCode != "queue_timeout" {
		t.Fatalf("queue expiry missing: %+v", expired)
	}
}
