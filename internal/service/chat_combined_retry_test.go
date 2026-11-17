package service

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"ragflow/internal/dao"
)

func TestChatCombinedRetryKeepsUnfinishedBranchRetryable(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "image_voice")
	reply := map[string]interface{}{"answer": "saved grounded answer", "speech_plan": chatSpeechPlan{
		Answer: "saved grounded answer", Voice: chatVoiceName, Mode: "speech"}}
	if err := execution.commitText(ctx, reply, chatTextAnswer("turn", reply)); err != nil {
		t.Fatal(err)
	}
	current, err := execution.dao.Get(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	execution.input.Resume, execution.input.RetryStage = current.Outputs, "audio"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(chatWAV())
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
	session, err := execution.service.chatSessionDAO.GetByID(ctx, dao.DB, execution.task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = execution.service.completeChatImageVoice(ctx, &execution.input.Chat, session,
		execution.input.Messages, "turn", "question", nil)
	if code, _ := chatTaskError(err); code != "stage_incomplete" || errors.Is(err, errChatTaskDeferred) {
		t.Fatalf("incomplete combined output reported completion: %v (%s)", err, code)
	}
	current, err = execution.dao.Get(ctx, execution.task.ID)
	if err != nil || current.Outputs["audio"] == nil || current.Outputs["image"] != nil {
		t.Fatalf("selective retry changed the wrong branch: %v", err)
	}
	current.State = "partial_succeeded"
	if retry := chatTaskRetryOptions(current); !reflect.DeepEqual(retry.Stages, []string{"image"}) {
		t.Fatalf("unfinished image cannot be retried: %+v", retry)
	}
}
