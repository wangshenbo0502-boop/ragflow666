//go:build e2e

package service

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

func TestChatTaskRealWorkerDiagnosticLogs(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	store := chatPersistenceStore(t)
	var original entity.TenantModel
	var instance entity.TenantModelInstance
	if db.Take(&original, "id = ?", os.Getenv("RAGFLOW_TEST_CHAT_PREFERRED")).Error != nil ||
		db.Take(&instance, "id = ?", original.InstanceID).Error != nil {
		t.Fatal("requires an explicitly selected isolated preferred model")
	}
	fixtureChatID, fixtureSessionID := e.newMediaSession("Real operational log fixture")
	var fixtureChat entity.Chat
	if db.Take(&fixtureChat, "id = ?", fixtureChatID).Error != nil || fixtureChat.TenantID == "" {
		t.Fatal("cannot resolve the test-owned chat tenant")
	}
	id := common.GenerateToken()
	asset := entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: fixtureChat.TenantID, SessionID: fixtureSessionID, TurnID: id,
		Kind: "audio", State: "deleting", Bucket: chatMediaBucket, ObjectKey: id + "/statistics.wav",
		CreatedAt: time.Now().Add(-2 * time.Hour).UnixMilli()}
	record := entity.ChatMediaCleanup{ID: id, AssetID: id, Bucket: asset.Bucket, ObjectKey: asset.ObjectKey,
		StoreScope: asset.Bucket, State: "retry", Attempts: 1, LastError: "storage_remove_failed",
		CreatedAt: asset.CreatedAt, NextRunAt: time.Now().Add(time.Hour).UnixMilli()}
	if db.Create(&asset).Error != nil {
		t.Fatal("cannot create test-owned real cleanup asset")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 15*time.Second)
		defer cancel()
		if store.Remove(ctx, asset.Bucket, asset.ObjectKey) != nil ||
			db.WithContext(ctx).Model(&asset).Update("state", "deleted").Error != nil ||
			db.WithContext(ctx).Model(&record).Updates(map[string]any{"state": "done", "last_error": ""}).Error != nil {
			t.Error("cannot settle test-owned real cleanup backlog")
		}
	})
	if db.Create(&record).Error != nil ||
		store.Put(t.Context(), asset.Bucket, asset.ObjectKey, []byte("owned-log-fixture")) != nil {
		t.Fatal("cannot create test-owned real cleanup backlog")
	}
	e.waitRolloutAPI(e.rolloutControl("prepare").Origin)
	deadline := time.Now().Add(time.Minute)
	for {
		available, err := dao.NewChatTaskDAO(db).WorkerAvailable(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if available {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("diagnostic Worker did not register a live heartbeat")
		}
		time.Sleep(200 * time.Millisecond)
	}
	before := e.faultControl(map[string]any{"fail_next": 1, "hold_next": 0})
	t.Cleanup(func() { e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0, "release": true}) })
	_, _, partialID := e.submitHeldVoice("Real partial task log attribution")
	partial := e.waitTask(partialID)
	if partial.Task.State != "partial_succeeded" || partial.Task.ErrorCode != "upstream_unavailable" ||
		partial.Diagnostics.FirstTextMs == nil || partial.Diagnostics.FirstAudioMs != nil ||
		!partial.Diagnostics.EventHistoryComplete {
		t.Fatal("real audio failure lost its usable text or diagnostic attribution")
	}
	chatID, sessionID := e.newMediaSession("Real failed task log attribution")
	contents := []byte("Test-owned evidence for a missing stored object.")
	missing := e.uploadFiles(chatUploadFile{name: "missing-log-evidence.txt", data: contents})
	bucket, key := stringValue(missing[0]["created_by"])+"-downloads", stringValue(missing[0]["id"])
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 15*time.Second)
		defer cancel()
		if err := store.Put(ctx, bucket, key, contents); err != nil {
			t.Error("cannot restore test-owned attachment")
		}
	})
	if err := store.Remove(t.Context(), bucket, key); err != nil {
		t.Fatal("cannot remove test-owned attachment")
	}
	failedID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "Read the attached text.", "files": missing,
	}, 1), true)
	failed := e.waitTask(failedID)
	if failed.Task.State != "failed" || failed.Task.ErrorCode != "attachment_unavailable" ||
		failed.Task.Calls != 0 || len(failed.Attempts) != 0 || !failed.Diagnostics.EventHistoryComplete {
		t.Fatal("missing attachment did not fail before upstream calls")
	}
	var rejected atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rejected.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":{"message":"isolated definite stopped failure","type":"server_error"}}`))
	}))
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal("cannot bind isolated upstream fault listener")
	}
	server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	var extra map[string]any
	if json.Unmarshal([]byte(instance.Extra), &extra) != nil {
		t.Fatal("invalid isolated model configuration")
	}
	extra["base_url"] = "http://ragflow-v1-builder:" + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port) + "/v1"
	raw, err := json.Marshal(extra)
	if err != nil {
		t.Fatal("cannot encode isolated fault model")
	}
	instance.ID, instance.InstanceName = common.GenerateToken(), "log-fault-"+common.GenerateToken()[:8]
	instance.Extra = string(raw)
	if db.Create(&instance).Error != nil {
		t.Fatal("cannot create isolated fault instance")
	}
	original.ID, original.InstanceID = common.GenerateToken(), instance.ID
	if db.Create(&original).Error != nil {
		t.Fatal("cannot create isolated fault model")
	}
	chatID, sessionID = e.newMediaSession("Real switched successful task log attribution")
	if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Updates(map[string]any{
		"tenant_llm_id": original.ID, "llm_id": original.ID,
		"kb_ids": entity.JSONSlice{},
		"prompt_config": entity.JSONMap{
			"system": "请用简短的中文回答。", "parameters": []any{}, "quote": false,
		},
	}).Error; err != nil {
		t.Fatal("cannot select the isolated fault model")
	}
	replayKey := "diagnostic-" + common.GenerateToken()
	switchedRequest := map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question":     "@语音 用一句简短的中文问候语回答。",
		"route_policy": "fallback", "allowed_models": []string{os.Getenv("RAGFLOW_TEST_CHAT_BACKUP")},
	}
	switchedID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", replayKey, switchedRequest, 1), true)
	switched := e.waitTask(switchedID)
	if switched.Task.State != "succeeded" || switched.Task.Switches != 1 || switched.Task.Calls != 3 ||
		rejected.Load() != 1 || switched.Diagnostics.SwitchedSucceeded != 1 ||
		switched.Diagnostics.SwitchReasons["service_unavailable"] != 1 ||
		!switched.Diagnostics.SwitchDetailsComplete || !switched.Diagnostics.EventHistoryComplete ||
		switched.Diagnostics.FirstTextMs == nil || switched.Diagnostics.FirstAudioMs == nil {
		t.Fatalf("real switched task attribution: state=%s code=%s calls=%d switches=%d rejected=%d",
			switched.Task.State, switched.Task.ErrorCode, switched.Task.Calls, switched.Task.Switches, rejected.Load())
	}
	language := switched.Diagnostics.Stages["language"]
	if language == nil || language.Attempts != 2 || language.Failed != 1 || language.Succeeded != 1 ||
		language.Usage["total_tokens"] <= 0 {
		t.Fatal("real backup model lost its persisted stage usage")
	}
	if len(switched.Attempts) != 3 ||
		switched.Attempts[0].Model != original.ID || switched.Attempts[1].Model != os.Getenv("RAGFLOW_TEST_CHAT_BACKUP") {
		t.Fatal("real backup model lost its persisted identity")
	}
	if replayID := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", replayKey, switchedRequest, 1), true); replayID != switchedID {
		t.Fatal("real diagnostic replay created another task")
	}
	expected := map[string]*entity.ChatTask{
		partialID: &partial.Task, failedID: &failed.Task, switchedID: &switched.Task,
	}
	for _, detail := range []chatVoiceTaskDetail{partial, failed, switched} {
		if detail.Diagnostics.ElapsedMs != detail.Task.FinishedAt-detail.Task.CreatedAt ||
			detail.Diagnostics.InitialQueueMs == nil || *detail.Diagnostics.InitialQueueMs < 0 ||
			len(detail.Attempts) != detail.Task.Calls {
			t.Fatal("real task timing or attempt count disagrees with its persisted records")
		}
		elapsed := map[string]int64{}
		for _, attempt := range detail.Attempts {
			if attempt.StartedAt <= 0 || attempt.FinishedAt < attempt.StartedAt {
				t.Fatal("real settled attempt has invalid timestamps")
			}
			elapsed[attempt.Stage] += attempt.FinishedAt - attempt.StartedAt
		}
		for stage, duration := range elapsed {
			diagnostic := detail.Diagnostics.Stages[stage]
			if diagnostic == nil || diagnostic.SettledElapsedMs != duration || diagnostic.Running != 0 ||
				diagnostic.RunningElapsedMs != 0 {
				t.Fatal("real stage duration disagrees with its persisted attempt timestamps")
			}
		}
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		claimed, finished := map[string]bool{}, map[string]bool{}
		inventory, backlog, replayed := false, false, false
		for _, entry := range e.rolloutControl("logs").Logs {
			if entry.Message == "chat task operational statistics" || entry.Message == "chat media cleanup backlog" {
				states, ok := entry.Fields["task_states"].(map[string]any)
				if !ok || len(states) != 7 {
					t.Fatal("real Worker omitted task states from operational logs")
				}
				for key, minimum := range map[string]int64{
					"observed_at": 1, "reclaimable_media": 1, "cleanup_retries": 1,
					"cleanup_pending": 1, "cleanup_oldest_ms": time.Hour.Milliseconds(),
				} {
					value, ok := entry.Fields[key].(float64)
					if !ok || value < float64(minimum) {
						t.Fatalf("real Worker operational field %s omitted the test-owned cleanup backlog", key)
					}
				}
				for _, state := range []string{"queued", "running", "cancel_requested", "succeeded", "partial_succeeded", "failed", "cancelled"} {
					value, ok := states[state].(float64)
					if !ok || value < 0 {
						t.Fatalf("real Worker operational state %s is absent or invalid", state)
					}
				}
				if entry.Fields["unknown_upstreams"] == nil || entry.Fields["unreferenced_media"] == nil {
					t.Fatal("real Worker omitted the test-owned cleanup backlog from operational logs")
				}
				inventory = inventory || entry.Message == "chat task operational statistics"
				backlog = backlog || entry.Message == "chat media cleanup backlog"
				continue
			}
			id := stringValue(entry.Fields["task_id"])
			task := expected[id]
			if task == nil {
				continue
			}
			if entry.Fields["turn_id"] != task.TurnID || entry.Fields["session_id"] != task.SessionID {
				t.Fatal("real Worker log lost task/turn/session correlation")
			}
			switch entry.Message {
			case "chat task replayed":
				replayed = replayed || id == switchedID
			case "chat task claimed":
				claimed[id] = true
			case "chat task finished":
				if entry.Fields["state"] != task.State || entry.Fields["error_code"] != task.ErrorCode ||
					entry.Fields["calls"] != float64(task.Calls) || entry.Fields["switches"] != float64(task.Switches) {
					t.Fatal("real terminal log disagrees with the persisted task")
				}
				finished[id] = true
			}
		}
		if len(claimed) == len(expected) && len(finished) == len(expected) && inventory && backlog && replayed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("real API/Worker did not emit correlated lifecycle, replay, inventory and backlog logs")
		}
		time.Sleep(100 * time.Millisecond)
	}
	counts := e.faultControl(nil)
	if counts["forwarded"] != before["forwarded"]+1 || counts["completed"] != before["completed"]+1 ||
		counts["rejected"] != before["rejected"]+1 {
		t.Fatal("diagnostic cases repeated synthesis or generated for the missing attachment")
	}
	t.Logf("PASS real API/Worker/MySQL/backup/TTS: failed=%s partial=%s switched_success=%s; persistent stage usage, model identities and sanitized correlated terminal logs",
		failedID, partialID, switchedID)
}
