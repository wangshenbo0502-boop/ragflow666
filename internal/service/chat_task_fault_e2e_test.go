//go:build e2e

package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
)

func chatFaultDatabase(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(mysql.Open(os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot connect disposable fault-test database")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	var schema string
	if err := db.Raw("SELECT DATABASE()").Scan(&schema).Error; err != nil ||
		(!strings.HasPrefix(schema, "ragflow_chat_test_e2e_") && schema != "ragflow_chat_test_planning_20261117") {
		t.Fatal("refusing non-isolated database")
	}
	return db
}

func (e *chatVoiceE2E) faultControl(command map[string]any) map[string]int {
	e.t.Helper()
	endpoint := os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	if endpoint != "http://host.docker.internal:19980/control" {
		e.t.Fatal("requires dedicated TTS timing forwarder")
	}
	raw, _ := json.Marshal(command)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(e.t.Context()), 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	response, err := e.client.Do(request)
	if err != nil {
		e.t.Fatal("TTS timing forwarder unavailable")
	}
	defer response.Body.Close()
	var counts map[string]int
	if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&counts) != nil {
		e.t.Fatal("invalid TTS timing-control response")
	}
	return counts
}

func (e *chatVoiceE2E) waitRealAudioHeld(taskID string, before map[string]int) {
	e.t.Helper()
	db := chatFaultDatabase(e.t)
	tasks := dao.NewChatTaskDAO(db)
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		details, err := tasks.Details(e.t.Context(), taskID)
		if err != nil {
			e.t.Fatal("cannot read task while waiting for held audio")
		}
		if dao.IsChatTaskTerminal(details.Task.State) {
			e.t.Fatalf("task reached terminal state before held audio: %s",
				chatTaskSnapshotDiagnostic(db, details))
		}
		current := e.faultControl(nil)
		if current["forwarded"] == before["forwarded"]+1 && current["ready"] == 1 &&
			current["completed"] == before["completed"]+1 {
			return
		}
		select {
		case <-e.t.Context().Done():
			e.t.Fatal("held audio wait cancelled")
		case <-time.After(250 * time.Millisecond):
		}
	}
	details, err := tasks.Details(e.t.Context(), taskID)
	if err == nil {
		e.t.Fatalf("real TTS did not produce a held WAV response: %s",
			chatTaskSnapshotDiagnostic(db, details))
	}
	e.t.Fatalf("real TTS did not produce a held WAV response: task_id=%s", taskID)
}

func (e *chatVoiceE2E) waitTaskBeforeHeldAudio(taskID string) chatVoiceTaskDetail {
	e.t.Helper()
	db := chatFaultDatabase(e.t)
	deadline := time.Now().Add(15 * time.Second)
	var current chatVoiceTaskDetail
	for time.Now().Before(deadline) {
		e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &current)
		if current.Task.State == "running" &&
			current.Task.UpstreamStatus == "unknown" &&
			current.Task.Stage == "audio" &&
			current.Task.Outputs["answer"] != nil &&
			len(current.Attempts) >= 3 {
			return current
		}
		if dao.IsChatTaskTerminal(current.Task.State) {
			details, err := dao.NewChatTaskDAO(db).Details(e.t.Context(), taskID)
			if err != nil {
				e.t.Fatal("cannot read terminal task at held audio boundary")
			}
			e.t.Fatalf("task reached terminal state before held audio boundary: %s",
				chatTaskSnapshotDiagnostic(db, details))
		}
		select {
		case <-e.t.Context().Done():
			e.t.Fatal("held audio boundary wait cancelled")
		case <-time.After(200 * time.Millisecond):
		}
	}
	e.t.Fatalf("held audio boundary not observable: state=%s upstream=%s stage=%s calls=%d attempts=%d",
		current.Task.State, current.Task.UpstreamStatus, current.Task.Stage, current.Task.Calls,
		len(current.Attempts))
	return current
}

func (e *chatVoiceE2E) workerFault(action string) {
	e.t.Helper()
	endpoint := os.Getenv("RAGFLOW_TEST_CHAT_WORKER_CONTROL")
	if endpoint != "http://host.docker.internal:19983" || (action != "crash" && action != "start") {
		e.t.Fatal("requires host callback limited to disposable ingestor")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(e.t.Context()), 35*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/"+action, nil)
	response, err := e.client.Do(request)
	if err != nil {
		e.t.Fatal("isolated Worker control unavailable")
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		e.t.Fatalf("isolated Worker %s failed", action)
	}
}

func (e *chatVoiceE2E) submitHeldVoice(name string) (string, string, string) {
	e.t.Helper()
	chatID, sessionID := e.newMediaSession(name)
	var admission struct {
		TaskID string `json:"task_id"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "@语音 请根据资料用一句话回答青禾项目的验收暗号和负责人，保留引用。",
	}, &admission)
	if admission.TaskID == "" {
		e.t.Fatal("missing durable task identity")
	}
	return chatID, sessionID, admission.TaskID
}

func assertChatFaultNoMedia(t *testing.T, db *gorm.DB, taskID string) {
	t.Helper()
	var count int64
	if err := db.Model(&entity.ChatMediaAsset{}).Where("task_id = ?", taskID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("late result published a media asset: count=%d err=%v", count, err)
	}
}

func TestChatWorkerRealGatewayUnknown(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	idle := e.faultControl(nil)
	if idle["holding"] != 0 || idle["hold_next"] != 0 || idle["fail_next"] != 0 {
		t.Fatal("another test owns the TTS timing gate")
	}
	before := e.faultControl(map[string]any{"hold_next": 1})
	t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
	_, _, taskID := e.submitHeldVoice("Real Worker gateway result unknown")
	e.waitRealAudioHeld(taskID, before)
	e.faultControl(map[string]any{"release": true, "release_status": 524})
	terminal := e.waitTask(taskID)
	if terminal.Task.State != "partial_succeeded" || terminal.Task.UpstreamStatus != "unknown" ||
		len(terminal.RetryStages) != 0 || terminal.Task.Calls < 2 {
		t.Fatalf("gateway did not isolate the result: state=%s upstream=%s calls=%d retries=%v",
			terminal.Task.State, terminal.Task.UpstreamStatus, terminal.Task.Calls, terminal.RetryStages)
	}
	var audioAttempts []entity.ChatTaskAttempt
	if err := db.Where("task_id = ? AND stage = ?", taskID, "audio").Find(&audioAttempts).Error; err != nil ||
		len(audioAttempts) != 1 || audioAttempts[0].State != "unknown" ||
		audioAttempts[0].ErrorCode != "upstream_result_unknown" {
		t.Fatal("gateway failure did not preserve one unknown audio attempt")
	}
	var leases int64
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", taskID).Count(&leases).Error; err != nil || leases == 0 {
		t.Fatal("gateway failure released uncertain capacity")
	}
	answer, ok := terminal.Task.Outputs["answer"].(map[string]any)
	if !ok || answer["reference"] == nil || !strings.Contains(fmt.Sprint(answer["content"]), "山海同行") ||
		!strings.Contains(fmt.Sprint(answer["content"]), "林悦") {
		t.Fatal("gateway failure lost the committed text or citations")
	}
	assertChatFaultNoMedia(t, db, taskID)
	body, _ := json.Marshal(map[string]any{"stage": "audio", "revision": terminal.Task.Revision})
	request, _ := http.NewRequestWithContext(t.Context(), http.MethodPost,
		e.origin+"/api/v1/chats/tasks/"+taskID+"/retry", bytes.NewReader(body))
	request.Header.Set("Authorization", e.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := e.client.Do(request)
	if err != nil {
		t.Fatal("cannot verify retry denial")
	}
	var envelope struct {
		Code int `json:"code"`
	}
	err = json.NewDecoder(response.Body).Decode(&envelope)
	response.Body.Close()
	if err != nil || (response.StatusCode == http.StatusOK && envelope.Code == 0) {
		t.Fatal("unknown gateway result admitted a retry")
	}
	var unchanged chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &unchanged)
	after := e.faultControl(nil)
	if !reflect.DeepEqual(unchanged.Task, terminal.Task) || after["forwarded"] != before["forwarded"]+1 ||
		after["completed"] != before["completed"]+1 || after["released"] != before["released"]+1 || after["holding"] != 0 {
		t.Fatal("retry denial changed the terminal task or repeated synthesis")
	}
	// The forwarder consumed a complete valid WAV before emitting the gateway error.
	if err := dao.NewChatTaskDAO(db).ReconcileStopped(t.Context(), taskID,
		fmt.Sprintf("gateway-524-real-WAV-completed-released-%s", taskID)); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", taskID).Count(&leases).Error; err != nil || leases != 0 {
		t.Fatal("confirmed completed synthesis retained test capacity")
	}
	var reconciled chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &reconciled)
	if reconciled.Task.State != terminal.Task.State || reconciled.Task.Calls != terminal.Task.Calls ||
		!reflect.DeepEqual(reconciled.Task.Outputs, terminal.Task.Outputs) || reconciled.Task.UpstreamStatus != "stopped" {
		t.Fatal("reconciliation changed the terminal outcome")
	}
	t.Logf("PASS real Worker gateway 524 after actual WAV: unknown attempt and leases retained, retry denied, text/citations unchanged, real TTS=1, confirmed completion reconciled; task=%s", taskID)
}

func TestChatWorkerRealCrashUnknown(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 1})
	if before["holding"] != 0 {
		t.Fatal("another test owns the TTS timing gate")
	}
	t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
	chatID, sessionID, taskID := e.submitHeldVoice("Real Worker SIGKILL during TTS")
	e.waitRealAudioHeld(taskID, before)
	running := e.waitTaskBeforeHeldAudio(taskID)
	e.workerFault("crash")
	t.Cleanup(func() { e.workerFault("start") })
	e.workerFault("start")
	terminal := e.waitTask(taskID)
	if terminal.Task.State != "partial_succeeded" || terminal.Task.ErrorCode != "executor_lost" ||
		terminal.Task.UpstreamStatus != "unknown" || len(terminal.RetryStages) != 0 ||
		terminal.Task.Calls != running.Task.Calls {
		t.Fatalf("crash must isolate unknown outcome without replay: %s/%s upstream=%s calls=%d retry=%v",
			terminal.Task.State, terminal.Task.ErrorCode, terminal.Task.UpstreamStatus, terminal.Task.Calls, terminal.RetryStages)
	}
	var leases int64
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", taskID).Count(&leases).Error; err != nil || leases == 0 {
		t.Fatal("lost executor released uncertain upstream capacity")
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
	answer := terminal.Task.Outputs["answer"].(map[string]any)
	found := false
	for _, message := range refreshed.Messages {
		if message["role"] == "assistant" && message["id"] == terminal.Task.TurnID {
			found = message["content"] == answer["content"] && message["reference"] != nil
		}
	}
	if !found {
		t.Fatal("real Worker crash lost committed text or citations")
	}
	after := e.faultControl(map[string]any{"release": true})
	if after["forwarded"] != before["forwarded"]+1 {
		t.Fatal("restarted Worker repeated chargeable TTS")
	}
	time.Sleep(3 * time.Second)
	var unchanged chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &unchanged)
	if unchanged.Task.Revision != terminal.Task.Revision || !reflect.DeepEqual(unchanged.Task.Outputs, terminal.Task.Outputs) {
		t.Fatal("late response or duplicate delivery changed the terminal task")
	}
	assertChatFaultNoMedia(t, db, taskID)
	if err := dao.NewChatTaskDAO(db).ReconcileStopped(t.Context(), taskID,
		fmt.Sprintf("real-forwarder-completed-%d-released-SIGKILL", after["completed"])); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", taskID).Count(&leases).Error; err != nil || leases != 0 {
		t.Fatal("confirmed stopped reconciliation did not release retained capacity")
	}
	t.Logf("PASS actual isolated Worker SIGKILL/restart, natural lease expiry, saved text/citations, unknown outcome isolated, no replay/late publication; task=%s real TTS=1", taskID)
}

func TestChatCancelDeleteRealLateAudio(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	for _, removeSession := range []bool{false, true} {
		t.Run(fmt.Sprintf("delete_session_%t", removeSession), func(t *testing.T) {
			e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
			before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 1})
			if before["holding"] != 0 {
				t.Fatal("another test owns the TTS timing gate")
			}
			t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
			chatID, sessionID, taskID := e.submitHeldVoice("Cancel with actual generated audio held")
			e.waitRealAudioHeld(taskID, before)
			if removeSession {
				e.request(http.MethodDelete, "/chats/"+chatID+"/sessions", map[string]any{"ids": []string{sessionID}}, nil)
			} else {
				e.request(http.MethodPost, "/chats/tasks/"+taskID+"/cancel", nil, nil)
			}
			deadline := time.Now().Add(45 * time.Second)
			var terminal entity.ChatTask
			for time.Now().Before(deadline) {
				details, err := dao.NewChatTaskDAO(db).Details(t.Context(), taskID)
				if err != nil {
					t.Fatal("cannot read task while waiting for cancellation")
				}
				terminal = *details.Task
				if terminal.State == "cancelled" {
					break
				}
				if dao.IsChatTaskTerminal(terminal.State) {
					t.Fatalf("task reached another terminal state before cancellation: %s",
						chatTaskSnapshotDiagnostic(db, details))
				}
				select {
				case <-t.Context().Done():
					t.Fatal("cancellation wait cancelled")
				case <-time.After(250 * time.Millisecond):
				}
			}
			if terminal.State != "cancelled" || terminal.UpstreamStatus != "unknown" {
				t.Fatalf("cancel/delete must isolate unreceived real result: %s/%s", terminal.State, terminal.UpstreamStatus)
			}
			var leases int64
			if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", taskID).Count(&leases).Error; err != nil || leases == 0 {
				t.Fatal("cancel released capacity before upstream completion receipt")
			}
			e.faultControl(map[string]any{"release": true})
			time.Sleep(3 * time.Second)
			var after entity.ChatTask
			if err := db.Take(&after, "id = ?", taskID).Error; err != nil {
				t.Fatal(err)
			}
			if after.Revision != terminal.Revision || !reflect.DeepEqual(after.Outputs, terminal.Outputs) {
				t.Fatal("late audio changed cancelled task outputs or revision")
			}
			assertChatFaultNoMedia(t, db, taskID)
			if removeSession {
				var sessions int64
				if err := db.Model(&entity.ChatSession{}).Where("id = ?", sessionID).Count(&sessions).Error; err != nil || sessions != 0 {
					t.Fatal("late audio resurrected deleted session")
				}
				var list struct {
					Tasks []entity.ChatTask `json:"tasks"`
					Total int64             `json:"total"`
				}
				e.request(http.MethodGet, "/chats/tasks?session_id="+sessionID+"&page=1&page_size=10", nil, &list)
				if list.Total != 0 || len(list.Tasks) != 0 {
					t.Fatal("deleted session remained in task-center count or rows")
				}
			}
			counts := e.faultControl(nil)
			if counts["forwarded"] != before["forwarded"]+1 || counts["completed"] != before["completed"]+1 || counts["holding"] != 0 {
				t.Fatal("cancel/delete repeated TTS or failed to release actual response")
			}
			if err := dao.NewChatTaskDAO(db).ReconcileStopped(t.Context(), taskID,
				fmt.Sprintf("real-forwarder-completed-%d-cancel-late", counts["completed"])); err != nil {
				t.Fatal(err)
			}
			t.Logf("PASS real generation -> cancel/delete -> late response: no publication/resurrection, upstream isolated until confirmed; task=%s real TTS=1", taskID)
		})
	}
}
