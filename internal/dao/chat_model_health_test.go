package dao

import (
	"testing"
	"time"

	"ragflow/internal/entity"
)

func TestChatModelHealthFencesLateResultsAndSingleProbe(t *testing.T) {
	_, db := setupChatTaskTest(t)
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	policy := ChatModelHealthPolicy{FailureThreshold: 1, FailureWindow: time.Minute, Cooldown: 5 * time.Second}
	first, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute)
	if err != nil || !allowed {
		t.Fatalf("first claim: %v %v", allowed, err)
	}
	if err := SettleChatModelHealth(ctx, db, "tenant:model", first, policy, "service_unavailable", true, false); err != nil {
		t.Fatal(err)
	}
	if err := SettleChatModelHealth(ctx, db, "tenant:model", first, policy, "", false, true); err != nil {
		t.Fatal(err)
	}
	if _, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute); err != nil || allowed {
		t.Fatalf("late success cleared cooldown: %v %v", allowed, err)
	}
	if err := db.Model(&entity.ChatModelHealth{}).Where("id = ?", "tenant:model").Update("cooldown_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	probe, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute)
	if err != nil || !allowed || probe <= first {
		t.Fatalf("recovery probe: %d %v %v", probe, allowed, err)
	}
	if _, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute); err != nil || allowed {
		t.Fatalf("duplicate recovery probe: %v %v", allowed, err)
	}
	if err := SettleChatModelHealth(ctx, db, "tenant:model", probe, policy, "", false, true); err != nil {
		t.Fatal(err)
	}
	if _, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute); err != nil || !allowed {
		t.Fatalf("healthy model not restored: %v %v", allowed, err)
	}
}

func TestChatModelHealthUsesConfiguredWindowThresholdAndCooldown(t *testing.T) {
	_, db := setupChatTaskTest(t)
	if err := db.AutoMigrate(&entity.ChatModelHealth{}); err != nil {
		t.Fatal(err)
	}
	policy := ChatModelHealthPolicy{FailureThreshold: 2, FailureWindow: time.Minute, Cooldown: 17 * time.Second}
	ctx := t.Context()
	fail := func() entity.ChatModelHealth {
		t.Helper()
		generation, allowed, err := ClaimChatModelProbe(ctx, db, "tenant:model", time.Minute)
		if err != nil || !allowed {
			t.Fatalf("healthy model blocked before threshold: %v %v", allowed, err)
		}
		if err := SettleChatModelHealth(ctx, db, "tenant:model", generation, policy, "service_unavailable", true, false); err != nil {
			t.Fatal(err)
		}
		var health entity.ChatModelHealth
		if err := db.Take(&health, "id = ?", "tenant:model").Error; err != nil {
			t.Fatal(err)
		}
		return health
	}
	first := fail()
	if first.Failures != 1 || first.CooldownUntil != 0 || first.ProbeUntil != 0 {
		t.Fatalf("first failure tripped threshold: %+v", first)
	}
	if err := db.Model(&first).Update("window_start", 1).Error; err != nil {
		t.Fatal(err)
	}
	expired := fail()
	if expired.Failures != 1 || expired.CooldownUntil != 0 {
		t.Fatalf("failure outside window counted: %+v", expired)
	}
	// Parameter errors and cancellation release a probe without adding failures.
	if err := SettleChatModelHealth(ctx, db, first.ID, expired.Generation, policy, "", false, false); err != nil {
		t.Fatal(err)
	}
	tripped := fail()
	now, err := databaseTime(db)
	if err != nil || tripped.Failures != 2 || tripped.Generation <= expired.Generation ||
		tripped.CooldownUntil-now < 16000 || tripped.CooldownUntil-now > 17000 {
		t.Fatalf("configured cooldown not enforced: %+v now=%d err=%v", tripped, now, err)
	}
	if _, allowed, err := ClaimChatModelProbe(ctx, db, first.ID, time.Minute); err != nil || allowed {
		t.Fatalf("shared cooldown allowed another request: %v %v", allowed, err)
	}
	if err := db.Model(&tripped).Update("cooldown_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	probe, allowed, err := ClaimChatModelProbe(ctx, db, first.ID, time.Minute)
	if err != nil || !allowed {
		t.Fatal("expired cooldown did not allow a probe")
	}
	if err := SettleChatModelHealth(ctx, db, first.ID, probe, policy, "", false, true); err != nil {
		t.Fatal(err)
	}
	var restored entity.ChatModelHealth
	if err := db.Take(&restored, "id = ?", first.ID).Error; err != nil || restored.Failures != 0 ||
		restored.WindowStart != 0 || restored.CooldownUntil != 0 || restored.ProbeUntil != 0 {
		t.Fatalf("success did not reset window: %+v %v", restored, err)
	}
}
