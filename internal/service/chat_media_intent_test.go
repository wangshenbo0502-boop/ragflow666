package service

import (
	"context"
	"encoding/json"
	"testing"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

func TestParseChatMediaIntent(t *testing.T) {
	for answer, want := range map[string]string{
		`{"mode":"chat"}`:        "chat",
		`{"mode":"image"}`:       "image",
		`{"mode":"voice"}`:       "voice",
		`{"mode":"music"}`:       "music",
		`{"mode":"image_voice"}`: "image_voice",
		`{"mode":"tool"}`:        "chat",
		`not JSON`:               "chat",
	} {
		if got := parseChatMediaIntent(answer); got != want {
			t.Errorf("parseChatMediaIntent(%q) = %q, want %q", answer, got, want)
		}
	}
}

func TestBuildChatMediaIntentInputKeepsLatestUserText(t *testing.T) {
	messages := []map[string]interface{}{
		{"role": "system", "content": "not part of the transcript"},
		{"role": "assistant", "content": "Previous image"},
		{"role": "user", "content": "Do not make another image; explain it in text."},
	}
	var turns []chatMediaIntentTurn
	if err := json.Unmarshal([]byte(buildChatMediaIntentInput(messages)), &turns); err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 || turns[1].Role != "user" || turns[1].Text != messages[2]["content"] {
		t.Fatalf("incorrect transcript: %+v", turns)
	}
}

func TestResolveChatMediaIntentPrioritizesSelectedAsset(t *testing.T) {
	if got := resolveChatMediaIntent(context.Background(), nil, nil, true, "selected-asset"); got != "image" {
		t.Fatalf("selected asset resolved to %q", got)
	}
	if got := resolveChatMediaIntent(context.Background(), nil, nil, false, ""); got != "chat" {
		t.Fatalf("disabled media resolved to %q", got)
	}
}

func TestChatTaskAutoReplayWithoutClassifier(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	session, err := execution.service.chatSessionDAO.GetByID(ctx, dao.DB, execution.task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	options := map[string]interface{}{"mode": "auto", "idempotency_key": "auto-media-replay"}
	request, err := newChatTaskRequest(&execution.input.Chat, session, execution.input.Messages[0], "turn", "auto", "question", "", options)
	if err != nil {
		t.Fatal(err)
	}
	if err := dao.DB.Model(&entity.ChatTask{}).Where("id = ?", execution.task.ID).
		Updates(map[string]interface{}{"input_hash": request.Hash, "idempotency_key": request.Key}).Error; err != nil {
		t.Fatal(err)
	}
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "")
	replay, err := execution.service.ChatCompletions(ctx, execution.task.ChatID, session.ID, nil, "question", nil,
		"", nil, options, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	task, ok := replay["task"].(*entity.ChatTask)
	if !ok || task.ID != execution.task.ID {
		t.Fatalf("expected original task, got %+v", replay)
	}
}
