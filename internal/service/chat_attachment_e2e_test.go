//go:build e2e

package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"ragflow/internal/common"
	"ragflow/internal/entity"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

type chatUploadFile struct {
	name string
	data []byte
}

func (e *chatVoiceE2E) uploadFiles(files ...chatUploadFile) []map[string]any {
	e.t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, file := range files {
		part, err := writer.CreateFormFile("file", file.name)
		if err != nil {
			e.t.Fatal(err)
		}
		if _, err := part.Write(file.data); err != nil {
			e.t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		e.t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(e.t.Context(), http.MethodPost,
		e.origin+"/api/v1/documents/upload", &body)
	if err != nil {
		e.t.Fatal(err)
	}
	request.Header.Set("Authorization", e.token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := e.client.Do(request)
	if err != nil {
		e.t.Fatal("real attachment upload transport failed")
	}
	defer response.Body.Close()
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope); err != nil ||
		response.StatusCode != 200 || envelope.Code != 0 {
		e.t.Fatalf("real attachment upload failed: HTTP=%d code=%d", response.StatusCode, envelope.Code)
	}
	var descriptors []map[string]any
	if len(files) == 1 {
		var descriptor map[string]any
		if err := json.Unmarshal(envelope.Data, &descriptor); err != nil {
			e.t.Fatal(err)
		}
		descriptors = []map[string]any{descriptor}
	} else if err := json.Unmarshal(envelope.Data, &descriptors); err != nil {
		e.t.Fatal(err)
	}
	if len(descriptors) != len(files) {
		e.t.Fatal("upload omitted a descriptor")
	}
	for i, descriptor := range descriptors {
		if descriptor["name"] != files[i].name || stringValue(descriptor["id"]) == "" ||
			stringValue(descriptor["created_by"]) == "" || descriptor["size"] != float64(len(files[i].data)) {
			e.t.Fatal("upload changed descriptor order or identity")
		}
	}
	return descriptors
}

func TestChatAttachmentsRealLifecycle(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	var cfg config.MinioConfig
	if err := json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &cfg); err != nil ||
		cfg.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("requires disposable object storage")
	}
	store, err := storage.NewMinioStorage(cfg)
	if err != nil {
		t.Fatal("cannot open disposable object storage")
	}
	first, second := "FIRST_"+common.GenerateToken(), "SECOND_"+common.GenerateToken()
	files := []chatUploadFile{
		{name: "first-evidence.txt", data: []byte("The acceptance code in the first uploaded file is " + first + ".")},
		{name: "second-evidence.txt", data: []byte("The acceptance code in the second uploaded file is " + second + ".")},
	}
	descriptors := e.uploadFiles(files...)
	chatID, sessionID := e.newMediaSession("Real ordered text attachments")
	before := e.faultControl(map[string]any{"fail_next": 1, "hold_next": 0})
	body := map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "Read both uploaded files. First output their exact acceptance codes in upload order, without changing any character. Then state the Qinghe project's acceptance phrase and owner from the knowledge base with citations.",
		"files":    descriptors,
	}
	taskID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", body, 1), true)
	partial := e.waitTask(taskID)
	if partial.Task.State != "partial_succeeded" || partial.Task.ErrorCode != "upstream_unavailable" ||
		!reflect.DeepEqual(partial.RetryStages, []string{"audio"}) {
		t.Fatalf("attachment answer was not saved before audio failure: %s/%s", partial.Task.State, partial.Task.ErrorCode)
	}
	answer, ok := partial.Task.Outputs["answer"].(map[string]any)
	if !ok {
		t.Fatal("attachments produced no persisted text")
	}
	content := stringValue(answer["content"])
	if strings.Index(content, first) < 0 || strings.Index(content, second) <= strings.Index(content, first) {
		t.Fatal("real model did not read both attachments in upload order")
	}
	ref, _ := answer["reference"].(map[string]any)
	chunks, _ := ref["chunks"].([]any)
	if len(chunks) == 0 {
		t.Fatal("attachment answer lost knowledge citations")
	}
	var saved entity.ChatTask
	if err := db.Take(&saved, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	var frozen chatTaskInput
	if err := json.Unmarshal([]byte(saved.Input), &frozen); err != nil {
		t.Fatal(err)
	}
	actual, _ := json.Marshal(frozen.Messages[len(frozen.Messages)-1]["files"])
	expected, _ := json.Marshal(descriptors)
	if !bytes.Equal(actual, expected) {
		t.Fatal("durable task changed attachment order or descriptors")
	}
	var session ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &session)
	userFound, answerFound := false, false
	for _, message := range session.Messages {
		if message["id"] != partial.Task.TurnID {
			continue
		}
		if message["role"] == "user" {
			userFound = true
			actual, _ := json.Marshal(message["files"])
			if !bytes.Equal(actual, expected) {
				t.Fatal("refresh changed attachment descriptors or order")
			}
		} else if message["role"] == "assistant" {
			answerFound = true
			if message["content"] != content || !reflect.DeepEqual(message["reference"], answer["reference"]) {
				t.Fatal("refresh lost attachment answer or citations")
			}
		}
	}
	if !userFound || !answerFound {
		t.Fatal("refresh omitted the attachment question or answer")
	}
	for i, descriptor := range descriptors {
		var asset entity.ChatMediaAsset
		if err := db.Take(&asset, "bucket = ? AND object_key = ?",
			stringValue(descriptor["created_by"])+"-downloads", descriptor["id"]).Error; err != nil {
			t.Fatal("uploaded input was not registered")
		}
		var ref entity.ChatMediaReference
		if err := db.Take(&ref, "asset_id = ? AND owner_kind = ? AND owner_id = ?",
			asset.ID, "message", sessionID+":"+partial.Task.TurnID).Error; err != nil || ref.Position != i {
			t.Fatal("persisted attachment reference has the wrong position")
		}
	}
	t.Run("missing_object", func(t *testing.T) {
		e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
		bucket, key := stringValue(descriptors[1]["created_by"])+"-downloads", stringValue(descriptors[1]["id"])
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 15*time.Second)
			defer cancel()
			if err := store.Put(ctx, bucket, key, files[1].data); err != nil {
				t.Error("cannot restore test-owned attachment")
			}
		})
		if err := store.Remove(t.Context(), bucket, key); err != nil {
			t.Fatal(err)
		}
		chatID, sessionID := e.newMediaSession("Real missing attachment")
		body := map[string]any{"chat_id": chatID, "session_id": sessionID, "mode": "voice",
			"stream": false, "question": "Read both uploaded files and answer their acceptance codes.", "files": descriptors}
		id := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", body, 1), true)
		failed := e.waitTask(id)
		if failed.Task.State != "failed" || failed.Task.ErrorCode != "attachment_unavailable" ||
			failed.Task.Calls != 0 || len(failed.Attempts) != 0 || failed.Task.Outputs["answer"] != nil {
			t.Fatalf("missing input silently continued: %s/%s calls=%d", failed.Task.State, failed.Task.ErrorCode, failed.Task.Calls)
		}
	})
	t.Run("forged_owner", func(t *testing.T) {
		e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
		forged := make(map[string]any, len(descriptors[0]))
		for key, value := range descriptors[0] {
			forged[key] = value
		}
		forged["created_by"] = common.GenerateToken()
		chatID, sessionID := e.newMediaSession("Real forbidden attachment")
		body := map[string]any{"chat_id": chatID, "session_id": sessionID, "mode": "voice",
			"stream": false, "question": "Read this file.", "files": []map[string]any{forged}}
		result := e.concurrentRequests("/chat/completions", "", body, 1)[0]
		if result.err != nil || result.code == 0 {
			t.Fatal("forged attachment owner was accepted")
		}
		var count int64
		if err := db.Model(&entity.ChatTask{}).Where("session_id = ?", sessionID).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("forged owner created a durable task")
		}
	})
	after := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if after["forwarded"] != before["forwarded"] || after["rejected"] != before["rejected"]+1 {
		t.Fatal("invalid attachments or failed media triggered extra synthesis")
	}
	t.Log("PASS real multipart upload + two random file codes read in order + citations + durable/refresh/reference order; missing object fails before model calls; forged owner denied before admission")
}

func TestChatAttachmentHistoryRealLifecycle(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	first, second := "FOLLOWUP_FIRST_"+common.GenerateToken(), "FOLLOWUP_SECOND_"+common.GenerateToken()
	descriptors := e.uploadFiles(
		chatUploadFile{name: "history-first.txt", data: []byte("Label: first evidence. Followup-only acceptance code: " + first + ".")},
		chatUploadFile{name: "history-second.txt", data: []byte("Label: second evidence. Followup-only acceptance code: " + second + ".")},
	)
	chatID, sessionID := e.newMediaSession("Real historical attachment followup")
	before := e.faultControl(map[string]any{"fail_next": 2, "hold_next": 0})
	t.Cleanup(func() { e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0}) })
	initialID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "Read both uploaded files but output only their labels, not their acceptance codes. " +
			"Then answer the Qinghe project's acceptance phrase and owner using the knowledge base with citations. " +
			"Do not reproduce any followup-only acceptance code.",
		"files": descriptors,
	}, 1), true)
	initial := e.waitTask(initialID)
	initialAnswer, _ := initial.Task.Outputs["answer"].(map[string]any)
	initialContent := stringValue(initialAnswer["content"])
	if initial.Task.State != "partial_succeeded" || initial.Task.ErrorCode != "upstream_unavailable" ||
		initialContent == "" || strings.Contains(initialContent, first) || strings.Contains(initialContent, second) {
		t.Fatal("initial answer must be saved without revealing the followup-only codes")
	}
	followupID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "Now reread the two files uploaded in my previous turn. Output their exact followup-only acceptance codes " +
			"in original upload order without changing any character. Also state the Qinghe project's acceptance phrase " +
			"and owner from the knowledge base with citations. No files are attached to this turn.",
	}, 1), true)
	followup := e.waitTask(followupID)
	answer, _ := followup.Task.Outputs["answer"].(map[string]any)
	content := stringValue(answer["content"])
	if followup.Task.State != "partial_succeeded" || followup.Task.ErrorCode != "upstream_unavailable" ||
		!reflect.DeepEqual(followup.RetryStages, []string{"audio"}) ||
		strings.Index(content, first) < 0 || strings.Index(content, second) <= strings.Index(content, first) {
		t.Fatalf("historical files were not read in order: %s/%s", followup.Task.State, followup.Task.ErrorCode)
	}
	reference, _ := answer["reference"].(map[string]any)
	chunks, _ := reference["chunks"].([]any)
	if len(chunks) == 0 {
		t.Fatal("historical attachment followup lost knowledge citations")
	}
	var saved entity.ChatTask
	if err := db.Take(&saved, "id = ?", followupID).Error; err != nil {
		t.Fatal(err)
	}
	var frozen chatTaskInput
	if err := json.Unmarshal([]byte(saved.Input), &frozen); err != nil {
		t.Fatal(err)
	}
	expected, _ := json.Marshal(descriptors)
	found := false
	for _, message := range frozen.Messages {
		if message["role"] != "user" || message["files"] == nil {
			continue
		}
		actual, _ := json.Marshal(message["files"])
		if bytes.Equal(actual, expected) {
			found = true
		}
	}
	if !found || len(frozen.Messages) < 3 || frozen.Messages[len(frozen.Messages)-1]["files"] != nil {
		t.Fatal("followup snapshot omitted historical descriptors or added new attachments")
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
	found = false
	for _, message := range refreshed.Messages {
		if message["role"] == "assistant" && message["id"] == followup.Task.TurnID {
			found = message["content"] == content && reflect.DeepEqual(message["reference"], answer["reference"])
		}
	}
	if !found {
		t.Fatal("refresh lost the historical attachment answer or citations")
	}
	after := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if after["forwarded"] != before["forwarded"] || after["rejected"] != before["rejected"]+2 {
		t.Fatal("followup triggered unexpected audio synthesis")
	}
	t.Log("PASS second turn with no new files reread two historical random codes absent from the first answer; frozen descriptors, citations and refresh retained")
}

func TestChatAttachmentContextLimitRealLifecycle(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	chatID, sessionID := e.newMediaSession("Real required attachment context overflow")
	var chat entity.Chat
	if err := db.Take(&chat, "id = ?", chatID).Error; err != nil || chat.TenantLLMID == nil {
		t.Fatal("cannot resolve disposable chat model")
	}
	modelID, _ := cloneChatSnapshotModel(t, db, &chat)
	var model entity.TenantModel
	if err := db.Take(&model, "id = ?", modelID).Error; err != nil {
		t.Fatal(err)
	}
	extra := map[string]any{}
	if strings.TrimSpace(model.Extra) != "" {
		if err := json.Unmarshal([]byte(model.Extra), &extra); err != nil {
			t.Fatal(err)
		}
	}
	extra["max_tokens"] = 2048
	raw, err := json.Marshal(extra)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.TenantModel{}).Where("id = ?", modelID).Update("extra", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).
		Updates(map[string]any{"kb_ids": "[]", "prompt_config": "{}"}).Error; err != nil {
		t.Fatal(err)
	}
	descriptors := e.uploadFiles(chatUploadFile{
		name: "required-context.txt",
		data: []byte(strings.Repeat("alpha beta gamma delta epsilon zeta eta theta\n", 4096)),
	})
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	id := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "Read the entire current attachment and summarize all of its contents.", "files": descriptors,
	}, 1), true)
	failed := e.waitTask(id)
	if failed.Task.State != "failed" || failed.Task.ErrorCode != "context_budget_exceeded" ||
		failed.Task.Calls != 0 || len(failed.Attempts) != 0 || failed.Task.Outputs["answer"] != nil ||
		len(failed.RetryStages) != 0 {
		t.Fatalf("required context overflow was not stopped before model calls: %s/%s calls=%d attempts=%d",
			failed.Task.State, failed.Task.ErrorCode, failed.Task.Calls, len(failed.Attempts))
	}
	after := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if after["forwarded"] != before["forwarded"] || after["rejected"] != before["rejected"] {
		t.Fatal("required context overflow reached audio synthesis")
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID, nil, &refreshed)
	for _, message := range refreshed.Messages {
		if message["role"] == "assistant" && message["id"] == failed.Task.TurnID && stringValue(message["content"]) != "" {
			t.Fatal("overflow persisted an answer based on truncated current evidence")
		}
	}
	t.Log("PASS real current attachment over a test-owned 2048-token model context fails explicitly with zero model calls, attempts or audio requests")
}
