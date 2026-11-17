package dao

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/entity"
)

type ChatModelHealthPolicy struct {
	FailureThreshold int
	FailureWindow    time.Duration
	Cooldown         time.Duration
}

// ClaimChatModelProbe shares cooldown and a single recovery probe across hosts.
func ClaimChatModelProbe(ctx context.Context, db *gorm.DB, id string, lease time.Duration) (int64, bool, error) {
	allowed := false
	var generation int64
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&entity.ChatModelHealth{ID: id}).Error; err != nil {
			return err
		}
		var health entity.ChatModelHealth
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&health, "id = ?", id).Error; err != nil {
			return err
		}
		now, err := databaseTime(tx)
		if err != nil {
			return err
		}
		if health.CooldownUntil > now || health.ProbeUntil > now {
			return nil
		}
		allowed = true
		if health.CooldownUntil > 0 {
			health.Generation++
			health.ProbeUntil = now + lease.Milliseconds()
			if err := tx.Save(&health).Error; err != nil {
				return err
			}
		}
		generation = health.Generation
		return nil
	})
	return generation, allowed, err
}

func SettleChatModelHealth(ctx context.Context, db *gorm.DB, id string, generation int64, policy ChatModelHealthPolicy, code string, failed, succeeded bool) error {
	if policy.FailureThreshold < 1 || policy.FailureThreshold > 1000 ||
		policy.FailureWindow < time.Second || policy.FailureWindow > 24*time.Hour ||
		policy.Cooldown < time.Second || policy.Cooldown > 24*time.Hour || failed && succeeded {
		return errors.New("invalid chat model health policy")
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var health entity.ChatModelHealth
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&health, "id = ?", id).Error; err != nil {
			return err
		}
		if health.Generation != generation {
			return nil
		}
		health.ProbeUntil = 0
		if succeeded {
			health.Failures, health.CooldownUntil, health.LastError = 0, 0, ""
			health.WindowStart = 0
		} else if failed {
			now, err := databaseTime(tx)
			if err != nil {
				return err
			}
			if health.WindowStart == 0 || now-health.WindowStart >= policy.FailureWindow.Milliseconds() {
				health.WindowStart, health.Failures = now, 0
			}
			health.Failures++
			if health.CooldownUntil > 0 || health.Failures >= policy.FailureThreshold {
				health.Generation++
				health.CooldownUntil = now + policy.Cooldown.Milliseconds()
			}
			health.LastError = code
		}
		return tx.Save(&health).Error
	})
}
