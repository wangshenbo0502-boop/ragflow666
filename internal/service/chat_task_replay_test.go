package service

import (
	"errors"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
)

func TestChatTaskReplayIgnoresNewAdmissionConfiguration(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	previousLogger := common.Logger
	core, observed := observer.New(zap.InfoLevel)
	common.Logger = zap.New(core)
	t.Cleanup(func() { common.Logger = previousLogger })
	options := map[string]interface{}{"mode": "voice", "idempotency_key": "stable-client-key", "temperature": 0.25}
	session, err := execution.service.chatSessionDAO.GetByID(ctx, dao.DB, execution.task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	request, err := newChatTaskRequest(&execution.input.Chat, session, execution.input.Messages[0], "turn", "语音", "question", "", options)
	if err != nil {
		t.Fatal(err)
	}
	if err := dao.DB.Model(&entity.ChatTask{}).Where("id = ?", execution.task.ID).
		Updates(map[string]interface{}{"input_hash": request.Hash, "idempotency_key": request.Key}).Error; err != nil {
		t.Fatal(err)
	}
	// No worker heartbeat exists. Even invalid new-admission settings and a
	// removed default must not change a previously accepted receipt.
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "")
	t.Setenv("RAGFLOW_CHAT_ROUTE_CONFIG", "invalid")
	if err := dao.DB.Model(&entity.Chat{}).Where("id = ?", execution.task.ChatID).
		Updates(map[string]interface{}{"llm_id": "", "prompt_config": `{"system":"changed"}`}).Error; err != nil {
		t.Fatal(err)
	}
	replay, err := execution.service.ChatCompletions(ctx, execution.task.ChatID, session.ID, nil, "question", nil,
		"", map[string]interface{}{"temperature": 0.25}, map[string]interface{}{"mode": "voice", "idempotency_key": request.Key}, false, false, nil)
	if err != nil {
		t.Fatalf("replay depended on current defaults/worker: %v", err)
	}
	task := replay["task"].(*entity.ChatTask)
	if task.ID != execution.task.ID || task.Input != execution.task.Input || replay["accepted"] != true {
		t.Fatal("replay did not return original frozen receipt")
	}
	replayLogs := observed.FilterMessage("chat task replayed").All()
	if len(replayLogs) != 1 || replayLogs[0].ContextMap()["task_id"] != task.ID ||
		replayLogs[0].ContextMap()["turn_id"] != task.TurnID ||
		replayLogs[0].ContextMap()["session_id"] != task.SessionID {
		t.Fatal("authorized replay did not emit one correlated log")
	}
	for _, changed := range []struct {
		question string
		model    string
		temp     float64
	}{{"different question", "", 0.25}, {"question", "explicit-model", 0.25}, {"question", "", 0.75}} {
		_, err := execution.service.ChatCompletions(ctx, execution.task.ChatID, session.ID, nil, changed.question, nil,
			changed.model, map[string]interface{}{"temperature": changed.temp}, map[string]interface{}{"mode": "voice", "idempotency_key": request.Key}, false, false, nil)
		if !errors.Is(err, dao.ErrChatTaskConflict) {
			t.Fatalf("different client input was not a conflict: %v", err)
		}
	}
	var count int64
	if err := dao.DB.Model(&entity.ChatTask{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("replay created another task")
	}
	execution.service.permissionChecker = permission.NewDatabaseChecker(dao.DB)
	result := dao.DB.Model(&entity.Chat{}).Where("id = ?", execution.task.ChatID).Update("status", "0")
	if result.Error != nil || result.RowsAffected != 1 {
		t.Fatalf("cannot revoke test-owned chat: rows=%d err=%v", result.RowsAffected, result.Error)
	}
	if _, err := execution.service.ChatCompletions(ctx, execution.task.ChatID, session.ID, nil, "question", nil,
		"", map[string]interface{}{"temperature": 0.25}, options, false, false, nil); err == nil {
		t.Fatal("revoked chat received original receipt")
	}
	if observed.FilterMessage("chat task replayed").Len() != 1 {
		t.Fatal("conflicting or revoked requests were counted as successful replays")
	}
}

func TestChatTaskRetryReplayIgnoresNewAdmissionConfiguration(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	answer := map[string]interface{}{"id": "turn", "role": "assistant", "content": "saved answer"}
	if err := execution.commitText(ctx, map[string]interface{}{
		"answer": "saved answer", "speech_plan": chatSpeechPlan{Answer: "saved answer", Voice: chatVoiceName},
	}, answer); err != nil {
		t.Fatal(err)
	}
	original, err := execution.dao.Get(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	original.State, original.UpstreamStatus = "partial_succeeded", "stopped"
	if err := dao.DB.Save(original).Error; err != nil {
		t.Fatal(err)
	}
	retry, err := execution.service.RetryChatTask(ctx, original.ID, "audio", original.Revision)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("RAGFLOW_CHAT_ROUTE_CONFIG", "invalid")
	replay, err := execution.service.RetryChatTask(ctx, original.ID, "audio", original.Revision)
	if err != nil || replay.ID != retry.ID || replay.Input != retry.Input {
		t.Fatalf("retry replay depended on new admission configuration: %v", err)
	}
}
