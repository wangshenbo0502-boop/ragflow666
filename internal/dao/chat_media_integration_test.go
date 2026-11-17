//go:build integration

package dao

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/entity"
	"ragflow/internal/storage"
)

type blockedChatRemoval struct {
	storage.Storage
	started chan struct{}
	release chan struct{}
}

func (s *blockedChatRemoval) Remove(ctx context.Context, bucket, key string, options ...string) error {
	close(s.started)
	select {
	case <-s.release:
		return s.Storage.Remove(ctx, bucket, key, options...)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestChatMediaReferenceCleanupConcurrencyMySQL(t *testing.T) {
	dsn := os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")
	if dsn == "" {
		t.Skip("RAGFLOW_TEST_CHAT_MYSQL_DSN requires an isolated ragflow_chat_test_ schema")
	}
	db, err := gorm.Open(newMigrationAwareDialector(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot open isolated database")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var schema string
	if err := db.Raw("SELECT DATABASE()").Scan(&schema).Error; err != nil || !strings.HasPrefix(schema, "ragflow_chat_test_") {
		t.Fatal("refusing to migrate a database outside ragflow_chat_test_")
	}
	pool.SetMaxOpenConns(12)
	for _, model := range []any{&entity.ChatMediaAsset{}, &entity.ChatMediaReference{}, &entity.ChatMediaCleanup{}, &entity.ChatTask{}} {
		if db.Migrator().HasTable(model) {
			t.Fatal("isolated schema must be empty")
		}
		if err := db.AutoMigrate(model); err != nil {
			t.Fatal(err)
		}
	}
	d := NewChatTaskDAO(db)
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	store := storage.NewMemoryStorage()
	fixture := func(id string) (entity.ChatMediaAsset, entity.ChatMediaCleanup) {
		t.Helper()
		asset := entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: "tenant", SessionID: "session",
			Kind: "audio", Bucket: "isolated", ObjectKey: id, State: "committed", CreatedAt: 1}
		record := entity.ChatMediaCleanup{ID: id, AssetID: id, Bucket: asset.Bucket,
			ObjectKey: id, State: "pending", CreatedAt: 1}
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&record).Error; err != nil {
			t.Fatal(err)
		}
		if err := store.Put(ctx, asset.Bucket, id, []byte("object")); err != nil {
			t.Fatal(err)
		}
		return asset, record
	}
	check := func(id string, referenced bool) {
		t.Helper()
		var asset entity.ChatMediaAsset
		if err := db.Take(&asset, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		var count int64
		if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", id).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
		if err != nil {
			t.Fatal(err)
		}
		if referenced && (asset.State != "committed" || count != 1 || !exists) {
			t.Fatalf("successful reference lost its object: state=%s refs=%d exists=%v", asset.State, count, exists)
		}
		if !referenced && (asset.State != "deleted" || count != 0 || exists) {
			t.Fatalf("cleanup left a dangling object/reference: state=%s refs=%d exists=%v", asset.State, count, exists)
		}
	}
	t.Run("reference_commits_first", func(t *testing.T) {
		asset, journal := fixture("reference-first")
		tx := db.WithContext(ctx).Begin()
		defer tx.Rollback()
		if err := ReferenceChatMedia(tx, entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "message", OwnerID: "session:turn"}); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- d.cleanupMediaObject(ctx, store, journal.ID) }()
		if err := tx.Commit().Error; err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		check(asset.ID, true)
	})
	t.Run("cleanup_commits_first", func(t *testing.T) {
		asset, journal := fixture("cleanup-first")
		slow := &blockedChatRemoval{Storage: store, started: make(chan struct{}), release: make(chan struct{})}
		done := make(chan error, 1)
		go func() { done <- d.cleanupMediaObject(ctx, slow, journal.ID) }()
		select {
		case <-slow.started:
		case <-ctx.Done():
			t.Fatal("cleanup did not reach storage")
		}
		err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			return ReferenceChatMedia(tx, entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "task", OwnerID: "retry"})
		})
		close(slow.release)
		if !errors.Is(err, ErrChatMediaReclaimed) {
			t.Fatalf("deleting asset accepted a new reference: %v", err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		check(asset.ID, false)
		// A repeated call must reject deleted assets too.
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			return ReferenceChatMedia(tx, entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "message", OwnerID: "late"})
		}); !errors.Is(err, ErrChatMediaReclaimed) {
			t.Fatalf("deleted asset accepted a reference: %v", err)
		}
	})
	t.Run("simultaneous_races", func(t *testing.T) {
		for i := 0; i < 30; i++ {
			asset, journal := fixture(fmt.Sprintf("race-%02d", i))
			start := make(chan struct{})
			refResult, cleanupResult := make(chan error, 1), make(chan error, 1)
			go func() {
				<-start
				refResult <- db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					return ReferenceChatMedia(tx, entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "message", OwnerID: "session:turn"})
				})
			}()
			go func() { <-start; cleanupResult <- d.cleanupMediaObject(ctx, store, journal.ID) }()
			close(start)
			refErr, cleanupErr := <-refResult, <-cleanupResult
			if cleanupErr != nil || refErr != nil && !errors.Is(refErr, ErrChatMediaReclaimed) {
				t.Fatalf("race %d deadlock/error: reference=%v cleanup=%v", i, refErr, cleanupErr)
			}
			check(asset.ID, refErr == nil)
		}
	})
	t.Run("opposite_input_order", func(t *testing.T) {
		first, _ := fixture("order-a")
		second, _ := fixture("order-z")
		start := make(chan struct{})
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				ids := []string{first.ID, second.ID}
				if i == 1 {
					ids[0], ids[1] = ids[1], ids[0]
				}
				<-start
				results <- db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					return ReferenceChatMedia(tx,
						entity.ChatMediaReference{AssetID: ids[0], OwnerKind: "task", OwnerID: fmt.Sprint(i)},
						entity.ChatMediaReference{AssetID: ids[1], OwnerKind: "task", OwnerID: fmt.Sprint(i)})
				})
			}(i)
		}
		close(start)
		wg.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatal(err)
			}
		}
	})
}
