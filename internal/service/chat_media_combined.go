package service

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"ragflow/internal/entity"
)

// Branches execute sequentially so a task never holds one device while waiting
// for another. Each branch commits independently against the same frozen text.
func (s *ChatSessionService) completeChatImageVoice(ctx context.Context, dialog *entity.Chat, session *entity.ChatSession,
	messages []map[string]interface{}, messageID, prompt string, options map[string]interface{}) (map[string]interface{}, error) {
	execution := chatExecution(ctx)
	input := execution.input
	if input.Resume == nil {
		input.Resume = map[string]interface{}{}
	}
	if input.Resume["text"] == nil {
		reply, err := s.generateSpeechReply(ctx, dialog, messages, options)
		if err != nil {
			return nil, err
		}
		plan := reply["speech_plan"].(chatSpeechPlan)
		plan.Mode = "speech"
		reply["speech_plan"] = plan
		answer := chatTextAnswer(messageID, reply)
		if err := execution.commitText(ctx, reply, answer); err != nil {
			return nil, err
		}
		input.Resume["text"] = reply
	}
	var failures []error
	imagePlanFailed := false
	if input.Resume["image_plan"] == nil && input.Resume["image"] == nil && input.RetryStage != "audio" {
		basis := append([]map[string]interface{}(nil), messages...)
		reply := input.Resume["text"].(map[string]interface{})
		basis = append(basis, map[string]interface{}{"role": "assistant", "content": reply["answer"]})
		basis = append(basis, map[string]interface{}{"role": "user", "content": prompt})
		plan, err := s.planChatImage(ctx, dialog, basis, options)
		if errors.Is(err, errChatTaskDeferred) {
			return nil, err
		}
		if err != nil {
			failures = append(failures, err)
			imagePlanFailed = true
		} else if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "plan_saved",
			func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
				task.Outputs["image_plan"] = plan
				return entity.JSONMap{"stage": "image"}, nil
			}); err != nil {
			return nil, err
		} else {
			input.Resume["image_plan"] = plan
		}
	}
	var result map[string]interface{}
	for _, branch := range []struct{ stage, kind string }{{"image", "生图"}, {"audio", "语音"}} {
		if branch.stage == "image" && imagePlanFailed || input.Resume[branch.stage] != nil || input.RetryStage != "" && input.RetryStage != branch.stage {
			continue
		}
		current, readErr := execution.dao.Get(ctx, execution.task.ID)
		if readErr != nil {
			return result, readErr
		}
		if current.UpstreamStatus == "unknown" || current.UpstreamStatus == "running" || ctx.Err() != nil {
			failures = append(failures, errors.New("upstream_unknown: branch execution requires reconciliation"))
			break
		}
		output, err := s.completeMediaBranch(ctx, dialog, session, messages, messageID, branch.kind, prompt, options)
		if errors.Is(err, errChatTaskDeferred) {
			return result, err
		}
		if err != nil {
			failures = append(failures, err)
		} else {
			result = output
		}
		current, readErr = execution.dao.Get(ctx, execution.task.ID)
		if readErr != nil {
			return result, readErr
		}
		input.Resume = current.Outputs
		if current.UpstreamStatus == "unknown" || ctx.Err() != nil {
			break
		}
	}
	if len(failures) == 0 && (input.Resume["image"] == nil || input.Resume["audio"] == nil) {
		failures = append(failures, errors.New("stage_incomplete: combined output still has an unfinished media branch"))
	}
	return result, errors.Join(failures...)
}
