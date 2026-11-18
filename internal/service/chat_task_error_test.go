package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
)

func TestChatTaskErrorClassification(t *testing.T) {
	for _, scenario := range []struct {
		err  error
		code string
	}{
		{context.DeadlineExceeded, "deadline_exceeded"},
		{dao.ErrChatTaskBudget, "budget_exhausted"},
		{dao.ErrChatTaskDeadline, "deadline_exceeded"},
		{dao.ErrChatTaskResourceWaitTimeout, "resource_unavailable"},
		{fmt.Errorf("resource secret: %w", dao.ErrChatTaskResourceConfig), "resource_config_mismatch"},
		{dao.ErrChatMediaReclaimed, "attachment_unavailable"},
		{fmt.Errorf("persistence_failed: secret storage: %w", dao.ErrAnswerVersion), "revision_conflict"},
		{fmt.Errorf("secret provider: %w", errChatModelConfigurationChanged), "provider_identity_changed"},
		{fmt.Errorf("%w: secret model", errModelConfigUnavailable), "unsupported_capability"},
		{fmt.Errorf("%w: provider %q driver not found: %w", errModelConfigUnavailable, "secret-provider", models.ErrModelDriverUnavailable), "model_driver_missing"},
		{fmt.Errorf("secret model parameters: %w", models.ErrChatMaxOutput), "max_output_validation"},
		{models.ErrModelDriverUnavailable, "model_driver_missing"},
		{fmt.Errorf("%w: %w", permission.ErrPermissionDenied, models.ErrModelDriverUnavailable), "forbidden"},
		{&models.APIStatusError{Status: 503, Body: "chat max_tokens secret URL https://secret.invalid?key=secret"}, "upstream_unavailable"},
		{errors.New("untrusted error chat max_tokens 2048 exceeds model max_output 1024"), "upstream_unavailable"},
		{ErrNoDefaultModel, "unsupported_capability"},
		{fmt.Errorf("%w: secret identity: %w", errModelConfigUnavailable, permission.ErrPermissionDenied), "forbidden"},
		{fmt.Errorf("secret membership: %w", permission.ErrMembershipNotFound), "forbidden"},
		{permission.ErrIdentityMismatch, "forbidden"},
		{fmt.Errorf("%w: secret model: %w", errModelConfigUnavailable, permission.ErrResourceNotFound), "not_found"},
		{fmt.Errorf("model: %w", &models.APIStatusError{Status: 429, Body: "secret"}), "upstream_rate_limited"},
		{errors.New("invalid_plan: secret model output"), "invalid_plan"},
		{&models.APIStatusError{Status: 503, Body: "secret"}, "upstream_unavailable"},
		{errors.New("persistence_failed: secret storage URL"), "persistence_failed"},
		{errors.New("checkpoint_incomplete: secret object"), "checkpoint_incomplete"},
		{errors.New("context_budget_exceeded: secret attachment"), "context_budget_exceeded"},
		{errors.New("route_no_eligible_candidate: secret model"), "route_no_eligible_candidate"},
		{errors.New("budget_exceeded: secret candidate"), "budget_exceeded"},
		{errors.New("vision_model_required: secret model"), "vision_model_required"},
	} {
		code, message := chatTaskError(scenario.err)
		if code != scenario.code || strings.Contains(message, "secret") {
			t.Fatalf("classification = %s %q; want %s", code, message, scenario.code)
		}
	}
}

func TestChatTaskRetryUsesSavedStageCheckpoints(t *testing.T) {
	for _, scenario := range []struct {
		name, kind, upstream, state string
		text, audio, image          bool
		stages                      []string
		reason                      string
	}{
		{name: "speech-with-text", kind: "语音", text: true, stages: []string{"audio"}},
		{name: "speech-without-text", kind: "语音", reason: "no_retryable_stage"},
		{name: "both-failed", kind: "image_voice", text: true, stages: []string{"image", "audio"}},
		{name: "audio-done", kind: "image_voice", text: true, audio: true, stages: []string{"image"}},
		{name: "image-done", kind: "image_voice", text: true, image: true, stages: []string{"audio"}},
		{name: "image-only", kind: "生图", stages: []string{"image"}},
		{name: "unknown", kind: "语音", text: true, upstream: "unknown", reason: "upstream_result_unknown"},
		{name: "still-running", kind: "语音", text: true, upstream: "running", reason: "upstream_result_unknown"},
		{name: "cancelled", kind: "语音", text: true, state: "cancelled", reason: "task_not_retryable"},
		{name: "succeeded", kind: "语音", text: true, state: "succeeded", reason: "task_not_retryable"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			raw, _ := json.Marshal(chatTaskInput{Kind: scenario.kind})
			task := &entity.ChatTask{State: "partial_succeeded", UpstreamStatus: "stopped", Input: string(raw), Outputs: entity.JSONMap{}}
			if scenario.state != "" {
				task.State = scenario.state
			}
			if scenario.upstream != "" {
				task.UpstreamStatus = scenario.upstream
			}
			if scenario.text {
				task.Outputs["answer"] = map[string]interface{}{"content": "saved", "answer_version": int64(1)}
				task.Outputs["text"] = map[string]interface{}{"speech_plan": chatSpeechPlan{Answer: "saved", Voice: chatVoiceName}}
			}
			if scenario.audio {
				task.Outputs["audio"] = []interface{}{"saved"}
			}
			if scenario.image {
				task.Outputs["image"] = []interface{}{"saved"}
			}
			result := chatTaskRetryOptions(task)
			want := scenario.stages
			if want == nil {
				want = []string{}
			}
			if !reflect.DeepEqual(result.Stages, want) || result.Reason != scenario.reason {
				t.Fatalf("retry=%+v; want %v %s", result, want, scenario.reason)
			}
		})
	}
}
