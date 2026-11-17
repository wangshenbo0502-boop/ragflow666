//go:build e2e

package service

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"ragflow/internal/entity"
)

func TestChatRouteRealCapabilityBoundaries(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	var capabilities struct {
		Routes map[string]struct {
			Policies       []string `json:"policies"`
			Candidates     []string `json:"candidates"`
			DisabledReason string   `json:"fallback_disabled_reason"`
			StrictCost     bool     `json:"strict_cost_supported"`
			CostKnown      bool     `json:"cost_known"`
			Voice          string   `json:"fixed_voice"`
		} `json:"model_routes"`
	}
	e.request(http.MethodGet, "/chats/capabilities", nil, &capabilities)
	for _, kind := range []string{"image", "voice", "music"} {
		route, ok := capabilities.Routes[kind]
		if !ok || !reflect.DeepEqual(route.Policies, []string{"fixed"}) ||
			len(route.Candidates) != 1 || route.DisabledReason != "no_qualified_candidate" ||
			route.StrictCost || route.CostKnown || kind != "image" && route.Voice != chatVoiceName {
			t.Fatalf("%s capability response misrepresents fixed media support", kind)
		}
	}
	ttsBefore := e.faultControl(nil)
	imageControl := os.Getenv("RAGFLOW_TEST_CHAT_IMAGE_CONTROL")
	imageBefore := e.mediaControl(imageControl, 0)
	t.Run("image_input_requires_qualified_vision", func(t *testing.T) {
		e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 64, 64))); err != nil {
			t.Fatal(err)
		}
		descriptors := e.uploadFiles(chatUploadFile{name: "vision-boundary.png", data: encoded.Bytes()})
		for _, policy := range []string{"fixed", "fallback", "auto"} {
			t.Run(policy, func(t *testing.T) {
				e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
				chatID, sessionID := e.newMediaSession("Real image input route boundary " + policy)
				var chat entity.Chat
				var model entity.TenantModel
				if db.Take(&chat, "id = ?", chatID).Error != nil || chat.TenantLLMID == nil ||
					db.Take(&model, "id = ?", *chat.TenantLLMID).Error != nil ||
					model.ModelType&int(entity.ModelTypeImage2Text) != 0 {
					t.Fatal("this boundary requires a real text-only preferred model")
				}
				id := requireChatConcurrentIdentity(t, e.concurrentRequests("/chat/completions", "", map[string]any{
					"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
					"question": "Describe the attached image exactly.", "files": descriptors,
					"route_policy": policy, "allowed_models": []string{},
				}, 1), true)
				result := e.waitTask(id)
				if result.Task.State != "failed" || result.Task.ErrorCode != "unsupported_capability" ||
					result.Task.Calls != 0 || len(result.Attempts) != 0 || result.Task.Outputs["answer"] != nil ||
					len(result.RetryStages) != 0 {
					t.Fatalf("unqualified vision continued: %s/%s calls=%d attempts=%d",
						result.Task.State, result.Task.ErrorCode, result.Task.Calls, len(result.Attempts))
				}
				var saved entity.ChatTask
				var input chatTaskInput
				if db.Take(&saved, "id = ?", id).Error != nil || json.Unmarshal([]byte(saved.Input), &input) != nil {
					t.Fatal("cannot read actual frozen route input")
				}
				raw, _ := json.Marshal(input.Options["allowed_models"])
				if string(raw) != "[]" || input.Options["route_policy"] != policy {
					t.Fatal("route widened the client's explicit empty candidate scope")
				}
			})
		}
	})
	t.Run("fixed_media_has_no_qualified_fallback_or_price", func(t *testing.T) {
		e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
		for _, mode := range []string{"voice", "image", "music", "image_voice"} {
			for _, policy := range []string{"auto", "fallback", "strict_cost"} {
				t.Run(mode+"_"+policy, func(t *testing.T) {
					e := &chatVoiceE2E{t: t, origin: e.origin, token: e.token, client: e.client}
					chatID, sessionID := e.newMediaSession("Real media admission boundary " + mode + " " + policy)
					body := map[string]any{"chat_id": chatID, "session_id": sessionID,
						"mode": mode, "stream": false, "question": "Create media for a quiet river."}
					code := "unsupported_capability"
					if policy == "strict_cost" {
						body["cost_limit_micros"] = 100
						code = "budget_exceeded"
					} else {
						body["media_route_policy"] = policy
					}
					raw, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					request, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
						e.origin+"/api/v1/chat/completions", bytes.NewReader(raw))
					if err != nil {
						t.Fatal(err)
					}
					request.Header.Set("Authorization", e.token)
					request.Header.Set("Content-Type", "application/json")
					response, err := e.client.Do(request)
					if err != nil {
						t.Fatal("real admission request failed")
					}
					defer response.Body.Close()
					var envelope struct {
						Code    int    `json:"code"`
						Message string `json:"message"`
					}
					if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope) != nil ||
						envelope.Code == 0 || !strings.HasPrefix(envelope.Message, code+":") {
						t.Fatalf("media admission did not return %s: HTTP=%d code=%d",
							code, response.StatusCode, envelope.Code)
					}
					var count int64
					if err := db.Model(&entity.ChatTask{}).Where("session_id = ?", sessionID).Count(&count).Error; err != nil || count != 0 {
						t.Fatal("unsupported media policy or unknown price created a task")
					}
				})
			}
		}
	})
	ttsAfter, imageAfter := e.faultControl(nil), e.mediaControl(imageControl, 0)
	for _, key := range []string{"forwarded", "rejected"} {
		if ttsAfter[key] != ttsBefore[key] || imageAfter[key] != imageBefore[key] {
			t.Fatal("capability or price rejection made an upstream media request")
		}
	}
	t.Log("PASS real API: fixed media candidates and fixed voice are explicit; text-only image input fails before calls under all policies; empty allowed scope stays frozen; media fallback and unknown strict price reject before task admission")
}
