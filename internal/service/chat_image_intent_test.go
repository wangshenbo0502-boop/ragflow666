package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
)

type imagePlanPipeline struct {
	answers    []string
	calls      int
	chat       *entity.Chat
	messages   []map[string]interface{}
	options    map[string]interface{}
	directives []string
}

func (p *imagePlanPipeline) AsyncChat(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}, stream bool, kwargs map[string]interface{}) (<-chan AsyncChatResult, error) {
	p.chat, p.messages, p.options = applyChatMediaDirective(ctx, chat), messages, kwargs
	p.directives = append(p.directives, stringValue(p.chat.PromptConfig["system"]))
	answer := p.answers[min(p.calls, len(p.answers)-1)]
	p.calls++
	return makeResultChan(AsyncChatResult{Answer: answer, Final: true}), nil
}

func TestChatImagePlanRetriesInvalidOutput(t *testing.T) {
	for _, invalid := range []string{"", `{"prompt":"unfinished`, `{"prompt":"draw","size":"4096x4096"}`, `{"prompt":""}`} {
		t.Run(invalid, func(t *testing.T) {
			pipeline := &imagePlanPipeline{answers: []string{invalid, `{"prompt":"exactly two people, no text","size":"2048x1152"}`}}
			service := &ChatSessionService{pipeline: pipeline}
			chat := &entity.Chat{
				LLMID: "selected", LLMSetting: entity.JSONMap{"max_tokens": 64, "temperature": 0.9},
				PromptConfig: entity.JSONMap{"system": "Only answer railway questions", "tts": true},
			}
			options := map[string]interface{}{"max_tokens": 32, "temperature": 0.8}
			plan, err := service.planChatImage(t.Context(), chat, []map[string]interface{}{
				{"role": "user", "content": "@生图 恰好两个人，不要文字"},
			}, options)
			if err != nil || pipeline.calls != 2 || plan.Size != "2048x1152" {
				t.Fatalf("retry failed: calls=%d plan=%+v err=%v", pipeline.calls, plan, err)
			}
			if !strings.Contains(pipeline.directives[1], "上一次创作计划未通过校验") ||
				strings.Contains(pipeline.directives[0], "Only answer railway questions") {
				t.Fatal("planning must use a dedicated directive with retry feedback")
			}
			if pipeline.chat.LLMID != "selected" || pipeline.chat.PromptConfig["tts"] != false ||
				pipeline.chat.LLMSetting["max_tokens"] != 8192 || pipeline.options["max_tokens"] != 8192 ||
				pipeline.options["temperature"] != 0.2 {
				t.Fatalf("planning model or budget lost: %+v %+v", pipeline.chat, pipeline.options)
			}
			if chat.LLMSetting["max_tokens"] != 64 || options["max_tokens"] != 32 ||
				chat.PromptConfig["system"] != "Only answer railway questions" || chat.PromptConfig["tts"] != true {
				t.Fatal("planning mutated caller settings")
			}
		})
	}
	pipeline := &imagePlanPipeline{answers: []string{`{"prompt":""}`}}
	service := &ChatSessionService{pipeline: pipeline}
	if _, err := service.planChatImage(t.Context(), &entity.Chat{}, []map[string]interface{}{{"role": "user", "content": "draw"}}, nil); err == nil || pipeline.calls != 2 {
		t.Fatal("invalid output must stop after one retry")
	}
}

func TestChatImagePlanRestoresCreativeHistory(t *testing.T) {
	for _, edit := range []bool{false, true} {
		pipeline := &imagePlanPipeline{answers: []string{`{"prompt":"change only the background","use_previous_image":` + map[bool]string{false: "false", true: "true"}[edit] + `}`}}
		service := &ChatSessionService{pipeline: pipeline}
		history := []map[string]interface{}{
			{"role": "user", "content": "@生图 横版，左边红衣人，右边蓝衣人"},
			{"role": "assistant", "content": "![生成的图片](/api/v1/chats/ab/sessions/cd/media/ef.png)",
				"media_assets": []interface{}{map[string]interface{}{"id": "ef", "kind": "image"}},
				"image_plan":   map[string]interface{}{"prompt": "left red, right blue, exactly two people", "size": "2048x1152", "use_previous_image": false}},
			{"role": "user", "content": "@生图 背景改成绿色"},
		}
		plan, err := service.planChatImage(t.Context(), &entity.Chat{}, history, nil)
		if err != nil {
			t.Fatal(err)
		}
		wantSize := "2048x2048"
		if edit {
			wantSize = "2048x1152"
		}
		if plan.Size != wantSize || !strings.Contains(stringValue(pipeline.messages[1]["content"]), "left red, right blue") {
			t.Fatalf("history or size lost: %+v %+v", plan, pipeline.messages)
		}
		if strings.Contains(stringValue(history[1]["content"]), "创作记录") || history[2]["content"] != "@生图 背景改成绿色" {
			t.Fatal("planner mutated saved history")
		}
	}
}

func TestChatImageSelectedModelOriginalRequestAndSavedEdit(t *testing.T) {
	db := setupChatListTestDB(t)
	if err := db.AutoMigrate(&entity.ChatSession{}, &entity.ConversationMessage{},
		&entity.ChatTask{}, &entity.ChatTaskEvent{}, &entity.ChatTaskAttempt{}, &entity.ChatMediaAsset{},
		&entity.ChatMediaReference{}, &entity.ChatTaskResource{}, &entity.ChatTaskResourceLease{}, &entity.ChatTaskWorker{}); err != nil {
		t.Fatal(err)
	}
	seedChatImageStorage(t)
	store := storage.GetStorageFactory().GetStorage()
	var fixture bytes.Buffer
	if err := jpeg.Encode(&fixture, image.NewRGBA(image.Rect(0, 0, 2048, 1152)), nil); err != nil {
		t.Fatal(err)
	}
	png := fixture.Bytes()
	attachment := append([]byte(nil), png...)
	if err := store.Put(t.Context(), "user-1-downloads", "img-1", attachment); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "user-1")
	const original = "横版，恰好两个人，观看者左边红衣、右边蓝衣。标题只有“Hi, 你好！”，不要帽子。"
	const edit = "上一张只把背景改绿，再参考附件的色调，人物位置和标题不变。"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			var body map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if r.URL.Path != "/images/generations" || !strings.Contains(stringValue(body["prompt"]), original) {
				t.Error("renderer lost the original constraints omitted by the planner")
			}
		} else {
			if r.URL.Path != "/images/edits" {
				t.Error("follow-up must edit the previous image")
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if !strings.Contains(r.FormValue("prompt"), edit) || r.FormValue("size") != "2048x1152" {
				t.Error("edit lost the original request or previous dimensions")
			}
			parts := r.MultipartForm.File["image[]"]
			if len(parts) != 2 {
				t.Errorf("expected previous image and attachment, got %d", len(parts))
				return
			}
			for i, part := range parts {
				reader, err := part.Open()
				if err != nil {
					t.Error(err)
					continue
				}
				data, err := io.ReadAll(reader)
				reader.Close()
				if err != nil || !bytes.Equal(data, [][]byte{png, attachment}[i]) {
					t.Error("reference order must be previous image, then new attachment")
				}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(png)}},
		})
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", server.URL)
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test-key")
	chat := &entity.Chat{
		ID: "ab", TenantID: "user-1", LLMID: "original-model", Status: strPtr(string(entity.StatusValid)),
		LLMSetting: entity.JSONMap{}, PromptConfig: entity.JSONMap{}, KBIDs: entity.JSONSlice{},
	}
	if err := db.Create(chat).Error; err != nil {
		t.Fatal(err)
	}
	sessionDAO := dao.NewChatSessionDAO()
	session := &entity.ChatSession{ID: "cd", DialogID: chat.ID, UserID: strPtr("user-1"), Message: json.RawMessage(`[]`)}
	ctx := permission.WithIdentity(t.Context(), "user-1", "user-1")
	if err := sessionDAO.Create(ctx, db, session); err != nil {
		t.Fatal(err)
	}
	access := newFakeSessionStore()
	access.dialogExists["user-1|ab"] = true
	access.sessions["cd"] = session
	pipeline := &imagePlanPipeline{answers: []string{
		`{"prompt":"two people","size":"2048x1152"}`,
		`{"prompt":"only change background to green","use_previous_image":true}`,
	}}
	service := &ChatSessionService{
		chatSessionDAO: sessionDAO, permissionChecker: access, pipeline: pipeline,
		modelFactory: &fakeChatModelConfigResolver{},
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	taskDAO := dao.NewChatTaskDAO(db)
	if err := taskDAO.WorkerHeartbeat(ctx, "test-worker", config.Lease); err != nil {
		t.Fatal(err)
	}
	worker := &ChatTaskWorker{config: config, dao: taskDAO, service: service, id: "test-worker"}
	for i, question := range []string{original, edit} {
		var files []interface{}
		if i == 1 {
			files = []interface{}{chatImageFileDict}
		}
		result, err := service.ChatCompletions(ctx, "ab", "cd", nil, "@生图 "+question, files,
			"selected-model", map[string]interface{}{"max_tokens": 64}, nil, false, false, nil)
		if err != nil || result["accepted"] != true {
			t.Fatalf("image turn failed: result=%+v err=%v", result, err)
		}
		id := stringValue(result["task_id"])
		if err := worker.execute(ctx, id, nil); err != nil {
			t.Fatal(err)
		}
		task, err := taskDAO.Get(ctx, id)
		if err != nil || task.State != "succeeded" {
			t.Fatalf("worker did not commit image: task=%+v err=%v", task, err)
		}
		if pipeline.chat.LLMID != "selected-model" {
			t.Fatal("selected chat model was ignored for image planning")
		}
		saved, err := sessionDAO.GetByID(ctx, db, "cd")
		if err != nil {
			t.Fatal(err)
		}
		messages := parseMessages(saved.Message)
		plan, ok := readChatImagePlan(messages[len(messages)-1]["image_plan"])
		if !ok || plan.Size != "2048x1152" {
			t.Fatal("creative plan did not survive database persistence and reload")
		}
	}
	if calls != 2 || !strings.Contains(stringValue(pipeline.messages[1]["content"]), "two people") {
		t.Fatal("follow-up did not receive the saved creative plan")
	}
}
