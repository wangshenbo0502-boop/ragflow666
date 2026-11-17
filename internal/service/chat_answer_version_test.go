package service

import (
	"errors"
	"testing"

	"ragflow/internal/dao"
)

func TestChatTaskAnswerVersionRejectsLateTextAndStages(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	answer := map[string]interface{}{"id": "turn", "role": "assistant", "content": "same text"}
	if err := execution.commitText(ctx, map[string]interface{}{"answer": "same text"}, answer); err != nil {
		t.Fatal(err)
	}
	version := *execution.input.ExpectedAnswerVersion
	updated := map[string]interface{}{"id": "turn", "role": "assistant", "content": "same text",
		"reference": map[string]interface{}{"chunks": []string{"new citation"}}}
	if err := execution.service.chatSessionDAO.UpdateByID(ctx, dao.DB, execution.task.SessionID, map[string]interface{}{
		"history_update": dao.ConversationHistoryUpdate{QuestionID: "turn", Message: updated, ExpectedVersion: &version},
	}); err != nil {
		t.Fatal(err)
	}
	if err := execution.commitText(ctx, nil, answer); !errors.Is(err, dao.ErrAnswerVersion) {
		t.Fatalf("late checkpoint overwrote same-content citation change: %v", err)
	}
	if _, _, err := execution.Begin(ctx, "audio", "tts"); !errors.Is(err, dao.ErrAnswerVersion) {
		t.Fatalf("stale task started another stage: %v", err)
	}
	current, err := execution.dao.Get(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	persisted, _ := current.Outputs["answer"].(map[string]interface{})
	savedVersion, err := chatAnswerVersion(persisted)
	if err != nil || *savedVersion != version {
		t.Fatal("failed commit advanced persisted task checkpoint")
	}
	current.State, current.UpstreamStatus = "partial_succeeded", "stopped"
	current.Outputs["text"] = map[string]interface{}{"speech_plan": chatSpeechPlan{Answer: "same text", Voice: chatVoiceName}}
	if err := dao.DB.Save(current).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := execution.service.RetryChatTask(ctx, current.ID, "audio", current.Revision); !errors.Is(err, dao.ErrAnswerVersion) {
		t.Fatalf("stale retry was admitted: %v", err)
	}
	detail, err := execution.service.GetChatTask(ctx, current.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail["can_retry"] != false || detail["retry_disabled_reason"] != "revision_conflict" ||
		detail["retry_stage_reasons"].(map[string]string)["audio"] != "revision_conflict" {
		t.Fatal("task detail advertised a retry against an obsolete answer version")
	}
}
