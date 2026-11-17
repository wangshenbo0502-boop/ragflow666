package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
)

type chatTaskPhaseDiagnostics struct {
	Samples   int64 `json:"samples"`
	ElapsedMs int64 `json:"elapsed_ms"`
}

type chatTaskStageDiagnostics struct {
	Attempts         int              `json:"attempts"`
	Succeeded        int              `json:"succeeded"`
	Failed           int              `json:"failed"`
	Unknown          int              `json:"unknown"`
	Running          int              `json:"running"`
	SettledElapsedMs int64            `json:"settled_elapsed_ms"`
	RunningElapsedMs int64            `json:"running_elapsed_ms"`
	Usage            map[string]int64 `json:"usage"`
}

type chatTaskDiagnostics struct {
	ObservedAt            int64                                `json:"observed_at"`
	ElapsedMs             int64                                `json:"elapsed_ms"`
	InitialQueueMs        *int64                               `json:"initial_queue_ms"`
	FirstTextMs           *int64                               `json:"first_text_ms"`
	FirstAudioMs          *int64                               `json:"first_audio_ms"`
	Stages                map[string]*chatTaskStageDiagnostics `json:"stages"`
	Phases                map[string]*chatTaskPhaseDiagnostics `json:"phases"`
	Switches              int                                  `json:"switches"`
	SwitchedSucceeded     int                                  `json:"switched_succeeded"`
	SwitchReasons         map[string]int                       `json:"switch_reasons"`
	SwitchDetailsComplete bool                                 `json:"switch_details_complete"`
	Recoveries            int64                                `json:"recoveries"`
	LeaseExpirations      int64                                `json:"lease_expirations"`
	ResourceWaits         int64                                `json:"resource_waits"`
	EventHistoryComplete  bool                                 `json:"event_history_complete"`
	UnmeasuredPhases      []string                             `json:"unmeasured_phases"`
}

func describeChatTask(details *dao.ChatTaskDetails) chatTaskDiagnostics {
	task := details.Task
	end := details.ObservedAt
	if dao.IsChatTaskTerminal(task.State) && task.FinishedAt > 0 {
		end = task.FinishedAt
	}
	result := chatTaskDiagnostics{
		ObservedAt: details.ObservedAt, ElapsedMs: max(0, end-task.CreatedAt),
		Stages: map[string]*chatTaskStageDiagnostics{}, Switches: task.Switches,
		Phases: map[string]*chatTaskPhaseDiagnostics{}, SwitchReasons: map[string]int{},
		UnmeasuredPhases: []string{},
	}
	var eventCount int64
	switchAttempts := map[string]string{}
	first := func(target **int64, at int64) {
		elapsed := max(0, at-task.CreatedAt)
		if *target == nil || elapsed < **target {
			*target = &elapsed
		}
	}
	for _, event := range details.Events {
		eventCount += event.Count
		switch event.Type {
		case "phase_measured":
			phase := stringValue(event.Data["phase"])
			if !isChatTaskMeasuredPhase(phase) || event.Count < 1 {
				continue
			}
			raw, err := json.Marshal(event.Data["elapsed_ms"])
			var elapsed int64
			if err != nil || string(raw) == "null" || json.Unmarshal(raw, &elapsed) != nil || elapsed < 0 {
				continue
			}
			if result.Phases[phase] == nil {
				result.Phases[phase] = &chatTaskPhaseDiagnostics{}
			}
			result.Phases[phase].Samples += event.Count
			result.Phases[phase].ElapsedMs += elapsed * event.Count
		case "stage_changed":
			if event.Data["state"] == "running" && event.Data["reason"] == nil {
				first(&result.InitialQueueMs, event.FirstAt)
			}
			if event.Data["reason"] == "executor_recovered" {
				result.Recoveries += event.Count
			}
			if event.Data["reason"] == "resource_wait" {
				result.ResourceWaits += event.Count
			}
		case "output_committed":
			switch event.Data["kind"] {
			case "text":
				first(&result.FirstTextMs, event.FirstAt)
			case "audio":
				first(&result.FirstAudioMs, event.FirstAt)
			}
		case "attempt_started":
			if event.Data["switch"] == true {
				switchAttempts[stringValue(event.Data["attempt_id"])] = stringValue(event.Data["reason"])
			}
		}
		if event.Data["lease_expired"] == true {
			result.LeaseExpirations += event.Count
		}
	}
	for _, phase := range []string{"planning", "retrieval", "save"} {
		if result.Phases[phase] == nil {
			result.UnmeasuredPhases = append(result.UnmeasuredPhases, phase)
		}
	}
	result.EventHistoryComplete = eventCount == task.EventSeq
	matchedSwitches := 0
	for _, attempt := range details.Attempts {
		stage := result.Stages[attempt.Stage]
		if stage == nil {
			stage = &chatTaskStageDiagnostics{Usage: map[string]int64{}}
			result.Stages[attempt.Stage] = stage
		}
		stage.Attempts++
		switch attempt.State {
		case "succeeded":
			stage.Succeeded++
		case "failed":
			stage.Failed++
		case "unknown":
			stage.Unknown++
		case "running":
			stage.Running++
		}
		if attempt.FinishedAt > 0 {
			stage.SettledElapsedMs += max(0, attempt.FinishedAt-attempt.StartedAt)
		} else {
			stage.RunningElapsedMs += max(0, end-attempt.StartedAt)
		}
		for _, key := range []string{"input_tokens", "output_tokens", "total_tokens", "response_time_ms"} {
			raw, err := json.Marshal(attempt.Usage[key])
			var count int64
			if err == nil && string(raw) != "null" && json.Unmarshal(raw, &count) == nil && count >= 0 {
				stage.Usage[key] += count
			}
		}
		if reason, switched := switchAttempts[attempt.ID]; switched {
			matchedSwitches++
			result.SwitchReasons[reason]++
			if attempt.State == "succeeded" {
				result.SwitchedSucceeded++
			}
		}
	}
	result.SwitchDetailsComplete = result.EventHistoryComplete &&
		len(switchAttempts) == task.Switches && matchedSwitches == task.Switches
	return result
}

func isChatTaskMeasuredPhase(phase string) bool {
	return phase == "planning" || phase == "retrieval" || phase == "save"
}

// Phase spans are inclusive; planning can contain retrieval and model calls.
// Closing a span twice must not count it again on an early-return path.
func measureChatTaskPhase(ctx context.Context, phase string) func() {
	execution := chatExecution(ctx)
	if execution == nil || !isChatTaskMeasuredPhase(phase) {
		return func() {}
	}
	started := time.Now()
	var once sync.Once
	return func() {
		once.Do(func() {
			elapsed := time.Since(started).Milliseconds()
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
			defer cancel()
			if err := execution.dao.Mutate(recordCtx, execution.task.ID, execution.owner,
				execution.task.LeaseEpoch, "phase_measured",
				func(_ *gorm.DB, _ *entity.ChatTask) (entity.JSONMap, error) {
					return entity.JSONMap{"phase": phase, "elapsed_ms": elapsed}, nil
				}); err != nil {
				common.Warn("chat task phase measurement not persisted",
					zap.String("task_id", execution.task.ID), zap.String("phase", phase))
			}
		})
	}
}

func chatTaskLogFields(task *entity.ChatTask) []zap.Field {
	return []zap.Field{
		zap.String("task_id", task.ID), zap.String("turn_id", task.TurnID),
		zap.String("session_id", task.SessionID), zap.String("state", task.State),
		zap.String("stage", task.Stage), zap.String("error_code", task.ErrorCode),
		zap.Int("calls", task.Calls), zap.Int("switches", task.Switches),
	}
}

func chatTaskDiagnosticCause(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, dao.ErrChatTaskDeadline) {
		return "deadline_exceeded"
	}
	if errors.Is(err, dao.ErrChatTaskResourceWaitTimeout) {
		return "resource_wait_timeout"
	}
	if errors.Is(err, dao.ErrChatTaskResourceConfig) {
		return "resource_config_mismatch"
	}
	switch {
	case errors.Is(err, models.ErrChatMaxOutput):
		return "max_output_validation"
	case errors.Is(err, models.ErrModelDriverUnavailable):
		return "model_driver_missing"
	}
	if errors.Is(err, errModelConfigUnavailable) {
		return "model_configuration_unavailable"
	}
	var status *models.APIStatusError
	if errors.As(err, &status) {
		return "upstream_http_status"
	}
	switch {
	case strings.Contains(err.Error(), "model health"):
		return "model_health_persistence"
	case strings.Contains(err.Error(), "route_no_eligible_candidate"):
		return "no_eligible_route_candidate"
	case strings.Contains(err.Error(), "unsupported_capability"):
		return "unsupported_capability"
	case strings.Contains(err.Error(), "provider_identity_changed"):
		return "provider_identity_changed"
	case strings.Contains(err.Error(), "persistence_failed"):
		return "persistence_failed"
	default:
		return "unclassified"
	}
}

func chatTaskFailureDiagnostics(err error) entity.JSONMap {
	if err == nil {
		return entity.JSONMap{}
	}
	return entity.JSONMap{
		"diagnostic_cause": chatTaskDiagnosticCause(err),
		"error_type":       fmt.Sprintf("%T", err),
	}
}

func chatTaskStatisticsLogFields(stats *dao.ChatTaskStatistics) []zap.Field {
	return []zap.Field{
		zap.Int64("observed_at", stats.ObservedAt),
		zap.Any("task_states", stats.TaskStates),
		zap.Int64("unknown_upstreams", stats.UnknownUpstreams),
		zap.Int64("unreferenced_media", stats.UnreferencedMedia),
		zap.Int64("reclaimable_media", stats.ReclaimableMedia),
		zap.Int64("cleanup_pending", stats.CleanupPending),
		zap.Int64("cleanup_retries", stats.CleanupRetries),
		zap.Int64("cleanup_oldest_ms", stats.CleanupOldestMs),
	}
}
