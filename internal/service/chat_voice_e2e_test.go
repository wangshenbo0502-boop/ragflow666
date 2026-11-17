//go:build e2e

package service

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

type chatVoiceE2E struct {
	t      *testing.T
	origin string
	token  string
	client *http.Client
}

func TestChatSpeechTextRealSynthesis(t *testing.T) {
	if os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL") == "" {
		t.Skip("requires the isolated forwarder and actual speech engine")
	}
	if os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL") != "http://host.docker.internal:19980/control" ||
		os.Getenv("RAGFLOW_TTS_BASE_URL") != "http://host.docker.internal:19980/v1" {
		t.Fatal("refusing to exercise speech outside the disposable forwarder")
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	control, err := client.Post("http://host.docker.internal:19980/control", "application/json",
		strings.NewReader(`{"observe_next":1}`))
	if err != nil {
		t.Fatal("speech observation control unavailable")
	}
	var gate map[string]int
	err = json.NewDecoder(control.Body).Decode(&gate)
	control.Body.Close()
	if err != nil || control.StatusCode != http.StatusOK || gate["holding"] != 0 || gate["fail_next"] != 0 {
		t.Fatal("another test owns the speech forwarder")
	}
	text := `Show &lt;span&gt;literal&lt;/span&gt;. Use \*literal\* &amp; &#65; &#x42;. Visit <https://example.com>.`
	want := "Show <span>literal</span>. Use *literal* & A B. Visit https://example.com."
	audio, err := synthesizeLocalSpeech(t.Context(), ChatSpeechText(text), chatSpeechPlan{Voice: chatVoiceName})
	if err != nil {
		t.Fatal("real speech synthesis failed")
	}
	duration, err := validateChatWAV(audio)
	if err != nil || duration <= 0 {
		t.Fatal("speech engine did not produce valid audio")
	}
	response, err := client.Get("http://host.docker.internal:19980/observations")
	if err != nil {
		t.Fatal("speech observations unavailable")
	}
	defer response.Body.Close()
	var observations []struct {
		Input     string `json:"input"`
		Voice     string `json:"voice"`
		Status    int    `json:"upstream_status"`
		Completed bool   `json:"completed"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&observations) != nil ||
		len(observations) == 0 {
		t.Fatal("missing actual forwarded speech request")
	}
	last := observations[len(observations)-1]
	if last.Input != want || last.Voice != chatVoiceName || last.Status != http.StatusOK || !last.Completed {
		t.Fatalf("actual synthesis did not receive the expected spoken text: %+v", last)
	}
	t.Logf("actual TTS input matched decoded markup, escapes, entities and autolink; WAV bytes=%d duration_ms=%d", len(audio), duration)
}

func (e *chatVoiceE2E) request(method, path string, body any, result any) {
	e.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		e.t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(e.t.Context(), method, e.origin+"/api/v1"+path, bytes.NewReader(raw))
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Authorization", e.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := e.client.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: transport failed", method, path)
	}
	defer response.Body.Close()
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope); err != nil {
		e.t.Fatalf("%s %s: invalid envelope: %v", method, path, err)
	}
	if response.StatusCode != 200 || envelope.Code != 0 {
		e.t.Fatalf("%s %s: HTTP %d code %d: %s", method, path, response.StatusCode, envelope.Code, envelope.Message)
	}
	if result != nil {
		if err := json.Unmarshal(envelope.Data, result); err != nil {
			e.t.Fatal(err)
		}
	}
}

type chatVoiceTaskDetail struct {
	Task        entity.ChatTask          `json:"task"`
	Attempts    []entity.ChatTaskAttempt `json:"attempts"`
	RetryStages []string                 `json:"retry_stages"`
	Diagnostics chatTaskDiagnostics      `json:"diagnostics"`
}

func (e *chatVoiceE2E) waitTask(id string) chatVoiceTaskDetail {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		var detail chatVoiceTaskDetail
		e.request(http.MethodGet, "/chats/tasks/"+id, nil, &detail)
		if dao.IsChatTaskTerminal(detail.Task.State) {
			e.t.Logf("task=%s state=%s error=%s calls=%d", id, detail.Task.State, detail.Task.ErrorCode, detail.Task.Calls)
			return detail
		}
		select {
		case <-e.t.Context().Done():
			e.t.Fatal("test cancelled")
		case <-time.After(time.Second):
		}
	}
	e.t.Fatal("task did not reach a terminal state")
	return chatVoiceTaskDetail{}
}

func TestChatVoiceRealLifecycle(t *testing.T) {
	origin := os.Getenv("RAGFLOW_TEST_CHAT_API")
	if origin == "" {
		t.Skip("requires disposable API, MySQL, NATS, MinIO, indexed knowledge, real chat model and TTS forwarder")
	}
	if origin != "http://ragflow-chat-test-api:19380" {
		t.Fatal("refusing to exercise an API outside the disposable environment")
	}
	e := &chatVoiceE2E{t: t, origin: origin, token: os.Getenv("RAGFLOW_TEST_CHAT_TOKEN"), client: &http.Client{Timeout: 2 * time.Minute}}
	db, err := gorm.Open(mysql.Open(os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot open disposable database")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var schema string
	if err := db.Raw("SELECT DATABASE()").Scan(&schema).Error; err != nil || !strings.HasPrefix(schema, "ragflow_chat_test_e2e_") {
		t.Fatal("database is not isolated")
	}
	var minioConfig config.MinioConfig
	if err := json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &minioConfig); err != nil || minioConfig.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("object store is not isolated")
	}
	store, err := storage.NewMinioStorage(minioConfig)
	if err != nil {
		t.Fatal("cannot connect disposable MinIO")
	}
	proxy := os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	if proxy != "http://host.docker.internal:19980/control" {
		t.Fatal("expected dedicated observable TTS forwarder")
	}
	control := func(fail int) map[string]int {
		t.Helper()
		body, err := json.Marshal(map[string]int{"fail_next": fail})
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, proxy, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res, err := e.client.Do(req)
		if err != nil {
			t.Fatal("TTS forwarder unavailable")
		}
		defer res.Body.Close()
		var counts map[string]int
		if err := json.NewDecoder(res.Body).Decode(&counts); err != nil {
			t.Fatal(err)
		}
		return counts
	}
	baseline := control(1)
	datasetID := os.Getenv("RAGFLOW_TEST_CHAT_DATASET")
	var documents struct {
		Docs []struct {
			ChunkCount int    `json:"chunk_count"`
			Status     string `json:"ingestion_status"`
		} `json:"docs"`
	}
	e.request(http.MethodGet, "/datasets/"+datasetID+"/documents", nil, &documents)
	if len(documents.Docs) != 1 || documents.Docs[0].Status != "COMPLETED" || documents.Docs[0].ChunkCount < 1 {
		t.Fatal("real knowledge ingestion must complete before speech acceptance")
	}
	var chat struct {
		ID string `json:"id"`
	}
	e.request(http.MethodPost, "/chats", map[string]any{
		"name": "Isolated real speech lifecycle", "dataset_ids": []string{datasetID},
		"llm_id": os.Getenv("RAGFLOW_TEST_CHAT_MODEL"), "llm_setting": map[string]any{"temperature": 0, "max_tokens": 1024},
		"prompt_config": map[string]any{"system": "请根据知识库回答，保留来源引用。{knowledge}",
			"parameters": []any{map[string]any{"key": "knowledge", "optional": false}}, "quote": true},
		"similarity_threshold": 0,
	}, &chat)
	var session ChatSessionPayload
	e.request(http.MethodPost, "/chats/"+chat.ID+"/sessions", map[string]any{"name": "Voice failure and retry"}, &session)
	t.Logf("isolated dataset=%s chat=%s session=%s", datasetID, chat.ID, session.ID)
	var admission struct {
		TaskID string          `json:"task_id"`
		Task   entity.ChatTask `json:"task"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chat.ID, "session_id": session.ID, "stream": false, "mode": "voice",
		"question": "@语音 青禾项目的验收暗号和负责人分别是什么？请根据资料简短回答并标注来源。",
	}, &admission)
	if admission.TaskID == "" {
		admission.TaskID = admission.Task.ID
	}
	if admission.TaskID == "" {
		t.Fatal("durable admission did not return a task identity")
	}
	failed := e.waitTask(admission.TaskID)
	if failed.Task.State != "partial_succeeded" || failed.Task.ErrorCode != "upstream_unavailable" ||
		!reflect.DeepEqual(failed.RetryStages, []string{"audio"}) {
		t.Fatalf("TTS rejection lost partial/retry semantics: state=%s error=%s retry=%v", failed.Task.State, failed.Task.ErrorCode, failed.RetryStages)
	}
	checkDiagnostics := func(detail chatVoiceTaskDetail, retried bool) {
		t.Helper()
		diagnostics := detail.Diagnostics
		if !diagnostics.EventHistoryComplete || !diagnostics.SwitchDetailsComplete ||
			diagnostics.ObservedAt < detail.Task.FinishedAt || diagnostics.InitialQueueMs == nil ||
			diagnostics.ElapsedMs != detail.Task.FinishedAt-detail.Task.CreatedAt {
			t.Fatalf("real task diagnostics lost persisted timing or event coverage: %+v", diagnostics)
		}
		attempts, succeeded, failed := 0, 0, 0
		for _, stage := range diagnostics.Stages {
			attempts += stage.Attempts
			succeeded += stage.Succeeded
			failed += stage.Failed
			if stage.Running != 0 || stage.Unknown != 0 || stage.SettledElapsedMs < 0 {
				t.Fatal("settled real task has an unresolved diagnostic attempt")
			}
		}
		if attempts != len(detail.Attempts) || attempts != detail.Task.Calls {
			t.Fatal("diagnostic calls differ from persisted real attempts")
		}
		if diagnostics.Phases["save"] == nil || diagnostics.Phases["save"].Samples < 1 {
			t.Fatal("real text or media persistence has no measured save phase")
		}
		if retried {
			if diagnostics.FirstTextMs != nil || diagnostics.FirstAudioMs == nil ||
				succeeded != 1 || failed != 0 || len(diagnostics.Stages) != 1 ||
				diagnostics.Phases["planning"] != nil || diagnostics.Phases["retrieval"] != nil {
				t.Fatal("audio retry diagnostics counted inherited text or replayed other stages")
			}
		} else if diagnostics.FirstTextMs == nil || diagnostics.FirstAudioMs != nil || succeeded < 1 || failed != 1 {
			t.Fatal("partial task diagnostics lost saved text or the failed audio call")
		} else if diagnostics.Phases["planning"] == nil || diagnostics.Phases["retrieval"] == nil {
			t.Fatal("real knowledge voice task has no measured planning or retrieval phase")
		}
		for phase, span := range diagnostics.Phases {
			if span.ElapsedMs < 0 || span.ElapsedMs > diagnostics.ElapsedMs {
				t.Fatalf("real %s phase has an invalid inclusive duration: %+v", phase, span)
			}
			t.Logf("phase task=%s phase=%s samples=%d elapsed_ms=%d", detail.Task.ID, phase, span.Samples, span.ElapsedMs)
		}
		t.Logf("diagnostics task=%s elapsed_ms=%d calls=%d succeeded=%d failed=%d switches=%d events_complete=%t",
			detail.Task.ID, diagnostics.ElapsedMs, attempts, succeeded, failed, diagnostics.Switches, diagnostics.EventHistoryComplete)
	}
	checkDiagnostics(failed, false)
	answer, ok := failed.Task.Outputs["answer"].(map[string]any)
	if !ok {
		t.Fatal("partial task has no persisted answer")
	}
	content, _ := answer["content"].(string)
	ref, _ := answer["reference"].(map[string]any)
	chunks, _ := ref["chunks"].([]any)
	if !strings.Contains(content, "山海同行") || !strings.Contains(content, "林悦") || len(chunks) == 0 || answer["output_revision"] == nil {
		t.Fatalf("saved answer does not preserve grounded facts, citations and version: content=%q citations=%d", content, len(chunks))
	}
	sessionPath := "/chats/" + chat.ID + "/sessions/" + session.ID
	checkReload := func(media bool) map[string]any {
		t.Helper()
		var reloaded ChatSessionPayload
		e.request(http.MethodGet, sessionPath+"?include_reference=true&include_prompt=true", nil, &reloaded)
		for _, message := range reloaded.Messages {
			if message["role"] == "assistant" && message["id"] == failed.Task.TurnID {
				text, _ := message["content"].(string)
				reference, _ := message["reference"].(map[string]any)
				citations, _ := reference["chunks"].([]any)
				if !strings.HasPrefix(text, content) || len(citations) != len(chunks) || message["output_revision"] == nil {
					t.Fatal("refresh lost answer, citations or version")
				}
				if media && message["media_assets"] == nil {
					t.Fatal("refresh lost generated audio")
				}
				return message
			}
		}
		t.Fatal("refresh lost assistant message")
		return nil
	}
	checkReload(false)
	beforeRetry := control(0)
	if beforeRetry["rejected"]-baseline["rejected"] != 1 || beforeRetry["forwarded"] != baseline["forwarded"] {
		t.Fatal("failed TTS submission made unexpected upstream calls")
	}
	var retried entity.ChatTask
	e.request(http.MethodPost, "/chats/tasks/"+failed.Task.ID+"/retry", map[string]any{"stage": "audio", "revision": failed.Task.Revision}, &retried)
	succeeded := e.waitTask(retried.ID)
	if succeeded.Task.State != "succeeded" {
		t.Fatalf("real TTS retry failed: %s %s", succeeded.Task.State, succeeded.Task.ErrorCode)
	}
	checkDiagnostics(succeeded, true)
	for _, attempt := range succeeded.Attempts {
		if attempt.Stage != "audio" {
			t.Fatalf("audio retry replayed %s", attempt.Stage)
		}
	}
	reloaded := checkReload(true)
	assets, ok := reloaded["media_assets"].([]any)
	if !ok || len(assets) != 1 {
		t.Fatal("audio retry must persist exactly one media asset")
	}
	media, ok := assets[0].(map[string]any)
	if !ok {
		t.Fatal("invalid media asset descriptor")
	}
	mediaURL, ok := media["url"].(string)
	if !ok || !strings.HasPrefix(mediaURL, "/api/v1/chats/") {
		t.Fatal("audio has no authenticated media URL")
	}
	durationMS, ok := media["duration_ms"].(float64)
	if !ok || durationMS < 1 {
		t.Fatal("real audio has no validated duration")
	}
	readAudio := func() []byte {
		t.Helper()
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, origin+mediaURL, nil)
		req.Header.Set("Authorization", e.token)
		res, err := e.client.Do(req)
		if err != nil {
			t.Fatal("authenticated media read failed")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("media read status/cache: %d %s", res.StatusCode, res.Header.Get("Cache-Control"))
		}
		audio, err := io.ReadAll(io.LimitReader(res.Body, chatMediaMaxBytes+1))
		if err != nil {
			t.Fatal(err)
		}
		if duration, err := validateChatWAV(audio); err != nil || duration != int64(durationMS) {
			t.Fatalf("download does not match persisted valid audio: %v", err)
		}
		return audio
	}
	audio := readAudio()
	if !bytes.Equal(audio, readAudio()) {
		t.Fatal("repeated media download changed bytes")
	}
	browserVerified := false
	if browser := os.Getenv("RAGFLOW_TEST_CHAT_BROWSER"); browser != "" {
		if browser != "http://host.docker.internal:19981/verify" {
			t.Fatal("browser verifier is outside the disposable environment")
		}
		verifyBrowser := func(phase string) {
			t.Helper()
			body, err := json.Marshal(map[string]string{"chat_id": chat.ID, "session_id": session.ID,
				"turn_id": failed.Task.TurnID, "media_url": mediaURL, "content": content, "phase": phase})
			if err != nil {
				t.Fatal(err)
			}
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, browser, bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			response, err := e.client.Do(req)
			if err != nil {
				t.Fatal("browser verification request failed")
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				t.Fatalf("real frontend %s verification failed", phase)
			}
		}
		verifyBrowser("initial")
		func() {
			defer func() {
				if err := db.Model(&entity.Chat{}).Where("id = ?", chat.ID).Update("status", "1").Error; err != nil {
					t.Error("cannot restore isolated chat permission")
				}
			}()
			if err := db.Model(&entity.Chat{}).Where("id = ?", chat.ID).Update("status", "0").Error; err != nil {
				t.Fatal(err)
			}
			verifyBrowser("revoked")
		}()
		browserVerified = true
	}
	counts := control(0)
	if counts["forwarded"]-baseline["forwarded"] != 1 || counts["rejected"]-baseline["rejected"] != 1 {
		t.Fatal("retry did not produce exactly one real TTS request")
	}
	var original chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+failed.Task.ID, nil, &original)
	if original.Task.State != failed.Task.State || original.Task.Revision != failed.Task.Revision {
		t.Fatal("retry changed the source terminal task")
	}
	var asset entity.ChatMediaAsset
	if err := db.Take(&asset, "id = ?", media["id"]).Error; err != nil {
		t.Fatal(err)
	}
	exists, err := store.ObjectExists(t.Context(), asset.Bucket, asset.ObjectKey)
	if err != nil || !exists {
		t.Fatal("real object is absent before deletion")
	}
	e.request(http.MethodDelete, "/chats/"+chat.ID+"/sessions", map[string]any{"ids": []string{session.ID}}, nil)
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, origin+mediaURL, nil)
	req.Header.Set("Authorization", e.token)
	res, err := e.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatal("deleted session still authorizes media")
	}
	deadline := time.Now().Add(75 * time.Second)
	for time.Now().Before(deadline) {
		if err := db.Take(&asset, "id = ?", asset.ID).Error; err != nil {
			t.Fatal(err)
		}
		exists, err = store.ObjectExists(t.Context(), asset.Bucket, asset.ObjectKey)
		if err != nil {
			t.Fatal("object-store cleanup check failed")
		}
		if asset.State == "deleted" && !exists {
			t.Logf("PASS real speech partial -> refresh -> audio-only retry -> download (%d bytes) -> revoke -> physical cleanup; TTS forwarded=1 rejected=1; browser_verified=%t", len(audio), browserVerified)
			return
		}
		select {
		case <-t.Context().Done():
			t.Fatal("cleanup cancelled")
		case <-time.After(time.Second):
		}
	}
	t.Fatal("worker did not physically clean the deleted session audio")
}
