//go:build e2e

package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

func TestChatMusicRealWorkerLifecycle(t *testing.T) {
	e := chatMediaE2E(t)
	control := os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	before := e.mediaControl(control, 1)
	var chat struct {
		ID string `json:"id"`
	}
	e.request(http.MethodPost, "/chats", map[string]any{
		"name":          "Isolated real Worker singing",
		"llm_id":        os.Getenv("RAGFLOW_TEST_CHAT_MODEL"),
		"llm_setting":   map[string]any{"temperature": 0, "max_tokens": 1024},
		"prompt_config": map[string]any{"system": "请按用户要求创作完整歌词。"},
	}, &chat)
	var session ChatSessionPayload
	e.request(http.MethodPost, "/chats/"+chat.ID+"/sessions", map[string]any{"name": "Song reference failure and retry"}, &session)
	var admission struct {
		TaskID string          `json:"task_id"`
		Task   entity.ChatTask `json:"task"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chat.ID, "session_id": session.ID, "mode": "music", "stream": false,
		"question": "请创作并唱一首10秒的普通话女声钢琴小歌，四行歌词，主题是晚风与明日，曲风温柔。必须生成歌曲，duration设为10。",
	}, &admission)
	if admission.TaskID == "" {
		admission.TaskID = admission.Task.ID
	}
	if admission.TaskID == "" {
		t.Fatal("singing task was not durably admitted")
	}
	partial := e.waitTask(admission.TaskID)
	if partial.Task.State != "partial_succeeded" || partial.Task.ErrorCode != "upstream_unavailable" ||
		!reflect.DeepEqual(partial.RetryStages, []string{"audio"}) || partial.Task.SchedulingClass != "" {
		// SchedulingClass is deliberately absent from the public task JSON.
		t.Fatalf("reference failure lost singing retry contract: %s %s %v",
			partial.Task.State, partial.Task.ErrorCode, partial.RetryStages)
	}
	text, _ := partial.Task.Outputs["text"].(map[string]any)
	rawPlan, err := json.Marshal(text["speech_plan"])
	if err != nil {
		t.Fatal(err)
	}
	var plan chatSpeechPlan
	if json.Unmarshal(rawPlan, &plan) != nil || plan.Mode != "singing" || plan.Voice != chatVoiceName ||
		plan.Answer == "" || plan.MusicCaption == "" || plan.Duration != 10 {
		t.Fatalf("real planner did not preserve the requested singing contract: mode=%s voice=%s duration=%d",
			plan.Mode, plan.Voice, plan.Duration)
	}
	reload := func(wantAudio bool) map[string]any {
		t.Helper()
		var loaded ChatSessionPayload
		e.request(http.MethodGet, "/chats/"+chat.ID+"/sessions/"+session.ID+"?include_reference=true", nil, &loaded)
		for _, message := range loaded.Messages {
			if message["role"] != "assistant" || message["id"] != partial.Task.TurnID {
				continue
			}
			if !strings.HasPrefix(stringValue(message["content"]), plan.Answer) || message["output_revision"] == nil {
				t.Fatal("refresh lost saved lyrics or version")
			}
			assets, _ := message["media_assets"].([]any)
			if !wantAudio && len(assets) != 0 {
				t.Fatal("reference failure published an audio result")
			}
			if wantAudio {
				if len(assets) != 1 {
					t.Fatal("singing did not persist exactly one public audio result")
				}
				return assets[0].(map[string]any)
			}
			return nil
		}
		t.Fatal("refresh lost song message")
		return nil
	}
	reload(false)
	afterFailure := e.mediaControl(control, 0)
	if afterFailure["rejected"]-before["rejected"] != 1 || afterFailure["forwarded"] != before["forwarded"] {
		t.Fatal("failed voice reference unexpectedly called the real TTS")
	}
	var retry entity.ChatTask
	e.request(http.MethodPost, "/chats/tasks/"+partial.Task.ID+"/retry",
		map[string]any{"stage": "audio", "revision": partial.Task.Revision}, &retry)
	done := e.waitTask(retry.ID)
	if done.Task.State != "succeeded" || done.Task.Outputs["voice_reference"] == nil || done.Task.Calls != 2 ||
		len(done.Attempts) != 2 || done.Attempts[0].Stage != "audio" || done.Attempts[1].Stage != "music" ||
		done.Attempts[0].State != "succeeded" || done.Attempts[1].State != "succeeded" ||
		done.Attempts[1].UpstreamID == "" {
		t.Fatalf("Worker singing did not reuse lyrics and finish reference/music: state=%s error=%s calls=%d attempts=%d",
			done.Task.State, done.Task.ErrorCode, done.Task.Calls, len(done.Attempts))
	}
	asset := reload(true)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, e.origin+stringValue(asset["url"]), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", e.token)
	response, err := e.client.Do(req)
	if err != nil {
		t.Fatal("real song download failed")
	}
	audio, readErr := io.ReadAll(io.LimitReader(response.Body, chatMediaMaxBytes+1))
	response.Body.Close()
	duration, wavErr := validateChatWAV(audio)
	if readErr != nil || response.StatusCode != 200 || wavErr != nil || duration < 9000 || duration > 12000 ||
		asset["duration_ms"] != float64(duration) {
		t.Fatalf("real song WAV or saved duration invalid: duration=%d wav_error=%v", duration, wavErr)
	}
	counts := e.mediaControl(control, 0)
	if counts["forwarded"]-before["forwarded"] != 1 || counts["rejected"]-before["rejected"] != 1 {
		t.Fatal("Worker repeated the successful voice reference")
	}
	var original chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+partial.Task.ID, nil, &original)
	if original.Task.State != partial.Task.State || original.Task.Revision != partial.Task.Revision {
		t.Fatal("singing retry changed the original terminal task")
	}
	t.Logf("PASS API -> real Worker: saved lyrics -> reference 503 -> refresh -> audio-only retry -> TTS=1/music=1 -> valid %dms WAV (%d bytes); original=%s retry=%s",
		duration, len(audio), partial.Task.ID, done.Task.ID)
}

func TestChatMusicReferenceRealWait(t *testing.T) {
	e := chatMediaE2E(t)
	db, err := gorm.Open(mysql.Open(os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot open disposable MySQL")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var schema string
	if err := db.Raw("SELECT DATABASE()").Scan(&schema).Error; err != nil || !strings.HasPrefix(schema, "ragflow_chat_test_e2e_") {
		t.Fatal("refusing database outside disposable environment")
	}
	var minioConfig config.MinioConfig
	if json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &minioConfig) != nil || minioConfig.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("requires disposable MinIO")
	}
	store, err := storage.NewMinioStorage(minioConfig)
	if err != nil {
		t.Fatal("cannot connect disposable MinIO")
	}
	oldDB := dao.DB
	dao.DB = db
	defer func() { dao.DB = oldDB }()
	factory := storage.GetStorageFactory()
	previousStore := factory.GetStorage()
	factory.SetStorage(store)
	defer factory.SetStorage(previousStore)
	chatID, sessionID := e.newMediaSession("Isolated real music resource wait")
	var chat entity.Chat
	if err := db.Take(&chat, "id = ?", chatID).Error; err != nil {
		t.Fatal(err)
	}
	ctx := permission.WithIdentity(t.Context(), chat.UserID, chat.TenantID)
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", chat.TenantID)
	cfg, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Device = "chat-reliability-device"
	d := dao.NewChatTaskDAO(db)
	input := &chatTaskInput{Chat: chat, Kind: "语音", Options: map[string]interface{}{"mode": "music"}}
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	submit := func(owner string) *entity.ChatTask {
		t.Helper()
		id := common.GenerateToken()
		now := time.Now()
		task, _, err := d.Submit(ctx, &entity.ChatTask{ID: id, TenantID: chat.TenantID, UserID: chat.UserID,
			ChatID: chatID, SessionID: sessionID, TurnID: id, Kind: "语音", Input: string(raw),
			IdempotencyKey: id, InputHash: strings.Repeat("a", 64), MaxCalls: 12, MaxStageCalls: 4, MaxSwitches: 2,
			QueueDeadline: now.Add(time.Minute).UnixMilli(), Deadline: now.Add(15 * time.Minute).UnixMilli()}, 10, 100, nil)
		if err != nil {
			t.Fatal(err)
		}
		task, err = d.Claim(ctx, task.ID, owner, 12*time.Minute)
		if err != nil || task == nil {
			t.Fatalf("test executor could not claim task: %v", err)
		}
		return task
	}
	task := submit("music-verify")
	execution := &chatTaskExecution{service: NewChatSessionService(), dao: d, task: task,
		config: cfg, owner: "music-verify", input: input}
	ctx = context.WithValue(ctx, chatTaskExecutionKey{}, execution)
	ctx = common.WithModelCallObserver(ctx, execution)
	control := os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	before := e.mediaControl(control, 0)
	reference, err := musicVoiceReference(ctx)
	if err != nil {
		t.Fatal(err)
	}
	current, err := d.Get(ctx, task.ID)
	if err != nil || current.Outputs["voice_reference"] == nil {
		t.Fatal("real reference did not create a durable checkpoint")
	}
	referenceID := current.Outputs["voice_reference"]
	blocker := submit("device-blocker")
	attempt, err := d.ReserveCall(ctx, blocker.ID, "device-blocker", blocker.LeaseEpoch,
		dao.ChatTaskCall{Stage: "music", Model: "resource-wait-verification", Resources: []string{cfg.Device}})
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			_ = d.SettleCall(context.WithoutCancel(ctx), blocker.ID, "device-blocker", blocker.LeaseEpoch,
				attempt.ID, "succeeded", "stopped", 0, nil, "")
		}
	}()
	plan := chatSpeechPlan{Answer: "[Verse]\n晚风轻轻来，星光落窗台。\n愿你笑颜常在，明日春暖花开。",
		Voice: chatVoiceName, Mode: "singing", MusicCaption: "soft gentle Mandarin female solo pop, light piano, warm and clear", Duration: 10}
	for i := 0; i < 3; i++ {
		execution.deferred.Store(false)
		if _, err := synthesizeLocalMusic(ctx, plan); !errors.Is(err, errChatTaskDeferred) {
			t.Fatalf("real device wait %d: %v", i, err)
		}
		current, err = d.Get(ctx, task.ID)
		if err != nil || current.Calls != 1 || current.Outputs["voice_reference"] != referenceID || !dao.CanResumeChatTask(current) {
			t.Fatalf("wait repeated TTS or lost checkpoint: calls=%d err=%v", current.Calls, err)
		}
		loaded, err := musicVoiceReference(ctx)
		if err != nil || !bytes.Equal(loaded, reference) {
			t.Fatal("saved real reference changed while waiting")
		}
	}
	counts := e.mediaControl(control, 0)
	if counts["forwarded"]-before["forwarded"] != 1 || counts["rejected"] != before["rejected"] {
		t.Fatal("resource wait repeated a real TTS request")
	}
	if err := d.SettleCall(ctx, blocker.ID, "device-blocker", blocker.LeaseEpoch,
		attempt.ID, "succeeded", "stopped", 0, nil, ""); err != nil {
		t.Fatal(err)
	}
	released = true
	execution.deferred.Store(false)
	audio, err := synthesizeLocalMusic(ctx, plan)
	if err != nil {
		t.Fatal(err)
	}
	duration, err := validateChatWAV(audio)
	if err != nil || duration < 9000 || duration > 12000 {
		t.Fatalf("real song has invalid duration=%d err=%v", duration, err)
	}
	counts = e.mediaControl(control, 0)
	current, err = d.Get(ctx, task.ID)
	if err != nil || current.Calls != 2 || current.Outputs["voice_reference"] != referenceID ||
		counts["forwarded"]-before["forwarded"] != 1 {
		t.Fatal("real music completion regenerated TTS or changed checkpoint/budget")
	}
	for _, finished := range []struct {
		task  *entity.ChatTask
		owner string
	}{{task, "music-verify"}, {blocker, "device-blocker"}} {
		if err := d.Mutate(ctx, finished.task.ID, finished.owner, finished.task.LeaseEpoch, "task_terminal",
			func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
				task.State = "succeeded"
				return entity.JSONMap{"state": task.State}, nil
			}); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("PASS real MySQL/MinIO/TTS/music: waits=3, real TTS requests=1, calls=2, reference=%v, song duration=%dms bytes=%d; service-level recovery (not full Worker singing E2E)",
		referenceID, duration, len(audio))
}
