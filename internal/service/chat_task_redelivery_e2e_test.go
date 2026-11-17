//go:build e2e

package service

import (
	"net/http"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"ragflow/internal/entity"
)

func TestChatTaskRealCompletedRedelivery(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	endpoint := os.Getenv("RAGFLOW_TEST_CHAT_NATS")
	if endpoint != "nats://ragflow-chat-test-nats:4222" {
		t.Fatal("requires the disposable worker's actual NATS server")
	}
	connection, err := nats.Connect(endpoint)
	if err != nil {
		t.Fatal("cannot connect disposable NATS")
	}
	defer connection.Close()
	queue, err := jetstream.New(connection)
	if err != nil {
		t.Fatal(err)
	}
	const namespace, consumerName = "CHAT_RELIABILITY", "CHAT_RELIABILITY_WORKER"
	consumer, err := queue.Consumer(t.Context(), namespace, consumerName)
	if err != nil {
		t.Fatal("disposable chat worker consumer unavailable")
	}
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 1})
	if before["holding"] != 0 {
		t.Fatal("another test owns the TTS gate")
	}
	t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
	chatID, sessionID, taskID := e.submitHeldVoice("Real duplicate delivery at running and completed boundaries")
	e.waitRealAudioHeld(taskID, before)
	running := e.waitTaskBeforeHeldAudio(taskID)
	publish := func(count int) uint64 {
		t.Helper()
		var latest uint64
		for range count {
			receipt, err := queue.Publish(t.Context(), namespace+".ready", []byte(taskID))
			if err != nil {
				t.Fatal(err)
			}
			if receipt.Stream != namespace || receipt.Sequence <= latest {
				t.Fatal("duplicate task message was not durably published")
			}
			latest = receipt.Sequence
		}
		return latest
	}
	publish(3)
	e.faultControl(map[string]any{"release": true})
	completed := e.waitTask(taskID)
	if completed.Task.State != "succeeded" || completed.Task.Calls != running.Task.Calls ||
		len(completed.Attempts) != len(running.Attempts) {
		t.Fatalf("running delivery repeated a stage: %s calls=%d attempts=%d", completed.Task.State, completed.Task.Calls, len(completed.Attempts))
	}
	lastSequence := publish(5)
	acknowledged := false
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		info, err := consumer.Info(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if info.AckFloor.Stream >= lastSequence {
			acknowledged = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !acknowledged {
		t.Fatal("real Worker did not acknowledge all completed-task duplicate deliveries")
	}
	var unchanged chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+taskID, nil, &unchanged)
	if unchanged.Task.Revision != completed.Task.Revision || unchanged.Task.EventSeq != completed.Task.EventSeq ||
		!reflect.DeepEqual(unchanged.Task.Outputs, completed.Task.Outputs) ||
		!reflect.DeepEqual(unchanged.Attempts, completed.Attempts) {
		t.Fatal("acknowledged duplicate delivery changed completed state, events, attempts or outputs")
	}
	after := e.faultControl(nil)
	if after["forwarded"] != before["forwarded"]+1 || after["completed"] != before["completed"]+1 ||
		after["rejected"] != before["rejected"] {
		t.Fatal("duplicate queue delivery repeated real upstream synthesis")
	}
	var assets int64
	if err := db.Model(&entity.ChatMediaAsset{}).Where("task_id = ?", taskID).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatal("duplicate queue delivery inserted extra media assets")
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
	answers := 0
	for _, message := range refreshed.Messages {
		if message["role"] == "assistant" && message["id"] == completed.Task.TurnID {
			answers++
			media, _ := message["media_assets"].([]any)
			if len(media) != 1 || message["reference"] == nil {
				t.Fatal("refresh lost unique audio or citations")
			}
		}
	}
	if answers != 1 {
		t.Fatal("duplicate queue delivery duplicated the persisted answer")
	}
	t.Logf("PASS real NATS: 3 duplicate deliveries during TTS plus 5 after success acknowledged through stream seq=%d; unchanged revision/events/attempts; actual TTS=1, asset=1, answer=1; task=%s", lastSequence, taskID)
}
