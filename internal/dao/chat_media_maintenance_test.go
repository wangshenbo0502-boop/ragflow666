package dao

import (
	"errors"
	"testing"
	"time"

	"ragflow/internal/entity"
)

func TestChatMediaMaintenanceSerializesAdmissionAndClaim(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "queued")
	if err := SetChatMediaMaintenance(t.Context(), db, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.Submit(t.Context(), taskForTest("new"), 10, 20, nil); !errors.Is(err, ErrChatMediaMaintenance) {
		t.Fatalf("frozen admission: %v", err)
	}
	if _, err := d.Claim(t.Context(), "queued", "worker", time.Minute); !errors.Is(err, ErrChatMediaMaintenance) {
		t.Fatalf("frozen claim: %v", err)
	}
	if err := SetChatMediaMaintenance(t.Context(), db, false); err != nil {
		t.Fatal(err)
	}
	task := claimTaskForTest(t, d, "queued")
	if err := SetChatMediaMaintenance(t.Context(), db, true); err == nil {
		t.Fatal("froze an executing task")
	}
	if err := d.ReconcileStopped(t.Context(), task.ID, "ticket-123"); !errors.Is(err, ErrChatTaskState) {
		t.Fatalf("reconciled an executing task: %v", err)
	}
}

func TestChatTaskReconciliationRetainsTerminalAndFencesWriters(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "unknown")
	task := claimTaskForTest(t, d, "unknown")
	if _, err := d.ReserveCall(t.Context(), task.ID, "worker", task.LeaseEpoch,
		ChatTaskCall{Stage: "image", Model: "image-model", Resources: []string{"gpu"}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.RecoverExpired(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	before, _ := d.Get(t.Context(), task.ID)
	if err := SetChatMediaMaintenance(t.Context(), db, true); err == nil {
		t.Fatal("froze with an unresolved upstream")
	}
	if err := d.ReconcileStopped(t.Context(), task.ID, "verified-service-job-stopped"); err != nil {
		t.Fatal(err)
	}
	after, _ := d.Get(t.Context(), task.ID)
	if before.State != after.State || after.UpstreamStatus != "stopped" || after.LeaseEpoch <= before.LeaseEpoch {
		t.Fatalf("reconciliation corrupted outcome: before=%+v after=%+v", before, after)
	}
	var count int64
	db.Model(&entity.ChatTaskResourceLease{}).Count(&count)
	if count != 0 {
		t.Fatal("reconciled resource is still held")
	}
	if err := SetChatMediaMaintenance(t.Context(), db, true); err != nil {
		t.Fatal(err)
	}
}

func TestChatTaskPriorityHasBoundedInteractivePreference(t *testing.T) {
	d, db := setupChatTaskTest(t)
	for _, item := range []struct {
		id, class string
		age       int64
	}{
		{"young-music", "normal", 0}, {"speech", "interactive", 0}, {"old-music", "normal", 180000},
	} {
		task := taskForTest(item.id)
		task.SchedulingClass = item.class
		if _, _, err := d.Submit(t.Context(), task, 10, 20, nil); err != nil {
			t.Fatal(err)
		}
		db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Update("created_at", task.CreatedAt-item.age)
	}
	tasks, err := d.Dispatchable(t.Context(), 10, 2*time.Minute)
	if err != nil || len(tasks) != 3 || tasks[0].ID != "old-music" || tasks[1].ID != "speech" {
		t.Fatalf("priority: %+v %v", tasks, err)
	}
	tasks, err = d.Dispatchable(t.Context(), 10, 4*time.Minute)
	if err != nil || len(tasks) != 3 || tasks[0].ID != "speech" || tasks[1].ID != "old-music" {
		t.Fatalf("configured priority wait: %+v %v", tasks, err)
	}
}
