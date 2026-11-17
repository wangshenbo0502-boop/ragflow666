package dao

import (
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/entity"
)

func TestChatTaskRecoveryCheckpointBoundaries(t *testing.T) {
	for _, scenario := range []struct {
		name, upstream, wantState, wantCode string
		calls, checkpointCalls              int
		ready, output, expired              bool
	}{
		{name: "before-call", upstream: "not_started", wantState: "running"},
		{name: "complete", upstream: "stopped", calls: 2, checkpointCalls: 2, ready: true, output: true, wantState: "running"},
		{name: "incomplete", upstream: "stopped", calls: 2, wantState: "failed", wantCode: "checkpoint_incomplete"},
		{name: "stale-checkpoint", upstream: "stopped", calls: 2, checkpointCalls: 1, ready: true, output: true, wantState: "partial_succeeded", wantCode: "checkpoint_incomplete"},
		{name: "unknown", upstream: "unknown", calls: 2, checkpointCalls: 2, ready: true, wantState: "failed", wantCode: "executor_lost"},
		{name: "deadline-with-text", upstream: "stopped", calls: 2, checkpointCalls: 2, ready: true, output: true, expired: true, wantState: "partial_succeeded", wantCode: "deadline_exceeded"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			d, db := setupChatTaskTest(t)
			submitTaskForTest(t, d, "task")
			claimed := claimTaskForTest(t, d, "task")
			updates := map[string]interface{}{
				"calls": scenario.calls, "checkpoint_calls": scenario.checkpointCalls,
				"checkpoint_ready": scenario.ready, "upstream_status": scenario.upstream, "lease_until": 1,
			}
			if scenario.output {
				updates["outputs"] = entity.JSONMap{"text": map[string]interface{}{"answer": "saved answer"}}
			}
			if scenario.expired {
				updates["deadline"] = 1
			}
			if err := db.Model(&entity.ChatTask{}).Where("id = ?", claimed.ID).Updates(updates).Error; err != nil {
				t.Fatal(err)
			}
			if err := d.RecoverExpired(t.Context(), 10); err != nil {
				t.Fatal(err)
			}
			current, err := d.Get(t.Context(), claimed.ID)
			if err != nil || current.State != scenario.wantState || current.ErrorCode != scenario.wantCode ||
				current.LeaseOwner != "" || current.LeaseEpoch <= claimed.LeaseEpoch || current.Calls != scenario.calls {
				t.Fatalf("recovery: %+v err=%v", current, err)
			}
			if current.State == "running" {
				resumed, err := d.Claim(t.Context(), current.ID, "new-worker", time.Minute)
				if err != nil || resumed.Calls != scenario.calls {
					t.Fatalf("checkpoint not dispatchable: %+v %v", resumed, err)
				}
			}
			if err := d.Mutate(t.Context(), current.ID, "worker", claimed.LeaseEpoch, "output_committed",
				func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error) {
					t.Error("stale callback ran")
					return nil, nil
				}); !errors.Is(err, ErrChatTaskLease) {
				t.Fatalf("old worker not fenced: %v", err)
			}
		})
	}
}

func TestChatTaskResourceWaitKeepsRunningAndUsesTotalDeadline(t *testing.T) {
	d, db := setupChatTaskTest(t)
	submitTaskForTest(t, d, "task")
	task := claimTaskForTest(t, d, "task")
	if err := d.Mutate(t.Context(), task.ID, "worker", task.LeaseEpoch, "output_committed",
		func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			task.Calls, task.UpstreamStatus = 1, "stopped"
			task.Outputs = entity.JSONMap{"text": map[string]interface{}{"answer": "saved"}}
			return nil, nil
		}); err != nil {
		t.Fatal(err)
	}
	if err := d.Defer(t.Context(), task.ID, "worker", task.LeaseEpoch, time.Millisecond, time.Minute); err != nil {
		t.Fatal(err)
	}
	current, _ := d.Get(t.Context(), task.ID)
	if current.State != "running" || current.LeaseOwner != "" || current.Calls != 1 || !current.CheckpointReady {
		t.Fatalf("wait reset state/checkpoint: %+v", current)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).
		Updates(map[string]interface{}{"next_run_at": 0, "queue_deadline": 1}).Error; err != nil {
		t.Fatal(err)
	}
	resumed := claimTaskForTest(t, d, task.ID)
	if resumed.Calls != 1 || resumed.State != "running" {
		t.Fatalf("first queue deadline reused: %+v", resumed)
	}
	if err := d.Defer(t.Context(), task.ID, "worker", resumed.LeaseEpoch, time.Millisecond, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).
		Updates(map[string]interface{}{"next_run_at": 0, "deadline": 1}).Error; err != nil {
		t.Fatal(err)
	}
	ended, err := d.Claim(t.Context(), task.ID, "worker", time.Minute)
	if err != nil || ended != nil {
		t.Fatalf("expired wait claimed: %+v %v", ended, err)
	}
	current, _ = d.Get(t.Context(), task.ID)
	if current.State != "partial_succeeded" || current.ErrorCode != "deadline_exceeded" || !HasChatTaskOutput(current) {
		t.Fatalf("lost usable output: %+v", current)
	}
}

func TestChatTaskDeferDistinguishesResourceWaitAndExecutionDeadline(t *testing.T) {
	for _, scenario := range []struct {
		name string
		set  map[string]interface{}
		want error
	}{
		{
			name: "resource wait limit",
			set:  map[string]interface{}{"resource_wait_at": 1},
			want: ErrChatTaskResourceWaitTimeout,
		},
		{
			name: "total execution deadline",
			set:  map[string]interface{}{"deadline": 1},
			want: ErrChatTaskDeadline,
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			d, db := setupChatTaskTest(t)
			submitTaskForTest(t, d, "task")
			task := claimTaskForTest(t, d, "task")
			if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Updates(scenario.set).Error; err != nil {
				t.Fatal(err)
			}
			err := d.Defer(t.Context(), task.ID, "worker", task.LeaseEpoch, time.Millisecond, time.Minute)
			if !errors.Is(err, scenario.want) {
				t.Fatalf("Defer error = %v, want %v", err, scenario.want)
			}
			current, getErr := d.Get(t.Context(), task.ID)
			if getErr != nil || current.State != "running" || current.LeaseOwner != "worker" {
				t.Fatalf("failed defer must leave the transaction unchanged: %+v err=%v", current, getErr)
			}
		})
	}
}

func TestChatTaskWaitingCancellationUsesContractEvents(t *testing.T) {
	d, _ := setupChatTaskTest(t)
	submitTaskForTest(t, d, "task")
	task := claimTaskForTest(t, d, "task")
	if err := d.Defer(t.Context(), task.ID, "worker", task.LeaseEpoch, time.Second, time.Minute); err != nil {
		t.Fatal(err)
	}
	current, err := d.Cancel(t.Context(), task.ID)
	if err != nil || current.State != "cancelled" {
		t.Fatalf("waiting cancellation: %+v %v", current, err)
	}
	events, err := d.Events(t.Context(), task.ID, 0, 100)
	if err != nil || len(events) < 2 || events[len(events)-2].Data["state"] != "cancel_requested" ||
		events[len(events)-1].Data["state"] != "cancelled" {
		t.Fatalf("invalid event sequence: %+v %v", events, err)
	}
}
