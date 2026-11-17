package dao

import (
	"context"
	"testing"
	"time"

	"ragflow/internal/entity"
)

func TestChatTaskStatisticsRetentionAndCleanup(t *testing.T) {
	d, db := setupChatTaskTest(t)
	for _, state := range []string{"queued", "running", "cancel_requested", "succeeded", "partial_succeeded", "failed", "cancelled"} {
		task := taskForTest("owner-" + state)
		task.State, task.UpstreamStatus = state, "stopped"
		if state == "failed" {
			task.UpstreamStatus = "unknown"
		}
		if err := db.Create(task).Error; err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UnixMilli()
	old := now - time.Hour.Milliseconds()
	for _, fixture := range []struct {
		id, state, task, refKind, refOwner, cleanup string
		fresh                                       bool
	}{
		{id: "orphan", state: "committed", cleanup: "pending"},
		{id: "unjournaled", state: "staging"},
		{id: "fresh", state: "staging", cleanup: "pending", fresh: true},
		{id: "deleting", state: "deleting", cleanup: "retry"},
		{id: "deleted", state: "deleted", cleanup: "done"},
		{id: "message", state: "committed", refKind: "message", refOwner: "session:turn", cleanup: "retry"},
		{id: "parent", state: "committed", refKind: "parent", refOwner: "child"},
		{id: "active-owned", state: "staging", task: "owner-running"},
		{id: "unknown-owned", state: "staging", task: "owner-failed"},
		{id: "unknown-ref", state: "committed", refKind: "task", refOwner: "owner-failed"},
		{id: "active-ref", state: "committed", refKind: "task", refOwner: "owner-running"},
		{id: "terminal-ref", state: "committed", refKind: "task", refOwner: "owner-succeeded", cleanup: "done"},
		{id: "missing-ref", state: "committed", refKind: "task", refOwner: "missing"},
		{id: "null-owner", state: "committed"},
	} {
		created := old
		if fixture.fresh {
			created = now
		}
		asset := entity.ChatMediaAsset{ID: fixture.id, SourceKey: fixture.id, State: fixture.state,
			TaskID: fixture.task, CreatedAt: created, Bucket: "test", ObjectKey: fixture.id}
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
		if fixture.id == "null-owner" {
			if err := db.Model(&asset).Update("task_id", nil).Error; err != nil {
				t.Fatal(err)
			}
		}
		if fixture.refKind != "" {
			ref := entity.ChatMediaReference{AssetID: fixture.id, OwnerKind: fixture.refKind, OwnerID: fixture.refOwner}
			if err := db.Create(&ref).Error; err != nil {
				t.Fatal(err)
			}
		}
		if fixture.cleanup != "" {
			record := entity.ChatMediaCleanup{ID: fixture.id, AssetID: fixture.id, State: fixture.cleanup,
				CreatedAt: created, StoreScope: "test", ObjectKey: fixture.id}
			if err := db.Create(&record).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	stats, err := d.Statistics(t.Context(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for state, count := range stats.TaskStates {
		if count != 1 {
			t.Fatalf("%s count = %d, want 1", state, count)
		}
	}
	if len(stats.TaskStates) != 7 || stats.UnknownUpstreams != 1 ||
		stats.UnreferencedMedia != 7 || stats.ReclaimableMedia != 6 ||
		stats.CleanupPending != 2 || stats.CleanupRetries != 1 ||
		stats.CleanupOldestMs != stats.ObservedAt-old {
		t.Fatalf("retained or fresh assets counted as cleanup backlog: %+v", stats)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id IN ?", []string{"owner-running", "owner-failed"}).
		Updates(map[string]interface{}{"state": "failed", "upstream_status": "stopped"}).Error; err != nil {
		t.Fatal(err)
	}
	stats, err = d.Statistics(t.Context(), time.Minute)
	if err != nil || stats.UnknownUpstreams != 0 || stats.UnreferencedMedia != 11 || stats.ReclaimableMedia != 10 {
		t.Fatalf("confirmed stopped tasks kept their assets protected: stats=%+v err=%v", stats, err)
	}
}

func TestChatTaskStatisticsEmptyAndInvalidReads(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	stats, err := d.Statistics(t.Context(), 0)
	if err != nil || stats.ObservedAt <= 0 || stats.CleanupOldestMs != 0 ||
		stats.UnreferencedMedia != 0 || stats.CleanupPending != 0 || stats.CleanupRetries != 0 {
		t.Fatalf("empty inventory: stats=%+v err=%v", stats, err)
	}
	if stats, err := d.Statistics(t.Context(), -time.Second); err == nil || stats != nil {
		t.Fatal("negative grace produced statistics")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if stats, err := d.Statistics(ctx, 0); err == nil || stats != nil {
		t.Fatal("a failed read was reported as zero backlog")
	}
}
