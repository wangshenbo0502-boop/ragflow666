package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
	"ragflow/internal/storage"
)

func setupChatExecutionTest(t *testing.T, kind string) (context.Context, *chatTaskExecution) {
	t.Helper()
	db := setupChatListTestDB(t)
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.AutoMigrate(&entity.ChatSession{}, &entity.ConversationMessage{}, &entity.ConversationReference{},
		&entity.ChatTask{}, &entity.ChatTaskEvent{}, &entity.ChatTaskAttempt{}, &entity.ChatMediaAsset{},
		&entity.ChatMediaCleanup{}, &entity.ChatMediaReference{}, &entity.ChatTaskResource{},
		&entity.ChatTaskResourceLease{}, &entity.ChatTaskWorker{}); err != nil {
		t.Fatal(err)
	}
	factory := storage.GetStorageFactory()
	previous := factory.GetStorage()
	factory.SetStorage(storage.NewMemoryStorage())
	t.Cleanup(func() { factory.SetStorage(previous) })
	ctx := permission.WithIdentity(t.Context(), "user-1", "user-1")
	sessionDAO := dao.NewChatSessionDAO()
	dialog := &entity.Chat{ID: "chat-1", TenantID: "user-1", Status: strPtr("1"), PromptConfig: entity.JSONMap{},
		LLMSetting: entity.JSONMap{}, KBIDs: entity.JSONSlice{}}
	if err := db.Create(dialog).Error; err != nil {
		t.Fatal(err)
	}
	session := &entity.ChatSession{ID: "session-1", DialogID: dialog.ID, UserID: strPtr("user-1"), Message: json.RawMessage(`[]`)}
	if err := sessionDAO.Create(ctx, db, session); err != nil {
		t.Fatal(err)
	}
	checker := newFakeSessionStore()
	checker.dialogExists["user-1|chat-1"] = true
	checker.dialogs[dialog.ID], checker.sessions[session.ID] = dialog, session
	config, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	input := &chatTaskInput{Chat: *dialog, Kind: kind, Prompt: "question",
		Messages: []map[string]interface{}{{"id": "turn", "role": "user", "content": "question"}}, Options: map[string]interface{}{},
		Resume: map[string]interface{}{}, ExpectedAnswerAbsent: true}
	raw, _ := json.Marshal(input)
	now := time.Now().UnixMilli()
	taskDAO := dao.NewChatTaskDAO(db)
	task, _, err := taskDAO.Submit(ctx, &entity.ChatTask{ID: "task", TenantID: "user-1", UserID: "user-1",
		SessionID: session.ID, ChatID: dialog.ID, TurnID: "turn", Kind: kind, Input: string(raw), InputHash: fmt.Sprintf("%x", sha256.Sum256(raw)),
		IdempotencyKey: "test", MaxCalls: 12, MaxStageCalls: 4, MaxSwitches: 2,
		QueueDeadline: now + 60000, Deadline: now + 120000}, 10, 100, func(tx *gorm.DB) error {
		return sessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
			"history_update": dao.ConversationHistoryUpdate{Message: input.Messages[0]},
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err = taskDAO.Claim(ctx, task.ID, "worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	execution := &chatTaskExecution{service: &ChatSessionService{chatSessionDAO: sessionDAO, permissionChecker: checker},
		dao: taskDAO, task: task, config: config, owner: "worker", input: input}
	ctx = context.WithValue(ctx, chatTaskExecutionKey{}, execution)
	ctx = common.WithModelCallObserver(ctx, execution)
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "user-1")
	return ctx, execution
}

func TestChatMediaConnectionFailureResourceSettlement(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		upstream string
		attempt  string
		leases   int64
	}{
		{"connection_refused", "stopped", "failed", 0},
		{"response_lost", "unknown", "unknown", 3},
		{"partial_response", "unknown", "unknown", 3},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, execution := setupChatExecutionTest(t, "语音")
			var received atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := io.Copy(io.Discard, r.Body); err != nil {
					t.Errorf("read request: %v", err)
					return
				}
				received.Add(1)
				if scenario.name == "partial_response" {
					w.Header().Set("Content-Length", "100")
					_, _ = w.Write([]byte("RIFF"))
					return
				}
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Errorf("hijack response: %v", err)
					return
				}
				_ = conn.Close()
			}))
			defer server.Close()
			if scenario.name == "connection_refused" {
				server.Close()
			}
			t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
			_, callErr := synthesizeLocalSpeech(ctx, "hello", chatSpeechPlan{Voice: "serena"})
			if callErr == nil || strings.Contains(callErr.Error(), server.URL) {
				t.Fatalf("expected sanitized request failure, got %v", callErr)
			}
			current, err := execution.dao.Get(ctx, execution.task.ID)
			if err != nil {
				t.Fatal(err)
			}
			var attempt entity.ChatTaskAttempt
			if err := dao.DB.Take(&attempt, "task_id = ?", current.ID).Error; err != nil {
				t.Fatal(err)
			}
			var leases int64
			if err := dao.DB.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", current.ID).Count(&leases).Error; err != nil {
				t.Fatal(err)
			}
			if current.Calls != 1 || current.UpstreamStatus != scenario.upstream ||
				attempt.State != scenario.attempt || leases != scenario.leases {
				t.Fatalf("calls=%d upstream=%s attempt=%s leases=%d", current.Calls, current.UpstreamStatus, attempt.State, leases)
			}
			if (received.Load() == 0) != (scenario.name == "connection_refused") {
				t.Fatalf("unexpected upstream request count: %d", received.Load())
			}
		})
	}
}

func TestChatGatewayFailureResourceSettlement(t *testing.T) {
	for _, driver := range []string{"media", "language"} {
		for _, status := range []int{408, 429, 502, 503, 504, 520, 524} {
			t.Run(fmt.Sprintf("%s_%d", driver, status), func(t *testing.T) {
				ctx, execution := setupChatExecutionTest(t, "语音")
				var received atomic.Int32
				if driver == "media" {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						received.Add(1)
						w.WriteHeader(status)
						_, _ = w.Write([]byte("private-provider-response"))
					}))
					defer server.Close()
					t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
					_, err := synthesizeLocalSpeech(ctx, "hello", chatSpeechPlan{Voice: "serena"})
					if err == nil || strings.Contains(err.Error(), "private-provider-response") {
						t.Fatalf("expected sanitized HTTP error, got %v", err)
					}
					if received.Load() != 1 {
						t.Fatalf("requests=%d, want one", received.Load())
					}
				} else {
					_, settle, err := execution.Begin(ctx, "language", "test-model")
					if err != nil {
						t.Fatal(err)
					}
					settle(fmt.Errorf("driver: %w", &models.APIStatusError{Status: status}))
				}
				current, err := execution.dao.Get(ctx, execution.task.ID)
				if err != nil {
					t.Fatal(err)
				}
				var attempt entity.ChatTaskAttempt
				if err := dao.DB.Take(&attempt, "task_id = ?", current.ID).Error; err != nil {
					t.Fatal(err)
				}
				var leases int64
				if err := dao.DB.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", current.ID).Count(&leases).Error; err != nil {
					t.Fatal(err)
				}
				if status == 429 || status == 503 {
					if current.UpstreamStatus != "stopped" || attempt.State != "failed" || leases != 0 {
						t.Fatalf("rejection: upstream=%s attempt=%s leases=%d", current.UpstreamStatus, attempt.State, leases)
					}
					return
				}
				wantLeases := int64(3)
				if driver == "language" {
					wantLeases = 2
				}
				if current.Calls != 1 || current.UpstreamStatus != "unknown" || attempt.State != "unknown" ||
					attempt.ErrorCode != "upstream_result_unknown" || leases != wantLeases {
					t.Fatalf("calls=%d upstream=%s attempt=%s code=%s leases=%d", current.Calls, current.UpstreamStatus, attempt.State, attempt.ErrorCode, leases)
				}
				options := chatTaskRetryOptions(current)
				if len(options.Stages) != 0 || options.Reason != "upstream_result_unknown" {
					t.Fatalf("uncertain call allowed retry: %+v", options)
				}
				if _, _, err := execution.Begin(ctx, "audio", "test-model"); err == nil {
					t.Fatal("uncertain call allowed another reservation")
				}
			})
		}
	}
}

func TestChatTaskCommunityIdentity(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	execution.service.permissionChecker = permission.NewDatabaseChecker(dao.DB)
	ctx = permission.WithIdentity(ctx, "user-1", "")
	if err := execution.dao.WorkerHeartbeat(ctx, "worker", time.Minute); err != nil {
		t.Fatal(err)
	}
	capabilities, err := execution.service.ChatCapabilities(ctx)
	if err != nil || capabilities == nil {
		t.Fatalf("community credentials cannot query capabilities: %v", err)
	}
	result, err := execution.service.GetChatTask(ctx, execution.task.ID)
	if err != nil || result["task"].(*entity.ChatTask).ID != execution.task.ID {
		t.Fatalf("community credentials cannot read own task: %v", err)
	}
	list, err := execution.service.ListChatTasks(ctx, "", "", "", 1, 20)
	if err != nil || len(list["tasks"].([]entity.ChatTask)) != 1 {
		t.Fatalf("community credentials cannot list own tasks: %v", err)
	}
	for _, identity := range [][2]string{{"other", ""}, {"user-1", "other-tenant"}} {
		if _, err := execution.service.GetChatTask(permission.WithIdentity(ctx, identity[0], identity[1]), execution.task.ID); err == nil {
			t.Fatalf("foreign identity could read task: %v", identity)
		}
	}
}

func TestChatTaskListFiltersBeforePagination(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	execution.service.permissionChecker = permission.NewDatabaseChecker(dao.DB)
	db := dao.DB
	for _, id := range []string{"deleted-chat", "disabled-chat", "foreign-chat"} {
		chat := execution.input.Chat
		chat.ID = id
		if id == "foreign-chat" {
			chat.TenantID = "another-owner"
		}
		if id == "disabled-chat" {
			chat.Status = strPtr("0")
		}
		if err := db.Create(&chat).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range []entity.ChatSession{
		{ID: "deleted-session", DialogID: "chat-1"},
		{ID: "deleted-chat-session", DialogID: "deleted-chat"},
		{ID: "disabled-session", DialogID: "disabled-chat"},
		{ID: "foreign-session", DialogID: "foreign-chat"},
	} {
		if err := db.Create(&session).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&entity.Chat{}, "id = ?", "deleted-chat").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&entity.ChatSession{}, "id = ?", "deleted-session").Error; err != nil {
		t.Fatal(err)
	}
	hiddenSessions := []string{"deleted-session", "deleted-chat-session", "disabled-session", "foreign-session", "session-1"}
	hiddenChats := []string{"chat-1", "deleted-chat", "disabled-chat", "foreign-chat", "foreign-chat"}
	for i := 0; i < 17; i++ {
		task := *execution.task
		task.ID, task.IdempotencyKey = fmt.Sprintf("listed-%02d", i), fmt.Sprintf("listed-%02d", i)
		task.CreatedAt = execution.task.CreatedAt + int64(i+1)
		task.State, task.Kind = "succeeded", "语音"
		if i >= 12 {
			task.SessionID, task.ChatID = hiddenSessions[i-12], hiddenChats[i-12]
		}
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	assertPage := func(page int, wantIDs []string, session, state, kind string, wantTotal int64) {
		t.Helper()
		result, err := execution.service.ListChatTasks(ctx, session, state, kind, page, 10)
		if err != nil {
			t.Fatal(err)
		}
		tasks := result["tasks"].([]entity.ChatTask)
		if result["total"] != wantTotal || len(tasks) != len(wantIDs) {
			t.Fatalf("page %d: total=%v rows=%d want total=%d rows=%d", page, result["total"], len(tasks), wantTotal, len(wantIDs))
		}
		for i, id := range wantIDs {
			if tasks[i].ID != id {
				t.Fatalf("page %d row %d = %s, want %s", page, i, tasks[i].ID, id)
			}
		}
	}
	assertPage(1, []string{"listed-11", "listed-10", "listed-09", "listed-08", "listed-07", "listed-06", "listed-05", "listed-04", "listed-03", "listed-02"}, "", "", "", 13)
	assertPage(2, []string{"listed-01", "listed-00", "task"}, "", "", "", 13)
	assertPage(2, []string{"listed-01", "listed-00"}, "session-1", "succeeded", "语音", 12)
	assertPage(1, nil, "deleted-session", "", "", 0)
	assertPage(1, nil, "", "succeeded", "image_voice", 0)
	if err := db.Model(&entity.UserTenant{}).Where("user_id = ?", "user-1").Update("status", "0").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := execution.service.ListChatTasks(ctx, "", "", "", 1, 10); !errors.Is(err, permission.ErrMembershipNotFound) {
		t.Fatalf("revoked membership must deny the entire listing: %v", err)
	}
}

func TestChatMusicWaitReusesVoiceReference(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write(chatWAV())
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
	t.Setenv("RAGFLOW_MUSIC_BASE_URL", server.URL)
	if _, err := musicVoiceReference(ctx); err != nil {
		t.Fatal(err)
	}
	if err := dao.DB.Create(&entity.ChatTaskResourceLease{ResourceID: execution.config.Device, TaskID: "other-worker", LeaseEpoch: 1}).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		execution.deferred.Store(false)
		if _, err := synthesizeLocalMusic(ctx, chatSpeechPlan{Answer: "歌词", MusicCaption: "soft female vocal", Duration: 10}); !errors.Is(err, errChatTaskDeferred) {
			t.Fatalf("wait %d: %v", i, err)
		}
		current, err := execution.dao.Get(ctx, execution.task.ID)
		if err != nil || !dao.CanResumeChatTask(current) {
			t.Fatalf("reference checkpoint not resumable: %+v %v", current, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("successful TTS repeated while waiting for music: %d", calls.Load())
	}
	current, _ := execution.dao.Get(ctx, execution.task.ID)
	var asset entity.ChatMediaAsset
	if err := dao.DB.Take(&asset, "id = ?", current.Outputs["voice_reference"]).Error; err != nil {
		t.Fatal(err)
	}
	if err := storage.GetStorageFactory().GetStorage().Remove(ctx, asset.Bucket, asset.ObjectKey); err != nil {
		t.Fatal(err)
	}
	if _, err := musicVoiceReference(ctx); err == nil || calls.Load() != 1 {
		t.Fatalf("missing checkpoint blindly regenerated: calls=%d err=%v", calls.Load(), err)
	}
}

type combinedFailurePipeline struct{}

func (p *combinedFailurePipeline) AsyncChat(ctx context.Context, _ *entity.Chat, _ []map[string]interface{}, _ bool, _ map[string]interface{}) (<-chan AsyncChatResult, error) {
	if ctx.Value(chatImagePlanningKey{}) == true {
		return makeResultChan(AsyncChatResult{Answer: `{"prompt":"a train","size":"2048x2048","use_previous_image":false}`, Final: true}), nil
	}
	return makeResultChan(AsyncChatResult{Answer: `{"answer":"完整正文 [ID:0]","voice":"serena","mode":"speech"}`,
		Reference: map[string]interface{}{"chunks": []interface{}{map[string]interface{}{"id": "source-1"}}},
		Prompt:    "grounded prompt", Usage: &ChatTurnUsage{TotalTokens: 12}, ElapsedMs: 125, Final: true}), nil
}

func TestChatCombinedMediaFailureKeepsTextAndCitationsAfterReload(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "image_voice")
	execution.service.pipeline = &combinedFailurePipeline{}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", server.URL)
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test")
	t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
	session, err := execution.service.chatSessionDAO.GetByID(ctx, dao.DB, execution.task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = execution.service.completeMedia(ctx, &execution.input.Chat, session, execution.input.Messages, "turn", "image_voice", "question", nil)
	if err == nil || calls.Load() != 2 {
		t.Fatalf("expected both media failures: calls=%d err=%v", calls.Load(), err)
	}
	current, err := execution.dao.Get(ctx, execution.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	answer := current.Outputs["answer"].(map[string]interface{})
	for _, key := range []string{"content", "reference", "prompt", "usage", "elapsed_ms", "output_revision"} {
		if answer[key] == nil {
			t.Fatalf("first text commit lost %s: %#v", key, answer)
		}
	}
	reloaded, err := dao.NewChatSessionDAO().GetByID(ctx, dao.DB, execution.task.SessionID,
		dao.ConversationHistoryOptions{IncludeReference: true, IncludePrompt: true, IncludeUsage: true, IncludeElapsedMs: true})
	if err != nil {
		t.Fatal(err)
	}
	messages := parseMessages(reloaded.Message)
	var saved map[string]interface{}
	for _, message := range messages {
		if message["role"] == "assistant" {
			saved = message
		}
	}
	if saved["content"] != "完整正文 [ID:0]" || saved["reference"] == nil || saved["output_revision"] == nil {
		t.Fatalf("reloaded answer lost text/citations/version: %#v", saved)
	}
	for _, key := range []string{"prompt", "usage", "elapsed_ms"} {
		if saved[key] == nil {
			t.Fatalf("reloaded answer lost %s: %#v", key, saved)
		}
	}
	if got := chatTaskRetryOptions(&entity.ChatTask{State: "partial_succeeded", UpstreamStatus: current.UpstreamStatus,
		Input: current.Input, Outputs: current.Outputs}); len(got.Stages) != 2 {
		t.Fatalf("failed branches not retryable: %+v", got)
	}
}

func TestChatIndependentImageDoesNotRetainCandidateParent(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "生图")
	execution.input.ParentID = "candidate"
	execution.input.Resume["image_plan"] = chatImagePlan{Prompt: "independent", Size: "2048x2048"}
	image := chatJPEG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": []interface{}{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(image)}}})
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", server.URL)
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test")
	session, _ := execution.service.chatSessionDAO.GetByID(ctx, dao.DB, execution.task.SessionID)
	if _, err := execution.service.completeMediaBranch(ctx, &execution.input.Chat, session, execution.input.Messages, "turn", "生图", "independent", nil); err != nil {
		t.Fatal(err)
	}
	var output entity.ChatMediaAsset
	if err := dao.DB.Take(&output, "task_id = ?", execution.task.ID).Error; err != nil || output.ParentID != "" {
		t.Fatalf("independent image linked candidate: %+v %v", output, err)
	}
	var count int64
	dao.DB.Model(&entity.ChatMediaReference{}).Where("owner_kind = ?", "parent").Count(&count)
	if count != 0 {
		t.Fatalf("independent image retained a parent: %d", count)
	}
}

type chatScanQueue struct{ published chan string }

func (*chatScanQueue) InitChatTasks(context.Context, string, string, time.Duration, int) error {
	return nil
}
func (q *chatScanQueue) PublishChatTask(_ context.Context, _, id string) error {
	select {
	case q.published <- id:
	default:
	}
	return nil
}
func (*chatScanQueue) PullChatTask(context.Context, string, string) (jetstream.Msg, error) {
	return nil, nil
}

type slowChatRemoval struct {
	storage.Storage
	started chan struct{}
}

func (s *slowChatRemoval) Remove(ctx context.Context, _, _ string, _ ...string) error {
	close(s.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestChatSlowCleanupDoesNotBlockHeartbeatOrDispatch(t *testing.T) {
	ctx, execution := setupChatExecutionTest(t, "语音")
	// A second queued task is discovered while cleanup is blocked in storage.
	if err := dao.DB.Model(&entity.ChatTask{}).Where("id = ?", execution.task.ID).Updates(map[string]interface{}{
		"state": "queued", "lease_owner": "", "lease_until": 0, "dispatch_after": 0,
	}).Error; err != nil {
		t.Fatal(err)
	}
	asset := entity.ChatMediaAsset{ID: "orphan", SourceKey: "orphan", Kind: "audio", State: "staging", CreatedAt: 1, Bucket: "test", ObjectKey: "orphan"}
	if err := dao.DB.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	slow := &slowChatRemoval{Storage: storage.NewMemoryStorage(), started: make(chan struct{})}
	queue := &chatScanQueue{published: make(chan string, 10)}
	config := execution.config
	config.Scan, config.Lease, config.CleanupGrace = 10*time.Millisecond, 100*time.Millisecond, 0
	worker := &ChatTaskWorker{config: config, dao: execution.dao, queue: queue, id: "slow-test"}
	runCtx, cancel := context.WithCancel(ctx)
	defer func() { cancel(); worker.wg.Wait() }()
	worker.wg.Add(1)
	go worker.cleanup(runCtx, slow)
	select {
	case <-slow.started:
	case <-time.After(2 * time.Second):
		t.Fatal("cleanup did not reach storage")
	}
	worker.wg.Add(1)
	go worker.scan(runCtx)
	select {
	case <-queue.published:
	case <-time.After(2 * time.Second):
		t.Fatal("slow cleanup blocked dispatch")
	}
	timer := time.NewTimer(3 * config.Lease)
	defer timer.Stop()
	<-timer.C
	var heartbeat entity.ChatTaskWorker
	if err := dao.DB.Take(&heartbeat, "id = ?", worker.id).Error; err != nil || heartbeat.LeaseUntil <= time.Now().UnixMilli() {
		t.Fatalf("slow cleanup expired heartbeat: %+v %v", heartbeat, err)
	}
}
