//go:build e2e

package service

import (
	"bytes"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"ragflow/internal/entity"
)

func chatMediaE2E(t *testing.T) *chatVoiceE2E {
	t.Helper()
	origin := os.Getenv("RAGFLOW_TEST_CHAT_API")
	if origin == "" {
		t.Skip("requires disposable real chat/media services and indexed knowledge")
	}
	if origin != "http://ragflow-chat-test-api:19380" && origin != "http://ragflow-chat-test-planning-api:19380" {
		t.Fatal("refusing API outside disposable environment")
	}
	return &chatVoiceE2E{t: t, origin: origin, token: os.Getenv("RAGFLOW_TEST_CHAT_TOKEN"),
		client: &http.Client{Timeout: 2 * time.Minute}}
}

func (e *chatVoiceE2E) mediaControl(endpoint string, fail int) map[string]int {
	e.t.Helper()
	if endpoint != "http://host.docker.internal:19980/control" && endpoint != "http://host.docker.internal:19982/control" {
		e.t.Fatal("requires observable isolated media forwarder")
	}
	body, err := json.Marshal(map[string]int{"fail_next": fail})
	if err != nil {
		e.t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(e.t.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	response, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal("media forwarder unavailable")
	}
	defer response.Body.Close()
	var counts map[string]int
	if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&counts) != nil {
		e.t.Fatal("invalid media control response")
	}
	return counts
}

func (e *chatVoiceE2E) newMediaSession(name string) (string, string) {
	e.t.Helper()
	var chat struct {
		ID string `json:"id"`
	}
	e.request(http.MethodPost, "/chats", map[string]any{
		"name": name, "dataset_ids": []string{os.Getenv("RAGFLOW_TEST_CHAT_DATASET")},
		"llm_id": os.Getenv("RAGFLOW_TEST_CHAT_MODEL"), "llm_setting": map[string]any{"temperature": 0, "max_tokens": 1024},
		"prompt_config": map[string]any{"system": "请根据知识库回答，保留来源引用。{knowledge}",
			"parameters": []any{map[string]any{"key": "knowledge", "optional": false}}, "quote": true},
		"similarity_threshold": 0,
	}, &chat)
	var session ChatSessionPayload
	e.request(http.MethodPost, "/chats/"+chat.ID+"/sessions", map[string]any{"name": name}, &session)
	return chat.ID, session.ID
}

func TestChatCombinedRealLifecycle(t *testing.T) {
	t.Run("both_initial_failed", testChatCombinedBothFailed)
	for _, failed := range []string{"image", "audio"} {
		t.Run(failed+"_initial_failed", func(t *testing.T) {
			testChatCombinedOneFailed(t, failed)
		})
	}
}

func testChatCombinedBothFailed(t *testing.T) {
	e := chatMediaE2E(t)
	imageControl, ttsControl := os.Getenv("RAGFLOW_TEST_CHAT_IMAGE_CONTROL"), os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	imageBefore, ttsBefore := e.mediaControl(imageControl, 1), e.mediaControl(ttsControl, 1)
	chatID, sessionID := e.newMediaSession("Isolated combined branch recovery")
	var admission struct {
		TaskID string          `json:"task_id"`
		Task   entity.ChatTask `json:"task"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "image_voice", "stream": false,
		"question": "请根据知识库回答青禾项目的验收暗号和负责人，保留来源引用。同时画一幅青山与小河的插画，并为回答配音。",
	}, &admission)
	if admission.TaskID == "" {
		admission.TaskID = admission.Task.ID
	}
	if admission.TaskID == "" {
		t.Fatal("combined request was not admitted")
	}
	partial := e.waitTask(admission.TaskID)
	if partial.Task.State != "partial_succeeded" || !reflect.DeepEqual(partial.RetryStages, []string{"image", "audio"}) {
		t.Fatalf("both media failures lost partial/retry contract: %s %s %v",
			partial.Task.State, partial.Task.ErrorCode, partial.RetryStages)
	}
	answer, ok := partial.Task.Outputs["answer"].(map[string]any)
	if !ok {
		t.Fatal("combined task did not save first text")
	}
	text, _ := answer["content"].(string)
	ref, _ := answer["reference"].(map[string]any)
	chunks, _ := ref["chunks"].([]any)
	if !strings.Contains(text, "山海同行") || !strings.Contains(text, "林悦") || len(chunks) == 0 {
		t.Fatalf("ungrounded combined answer: %q citations=%d", text, len(chunks))
	}
	for _, key := range []string{"prompt", "usage", "elapsed_ms", "output_revision", "answer_version"} {
		if answer[key] == nil {
			t.Fatalf("first text commit omitted %s", key)
		}
	}
	reload := func(expectedAssets int) []any {
		t.Helper()
		var session ChatSessionPayload
		e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true&include_prompt=true", nil, &session)
		for _, msg := range session.Messages {
			if msg["role"] != "assistant" || msg["id"] != partial.Task.TurnID {
				continue
			}
			content, _ := msg["content"].(string)
			savedRef, _ := msg["reference"].(map[string]any)
			savedChunks, _ := savedRef["chunks"].([]any)
			if !strings.HasPrefix(content, text) || len(savedChunks) != len(chunks) || msg["output_revision"] == nil || msg["answer_version"] == nil {
				t.Fatal("refresh lost first text, citations or revision")
			}
			assets, _ := msg["media_assets"].([]any)
			if len(assets) != expectedAssets {
				t.Fatalf("refresh has %d assets, expected %d", len(assets), expectedAssets)
			}
			return assets
		}
		t.Fatal("refresh lost combined message")
		return nil
	}
	reload(0)
	imageAfterFailure, ttsAfterFailure := e.mediaControl(imageControl, 0), e.mediaControl(ttsControl, 0)
	if imageAfterFailure["rejected"]-imageBefore["rejected"] != 1 || ttsAfterFailure["rejected"]-ttsBefore["rejected"] != 1 ||
		imageAfterFailure["forwarded"] != imageBefore["forwarded"] || ttsAfterFailure["forwarded"] != ttsBefore["forwarded"] {
		t.Fatal("initial failure unexpectedly called a real media generator")
	}
	retry := func(source chatVoiceTaskDetail, stage, expectedState string) chatVoiceTaskDetail {
		t.Helper()
		var task entity.ChatTask
		e.request(http.MethodPost, "/chats/tasks/"+source.Task.ID+"/retry",
			map[string]any{"stage": stage, "revision": source.Task.Revision}, &task)
		result := e.waitTask(task.ID)
		if result.Task.State != expectedState {
			t.Fatalf("%s-only retry: %s %s, expected %s", stage, result.Task.State, result.Task.ErrorCode, expectedState)
		}
		for _, attempt := range result.Attempts {
			if attempt.Stage != stage {
				t.Fatalf("%s-only retry replayed %s", stage, attempt.Stage)
			}
		}
		return result
	}
	audioRetry := retry(partial, "audio", "partial_succeeded")
	if !reflect.DeepEqual(audioRetry.RetryStages, []string{"image"}) || audioRetry.Task.ErrorCode != "stage_incomplete" {
		t.Fatalf("remaining image is not retryable: %s %v", audioRetry.Task.ErrorCode, audioRetry.RetryStages)
	}
	audioAssets := reload(1)
	audioID := audioAssets[0].(map[string]any)["id"]
	imageRetry := retry(audioRetry, "image", "succeeded")
	assets := reload(2)
	audioPreserved := false
	for _, item := range assets {
		asset := item.(map[string]any)
		if asset["id"] == audioID {
			audioPreserved = true
		}
		url, _ := asset["url"].(string)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, e.origin+url, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", e.token)
		response, err := e.client.Do(req)
		if err != nil {
			t.Fatal("real media download failed")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, chatMediaMaxBytes+1))
		response.Body.Close()
		if readErr != nil || response.StatusCode != 200 || len(data) > chatMediaMaxBytes {
			t.Fatal("media download invalid")
		}
		if asset["kind"] == "audio" {
			if _, err := validateChatWAV(data); err != nil {
				t.Fatal(err)
			}
		} else if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
			t.Fatal("real generated image is not decodable")
		}
	}
	if !audioPreserved {
		t.Fatal("image retry replaced successful audio")
	}
	var original chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+partial.Task.ID, nil, &original)
	if original.Task.State != partial.Task.State || original.Task.Revision != partial.Task.Revision {
		t.Fatal("retry changed original terminal task")
	}
	imageCounts, ttsCounts := e.mediaControl(imageControl, 0), e.mediaControl(ttsControl, 0)
	if imageCounts["forwarded"]-imageBefore["forwarded"] != 1 || ttsCounts["forwarded"]-ttsBefore["forwarded"] != 1 {
		t.Fatal("branch retry repeated a successful upstream media call")
	}
	t.Logf("PASS combined both rejected -> text/citations refresh -> audio-only=%s -> image-only=%s; original=%s unchanged; real image=1 TTS=1; audio asset preserved=%v",
		audioRetry.Task.ID, imageRetry.Task.ID, partial.Task.ID, audioID)
}

func testChatCombinedOneFailed(t *testing.T, failed string) {
	e := chatMediaE2E(t)
	imageControl, ttsControl := os.Getenv("RAGFLOW_TEST_CHAT_IMAGE_CONTROL"), os.Getenv("RAGFLOW_TEST_CHAT_TTS_CONTROL")
	imageFailures, audioFailures := 0, 0
	successful := "audio"
	if failed == "image" {
		imageFailures = 1
	} else {
		audioFailures = 1
		successful = "image"
	}
	beforeImage, beforeAudio := e.mediaControl(imageControl, imageFailures), e.mediaControl(ttsControl, audioFailures)
	chatID, sessionID := e.newMediaSession("Real combined initial " + failed + " failure")
	var admission struct {
		TaskID string `json:"task_id"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "image_voice", "stream": false,
		"question": "根据知识库简短回答青禾项目的验收暗号和负责人，保留引用。同时画一幅青山与小河的插画，并为回答配音。",
	}, &admission)
	partial := e.waitTask(admission.TaskID)
	if partial.Task.State != "partial_succeeded" || !reflect.DeepEqual(partial.RetryStages, []string{failed}) ||
		partial.Task.Outputs[failed] != nil || partial.Task.Outputs[successful] == nil {
		t.Fatalf("initial branch results lost partial/retry semantics: %s/%s retry=%v",
			partial.Task.State, partial.Task.ErrorCode, partial.RetryStages)
	}
	answer := partial.Task.Outputs["answer"].(map[string]any)
	version, err := chatAnswerVersion(answer)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := answer["content"].(string)
	reference, _ := answer["reference"].(map[string]any)
	chunks, _ := reference["chunks"].([]any)
	if len(chunks) == 0 || !strings.Contains(content, "山海同行") || !strings.Contains(content, "林悦") {
		t.Fatal("initial successful branch lost grounded text or citations")
	}
	originalAssets := answer["media_assets"].([]any)
	if len(originalAssets) != 1 {
		t.Fatal("initial partial answer does not contain exactly its successful asset")
	}
	originalAsset := originalAssets[0].(map[string]any)
	if originalAsset["kind"] != successful {
		t.Fatal("initial answer exposed the wrong media branch")
	}
	checkRefresh := func(expectedVersion int64, expectedAssets int) {
		t.Helper()
		var session ChatSessionPayload
		e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &session)
		for _, message := range session.Messages {
			if message["role"] != "assistant" || message["id"] != partial.Task.TurnID {
				continue
			}
			actualVersion, err := chatAnswerVersion(message)
			if err != nil || *actualVersion != expectedVersion || !reflect.DeepEqual(message["reference"], reference) {
				t.Fatal("refresh lost the expected answer version or citations")
			}
			assets, _ := message["media_assets"].([]any)
			if len(assets) != expectedAssets {
				t.Fatalf("refresh assets=%d; want %d", len(assets), expectedAssets)
			}
			text := partial.Task.Outputs["text"].(map[string]any)
			expectedContent := stringValue(text["answer"])
			preserved := false
			for _, item := range assets {
				asset := item.(map[string]any)
				if asset["id"] == originalAsset["id"] {
					preserved = reflect.DeepEqual(asset, originalAsset)
				}
				url, _ := asset["url"].(string)
				label := "[语音]"
				if asset["kind"] == "image" {
					label = "![生成的图片]"
				}
				expectedContent = strings.TrimSpace(expectedContent + "\n\n" + label + "(" + url + ")")
				request, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, e.origin+url, nil)
				request.Header.Set("Authorization", e.token)
				response, err := e.client.Do(request)
				if err != nil {
					t.Fatal("real combined media download failed")
				}
				data, readErr := io.ReadAll(io.LimitReader(response.Body, chatMediaMaxBytes+1))
				response.Body.Close()
				if readErr != nil || response.StatusCode != 200 || len(data) > chatMediaMaxBytes {
					t.Fatal("real combined media is not readable")
				}
				if asset["kind"] == "audio" {
					if _, err := validateChatWAV(data); err != nil {
						t.Fatal(err)
					}
				} else if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
					t.Fatal("real combined image is not decodable")
				}
			}
			if !preserved {
				t.Fatal("failed-branch retry changed the successful asset")
			}
			if message["content"] != expectedContent {
				t.Fatal("refresh changed grounded text or omitted a media link")
			}
			return
		}
		t.Fatal("refresh lost the combined answer")
	}
	checkRefresh(*version, 1)
	var retry entity.ChatTask
	e.request(http.MethodPost, "/chats/tasks/"+partial.Task.ID+"/retry",
		map[string]any{"stage": failed, "revision": partial.Task.Revision}, &retry)
	completed := e.waitTask(retry.ID)
	if completed.Task.State != "succeeded" || completed.Task.RetryOf != partial.Task.ID || len(completed.Attempts) != 1 ||
		completed.Attempts[0].Stage != failed || len(completed.RetryStages) != 0 {
		t.Fatalf("failed branch retry repeated other stages: %s/%s attempts=%d",
			completed.Task.State, completed.Task.ErrorCode, len(completed.Attempts))
	}
	checkRefresh(*version+1, 2)
	var original chatVoiceTaskDetail
	e.request(http.MethodGet, "/chats/tasks/"+partial.Task.ID, nil, &original)
	if original.Task.State != partial.Task.State || original.Task.Revision != partial.Task.Revision ||
		!reflect.DeepEqual(original.Task.Outputs, partial.Task.Outputs) {
		t.Fatal("retry mutated the original terminal task or its saved outputs")
	}
	afterImage, afterAudio := e.mediaControl(imageControl, 0), e.mediaControl(ttsControl, 0)
	if afterImage["forwarded"] != beforeImage["forwarded"]+1 || afterAudio["forwarded"] != beforeAudio["forwarded"]+1 ||
		afterImage["rejected"] != beforeImage["rejected"]+imageFailures || afterAudio["rejected"] != beforeAudio["rejected"]+audioFailures {
		t.Fatal("retry regenerated the successful branch")
	}
	t.Logf("PASS first %s success/%s failure -> refresh and download -> retry only %s -> succeeded; answer version %d->%d, successful asset preserved, real image=1 TTS=1",
		successful, failed, failed, *version, *version+1)
}
