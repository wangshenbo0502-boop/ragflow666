package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
)

type chatRouteCandidate struct {
	ID            string `json:"id"`
	MaxCostMicros *int64 `json:"max_cost_micros,omitempty"`
}

// The route policy selects chat/vision models. Media adapters have one verified
// model each; they cannot substitute a text model or a different voice.
func validateChatMediaRoute(options map[string]interface{}) error {
	if policy := stringValue(options["media_route_policy"]); policy != "" && policy != "fixed" {
		return errors.New("unsupported_capability: no qualified media fallback is configured")
	}
	if _, strict := chatConfigPositiveInt(options["cost_limit_micros"]); strict {
		return errors.New("budget_exceeded: fixed media adapter price is unknown")
	}
	return nil
}

func chatModelRouteCapabilities(ctx context.Context) (map[string]interface{}, error) {
	candidates, err := loadChatRouteCandidates(permission.TenantIDFromContext(ctx))
	if err != nil {
		return nil, err
	}
	// Resolve through the same tenant-scoped factory used at call time.
	authorized := []string{}
	for _, candidate := range candidates {
		if info, err := NewModelFactory().ResolveInfo(ctx, entity.ModelTypeChat, candidate.ID); err == nil && info.ID == candidate.ID {
			authorized = append(authorized, candidate.ID)
		}
	}
	fallbackReason := ""
	if len(authorized) == 0 {
		fallbackReason = "no_qualified_candidate"
	}
	media := func(model, voice string, configured bool) map[string]interface{} {
		refs := []string{}
		if configured && permission.TenantIDFromContext(ctx) == os.Getenv("RAGFLOW_MEDIA_TENANT_ID") && permission.TenantIDFromContext(ctx) != "" {
			refs = append(refs, model)
		}
		return map[string]interface{}{
			"policies": []string{"fixed"}, "candidates": refs, "permission_scope": "configured_tenant",
			"fallback_disabled_reason": "no_qualified_candidate", "cost_known": false,
			"strict_cost_supported": false, "fixed_voice": voice,
		}
	}
	return map[string]interface{}{
		"chat": map[string]interface{}{"policies": []string{"fixed", "fallback", "auto"},
			"candidates": authorized, "permission_scope": "current_model_authorization",
			"fallback_disabled_reason": fallbackReason},
		"image": media(chatImageModel, "", os.Getenv("RAGFLOW_IMAGE_BASE_URL") != "" && os.Getenv("RAGFLOW_IMAGE_API_KEY") != ""),
		"voice": media("Qwen3-TTS-12Hz-1.7B-CustomVoice", chatVoiceName, os.Getenv("RAGFLOW_TTS_BASE_URL") != ""),
		"music": media("acestep-v15-turbo-Q6_K.gguf", chatVoiceName, os.Getenv("RAGFLOW_TTS_BASE_URL") != "" && os.Getenv("RAGFLOW_MUSIC_BASE_URL") != ""),
	}, nil
}

// Configuration is tenant scoped and names existing model references only.
// Adding a provider elsewhere does not authorize sending chat data to it.
func loadChatRouteCandidates(tenant string) ([]chatRouteCandidate, error) {
	raw := strings.TrimSpace(os.Getenv("RAGFLOW_CHAT_ROUTE_CONFIG"))
	if raw == "" {
		return nil, nil
	}
	var config map[string][]chatRouteCandidate
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return nil, errors.New("invalid RAGFLOW_CHAT_ROUTE_CONFIG: expected tenant to model array")
	}
	for tenant, candidates := range config {
		if tenant == "" || len(candidates) > 16 {
			return nil, errors.New("invalid RAGFLOW_CHAT_ROUTE_CONFIG: tenant or candidate count")
		}
		seen := map[string]bool{}
		for _, candidate := range candidates {
			if candidate.ID == "" || len(candidate.ID) > 255 || seen[candidate.ID] ||
				(candidate.MaxCostMicros != nil && (*candidate.MaxCostMicros < 0 || *candidate.MaxCostMicros > 1_000_000_000_000)) {
				return nil, errors.New("invalid RAGFLOW_CHAT_ROUTE_CONFIG: model or cost ceiling")
			}
			seen[candidate.ID] = true
		}
	}
	return config[tenant], nil
}

func chatAllowedModels(value interface{}) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("invalid allowed_models")
	}
	var refs []string
	if err := json.Unmarshal(data, &refs); err != nil || len(refs) > 16 {
		return nil, errors.New("invalid allowed_models: expected at most 16 model references")
	}
	for _, ref := range refs {
		if strings.TrimSpace(ref) == "" || len(ref) > 255 {
			return nil, errors.New("invalid allowed_models: empty or oversized reference")
		}
	}
	return refs, nil
}

func resolveChatRouteOptions(ctx context.Context, options map[string]interface{}) (string, []chatRouteCandidate, error) {
	policy := stringValue(options["route_policy"])
	if policy == "" {
		policy = "fixed"
	}
	if policy != "fixed" && policy != "fallback" && policy != "auto" {
		return "", nil, errors.New("invalid route_policy")
	}
	candidates, err := loadChatRouteCandidates(permission.TenantIDFromContext(ctx))
	if err != nil {
		return "", nil, err
	}
	allowed, err := chatAllowedModels(options["allowed_models"])
	if err != nil {
		return "", nil, err
	}
	if allowed != nil {
		candidates = slices.DeleteFunc(candidates, func(candidate chatRouteCandidate) bool {
			return !slices.Contains(allowed, candidate.ID)
		})
	}
	return policy, candidates, nil
}

type chatRouteState struct {
	mu         sync.Mutex
	calls      int
	switches   int
	reserved   int64
	config     ChatTaskConfig
	deadline   time.Time
	strictCost bool
	costLimit  int64
	policy     string
	candidates []chatRouteCandidate
	vision     bool
	autoSwitch bool
	lastModel  string
	stageCalls int
}

func (s *ChatPipelineService) prepareChatRoute(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}, options map[string]interface{}) (context.Context, *entity.Chat, error) {
	ctx = permission.WithTenantID(ctx, chat.TenantID)
	policy, candidates, err := resolveChatRouteOptions(ctx, options)
	if err != nil {
		return ctx, chat, err
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		return ctx, chat, err
	}
	state := &chatRouteState{config: config, deadline: time.Now().Add(config.Timeout), policy: policy, candidates: candidates}
	if value, ok := chatConfigPositiveInt(options["cost_limit_micros"]); ok {
		state.strictCost, state.costLimit = true, int64(value)
	}
	for _, message := range messages {
		if ctx.Value(chatImagePlanningKey{}) == true {
			break
		}
		if descriptors, ok := parseFileDicts(message["files"]); ok {
			for _, descriptor := range descriptors {
				state.vision = state.vision || strings.HasPrefix(stringValue(descriptor["mime_type"]), "image/")
			}
		} else if files, ok := message["files"].([]string); ok {
			for _, value := range files {
				state.vision = state.vision || strings.HasPrefix(value, "data:image/")
			}
		} else if files, ok := message["files"].([]interface{}); ok {
			for _, value := range files {
				state.vision = state.vision || strings.HasPrefix(stringValue(value), "data:image/")
			}
		}
	}
	if state.vision && policy == "auto" {
		factory := NewModelFactory()
		var info *models.ModelInfo
		var err error
		if chat.LLMID == "" {
			info, err = factory.ResolveDefaultInfo(ctx, entity.ModelTypeChat)
		} else {
			info, err = factory.ResolveInfo(ctx, entity.ModelTypeChat, chat.LLMID)
		}
		if err != nil {
			return ctx, chat, err
		}
		if !slices.Contains(info.ModelTypes, entity.ModelTypeImage2Text.String()) {
			var selected *models.ModelInfo
			for _, candidate := range candidates {
				target, err := factory.ResolveInfo(ctx, entity.ModelTypeChat, candidate.ID)
				if err == nil && target.ID == candidate.ID && chatRouteCompatible(info, target, true) &&
					(!state.strictCost || candidate.MaxCostMicros != nil) {
					selected = target
					break
				}
			}
			if selected == nil {
				return ctx, chat, errors.New("unsupported_capability: no authorized vision model in automatic route")
			}
			copy := *chat
			copy.LLMID = ModelReference(selected)
			copy.TenantLLMID = nil
			chat, state.autoSwitch = &copy, true
		}
	}
	return models.WithChatRoute(ctx, state.invoke), chat, nil
}

func chatRouteCompatible(preferred, candidate *models.ModelInfo, vision bool) bool {
	if preferred == nil || candidate == nil {
		return false
	}
	return (!vision || slices.Contains(candidate.ModelTypes, entity.ModelTypeImage2Text.String())) &&
		(!preferred.SupportsTools || candidate.SupportsTools) &&
		candidate.ContextLength >= preferred.ContextLength && candidate.MaxOutput >= preferred.MaxOutput &&
		(preferred.ModelClass == "" || candidate.ModelClass == preferred.ModelClass)
}

func retryableChatRouteError(err error) bool {
	var partial *models.ChatPartialError
	if errors.As(err, &partial) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var status *models.APIStatusError
	return errors.As(err, &status) && (status.Status == 429 || status.Status == 502 || status.Status == 503 || status.Status == 504)
}

func (r *chatRouteState) invoke(ctx context.Context, preferred *models.ChatModel, call func(context.Context, *models.ChatModel) error) error {
	if preferred == nil || preferred.Info() == nil {
		return errors.New("unsupported_capability: route requires model metadata")
	}
	factory := NewModelFactory()
	ctx, deadlineCancel := context.WithDeadline(ctx, r.deadline)
	defer deadlineCancel()
	refs := []string{ModelReference(preferred.Info())}
	if r.policy != "fixed" {
		for _, candidate := range r.candidates {
			if !slices.Contains(refs, candidate.ID) {
				refs = append(refs, candidate.ID)
			}
		}
	}
	lastErr := errors.New("upstream_unavailable: no eligible model outside cooldown")
	healthPolicy := dao.ChatModelHealthPolicy{FailureThreshold: r.config.ModelFailureThreshold,
		FailureWindow: r.config.ModelFailureWindow, Cooldown: r.config.ModelCooldown}
	probeRejected, callStarted := false, false
	for i, ref := range refs {
		if err := ctx.Err(); err != nil {
			return err
		}
		candidate, err := factory.NewChatModel(ctx, ref)
		if err != nil {
			if i == 0 {
				return err
			}
			continue
		}
		info := candidate.Info()
		if info.ID != ref {
			return errors.New("unsupported_capability: routed models require persisted identities")
		}
		if !chatRouteCompatible(preferred.Info(), info, r.vision) {
			continue
		}
		candidate.ToolConfig = preferred.ToolConfig
		r.mu.Lock()
		switched := r.lastModel != "" && r.lastModel != info.ID || r.lastModel == "" && (r.autoSwitch || i > 0)
		r.mu.Unlock()
		details := common.ModelCallDetails{Switch: switched, Reason: "preferred"}
		if details.Switch {
			details.Reason = "service_unavailable"
			if i == 0 {
				details.Reason = "vision_required"
			}
		}
		for _, configured := range r.candidates {
			if configured.ID == ref && configured.MaxCostMicros != nil {
				details.CostKnown, details.EstimatedCost = true, *configured.MaxCostMicros
			}
		}
		if r.strictCost && !details.CostKnown {
			lastErr = errors.New("budget_exceeded: candidate price is unknown")
			continue
		}
		healthID := permission.TenantIDFromContext(ctx) + ":" + info.ID
		if info.ID == "" {
			return errors.New("unsupported_capability: routed models require persisted identities")
		}
		generation, available, err := dao.ClaimChatModelProbe(ctx, dao.DB, healthID, r.config.StageTimeout)
		if err != nil {
			return errors.New("persistence_failed: model health unavailable")
		}
		if !available {
			probeRejected = true
			continue
		}
		if chatExecution(ctx) == nil {
			r.mu.Lock()
			overBudget := r.calls >= r.config.MaxCalls || r.stageCalls >= r.config.MaxStageCalls || (details.Switch && r.switches >= r.config.MaxSwitches) ||
				time.Now().After(r.deadline) || (r.strictCost && details.EstimatedCost > r.costLimit-r.reserved)
			if !overBudget {
				r.calls++
				r.stageCalls++
				r.reserved += details.EstimatedCost
				if details.Switch {
					r.switches++
				}
			}
			r.mu.Unlock()
			if overBudget {
				_ = dao.SettleChatModelHealth(context.WithoutCancel(ctx), dao.DB, healthID, generation, healthPolicy, "", false, false)
				return dao.ErrChatTaskBudget
			}
		}
		r.mu.Lock()
		r.lastModel = info.ID
		r.mu.Unlock()
		callStarted = true
		callCtx := common.WithModelCallDetails(ctx, details)
		callCtx, cancel := context.WithTimeout(callCtx, r.config.StageTimeout)
		err = call(callCtx, candidate)
		cancel()
		retryable := retryableChatRouteError(err)
		settleCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		healthErr := dao.SettleChatModelHealth(settleCtx, dao.DB, healthID, generation, healthPolicy, "service_unavailable", retryable, err == nil)
		stop()
		if healthErr != nil {
			return errors.New("persistence_failed: model health settlement failed")
		}
		common.Info("chat model attempt", zap.String("model_id", info.ID), zap.String("reason", details.Reason),
			zap.Bool("succeeded", err == nil), zap.Bool("cost_unknown", !details.CostKnown))
		if err == nil {
			return nil
		}
		lastErr = err
		if !retryable {
			return err
		}
		if i == len(refs)-1 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(125+rand.IntN(125)) * time.Millisecond * time.Duration(1<<min(i, 3))):
		}
	}
	if probeRejected && !callStarted {
		return errors.New("route_no_eligible_candidate: all compatible models are temporarily unavailable")
	}
	return fmt.Errorf("model route exhausted: %w", lastErr)
}
