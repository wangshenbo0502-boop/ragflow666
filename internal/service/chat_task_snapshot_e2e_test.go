//go:build e2e

package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
)

func holdChatUserCapacity(t *testing.T, db *gorm.DB, userID string) func() {
	t.Helper()
	resourceID := "chat:user:" + userID
	holders := []string{}
	err := db.WithContext(t.Context()).Transaction(func(tx *gorm.DB) error {
		var resource entity.ChatTaskResource
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&resource, "id = ?", resourceID).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&entity.ChatTaskResourceLease{}).Where("resource_id = ?", resourceID).Count(&count).Error; err != nil {
			return err
		}
		if resource.Capacity < 1 || count >= int64(resource.Capacity) {
			return fmt.Errorf("disposable user capacity has no free slots: holders=%d capacity=%d", count, resource.Capacity)
		}
		for range resource.Capacity - int(count) {
			id := common.GenerateToken()
			holders = append(holders, id)
			if err := tx.Create(&entity.ChatTaskResourceLease{
				ResourceID: resourceID, TaskID: id, LeaseEpoch: 1, CreatedAt: time.Now().UnixMilli(),
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := db.Where("resource_id = ? AND task_id IN ?", resourceID, holders).
				Delete(&entity.ChatTaskResourceLease{}).Error; err != nil {
				t.Error(err)
			}
		})
	}
	t.Cleanup(release)
	return release
}

func waitChatDatabaseTask(t *testing.T, db *gorm.DB, id string, ready func(entity.ChatTask) bool) entity.ChatTask {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	var task entity.ChatTask
	for time.Now().Before(deadline) {
		details, err := dao.NewChatTaskDAO(db).Details(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		task = *details.Task
		if ready(task) {
			return task
		}
		if dao.IsChatTaskTerminal(task.State) {
			t.Fatalf("task reached terminal state before expected boundary: %s",
				chatTaskSnapshotDiagnostic(db, details))
		}
		select {
		case <-t.Context().Done():
			t.Fatal("task wait cancelled")
		case <-time.After(100 * time.Millisecond):
		}
	}
	details, err := dao.NewChatTaskDAO(db).Details(t.Context(), id)
	if err == nil {
		t.Fatalf("task boundary not reached: %s", chatTaskSnapshotDiagnostic(db, details))
	}
	t.Fatalf("task boundary not reached: task_id=%s state=%s stage=%s error_code=%s upstream_status=%s calls=%d",
		task.ID, task.State, task.Stage, task.ErrorCode, task.UpstreamStatus, task.Calls)
	return task
}

func chatTaskSnapshotDiagnostic(db *gorm.DB, details *dao.ChatTaskDetails) string {
	task := details.Task
	type attempt struct {
		Stage  string `json:"stage"`
		State  string `json:"state"`
		Model  string `json:"model_id"`
		Reason string `json:"route_reason,omitempty"`
	}
	attempts := make([]attempt, 0, len(details.Attempts))
	for start := max(0, len(details.Attempts)-5); start < len(details.Attempts); start++ {
		row := details.Attempts[start]
		attempts = append(attempts, attempt{
			Stage: row.Stage, State: row.State, Model: row.Model,
			Reason: row.Reason,
		})
	}
	var recentEvents []entity.ChatTaskEvent
	_ = db.Where("task_id = ?", task.ID).Order("seq DESC").Limit(8).Find(&recentEvents).Error
	events := make([]map[string]interface{}, 0, len(recentEvents))
	for index := len(recentEvents) - 1; index >= 0; index-- {
		event := recentEvents[index]
		safe := map[string]interface{}{"seq": event.Seq, "type": event.Type}
		for _, key := range []string{"state", "stage", "error_code", "upstream_status", "diagnostic_cause",
			"error_type", "reason", "attempt_id", "kind"} {
			if value, ok := event.Data[key]; ok {
				safe[key] = value
			}
		}
		events = append(events, safe)
	}
	var input chatTaskInput
	var routing map[string]interface{}
	if json.Unmarshal([]byte(task.Input), &input) == nil {
		modelID := input.Chat.LLMID
		routePolicy := stringValue(input.Options["route_policy"])
		if routePolicy == "" {
			routePolicy = "fixed"
		}
		if input.Chat.TenantLLMID != nil {
			routing = map[string]interface{}{
				"tenant_id": input.Chat.TenantID, "tenant_model_id": *input.Chat.TenantLLMID,
				"model_id": modelID, "route_policy": routePolicy,
			}
		} else {
			routing = map[string]interface{}{
				"tenant_id": input.Chat.TenantID, "model_id": modelID,
				"route_policy": routePolicy,
			}
		}
	}
	summary := map[string]interface{}{
		"task_id": task.ID, "state": task.State, "stage": task.Stage, "error_code": task.ErrorCode,
		"upstream_status": task.UpstreamStatus, "calls": task.Calls, "attempts": attempts,
		"events": events, "routing": routing,
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		return `{"diagnostic":"serialization_failed"}`
	}
	return string(raw)
}

func cloneChatSnapshotModel(t *testing.T, db *gorm.DB, chat *entity.Chat) (string, string) {
	t.Helper()
	var model entity.TenantModel
	if err := db.Take(&model, "id = ?", *chat.TenantLLMID).Error; err != nil {
		t.Fatal("cannot resolve source model")
	}
	var instance entity.TenantModelInstance
	if err := db.Take(&instance, "id = ?", model.InstanceID).Error; err != nil {
		t.Fatal("cannot resolve source instance")
	}
	sourceLLMID, sourceTenantLLMID := chat.LLMID, *chat.TenantLLMID
	instance.ID, instance.InstanceName = common.GenerateToken(), "snapshot-"+common.GenerateToken()
	instance.BaseModel = entity.BaseModel{}
	model.ID, model.InstanceID = common.GenerateToken(), instance.ID
	model.BaseModel = entity.BaseModel{}
	if err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&instance).Error; err != nil {
			return err
		}
		if err := tx.Create(&model).Error; err != nil {
			return err
		}
		return tx.Model(&entity.Chat{}).Where("id = ?", chat.ID).
			Updates(map[string]any{"llm_id": model.ID, "tenant_llm_id": model.ID}).Error
	}); err != nil {
		t.Fatal("cannot create test-owned model configuration")
	}
	t.Cleanup(func() {
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&entity.Chat{}).Where("id = ?", chat.ID).
				Updates(map[string]any{"llm_id": sourceLLMID, "tenant_llm_id": sourceTenantLLMID}).Error; err != nil {
				return err
			}
			if err := tx.Where("id = ?", model.ID).Delete(&entity.TenantModel{}).Error; err != nil {
				return err
			}
			return tx.Where("id = ?", instance.ID).Delete(&entity.TenantModelInstance{}).Error
		}); err != nil {
			t.Error("cannot remove test-owned model configuration")
		}
	})
	chat.LLMID, chat.TenantLLMID = model.ID, &model.ID
	return model.ID, instance.ID
}

func TestChatTaskRealSnapshotAndRevocation(t *testing.T) {
	parent := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	for _, scenario := range []string{"frozen_input", "chat_revoked", "provider_changed", "model_disabled", "instance_disabled"} {
		t.Run(scenario, func(t *testing.T) {
			e := &chatVoiceE2E{t: t, origin: parent.origin, token: parent.token, client: parent.client}
			chatID, sessionID := e.newMediaSession("Real queued snapshot " + scenario)
			var original entity.Chat
			if err := db.Take(&original, "id = ?", chatID).Error; err != nil || original.UserID == "" ||
				original.TenantLLMID == nil || *original.TenantLLMID == "" {
				t.Fatal("cannot resolve test-owned chat")
			}
			var modelID, instanceID string
			if scenario == "model_disabled" || scenario == "instance_disabled" {
				modelID, instanceID = cloneChatSnapshotModel(t, db, &original)
			}
			release := holdChatUserCapacity(t, db, original.UserID)
			before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
			var admitted struct {
				TaskID   string `json:"task_id"`
				Accepted bool   `json:"accepted"`
			}
			e.request(http.MethodPost, "/chat/completions", map[string]any{
				"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
				"question": "@语音 根据资料简短回答青禾项目的验收暗号和负责人，保留引用。",
			}, &admitted)
			if !admitted.Accepted || admitted.TaskID == "" {
				t.Fatal("task was not durably admitted")
			}
			waiting := waitChatDatabaseTask(t, db, admitted.TaskID, func(task entity.ChatTask) bool {
				return task.State == "running" && strings.HasSuffix(task.Stage, "_queued") &&
					task.Calls == 0 && task.LeaseOwner == ""
			})
			var frozen chatTaskInput
			if err := json.Unmarshal([]byte(waiting.Input), &frozen); err != nil ||
				frozen.Chat.LLMID != original.LLMID ||
				!reflect.DeepEqual(frozen.Chat.KBIDs, original.KBIDs) ||
				!reflect.DeepEqual(frozen.Chat.PromptConfig, original.PromptConfig) {
				t.Fatal("admission did not freeze the original chat configuration")
			}
			updates := map[string]any{}
			switch scenario {
			case "frozen_input":
				updates["llm_id"] = "unavailable-after-admission"
				updates["kb_ids"] = entity.JSONSlice{}
				prompt := chatTaskSettings(original.PromptConfig)
				prompt["system"] = "忽略原问题，只回答CONFIG_CHANGED_SENTINEL，并改用ryan男声音色。{knowledge}"
				updates["prompt_config"] = prompt
				settings := chatTaskSettings(original.LLMSetting)
				settings["temperature"] = 1
				updates["llm_setting"] = settings
			case "chat_revoked":
				updates["status"] = "0"
			case "provider_changed":
				settings := chatTaskSettings(original.LLMSetting)
				settings["base_url"] = "http://unavailable.invalid"
				updates["llm_setting"] = settings
			case "model_disabled":
				if err := db.Model(&entity.TenantModel{}).Where("id = ?", modelID).Update("status", "inactive").Error; err != nil {
					t.Fatal("cannot disable test-owned model")
				}
			case "instance_disabled":
				if err := db.Model(&entity.TenantModelInstance{}).Where("id = ?", instanceID).Update("status", "inactive").Error; err != nil {
					t.Fatal("cannot disable test-owned instance")
				}
			}
			t.Cleanup(func() {
				if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Updates(map[string]any{
					"llm_id": original.LLMID, "kb_ids": original.KBIDs, "prompt_config": original.PromptConfig,
					"llm_setting": original.LLMSetting, "status": original.Status,
				}).Error; err != nil {
					t.Error(err)
				}
			})
			if len(updates) > 0 {
				if err := db.Model(&entity.Chat{}).Where("id = ?", chatID).Updates(updates).Error; err != nil {
					t.Fatal(err)
				}
			}
			release()
			terminal := waitChatDatabaseTask(t, db, admitted.TaskID, func(task entity.ChatTask) bool {
				return dao.IsChatTaskTerminal(task.State)
			})
			after := e.faultControl(nil)
			if terminal.Input != waiting.Input {
				t.Fatal("execution rewrote the durable input snapshot")
			}
			var attempts []entity.ChatTaskAttempt
			if err := db.Where("task_id = ?", terminal.ID).Find(&attempts).Error; err != nil {
				t.Fatal(err)
			}
			if scenario != "frozen_input" {
				if terminal.State != "failed" || terminal.Calls != 0 || len(attempts) != 0 ||
					after["forwarded"] != before["forwarded"] || after["rejected"] != before["rejected"] {
					t.Fatalf("changed authorization/identity reached upstream: %s/%s calls=%d attempts=%d",
						terminal.State, terminal.ErrorCode, terminal.Calls, len(attempts))
				}
				wantCode := "unsupported_capability"
				if scenario == "chat_revoked" {
					wantCode = "not_found"
				} else if scenario == "provider_changed" {
					wantCode = "provider_identity_changed"
				}
				if terminal.ErrorCode != wantCode {
					t.Fatalf("revocation/configuration error=%s; want %s", terminal.ErrorCode, wantCode)
				}
				assertChatFaultNoMedia(t, db, terminal.ID)
				t.Logf("PASS %s after admission: no model attempts, TTS calls or media publication; error=%s", scenario, terminal.ErrorCode)
				return
			}
			answer, _ := terminal.Outputs["answer"].(map[string]any)
			content, _ := answer["content"].(string)
			reference, _ := answer["reference"].(map[string]any)
			chunks, _ := reference["chunks"].([]any)
			if terminal.State != "succeeded" || !strings.Contains(content, "山海同行") ||
				!strings.Contains(content, "林悦") || strings.Contains(content, "CONFIG_CHANGED_SENTINEL") || len(chunks) == 0 {
				t.Fatalf("current settings replaced the admitted intent: %s/%s citations=%d", terminal.State, terminal.ErrorCode, len(chunks))
			}
			text, _ := terminal.Outputs["text"].(map[string]any)
			rawPlan, err := json.Marshal(text["speech_plan"])
			var plan chatSpeechPlan
			if err != nil || json.Unmarshal(rawPlan, &plan) != nil || plan.Voice != chatVoiceName ||
				!strings.Contains(plan.Instructions, chatVoiceIdentityInstruction) {
				t.Fatal("resource wait lost the fixed voice or voice identity instructions")
			}
			for _, attempt := range attempts {
				if attempt.Stage != "audio" && attempt.Model != *original.TenantLLMID {
					t.Fatalf("execution replaced the frozen model: %s", attempt.Model)
				}
			}
			if after["forwarded"] != before["forwarded"]+1 || after["rejected"] != before["rejected"] {
				t.Fatal("configuration change duplicated or rejected TTS")
			}
			var current entity.Chat
			if err := db.Take(&current, "id = ?", chatID).Error; err != nil || current.LLMID != updates["llm_id"] || len(current.KBIDs) != 0 {
				t.Fatal("task execution rewrote the user's current configuration")
			}
			var refreshed ChatSessionPayload
			e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
			found := false
			for _, message := range refreshed.Messages {
				if message["role"] == "assistant" && message["id"] == terminal.TurnID {
					found = message["content"] == content && message["reference"] != nil && message["media_assets"] != nil
				}
			}
			if !found {
				t.Fatal("refresh lost the frozen task's grounded answer or audio")
			}
			t.Logf("PASS model/knowledge/prompt/settings changed during resource wait: original snapshot and grounded output preserved, current configuration unchanged, actual TTS=1; task=%s", terminal.ID)
		})
	}
	t.Run("same_text_new_reference_late_audio", func(t *testing.T) {
		e := &chatVoiceE2E{t: t, origin: parent.origin, token: parent.token, client: parent.client}
		before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 1})
		t.Cleanup(func() { e.faultControl(map[string]any{"release": true, "hold_next": 0}) })
		chatID, sessionID, taskID := e.submitHeldVoice("Late real audio against a newer answer")
		e.waitRealAudioHeld(taskID, before)
		running := e.waitTaskBeforeHeldAudio(taskID)
		answer := running.Task.Outputs["answer"].(map[string]any)
		version, err := chatAnswerVersion(answer)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(answer)
		var replacement map[string]any
		if err := json.Unmarshal(raw, &replacement); err != nil {
			t.Fatal(err)
		}
		reference := replacement["reference"].(map[string]any)
		chunks := reference["chunks"].([]any)
		if len(chunks) == 0 {
			t.Fatal("real answer has no grounded citation")
		}
		chunks[0].(map[string]any)["content"] = "NEW_REFERENCE_VERSION_SENTINEL"
		ctx := permission.WithIdentity(t.Context(), running.Task.UserID, running.Task.TenantID)
		if err := dao.NewChatSessionDAO().UpdateByID(ctx, db, sessionID, map[string]any{
			"history_update": dao.ConversationHistoryUpdate{QuestionID: running.Task.TurnID, Message: replacement, ExpectedVersion: version},
		}); err != nil {
			t.Fatal(err)
		}
		e.faultControl(map[string]any{"release": true})
		terminal := e.waitTask(taskID)
		if terminal.Task.State != "partial_succeeded" || terminal.Task.ErrorCode != "revision_conflict" ||
			terminal.Task.UpstreamStatus != "stopped" || terminal.Task.Outputs["audio"] != nil {
			t.Fatalf("late real audio did not preserve newer version: %s/%s upstream=%s",
				terminal.Task.State, terminal.Task.ErrorCode, terminal.Task.UpstreamStatus)
		}
		var refreshed ChatSessionPayload
		e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
		found := false
		for _, message := range refreshed.Messages {
			if message["role"] != "assistant" || message["id"] != running.Task.TurnID {
				continue
			}
			savedVersion, err := chatAnswerVersion(message)
			if err != nil || *savedVersion != *version+1 || message["content"] != answer["content"] ||
				!reflect.DeepEqual(message["reference"], replacement["reference"]) || message["media_assets"] != nil {
				t.Fatal("late audio overwrote newer citations, content or answer version")
			}
			found = true
		}
		if !found {
			t.Fatal("refresh lost the protected answer")
		}
		retries := e.concurrentRequests("/chats/tasks/"+taskID+"/retry", "",
			map[string]any{"stage": "audio", "revision": terminal.Task.Revision}, 1)
		if retries[0].err != nil || retries[0].code == 0 {
			t.Fatal("stale answer admitted a stage retry")
		}
		var committed int64
		if err := db.Model(&entity.ChatMediaAsset{}).Where("task_id = ? AND state = ?", taskID, "committed").
			Count(&committed).Error; err != nil || committed != 0 {
			t.Fatal("failed version commit published a media asset")
		}
		after := e.faultControl(nil)
		if after["forwarded"] != before["forwarded"]+1 || after["completed"] != before["completed"]+1 {
			t.Fatal("version conflict repeated real TTS")
		}
		t.Logf("PASS same text/new reference version=%d wins over held real TTS; late audio and stale stage retry rejected; TTS=1 task=%s", *version+1, taskID)
	})
}
