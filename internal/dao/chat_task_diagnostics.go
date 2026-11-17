package dao

import (
	"context"
	"database/sql"

	"gorm.io/gorm"

	"ragflow/internal/entity"
)

type ChatTaskEventSummary struct {
	Type    string
	Data    entity.JSONMap
	Count   int64
	FirstAt int64
	LastAt  int64
}

type ChatTaskDetails struct {
	Task       *entity.ChatTask
	Attempts   []entity.ChatTaskAttempt
	Events     []ChatTaskEventSummary
	ObservedAt int64
}

// Details reads one consistent snapshot, including settlements which do not
// advance the task's event sequence. Repeated resource waits are grouped in SQL.
func (d *ChatTaskDAO) Details(ctx context.Context, id string) (*ChatTaskDetails, error) {
	result := &ChatTaskDetails{Attempts: []entity.ChatTaskAttempt{}, Events: []ChatTaskEventSummary{}}
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		snapshot := NewChatTaskDAO(tx)
		var err error
		if result.Task, err = snapshot.Get(ctx, id); err != nil {
			return err
		}
		if result.Attempts, err = snapshot.Attempts(ctx, id); err != nil {
			return err
		}
		if err := tx.Model(&entity.ChatTaskEvent{}).
			Select("type, data, COUNT(*) AS count, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at").
			Where("task_id = ? AND seq <= ?", id, result.Task.EventSeq).
			Group("type, data").Scan(&result.Events).Error; err != nil {
			return err
		}
		result.ObservedAt, err = databaseTime(tx)
		return err
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return result, err
}
