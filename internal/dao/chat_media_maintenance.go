package dao

import (
	"context"
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/entity"
)

const chatMediaMaintenanceID = "chat:media:maintenance"

var ErrChatMediaMaintenance = errors.New("queue_unavailable: media writes are frozen for maintenance")

func checkChatMediaMaintenance(tx *gorm.DB) error {
	resource, err := lockChatMediaMaintenance(tx)
	if err != nil {
		return err
	}
	if resource.Capacity == 0 {
		return ErrChatMediaMaintenance
	}
	return nil
}

func lockChatMediaMaintenance(tx *gorm.DB) (*entity.ChatTaskResource, error) {
	resource := entity.ChatTaskResource{ID: chatMediaMaintenanceID, Capacity: 1}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&resource).Error; err != nil {
		return nil, err
	}
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&resource, "id = ?", chatMediaMaintenanceID).Error
	return &resource, err
}

// RequireChatMediaFrozen holds the admission lock for one migration transaction.
func RequireChatMediaFrozen(tx *gorm.DB) error {
	resource, err := lockChatMediaMaintenance(tx)
	if err != nil {
		return err
	}
	if resource.Capacity != 0 {
		return errors.New("media writes must remain frozen during migration")
	}
	return nil
}

// SetChatMediaMaintenance serializes with admission and claiming across hosts.
// It refuses a freeze while any executor or unresolved remote job remains.
func SetChatMediaMaintenance(ctx context.Context, db *gorm.DB, frozen bool) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		resource, err := lockChatMediaMaintenance(tx)
		if err != nil {
			return err
		}
		if frozen {
			var active int64
			if err := tx.Model(&entity.ChatTask{}).Where("state IN ? OR upstream_status IN ?",
				[]string{"running", "cancel_requested"}, []string{"running", "unknown"}).Count(&active).Error; err != nil {
				return err
			}
			if active != 0 {
				return errors.New("media maintenance requires all running and unknown upstream jobs to be reconciled")
			}
			resource.Capacity = 0
		} else {
			resource.Capacity = 1
		}
		return tx.Save(resource).Error
	})
}

func IsChatMediaFrozen(ctx context.Context, db *gorm.DB) (bool, error) {
	var resource entity.ChatTaskResource
	err := db.WithContext(ctx).Take(&resource, "id = ?", chatMediaMaintenanceID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return resource.Capacity == 0, err
}
