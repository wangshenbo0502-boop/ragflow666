package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
)

type chatTaskQueue interface {
	InitChatTasks(context.Context, string, string, time.Duration, int) error
	PublishChatTask(context.Context, string, string) error
	PullChatTask(context.Context, string, string) (jetstream.Msg, error)
}

type ChatTaskWorker struct {
	config  ChatTaskConfig
	queue   chatTaskQueue
	service *ChatSessionService
	dao     *dao.ChatTaskDAO
	id      string
	cancel  context.CancelFunc
	abort   context.CancelFunc
	runCtx  context.Context
	wg      sync.WaitGroup
}

func StartChatTaskWorker(ctx context.Context, queue interface{}) (*ChatTaskWorker, error) {
	config, err := LoadChatTaskConfig()
	if err != nil || !config.Enabled {
		return nil, err
	}
	q, ok := queue.(chatTaskQueue)
	if !ok {
		return nil, errors.New("chat worker requires a NATS JetStream queue")
	}
	if err := q.InitChatTasks(ctx, config.Namespace, config.Consumer, config.AckWait, config.MaxDeliver); err != nil {
		return nil, err
	}
	d := dao.NewChatTaskDAO(dao.DB)
	if err := d.EnsureResource(ctx, config.Device, config.DeviceCapacity); err != nil {
		return nil, err
	}
	runCtx, abort := context.WithCancel(context.WithoutCancel(ctx))
	intakeCtx, cancel := context.WithCancel(runCtx)
	w := &ChatTaskWorker{config: config, queue: q, service: NewChatSessionService(), dao: d,
		id: common.GenerateToken(), cancel: cancel, abort: abort, runCtx: runCtx}
	if err := d.WorkerHeartbeat(ctx, w.id, config.Lease); err != nil {
		cancel()
		abort()
		return nil, err
	}
	w.wg.Add(1)
	go w.scan(intakeCtx)
	w.wg.Add(1)
	go w.cleanup(intakeCtx, storage.GetStorageFactory().GetStorage())
	for i := 0; i < config.Workers; i++ {
		w.wg.Add(1)
		go w.consume(intakeCtx)
	}
	return w, nil
}

func (w *ChatTaskWorker) Stop(ctx context.Context) {
	if w == nil {
		return
	}
	w.cancel()
	defer w.abort()
	done := make(chan struct{})
	go func() { w.wg.Wait(); close(done) }()
	drainCtx, stop := context.WithTimeout(ctx, w.config.ShutdownTimeout)
	defer stop()
	select {
	case <-done:
	case <-drainCtx.Done():
		w.abort()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			common.Warn("chat worker drain deadline elapsed; unfinished calls require reconciliation")
		}
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = dao.DB.WithContext(cleanupCtx).Delete(&entity.ChatTaskWorker{}, "id = ?", w.id).Error
}

func (w *ChatTaskWorker) scan(ctx context.Context) {
	defer w.wg.Done()
	ticker := time.NewTicker(w.config.Scan)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := w.dao.RecoverExpired(ctx, 100); err != nil {
			common.Warn("chat task recovery scan failed")
		}
		tasks, err := w.dao.Dispatchable(ctx, 100, w.config.PriorityWait)
		healthy := err == nil
		for _, task := range tasks {
			if err := w.queue.PublishChatTask(ctx, w.config.Namespace, task.ID); err != nil {
				healthy = false
				break
			}
			_ = w.dao.MarkDispatched(ctx, task.ID, w.config.AckWait)
		}
		if healthy {
			if err := w.dao.WorkerHeartbeat(ctx, w.id, w.config.Lease); err != nil {
				common.Warn("chat worker heartbeat failed")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// One bounded sweep at a time; storage latency never occupies the dispatcher.
func (w *ChatTaskWorker) cleanup(ctx context.Context, store storage.Storage) {
	defer w.wg.Done()
	if store == nil {
		return
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for ctx.Err() == nil {
		sweepCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err := w.dao.CleanupMedia(sweepCtx, store, w.config.CleanupGrace, w.config.CleanupBatch)
		cancel()
		if err != nil && ctx.Err() == nil {
			common.Warn("chat media cleanup scan failed")
		}
		if ctx.Err() == nil {
			statsCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			stats, statsErr := w.dao.Statistics(statsCtx, w.config.CleanupGrace)
			stop()
			if statsErr != nil {
				common.Warn("chat task operational statistics unavailable")
			} else {
				fields := chatTaskStatisticsLogFields(stats)
				common.Info("chat task operational statistics", fields...)
				if stats.ReclaimableMedia >= int64(w.config.CleanupAlertThreshold) || stats.CleanupRetries > 0 {
					common.Warn("chat media cleanup backlog", fields...)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *ChatTaskWorker) consume(ctx context.Context) {
	defer w.wg.Done()
	for ctx.Err() == nil {
		pullCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		msg, err := w.queue.PullChatTask(pullCtx, w.config.Namespace, w.config.Consumer)
		cancel()
		if err != nil || msg == nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(250 * time.Millisecond):
			}
			continue
		}
		if ctx.Err() != nil {
			_ = msg.NakWithDelay(w.config.Scan)
			return
		}
		if err := w.execute(w.runCtx, string(msg.Data()), msg); err != nil {
			_ = msg.NakWithDelay(w.config.Scan)
		} else {
			_ = msg.Ack()
		}
	}
}

func (w *ChatTaskWorker) execute(ctx context.Context, id string, msg jetstream.Msg) error {
	task, err := w.dao.Claim(ctx, id, w.id, w.config.Lease)
	if errors.Is(err, dao.ErrChatTaskState) || errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil || task == nil {
		return err
	}
	common.Info("chat task claimed", chatTaskLogFields(task)...)
	jobCtx, cancel := context.WithDeadline(ctx, time.UnixMilli(task.Deadline))
	defer cancel()
	jobCtx = permission.WithIdentity(jobCtx, task.UserID, task.TenantID)
	execution := &chatTaskExecution{service: w.service, dao: w.dao, task: task, config: w.config, owner: w.id}
	jobCtx = context.WithValue(jobCtx, chatTaskExecutionKey{}, execution)
	jobCtx = common.WithModelCallObserver(jobCtx, execution)
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		ticker := time.NewTicker(w.config.Renew)
		defer ticker.Stop()
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				ok, err := w.dao.Renew(jobCtx, id, w.id, task.LeaseEpoch, w.config.Lease)
				if err != nil || !ok || (msg != nil && msg.InProgress() != nil) {
					cancel()
					return
				}
				current, err := w.dao.Get(jobCtx, id)
				if err != nil || current.State == "cancel_requested" {
					cancel()
					return
				}
			}
		}
	}()
	var input chatTaskInput
	if err = json.Unmarshal([]byte(task.Input), &input); err == nil {
		if len(task.Outputs) > 0 {
			input.Resume = task.Outputs
			if answer, ok := task.Outputs["answer"].(map[string]interface{}); ok {
				input.ExpectedAnswerVersion, err = chatAnswerVersion(answer)
				input.ExpectedAnswerAbsent = false
			}
		}
		execution.input = &input
		if err == nil {
			err = execution.checkPermission(jobCtx)
		}
		if err == nil {
			var current *entity.Chat
			current, err = w.service.chatSessionDAO.GetDialogByID(jobCtx, dao.DB, task.ChatID)
			if err == nil {
				if err = restoreChatCredentials(input.Chat.PromptConfig, current.PromptConfig); err == nil {
					err = restoreChatCredentials(input.Chat.LLMSetting, current.LLMSetting)
				}
			}
		}
	}
	if err == nil {
		var session *entity.ChatSession
		session, err = w.service.chatSessionDAO.GetByID(jobCtx, dao.DB, task.SessionID)
		if err == nil {
			_, err = w.service.completeMedia(jobCtx, &input.Chat, session, input.Messages,
				task.TurnID, input.Kind, input.Prompt, input.Options)
		}
	}
	cancel()
	<-renewDone
	if execution.deferred.Load() {
		err = errChatTaskDeferred
	}
	finalCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	if errors.Is(err, errChatTaskDeferred) {
		deferErr := w.dao.Defer(finalCtx, id, w.id, task.LeaseEpoch, w.config.Scan, w.config.ResourceWait)
		if deferErr == nil {
			return nil
		}
		err = deferErr
	}
	commitErr := w.dao.Mutate(finalCtx, id, w.id, task.LeaseEpoch, "task_terminal",
		func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
			switch {
			case current.State == "cancel_requested":
				current.State = "cancelled"
			case err == nil && current.UpstreamStatus != "unknown" && current.UpstreamStatus != "running":
				current.State = "succeeded"
			case dao.HasChatTaskOutput(current):
				current.State = "partial_succeeded"
			default:
				current.State = "failed"
			}
			if err != nil {
				current.ErrorCode, current.ErrorMessage = chatTaskError(err)
			}
			if current.UpstreamStatus == "unknown" || current.UpstreamStatus == "running" {
				current.ErrorCode, current.ErrorMessage = "upstream_result_unknown", "上游结果尚未确认，暂不能重新生成"
			}
			event := entity.JSONMap{"state": current.State, "error_code": current.ErrorCode,
				"upstream_status": current.UpstreamStatus}
			for key, value := range chatTaskFailureDiagnostics(err) {
				event[key] = value
			}
			return event, nil
		})
	if commitErr == nil {
		if current, readErr := w.dao.Get(finalCtx, id); readErr == nil {
			common.Info("chat task finished", chatTaskLogFields(current)...)
			if err != nil {
				common.Warn("chat task execution failed",
					append(chatTaskLogFields(current),
						zap.String("error_type", fmt.Sprintf("%T", err)),
						zap.String("cause", chatTaskDiagnosticCause(err)))...)
			}
		}
	}
	return commitErr
}
