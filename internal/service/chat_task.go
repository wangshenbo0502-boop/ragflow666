package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
	"ragflow/internal/service/file"
)

type chatTaskInput struct {
	Chat                  entity.Chat              `json:"chat"`
	Messages              []map[string]interface{} `json:"messages"`
	Kind                  string                   `json:"kind"`
	Prompt                string                   `json:"prompt"`
	Options               map[string]interface{}   `json:"options"`
	ParentID              string                   `json:"parent_id,omitempty"`
	Resume                map[string]interface{}   `json:"resume,omitempty"`
	RetryStage            string                   `json:"retry_stage,omitempty"`
	ExpectedAnswerVersion *int64                   `json:"expected_answer_version,omitempty"`
	ExpectedAnswerAbsent  bool                     `json:"expected_answer_absent,omitempty"`
}

type chatTaskExecution struct {
	service  *ChatSessionService
	dao      *dao.ChatTaskDAO
	task     *entity.ChatTask
	config   ChatTaskConfig
	owner    string
	active   *entity.ChatTaskAttempt
	input    *chatTaskInput
	deferred atomic.Bool
}

type chatTaskExecutionKey struct{}
type chatTaskRequestKey struct{}
type chatTaskRequest struct {
	Key  string
	Hash string
}

var errChatTaskDeferred = errors.New("chat task waiting for resources")

func chatExecution(ctx context.Context) *chatTaskExecution {
	execution, _ := ctx.Value(chatTaskExecutionKey{}).(*chatTaskExecution)
	return execution
}

func safeChatTaskOptions(options map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{})
	for _, key := range []string{"temperature", "top_p", "frequency_penalty", "presence_penalty",
		"max_tokens", "thinking", "reasoning", "internet", "route_policy", "media_route_policy", "allowed_models", "edit_asset_id", "cost_limit_micros", "mode"} {
		if value, ok := options[key]; ok {
			out[key] = value
		}
	}
	return out
}

func chatTaskSchedulingClass(input *chatTaskInput) string {
	if input.Kind != "语音" && input.Kind != "qwen3-tts" || stringValue(input.Options["mode"]) == "music" {
		return "normal"
	}
	if text, ok := input.Resume["text"].(map[string]interface{}); ok {
		raw, err := json.Marshal(text["speech_plan"])
		var plan chatSpeechPlan
		if err != nil || json.Unmarshal(raw, &plan) != nil || plan.Mode == "singing" {
			return "normal"
		}
	}
	return "interactive"
}

func newChatTaskRequest(dialog *entity.Chat, session *entity.ChatSession, last map[string]interface{}, turnID, kind, prompt, model string, options map[string]interface{}) (chatTaskRequest, error) {
	if session == nil {
		return chatTaskRequest{}, errors.New("invalid_request: media requires a saved session")
	}
	turn := make(map[string]interface{}, len(last))
	for key, value := range last {
		if key != "created_at" && key != "id" {
			turn[key] = value
		}
	}
	raw, err := json.Marshal(map[string]interface{}{
		"chat_id": dialog.ID, "session_id": session.ID, "turn": turn,
		"kind": kind, "prompt": prompt, "options": safeChatTaskOptions(options), "model": model,
	})
	if err != nil {
		return chatTaskRequest{}, err
	}
	hash := sha256.Sum256(raw)
	key := strings.TrimSpace(stringValue(options["idempotency_key"]))
	if key == "" {
		key = "turn:" + session.ID + ":" + turnID
	}
	return chatTaskRequest{Key: key, Hash: hex.EncodeToString(hash[:])}, nil
}

func (s *ChatSessionService) replayChatTask(ctx context.Context, dialog *entity.Chat, request chatTaskRequest) (*entity.ChatTask, error) {
	var existing entity.ChatTask
	err := dao.DB.WithContext(ctx).Take(&existing, "tenant_id = ? AND user_id = ? AND idempotency_key = ?",
		dialog.TenantID, permission.UserIDFromContext(ctx), request.Key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	task, err := s.authorizedChatTask(permission.WithTenantID(ctx, dialog.TenantID), existing.ID, permission.OperationRun)
	if err != nil {
		return nil, err
	}
	if task.InputHash != request.Hash {
		return nil, dao.ErrChatTaskConflict
	}
	return task, nil
}

func (s *ChatSessionService) checkChatReplayInputs(ctx context.Context, task *entity.ChatTask) error {
	var input chatTaskInput
	if json.Unmarshal([]byte(task.Input), &input) != nil || len(input.Messages) == 0 {
		return errors.New("checkpoint_incomplete: invalid saved input")
	}
	if id := stringValue(input.Options["edit_asset_id"]); id != "" {
		var asset entity.ChatMediaAsset
		if err := dao.DB.WithContext(ctx).Take(&asset, "id = ? AND session_id = ? AND tenant_id = ? AND state = ?",
			id, task.SessionID, task.TenantID, "committed").Error; err != nil {
			return errors.New("not_found: edit image unavailable")
		}
	}
	if descriptors, ok := parseFileDicts(input.Messages[len(input.Messages)-1]["files"]); ok {
		for _, descriptor := range descriptors {
			if descriptor["created_by"] != permission.UserIDFromContext(ctx) {
				return errors.New("attachment_unavailable: invalid attachment owner")
			}
			var asset entity.ChatMediaAsset
			if err := dao.DB.WithContext(ctx).Take(&asset, "bucket = ? AND object_key = ? AND state = ?",
				task.UserID+"-downloads", stringValue(descriptor["id"]), "committed").Error; err != nil {
				return errors.New("attachment_unavailable: uploaded resource unavailable")
			}
		}
	}
	common.Info("chat task replayed", chatTaskLogFields(task)...)
	return nil
}

func (s *ChatSessionService) submitChatMedia(ctx context.Context, dialog *entity.Chat, session *entity.ChatSession,
	messages []map[string]interface{}, turnID, kind, prompt string, options map[string]interface{}) (*entity.ChatTask, error) {
	ctx = permission.WithTenantID(ctx, dialog.TenantID)
	if session == nil || prompt == "" {
		return nil, errors.New("invalid_request: media requires a saved session and a prompt")
	}
	if len(messages) == 0 {
		return nil, errors.New("invalid_request: missing messages")
	}
	last := messages[len(messages)-1]
	if descriptors, ok := parseFileDicts(last["files"]); ok {
		if len(descriptors) > file.ChatAttachmentMaxCount {
			return nil, errors.New("attachment_unavailable: attachment_count_limit")
		}
		for _, descriptor := range descriptors {
			if descriptor["created_by"] != permission.UserIDFromContext(ctx) || stringValue(descriptor["id"]) == "" {
				return nil, errors.New("attachment_unavailable: invalid attachment owner")
			}
		}
	} else if last["files"] != nil {
		switch values := last["files"].(type) {
		case []interface{}:
			if len(values) != 0 {
				return nil, errors.New("attachment_unavailable: uploaded descriptors required")
			}
		case []string:
			if len(values) != 0 {
				return nil, errors.New("attachment_unavailable: uploaded descriptors required")
			}
		default:
			return nil, errors.New("attachment_unavailable: uploaded descriptors required")
		}
	}
	request, ok := ctx.Value(chatTaskRequestKey{}).(chatTaskRequest)
	if !ok {
		var err error
		request, err = newChatTaskRequest(dialog, session, last, turnID, kind, prompt, "", options)
		if err != nil {
			return nil, err
		}
	}
	if replay, err := s.replayChatTask(ctx, dialog, request); err != nil || replay != nil {
		if err == nil {
			err = s.checkChatReplayInputs(ctx, replay)
		}
		return replay, err
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		return nil, err
	}
	if tenant := strings.TrimSpace(os.Getenv("RAGFLOW_MEDIA_TENANT_ID")); tenant == "" || tenant != dialog.TenantID {
		return nil, errors.New("unsupported_capability: media is not configured for this workspace")
	}
	if err := validateChatMediaRoute(options); err != nil {
		return nil, err
	}
	d := dao.NewChatTaskDAO(dao.DB)
	available, err := d.WorkerAvailable(ctx)
	if err != nil || !available {
		return nil, errors.New("queue_unavailable: no active chat media worker")
	}
	frozen := *dialog
	frozen.PromptConfig = chatTaskSettings(dialog.PromptConfig)
	frozen.LLMSetting = chatTaskSettings(dialog.LLMSetting)
	if dialog.MetaDataFilter != nil {
		metadata := chatTaskSettings(*dialog.MetaDataFilter)
		frozen.MetaDataFilter = &metadata
	}
	input := chatTaskInput{Chat: frozen, Messages: messages, Kind: kind, Prompt: prompt, Options: safeChatTaskOptions(options), ExpectedAnswerAbsent: true}
	_, candidates, err := resolveChatRouteOptions(ctx, input.Options)
	if err != nil {
		return nil, err
	}
	// Freeze the authorized set; later administrative changes may narrow it.
	allowed := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		allowed = append(allowed, candidate.ID)
	}
	input.Options["allowed_models"] = allowed
	input.ParentID = stringValue(options["edit_asset_id"])
	if input.ParentID == "" && (kind == "生图" || kind == "image_voice") {
		var asset entity.ChatMediaAsset
		err := dao.DB.WithContext(ctx).Where("session_id = ? AND tenant_id = ? AND kind = ? AND state = ?",
			session.ID, dialog.TenantID, "image", "committed").Order("created_at DESC").Order("id DESC").Take(&asset).Error
		if err == nil {
			input.ParentID = asset.ID
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
	}
	if input.ParentID != "" {
		var asset entity.ChatMediaAsset
		if err := dao.DB.WithContext(ctx).Take(&asset, "id = ? AND session_id = ? AND tenant_id = ? AND kind = ? AND state = ?",
			input.ParentID, session.ID, dialog.TenantID, "image", "committed").Error; err != nil {
			return nil, errors.New("not_found: edit image unavailable")
		}
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, errors.New("invalid_request: invalid media configuration")
	}
	now := time.Now()
	task := &entity.ChatTask{
		ID: common.GenerateToken(), TenantID: dialog.TenantID, UserID: permission.UserIDFromContext(ctx),
		ChatID: dialog.ID, SessionID: session.ID, TurnID: turnID, Kind: kind,
		SchedulingClass: chatTaskSchedulingClass(&input),
		IdempotencyKey:  request.Key, InputHash: request.Hash, Input: string(encoded),
		MaxCalls: config.MaxCalls, MaxStageCalls: config.MaxStageCalls, MaxSwitches: config.MaxSwitches,
		QueueDeadline: now.Add(config.QueueTimeout).UnixMilli(), Deadline: now.Add(config.Timeout).UnixMilli(),
	}
	if value, ok := chatConfigPositiveInt(options["cost_limit_micros"]); ok {
		task.StrictCost, task.CostLimit = true, int64(value)
	}
	created, replayed, err := d.Submit(ctx, task, config.UserPending, config.TenantPending, func(tx *gorm.DB) error {
		if err := dao.CheckConversationAnswerVersion(ctx, tx, session.ID, turnID, nil, true); err != nil {
			return err
		}
		var refs []entity.ChatMediaReference
		if input.ParentID != "" {
			refs = append(refs, entity.ChatMediaReference{AssetID: input.ParentID, OwnerKind: "task", OwnerID: task.ID})
		}
		if err := dao.RegisterChatMediaInputs(ctx, tx, session.ID, last, refs...); err != nil {
			return err
		}
		return s.chatSessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
			"history_update": dao.ConversationHistoryUpdate{Message: last},
		})
	})
	if err == nil && replayed {
		common.Info("chat task replayed", chatTaskLogFields(created)...)
	}
	return created, err
}

func (s *ChatSessionService) authorizedChatTask(ctx context.Context, id string, operation permission.Operation) (*entity.ChatTask, error) {
	task, err := dao.NewChatTaskDAO(dao.DB).Get(ctx, id)
	if err != nil || task.UserID != permission.UserIDFromContext(ctx) ||
		(permission.TenantIDFromContext(ctx) != "" && task.TenantID != permission.TenantIDFromContext(ctx)) {
		return nil, errors.New("not_found: task unavailable")
	}
	for _, ref := range []permission.ResourceRef{{Kind: permission.ResourceKindChat, ID: task.ChatID}, {Kind: permission.ResourceKindChatSession, ID: task.SessionID}} {
		if err := s.permissionChecker.CheckResource(ctx, ref, operation); err != nil {
			return nil, errors.New("not_found: task unavailable")
		}
	}
	return task, nil
}

func (s *ChatSessionService) GetChatTask(ctx context.Context, id string) (map[string]interface{}, error) {
	task, err := s.authorizedChatTask(ctx, id, permission.OperationRead)
	if err != nil {
		return nil, err
	}
	details, err := dao.NewChatTaskDAO(dao.DB).Details(ctx, id)
	if err != nil {
		return nil, err
	}
	task = details.Task
	var input chatTaskInput
	if err := json.Unmarshal([]byte(task.Input), &input); err != nil {
		return nil, fmt.Errorf("decode chat task diagnostic snapshot: %w", err)
	}
	var tenantLLMID, tenantDecisionID interface{}
	if input.Chat.TenantLLMID != nil {
		tenantLLMID = *input.Chat.TenantLLMID
	}
	if input.Chat.TenantDecisionID != nil {
		tenantDecisionID = *input.Chat.TenantDecisionID
	}
	retry := chatTaskRetryOptions(task)
	if err := s.permissionChecker.CheckResource(ctx, permission.ResourceRef{Kind: permission.ResourceKindChatSession, ID: task.SessionID}, permission.OperationRun); err != nil {
		retry.Stages, retry.Reason = []string{}, "forbidden"
	} else if len(retry.Stages) > 0 {
		answer, _ := task.Outputs["answer"].(map[string]interface{})
		version, err := chatAnswerVersion(answer)
		if err == nil {
			err = dao.CheckConversationAnswerVersion(ctx, dao.DB, task.SessionID, task.TurnID, version, answer == nil)
		}
		if err != nil {
			if !errors.Is(err, dao.ErrAnswerVersion) {
				return nil, err
			}
			for _, stage := range retry.Stages {
				retry.StageReasons[stage] = "revision_conflict"
			}
			retry.Stages, retry.Reason = []string{}, "revision_conflict"
		}
	}
	return map[string]interface{}{"task": task, "attempts": details.Attempts, "diagnostics": describeChatTask(details),
		"routing_snapshot": map[string]interface{}{
			"tenant_id": task.TenantID, "tenant_llm_id": tenantLLMID,
			"tenant_decision_id": tenantDecisionID, "model_id": input.Chat.LLMID,
			"route_policy": input.Options["route_policy"],
		},
		"can_cancel": !dao.IsChatTaskTerminal(task.State),
		"can_retry":  len(retry.Stages) > 0, "retry_stages": retry.Stages, "retry_disabled_reason": retry.Reason,
		"retry_stage_reasons": retry.StageReasons}, nil
}

type chatTaskRetry struct {
	Stages       []string
	Reason       string
	StageReasons map[string]string
}

func chatTaskRetryOptions(task *entity.ChatTask) chatTaskRetry {
	result := chatTaskRetry{Stages: []string{}, StageReasons: map[string]string{}}
	switch {
	case task.UpstreamStatus == "unknown" || task.UpstreamStatus == "running":
		result.Reason = "upstream_result_unknown"
	case task.State != "failed" && task.State != "partial_succeeded":
		result.Reason = "task_not_retryable"
	}
	if result.Reason != "" {
		return result
	}
	var input chatTaskInput
	if json.Unmarshal([]byte(task.Input), &input) != nil {
		result.Reason = "checkpoint_incomplete"
		return result
	}
	answer, _ := task.Outputs["answer"].(map[string]interface{})
	if _, err := chatAnswerVersion(answer); err != nil {
		result.Reason = "checkpoint_incomplete"
		return result
	}
	for _, stage := range []string{"image", "audio"} {
		reason := ""
		switch {
		case task.Outputs[stage] != nil:
			reason = "output_already_succeeded"
		case stage == "image" && input.Kind != "生图" && input.Kind != "image_voice":
			reason = "unsupported_capability"
		case stage == "audio" && input.Kind != "语音" && input.Kind != "qwen3-tts" && input.Kind != "image_voice":
			reason = "unsupported_capability"
		case stage == "audio":
			text, _ := task.Outputs["text"].(map[string]interface{})
			var plan chatSpeechPlan
			raw, err := json.Marshal(text["speech_plan"])
			if err != nil || json.Unmarshal(raw, &plan) != nil || plan.Answer == "" ||
				plan.Voice != chatVoiceName || stringValue(answer["content"]) == "" {
				reason = "checkpoint_incomplete"
			}
		}
		if reason != "" {
			result.StageReasons[stage] = reason
		} else {
			result.Stages = append(result.Stages, stage)
		}
	}
	if len(result.Stages) == 0 {
		result.Reason = "no_retryable_stage"
	}
	return result
}

func (s *ChatSessionService) ChatCapabilities(ctx context.Context) (map[string]interface{}, error) {
	tenantID, err := requireCurrentTenantID(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := LoadChatTaskConfig(); err != nil {
		return nil, err
	}
	available, err := dao.NewChatTaskDAO(dao.DB).WorkerAvailable(ctx)
	if err != nil {
		return nil, err
	}
	tenant := os.Getenv("RAGFLOW_MEDIA_TENANT_ID")
	enabled := tenant != "" && tenant == tenantID && available
	mode := func(configured bool) map[string]interface{} {
		reason := ""
		if !enabled {
			reason = "当前工作空间没有可用的媒体 Worker"
		} else if !configured {
			reason = "服务尚未配置"
		}
		return map[string]interface{}{"available": enabled && configured, "reason": reason}
	}
	image := os.Getenv("RAGFLOW_IMAGE_BASE_URL") != "" && os.Getenv("RAGFLOW_IMAGE_API_KEY") != ""
	voice := os.Getenv("RAGFLOW_TTS_BASE_URL") != ""
	routes, err := chatModelRouteCapabilities(permission.WithTenantID(ctx, tenantID))
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"image": mode(image), "voice": mode(voice), "music": mode(voice && os.Getenv("RAGFLOW_MUSIC_BASE_URL") != ""),
		"image_voice": mode(image && voice),
		"attachments": map[string]interface{}{"max_count": file.ChatAttachmentMaxCount, "max_bytes": file.ChatAttachmentMaxBytes,
			"total_bytes": file.ChatAttachmentTotalBytes, "max_pixels": file.ChatAttachmentMaxPixels},
		"model_routes": routes,
	}, nil
}

func (s *ChatSessionService) ListChatTasks(ctx context.Context, sessionID, state, kind string, page, size int) (map[string]interface{}, error) {
	tenantID, err := requireCurrentTenantID(ctx)
	if err != nil {
		return nil, err
	}
	chats, err := s.permissionChecker.Scope(ctx, permission.ScopeQuery{
		Kind: permission.ResourceKindChat, Operation: permission.OperationRead,
	})
	if err != nil {
		return nil, err
	}
	sessionIDs := make([]string, 0)
	for _, chatID := range chats.ResourceIDs {
		chatRef := permission.ResourceRef{Kind: permission.ResourceKindChat, ID: chatID}
		sessions, err := s.permissionChecker.Scope(ctx, permission.ScopeQuery{
			Kind: permission.ResourceKindChatSession, Parent: chatRef,
			Operation: permission.OperationRead, Entry: &chatRef, EntryOp: permission.OperationRead,
		})
		if err != nil {
			return nil, err
		}
		sessionIDs = append(sessionIDs, sessions.ResourceIDs...)
	}
	tasks, total, err := dao.NewChatTaskDAO(dao.DB).List(ctx, tenantID, permission.UserIDFromContext(ctx), sessionIDs, sessionID, state, kind, page, size)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"tasks": tasks, "total": total, "page": page, "page_size": size}, nil
}

func (s *ChatSessionService) ChatTaskEvents(ctx context.Context, id string, after int64) (map[string]interface{}, error) {
	task, err := s.authorizedChatTask(ctx, id, permission.OperationRead)
	if err != nil {
		return nil, err
	}
	events, err := dao.NewChatTaskDAO(dao.DB).Events(ctx, id, after, 100)
	if err != nil {
		return nil, err
	}
	// Never apply events newer than the accompanying authoritative snapshot.
	stable := make([]entity.ChatTaskEvent, 0, len(events))
	for _, event := range events {
		if event.Seq <= task.EventSeq {
			stable = append(stable, event)
		}
	}
	reset := after > task.EventSeq || (after < task.EventSeq && len(stable) == 0)
	next := after
	for _, event := range stable {
		if event.Seq != next+1 {
			reset = true
			break
		}
		next = event.Seq
	}
	if reset {
		next = task.EventSeq
		stable = []entity.ChatTaskEvent{}
	}
	return map[string]interface{}{"task": task, "events": stable, "after_seq": after,
		"last_seq": task.EventSeq, "next_seq": next, "reset": reset}, nil
}

func (s *ChatSessionService) CancelChatTask(ctx context.Context, id string) (*entity.ChatTask, error) {
	if _, err := s.authorizedChatTask(ctx, id, permission.OperationRun); err != nil {
		return nil, err
	}
	return dao.NewChatTaskDAO(dao.DB).Cancel(ctx, id)
}

func (s *ChatSessionService) RetryChatTask(ctx context.Context, id, stage string, revision int64) (*entity.ChatTask, error) {
	original, err := s.authorizedChatTask(ctx, id, permission.OperationRun)
	if err != nil {
		return nil, err
	}
	if revision != original.Revision {
		return nil, errors.New("revision_conflict: task cannot be retried at this revision")
	}
	if stage != "audio" && stage != "image" {
		return nil, errors.New("invalid_request: retry stage must be audio or image")
	}
	retry := chatTaskRetryOptions(original)
	allowed := false
	for _, candidate := range retry.Stages {
		allowed = allowed || candidate == stage
	}
	if !allowed {
		return nil, errors.New("invalid_request: retry not allowed: " + retry.Reason + " " + retry.StageReasons[stage])
	}
	savedAnswer, _ := original.Outputs["answer"].(map[string]interface{})
	expectedContent := stringValue(savedAnswer["content"])
	if stage == "audio" && expectedContent == "" {
		return nil, errors.New("invalid_request: retry target answer is unavailable")
	}
	var input chatTaskInput
	if json.Unmarshal([]byte(original.Input), &input) != nil || len(input.Messages) == 0 {
		return nil, errors.New("invalid_request: invalid saved input")
	}
	if stage == "audio" && input.Kind == "生图" {
		return nil, errors.New("invalid_request: task has no audio output")
	}
	if stage == "image" && input.Kind != "生图" && input.Kind != "image_voice" {
		return nil, errors.New("invalid_request: task has no image output")
	}
	input.Resume, input.RetryStage = original.Outputs, stage
	input.ExpectedAnswerVersion, err = chatAnswerVersion(savedAnswer)
	if err != nil {
		return nil, err
	}
	input.ExpectedAnswerAbsent = savedAnswer == nil
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(encoded)
	request := chatTaskRequest{Key: fmt.Sprintf("retry:%s:%s:%d", id, stage, revision), Hash: hex.EncodeToString(hash[:])}
	if replay, err := s.replayChatTask(ctx, &input.Chat, request); err != nil || replay != nil {
		if err == nil {
			err = s.checkChatReplayInputs(ctx, replay)
		}
		return replay, err
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	task := &entity.ChatTask{
		ID: common.GenerateToken(), TenantID: original.TenantID, UserID: original.UserID,
		ChatID: original.ChatID, SessionID: original.SessionID, TurnID: original.TurnID, Kind: original.Kind,
		Input: string(encoded), InputHash: request.Hash,
		SchedulingClass: chatTaskSchedulingClass(&input),
		IdempotencyKey:  request.Key, RetryOf: id, TargetRevision: revision,
		MaxCalls: config.MaxCalls, MaxStageCalls: config.MaxStageCalls, MaxSwitches: config.MaxSwitches,
		QueueDeadline: now.Add(config.QueueTimeout).UnixMilli(), Deadline: now.Add(config.Timeout).UnixMilli(),
		StrictCost: original.StrictCost, CostLimit: original.CostLimit,
	}
	result, replayed, err := dao.NewChatTaskDAO(dao.DB).Submit(ctx, task, config.UserPending, config.TenantPending, func(tx *gorm.DB) error {
		var current entity.ChatTask
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&current, "id = ?", original.ID).Error; err != nil {
			return err
		}
		if current.Revision != revision {
			return errors.New("revision_conflict: task changed before retry admission")
		}
		currentRetry := chatTaskRetryOptions(&current)
		permitted := false
		for _, candidate := range currentRetry.Stages {
			permitted = permitted || candidate == stage
		}
		if !permitted {
			return errors.New("invalid_request: retry no longer allowed")
		}
		if err := dao.CheckConversationAnswerVersion(ctx, tx, original.SessionID, original.TurnID, input.ExpectedAnswerVersion, input.ExpectedAnswerAbsent); err != nil {
			return err
		}
		// Retain successful branches, the edit target and uploaded staging objects
		// until this retry has either committed or reached a terminal state.
		var assets []entity.ChatMediaAsset
		if err := tx.Where("(task_id = ? AND state IN ?) OR id IN (?)", original.ID,
			[]string{"staging", "committed"},
			tx.Model(&entity.ChatMediaReference{}).Select("asset_id").Where("owner_kind = ? AND owner_id = ?", "task", original.ID),
		).Order("id").Find(&assets).Error; err != nil {
			return err
		}
		refs := make([]entity.ChatMediaReference, 0, len(assets)+1)
		for _, asset := range assets {
			refs = append(refs, entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "task", OwnerID: task.ID})
		}
		// Cleanup may already have removed a terminal task's references. The
		// checkpoint remains authoritative about inputs the retry must retain.
		for _, kind := range []string{"image", "audio"} {
			var outputs []struct {
				ID string `json:"id"`
			}
			raw, err := json.Marshal(current.Outputs[kind])
			if err != nil || json.Unmarshal(raw, &outputs) != nil {
				return errors.New("checkpoint_incomplete: invalid saved media output")
			}
			for _, output := range outputs {
				if output.ID == "" {
					return errors.New("checkpoint_incomplete: missing saved media identity")
				}
				refs = append(refs, entity.ChatMediaReference{AssetID: output.ID, OwnerKind: "task", OwnerID: task.ID})
			}
		}
		if id := stringValue(current.Outputs["voice_reference"]); id != "" {
			refs = append(refs, entity.ChatMediaReference{AssetID: id, OwnerKind: "task", OwnerID: task.ID})
		}
		if input.ParentID != "" {
			refs = append(refs, entity.ChatMediaReference{AssetID: input.ParentID, OwnerKind: "task", OwnerID: task.ID})
		}
		return dao.RegisterChatMediaInputs(ctx, tx, original.SessionID, input.Messages[len(input.Messages)-1], refs...)
	})
	if err == nil && replayed {
		common.Info("chat task replayed", chatTaskLogFields(result)...)
	}
	return result, err
}

func (s *ChatSessionService) observeChatTask(ctx context.Context, task *entity.ChatTask, stream chan<- string) error {
	send := func(value interface{}) error {
		payload := fmt.Sprintf("data:%s\n\n", marshalJSONWithSpaces(sseWrapper{Code: 0, Message: "success", Data: value}))
		select {
		case stream <- payload:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := send(map[string]interface{}{"task": task, "task_id": task.ID, "accepted": true}); err != nil {
		return err
	}
	cursor := int64(0)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if _, err := s.authorizedChatTask(ctx, task.ID, permission.OperationRead); err != nil {
			return err
		}
		current, err := dao.NewChatTaskDAO(dao.DB).Get(ctx, task.ID)
		if err != nil {
			return err
		}
		events, err := dao.NewChatTaskDAO(dao.DB).Events(ctx, task.ID, cursor, 100)
		if err != nil {
			return err
		}
		for _, event := range events {
			if err := send(map[string]interface{}{"task_event": event, "task": current}); err != nil {
				return err
			}
			cursor = event.Seq
		}
		if answer, ok := current.Outputs["answer"].(map[string]interface{}); ok {
			result := s.structureAnswer(nil, stringValue(answer["content"]), task.TurnID, task.SessionID, nil)
			for _, key := range []string{"reference", "prompt", "usage", "elapsed_ms", "media_assets", "image_plan", "answer_version", "output_revision", "task_id"} {
				if value := answer[key]; value != nil {
					result[key] = value
				}
			}
			result["chat_id"], result["final"] = task.ChatID, dao.IsChatTaskTerminal(current.State)
			if err := send(result); err != nil {
				return err
			}
		}
		if dao.IsChatTaskTerminal(current.State) && cursor >= current.EventSeq {
			return send(true)
		}
		select {
		case stream <- ": heartbeat\n\n":
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (e *chatTaskExecution) checkPermission(ctx context.Context) error {
	_, err := e.service.authorizedChatTask(ctx, e.task.ID, permission.OperationRun)
	return err
}

func (e *chatTaskExecution) Begin(ctx context.Context, stage, model string) (context.Context, func(error), error) {
	if err := e.checkPermission(ctx); err != nil {
		return ctx, nil, err
	}
	if err := dao.CheckConversationAnswerVersion(ctx, dao.DB, e.task.SessionID, e.task.TurnID,
		e.input.ExpectedAnswerVersion, e.input.ExpectedAnswerAbsent); err != nil {
		return ctx, nil, err
	}
	resources := []string{"chat:user:" + e.task.UserID, "chat:tenant:" + e.task.TenantID}
	if stage == "audio" || stage == "image" || stage == "music" {
		resources = append(resources, e.config.Device)
	}
	for _, resource := range resources {
		capacity := e.config.DeviceCapacity
		if strings.HasPrefix(resource, "chat:user:") {
			capacity = e.config.UserConcurrent
		} else if strings.HasPrefix(resource, "chat:tenant:") {
			capacity = e.config.TenantConcurrent
		}
		if err := e.dao.EnsureResource(ctx, resource, capacity); err != nil {
			return ctx, nil, err
		}
	}
	details := common.ModelCallDetailsFromContext(ctx)
	attempt, err := e.dao.ReserveCall(ctx, e.task.ID, e.owner, e.task.LeaseEpoch,
		dao.ChatTaskCall{Stage: stage, Model: model, Resources: resources, Reason: details.Reason,
			Switch: details.Switch, CostKnown: details.CostKnown, EstimatedCost: details.EstimatedCost})
	if errors.Is(err, dao.ErrChatTaskQuota) {
		e.deferred.Store(true)
		if err := e.stage(ctx, stage+"_queued"); err != nil {
			return ctx, nil, err
		}
		return ctx, nil, errChatTaskDeferred
	}
	if err != nil {
		return ctx, nil, err
	}
	e.active = attempt
	if err := e.stage(ctx, stage); err != nil {
		_ = e.dao.SettleCall(context.WithoutCancel(ctx), e.task.ID, e.owner, e.task.LeaseEpoch, attempt.ID, "failed", "stopped", 0, nil, "persistence_failed")
		return ctx, nil, err
	}
	callCtx, stop := context.WithTimeout(ctx, e.config.StageTimeout)
	return callCtx, func(callErr error) {
		defer stop()
		state, upstream, code := "succeeded", "stopped", ""
		if callErr != nil {
			state = "failed"
			code, _ = chatTaskError(callErr)
			var stopped *chatUpstreamStoppedError
			var status *models.APIStatusError
			confirmedStopped := errors.As(callErr, &stopped)
			if errors.As(callErr, &status) {
				confirmedStopped = !chatHTTPResultUnknown(status.Status)
			}
			if !confirmedStopped {
				// Without a completion receipt the remote work may still run.
				upstream, state = "unknown", "unknown"
				code = "upstream_result_unknown"
			}
		}
		settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		usage := entity.JSONMap(common.ModelCallUsage(callCtx))
		if usage == nil {
			usage = entity.JSONMap{}
		}
		usage["elapsed_ms"] = time.Now().UnixMilli() - attempt.StartedAt
		if err := e.dao.SettleCall(settleCtx, e.task.ID, e.owner, e.task.LeaseEpoch, attempt.ID, state, upstream, 0, usage, code); err != nil {
			common.Warn("chat task call settlement failed")
		}
		e.active = nil
	}, nil
}

func (e *chatTaskExecution) Upstream(ctx context.Context, id string) error {
	if e.active == nil || len(id) > 255 {
		return errors.New("invalid upstream job")
	}
	return e.dao.RecordUpstream(ctx, e.task.ID, e.owner, e.task.LeaseEpoch, e.active.ID, id)
}

func (e *chatTaskExecution) stage(ctx context.Context, stage string) error {
	return e.dao.Mutate(ctx, e.task.ID, e.owner, e.task.LeaseEpoch, "stage_changed",
		func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			task.Stage = stage
			return entity.JSONMap{"stage": stage}, nil
		})
}

func (e *chatTaskExecution) commitText(ctx context.Context, reply, answer map[string]interface{}) error {
	finishSave := measureChatTaskPhase(ctx, "save")
	defer finishSave()
	err := e.dao.Mutate(ctx, e.task.ID, e.owner, e.task.LeaseEpoch, "output_committed",
		func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			if task.Outputs == nil {
				task.Outputs = entity.JSONMap{}
			}
			answer["output_revision"], answer["task_id"] = task.Revision+1, task.ID
			task.Outputs["text"], task.Outputs["answer"] = reply, answer
			if raw, err := json.Marshal(reply["speech_plan"]); err == nil {
				var plan chatSpeechPlan
				if json.Unmarshal(raw, &plan) == nil && plan.Mode == "singing" {
					task.SchedulingClass = "normal"
				}
			}
			return entity.JSONMap{"kind": "text"}, e.service.chatSessionDAO.UpdateByID(ctx, tx, task.SessionID, map[string]interface{}{
				"history_update": dao.ConversationHistoryUpdate{Message: answer, QuestionID: task.TurnID,
					ExpectedVersion: e.input.ExpectedAnswerVersion, ExpectedAbsent: e.input.ExpectedAnswerAbsent},
			})
		})
	if err == nil {
		e.advanceAnswerVersion(answer)
	}
	return err
}

func (e *chatTaskExecution) advanceAnswerVersion(answer map[string]interface{}) {
	e.input.ExpectedAnswerAbsent = false
	e.input.ExpectedAnswerVersion, _ = chatAnswerVersion(answer)
}

func chatAnswerVersion(answer map[string]interface{}) (*int64, error) {
	if answer == nil {
		return nil, nil
	}
	raw, err := json.Marshal(answer["answer_version"])
	var version int64
	if err != nil || json.Unmarshal(raw, &version) != nil || version < 1 {
		return nil, errors.New("checkpoint_incomplete: missing answer version")
	}
	return &version, nil
}
