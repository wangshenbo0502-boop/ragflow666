package dao

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/common"
	"ragflow/internal/entity"
)

var (
	ErrChatTaskConflict            = errors.New("idempotency key was already used with different input")
	ErrChatTaskLease               = errors.New("chat task executor lease is no longer valid")
	ErrChatTaskState               = errors.New("invalid chat task state transition")
	ErrChatTaskBudget              = errors.New("chat task call, cost or deadline budget exhausted")
	ErrChatTaskDeadline            = errors.New("chat task execution deadline exceeded")
	ErrChatTaskResourceWaitTimeout = errors.New("chat task resource wait timed out")
	ErrChatTaskQuota               = errors.New("chat task quota unavailable")
	ErrChatTaskResourceConfig      = errors.New("chat task resource capacity does not match worker configuration")
)

type ChatTaskDAO struct {
	db *gorm.DB
}

func NewChatTaskDAO(db *gorm.DB) *ChatTaskDAO { return &ChatTaskDAO{db: db} }

// databaseTime uses the database clock for comparisons across worker instances.
func databaseTime(tx *gorm.DB) (int64, error) {
	var now int64
	query := "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
	switch tx.Dialector.Name() {
	case "mysql":
		query = "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS SIGNED)"
	case "postgres":
		query = "SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)"
	}
	err := tx.Raw(query).Scan(&now).Error
	return now, err
}

func IsChatTaskTerminal(state string) bool {
	switch state {
	case "succeeded", "partial_succeeded", "failed", "cancelled":
		return true
	}
	return false
}

func validChatTaskTransition(from, to string) bool {
	switch from {
	case "queued":
		return to == "running" || to == "cancelled" || to == "failed"
	case "running":
		return to == "succeeded" || to == "partial_succeeded" || to == "failed" || to == "cancel_requested"
	case "cancel_requested":
		return to == "cancelled"
	}
	return false
}

func appendChatTaskEvent(tx *gorm.DB, task *entity.ChatTask, kind string, data entity.JSONMap, now int64) error {
	task.EventSeq++
	event := entity.ChatTaskEvent{
		TaskID: task.ID, Seq: task.EventSeq, TurnID: task.TurnID,
		TaskRevision: task.Revision, Type: kind, OccurredAt: now, Data: data,
	}
	return tx.Create(&event).Error
}

func lockChatTask(tx *gorm.DB, id string) (*entity.ChatTask, int64, error) {
	var task entity.ChatTask
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&task, "id = ?", id).Error; err != nil {
		return nil, 0, err
	}
	now, err := databaseTime(tx)
	return &task, now, err
}

func checkChatTaskLease(task *entity.ChatTask, owner string, epoch, now int64) error {
	if task.LeaseOwner != owner || task.LeaseEpoch != epoch || task.LeaseUntil <= now ||
		(task.State != "running" && task.State != "cancel_requested") {
		return ErrChatTaskLease
	}
	return nil
}

// Submit locks the session before reserving the turn and task. The unique
// request key and input hash make replay independent of completion order.
func (d *ChatTaskDAO) Submit(ctx context.Context, task *entity.ChatTask, maxUserPending, maxTenantPending int, commitInput func(*gorm.DB) error) (*entity.ChatTask, bool, error) {
	if task.ID == "" || task.SessionID == "" || task.TurnID == "" || task.UserID == "" || task.TenantID == "" ||
		task.IdempotencyKey == "" || len(task.IdempotencyKey) > 128 || len(task.InputHash) != 64 ||
		task.MaxCalls < 1 || task.MaxStageCalls < 1 || task.MaxSwitches < 0 || maxUserPending < 1 || maxTenantPending < 1 {
		return nil, false, errors.New("invalid chat task submission")
	}
	if task.SchedulingClass == "" {
		task.SchedulingClass = "normal"
	}
	if task.SchedulingClass != "normal" && task.SchedulingClass != "interactive" {
		return nil, false, errors.New("invalid chat task scheduling class")
	}
	var result *entity.ChatTask
	replayed := false
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := checkChatMediaMaintenance(tx); err != nil {
			return err
		}
		var session entity.ChatSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Take(&session, "id = ? AND dialog_id = ?", task.SessionID, task.ChatID).Error; err != nil {
			return err
		}
		var existing entity.ChatTask
		err := tx.Take(&existing, "tenant_id = ? AND user_id = ? AND idempotency_key = ?", task.TenantID, task.UserID, task.IdempotencyKey).Error
		if err == nil {
			if existing.InputHash != task.InputHash {
				return ErrChatTaskConflict
			}
			result, replayed = &existing, true
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		// The tenant row serializes pending admission across different sessions.
		var tenant entity.Tenant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&tenant, "id = ?", task.TenantID).Error; err != nil {
			return err
		}
		for _, limit := range []struct {
			user string
			max  int
		}{{task.UserID, maxUserPending}, {"", maxTenantPending}} {
			q := tx.Model(&entity.ChatTask{}).Where("tenant_id = ? AND state IN ?", task.TenantID, []string{"queued", "running", "cancel_requested"})
			if limit.user != "" {
				q = q.Where("user_id = ?", limit.user)
			}
			var count int64
			if err := q.Count(&count).Error; err != nil {
				return err
			}
			if count >= int64(limit.max) {
				return ErrChatTaskQuota
			}
		}
		now, err := databaseTime(tx)
		if err != nil {
			return err
		}
		if task.QueueDeadline <= now || task.Deadline <= task.QueueDeadline {
			return ErrChatTaskBudget
		}
		task.State, task.Stage = "queued", "accepted"
		task.Revision, task.EventSeq = 1, 0
		task.CreatedAt, task.UpdatedAt, task.NextRunAt = now, now, now
		task.UpstreamStatus = "not_started"
		if commitInput != nil {
			if err := commitInput(tx); err != nil {
				return err
			}
		}
		var position int64
		if err := tx.Model(&entity.ConversationMessage{}).Select("COALESCE(MAX(position), 0)").
			Where("conversation_id = ? AND message_id = ? AND role = ?", task.SessionID, task.TurnID, "user").Scan(&position).Error; err != nil {
			return err
		}
		task.TurnSequence = position
		if err := tx.Create(task).Error; err != nil {
			return err
		}
		if err := appendChatTaskEvent(tx, task, "accepted", entity.JSONMap{"state": task.State}, now); err != nil {
			return err
		}
		if err := tx.Model(task).Update("event_seq", task.EventSeq).Error; err != nil {
			return err
		}
		result = task
		return nil
	})
	// A request using another session can race the unique key. Never reinterpret
	// an arbitrary insert error as success; only an existing matching key counts.
	if err != nil {
		var existing entity.ChatTask
		readErr := d.db.WithContext(ctx).Take(&existing, "tenant_id = ? AND user_id = ? AND idempotency_key = ?", task.TenantID, task.UserID, task.IdempotencyKey).Error
		if readErr == nil {
			if existing.InputHash != task.InputHash {
				return nil, false, ErrChatTaskConflict
			}
			return &existing, true, nil
		}
	}
	return result, replayed, err
}

func (d *ChatTaskDAO) Get(ctx context.Context, id string) (*entity.ChatTask, error) {
	var task entity.ChatTask
	err := d.db.WithContext(ctx).Take(&task, "id = ?", id).Error
	return &task, err
}

func (d *ChatTaskDAO) Claim(ctx context.Context, id, owner string, lease time.Duration) (*entity.ChatTask, error) {
	if owner == "" || lease < time.Second {
		return nil, errors.New("invalid executor lease")
	}
	var result *entity.ChatTask
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := checkChatMediaMaintenance(tx); err != nil {
			return err
		}
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if (task.State != "queued" && !(task.State == "running" && task.LeaseOwner == "" && CanResumeChatTask(task))) || task.NextRunAt > now {
			return ErrChatTaskState
		}
		if (task.State == "queued" && task.QueueDeadline <= now) || task.Deadline <= now {
			task.State, task.ErrorCode, task.ErrorMessage = "failed", "deadline_exceeded", "Task execution deadline exceeded"
			if task.Calls == 0 && task.QueueDeadline <= now && task.Deadline > now {
				task.ErrorCode, task.ErrorMessage = "queue_timeout", "Task expired before execution"
			}
			if HasChatTaskOutput(task) {
				task.State = "partial_succeeded"
			}
			task.Revision++
			task.FinishedAt, task.UpdatedAt = now, now
			if err := appendChatTaskEvent(tx, task, "task_terminal", entity.JSONMap{"state": task.State, "error_code": task.ErrorCode}, now); err != nil {
				return err
			}
			return tx.Save(task).Error
		}
		task.State = "running"
		if task.Stage == "accepted" {
			task.Stage = "planning"
		}
		task.LeaseOwner, task.LeaseUntil = owner, now+lease.Milliseconds()
		task.LeaseEpoch++
		task.Revision++
		task.UpdatedAt = now
		if err := appendChatTaskEvent(tx, task, "stage_changed", entity.JSONMap{"state": task.State, "stage": task.Stage}, now); err != nil {
			return err
		}
		if err := tx.Save(task).Error; err != nil {
			return err
		}
		result = task
		return nil
	})
	return result, err
}

func (d *ChatTaskDAO) Renew(ctx context.Context, id, owner string, epoch int64, lease time.Duration) (bool, error) {
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return false, err
	}
	result := d.db.WithContext(ctx).Model(&entity.ChatTask{}).
		Where("id = ? AND lease_owner = ? AND lease_epoch = ? AND lease_until > ? AND state IN ?", id, owner, epoch, now, []string{"running", "cancel_requested"}).
		Update("lease_until", now+lease.Milliseconds())
	return result.RowsAffected == 1, result.Error
}

// Mutate commits outputs, message changes and their event in the same transaction.
// The callback runs only after both session and executor leases are checked.
func (d *ChatTaskDAO) Mutate(ctx context.Context, id, owner string, epoch int64, eventType string, mutate func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error)) error {
	return d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Session first is the shared order used by submission and deletion.
		var current entity.ChatTask
		if err := tx.Take(&current, "id = ?", id).Error; err != nil {
			return err
		}
		var session entity.ChatSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&session, "id = ?", current.SessionID).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) || eventType != "task_terminal" {
				return err
			}
		}
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if err := checkChatTaskLease(task, owner, epoch, now); err != nil {
			return err
		}
		if session.ID == "" && task.State != "cancel_requested" {
			return ErrChatTaskState
		}
		if task.State == "cancel_requested" && eventType != "task_terminal" {
			return ErrChatTaskState
		}
		previous := task.State
		data, err := mutate(tx, task)
		if err != nil {
			return err
		}
		if (eventType == "plan_saved" || eventType == "output_committed" || eventType == "checkpoint_saved") &&
			(task.UpstreamStatus == "stopped" || task.UpstreamStatus == "not_started") {
			task.CheckpointCalls, task.CheckpointReady = task.Calls, true
		}
		if task.State != previous && !validChatTaskTransition(previous, task.State) {
			return ErrChatTaskState
		}
		task.Revision++
		task.UpdatedAt = now
		if IsChatTaskTerminal(task.State) {
			task.FinishedAt = now
			task.LeaseOwner, task.LeaseUntil = "", 0
			if task.UpstreamStatus == "stopped" || task.UpstreamStatus == "not_started" {
				if err := tx.Where("task_id = ?", task.ID).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
					return err
				}
			}
		}
		if err := appendChatTaskEvent(tx, task, eventType, data, now); err != nil {
			return err
		}
		return tx.Save(task).Error
	})
}

func (d *ChatTaskDAO) Cancel(ctx context.Context, id string) (*entity.ChatTask, error) {
	var result *entity.ChatTask
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if err := cancelChatTask(tx, task, now); err != nil {
			return err
		}
		result = task
		return nil
	})
	return result, err
}

func cancelChatTask(tx *gorm.DB, task *entity.ChatTask, now int64) error {
	if IsChatTaskTerminal(task.State) {
		return nil
	}
	if task.State != "cancel_requested" {
		if task.State == "queued" {
			task.State, task.FinishedAt = "cancelled", now
		} else {
			task.State = "cancel_requested"
		}
		task.Revision++
		task.UpdatedAt = now
		kind := "stage_changed"
		if task.State == "cancelled" {
			kind = "task_terminal"
		}
		if err := appendChatTaskEvent(tx, task, kind,
			entity.JSONMap{"state": task.State, "upstream_status": task.UpstreamStatus}, now); err != nil {
			return err
		}
	}
	if task.State == "cancel_requested" && task.LeaseOwner == "" &&
		(task.UpstreamStatus == "not_started" || task.UpstreamStatus == "stopped") {
		task.State, task.FinishedAt = "cancelled", now
		task.Revision++
		task.UpdatedAt = now
		if err := appendChatTaskEvent(tx, task, "task_terminal",
			entity.JSONMap{"state": task.State, "upstream_status": task.UpstreamStatus}, now); err != nil {
			return err
		}
	}
	return tx.Save(task).Error
}

type ChatTaskCall struct {
	Stage, Model, Reason string
	Switch               bool
	CostKnown            bool
	EstimatedCost        int64
	Resources            []string
}

// ReserveCall atomically checks the shared budgets and every resource. A
// rejected reservation never consumes a call or holds a subset of the slots.
func (d *ChatTaskDAO) ReserveCall(ctx context.Context, id, owner string, epoch int64, call ChatTaskCall) (*entity.ChatTaskAttempt, error) {
	if call.Stage == "" || call.Model == "" || call.EstimatedCost < 0 {
		return nil, errors.New("invalid chat task call")
	}
	var attempt *entity.ChatTaskAttempt
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if err := checkChatTaskLease(task, owner, epoch, now); err != nil {
			return err
		}
		if task.Deadline <= now {
			return ErrChatTaskDeadline
		}
		if task.State != "running" || task.Calls >= task.MaxCalls ||
			(call.Switch && task.Switches >= task.MaxSwitches) ||
			(task.StrictCost && (!call.CostKnown || call.EstimatedCost > task.CostLimit-task.CostReserved-task.CostActual)) {
			return ErrChatTaskBudget
		}
		if task.UpstreamStatus == "unknown" || task.UpstreamStatus == "running" {
			return ErrChatTaskState
		}
		var count int64
		if err := tx.Model(&entity.ChatTaskAttempt{}).Where("task_id = ? AND stage = ?", id, call.Stage).Count(&count).Error; err != nil {
			return err
		}
		if count >= int64(task.MaxStageCalls) {
			return ErrChatTaskBudget
		}
		ids := append([]string(nil), call.Resources...)
		sort.Strings(ids)
		for i, resourceID := range ids {
			if i > 0 && resourceID == ids[i-1] {
				continue
			}
			var resource entity.ChatTaskResource
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&resource, "id = ?", resourceID).Error; err != nil {
				return err
			}
			if resource.Capacity < 1 {
				return ErrChatTaskQuota
			}
			// A locking read observes the latest committed holders even when
			// MySQL established a repeatable-read snapshot before this mutex.
			var held []entity.ChatTaskResourceLease
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("resource_id = ? AND task_id <> ?", resourceID, id).
				Limit(resource.Capacity).Find(&held).Error; err != nil {
				return err
			}
			if len(held) >= resource.Capacity {
				return ErrChatTaskQuota
			}
			lease := entity.ChatTaskResourceLease{ResourceID: resourceID, TaskID: id, LeaseEpoch: epoch, CreatedAt: now}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&lease).Error; err != nil {
				return err
			}
		}
		task.Calls++
		task.CheckpointReady = false
		if call.Switch {
			task.Switches++
		}
		task.CostReserved += call.EstimatedCost
		task.ResourceWaitAt = 0
		task.CostUnknown = task.CostUnknown || !call.CostKnown
		task.UpstreamStatus = "unknown"
		task.UpdatedAt = now
		attempt = &entity.ChatTaskAttempt{
			ID: common.GenerateToken(), TaskID: id, Stage: call.Stage, Number: int(count) + 1,
			LeaseEpoch: epoch, Model: call.Model, Reason: call.Reason, State: "running",
			EstimatedCost: call.EstimatedCost, CostKnown: call.CostKnown, StartedAt: now,
		}
		// Allocate the staging location before the first external side effect.
		attempt.StagingKey = fmt.Sprintf("staging/%s/%s", id, attempt.ID)
		if err := tx.Create(attempt).Error; err != nil {
			return err
		}
		task.Revision++
		if err := appendChatTaskEvent(tx, task, "attempt_started", entity.JSONMap{"attempt_id": attempt.ID, "stage": call.Stage, "model": call.Model, "reason": call.Reason, "switch": call.Switch}, now); err != nil {
			return err
		}
		return tx.Save(task).Error
	})
	return attempt, err
}

func (d *ChatTaskDAO) SettleCall(ctx context.Context, id, owner string, epoch int64, attemptID, state, upstream string, actualCost int64, usage entity.JSONMap, code string) error {
	if actualCost < 0 || (state != "succeeded" && state != "failed" && state != "unknown") ||
		(upstream != "stopped" && upstream != "running" && upstream != "unknown") {
		return errors.New("invalid call settlement")
	}
	return d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if err := checkChatTaskLease(task, owner, epoch, now); err != nil {
			return err
		}
		var attempt entity.ChatTaskAttempt
		if err := tx.Take(&attempt, "id = ? AND task_id = ? AND lease_epoch = ?", attemptID, id, epoch).Error; err != nil {
			return err
		}
		if attempt.State != "running" {
			return ErrChatTaskState
		}
		attempt.State, attempt.ActualCost, attempt.Usage = state, actualCost, usage
		attempt.ErrorCode, attempt.FinishedAt = code, now
		// A configured upper bound is not an invoice. Keep unconfirmed spend
		// reserved so another attempt cannot reuse money that may be charged.
		if usage != nil && usage["cost_confirmed"] == true {
			task.CostReserved -= attempt.EstimatedCost
		}
		task.CostActual += actualCost
		task.UpstreamStatus, task.UpdatedAt = upstream, now
		if upstream == "stopped" {
			if err := tx.Where("task_id = ? AND lease_epoch = ?", id, epoch).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Save(&attempt).Error; err != nil {
			return err
		}
		return tx.Save(task).Error
	})
}

// Dispatchable includes a repeat wakeup deadline; publish success alone never
// removes a task from the durable recovery scan.
func (d *ChatTaskDAO) Dispatchable(ctx context.Context, limit int, priorityWait time.Duration) ([]entity.ChatTask, error) {
	if limit < 1 || limit > 1000 || priorityWait < time.Second || priorityWait > 24*time.Hour {
		return nil, errors.New("invalid dispatch batch limit")
	}
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	var tasks []entity.ChatTask
	err = d.db.WithContext(ctx).Where("(state = ? OR (state = ? AND lease_owner = ?)) AND next_run_at <= ? AND dispatch_after <= ?", "queued", "running", "", now, now).
		Clauses(clause.OrderBy{Expression: clause.Expr{
			SQL:  "created_at + CASE WHEN scheduling_class = 'interactive' THEN 0 ELSE ? END ASC, id ASC",
			Vars: []interface{}{priorityWait.Milliseconds()},
		}}).Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ReconcileStopped is an operator action after checking the upstream service.
// It releases uncertain slots without rewriting the task's terminal outcome.
func (d *ChatTaskDAO) ReconcileStopped(ctx context.Context, id, evidence string) error {
	if len(evidence) < 8 || len(evidence) > 256 {
		return errors.New("reconciliation requires an evidence reference")
	}
	return d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if !IsChatTaskTerminal(task.State) {
			return ErrChatTaskState
		}
		if task.UpstreamStatus == "stopped" || task.UpstreamStatus == "not_started" {
			return nil
		}
		if err := tx.Where("task_id = ?", id).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&entity.ChatTaskAttempt{}).
			Where("task_id = ? AND state IN ?", id, []string{"running", "unknown"}).
			Updates(map[string]interface{}{"state": "failed", "error_code": "operator_confirmed_stopped", "finished_at": now}).Error; err != nil {
			return err
		}
		task.UpstreamStatus, task.UpdatedAt = "stopped", now
		task.LeaseEpoch++
		task.Revision++
		// Evidence may be an internal ticket. Retain its digest, never secrets.
		digest := sha256.Sum256([]byte(evidence))
		if err := appendChatTaskEvent(tx, task, "upstream_reconciled",
			entity.JSONMap{"upstream_status": "stopped", "evidence_sha256": fmt.Sprintf("%x", digest)}, now); err != nil {
			return err
		}
		return tx.Save(task).Error
	})
}

func (d *ChatTaskDAO) MarkDispatched(ctx context.Context, id string, delay time.Duration) error {
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return err
	}
	return d.db.WithContext(ctx).Model(&entity.ChatTask{}).Where("id = ? AND state IN ?", id, []string{"queued", "running"}).
		Update("dispatch_after", now+delay.Milliseconds()).Error
}

// Defer yields the executor without resetting the task's call or time budgets.
func (d *ChatTaskDAO) Defer(ctx context.Context, id, owner string, epoch int64, delay, maxWait time.Duration) error {
	if delay < time.Millisecond || maxWait < time.Second {
		return errors.New("invalid resource wait")
	}
	return d.Mutate(ctx, id, owner, epoch, "stage_changed",
		func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			now, err := databaseTime(tx)
			if err != nil {
				return nil, err
			}
			if !CanResumeChatTask(task) {
				return nil, ErrChatTaskState
			}
			if task.ResourceWaitAt == 0 {
				task.ResourceWaitAt = now
			}
			if now >= task.Deadline {
				return nil, ErrChatTaskDeadline
			}
			if now-task.ResourceWaitAt >= maxWait.Milliseconds() {
				return nil, ErrChatTaskResourceWaitTimeout
			}
			task.NextRunAt, task.DispatchAfter = now+delay.Milliseconds(), 0
			task.LeaseOwner, task.LeaseUntil = "", 0
			task.LeaseEpoch++
			if err := tx.Where("task_id = ?", id).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
				return nil, err
			}
			return entity.JSONMap{"state": "running", "stage": task.Stage, "reason": "resource_wait"}, nil
		})
}

// RecoverExpired isolates uncertain upstream work. A lost lease never permits
// another chargeable call; operators can reconcile the recorded attempt first.
func (d *ChatTaskDAO) RecoverExpired(ctx context.Context, limit int) error {
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return err
	}
	var tasks []entity.ChatTask
	if err := d.db.WithContext(ctx).Where("state IN ? AND lease_owner <> ? AND lease_until <= ?", []string{"running", "cancel_requested"}, "", now).
		Order("lease_until").Limit(limit).Find(&tasks).Error; err != nil {
		return err
	}
	for _, candidate := range tasks {
		if err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			task, now, err := lockChatTask(tx, candidate.ID)
			if err != nil {
				return err
			}
			if (task.State != "running" && task.State != "cancel_requested") || task.LeaseUntil > now || task.LeaseOwner == "" {
				return nil
			}
			if task.State == "running" && CanResumeChatTask(task) && task.Deadline > now {
				task.LeaseEpoch++
				task.LeaseOwner, task.LeaseUntil, task.DispatchAfter = "", 0, 0
				task.NextRunAt = now
				if err := tx.Where("task_id = ?", task.ID).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
					return err
				}
				task.Revision++
				task.UpdatedAt = now
				if err := appendChatTaskEvent(tx, task, "stage_changed", entity.JSONMap{"state": task.State, "reason": "executor_recovered", "lease_expired": true}, now); err != nil {
					return err
				}
				return tx.Save(task).Error
			}
			// Terminal outputs remain available. Unknown attempts retain resource
			// slots rather than guessing that a remote generator has stopped.
			task.ErrorCode, task.ErrorMessage = "executor_lost", "Executor stopped; upstream result requires reconciliation"
			if task.UpstreamStatus == "stopped" || task.UpstreamStatus == "not_started" {
				task.ErrorCode, task.ErrorMessage = "checkpoint_incomplete", "Executor stopped before a complete recovery checkpoint"
				if task.Deadline <= now {
					task.ErrorCode, task.ErrorMessage = "deadline_exceeded", "Task execution deadline exceeded"
				}
				if err := tx.Where("task_id = ?", task.ID).Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
					return err
				}
			}
			if task.State == "cancel_requested" {
				task.State = "cancelled"
			} else if HasChatTaskOutput(task) {
				task.State = "partial_succeeded"
			} else {
				task.State = "failed"
			}
			task.LeaseEpoch++
			task.LeaseOwner, task.LeaseUntil = "", 0
			task.Revision++
			task.FinishedAt, task.UpdatedAt = now, now
			if err := appendChatTaskEvent(tx, task, "task_terminal", entity.JSONMap{"state": task.State, "error_code": task.ErrorCode, "upstream_status": task.UpstreamStatus, "lease_expired": true}, now); err != nil {
				return err
			}
			return tx.Save(task).Error
		}); err != nil {
			return err
		}
	}
	return nil
}

func CanResumeChatTask(task *entity.ChatTask) bool {
	return task.Calls == 0 && task.UpstreamStatus == "not_started" ||
		task.UpstreamStatus == "stopped" && task.CheckpointReady && task.CheckpointCalls == task.Calls
}

func HasChatTaskOutput(task *entity.ChatTask) bool {
	return task.Outputs["text"] != nil || task.Outputs["image"] != nil || task.Outputs["audio"] != nil
}

func (d *ChatTaskDAO) Events(ctx context.Context, id string, after int64, limit int) ([]entity.ChatTaskEvent, error) {
	if after < 0 || limit < 1 || limit > 1000 {
		return nil, errors.New("invalid event cursor")
	}
	var events []entity.ChatTaskEvent
	err := d.db.WithContext(ctx).Where("task_id = ? AND seq > ?", id, after).Order("seq").Limit(limit).Find(&events).Error
	return events, err
}

func (d *ChatTaskDAO) Attempts(ctx context.Context, id string) ([]entity.ChatTaskAttempt, error) {
	attempts := make([]entity.ChatTaskAttempt, 0)
	err := d.db.WithContext(ctx).Where("task_id = ?", id).Order("started_at").Order("id").Find(&attempts).Error
	return attempts, err
}

func (d *ChatTaskDAO) List(ctx context.Context, tenantID, userID string, authorizedSessionIDs []string, sessionID, state, kind string, page, size int) ([]entity.ChatTask, int64, error) {
	if page < 1 || size < 1 || size > 100 || tenantID == "" || userID == "" {
		return nil, 0, errors.New("invalid task list")
	}
	query := d.db.WithContext(ctx).Model(&entity.ChatTask{}).Where("tenant_id = ? AND user_id = ?", tenantID, userID)
	// Check the live session/chat relationship before both count and pagination.
	sessions := d.db.WithContext(ctx).Model(&entity.ChatSession{}).Select("1").
		Joins("JOIN dialog ON dialog.id = conversation.dialog_id").
		Where("conversation.id = chat_task.session_id AND conversation.dialog_id = chat_task.chat_id").
		Where("dialog.status = ? AND conversation.id IN ?", string(entity.StatusValid), authorizedSessionIDs)
	query = query.Where("EXISTS (?)", sessions)
	if sessionID != "" {
		query = query.Where("session_id = ?", sessionID)
	}
	if state != "" {
		query = query.Where("state = ?", state)
	}
	if kind != "" {
		query = query.Where("kind = ?", kind)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	tasks := make([]entity.ChatTask, 0)
	err := query.Order("created_at DESC").Order("id").Offset((page - 1) * size).Limit(size).Find(&tasks).Error
	return tasks, total, err
}

func (d *ChatTaskDAO) EnsureResource(ctx context.Context, id string, capacity int) error {
	if id == "" || capacity < 1 {
		return errors.New("invalid resource capacity")
	}
	resource := entity.ChatTaskResource{ID: id, Capacity: capacity}
	// A second worker must not silently change another worker's device quota.
	if err := d.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&resource).Error; err != nil {
		return err
	}
	if err := d.db.WithContext(ctx).Take(&resource, "id = ?", id).Error; err != nil {
		return err
	}
	if resource.Capacity != capacity {
		return fmt.Errorf("%w: resource %s has capacity %d, configured %d", ErrChatTaskResourceConfig, id, resource.Capacity, capacity)
	}
	return nil
}

func (d *ChatTaskDAO) WorkerHeartbeat(ctx context.Context, id string, lease time.Duration) error {
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return err
	}
	worker := entity.ChatTaskWorker{ID: id, LeaseUntil: now + lease.Milliseconds()}
	return d.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(&worker).Error
}

func (d *ChatTaskDAO) WorkerAvailable(ctx context.Context) (bool, error) {
	now, err := databaseTime(d.db.WithContext(ctx))
	if err != nil {
		return false, err
	}
	var count int64
	err = d.db.WithContext(ctx).Model(&entity.ChatTaskWorker{}).Where("lease_until > ?", now).Count(&count).Error
	return count > 0, err
}

func (d *ChatTaskDAO) RecordUpstream(ctx context.Context, id, owner string, epoch int64, attemptID, upstreamID string) error {
	return d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		task, now, err := lockChatTask(tx, id)
		if err != nil {
			return err
		}
		if err := checkChatTaskLease(task, owner, epoch, now); err != nil {
			return err
		}
		return tx.Model(&entity.ChatTaskAttempt{}).Where("id = ? AND task_id = ? AND state = ?", attemptID, id, "running").
			Update("upstream_id", upstreamID).Error
	})
}
