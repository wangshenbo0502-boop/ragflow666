//go:build e2e

package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

type chatRolloutStatus struct {
	Origin   string `json:"origin"`
	Received bool   `json:"received"`
	Stopped  bool   `json:"stopped"`
	ExitCode int    `json:"exit_code"`
	Logs     []struct {
		Message string         `json:"message"`
		Fields  map[string]any `json:"fields"`
	} `json:"logs"`
}

func (e *chatVoiceE2E) rolloutControl(action string) chatRolloutStatus {
	e.t.Helper()
	if os.Getenv("RAGFLOW_TEST_CHAT_ROLLOUT_CONTROL") != "http://host.docker.internal:19984" {
		e.t.Fatal("requires the disposable rollout controller")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(e.t.Context()), time.Minute)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://host.docker.internal:19984/"+action, nil)
	response, err := e.client.Do(request)
	if err != nil {
		e.t.Fatal("disposable rollout control unavailable")
	}
	defer response.Body.Close()
	var result chatRolloutStatus
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil {
		e.t.Fatalf("disposable rollout %s failed: HTTP %d", action, response.StatusCode)
	}
	return result
}

func (e *chatVoiceE2E) waitRolloutAPI(origin string) {
	e.t.Helper()
	if origin != "http://ragflow-chat-test-rollout-api:19380" &&
		origin != "http://ragflow-chat-test-log-api:19380" &&
		origin != "http://ragflow-chat-test-rollback-api:19380" {
		e.t.Fatal("rollout API outside the disposable environment")
	}
	e.origin = origin
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(e.t.Context(), 2*time.Second)
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/v1/users/me", nil)
		request.Header.Set("Authorization", e.token)
		response, err := e.client.Do(request)
		ready := false
		if err == nil {
			var envelope struct {
				Code int `json:"code"`
			}
			ready = response.StatusCode == http.StatusOK &&
				json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope) == nil && envelope.Code == 0
			response.Body.Close()
		}
		cancel()
		if ready {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	e.t.Fatal("rollout API did not become ready with the current identity")
}

func TestChatTaskRealDrainAndRollback(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if before["holding"] != 0 {
		t.Fatal("another test owns the TTS gate")
	}
	t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
	e.waitRolloutAPI(e.rolloutControl("prepare").Origin)
	waitWorker := func() {
		t.Helper()
		deadline := time.Now().Add(time.Minute)
		for time.Now().Before(deadline) {
			available, err := dao.NewChatTaskDAO(db).WorkerAvailable(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if available {
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("rollout Worker did not register a live heartbeat")
	}
	waitWorker()
	e.faultControl(map[string]any{"hold_next": 1})
	chatID, sessionID := e.newMediaSession("Real drain and rollback with preserved citations")
	key := "rollout-" + common.GenerateToken()
	body := map[string]any{"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "@语音 根据资料简短回答青禾项目的验收暗号和负责人，保留引用。"}
	taskID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 1), true)
	e.waitRealAudioHeld(taskID, before)
	running := e.waitTaskBeforeHeldAudio(taskID)
	e.rolloutControl("drain")
	deadline := time.Now().Add(10 * time.Second)
	received := false
	for time.Now().Before(deadline) {
		status := e.rolloutControl("drain_status")
		if status.Stopped {
			t.Fatal("Worker exited before its real upstream response was released")
		}
		if status.Received {
			received = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !received {
		t.Fatal("actual Worker did not observe SIGTERM")
	}
	e.faultControl(map[string]any{"release": true})
	completed := e.waitTask(taskID)
	if completed.Task.State != "succeeded" || completed.Task.Calls != running.Task.Calls ||
		completed.Task.UpstreamStatus != "stopped" {
		t.Fatal("graceful drain cancelled or replayed the real in-flight generation")
	}
	deadline = time.Now().Add(40 * time.Second)
	stopped := false
	for time.Now().Before(deadline) {
		status := e.rolloutControl("drain_status")
		if status.Stopped {
			if status.ExitCode != 0 {
				t.Fatalf("graceful Worker exit code=%d", status.ExitCode)
			}
			stopped = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !stopped {
		t.Fatal("drained Worker did not exit within its configured deadline")
	}
	var heartbeats int64
	if err := db.Model(&entity.ChatTaskWorker{}).Where("id = ?", running.Task.LeaseOwner).
		Count(&heartbeats).Error; err != nil || heartbeats != 0 {
		t.Fatal("drained Worker retained its heartbeat")
	}
	if available, err := dao.NewChatTaskDAO(db).WorkerAvailable(t.Context()); err != nil || available {
		t.Fatal("stopped rollout still advertises an available Worker")
	}
	var frozen entity.ChatTask
	if err := db.Take(&frozen, "id = ?", taskID).Error; err != nil || frozen.Input == "" {
		t.Fatal("drained task lost its frozen snapshot")
	}
	var asset entity.ChatMediaAsset
	if err := db.Take(&asset, "task_id = ? AND state = ?", taskID, "committed").Error; err != nil {
		t.Fatal("drain did not commit the generated audio")
	}
	var expectedAudio [32]byte
	checkOriginal := func(first bool) {
		t.Helper()
		if replayID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", key, body, 1), true); replayID != taskID {
			t.Fatal("version change or Worker pause generated a new task")
		}
		var actual entity.ChatTask
		if err := db.Take(&actual, "id = ?", taskID).Error; err != nil || actual.Input != frozen.Input ||
			actual.InputHash != frozen.InputHash || actual.Revision != frozen.Revision ||
			actual.EventSeq != frozen.EventSeq || !reflect.DeepEqual(actual.Outputs, frozen.Outputs) {
			t.Fatal("version change modified the frozen input or completed task")
		}
		var detail chatVoiceTaskDetail
		e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &detail)
		if !reflect.DeepEqual(detail.Attempts, completed.Attempts) || detail.Task.Revision != completed.Task.Revision {
			t.Fatal("version change lost persisted attempts or task revision")
		}
		var session ChatSessionPayload
		e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &session)
		found := false
		for _, message := range session.Messages {
			if message["role"] != "assistant" || message["id"] != completed.Task.TurnID {
				continue
			}
			answer := completed.Task.Outputs["answer"].(map[string]any)
			media, _ := message["media_assets"].([]any)
			if len(media) != 1 || media[0].(map[string]any)["id"] != asset.ID ||
				!reflect.DeepEqual(message["reference"], answer["reference"]) ||
				message["answer_version"] != answer["answer_version"] ||
				!strings.Contains(stringValue(message["content"]), "山海同行") {
				t.Fatal("version change lost audio identity, citations, answer version or grounded text")
			}
			request, _ := http.NewRequestWithContext(t.Context(), http.MethodGet,
				e.origin+stringValue(media[0].(map[string]any)["url"]), nil)
			request.Header.Set("Authorization", e.token)
			response, err := e.client.Do(request)
			if err != nil {
				t.Fatal("version change made persisted audio unreadable")
			}
			audio, readErr := io.ReadAll(io.LimitReader(response.Body, chatMediaMaxBytes+1))
			response.Body.Close()
			duration, wavErr := validateChatWAV(audio)
			if response.StatusCode != 200 || readErr != nil || wavErr != nil || duration != asset.DurationMs {
				t.Fatal("version change corrupted the persisted playable audio")
			}
			hash := sha256.Sum256(audio)
			if first {
				expectedAudio = hash
			} else if hash != expectedAudio {
				t.Fatal("version change modified the audio bytes")
			}
			found = true
		}
		if !found {
			t.Fatal("version change lost the saved answer")
		}
	}
	checkOriginal(true)
	newBody := map[string]any{"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "@语音 请根据资料回答试运行日期。"}
	result := e.concurrentRequests("/chat/completions", "offline-"+key, newBody, 1)[0]
	if result.err != nil || result.code != 500 || result.status != http.StatusInternalServerError ||
		result.reason != "queue_unavailable" {
		t.Fatalf("offline Worker admission did not return queue_unavailable: HTTP=%d code=%d reason=%s err=%v",
			result.status, result.code, result.reason, result.err)
	}
	var taskCount int64
	if err := db.Model(&entity.ChatTask{}).Where("session_id = ?", sessionID).Count(&taskCount).Error; err != nil || taskCount != 1 {
		t.Fatal("offline admission created an extra task")
	}
	if counts := e.faultControl(nil); counts["forwarded"] != before["forwarded"]+1 ||
		counts["completed"] != before["completed"]+1 || counts["rejected"] != before["rejected"] {
		t.Fatal("offline replay or rejected admission started another real synthesis")
	}
	checkLogs := func() {
		t.Helper()
		status := e.rolloutControl("logs")
		claimed, finished := false, false
		for _, entry := range status.Logs {
			if entry.Fields["task_id"] != taskID {
				continue
			}
			if entry.Fields["turn_id"] != completed.Task.TurnID || entry.Fields["session_id"] != sessionID {
				t.Fatal("real task logs lost correlation fields")
			}
			switch entry.Message {
			case "chat task claimed":
				claimed = true
			case "chat task finished":
				finished = entry.Fields["state"] == "succeeded" && entry.Fields["calls"] == float64(completed.Task.Calls)
			}
		}
		if !claimed || !finished {
			t.Fatal("real Worker did not emit correlated claim and terminal logs")
		}
	}
	checkLogs()
	e.waitRolloutAPI(e.rolloutControl("rollback").Origin)
	waitWorker()
	checkOriginal(false)
	_, _, previousID := e.submitHeldVoice("Actual generation on previous binary after rollback")
	previous := e.waitTask(previousID)
	if previous.Task.State != "succeeded" {
		t.Fatalf("previous binary cannot generate with current persisted data: %s/%s", previous.Task.State, previous.Task.ErrorCode)
	}
	e.waitRolloutAPI(e.rolloutControl("restore").Origin)
	waitWorker()
	checkOriginal(false)
	var previousRestored chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+previousID, nil, &previousRestored)
	if previousRestored.Task.Revision != previous.Task.Revision ||
		!reflect.DeepEqual(previousRestored.Task.Outputs, previous.Task.Outputs) {
		t.Fatal("restoring current binary changed output generated by previous binary")
	}
	_, _, restoredID := e.submitHeldVoice("Actual generation after restoring current binary")
	restored := e.waitTask(restoredID)
	if restored.Task.State != "succeeded" || !restored.Diagnostics.EventHistoryComplete {
		t.Fatal("restored current binary cannot execute and describe a new task")
	}
	counts := e.faultControl(nil)
	if counts["forwarded"] != before["forwarded"]+3 || counts["completed"] != before["completed"]+3 ||
		counts["rejected"] != before["rejected"] || counts["holding"] != 0 {
		t.Fatal("drain/rollback/restore replayed a real synthesis call")
	}
	checkLogs()
	t.Logf("PASS actual SIGTERM drain/exit0/heartbeat removal, offline replay and new-admission rejection, previous/current binary generation and unchanged answer/asset/audio SHA256; real TTS=3; original=%s previous=%s restored=%s",
		taskID, previousID, restoredID)
}
