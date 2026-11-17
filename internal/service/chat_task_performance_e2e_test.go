//go:build e2e

package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"ragflow/internal/entity"
)

func TestChatTaskRealFixedSampleRegression(t *testing.T) {
	e := chatMediaE2E(t)
	tts := e.faultControl(nil)
	imageEndpoint := os.Getenv("RAGFLOW_TEST_CHAT_IMAGE_CONTROL")
	if imageEndpoint != "http://host.docker.internal:19982/control" {
		t.Fatal("requires the disposable image forwarder")
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, imageEndpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := e.client.Do(request)
	if err != nil {
		t.Fatal("image forwarder is unavailable")
	}
	var images map[string]int
	decodeErr := json.NewDecoder(response.Body).Decode(&images)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || decodeErr != nil {
		t.Fatal("image forwarder returned invalid gate state")
	}
	if tts["fail_next"] != 0 || tts["holding"] != 0 || images["fail_next"] != 0 {
		t.Fatal("another test owns a media fault gate")
	}
	samples := []struct {
		mode, question string
		assets         int
	}{
		{"voice", "请根据知识库，用一句话回答青禾项目的验收暗号和负责人，保留引用并配音。", 1},
		{"image_voice", "根据知识库简短回答青禾项目的验收暗号和负责人，保留引用。同时画一幅青山与小河的插画，并为回答配音。", 2},
	}
	latencies := map[string]map[string][]int64{}
	states := map[string]int{}
	for round := 1; round <= 2; round++ {
		for _, sample := range samples {
			t.Run(fmt.Sprintf("round_%d/%s", round, sample.mode), func(t *testing.T) {
				e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
				chatID, sessionID := e.newMediaSession("Fixed regression " + sample.mode)
				var admission struct {
					Accepted bool            `json:"accepted"`
					TaskID   string          `json:"task_id"`
					Task     entity.ChatTask `json:"task"`
				}
				started := time.Now()
				e.request(http.MethodPost, "/chat/completions", map[string]any{
					"chat_id": chatID, "session_id": sessionID, "mode": sample.mode,
					"stream": false, "question": sample.question,
				}, &admission)
				firstStatus := time.Since(started).Milliseconds()
				if !admission.Accepted || admission.TaskID == "" || admission.Task.ID != admission.TaskID || admission.Task.State == "" {
					t.Fatal("real API did not return a persisted task status with its acceptance")
				}
				if firstStatus > 1000 {
					t.Errorf("acceptance status took %d ms, exceeding the 1000 ms target", firstStatus)
				}
				detail := e.waitTask(admission.TaskID)
				states[detail.Task.State]++
				if latencies[sample.mode] == nil {
					latencies[sample.mode] = map[string][]int64{}
				}
				measurements := latencies[sample.mode]
				measurements["first_status_ms"] = append(measurements["first_status_ms"], firstStatus)
				measurements["elapsed_ms"] = append(measurements["elapsed_ms"], detail.Diagnostics.ElapsedMs)
				for key, value := range map[string]*int64{
					"initial_queue_ms": detail.Diagnostics.InitialQueueMs,
					"first_text_ms":    detail.Diagnostics.FirstTextMs,
					"first_audio_ms":   detail.Diagnostics.FirstAudioMs,
				} {
					if value != nil {
						measurements[key] = append(measurements[key], *value)
					}
				}
				record := map[string]any{
					"round": round, "sample": sample.mode, "task_id": detail.Task.ID,
					"state": detail.Task.State, "error_code": detail.Task.ErrorCode,
					"first_status_ms": firstStatus, "first_status_scope": "HTTP acceptance response",
					"calls": detail.Task.Calls, "diagnostics": detail.Diagnostics,
				}
				raw, err := json.Marshal(record)
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("FIXED_SAMPLE %s", raw)
				if detail.Task.State != "succeeded" {
					t.Fatalf("fixed sample failed: %s/%s", detail.Task.State, detail.Task.ErrorCode)
				}
				if detail.Diagnostics.FirstTextMs == nil || detail.Diagnostics.FirstAudioMs == nil ||
					detail.Diagnostics.InitialQueueMs == nil || !detail.Diagnostics.EventHistoryComplete ||
					len(detail.Diagnostics.UnmeasuredPhases) != 0 || len(detail.Attempts) != detail.Task.Calls {
					t.Fatal("fixed sample omitted persisted timing, phases or model attempts")
				}
				var refreshed ChatSessionPayload
				e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
				for _, message := range refreshed.Messages {
					if message["role"] != "assistant" || message["id"] != detail.Task.TurnID {
						continue
					}
					content := stringValue(message["content"])
					ref, _ := message["reference"].(map[string]any)
					chunks, _ := ref["chunks"].([]any)
					assets, _ := message["media_assets"].([]any)
					version, err := chatAnswerVersion(message)
					if err != nil || version == nil || len(chunks) == 0 || len(assets) != sample.assets ||
						!strings.Contains(content, "山海同行") || !strings.Contains(content, "林悦") {
						t.Fatal("fixed sample refresh lost grounded text, citations, media or answer version")
					}
					return
				}
				t.Fatal("fixed sample disappeared after refresh")
			})
		}
	}
	percentile := func(values []int64, percent int) int64 {
		sorted := append([]int64(nil), values...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		return sorted[(len(sorted)*percent+99)/100-1]
	}
	distributions := map[string]any{}
	for sample, measurements := range latencies {
		distribution := map[string]any{}
		for name, values := range measurements {
			distribution[name] = map[string]any{
				"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95),
			}
		}
		distributions[sample] = distribution
	}
	raw, err := json.Marshal(map[string]any{
		"rounds": 2, "expected_samples": 2 * len(samples), "task_states": states,
		"latency_ms": distributions, "quantiles": "nearest rank; two observations per mode, descriptive only",
		"quality_review": "manual image, speech and singing quality remains separate",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("FIXED_SAMPLE_SUMMARY %s", raw)
}
