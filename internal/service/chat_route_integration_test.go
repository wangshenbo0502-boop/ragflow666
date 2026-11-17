//go:build integration

package service

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
)

type chatInterruptedStream struct {
	io.ReadCloser
	reader  *bufio.Reader
	pending []byte
	cut     bool
	cuts    *atomic.Int64
}

func (s *chatInterruptedStream) Read(p []byte) (int, error) {
	if len(s.pending) == 0 {
		if s.cut {
			return 0, io.EOF
		}
		line, err := s.reader.ReadBytes('\n')
		if len(line) == 0 {
			return 0, err
		}
		s.pending = line
		payload := strings.TrimSpace(string(line))
		if strings.HasPrefix(payload, "data:") {
			var event struct {
				Choices []struct {
					Delta struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(payload, "data:"))), &event) == nil {
				for _, choice := range event.Choices {
					if choice.Delta.Content != "" || choice.Delta.ReasoningContent != "" {
						s.cut = true
						s.cuts.Add(1)
						break
					}
				}
			}
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

func TestChatRouteRealModelFallback(t *testing.T) {
	dsn := os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")
	if dsn == "" {
		t.Skip("requires disposable seeded MySQL and two authorized real chat models")
	}
	// This opt-in affects this test process only, allowing the controlled
	// loopback proxies to forward successful calls to the real provider.
	t.Setenv(common.EnvAllowAnyHost, "true")
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot open disposable MySQL")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var schema string
	if db.Raw("SELECT DATABASE()").Scan(&schema).Error != nil || !strings.HasPrefix(schema, "ragflow_chat_test_e2e_") {
		t.Fatal("refusing database outside disposable schema")
	}
	oldDB := dao.DB
	dao.DB = db
	defer func() { dao.DB = oldDB }()
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal("cannot migrate disposable health state")
	}
	ctx, cancel := context.WithTimeout(permission.WithIdentity(t.Context(),
		os.Getenv("RAGFLOW_TEST_CHAT_TENANT"), os.Getenv("RAGFLOW_TEST_CHAT_TENANT")), 3*time.Minute)
	defer cancel()
	var originals []entity.TenantModel
	for _, id := range []string{os.Getenv("RAGFLOW_TEST_CHAT_PREFERRED"), os.Getenv("RAGFLOW_TEST_CHAT_BACKUP")} {
		var model entity.TenantModel
		if id == "" || db.Take(&model, "id = ?", id).Error != nil {
			t.Fatal("requires two explicitly selected authorized models")
		}
		originals = append(originals, model)
	}
	if originals[0].ModelName == originals[1].ModelName {
		t.Fatal("fallback must use a different real model")
	}
	factory := NewModelFactory()
	var preferredFailures atomic.Int64
	var backupFailures atomic.Int64
	var interruptStream atomic.Bool
	var streamCuts atomic.Int64
	var preferredStatus atomic.Int64
	preferredStatus.Store(http.StatusServiceUnavailable)
	cancelStarted := make(chan struct{}, 1)
	var preferredCalls, backupCalls, preferredSuccess, backupSuccess atomic.Int64
	preferredFailures.Store(1)
	var clones []entity.TenantModel
	for i, original := range originals {
		if _, err := factory.ResolveInfo(ctx, entity.ModelTypeChat, original.ID); err != nil {
			t.Fatal("original model is not currently authorized")
		}
		var instance entity.TenantModelInstance
		if db.Take(&instance, "id = ?", original.InstanceID).Error != nil {
			t.Fatal("cannot resolve original instance")
		}
		var extra map[string]interface{}
		if json.Unmarshal([]byte(instance.Extra), &extra) != nil {
			t.Fatal("invalid original instance configuration")
		}
		target, err := url.Parse(stringValue(extra["base_url"]))
		if err != nil || target.Scheme != "http" && target.Scheme != "https" || target.Host == "" {
			t.Fatal("requires explicitly configured real upstream URL")
		}
		// The proxy only injects a definite stopped HTTP failure; every successful
		// response comes from the existing authorized provider and real driver.
		proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: target.Scheme, Host: target.Host})
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "real upstream transport failed", http.StatusBadGateway)
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.StatusCode == http.StatusOK {
				if i == 0 {
					preferredSuccess.Add(1)
				} else {
					backupSuccess.Add(1)
				}
				if i == 0 && interruptStream.Load() {
					response.Body = &chatInterruptedStream{
						ReadCloser: response.Body, reader: bufio.NewReader(response.Body),
						cuts: &streamCuts,
					}
					response.ContentLength = -1
					response.Header.Del("Content-Length")
				}
			}
			return nil
		}
		direct := proxy.Director
		proxy.Director = func(req *http.Request) {
			direct(req)
			req.Host = target.Host
			if i == 0 && interruptStream.Load() {
				req.Header.Set("Accept-Encoding", "identity")
			}
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if i == 0 {
				preferredCalls.Add(1)
				if preferredFailures.Add(-1) >= 0 {
					io.Copy(io.Discard, req.Body)
					if preferredStatus.Load() == -1 {
						cancelStarted <- struct{}{}
						<-req.Context().Done()
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(int(preferredStatus.Load()))
					io.WriteString(w, `{"error":{"message":"isolated controlled failure","type":"server_error"}}`)
					return
				}
			} else {
				backupCalls.Add(1)
				if backupFailures.Add(-1) >= 0 {
					io.Copy(io.Discard, req.Body)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusServiceUnavailable)
					io.WriteString(w, `{"error":{"message":"isolated backup failure","type":"server_error"}}`)
					return
				}
			}
			proxy.ServeHTTP(w, req)
		}))
		t.Cleanup(server.Close)
		instance.ID, instance.InstanceName = common.GenerateToken(), "route-verify-"+common.GenerateToken()[:8]
		extra["base_url"] = server.URL + target.Path
		raw, err := json.Marshal(extra)
		if err != nil {
			t.Fatal(err)
		}
		instance.Extra = string(raw)
		if db.Create(&instance).Error != nil {
			t.Fatal("cannot create disposable instance")
		}
		model := original
		model.ID, model.InstanceID = common.GenerateToken(), instance.ID
		if db.Create(&model).Error != nil {
			t.Fatal("cannot create disposable model")
		}
		clones = append(clones, model)
	}
	preferred, err := factory.NewChatModel(ctx, clones[0].ID)
	if err != nil {
		t.Fatal("cannot construct preferred real model")
	}
	backup, err := factory.NewChatModel(ctx, clones[1].ID)
	if err != nil || !chatRouteCompatible(preferred.Info(), backup.Info(), false) {
		t.Fatal("selected models do not satisfy the same output/context/tool contract")
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	maxTokens, thinking := 128, false
	messages := []models.Message{{Role: "user", Content: "Reply with the single word READY."}}
	invoke := func(policy string) (*chatRouteState, *models.ChatResponse, error) {
		state := &chatRouteState{config: config, policy: policy, deadline: time.Now().Add(time.Minute),
			candidates: []chatRouteCandidate{{ID: clones[0].ID}, {ID: clones[1].ID}}}
		response, err := preferred.ChatWithMessages(models.WithChatRoute(ctx, state.invoke),
			messages, &models.ChatConfig{MaxTokens: &maxTokens, Thinking: &thinking}, &common.ModelUsage{})
		return state, response, err
	}
	state, response, err := invoke("fallback")
	if err != nil || response == nil || response.Answer == nil || strings.TrimSpace(*response.Answer) == "" ||
		state.calls != 2 || state.switches != 1 || preferredCalls.Load() != 1 || backupCalls.Load() != 1 || backupSuccess.Load() != 1 {
		t.Fatalf("real fallback failed: calls=%d switches=%d preferred=%d backup=%d successful_backup=%d err_type=%T",
			state.calls, state.switches, preferredCalls.Load(), backupCalls.Load(), backupSuccess.Load(), err)
	}
	// A new route instance observes the same database cooldown.
	state, response, err = invoke("fallback")
	if err != nil || response == nil || state.calls != 1 || state.switches != 1 || preferredCalls.Load() != 1 || backupCalls.Load() != 2 {
		t.Fatalf("shared cooldown failed: calls=%d preferred=%d backup=%d err_type=%T",
			state.calls, preferredCalls.Load(), backupCalls.Load(), err)
	}
	healthID := permission.TenantIDFromContext(ctx) + ":" + clones[0].ID
	if db.Model(&entity.ChatModelHealth{}).Where("id = ?", healthID).Update("cooldown_until", 1).Error != nil {
		t.Fatal("cannot advance isolated recovery boundary")
	}
	state, response, err = invoke("fixed")
	if err != nil || response == nil || state.calls != 1 || state.switches != 0 || preferredSuccess.Load() != 1 || backupCalls.Load() != 2 {
		t.Fatalf("real recovery/fixed route failed: preferred_success=%d err_type=%T", preferredSuccess.Load(), err)
	}
	preferredFailures.Store(1)
	state, _, err = invoke("fixed")
	var status *models.APIStatusError
	if err == nil || !errors.As(err, &status) || status.Status != 503 || state.calls != 1 ||
		state.switches != 0 || backupCalls.Load() != 2 {
		t.Fatalf("fixed route switched or swallowed failure: calls=%d switches=%d backup=%d err_type=%T",
			state.calls, state.switches, backupCalls.Load(), err)
	}
	loadHealth := func() entity.ChatModelHealth {
		t.Helper()
		var health entity.ChatModelHealth
		if db.Take(&health, "id = ?", healthID).Error != nil {
			t.Fatal("cannot read shared health")
		}
		return health
	}
	advanceRecovery := func() {
		t.Helper()
		if db.Model(&entity.ChatModelHealth{}).Where("id = ?", healthID).Update("cooldown_until", 1).Error != nil {
			t.Fatal("cannot advance isolated cooldown")
		}
	}
	advanceRecovery()
	// Separate database handles compete for the same recovery permit.
	type probeResult struct {
		generation int64
		allowed    bool
		err        error
	}
	results := make(chan probeResult, 12)
	start := make(chan struct{})
	var probes sync.WaitGroup
	for range 12 {
		probes.Add(1)
		go func() {
			defer probes.Done()
			<-start
			generation, allowed, err := dao.ClaimChatModelProbe(ctx, db.Session(&gorm.Session{NewDB: true}),
				healthID, time.Minute)
			results <- probeResult{generation, allowed, err}
		}()
	}
	close(start)
	probes.Wait()
	close(results)
	winners := 0
	var probeGeneration int64
	for result := range results {
		if result.err != nil {
			t.Fatal("concurrent real MySQL probe claim failed")
		}
		if result.allowed {
			winners++
			probeGeneration = result.generation
		}
	}
	if winners != 1 {
		t.Fatalf("shared recovery allowed %d probes, expected exactly one", winners)
	}
	policy := dao.ChatModelHealthPolicy{FailureThreshold: config.ModelFailureThreshold,
		FailureWindow: config.ModelFailureWindow, Cooldown: config.ModelCooldown}
	if err := dao.SettleChatModelHealth(ctx, db, healthID, probeGeneration, policy, "", false, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := invoke("fixed"); err != nil {
		t.Fatal("real recovery after shared probe did not succeed")
	}
	config.ModelFailureThreshold, config.ModelCooldown = 2, 17*time.Second
	preferredFailures.Store(1)
	if _, _, err := invoke("fixed"); err == nil {
		t.Fatal("controlled first failure unexpectedly succeeded")
	}
	firstFailure := loadHealth()
	if firstFailure.Failures != 1 || firstFailure.CooldownUntil != 0 {
		t.Fatal("configured threshold tripped before the second service failure")
	}
	preferredStatus.Store(http.StatusBadRequest)
	preferredFailures.Store(1)
	if _, _, err := invoke("fixed"); !errors.As(err, &status) || status.Status != http.StatusBadRequest {
		t.Fatal("real driver did not preserve the controlled parameter error")
	}
	afterParameter := loadHealth()
	if afterParameter.Failures != firstFailure.Failures || afterParameter.CooldownUntil != 0 {
		t.Fatal("user parameter error contributed to model cooldown")
	}
	preferredStatus.Store(-1)
	preferredFailures.Store(1)
	cancelCtx, stopCall := context.WithCancel(ctx)
	cancelResult := make(chan error, 1)
	go func() {
		cancelState := &chatRouteState{config: config, policy: "fixed", deadline: time.Now().Add(time.Minute)}
		_, err := preferred.ChatWithMessages(models.WithChatRoute(cancelCtx, cancelState.invoke),
			messages, &models.ChatConfig{MaxTokens: &maxTokens, Thinking: &thinking}, &common.ModelUsage{})
		cancelResult <- err
	}()
	select {
	case <-cancelStarted:
	case <-ctx.Done():
		stopCall()
		t.Fatal("controlled upstream did not receive cancellable request")
	}
	stopCall()
	select {
	case err := <-cancelResult:
		if err == nil {
			t.Fatal("cancelled real driver call unexpectedly succeeded")
		}
	case <-ctx.Done():
		t.Fatal("real driver did not finish cancellation")
	}
	afterCancel := loadHealth()
	if afterCancel.Failures != firstFailure.Failures || afterCancel.CooldownUntil != 0 || afterCancel.ProbeUntil != 0 {
		t.Fatal("cancellation contributed to model cooldown or retained probe")
	}
	preferredStatus.Store(http.StatusServiceUnavailable)
	preferredFailures.Store(1)
	if _, _, err := invoke("fixed"); err == nil {
		t.Fatal("controlled second service failure unexpectedly succeeded")
	}
	tripped := loadHealth()
	var databaseNow int64
	if db.Raw("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS SIGNED)").Scan(&databaseNow).Error != nil ||
		tripped.Failures != 2 || tripped.CooldownUntil-databaseNow < 16000 || tripped.CooldownUntil-databaseNow > 17000 {
		t.Fatal("second service failure did not apply the configured shared cooldown")
	}
	callsBeforeCooldown := preferredCalls.Load()
	if _, _, err := invoke("fixed"); err == nil || preferredCalls.Load() != callsBeforeCooldown {
		t.Fatal("fresh route called the upstream during shared cooldown")
	}
	advanceRecovery()
	if _, _, err := invoke("fixed"); err != nil {
		t.Fatal("real model did not recover after configured cooldown")
	}
	restored := loadHealth()
	if restored.Failures != 0 || restored.CooldownUntil != 0 || restored.WindowStart != 0 || restored.ProbeUntil != 0 {
		t.Fatal("successful real recovery did not clear shared failure window")
	}
	t.Run("durable_fallback_diagnostics", func(t *testing.T) {
		svc := NewChatSessionService()
		userID, tenantID := permission.UserIDFromContext(ctx), permission.TenantIDFromContext(ctx)
		chat := &entity.Chat{ID: common.GenerateToken(), TenantID: tenantID, UserID: userID,
			Status: strPtr("1"), PromptConfig: entity.JSONMap{}, LLMSetting: entity.JSONMap{}, KBIDs: entity.JSONSlice{}}
		if err := db.Create(chat).Error; err != nil {
			t.Fatal(err)
		}
		session := &entity.ChatSession{ID: common.GenerateToken(), DialogID: chat.ID,
			UserID: &userID, Message: json.RawMessage(`[]`)}
		if err := svc.chatSessionDAO.Create(ctx, db, session); err != nil {
			t.Fatal(err)
		}
		input := &chatTaskInput{ExpectedAnswerAbsent: true}
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		d := dao.NewChatTaskDAO(db)
		id := common.GenerateToken()
		task, _, err := d.Submit(ctx, &entity.ChatTask{ID: id, TenantID: tenantID, UserID: userID,
			ChatID: chat.ID, SessionID: session.ID, TurnID: id, Kind: "voice", Input: string(raw),
			InputHash: strings.Repeat("a", 64), IdempotencyKey: id,
			MaxCalls: config.MaxCalls, MaxStageCalls: config.MaxStageCalls, MaxSwitches: config.MaxSwitches,
			QueueDeadline: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(2 * time.Minute).UnixMilli(),
		}, 100, 100, func(tx *gorm.DB) error {
			return svc.chatSessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
				"history_update": dao.ConversationHistoryUpdate{
					Message: map[string]interface{}{"id": id, "role": "user", "content": messages[0].Content},
				},
			})
		})
		if err != nil {
			t.Fatal(err)
		}
		task, err = d.Claim(ctx, task.ID, "route-diagnostics", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		execution := &chatTaskExecution{service: svc, dao: d, task: task,
			config: config, owner: task.LeaseOwner, input: input}
		runCtx := context.WithValue(ctx, chatTaskExecutionKey{}, execution)
		runCtx = common.WithModelCallObserver(runCtx, execution)
		state := &chatRouteState{config: config, policy: "fallback", deadline: time.Now().Add(time.Minute),
			candidates: []chatRouteCandidate{{ID: clones[0].ID}, {ID: clones[1].ID}}}
		preferredFailures.Store(1)
		beforePreferred, beforeBackup := preferredCalls.Load(), backupCalls.Load()
		usage := &common.ModelUsage{}
		response, err := preferred.ChatWithMessages(models.WithChatRoute(runCtx, state.invoke),
			messages, &models.ChatConfig{MaxTokens: &maxTokens, Thinking: &thinking}, usage)
		if err != nil || response == nil || response.Answer == nil || strings.TrimSpace(*response.Answer) == "" ||
			preferredCalls.Load() != beforePreferred+1 || backupCalls.Load() != beforeBackup+1 {
			code, _ := chatTaskError(err)
			t.Fatalf("durable real fallback failed: err_type=%T code=%s preferred=%d backup=%d",
				err, code, preferredCalls.Load()-beforePreferred, backupCalls.Load()-beforeBackup)
		}
		reply := map[string]interface{}{"answer": *response.Answer}
		if err := execution.commitText(runCtx, reply, chatTextAnswer(task.TurnID, reply)); err != nil {
			t.Fatal(err)
		}
		if err := d.Mutate(ctx, task.ID, task.LeaseOwner, task.LeaseEpoch, "task_terminal",
			func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
				current.State = "succeeded"
				return entity.JSONMap{"state": current.State}, nil
			}); err != nil {
			t.Fatal(err)
		}
		result, err := svc.GetChatTask(ctx, task.ID)
		if err != nil {
			t.Fatal(err)
		}
		diagnostics := result["diagnostics"].(chatTaskDiagnostics)
		language := diagnostics.Stages["language"]
		if diagnostics.Switches != 1 || diagnostics.SwitchedSucceeded != 1 ||
			diagnostics.SwitchReasons["service_unavailable"] != 1 || !diagnostics.SwitchDetailsComplete ||
			!diagnostics.EventHistoryComplete || diagnostics.FirstTextMs == nil ||
			language == nil || language.Attempts != 2 || language.Succeeded != 1 || language.Failed != 1 ||
			usage.TotalTokens <= 0 || language.Usage["total_tokens"] != int64(usage.TotalTokens) {
			t.Fatalf("real model fallback lost durable diagnostics: %+v usage=%+v", diagnostics, language)
		}
		attempts := result["attempts"].([]entity.ChatTaskAttempt)
		if len(attempts) != 2 || attempts[0].Model != clones[0].ID || attempts[1].Model != clones[1].ID {
			t.Fatal("real model fallback lost persisted provider identity")
		}
		t.Logf("task=%s real_provider_attempts=2 failed=1 succeeded=1 switches=1 switched_succeeded=1 tokens=%d",
			task.ID, language.Usage["total_tokens"])
	})
	t.Run("real_partial_stream_never_switches", func(t *testing.T) {
		interruptStream.Store(true)
		defer interruptStream.Store(false)
		state := &chatRouteState{config: config, policy: "fallback", deadline: time.Now().Add(time.Minute),
			candidates: []chatRouteCandidate{{ID: clones[0].ID}, {ID: clones[1].ID}}}
		beforePreferred, beforeBackup := preferredCalls.Load(), backupCalls.Load()
		beforeCuts := streamCuts.Load()
		var text strings.Builder
		sawDone := false
		err := preferred.ChatStreamlyWithSender(models.WithChatRoute(ctx, state.invoke),
			[]models.Message{{Role: "user", Content: "Write three sentences about the ocean."}},
			&models.ChatConfig{MaxTokens: &maxTokens, Thinking: &thinking}, &common.ModelUsage{},
			func(delta, reasoning *string) error {
				for _, value := range []*string{delta, reasoning} {
					if value != nil {
						if *value == "[DONE]" {
							sawDone = true
						} else {
							text.WriteString(*value)
						}
					}
				}
				return nil
			})
		var partial *models.ChatPartialError
		if !errors.As(err, &partial) || text.Len() == 0 || sawDone || streamCuts.Load() != beforeCuts+1 || state.calls != 1 ||
			state.switches != 0 || preferredCalls.Load() != beforePreferred+1 || backupCalls.Load() != beforeBackup {
			t.Fatalf("partial real stream was swallowed or replayed: err_type=%T chars=%d done=%v cuts=%d calls=%d switches=%d",
				err, text.Len(), sawDone, streamCuts.Load()-beforeCuts, state.calls, state.switches)
		}
		t.Logf("PASS actual provider SSE interrupted after %d bytes of output; partial error retained, no success sentinel, backup calls=0", text.Len())
	})
	t.Run("all_candidates_fail_within_budget", func(t *testing.T) {
		preferredFailures.Store(1)
		backupFailures.Store(1)
		beforePreferred, beforeBackup := preferredCalls.Load(), backupCalls.Load()
		state, response, err := invoke("fallback")
		var status *models.APIStatusError
		if !errors.As(err, &status) || status.Status != http.StatusServiceUnavailable || response != nil ||
			state.calls != 2 || state.switches != 1 || preferredCalls.Load() != beforePreferred+1 ||
			backupCalls.Load() != beforeBackup+1 {
			t.Fatalf("all-candidate failure lost bounded error: err_type=%T calls=%d switches=%d",
				err, state.calls, state.switches)
		}
		t.Log("PASS two actual driver HTTP 503 failures -> exhausted route; calls=2 switches=1, no fabricated answer")
	})
	for _, original := range originals {
		var after entity.TenantModel
		if db.Take(&after, "id = ?", original.ID).Error != nil || after.ModelName != original.ModelName ||
			after.InstanceID != original.InstanceID || after.Extra != original.Extra {
			t.Fatal("routing rewrote original model configuration")
		}
	}
	t.Logf("real models=%s -> %s; fallback calls=2 switches=1; shared cooldown skipped preferred; real recovery and fixed-only failure passed; original configuration unchanged",
		originals[0].ModelName, originals[1].ModelName)
	t.Log("real MySQL recovery permits=1/12; threshold=2/cooldown=17s; HTTP 400 and in-flight cancellation do not increase failures; successful real probe resets window")
}
