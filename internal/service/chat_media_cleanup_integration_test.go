//go:build integration

package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

func verifyChatMediaStorageRemovalFailure(t *testing.T, ctx context.Context, db *gorm.DB, store storage.Storage, tasks *dao.ChatTaskDAO) {
	t.Helper()
	var cfg config.MinioConfig
	if err := json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &cfg); err != nil || cfg.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("requires isolated MinIO")
	}
	// Invalid credentials exercise the actual S3 deletion path, not a storage double.
	cfg.Password = common.GenerateToken()
	denied, err := storage.NewMinioStorage(cfg)
	if err != nil {
		t.Fatal(err)
	}
	id := common.GenerateToken()
	asset := entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: "owner", State: "committed",
		Kind: "audio", Bucket: chatMediaBucket, ObjectKey: "delete-denied/" + id + ".wav", CreatedAt: 1}
	journal := entity.ChatMediaCleanup{ID: common.GenerateToken(), AssetID: id, Bucket: asset.Bucket,
		StoreScope: asset.Bucket, ObjectKey: asset.ObjectKey, State: "pending", CreatedAt: 1}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&journal).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, chatWAV()); err != nil {
		t.Fatal(err)
	}
	if err := tasks.CleanupMedia(ctx, denied, 0, 100); err != nil {
		t.Fatalf("storage denial was not durably scheduled: %v", err)
	}
	if err := db.Take(&asset, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	var now int64
	if err := db.Raw("SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)").Scan(&now).Error; err != nil {
		t.Fatal(err)
	}
	if err != nil || !exists || asset.State != "deleting" || journal.State != "retry" ||
		journal.LastError != "storage_remove_failed" || journal.Attempts != 1 || journal.NextRunAt <= now {
		t.Fatalf("delete denial lost object, fence or backoff: exists=%t asset=%s journal=%s error=%s attempts=%d next=%d now=%d err=%v",
			exists, asset.State, journal.State, journal.LastError, journal.Attempts, journal.NextRunAt, now, err)
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		return dao.RegisterChatMediaInputs(ctx, tx, "", nil,
			entity.ChatMediaReference{AssetID: id, OwnerKind: "task", OwnerID: common.GenerateToken()})
	})
	if !errors.Is(err, dao.ErrChatMediaReclaimed) {
		t.Fatalf("resource scheduled for deletion accepted a new reference: %v", err)
	}
	if err := tasks.CleanupMedia(ctx, store, 0, 100); err != nil {
		t.Fatal(err)
	}
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil || journal.Attempts != 1 || journal.State != "retry" {
		t.Fatal("cleanup ignored the deletion retry backoff")
	}
	if err := db.Model(&journal).Update("next_run_at", 0).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := tasks.CleanupMedia(ctx, store, 0, 100); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Take(&asset, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	exists, err = store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	if err != nil || exists || asset.State != "deleted" || journal.State != "done" || journal.Attempts != 2 || journal.LastError != "" {
		t.Fatalf("restored storage did not finish deletion exactly once: exists=%t asset=%s journal=%s attempts=%d err=%v",
			exists, asset.State, journal.State, journal.Attempts, err)
	}
	var references int64
	if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", id).Count(&references).Error; err != nil || references != 0 {
		t.Fatal("deleted resource has a dangling reference")
	}
	t.Log("PASS real MinIO rejects deletion -> MySQL retains deleting fence and retry backoff -> new references rejected -> restored credentials delete object -> repeated cleanup unchanged")
}
