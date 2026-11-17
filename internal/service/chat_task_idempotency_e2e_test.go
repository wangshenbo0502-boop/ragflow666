//go:build e2e

package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

type chatConcurrentResponse struct {
	status int
	code   int
	data   json.RawMessage
	reason string
	err    error
}

func TestChatTaskRealReplayAdmissionIndependence(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	chatID, sessionID := e.newMediaSession("Replay with offline Worker and changed defaults")
	key := "e2e-replay-" + common.GenerateToken()
	body := map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "@语音 根据资料简短回答青禾项目的验收暗号和负责人，保留引用。",
	}
	before := e.faultControl(map[string]any{"fail_next": 1, "hold_next": 0})
	taskID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 1), true)
	partial := e.waitTask(taskID)
	if partial.Task.State != "partial_succeeded" || !reflect.DeepEqual(partial.RetryStages, []string{"audio"}) {
		t.Fatalf("original task did not preserve text and failed audio: %s/%s", partial.Task.State, partial.Task.ErrorCode)
	}
	retryPath := "/chats/tasks/" + taskID + "/retry"
	retryBody := map[string]any{"stage": "audio", "revision": partial.Task.Revision}
	retryID := requireChatConcurrentIdentity(t, e.concurrentRequests(retryPath, "", retryBody, 1), false)
	completed := e.waitTask(retryID)
	if completed.Task.State != "succeeded" {
		t.Fatalf("real audio retry failed: %s/%s", completed.Task.State, completed.Task.ErrorCode)
	}
	frozenInputs := make(map[string]string, 2)
	for _, id := range []string{taskID, retryID} {
		var saved entity.ChatTask
		if err := db.Take(&saved, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if saved.Input == "" {
			t.Fatal("admitted task has no frozen input")
		}
		frozenInputs[id] = saved.Input
	}
	var original entity.Chat
	if err := db.Take(&original, "id = ?", chatID).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Updates(map[string]any{
			"llm_id": original.LLMID, "tenant_llm_id": original.TenantLLMID, "kb_ids": original.KBIDs,
			"llm_setting": original.LLMSetting, "prompt_config": original.PromptConfig, "status": original.Status,
		}).Error; err != nil {
			t.Error("cannot restore test-owned chat")
		}
	})
	settings := chatTaskSettings(original.LLMSetting)
	settings["temperature"] = 1
	prompt := chatTaskSettings(original.PromptConfig)
	prompt["system"] = "REPLAY_MUST_USE_FROZEN_INPUT"
	if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Updates(map[string]any{
		"llm_id": "unavailable-after-admission", "tenant_llm_id": nil,
		"kb_ids": entity.JSONSlice{}, "llm_setting": settings, "prompt_config": prompt,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Let the real heartbeat expire instead of deleting Worker or capacity rows.
	e.workerFault("crash")
	t.Cleanup(func() { e.workerFault("start") })
	deadline := time.Now().Add(45 * time.Second)
	for {
		available, err := dao.NewChatTaskDAO(db).WorkerAvailable(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !available {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated Worker heartbeat did not expire")
		}
		time.Sleep(250 * time.Millisecond)
	}
	if id := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 2), true); id != taskID {
		t.Fatal("offline Worker/default changes replaced original task")
	}
	if id := requireChatConcurrentIdentity(t, e.concurrentRequests(retryPath, "", retryBody, 2), false); id != retryID {
		t.Fatal("offline Worker/default changes replaced completed stage retry")
	}
	for field, value := range map[string]any{
		"question": "@语音 只回答试运行日期。", "llm_id": "different-explicit-model", "temperature": 0.7,
	} {
		changed := make(map[string]any, len(body)+1)
		for k, v := range body {
			changed[k] = v
		}
		changed[field] = value
		result := e.concurrentRequests("/chat/completions", key, changed, 1)[0]
		if result.err != nil || result.code == 0 || result.reason != "idempotency_conflict" {
			t.Fatalf("different client %s did not conflict before new admission", field)
		}
	}
	for id, frozen := range frozenInputs {
		var saved entity.ChatTask
		if err := db.Take(&saved, "id = ?", id).Error; err != nil || saved.Input != frozen {
			t.Fatal("replay changed frozen input")
		}
	}
	if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Update("status", "0").Error; err != nil {
		t.Fatal(err)
	}
	for _, replay := range []struct {
		path string
		key  string
		body any
	}{{"/chat/completions", key, body}, {retryPath, "", retryBody}} {
		result := e.concurrentRequests(replay.path, replay.key, replay.body, 1)[0]
		if result.err != nil || result.code == 0 {
			t.Fatal("revoked chat allowed task replay")
		}
		var leaked map[string]any
		_ = json.Unmarshal(result.data, &leaked)
		if leaked["task"] != nil || leaked["task_id"] != nil || leaked["input"] != nil {
			t.Fatal("revoked replay leaked a task snapshot")
		}
	}
	var count int64
	if err := db.Model(&entity.ChatTask{}).Where("session_id = ?", sessionID).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("replay created extra tasks: rows=%d", count)
	}
	after := e.faultControl(nil)
	if after["rejected"] != before["rejected"]+1 || after["forwarded"] != before["forwarded"]+1 {
		t.Fatal("replay repeated real synthesis")
	}
	t.Logf("PASS natural Worker heartbeat expiry + changed model/KB/prompt/defaults: original/retry replay retain IDs and frozen snapshots; question/model/temperature conflicts; revoked replay rejected without data; rows=2 real TTS=1; original=%s retry=%s", taskID, retryID)
}

func (e *chatVoiceE2E) concurrentRequests(path, key string, body any, count int) []chatConcurrentResponse {
	e.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		e.t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan chatConcurrentResponse, count)
	for range count {
		go func() {
			<-start
			request, err := http.NewRequestWithContext(e.t.Context(), http.MethodPost,
				e.origin+"/api/v1"+path, bytes.NewReader(raw))
			if err != nil {
				results <- chatConcurrentResponse{err: err}
				return
			}
			request.Header.Set("Authorization", e.token)
			request.Header.Set("Content-Type", "application/json")
			if key != "" {
				request.Header.Set("Idempotency-Key", key)
			}
			response, err := e.client.Do(request)
			if err != nil {
				results <- chatConcurrentResponse{err: fmt.Errorf("request transport failed")}
				return
			}
			defer response.Body.Close()
			var envelope struct {
				Code    int             `json:"code"`
				Data    json.RawMessage `json:"data"`
				Message string          `json:"message"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope)
			reason := ""
			if strings.Contains(envelope.Message, "idempotency") {
				reason = "idempotency_conflict"
			} else if strings.HasPrefix(envelope.Message, "queue_unavailable:") {
				reason = "queue_unavailable"
			}
			results <- chatConcurrentResponse{status: response.StatusCode, code: envelope.Code, data: envelope.Data, reason: reason, err: err}
		}()
	}
	close(start)
	out := make([]chatConcurrentResponse, 0, count)
	for range count {
		out = append(out, <-results)
	}
	return out
}

func requireChatConcurrentIdentity(t *testing.T, results []chatConcurrentResponse, admission bool) string {
	t.Helper()
	id := ""
	for _, result := range results {
		if result.err != nil || result.status != 200 || result.code != 0 {
			t.Fatalf("identical concurrent request rejected: HTTP=%d code=%d reason=%s err=%v", result.status, result.code, result.reason, result.err)
		}
		var data struct {
			ID       string `json:"id"`
			TaskID   string `json:"task_id"`
			Accepted bool   `json:"accepted"`
		}
		if err := json.Unmarshal(result.data, &data); err != nil {
			t.Fatal(err)
		}
		current := data.ID
		if admission {
			current = data.TaskID
			if !data.Accepted {
				t.Fatal("durable admission lost accepted marker")
			}
		}
		if current == "" || id != "" && current != id {
			t.Fatal("identical requests created different task identities")
		}
		id = current
	}
	return id
}

func TestChatTaskRealConcurrentIdempotency(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	for _, explicitTurn := range []bool{true, false} {
		t.Run(fmt.Sprintf("explicit_turn_%t", explicitTurn), func(t *testing.T) {
			e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
			chatID, sessionID := e.newMediaSession("Real concurrent media admission")
			key := "e2e-admission-" + common.GenerateToken()
			body := map[string]any{
				"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
				"question": "@语音 请根据资料简短回答青禾项目的验收暗号和负责人，保留引用。",
			}
			if explicitTurn {
				body["messages"] = []map[string]any{{"id": common.GenerateToken(), "role": "user", "content": body["question"]}}
			}
			before := e.mediaControl("http://host.docker.internal:19980/control", 1)
			taskID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 4), true)
			partial := e.waitTask(taskID)
			if partial.Task.State != "partial_succeeded" || !reflect.DeepEqual(partial.RetryStages, []string{"audio"}) {
				t.Fatalf("expected saved text and retryable audio, got %s/%s", partial.Task.State, partial.Task.ErrorCode)
			}
			time.Sleep(1100 * time.Millisecond)
			if replay := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 2), true); replay != taskID {
				t.Fatal("terminal replay created a new task")
			}
			changed := make(map[string]any, len(body))
			for k, v := range body {
				changed[k] = v
			}
			changed["question"] = "@语音 只回答试运行日期。"
			if explicitTurn {
				messages := body["messages"].([]map[string]any)
				changed["messages"] = []map[string]any{{"id": messages[0]["id"], "role": "user", "content": changed["question"]}}
			}
			for _, result := range e.concurrentRequests("/chat/completions", key, changed, 2) {
				if result.err != nil || result.code == 0 || result.reason != "idempotency_conflict" {
					t.Fatal("same-key different input was not rejected")
				}
			}
			retryBefore := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 1})
			t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
			retryPath := "/chats/tasks/" + taskID + "/retry"
			retryBody := map[string]any{"stage": "audio", "revision": partial.Task.Revision}
			retryID := requireChatConcurrentIdentity(t, e.concurrentRequests(retryPath, "", retryBody, 4), false)
			e.waitRealAudioHeld(retryID, retryBefore)
			e.faultControl(map[string]any{"release": true})
			completed := e.waitTask(retryID)
			if completed.Task.State != "succeeded" || completed.Task.RetryOf != taskID || len(completed.Attempts) != 1 ||
				completed.Attempts[0].Stage != "audio" {
				t.Fatalf("audio retry repeated other stages: %s attempts=%d", completed.Task.State, len(completed.Attempts))
			}
			if replay := requireChatConcurrentIdentity(t, e.concurrentRequests(retryPath, "", retryBody, 2), false); replay != retryID {
				t.Fatal("completed retry replay created another task")
			}
			after := e.faultControl(nil)
			if after["rejected"] != before["rejected"]+1 || after["forwarded"] != before["forwarded"]+1 ||
				after["completed"] != retryBefore["completed"]+1 {
				t.Fatal("concurrent submission or retry repeated actual upstream synthesis")
			}
			var rows []entity.ChatTask
			if err := db.Where("session_id = ?", sessionID).Find(&rows).Error; err != nil || len(rows) != 2 {
				t.Fatalf("expected one original plus one retry task: rows=%d err=%v", len(rows), err)
			}
			var original entity.ChatTask
			if err := db.Take(&original, "id = ?", taskID).Error; err != nil ||
				original.State != partial.Task.State || original.Revision != partial.Task.Revision ||
				!reflect.DeepEqual(original.Outputs, partial.Task.Outputs) {
				t.Fatal("retries changed original terminal task")
			}
			var reloaded ChatSessionPayload
			e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &reloaded)
			users, answers := 0, 0
			for _, message := range reloaded.Messages {
				if message["id"] != partial.Task.TurnID {
					continue
				}
				if message["role"] == "user" {
					users++
				}
				if message["role"] == "assistant" {
					answers++
					reference, _ := message["reference"].(map[string]any)
					chunks, _ := reference["chunks"].([]any)
					content, _ := message["content"].(string)
					assets, _ := message["media_assets"].([]any)
					if len(chunks) == 0 || len(assets) != 1 || !strings.Contains(content, "山海同行") {
						t.Fatal("retry lost grounded text, citations or unique audio")
					}
				}
			}
			if users != 1 || answers != 1 {
				t.Fatalf("idempotent replay duplicated conversation: user=%d assistant=%d", users, answers)
			}
			t.Logf("PASS 4 concurrent admissions + terminal replays + 2 content conflicts + 4 concurrent audio retries + completed retry replays; original=%s retry=%s; actual TTS rejected=1 generated=1, rows=2", taskID, retryID)
		})
	}
}
