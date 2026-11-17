package dao

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/entity"
)

// ChatTaskStatistics is an inventory of retained rows, not lifetime counters.
type ChatTaskStatistics struct {
	ObservedAt        int64
	TaskStates        map[string]int64
	UnknownUpstreams  int64
	UnreferencedMedia int64
	ReclaimableMedia  int64
	CleanupPending    int64
	CleanupRetries    int64
	CleanupOldestMs   int64
}

func (d *ChatTaskDAO) Statistics(ctx context.Context, grace time.Duration) (*ChatTaskStatistics, error) {
	if grace < 0 {
		return nil, errors.New("invalid media cleanup grace")
	}
	result := &ChatTaskStatistics{TaskStates: map[string]int64{
		"queued": 0, "running": 0, "cancel_requested": 0,
		"succeeded": 0, "partial_succeeded": 0, "failed": 0, "cancelled": 0,
	}}
	err := d.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now, err := databaseTime(tx)
		if err != nil {
			return err
		}
		result.ObservedAt = now
		var states []struct {
			State string
			Count int64
		}
		if err := tx.Model(&entity.ChatTask{}).Select("state, COUNT(*) AS count").Group("state").Scan(&states).Error; err != nil {
			return err
		}
		for _, state := range states {
			if _, ok := result.TaskStates[state.State]; ok {
				result.TaskStates[state.State] = state.Count
			}
		}
		if err := tx.Model(&entity.ChatTask{}).Where("upstream_status = ?", "unknown").Count(&result.UnknownUpstreams).Error; err != nil {
			return err
		}
		// Match cleanup's retention rules, including task ownership without a
		// reference and unresolved upstreams on otherwise terminal tasks.
		liveTasks := tx.Model(&entity.ChatTask{}).Select("id").
			Where("state NOT IN ? OR upstream_status IN ?",
				[]string{"succeeded", "partial_succeeded", "failed", "cancelled"}, []string{"running", "unknown"})
		refs := tx.Model(&entity.ChatMediaReference{}).Select("1").
			Where("asset_id = chat_media_asset.id").
			Where("owner_kind <> ? OR owner_id IN (?)", "task", liveTasks)
		unreferenced := func() *gorm.DB {
			return tx.Model(&entity.ChatMediaAsset{}).
				Where("state IN ?", []string{"staging", "committed", "deleting"}).
				Where("NOT EXISTS (?)", refs).
				Where("COALESCE(task_id, '') NOT IN (?)", liveTasks)
		}
		if err := unreferenced().Count(&result.UnreferencedMedia).Error; err != nil {
			return err
		}
		cutoff := now - grace.Milliseconds()
		if err := unreferenced().Where("created_at <= ?", cutoff).Count(&result.ReclaimableMedia).Error; err != nil {
			return err
		}
		reclaimable := unreferenced().Select("id").Where("created_at <= ?", cutoff)
		var cleanup struct {
			Pending int64
			Retries int64
			Oldest  int64
		}
		if err := tx.Model(&entity.ChatMediaCleanup{}).
			Select("COUNT(*) AS pending, COALESCE(SUM(CASE WHEN state = ? THEN 1 ELSE 0 END), 0) AS retries, COALESCE(MIN(created_at), 0) AS oldest", "retry").
			Where("state <> ? AND created_at <= ? AND asset_id IN (?)", "done", cutoff, reclaimable).
			Scan(&cleanup).Error; err != nil {
			return err
		}
		result.CleanupPending, result.CleanupRetries = cleanup.Pending, cleanup.Retries
		if cleanup.Pending > 0 {
			result.CleanupOldestMs = max(0, now-cleanup.Oldest)
		}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	return result, nil
}
