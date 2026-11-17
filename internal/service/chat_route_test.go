package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/permission"
)

func TestChatRouteCommunityTenantScope(t *testing.T) {
	db := setupModelProviderServiceTestDB(t)
	useModelProviderServiceTestDB(t, db)
	seedModelProviderServiceScope(t, db)
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal(err)
	}
	chat := &entity.Chat{TenantID: "user-1", LLMID: "model-1"}
	service := &ChatPipelineService{}
	ctx, _, err := service.prepareChatRoute(serviceTestContext(t, "user-1", ""), chat, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if permission.TenantIDFromContext(ctx) != chat.TenantID {
		t.Fatal("community chat lost its model authorization scope")
	}
	model, err := NewModelFactory().NewChatModel(ctx, chat.LLMID)
	if err != nil || model.Info().ID != "model-1" {
		t.Fatalf("community model resolution: %v", err)
	}
	ctx, _, err = service.prepareChatRoute(serviceTestContext(t, "user-1", "foreign"), chat, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if permission.TenantIDFromContext(ctx) != "foreign" {
		t.Fatal("chat replaced an explicit authenticated tenant")
	}
	if _, err := NewModelFactory().NewChatModel(ctx, chat.LLMID); err == nil {
		t.Fatal("foreign tenant resolved the chat owner's model")
	}
}

func TestChatRoutePoliciesAndSharedBudget(t *testing.T) {
	db := setupModelProviderServiceTestDB(t)
	useModelProviderServiceTestDB(t, db)
	seedModelProviderServiceScope(t, db)
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&entity.TenantModel{ID: "model-2", ProviderID: "provider-1", InstanceID: "instance-1",
		ModelName: "gpt-second", ModelType: int(entity.ModelTypeChat), Status: "active"}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := serviceTestContext(t, "user-1", "user-1")
	preferred, err := NewModelFactory().NewChatModel(ctx, "model-1")
	if err != nil {
		t.Fatal(err)
	}
	config, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	cost := int64(6)
	route := &chatRouteState{config: config, deadline: time.Now().Add(time.Minute), policy: "fallback",
		candidates: []chatRouteCandidate{{ID: "model-1", MaxCostMicros: &cost}, {ID: "model-2", MaxCostMicros: &cost}}}
	var calls []string
	err = route.invoke(ctx, preferred, func(_ context.Context, model *models.ChatModel) error {
		calls = append(calls, model.Info().ID)
		if model.Info().ID == "model-1" {
			return &models.APIStatusError{Status: 503}
		}
		return nil
	})
	if err != nil || len(calls) != 2 || route.calls != 2 || route.switches != 1 {
		t.Fatalf("fallback calls=%v switches=%d err=%v", calls, route.switches, err)
	}
	cooldownRoute := &chatRouteState{config: config, deadline: time.Now().Add(time.Minute), policy: "fallback",
		candidates: route.candidates}
	err = cooldownRoute.invoke(ctx, preferred, func(ctx context.Context, model *models.ChatModel) error {
		details := common.ModelCallDetailsFromContext(ctx)
		if model.Info().ID != "model-2" || !details.Switch || details.Reason != "service_unavailable" {
			t.Fatalf("cooldown fallback lost identity/reason: %s %+v", model.Info().ID, details)
		}
		return nil
	})
	if err != nil || cooldownRoute.calls != 1 || cooldownRoute.switches != 1 {
		t.Fatalf("cooldown fallback not charged as switch: %v", err)
	}
	noSwitchConfig := config
	noSwitchConfig.MaxSwitches = 0
	noSwitchRoute := &chatRouteState{config: noSwitchConfig, deadline: time.Now().Add(time.Minute), policy: "fallback",
		candidates: route.candidates}
	if err := noSwitchRoute.invoke(ctx, preferred, func(context.Context, *models.ChatModel) error {
		t.Fatal("switch budget ignored")
		return nil
	}); !errors.Is(err, dao.ErrChatTaskBudget) {
		t.Fatalf("cooldown switch budget: %v", err)
	}
	route.strictCost, route.costLimit = true, 12
	if err := route.invoke(ctx, preferred, func(context.Context, *models.ChatModel) error {
		t.Fatal("reserved spend reused")
		return nil
	}); !errors.Is(err, dao.ErrChatTaskBudget) {
		t.Fatalf("shared cost budget: %v", err)
	}
}

func TestChatRouteNeverSwitchesAfterPartialOrUnknown(t *testing.T) {
	for _, err := range []error{context.Canceled, context.DeadlineExceeded, errors.New("transport failed"),
		&models.ChatPartialError{Err: &models.APIStatusError{Status: 503}}, &models.APIStatusError{Status: 400}} {
		if retryableChatRouteError(err) {
			t.Fatalf("unsafe fallback for %T", err)
		}
	}
	for _, code := range []int{429, 502, 503, 504} {
		if !retryableChatRouteError(&models.APIStatusError{Status: code}) {
			t.Fatalf("no fallback for %d", code)
		}
	}
}

func TestChatRouteHealthGateDoesNotMasqueradeAsProviderFailure(t *testing.T) {
	db := setupModelProviderServiceTestDB(t)
	useModelProviderServiceTestDB(t, db)
	seedModelProviderServiceScope(t, db)
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal(err)
	}
	ctx := serviceTestContext(t, "user-1", "user-1")
	config, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	healthID := "user-1:model-1"
	now := time.Now().UnixMilli()
	if err := db.Create(&entity.ChatModelHealth{ID: healthID, Failures: config.ModelFailureThreshold,
		WindowStart: now - 1000, CooldownUntil: now - 1}).Error; err != nil {
		t.Fatal(err)
	}
	generation, available, err := dao.ClaimChatModelProbe(ctx, db, healthID, config.StageTimeout)
	if err != nil || !available {
		t.Fatalf("reserve health probe: available=%v err=%v", available, err)
	}

	preferred, err := NewModelFactory().NewChatModel(ctx, "model-1")
	if err != nil {
		t.Fatal(err)
	}
	route := &chatRouteState{config: config, deadline: time.Now().Add(time.Minute), policy: "fixed"}
	calls := 0
	err = route.invoke(ctx, preferred, func(context.Context, *models.ChatModel) error {
		calls++
		return nil
	})
	if calls != 0 || route.calls != 0 {
		t.Fatalf("health-gated model was invoked: callback calls=%d charged calls=%d", calls, route.calls)
	}
	code, _ := chatTaskError(err)
	if code != "route_no_eligible_candidate" {
		t.Fatalf("health gate error=%v classified as %q", err, code)
	}
	if err := dao.SettleChatModelHealth(ctx, db, healthID, generation,
		dao.ChatModelHealthPolicy{FailureThreshold: config.ModelFailureThreshold,
			FailureWindow: config.ModelFailureWindow, Cooldown: config.ModelCooldown}, "", false, true); err != nil {
		t.Fatalf("release health probe: %v", err)
	}
}

func TestChatMediaRouteScopeAndUnknownPrice(t *testing.T) {
	for _, policy := range []string{"fallback", "auto", "invalid"} {
		if err := validateChatMediaRoute(map[string]interface{}{"media_route_policy": policy}); err == nil {
			t.Fatalf("accepted unsupported media policy %q", policy)
		}
	}
	if err := validateChatMediaRoute(map[string]interface{}{"route_policy": "fallback"}); err != nil {
		t.Fatalf("text planner policy affected fixed media: %v", err)
	}
	if err := validateChatMediaRoute(map[string]interface{}{"cost_limit_micros": 100}); err == nil {
		t.Fatal("unknown media price admitted under a strict currency limit")
	}
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "owner")
	t.Setenv("RAGFLOW_CHAT_ROUTE_CONFIG", "")
	t.Setenv("RAGFLOW_IMAGE_BASE_URL", "http://image")
	t.Setenv("RAGFLOW_IMAGE_API_KEY", "test")
	t.Setenv("RAGFLOW_TTS_BASE_URL", "http://tts")
	t.Setenv("RAGFLOW_MUSIC_BASE_URL", "http://music")
	for _, tenant := range []string{"owner", "other"} {
		routes, err := chatModelRouteCapabilities(permission.WithIdentity(t.Context(), tenant, tenant))
		if err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"image", "voice", "music"} {
			route := routes[kind].(map[string]interface{})
			policies, refs := route["policies"].([]string), route["candidates"].([]string)
			if len(policies) != 1 || policies[0] != "fixed" || (len(refs) == 1) != (tenant == "owner") ||
				route["strict_cost_supported"] != false || route["fallback_disabled_reason"] != "no_qualified_candidate" {
				t.Fatalf("%s advertised unsupported media routing: %v", kind, route)
			}
		}
	}
	t.Setenv("RAGFLOW_TTS_BASE_URL", "")
	routes, err := chatModelRouteCapabilities(permission.WithIdentity(t.Context(), "owner", "owner"))
	if err != nil || len(routes["voice"].(map[string]interface{})["candidates"].([]string)) != 0 ||
		len(routes["music"].(map[string]interface{})["candidates"].([]string)) != 0 {
		t.Fatal("unconfigured audio adapter advertised a candidate")
	}
	t.Setenv("RAGFLOW_CHAT_ROUTE_CONFIG", "{invalid")
	if _, err := chatModelRouteCapabilities(t.Context()); err == nil {
		t.Fatal("invalid routing configuration was hidden as an empty candidate list")
	}
}
