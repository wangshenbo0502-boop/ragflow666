package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
)

func TestChatTaskDiagnosticCause(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", want: ""},
		{name: "deadline", err: context.DeadlineExceeded, want: "deadline_exceeded"},
		{name: "task deadline", err: dao.ErrChatTaskDeadline, want: "deadline_exceeded"},
		{name: "resource wait timeout", err: dao.ErrChatTaskResourceWaitTimeout, want: "resource_wait_timeout"},
		{name: "cancelled", err: context.Canceled, want: "cancelled"},
		{name: "model config", err: fmt.Errorf("%w: model is inactive", errModelConfigUnavailable), want: "model_configuration_unavailable"},
		{name: "max output", err: fmt.Errorf("secret model: %w", models.ErrChatMaxOutput), want: "max_output_validation"},
		{name: "missing driver", err: fmt.Errorf("%w: provider %q driver not found: %w", errModelConfigUnavailable, "secret-provider", models.ErrModelDriverUnavailable), want: "model_driver_missing"},
		{name: "nil chat driver", err: models.ErrModelDriverUnavailable, want: "model_driver_missing"},
		{name: "upstream body", err: &models.APIStatusError{Status: 503, Body: "chat max_tokens secret"}, want: "upstream_http_status"},
		{name: "untrusted max tokens", err: errors.New("chat max_tokens from an untrusted response"), want: "unclassified"},
		{name: "health persistence", err: errors.New("model health update failed"), want: "model_health_persistence"},
		{name: "route candidates", err: errors.New("route_no_eligible_candidate: no eligible model"), want: "no_eligible_route_candidate"},
		{name: "capability", err: errors.New("unsupported_capability: image"), want: "unsupported_capability"},
		{name: "provider identity", err: errors.New("provider_identity_changed: configuration"), want: "provider_identity_changed"},
		{name: "persistence", err: errors.New("persistence_failed: commit"), want: "persistence_failed"},
		{name: "unknown", err: errors.New("unclassified internal failure"), want: "unclassified"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := chatTaskDiagnosticCause(test.err); got != test.want {
				t.Fatalf("chatTaskDiagnosticCause(%v) = %q, want %q", test.err, got, test.want)
			}
		})
	}
}

func TestChatTaskFailureDiagnosticsAreAllowlisted(t *testing.T) {
	err := errors.New("provider response contains private-key-and-request-body")
	diagnostics := chatTaskFailureDiagnostics(err)
	raw, marshalErr := json.Marshal(diagnostics)
	if marshalErr != nil || strings.Contains(string(raw), "private-key-and-request-body") {
		t.Fatal("failure diagnostics persisted raw error text")
	}
	if diagnostics["diagnostic_cause"] != "unclassified" ||
		diagnostics["error_type"] != "*errors.errorString" || len(diagnostics) != 2 {
		t.Fatalf("unexpected failure diagnostics: %+v", diagnostics)
	}
}

func TestChatTaskDiagnosticsPersistedAttempts(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	execution.input.Chat.LLMID = "frozen-model"
	execution.input.Chat.TenantLLMID = strPtr("tenant-model-row")
	execution.input.Options["route_policy"] = "fixed"
	snapshot, err := json.Marshal(execution.input)
	if err != nil {
		t.Fatal(err)
	}
	if err := dao.DB.Model(&entity.ChatTask{}).Where("id = ?", execution.task.ID).
		Update("input", string(snapshot)).Error; err != nil {
		t.Fatal(err)
	}
	firstCtx := common.WithModelCallDetails(ctx, common.ModelCallDetails{Reason: "preferred"})
	_, finish, err := execution.Begin(firstCtx, "language", "preferred-model")
	if err != nil {
		t.Fatal(err)
	}
	finish(&models.APIStatusError{Status: 503})
	usage := &common.ModelUsage{InputTokens: 21, OutputTokens: 8, TotalTokens: 29}
	nextCtx := common.WithModelCallUsage(ctx, usage)
	nextCtx = common.WithModelCallDetails(nextCtx, common.ModelCallDetails{Reason: "service_unavailable", Switch: true})
	_, finish, err = execution.Begin(nextCtx, "language", "backup-model")
	if err != nil {
		t.Fatal(err)
	}
	finish(nil)
	reply := map[string]interface{}{"answer": "saved text", "reference": map[string]interface{}{"chunks": []interface{}{"source"}}}
	if err := execution.commitText(ctx, reply, chatTextAnswer("turn", reply)); err != nil {
		t.Fatal(err)
	}
	if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "task_terminal",
		func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			task.State = "partial_succeeded"
			return entity.JSONMap{"state": task.State}, nil
		}); err != nil {
		t.Fatal(err)
	}
	result, err := execution.service.GetChatTask(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := result["diagnostics"].(chatTaskDiagnostics)
	task := result["task"].(*entity.ChatTask)
	attempts := result["attempts"].([]entity.ChatTaskAttempt)
	routing := result["routing_snapshot"].(map[string]interface{})
	if routing["tenant_id"] != task.TenantID || routing["tenant_llm_id"] != "tenant-model-row" ||
		routing["model_id"] != "frozen-model" || routing["route_policy"] != "fixed" {
		t.Fatalf("routing diagnostics do not reflect the frozen task snapshot: %+v", routing)
	}
	language := diagnostics.Stages["language"]
	if language == nil || language.Attempts != 2 || language.Succeeded != 1 || language.Failed != 1 ||
		language.Running != 0 || language.Usage["total_tokens"] != 29 {
		t.Fatalf("settled attempts lost their stage/usage attribution: %+v", language)
	}
	if diagnostics.Switches != 1 || diagnostics.SwitchedSucceeded != 1 ||
		diagnostics.SwitchReasons["service_unavailable"] != 1 || !diagnostics.SwitchDetailsComplete ||
		!diagnostics.EventHistoryComplete || diagnostics.FirstTextMs == nil ||
		diagnostics.FirstAudioMs != nil || diagnostics.InitialQueueMs == nil {
		t.Fatalf("incorrect persisted task milestones: %+v", diagnostics)
	}
	if diagnostics.ElapsedMs != task.FinishedAt-task.CreatedAt || len(attempts) != 2 ||
		language.SettledElapsedMs != attempts[0].FinishedAt-attempts[0].StartedAt+attempts[1].FinishedAt-attempts[1].StartedAt {
		t.Fatal("durations are not derived from the persisted timestamps")
	}
	if !reflect.DeepEqual(diagnostics.UnmeasuredPhases, []string{"planning", "retrieval"}) ||
		diagnostics.Phases["save"] == nil || diagnostics.Phases["save"].Samples != 1 {
		t.Fatal("unmeasured phases must not be reported as zero latency")
	}
}

func TestChatTaskPhaseMeasurementsPersistOnceAndRespectLease(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	for range 2 {
		finish := measureChatTaskPhase(ctx, "planning")
		var callers sync.WaitGroup
		for range 8 {
			callers.Go(finish)
		}
		callers.Wait()
	}
	details, err := execution.dao.Details(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := describeChatTask(details)
	if diagnostics.Phases["planning"] == nil || diagnostics.Phases["planning"].Samples != 2 ||
		!reflect.DeepEqual(diagnostics.UnmeasuredPhases, []string{"retrieval", "save"}) ||
		!diagnostics.EventHistoryComplete {
		t.Fatalf("phase closures were duplicated or not persisted: %+v", diagnostics)
	}
	var recordedMs int64
	for _, event := range details.Events {
		if event.Type == "phase_measured" {
			raw, _ := json.Marshal(event.Data["elapsed_ms"])
			var elapsed int64
			if json.Unmarshal(raw, &elapsed) != nil || elapsed < 0 {
				t.Fatal("invalid persisted elapsed time")
			}
			recordedMs += elapsed * event.Count
		}
	}
	if diagnostics.Phases["planning"].ElapsedMs != recordedMs {
		t.Fatal("phase duration disagrees with the persisted event samples")
	}
	finishLate := measureChatTaskPhase(ctx, "save")
	if err := dao.DB.Model(&entity.ChatTask{}).Where("id = ?", execution.task.ID).
		Update("lease_epoch", execution.task.LeaseEpoch+1).Error; err != nil {
		t.Fatal(err)
	}
	finishLate()
	measureChatTaskPhase(ctx, "private-provider-response")()
	measureChatTaskPhase(context.Background(), "retrieval")()
	latest, err := execution.dao.Details(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Task.EventSeq != details.Task.EventSeq || describeChatTask(latest).Phases["save"] != nil {
		t.Fatal("an expired executor or unsupported phase changed the diagnostic history")
	}
}

func TestChatTaskDiagnosticsRejectInvalidPhaseSamples(t *testing.T) {
	details := &dao.ChatTaskDetails{
		Task: &entity.ChatTask{EventSeq: 8},
		Events: []dao.ChatTaskEventSummary{
			{Type: "phase_measured", Count: 3, Data: entity.JSONMap{"phase": "retrieval", "elapsed_ms": 7}},
			{Type: "phase_measured", Count: 1, Data: entity.JSONMap{"phase": "planning", "elapsed_ms": -1}},
			{Type: "phase_measured", Count: 1, Data: entity.JSONMap{"phase": "planning", "elapsed_ms": 1.5}},
			{Type: "phase_measured", Count: 1, Data: entity.JSONMap{"phase": "save", "elapsed_ms": nil}},
			{Type: "phase_measured", Count: 1, Data: entity.JSONMap{"phase": "save", "elapsed_ms": "10"}},
			{Type: "phase_measured", Count: 1, Data: entity.JSONMap{"phase": "private-provider-response", "elapsed_ms": 20}},
		},
	}
	result := describeChatTask(details)
	if len(result.Phases) != 1 || result.Phases["retrieval"].Samples != 3 ||
		result.Phases["retrieval"].ElapsedMs != 21 || !result.EventHistoryComplete ||
		!reflect.DeepEqual(result.UnmeasuredPhases, []string{"planning", "save"}) {
		t.Fatalf("invalid phase data entered the diagnostics: %+v", result)
	}
}

func TestChatTaskOperationalStatisticsLogFields(t *testing.T) {
	stats := &dao.ChatTaskStatistics{
		ObservedAt: 123, TaskStates: map[string]int64{"succeeded": 3, "partial_succeeded": 2},
		UnknownUpstreams: 1, UnreferencedMedia: 8, ReclaimableMedia: 6,
		CleanupPending: 4, CleanupRetries: 2, CleanupOldestMs: 9000,
	}
	core, observed := observer.New(zap.InfoLevel)
	zap.New(core).Info("chat task operational statistics", chatTaskStatisticsLogFields(stats)...)
	fields := observed.All()[0].ContextMap()
	if len(fields) != 8 || fields["observed_at"] != stats.ObservedAt ||
		fields["unknown_upstreams"] != stats.UnknownUpstreams ||
		fields["unreferenced_media"] != stats.UnreferencedMedia ||
		fields["reclaimable_media"] != stats.ReclaimableMedia ||
		fields["cleanup_pending"] != stats.CleanupPending ||
		fields["cleanup_retries"] != stats.CleanupRetries ||
		fields["cleanup_oldest_ms"] != stats.CleanupOldestMs ||
		!reflect.DeepEqual(fields["task_states"], stats.TaskStates) {
		t.Fatalf("operational log fields lost counts or included unrelated data: %+v", fields)
	}
}

func TestChatTaskDiagnosticsMissingEventsAndInheritedOutputs(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "output_reused",
		func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			task.RetryOf = "previous-task"
			task.Outputs = entity.JSONMap{"text": map[string]interface{}{"answer": "inherited text"}}
			return entity.JSONMap{"retry_of": task.RetryOf}, nil
		}); err != nil {
		t.Fatal(err)
	}
	result, err := execution.service.GetChatTask(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := result["diagnostics"].(chatTaskDiagnostics)
	if diagnostics.FirstTextMs != nil || diagnostics.FirstAudioMs != nil || !diagnostics.EventHistoryComplete {
		t.Fatal("inherited output was counted as new generation")
	}
	if err := dao.DB.Delete(&entity.ChatTaskEvent{}, "task_id = ? AND seq = ?", execution.task.ID, 1).Error; err != nil {
		t.Fatal(err)
	}
	result, err = execution.service.GetChatTask(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics = result["diagnostics"].(chatTaskDiagnostics)
	if diagnostics.EventHistoryComplete || diagnostics.SwitchDetailsComplete {
		t.Fatal("pruned event history must be reported as incomplete")
	}
	details := &dao.ChatTaskDetails{
		Task: &entity.ChatTask{Switches: 1, EventSeq: 1},
		Events: []dao.ChatTaskEventSummary{{
			Type: "attempt_started", Count: 1,
			Data: entity.JSONMap{"attempt_id": "missing-attempt", "switch": true, "reason": "service_unavailable"},
		}},
	}
	if describeChatTask(details).SwitchDetailsComplete {
		t.Fatal("a switch event without its attempt must be reported as incomplete")
	}
}

func TestChatTaskDiagnosticOutputOmitsPrivateData(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	marker := "private-key-and-base64-content"
	_, finish, err := execution.Begin(ctx, "audio", "fixed-model")
	if err != nil {
		t.Fatal(err)
	}
	finish(nil)
	if err := dao.DB.Model(&entity.ChatTaskAttempt{}).Where("task_id = ?", execution.task.ID).
		Update("usage", entity.JSONMap{"input_tokens": 12, "output_tokens": -7, "total_tokens": "invalid",
			"provider_response": marker, "audio_base64": marker}).Error; err != nil {
		t.Fatal(err)
	}
	result, err := execution.service.GetChatTask(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := result["diagnostics"].(chatTaskDiagnostics)
	usage := diagnostics.Stages["audio"].Usage
	if len(usage) != 1 || usage["input_tokens"] != 12 {
		t.Fatalf("unvalidated/provider-specific usage entered diagnostics: %v", usage)
	}
	raw, err := json.Marshal(diagnostics)
	if err != nil || strings.Contains(string(raw), marker) {
		t.Fatal("diagnostics leaked private provider data")
	}
	task := result["task"].(*entity.ChatTask)
	task.Input, task.ErrorMessage = marker, marker
	task.Outputs = entity.JSONMap{"audio_base64": marker}
	core, observed := observer.New(zap.InfoLevel)
	zap.New(core).Info("chat task finished", chatTaskLogFields(task)...)
	logged, err := json.Marshal(observed.All())
	if err != nil || strings.Contains(string(logged), marker) {
		t.Fatal("task log leaked input, output or an unfiltered error")
	}
	fields := observed.All()[0].ContextMap()
	if fields["task_id"] != task.ID || fields["turn_id"] != task.TurnID || fields["session_id"] != task.SessionID {
		t.Fatal("task log lost its correlation fields")
	}
	checker := execution.service.permissionChecker.(*fakeSessionStore)
	delete(checker.sessions, task.SessionID)
	if _, err := execution.service.GetChatTask(ctx, task.ID); err == nil {
		t.Fatal("revoked session access still exposed diagnostics")
	}
}
