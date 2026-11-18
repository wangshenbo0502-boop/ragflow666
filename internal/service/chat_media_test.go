package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
	"ragflow/internal/utility"
)

func TestChatMediaCommands(t *testing.T) {
	for _, tt := range []struct {
		text, kind, prompt string
		matched            bool
	}{
		{"@生图 一列高铁", "生图", "一列高铁", true},
		{"@语音 撒娇说晚安", "语音", "撒娇说晚安", true},
		{" \n@qwen3-tts：你好\n欢迎", "qwen3-tts", "你好\n欢迎", true},
		{"@Qwen3-TTS", "qwen3-tts", "", true},
		{"@生图", "生图", "", true},
		{"解释 @生图 是什么", "", "", false},
		{"@Qwen3-TTS-other hello", "", "", false},
		{"普通聊天", "", "", false},
	} {
		t.Run(tt.text, func(t *testing.T) {
			kind, prompt, matched := parseChatMediaCommand(tt.text)
			if kind != tt.kind || prompt != tt.prompt || matched != tt.matched {
				t.Fatalf("got %q %q %v", kind, prompt, matched)
			}
		})
	}
}

func TestChatMediaCommandMode(t *testing.T) {
	for _, scenario := range []struct{ kind, mode, want string }{
		{"生图", "music", "image"},
		{"生图", "voice", "image"},
		{"生图", "image_voice", "image"},
		{"语音", "image", "voice"},
		{"qwen3-tts", "image_voice", "voice"},
		{"语音", "music", "music"},
	} {
		if got := chatMediaCommandMode(scenario.kind, scenario.mode); got != scenario.want {
			t.Errorf("command %q mode %q: got %q, want %q", scenario.kind, scenario.mode, got, scenario.want)
		}
	}
}

func TestChatMediaImageResponse(t *testing.T) {
	png := chatJPEG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("unexpected image request %s", r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "gpt-image-2.5-sunburst" || body["prompt"] != "高铁" || body["response_format"] != "b64_json" || body["size"] != "2048x1152" || body["quality"] != "high" {
			t.Errorf("unexpected image payload %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(png)}},
		})
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", server.URL+"/v1")
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test-key")
	t.Setenv("RAGFLOW_IMAGE_MODEL", "must-not-be-used")
	image, mediaType, err := generateChatImage(t.Context(), "高铁", "2048x1152")
	if err != nil || mediaType != "image/jpeg" || !bytes.Equal(image, png) {
		t.Fatalf("image type=%s err=%v", mediaType, err)
	}
	for _, test := range []struct{ body, cause string }{
		{`not json`, "image_response_invalid_json"},
		{`{}`, "image_response_missing_data"},
		{`{"data":[]}`, "image_response_missing_data"},
		{`{"data":[{"url":"https://127.0.0.1/image?secret=1"}]}`, "image_response_download_failed"},
		{`{"data":[{"b64_json":"!"}]}`, "image_response_invalid_base64"},
		{`{"data":[{"b64_json":"aGVsbG8="}]}`, "image_response_invalid_file"},
	} {
		_, _, err := decodeChatImage(t.Context(), []byte(test.body))
		code, message := chatTaskError(err)
		if cause := chatTaskDiagnosticCause(err); cause != test.cause || code != "invalid_image_response" || strings.Contains(message, "secret") {
			t.Fatalf("image response cause=%s code=%s message=%q, want %s", cause, code, message, test.cause)
		}
	}
}

func TestChatMediaImageURLResponse(t *testing.T) {
	image := chatJPEG(t)
	requests := make(chan string, 12)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Method + " " + r.URL.Path
		switch r.URL.Path {
		case "/v1/images/generations":
			if r.Header.Get("Authorization") != "Bearer test-key" {
				t.Error("missing authorization on generation request")
			}
			_, _ = io.WriteString(w, `{"data":[{"url":"https://8.8.8.8/redirect?sig=fixture"}]}`)
		case "/redirect", "/image", "/blocked", "/corrupt":
			if r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
				t.Error("download received credentials or a referrer")
			}
			switch r.URL.Path {
			case "/redirect":
				http.Redirect(w, r, "https://1.1.1.1/image?sig=fixture", http.StatusFound)
			case "/image":
				if r.URL.Query().Get("sig") != "fixture" {
					t.Error("download lost the signed query")
				}
				_, _ = w.Write(image)
			case "/blocked":
				http.Redirect(w, r, "https://127.0.0.1/image?sig=private", http.StatusFound)
			case "/corrupt":
				_, _ = io.WriteString(w, "not an image")
			}
		default:
			t.Errorf("unexpected request path %s", r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	// Route verified public destinations to a local fixture without overriding the URL guard.
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	t.Cleanup(transport.CloseIdleConnections)
	pinned := utility.PinnedHTTPClient
	utility.PinnedHTTPClient = func(host, ip string, timeout time.Duration) *http.Client {
		if host != ip || (ip != "8.8.8.8" && ip != "1.1.1.1") {
			t.Errorf("unexpected validated destination %q %q", host, ip)
		}
		return &http.Client{Transport: transport, Timeout: timeout}
	}
	t.Cleanup(func() { utility.PinnedHTTPClient = pinned })
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test-key")
	t.Setenv("ALLOW_ANY_HOST", "true")

	// The generation client uses the normal transport; only result downloads are pinned.
	provider := httptest.NewServer(server.Config.Handler)
	t.Cleanup(provider.Close)
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", provider.URL+"/v1")
	data, mime, err := generateChatImage(t.Context(), "train", "2048x1152")
	if err != nil || mime != "image/jpeg" || !bytes.Equal(data, image) {
		t.Fatalf("image type=%s err=%v", mime, err)
	}
	for _, tt := range []struct{ link, cause string }{
		{"https://8.8.8.8/blocked", "image_response_download_failed"},
		{"http://8.8.8.8/image", "image_response_download_failed"},
		{"https://user:secret@8.8.8.8/image", "image_response_download_failed"},
		{"https://8.8.8.8/corrupt", "image_response_invalid_file"},
	} {
		body := fmt.Appendf(nil, `{"data":[{"url":%q}]}`, tt.link)
		_, _, err = decodeChatImage(t.Context(), body)
		if code, message := chatTaskError(err); code != "invalid_image_response" || strings.Contains(message, "secret") || strings.Contains(message, "private") || chatTaskDiagnosticCause(err) != tt.cause {
			t.Fatalf("unexpected image error code=%s cause=%s message=%q", code, chatTaskDiagnosticCause(err), message)
		}
	}
	close(requests)
	var got []string
	for req := range requests {
		got = append(got, req)
	}
	want := []string{"POST /v1/images/generations", "GET /redirect", "GET /image", "GET /blocked", "GET /corrupt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

func TestChatMediaImageReferences(t *testing.T) {
	png := chatJPEG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/edits" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("unexpected image edit request %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("prompt") != "蓝底证件照" || r.FormValue("model") != "gpt-image-2.5-sunburst" || r.FormValue("size") != "1152x2048" || r.FormValue("quality") != "high" {
			t.Errorf("missing edit instructions")
		}
		parts := r.MultipartForm.File["image"]
		if len(parts) == 0 {
			parts = r.MultipartForm.File["image[]"]
		}
		if len(parts) == 0 {
			t.Error("missing reference images")
		}
		for _, part := range parts {
			reader, err := part.Open()
			if err != nil {
				t.Error(err)
				continue
			}
			data, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || !bytes.Equal(data, png) {
				t.Error("reference image changed")
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(png)}},
		})
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", server.URL+"/v1")
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test-key")
	t.Setenv("RAGFLOW_IMAGE_MODEL", "must-not-be-used")
	image := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(png)
	for _, images := range [][]string{{image}, {image, image}} {
		result, mediaType, err := generateChatImage(t.Context(), "蓝底证件照", "1152x2048", images...)
		if err != nil || mediaType != "image/jpeg" || !bytes.Equal(result, png) {
			t.Fatalf("edit result type=%s err=%v", mediaType, err)
		}
	}
	for _, invalid := range []string{"", "data:image/png;base64,!", "data:image/png;base64,aGVsbG8="} {
		if _, _, err := generateChatImage(t.Context(), "test", "2048x2048", invalid); err == nil {
			t.Fatal("accepted invalid reference image")
		}
	}

	seedChatImageStorage(t)
	ctx := permission.WithIdentity(t.Context(), "user-1", "")
	if images, err := chatImageReferences(ctx, []interface{}{chatImageFileDict}); err != nil || len(images) != 1 {
		t.Fatalf("uploaded reference not resolved: %v", err)
	}
	for _, descriptor := range []map[string]interface{}{
		{"id": "img-1", "name": "photo.jpg", "created_by": "another-user"},
		{"id": "missing", "name": "photo.jpg", "created_by": "user-1"},
		{"id": "img-1", "name": "document.txt", "created_by": "user-1"},
	} {
		if _, err := chatImageReferences(ctx, []interface{}{descriptor}); err == nil {
			t.Fatalf("accepted unreadable or non-image reference: %v", descriptor)
		}
	}
}

func TestChatImagePlannerReferencesDoNotRequireVision(t *testing.T) {
	db := setupModelProviderServiceTestDB(t)
	useModelProviderServiceTestDB(t, db)
	seedModelProviderServiceScope(t, db)
	seedChatImageStorage(t)
	ctx := serviceTestContext(t, "user-1", "user-1")
	planning := context.WithValue(ctx, chatImagePlanningKey{}, true)
	chat := &entity.Chat{TenantID: "user-1", LLMID: "model-1"}
	messages := []map[string]interface{}{{"role": "user", "content": "edit using reference 1 and 2",
		"files": []interface{}{chatImageFileDict, chatImageFileDict}}}
	pipeline := &ChatPipelineService{ModelFactory: NewModelFactory()}
	// An automatic text route must not seek a vision candidate for planning.
	routed, _, err := pipeline.prepareChatRoute(planning, chat, messages, map[string]interface{}{"route_policy": "auto"})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := pipeline.prepareChatAttachments(routed, chat, messages)
	if err != nil || len(prepared) != 1 || !strings.Contains(stringValue(prepared[0]["content"]), "2 张参考图片") {
		t.Fatalf("image references unavailable to planner: %v", err)
	}
	if len(prepared[0]["files"].([]string)) != 0 || !reflect.DeepEqual(messages[0]["files"], []interface{}{chatImageFileDict, chatImageFileDict}) {
		t.Fatal("planner received image bytes or mutated the original attachments")
	}
	if _, err := pipeline.prepareChatAttachments(ctx, chat, messages); err == nil || !strings.Contains(err.Error(), "vision_model_required") {
		t.Fatalf("ordinary text chat accepted images: %v", err)
	}
	for _, descriptor := range []map[string]interface{}{
		{"id": "missing", "name": "photo.jpg", "created_by": "user-1"},
		{"id": "img-1", "name": "photo.jpg", "created_by": "another-user"},
	} {
		if _, err := pipeline.prepareChatAttachments(planning, chat, []map[string]interface{}{
			{"role": "user", "content": "edit", "files": []interface{}{descriptor}},
		}); err == nil {
			t.Fatal("image planning bypassed attachment authorization or availability")
		}
	}
}

func TestChatMediaSpeechWAV(t *testing.T) {
	wav := chatWAV()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/speech" {
			t.Errorf("unexpected speech path %s", r.URL.Path)
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "Qwen3-TTS-12Hz-1.7B-CustomVoice" ||
			body["voice"] != "serena" || body["language"] != "zh" ||
			body["response_format"] != "wav" || body["input"] != "你好" || body["instructions"] != "台湾口音，开心" {
			t.Errorf("unexpected speech payload %#v", body)
		}
		_, _ = w.Write(wav)
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL+"/v1")
	audio, err := synthesizeLocalSpeech(t.Context(), "你好", chatSpeechPlan{Voice: "serena", Instructions: "台湾口音，开心"})
	if err != nil || !bytes.Equal(audio, wav) {
		t.Fatalf("audio len=%d err=%v", len(audio), err)
	}
}

type speechReplyPipeline struct {
	fakePipeline
	chat    *entity.Chat
	stream  bool
	options map[string]interface{}
}

func (p *speechReplyPipeline) AsyncChat(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}, stream bool, kwargs map[string]interface{}) (<-chan AsyncChatResult, error) {
	p.chat, p.stream, p.options = chat, stream, kwargs
	if ctx.Value(chatSpeechPlanningKey{}) == true {
		return makeResultChan(AsyncChatResult{Answer: `{"answer":"","mode":"speech","use_knowledge":true}`, Final: true}), nil
	}
	return p.fakePipeline.AsyncChat(ctx, chat, messages, stream, kwargs)
}

func TestChatMediaSpeechAnswersWithSelectedModel(t *testing.T) {
	for _, mode := range []struct {
		name   string
		stream bool
		legacy bool
	}{{name: "non-stream"}, {name: "stream", stream: true}, {name: "legacy-stream", stream: true, legacy: true}} {
		t.Run(mode.name, func(t *testing.T) {
			db := setupChatListTestDB(t)
			if err := db.AutoMigrate(&entity.ChatSession{}, &entity.ConversationMessage{},
				&entity.ChatTask{}, &entity.ChatTaskEvent{}, &entity.ChatTaskAttempt{}, &entity.ChatMediaAsset{},
				&entity.ChatMediaCleanup{},
				&entity.ChatMediaReference{}, &entity.ChatTaskResource{}, &entity.ChatTaskResourceLease{}, &entity.ChatTaskWorker{}); err != nil {
				t.Fatal(err)
			}
			factory := storage.GetStorageFactory()
			previousStorage := factory.GetStorage()
			factory.SetStorage(storage.NewMemoryStorage())
			t.Cleanup(func() { factory.SetStorage(previousStorage) })
			t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "user-1")

			const question = "@语音 高铁和动车有什么区别？"
			const answer = "<think>不要朗读推理过程</think>**高铁**侧重线路，动车侧重车辆。[ID:0]"
			wav := chatWAV()
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]interface{}
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["input"] != "高铁侧重线路，动车侧重车辆。" || body["voice"] != "serena" {
					t.Errorf("TTS must receive the visible answer: %#v", body)
				}
				calls++
				_, _ = w.Write(wav)
			}))
			defer server.Close()
			t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL+"/v1")
			store := newFakeSessionStore()
			store.dialogExists["user-1|chat-1"] = true
			store.dialogs["chat-1"] = &entity.Chat{
				ID: "chat-1", TenantID: "user-1", LLMID: "original-model",
				Status: strPtr("1"),
				KBIDs:  entity.JSONSlice{"kb-selected"}, PromptConfig: entity.JSONMap{"tts": true}, LLMSetting: entity.JSONMap{},
			}
			store.sessions["session-1"] = &entity.ChatSession{
				ID: "session-1", DialogID: "chat-1", UserID: strPtr("user-1"),
				Message: json.RawMessage(`[{"role":"user","content":"我正在学习铁路知识","id":"old"},{"role":"assistant","content":"好的","id":"old"}]`),
			}
			ctx := permission.WithIdentity(t.Context(), "user-1", "user-1")
			sessionDAO := dao.NewChatSessionDAO()
			if err := db.Create(store.dialogs["chat-1"]).Error; err != nil {
				t.Fatal(err)
			}
			if err := sessionDAO.Create(ctx, db, store.sessions["session-1"]); err != nil {
				t.Fatal(err)
			}
			ref := map[string]interface{}{"chunks": []interface{}{map[string]interface{}{"id": "source-1"}}}
			pipeline := &speechReplyPipeline{fakePipeline: fakePipeline{resultChan: makeResultChan(
				AsyncChatResult{Answer: answer, Reference: ref, Prompt: "selected prompt", Usage: &ChatTurnUsage{TotalTokens: 12}, Final: true},
			)}}
			svc := &ChatSessionService{
				chatSessionDAO: sessionDAO, permissionChecker: store,
				pipeline: pipeline, modelFactory: &fakeChatModelConfigResolver{},
			}
			config, err := LoadChatTaskConfig()
			if err != nil {
				t.Fatal(err)
			}
			taskDAO := dao.NewChatTaskDAO(db)
			if err := taskDAO.WorkerHeartbeat(ctx, "test-worker", config.Lease); err != nil {
				t.Fatal(err)
			}
			worker := &ChatTaskWorker{config: config, dao: taskDAO, service: svc, id: "test-worker"}
			events := make(chan string, 64)
			accepted, err := svc.ChatCompletions(ctx,
				"chat-1", "session-1", nil, question, nil, "selected-model", map[string]interface{}{"temperature": 0.4},
				map[string]interface{}{"internet": true}, mode.legacy, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			id := stringValue(accepted["task_id"])
			if err := worker.execute(ctx, id, nil); err != nil {
				t.Fatal(err)
			}
			task, err := taskDAO.Get(ctx, id)
			if err != nil || task.State != "succeeded" {
				t.Fatalf("speech task failed: task=%+v err=%v", task, err)
			}
			savedAnswer := task.Outputs["answer"].(map[string]interface{})
			result := map[string]interface{}{"answer": savedAnswer["content"], "reference": savedAnswer["reference"],
				"prompt": savedAnswer["prompt"], "usage": savedAnswer["usage"]}
			if mode.stream {
				if err := svc.observeChatTask(ctx, task, events); err != nil {
					t.Fatal(err)
				}
				close(events)
				for raw := range events {
					var event struct {
						Data interface{} `json:"data"`
					}
					if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(raw, "data:"))), &event) == nil {
						if answer, ok := event.Data.(map[string]interface{}); ok && answer["answer"] != nil {
							result = answer
						}
					}
				}
			}
			if pipeline.chat.LLMID != "selected-model" || !reflect.DeepEqual(pipeline.chat.KBIDs, entity.JSONSlice{"kb-selected"}) {
				t.Fatalf("selected model/knowledge bases lost: %+v", pipeline.chat)
			}
			if pipeline.stream || pipeline.chat.PromptConfig["tts"] != false || store.dialogs["chat-1"].PromptConfig["tts"] != true {
				t.Fatal("pipeline must synthesize only once without changing chat settings")
			}
			if len(pipeline.messages) != 3 || pipeline.messages[0]["content"] != "我正在学习铁路知识" ||
				pipeline.messages[2]["content"] != "高铁和动车有什么区别？" {
				t.Fatalf("question/context lost: %#v", pipeline.messages)
			}
			if pipeline.options["internet"] != true || pipeline.options["temperature"] != 0.4 {
				t.Fatalf("generation options lost: %#v", pipeline.options)
			}
			if calls != 1 || !strings.HasPrefix(stringValue(result["answer"]), answer) || !strings.Contains(stringValue(result["answer"]), "[语音](") {
				t.Fatalf("missing answer or audio: calls=%d result=%#v", calls, result)
			}
			if result["prompt"] != "selected prompt" || result["reference"] == nil || result["usage"] == nil {
				t.Fatalf("answer metadata lost: %#v", result)
			}
			session, err := sessionDAO.GetByID(ctx, db, "session-1")
			if err != nil {
				t.Fatal(err)
			}
			saved := parseMessages(session.Message)
			if len(saved) != 4 || saved[2]["content"] != question || saved[3]["content"] != result["answer"] {
				t.Fatalf("text/audio turn not persisted: %#v", saved)
			}
		})
	}
}

func TestChatMediaSpeechRejectsEmptyAndFailedAnswers(t *testing.T) {
	for _, answer := range []string{"", "![图片](image.png)"} {
		svc := &ChatSessionService{pipeline: &fakePipeline{resultChan: makeResultChan(AsyncChatResult{Answer: answer, Final: true})}}
		if _, err := svc.generateSpeechReply(t.Context(), &entity.Chat{}, []map[string]interface{}{{"role": "user", "content": "@Qwen3-TTS 问题"}}, nil); err == nil {
			t.Fatalf("accepted unanswerable result %q", answer)
		}
	}
	failure := &models.APIStatusError{Status: http.StatusTooManyRequests}
	svc := &ChatSessionService{pipeline: &fakePipeline{resultChan: makeResultChan(AsyncChatResult{Error: failure, Final: true})}}
	if _, err := svc.generateSpeechReply(t.Context(), &entity.Chat{}, []map[string]interface{}{{"role": "user", "content": "question"}}, nil); !errors.Is(err, failure) {
		t.Fatalf("lost typed upstream error: %v", err)
	}
	svc.pipeline = &fakePipeline{resultChan: makeResultChan(AsyncChatResult{Answer: "**ERROR** is literal text", Final: true})}
	if _, err := svc.generateSpeechReply(t.Context(), &entity.Chat{}, []map[string]interface{}{{"role": "user", "content": "question"}}, nil); err != nil {
		t.Fatalf("rejected literal text: %v", err)
	}
}

func TestChatSpeechTextOmitsNonProse(t *testing.T) {
	tests := []struct {
		name   string
		answer string
		want   string
	}{
		{
			name:   "fenced code",
			answer: "Before.\n```go\nfmt.Println(42)\n```\nAfter.",
			want:   "Before.\n\nAfter.",
		},
		{
			name:   "indented code",
			answer: "Before.\n\n    fmt.Println(42)\n\nAfter.",
			want:   "Before.\n\nAfter.",
		},
		{
			name:   "inline code",
			answer: "Call `deleteEverything()` only in examples.",
			want:   "Call  only in examples.",
		},
		{
			name:   "table",
			answer: "Before.\n\n| key | value |\n| --- | --- |\n| private | data |\n\nAfter.",
			want:   "Before.\n\nAfter.",
		},
		{
			name:   "image alt text",
			answer: "See this ![hidden description](image.png) now.",
			want:   "See this  now.",
		},
		{
			name:   "inline html",
			answer: "Before <span>hidden markup</span> after.",
			want:   "Before hidden markup after.",
		},
		{
			name:   "citation markers and link destination",
			answer: "**Hello** [world](https://private.example/path) [ID:3] [4].",
			want:   "Hello world  .",
		},
		{
			name:   "hidden thoughts and tts tags",
			answer: "<think>private reasoning</think>Visible <phoneme>word</phoneme>.",
			want:   "Visible word.",
		},
		{
			name:   "quoted prose with nested code",
			answer: "> Quoted **answer** [ID:2].\n>\n> ```text\n> private code\n> ```\n\nAfter.",
			want:   "Quoted answer .\n\n\nAfter.",
		},
		{
			name:   "reference link label",
			answer: "Read [the **guide**][guide].\n\n[guide]: https://private.example/path \"Hidden title\"",
			want:   "Read the guide.",
		},
		{
			name:   "autolink labels",
			answer: "Visit <https://example.com> or <reader@example.com>.",
			want:   "Visit https://example.com or reader@example.com.",
		},
		{
			name:   "line breaks",
			answer: "First  \nSecond\nThird.",
			want:   "First\nSecond\nThird.",
		},
		{
			name:   "markdown escapes and entities",
			answer: `Use \*literal\* &amp; &#65; &#x42;.`,
			want:   "Use *literal* & A B.",
		},
		{
			name:   "escaped entity stays literal",
			answer: `Show \&amp; and &amp;amp;.`,
			want:   "Show &amp; and &amp;.",
		},
		{
			name:   "encoded markup is visible text",
			answer: "Show &lt;span&gt;literal&lt;/span&gt;.",
			want:   "Show <span>literal</span>.",
		},
		{
			name:   "only non prose",
			answer: "```go\nprivate()\n```\n\n| secret |\n| --- |\n| data |\n\n![private](image.png)\n\n<script>\nprivate()\n</script>",
			want:   "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ChatSpeechText(tt.answer); got != tt.want {
				t.Fatalf("ChatSpeechText() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestChatMediaSpeechHistoryKeepsTextWithoutCommandsAndAudio(t *testing.T) {
	messages := []map[string]interface{}{
		{"role": "user", "content": "@Qwen3-TTS 上一个问题"},
		{"role": "assistant", "content": "上一个答案\n\n[Qwen3-TTS 语音](/api/v1/chats/ab/sessions/cd/media/ef.wav)"},
		{"role": "user", "content": "@Qwen3-TTS 继续说"},
	}
	pipeline := &fakePipeline{resultChan: makeResultChan(AsyncChatResult{Answer: "继续回答", Final: true})}
	svc := &ChatSessionService{pipeline: pipeline}
	if _, err := svc.generateSpeechReply(t.Context(), &entity.Chat{}, messages, nil); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"上一个问题", "上一个答案", "继续说"} {
		if pipeline.messages[i]["content"] != want {
			t.Fatalf("history[%d]=%v, want %q", i, pipeline.messages[i]["content"], want)
		}
	}
	if messages[0]["content"] != "@Qwen3-TTS 上一个问题" || messages[2]["content"] != "@Qwen3-TTS 继续说" {
		t.Fatal("saved questions were mutated")
	}
}

func TestChatMediaRequestRejectsRedirectAndSanitizesErrors(t *testing.T) {
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusUnauthorized, http.StatusBadGateway, 524} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "http://must-not-follow.invalid")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("private credential"))
			}))
			defer server.Close()
			_, err := requestChatMedia(t.Context(), server.URL, "test-key", nil)
			if err == nil || strings.Contains(err.Error(), "credential") || chatTaskFailureDiagnostics(err)["upstream_http_status"] != status {
				t.Fatalf("unsanitized error: %v", err)
			}
			if status == 524 || status == http.StatusBadGateway {
				if code, _ := chatTaskError(err); code != "upstream_result_unknown" {
					t.Fatalf("gateway failure not marked unknown: %s", code)
				}
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := requestChatMedia(ctx, "http://127.0.0.1:1", "", nil); err != context.Canceled {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestChatMediaRequestRetainsUnknownWhenResponseIsTruncated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(w, `{"data":[`)
	}))
	defer server.Close()
	_, err := requestChatMedia(t.Context(), server.URL, "test-key", nil)
	code, _ := chatTaskError(err)
	if code != "upstream_result_unknown" || chatTaskDiagnosticCause(err) != "upstream_response_read_failed" {
		t.Fatalf("truncated response: code=%s err=%v", code, err)
	}
}
