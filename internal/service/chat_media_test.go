package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
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

func TestChatMediaImageResponse(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
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
	if err != nil || mediaType != "image/png" || !bytes.Equal(image, png) {
		t.Fatalf("image type=%s err=%v", mediaType, err)
	}
	for _, body := range []string{
		`{}`, `{"data":[]}`, `{"data":[{"url":"http://untrusted/image"}]}`,
		`{"data":[{"b64_json":"!"}]}`, `{"data":[{"b64_json":"aGVsbG8="}]}`,
	} {
		if _, _, err := decodeChatImage([]byte(body)); err == nil {
			t.Fatalf("accepted invalid image: %s", body)
		}
	}
}

func TestChatMediaImageReferences(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
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
	image := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	for _, images := range [][]string{{image}, {image, image}} {
		result, mediaType, err := generateChatImage(t.Context(), "蓝底证件照", "1152x2048", images...)
		if err != nil || mediaType != "image/png" || !bytes.Equal(result, png) {
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

func TestChatMediaSpeechWAV(t *testing.T) {
	wav := make([]byte, 44)
	copy(wav, "RIFF")
	copy(wav[8:], "WAVE")
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
			setupChatListTestDB(t)
			factory := storage.GetStorageFactory()
			previousStorage := factory.GetStorage()
			factory.SetStorage(storage.NewMemoryStorage())
			t.Cleanup(func() { factory.SetStorage(previousStorage) })
			t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "user-1")

			const question = "@语音 高铁和动车有什么区别？"
			const answer = "<think>不要朗读推理过程</think>**高铁**侧重线路，动车侧重车辆。[ID:0]"
			wav := make([]byte, 44)
			copy(wav, "RIFF")
			copy(wav[8:], "WAVE")
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
				KBIDs: entity.JSONSlice{"kb-selected"}, PromptConfig: entity.JSONMap{"tts": true},
			}
			store.sessions["session-1"] = &entity.ChatSession{
				ID: "session-1", DialogID: "chat-1", UserID: strPtr("user-1"),
				Message: json.RawMessage(`[{"role":"user","content":"我正在学习铁路知识","id":"old"},{"role":"assistant","content":"好的","id":"old"}]`),
			}
			ref := map[string]interface{}{"chunks": []interface{}{map[string]interface{}{"id": "source-1"}}}
			pipeline := &speechReplyPipeline{fakePipeline: fakePipeline{resultChan: makeResultChan(
				AsyncChatResult{Answer: answer, Reference: ref, Prompt: "selected prompt", Usage: &ChatTurnUsage{TotalTokens: 12}, Final: true},
			)}}
			svc := &ChatSessionService{
				chatSessionDAO: store, permissionChecker: store,
				pipeline: pipeline, modelFactory: &fakeChatModelConfigResolver{},
			}
			events := make(chan string, 4)
			result, err := svc.ChatCompletions(permission.WithIdentity(t.Context(), "user-1", "user-1"),
				"chat-1", "session-1", nil, question, nil, "selected-model", map[string]interface{}{"temperature": 0.4},
				map[string]interface{}{"internet": true}, mode.legacy, mode.stream, events)
			if err != nil {
				t.Fatal(err)
			}
			if mode.stream {
				var event struct {
					Data map[string]interface{} `json:"data"`
				}
				if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(<-events, "data:"))), &event); err != nil {
					t.Fatal(err)
				}
				result = event.Data
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
			saved := parseMessages(store.sessions["session-1"].Message)
			if len(saved) != 4 || saved[2]["content"] != question || saved[3]["content"] != result["answer"] {
				t.Fatalf("text/audio turn not persisted: %#v", saved)
			}
		})
	}
}

func TestChatMediaSpeechRejectsEmptyAndFailedAnswers(t *testing.T) {
	for _, answer := range []string{"", "![图片](image.png)", "**ERROR**: model unavailable"} {
		svc := &ChatSessionService{pipeline: &fakePipeline{resultChan: makeResultChan(AsyncChatResult{Answer: answer, Final: true})}}
		if _, err := svc.generateSpeechReply(t.Context(), &entity.Chat{}, []map[string]interface{}{{"role": "user", "content": "@Qwen3-TTS 问题"}}, nil); err == nil {
			t.Fatalf("accepted unanswerable result %q", answer)
		}
	}
}

func TestChatMediaSpeechTextKeepsCodeAnswers(t *testing.T) {
	for _, answer := range []string{"```go\nfmt.Println(42)\n```", "    fmt.Println(42)\n"} {
		if got := speechReplyText(answer); got != "fmt.Println(42)" {
			t.Fatalf("code answer lost: %q", got)
		}
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
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusUnauthorized, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "http://must-not-follow.invalid")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("private credential"))
			}))
			defer server.Close()
			_, err := requestChatMedia(t.Context(), server.URL, "test-key", nil)
			if err == nil || strings.Contains(err.Error(), "credential") {
				t.Fatalf("unsanitized error: %v", err)
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := requestChatMedia(ctx, "http://127.0.0.1:1", "", nil); err != context.Canceled {
		t.Fatalf("cancellation lost: %v", err)
	}
}
