//go:build integration

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
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	chatqueue "ragflow/internal/engine/nats"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

type chatIntegrationRemoval struct {
	storage.Storage
	started chan struct{}
	release chan struct{}
}

type chatReservationSnapshotKey struct{}

func (s *chatIntegrationRemoval) Remove(ctx context.Context, bucket, key string, options ...string) error {
	close(s.started)
	select {
	case <-s.release:
		return s.Storage.Remove(ctx, bucket, key, options...)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestChatMediaEntryPointCleanupMySQLMinIO(t *testing.T) {
	dsn := os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")
	if dsn == "" {
		t.Skip("requires a disposable empty MySQL schema and dedicated MinIO")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot open disposable database")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	pool.SetMaxOpenConns(12)
	var schema string
	if err := db.Raw("SELECT DATABASE()").Scan(&schema).Error; err != nil || !strings.HasPrefix(schema, "ragflow_chat_test_") {
		t.Fatal("refusing database outside disposable schema")
	}
	var cfg config.MinioConfig
	if err := json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &cfg); err != nil || cfg.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("requires isolated MinIO")
	}
	store, err := storage.NewMinioStorage(cfg)
	if err != nil {
		t.Fatal("cannot connect disposable MinIO")
	}
	for _, model := range []any{&entity.Tenant{}, &entity.Chat{}, &entity.ChatSession{},
		&entity.ConversationMessage{}, &entity.ConversationReference{}, &entity.ChatTask{},
		&entity.ChatTaskEvent{}, &entity.ChatTaskAttempt{}, &entity.ChatTaskWorker{},
		&entity.ChatTaskResource{}, &entity.ChatTaskResourceLease{}, &entity.ChatMediaAsset{},
		&entity.ChatMediaReference{}, &entity.ChatMediaCleanup{}} {
		if db.Migrator().HasTable(model) {
			t.Fatal("schema must initially be empty")
		}
		if err := db.AutoMigrate(model); err != nil {
			t.Fatal(err)
		}
	}
	previous := dao.DB
	dao.DB = db
	defer func() { dao.DB = previous }()
	t.Setenv("RAGFLOW_MEDIA_TENANT_ID", "owner")
	t.Setenv("RAGFLOW_CHAT_ROUTE_CONFIG", "")
	ctx, cancel := context.WithTimeout(permission.WithIdentity(t.Context(), "owner", "owner"), 90*time.Second)
	defer cancel()
	if err := db.Create(&entity.Tenant{ID: "owner"}).Error; err != nil {
		t.Fatal(err)
	}
	d := dao.NewChatTaskDAO(db)
	if err := d.WorkerHeartbeat(ctx, "integration", 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	svc := NewChatSessionService()
	sequence := 0
	for _, entry := range []string{"submit", "retry", "migration"} {
		for _, order := range []string{"reference_first", "cleanup_first", "race"} {
			t.Run(entry+"/"+order, func(t *testing.T) {
				sequence++
				if err := dao.SetChatMediaMaintenance(ctx, db, entry == "migration"); err != nil {
					t.Fatal(err)
				}
				id := common.GenerateToken()
				chat := &entity.Chat{ID: common.GenerateToken(), TenantID: "owner", UserID: "owner", Status: strPtr("1"),
					LLMSetting: entity.JSONMap{}, PromptConfig: entity.JSONMap{}, KBIDs: entity.JSONSlice{}}
				session := &entity.ChatSession{ID: fmt.Sprintf("%032d", sequence), DialogID: chat.ID, UserID: strPtr("owner"), Message: json.RawMessage(`[]`)}
				if err := db.Create(chat).Error; err != nil {
					t.Fatal(err)
				}
				if err := dao.NewChatSessionDAO().Create(ctx, db, session); err != nil {
					t.Fatal(err)
				}
				turn := common.GenerateToken()
				message := map[string]interface{}{"id": turn, "role": "user", "content": "question"}
				asset := &entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: "owner",
					SessionID: session.ID, TurnID: turn, Kind: "image", Bucket: chatMediaBucket,
					ObjectKey: session.ID + "/" + id + ".wav", MIMEType: "audio/wav", State: "committed", CreatedAt: 1}
				var invoke func() error
				switch entry {
				case "submit":
					upload := common.GenerateToken()
					sum := sha256.Sum256([]byte("owner-downloads\x00" + upload))
					asset.ID = hex.EncodeToString(sum[:16])
					asset.Kind, asset.Bucket, asset.ObjectKey = "upload", "owner-downloads", upload
					message["files"] = []map[string]interface{}{{"id": upload, "created_by": "owner", "mime_type": "image/png"}}
					invoke = func() error {
						_, err := svc.submitChatMedia(ctx, chat, session, []map[string]interface{}{message}, turn, "语音", "question", nil)
						return err
					}
				case "retry":
					if err := svc.chatSessionDAO.UpdateByID(ctx, db, session.ID, map[string]interface{}{
						"history_update": dao.ConversationHistoryUpdate{Message: message},
					}); err != nil {
						t.Fatal(err)
					}
					answer := map[string]interface{}{"id": turn, "role": "assistant", "content": "saved answer"}
					if err := svc.chatSessionDAO.UpdateByID(ctx, db, session.ID, map[string]interface{}{
						"history_update": dao.ConversationHistoryUpdate{QuestionID: turn, Message: answer, ExpectedAbsent: true},
					}); err != nil {
						t.Fatal(err)
					}
					input, _ := json.Marshal(chatTaskInput{Chat: *chat, Kind: "image_voice", Prompt: "question",
						Messages: []map[string]interface{}{message}, Options: map[string]interface{}{}})
					original := &entity.ChatTask{ID: common.GenerateToken(), TenantID: "owner", UserID: "owner",
						ChatID: chat.ID, SessionID: session.ID, TurnID: turn, Kind: "image_voice", Input: string(input),
						InputHash: strings.Repeat("a", 64), IdempotencyKey: id, State: "partial_succeeded", Revision: 1, UpstreamStatus: "stopped",
						Outputs: entity.JSONMap{"image": []map[string]interface{}{{"id": asset.ID}},
							"answer": answer,
							"text":   map[string]interface{}{"speech_plan": chatSpeechPlan{Answer: "saved answer", Voice: chatVoiceName}}}}
					if err := db.Create(original).Error; err != nil {
						t.Fatal(err)
					}
					asset.TaskID = original.ID
					invoke = func() error {
						_, err := svc.RetryChatTask(ctx, original.ID, "audio", original.Revision)
						return err
					}
				case "migration":
					link := fmt.Sprintf("/api/v1/chats/%s/sessions/%s/media/%s.wav", chat.ID, session.ID, id)
					content, role := "[audio]("+link+")", "assistant"
					original := &entity.ConversationMessage{ConversationID: session.ID,
						ConversationMessageFields: entity.ConversationMessageFields{MessageID: &turn, Role: &role, Content: &content}}
					if err := db.Create(original).Error; err != nil {
						t.Fatal(err)
					}
					asset.Kind = "audio"
					invoke = func() error {
						report, err := MigrateChatMedia(ctx, db, store, true, fmt.Sprintf("%032d", sequence-1), 1)
						if err == nil && (report.Failures != 0 || report.Missing != 0 || report.Manual != 0) {
							return errors.New("migration rejected unavailable resource")
						}
						return err
					}
				}
				if err := db.Create(asset).Error; err != nil {
					t.Fatal(err)
				}
				journal := &entity.ChatMediaCleanup{ID: common.GenerateToken(), AssetID: asset.ID,
					Bucket: asset.Bucket, StoreScope: asset.Bucket, ObjectKey: asset.ObjectKey, State: "pending", CreatedAt: 1}
				if err := db.Create(journal).Error; err != nil {
					t.Fatal(err)
				}
				if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, chatWAV()); err != nil {
					t.Fatal(err)
				}
				var refErr, cleanupErr error
				switch order {
				case "reference_first":
					refErr = invoke()
					cleanupErr = d.CleanupMedia(ctx, store, 0, 100)
					if refErr != nil {
						t.Fatalf("valid reference failed: %v", refErr)
					}
				case "cleanup_first":
					slow := &chatIntegrationRemoval{Storage: store, started: make(chan struct{}), release: make(chan struct{})}
					done := make(chan error, 1)
					go func() { done <- d.CleanupMedia(ctx, slow, 0, 100) }()
					select {
					case <-slow.started:
					case <-ctx.Done():
						t.Fatal("cleanup never reached real storage")
					}
					refErr = invoke()
					close(slow.release)
					cleanupErr = <-done
					if refErr == nil {
						t.Fatal("deleting resource accepted a reference")
					}
				case "race":
					start := make(chan struct{})
					result := make(chan error, 1)
					go func() { <-start; result <- invoke() }()
					close(start)
					cleanupErr = d.CleanupMedia(ctx, store, 0, 100)
					refErr = <-result
				}
				if cleanupErr != nil {
					t.Fatalf("cleanup failed/deadlocked: %v", cleanupErr)
				}
				var current entity.ChatMediaAsset
				if err := db.Take(&current, "id = ?", asset.ID).Error; err != nil {
					t.Fatal(err)
				}
				var refs int64
				if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", asset.ID).Count(&refs).Error; err != nil {
					t.Fatal(err)
				}
				exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
				if err != nil {
					t.Fatal(err)
				}
				if refErr == nil {
					if current.State != "committed" || refs < 1 || !exists {
						t.Fatalf("successful reference lost resource: state=%s refs=%d exists=%v", current.State, refs, exists)
					}
				} else if current.State != "deleted" || refs != 0 || exists {
					t.Fatalf("cleanup winner left dangling resource: state=%s refs=%d exists=%v error=%v", current.State, refs, exists, refErr)
				}
				if refErr != nil && (strings.Contains(strings.ToLower(refErr.Error()), "deadlock") || errors.Is(refErr, context.DeadlineExceeded)) {
					t.Fatalf("reference deadlocked: %v", refErr)
				}
				t.Logf("reference_succeeded=%v resource=%s references=%d real_object_exists=%v", refErr == nil, current.State, refs, exists)
			})
		}
	}
	t.Run("migration_validation", func(t *testing.T) {
		verifyChatMediaMigration(t, ctx, db, store, svc)
	})
	t.Run("slow_cleanup_and_recovery", func(t *testing.T) {
		verifyChatWorkerRecovery(t, ctx, db, store, d)
	})
	t.Run("dispatch_claim_and_ack_faults", func(t *testing.T) {
		verifyChatDispatchFaultBoundaries(t, ctx, db, d)
	})
	t.Run("two_worker_dispatch_and_quota", func(t *testing.T) {
		verifyChatWorkerScheduling(t, ctx, db)
	})
	t.Run("sustained_arrival_scheduling", func(t *testing.T) {
		verifyChatSustainedScheduling(t, ctx, db)
	})
	t.Run("concurrent_pending_admission", func(t *testing.T) {
		verifyChatPendingAdmission(t, ctx, db)
	})
	t.Run("answer_version_competing_tabs", func(t *testing.T) {
		verifyChatAnswerVersionCompetition(t, ctx, db)
	})
	t.Run("cancel_completion_competition", func(t *testing.T) {
		verifyChatCancelCompletionCompetition(t, ctx, db)
	})
	t.Run("staging_orphan_and_cleanup_commit_failure", func(t *testing.T) {
		verifyChatMediaCleanupCommitFailure(t, ctx, db, store, d)
	})
	t.Run("storage_remove_failure_and_retry", func(t *testing.T) {
		verifyChatMediaStorageRemovalFailure(t, ctx, db, store, d)
	})
	t.Run("event_backlog_gap_and_permissions", func(t *testing.T) {
		verifyChatTaskEventRecovery(t, ctx, db, svc, d)
	})
	t.Run("diagnostics_consistent_snapshot", func(t *testing.T) {
		verifyChatTaskDiagnosticsSnapshot(t, ctx, db, svc, d)
	})
	t.Run("operational_statistics", func(t *testing.T) {
		verifyChatTaskOperationalStatistics(t, ctx, db, store, d)
	})
}

func verifyChatTaskEventRecovery(t *testing.T, ctx context.Context, db *gorm.DB, svc *ChatSessionService, d *dao.ChatTaskDAO) {
	t.Helper()
	chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	id := common.GenerateToken()
	task, _, err := d.Submit(ctx, &entity.ChatTask{
		ID: id, TenantID: "owner", UserID: "owner", ChatID: chat.ID, SessionID: session.ID,
		TurnID: common.GenerateToken(), Kind: "voice", IdempotencyKey: id,
		InputHash: strings.Repeat("b", 64), MaxCalls: 10, MaxStageCalls: 5, MaxSwitches: 1,
		QueueDeadline: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(2 * time.Minute).UnixMilli(),
	}, 1000, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err = d.Claim(ctx, task.ID, "event-recovery", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for range 205 {
		if err := d.Mutate(ctx, task.ID, task.LeaseOwner, task.LeaseEpoch, "stage_changed",
			func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
				current.Stage = "text"
				return entity.JSONMap{"stage": current.Stage}, nil
			}); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Mutate(ctx, task.ID, task.LeaseOwner, task.LeaseEpoch, "task_terminal",
		func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
			current.State, current.Stage = "succeeded", "complete"
			return entity.JSONMap{"state": current.State}, nil
		}); err != nil {
		t.Fatal(err)
	}
	read := func(after int64) map[string]interface{} {
		t.Helper()
		result, err := svc.ChatTaskEvents(ctx, task.ID, after)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	cursor, pages, count := int64(0), 0, 0
	for {
		page := read(cursor)
		snapshot := page["task"].(*entity.ChatTask)
		events := page["events"].([]entity.ChatTaskEvent)
		if page["reset"] != false || snapshot.State != "succeeded" || len(events) == 0 || len(events) > 100 {
			t.Fatal("terminal backlog did not retain a complete paginated event history")
		}
		for _, event := range events {
			if event.Seq != cursor+1 || event.TaskRevision > snapshot.Revision {
				t.Fatal("event pagination skipped or replayed an event")
			}
			cursor = event.Seq
			count++
		}
		pages++
		if page["next_seq"] != cursor || page["last_seq"] != snapshot.EventSeq {
			t.Fatal("event cursor did not match authoritative snapshot")
		}
		if cursor == snapshot.EventSeq {
			break
		}
		if pages > 3 {
			t.Fatal("event backlog never drained")
		}
	}
	if pages != 3 || count != 208 || len(read(cursor)["events"].([]entity.ChatTaskEvent)) != 0 {
		t.Fatalf("unexpected real event backlog: pages=%d events=%d", pages, count)
	}
	page := read(cursor + 10)
	if page["reset"] != true || page["next_seq"] != cursor {
		t.Fatal("future cursor did not reset to snapshot")
	}
	if _, err := svc.ChatTaskEvents(ctx, task.ID, -1); err == nil {
		t.Fatal("negative cursor was accepted")
	}
	// Remove one persisted event to exercise an actual gap inside a full page.
	if err := db.Where("task_id = ? AND seq = ?", task.ID, 51).Delete(&entity.ChatTaskEvent{}).Error; err != nil {
		t.Fatal(err)
	}
	for _, after := range []int64{0, 50} {
		page := read(after)
		if page["reset"] != true || page["next_seq"] != cursor || len(page["events"].([]entity.ChatTaskEvent)) != 0 {
			t.Fatalf("persisted event gap after %d did not reset to authoritative snapshot", after)
		}
	}
	other := permission.WithIdentity(ctx, "other", "other")
	if _, err := svc.ChatTaskEvents(other, task.ID, 0); err == nil {
		t.Fatal("cross-tenant event access succeeded")
	}
	if err := db.Model(chat).Update("status", "0").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ChatTaskEvents(ctx, task.ID, cursor); err == nil {
		t.Fatal("revoked chat still exposed cached-cursor task events")
	}
	t.Logf("PASS real MySQL events=%d pages=%d: terminal backlog drained; future/internal-gap cursors reset; negative cursor rejected; cross-tenant and revoked access denied", count, pages)
}

func verifyChatMediaCleanupCommitFailure(t *testing.T, ctx context.Context, db *gorm.DB, store storage.Storage, d *dao.ChatTaskDAO) {
	t.Helper()
	id := common.GenerateToken()
	task := entity.ChatTask{ID: common.GenerateToken(), TenantID: "owner", UserID: "owner",
		State: "running", UpstreamStatus: "unknown", InputHash: id, IdempotencyKey: id}
	asset := entity.ChatMediaAsset{ID: id, SourceKey: id, TenantID: "owner", TaskID: task.ID,
		State: "staging", Kind: "audio", Bucket: chatMediaBucket, ObjectKey: "cleanup-fault/" + id + ".wav", CreatedAt: 1}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, chatWAV()); err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(ctx, store, 0, 100); err != nil {
		t.Fatal(err)
	}
	var journal entity.ChatMediaCleanup
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil {
		t.Fatal("scanner did not discover the unreferenced staging object")
	}
	exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	if err != nil || !exists || journal.Attempts != 0 || journal.State != "pending" {
		t.Fatal("cleanup removed an active or unknown task's staged output")
	}
	if err := db.Model(&task).Updates(map[string]any{"state": "failed", "upstream_status": "stopped"}).Error; err != nil {
		t.Fatal(err)
	}
	trigger := "chat_test_cleanup_" + common.GenerateToken()
	if err := db.Exec(fmt.Sprintf(`CREATE TRIGGER %s BEFORE UPDATE ON chat_media_cleanup FOR EACH ROW
BEGIN
IF OLD.id = '%s' AND NEW.state = 'done' THEN
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated cleanup bookkeeping fault';
END IF;
END`, trigger, journal.ID)).Error; err != nil {
		t.Fatal("cannot inject isolated cleanup bookkeeping failure")
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := db.WithContext(cleanupCtx).Exec("DROP TRIGGER IF EXISTS " + trigger).Error; err != nil {
			t.Error("cannot remove test-owned cleanup trigger")
		}
	}()
	if err := db.Model(&journal).Update("next_run_at", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.CleanupMedia(ctx, store, 0, 100); err == nil || !strings.Contains(err.Error(), "isolated cleanup bookkeeping fault") {
		t.Fatalf("expected injected bookkeeping rejection, got %v", err)
	}
	if err := db.Take(&asset, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	exists, err = store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	if err != nil || exists || asset.State != "deleting" || journal.State != "removing" || journal.Attempts != 1 {
		t.Fatalf("failed bookkeeping lost retryable deletion fence: exists=%t asset=%s journal=%s attempts=%d",
			exists, asset.State, journal.State, journal.Attempts)
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		return dao.RegisterChatMediaInputs(ctx, tx, "", nil,
			entity.ChatMediaReference{AssetID: id, OwnerKind: "task", OwnerID: task.ID})
	})
	if !errors.Is(err, dao.ErrChatMediaReclaimed) {
		t.Fatalf("physically deleted asset accepted a new reference: %v", err)
	}
	if err := db.Exec("DROP TRIGGER " + trigger).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&journal).Update("next_run_at", 0).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := d.CleanupMedia(ctx, store, 0, 100); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Take(&asset, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Take(&journal, "asset_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if asset.State != "deleted" || journal.State != "done" || journal.Attempts != 2 || journal.LastError != "" {
		t.Fatal("cleanup did not finish exactly once after bookkeeping recovered")
	}
	t.Log("PASS real MySQL/MinIO: orphan discovered; unknown task retained; physical deletion succeeded despite bookkeeping rollback; new references fenced; retry finalized deletion; repeated cleanup unchanged")
}

func verifyChatAnswerVersionCompetition(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	_, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	history := dao.NewChatSessionDAO()
	turn := common.GenerateToken()
	if err := history.UpdateByID(ctx, db, session.ID, map[string]interface{}{
		"history_update": dao.ConversationHistoryUpdate{Message: map[string]interface{}{
			"id": turn, "role": "user", "content": "question"}},
	}); err != nil {
		t.Fatal(err)
	}
	first := map[string]interface{}{"id": turn, "role": "assistant", "content": "same text"}
	if err := history.UpdateByID(ctx, db, session.ID, map[string]interface{}{
		"history_update": dao.ConversationHistoryUpdate{QuestionID: turn, Message: first, ExpectedAbsent: true},
	}); err != nil {
		t.Fatal(err)
	}
	version := first["answer_version"].(int64)
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, citation := range []string{"tab-a", "tab-b"} {
		go func(citation string) {
			<-start
			answer := map[string]interface{}{"id": turn, "role": "assistant", "content": "same text",
				"reference":    map[string]interface{}{"chunks": []string{citation}},
				"media_assets": []string{citation + "-media"}}
			results <- history.UpdateByID(ctx, db, session.ID, map[string]interface{}{
				"history_update": dao.ConversationHistoryUpdate{QuestionID: turn, Message: answer, ExpectedVersion: &version},
			})
		}(citation)
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			successes++
		case errors.Is(err, dao.ErrAnswerVersion):
			conflicts++
		default:
			t.Fatalf("competing version write failed/deadlocked: %v", err)
		}
	}
	var winner entity.ConversationMessage
	if err := db.Take(&winner, "conversation_id = ? AND message_id = ? AND role = ?", session.ID, turn, "assistant").Error; err != nil {
		t.Fatal(err)
	}
	if successes != 1 || conflicts != 1 || winner.AnswerVersion != version+1 ||
		(!strings.Contains(string(winner.Reference), "tab-a") && !strings.Contains(string(winner.Reference), "tab-b")) ||
		!strings.Contains(winner.Metadata, "-media") {
		t.Fatalf("version competition lost atomic citation/media write: success=%d conflict=%d version=%d", successes, conflicts, winner.AnswerVersion)
	}
	if err := history.UpdateByID(ctx, db, session.ID, map[string]interface{}{
		"history_update": dao.ConversationHistoryUpdate{QuestionID: turn, Message: first, ExpectedVersion: &version},
	}); !errors.Is(err, dao.ErrAnswerVersion) {
		t.Fatalf("late old-task write was accepted: %v", err)
	}
	var after entity.ConversationMessage
	if err := db.Take(&after, "conversation_id = ? AND position = ?", session.ID, winner.Position).Error; err != nil ||
		after.AnswerVersion != winner.AnswerVersion || string(after.Reference) != string(winner.Reference) || after.Metadata != winner.Metadata {
		t.Fatal("late write changed the winning reference or media")
	}
	t.Logf("PASS real MySQL competing tabs: same text, different citations/media; success=1 conflict=1 version=%d; late checkpoint rejected", winner.AnswerVersion)
}

func verifyChatPendingAdmission(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	for _, scope := range []string{"user", "tenant"} {
		t.Run(scope, func(t *testing.T) {
			tenantID := common.GenerateToken()
			if err := db.Create(&entity.Tenant{ID: tenantID}).Error; err != nil {
				t.Fatal(err)
			}
			var isolation string
			if err := db.Raw("SELECT @@transaction_isolation").Scan(&isolation).Error; err != nil || isolation != "REPEATABLE-READ" {
				t.Fatalf("expected real repeatable-read isolation: %s err=%v", isolation, err)
			}
			tasks := make([]*entity.ChatTask, 2)
			for i := range tasks {
				chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
				id := common.GenerateToken()
				userID := tenantID
				if scope == "tenant" {
					userID = common.GenerateToken()
				}
				now := time.Now().UnixMilli()
				tasks[i] = &entity.ChatTask{ID: id, TenantID: tenantID, UserID: userID,
					ChatID: chat.ID, SessionID: session.ID, TurnID: id, Kind: "语音",
					IdempotencyKey: id, InputHash: strings.Repeat("b", 64), Input: "{}",
					MaxCalls: 4, MaxStageCalls: 2, MaxSwitches: 1,
					QueueDeadline: now + 60000, Deadline: now + 120000}
			}
			snapshots := make(chan struct{}, 2)
			entrants := make(chan struct{}, 2)
			release := make(chan struct{})
			callback := "chat_admission_snapshot_" + common.GenerateToken()
			if err := db.Callback().Create().Before("gorm:create").Register(callback, func(tx *gorm.DB) {
				resource, ok := tx.Statement.Dest.(*entity.ChatTaskResource)
				if tx.Statement.Context.Value(chatReservationSnapshotKey{}) == callback &&
					ok && resource.ID == "chat:media:maintenance" {
					entrants <- struct{}{}
				}
			}); err != nil {
				t.Fatal(err)
			}
			defer db.Callback().Create().Remove(callback)
			if err := db.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
				if tx.Statement.Context.Value(chatReservationSnapshotKey{}) != callback ||
					tx.Statement.Table != (entity.ChatTask{}).TableName() ||
					!strings.Contains(tx.Statement.SQL.String(), "idempotency_key") {
					return
				}
				// Hold the first admitted transaction after its consistent read.
				// The second must wait on the real maintenance admission lock.
				snapshots <- struct{}{}
				select {
				case <-release:
				case <-tx.Statement.Context.Done():
					tx.AddError(tx.Statement.Context.Err())
				}
			}); err != nil {
				t.Fatal(err)
			}
			defer db.Callback().Query().Remove(callback)
			admissionCtx := context.WithValue(ctx, chatReservationSnapshotKey{}, callback)
			results := make(chan error, 2)
			userLimit, tenantLimit := 1, 10
			if scope == "tenant" {
				userLimit, tenantLimit = 10, 1
			}
			for _, task := range tasks {
				go func() {
					_, _, err := dao.NewChatTaskDAO(db).Submit(admissionCtx, task, userLimit, tenantLimit, nil)
					results <- err
				}()
			}
			for range 2 {
				select {
				case <-entrants:
				case <-ctx.Done():
					t.Fatal("both concurrent submissions did not reach admission")
				}
			}
			select {
			case <-snapshots:
			case <-ctx.Done():
				t.Fatal("first admission did not reach the input lookup")
			}
			close(release)
			accepted, rejected := 0, 0
			for range 2 {
				select {
				case err := <-results:
					switch {
					case err == nil:
						accepted++
					case errors.Is(err, dao.ErrChatTaskQuota):
						rejected++
					default:
						t.Fatalf("admission failed or deadlocked: %v", err)
					}
				case <-ctx.Done():
					t.Fatal("admission transactions did not complete")
				}
			}
			var count int64
			if err := db.Model(&entity.ChatTask{}).Where("tenant_id = ?", tenantID).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if accepted != 1 || rejected != 1 || count != 1 {
				t.Fatalf("pending quota overbooked: accepted=%d rejected=%d persisted=%d", accepted, rejected, count)
			}
			t.Log("two concurrent submissions at real repeatable-read isolation: maintenance lock serializes snapshots; exactly one accepted and one quota rejection")
		})
	}
}

func verifyChatWorkerScheduling(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	queue := chatqueue.NewNatsEngine("ragflow-chat-test-nats", 4222)
	if err := queue.Init(); err != nil {
		t.Fatal(err)
	}
	namespace := "SCHEDULE_" + common.GenerateToken()
	if err := queue.InitChatTasks(ctx, namespace, namespace, time.Minute, 5); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Namespace, cfg.Consumer = namespace, namespace
	cfg.Scan, cfg.AckWait, cfg.PriorityWait = 50*time.Millisecond, time.Minute, time.Second
	_, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	first, second := dao.NewChatTaskDAO(db), dao.NewChatTaskDAO(db.Session(&gorm.Session{NewDB: true}))
	device := "verify-device-" + common.GenerateToken()
	if err := first.EnsureResource(ctx, device, 1); err != nil {
		t.Fatal(err)
	}
	submit := func(mode string) *entity.ChatTask {
		t.Helper()
		id := common.GenerateToken()
		input := &chatTaskInput{Kind: "语音", Options: map[string]interface{}{"mode": mode}}
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UnixMilli()
		task, _, err := first.Submit(ctx, &entity.ChatTask{ID: id, TenantID: "owner", UserID: "owner",
			SessionID: session.ID, ChatID: session.DialogID, TurnID: id, Kind: "语音", Input: string(raw),
			SchedulingClass: chatTaskSchedulingClass(input), InputHash: strings.Repeat("a", 64), IdempotencyKey: id,
			MaxCalls: 8, MaxStageCalls: 4, MaxSwitches: 1, QueueDeadline: now + 60000, Deadline: now + 120000}, 100, 100, nil)
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	long := submit("music")
	if long.SchedulingClass != "normal" {
		t.Fatal("real singing input received interactive priority")
	}
	if err := db.Model(long).Update("created_at", long.CreatedAt-2*cfg.PriorityWait.Milliseconds()).Error; err != nil {
		t.Fatal(err)
	}
	// Arrivals keep coming, but the aged long task keeps its place.
	ids := map[string]bool{long.ID: true}
	for range 12 {
		short := submit("voice")
		ids[short.ID] = true
		tasks, err := first.Dispatchable(ctx, 1000, cfg.PriorityWait)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range tasks {
			if !ids[task.ID] {
				continue
			}
			if task.ID != long.ID {
				t.Fatal("new short task displaced the aged singing task")
			}
			break
		}
	}
	workerA := &ChatTaskWorker{config: cfg, dao: first, queue: queue, id: common.GenerateToken()}
	workerB := &ChatTaskWorker{config: cfg, dao: second, queue: queue, id: common.GenerateToken()}
	runCtx, stop := context.WithCancel(ctx)
	defer func() { stop(); workerA.wg.Wait(); workerB.wg.Wait() }()
	for _, worker := range []*ChatTaskWorker{workerA, workerB} {
		worker.wg.Add(1)
		go worker.scan(runCtx)
	}
	var selected []string
	for len(selected) < 2 {
		msg, err := queue.PullChatTask(ctx, namespace, namespace)
		if err != nil || msg == nil {
			t.Fatalf("real dispatch missing: %v", err)
		}
		id := string(msg.Data())
		if err := msg.Ack(); err != nil {
			t.Fatal(err)
		}
		if !ids[id] || len(selected) == 1 && selected[0] == id {
			continue
		}
		selected = append(selected, id)
	}
	if selected[0] != long.ID {
		t.Fatal("broker dispatch order lost aged task preference")
	}
	stop()
	workerA.wg.Wait()
	workerB.wg.Wait()
	long, err = first.Claim(ctx, selected[0], workerA.id, time.Minute)
	if err != nil || long == nil {
		t.Fatalf("first executor claim: %v", err)
	}
	short, err := second.Claim(ctx, selected[1], workerB.id, time.Minute)
	if err != nil || short == nil {
		t.Fatalf("second executor claim: %v", err)
	}
	type reservation struct {
		attempt *entity.ChatTaskAttempt
		err     error
	}
	snapshots := make(chan struct{}, 2)
	releaseSnapshots := make(chan struct{})
	callback := "chat_quota_snapshot_" + common.GenerateToken()
	if err := db.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
		if tx.Error != nil || tx.Statement.Context.Value(chatReservationSnapshotKey{}) != callback ||
			tx.Statement.Table != (entity.ChatTaskAttempt{}).TableName() ||
			!strings.Contains(strings.ToLower(tx.Statement.SQL.String()), "count(") {
			return
		}
		// Both real COUNT queries establish their snapshots before either
		// transaction may acquire the shared resource mutex.
		snapshots <- struct{}{}
		select {
		case <-releaseSnapshots:
		case <-tx.Statement.Context.Done():
			tx.AddError(tx.Statement.Context.Err())
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove(callback)
	reserveCtx := context.WithValue(ctx, chatReservationSnapshotKey{}, callback)
	start := make(chan struct{})
	results := make(chan reservation, 2)
	for i, executor := range []*ChatTaskWorker{workerA, workerB} {
		task := []*entity.ChatTask{long, short}[i]
		go func() {
			<-start
			attempt, err := executor.dao.ReserveCall(reserveCtx, task.ID, executor.id, task.LeaseEpoch,
				dao.ChatTaskCall{Stage: "music", Model: "real-device-quota", Resources: []string{device}})
			results <- reservation{attempt, err}
		}()
	}
	close(start)
	for range 2 {
		select {
		case <-snapshots:
		case <-ctx.Done():
			t.Fatal("both real reservation snapshots were not established")
		}
	}
	close(releaseSnapshots)
	var winner *entity.ChatTaskAttempt
	for range 2 {
		result := <-results
		if result.err == nil {
			if winner != nil {
				t.Fatal("two executors overbooked one device")
			}
			winner = result.attempt
		} else if !errors.Is(result.err, dao.ErrChatTaskQuota) {
			t.Fatalf("resource race failed or deadlocked: %v", result.err)
		}
	}
	if winner == nil {
		t.Fatal("neither executor acquired device")
	}
	winnerTask, winnerWorker, loserTask, loserWorker := long, workerA, short, workerB
	if winner.TaskID == short.ID {
		winnerTask, winnerWorker, loserTask, loserWorker = short, workerB, long, workerA
	}
	var held int64
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("resource_id = ?", device).Count(&held).Error; err != nil || held != 1 {
		t.Fatalf("device held=%d err=%v", held, err)
	}
	// A local lease expiry while upstream is unknown must not free the GPU.
	if err := db.Model(winnerTask).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := first.RecoverExpired(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := loserWorker.dao.ReserveCall(ctx, loserTask.ID, loserWorker.id, loserTask.LeaseEpoch,
		dao.ChatTaskCall{Stage: "music", Model: "real-device-quota", Resources: []string{device}}); !errors.Is(err, dao.ErrChatTaskQuota) {
		t.Fatalf("unknown upstream released device: %v", err)
	}
	if err := winnerWorker.dao.ReconcileStopped(ctx, winnerTask.ID, "integration-upstream-stopped-confirmation"); err != nil {
		t.Fatal(err)
	}
	if _, err := loserWorker.dao.ReserveCall(ctx, loserTask.ID, loserWorker.id, loserTask.LeaseEpoch,
		dao.ChatTaskCall{Stage: "music", Model: "real-device-quota", Resources: []string{device}}); err != nil {
		t.Fatalf("confirmed stop did not release device: %v", err)
	}
	t.Log("two real Worker dispatch loops/NATS; 12 short arrivals cannot displace aged music; two pre-lock MySQL snapshots=1 winner/1 quota rejection; unknown retains GPU until confirmed stop")
}

func verifyChatSustainedScheduling(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	_, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	d := dao.NewChatTaskDAO(db)
	submit := func(mode string) *entity.ChatTask {
		t.Helper()
		input := &chatTaskInput{Kind: "语音", Options: map[string]interface{}{"mode": mode}}
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		id, now := common.GenerateToken(), time.Now().UnixMilli()
		task, _, err := d.Submit(ctx, &entity.ChatTask{
			ID: id, TenantID: "owner", UserID: "owner", ChatID: session.DialogID,
			SessionID: session.ID, TurnID: id, Kind: input.Kind, Input: string(raw),
			SchedulingClass: chatTaskSchedulingClass(input), InputHash: strings.Repeat("a", 64), IdempotencyKey: id,
			MaxCalls: 8, MaxStageCalls: 4, MaxSwitches: 1,
			QueueDeadline: now + 60000, Deadline: now + 120000,
		}, 250, 250, nil)
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	defer func() {
		var remaining []entity.ChatTask
		if err := db.Where("session_id = ? AND state = ?", session.ID, "queued").Find(&remaining).Error; err != nil {
			t.Error("cannot read remaining scheduling test tasks")
			return
		}
		for _, task := range remaining {
			if _, err := d.Cancel(ctx, task.ID); err != nil {
				t.Error("cannot cancel remaining scheduling test task")
			}
		}
	}()
	long := submit("music")
	for range 4 {
		submit("voice")
	}
	const priorityWait = time.Second
	const arrivalWindow = 3500 * time.Millisecond
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	started := time.Now()
	var longWait time.Duration
	arrivals, shortClaims, arrivalsAtClaim := 0, 0, 0
	for time.Since(started) < arrivalWindow {
		select {
		case <-ctx.Done():
			t.Fatal("continuous scheduling verification timed out")
		case <-ticker.C:
		}
		submit("voice")
		arrivals++
		if arrivals%2 != 0 {
			continue
		}
		// Service one waiting task per two arrivals so the queue cannot drain
		// before the long task naturally ages. Production ordering is unmodified.
		tasks, err := d.Dispatchable(ctx, 1000, priorityWait)
		if err != nil {
			t.Fatal(err)
		}
		var selected *entity.ChatTask
		for i := range tasks {
			if tasks[i].SessionID == session.ID {
				selected = &tasks[i]
				break
			}
		}
		if selected == nil {
			t.Fatal("continuous arrivals disappeared from the durable queue")
		}
		claimed, err := d.Claim(ctx, selected.ID, "sustained-scheduling", time.Minute)
		if err != nil || claimed == nil {
			t.Fatalf("ordered task could not be claimed: %v", err)
		}
		if claimed.ID == long.ID {
			longWait, arrivalsAtClaim = time.Since(started), arrivals
		} else {
			shortClaims++
		}
		if _, err := d.Cancel(ctx, claimed.ID); err != nil {
			t.Fatal(err)
		}
		if err := d.Mutate(ctx, claimed.ID, "sustained-scheduling", claimed.LeaseEpoch, "task_terminal",
			func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
				task.State = "cancelled"
				return entity.JSONMap{"state": task.State}, nil
			}); err != nil {
			t.Fatal(err)
		}
	}
	if arrivals < 50 || shortClaims < 20 || longWait < priorityWait ||
		longWait >= arrivalWindow || arrivalsAtClaim >= arrivals {
		t.Fatalf("long task did not receive a bounded turn during sustained arrivals: arrivals=%d short_claims=%d wait=%s arrivals_at_claim=%d",
			arrivals, shortClaims, longWait, arrivalsAtClaim)
	}
	t.Logf("real MySQL admission/dispatch/claim: %d continuous short arrivals over %s, %d short claims; unmodified long-task timestamp aged naturally and claimed after %s; arrivals continued afterward",
		arrivals, arrivalWindow, shortClaims, longWait)
}

func integrationChatSession(t *testing.T, ctx context.Context, db *gorm.DB, id string) (*entity.Chat, *entity.ChatSession) {
	t.Helper()
	chat := &entity.Chat{ID: common.GenerateToken(), TenantID: "owner", UserID: "owner", Status: strPtr("1"),
		LLMSetting: entity.JSONMap{}, PromptConfig: entity.JSONMap{}, KBIDs: entity.JSONSlice{}}
	if err := db.Create(chat).Error; err != nil {
		t.Fatal(err)
	}
	session := &entity.ChatSession{ID: id, DialogID: chat.ID, UserID: strPtr("owner"), Message: json.RawMessage(`[]`)}
	if err := dao.NewChatSessionDAO().Create(ctx, db, session); err != nil {
		t.Fatal(err)
	}
	return chat, session
}

func verifyChatMediaMigration(t *testing.T, ctx context.Context, db *gorm.DB, store storage.Storage, svc *ChatSessionService) {
	t.Helper()
	t.Cleanup(func() {
		if err := dao.SetChatMediaMaintenance(context.Background(), db, false); err != nil {
			t.Error(err)
		}
	})
	chat, session := integrationChatSession(t, ctx, db, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
	turn := common.GenerateToken()
	ids := []string{common.GenerateToken(), common.GenerateToken(), common.GenerateToken(), common.GenerateToken()}
	content := "historical audio"
	for _, id := range ids {
		content += fmt.Sprintf("\n[audio](/api/v1/chats/%s/sessions/%s/media/%s.wav)", chat.ID, session.ID, id)
	}
	role := "assistant"
	message := &entity.ConversationMessage{ConversationID: session.ID, Position: 2,
		ConversationMessageFields: entity.ConversationMessageFields{MessageID: &turn, Role: &role, Content: &content}}
	if err := db.Create(message).Error; err != nil {
		t.Fatal(err)
	}
	for i, id := range ids[:3] {
		data := chatWAV()
		if i == 2 {
			data = []byte("RIFF0000WAVE")
		}
		if err := store.Put(ctx, chatMediaBucket, session.ID+"/"+id+".wav", data); err != nil {
			t.Fatal(err)
		}
	}
	cursor := strings.Repeat("z", 31) + "y"
	dry, err := MigrateChatMedia(ctx, db, store, false, cursor, 1)
	if err != nil || dry.Messages != 1 || dry.Recognized != 4 || dry.Linked != 2 || dry.Missing != 1 ||
		dry.Manual != 1 || dry.Failures != 0 || !dry.Done || dry.Cursor != session.ID {
		t.Fatalf("dry run does not reconcile: %+v %v", dry, err)
	}
	var count int64
	if err := db.Model(&entity.ChatMediaAsset{}).Where("session_id = ?", session.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("dry run wrote assets: %d %v", count, err)
	}
	// A reordered message must still be identified by its stable turn.
	if err := db.Model(message).Update("position", 7).Error; err != nil {
		t.Fatal(err)
	}
	var before entity.ConversationMessage
	if err := db.Take(&before, "conversation_id = ? AND position = ?", session.ID, 7).Error; err != nil {
		t.Fatal(err)
	}
	trigger := "migration_fault_" + common.GenerateToken()
	if err := db.Exec("CREATE TRIGGER " + trigger + " BEFORE UPDATE ON conversation_message FOR EACH ROW " +
		"BEGIN IF NEW.conversation_id = '" + session.ID + "' AND NEW.answer_version > OLD.answer_version THEN " +
		"SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated migration commit fault'; END IF; END").Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Exec("DROP TRIGGER IF EXISTS " + trigger).Error; err != nil {
			t.Error(err)
		}
	})
	failed, err := MigrateChatMedia(ctx, db, store, true, cursor, 1)
	if err != nil || failed.Linked != 0 || failed.AlreadyLinked != 0 || failed.Failures != 2 ||
		failed.Manual != 1 || failed.Missing != 1 || failed.Cursor != session.ID {
		t.Fatalf("failed migration did not reconcile the real transaction failures: %+v %v", failed, err)
	}
	associationFailures := 0
	for _, issue := range failed.Issues {
		if issue.Code == "association_failed" {
			associationFailures++
			if issue.SessionID != session.ID || issue.TurnID != turn || (issue.AssetID != ids[0] && issue.AssetID != ids[1]) {
				t.Fatal("migration failure omitted the stable identity needed for recovery")
			}
		}
	}
	if associationFailures != 2 {
		t.Fatal("migration did not retain both failed asset identities for operator recovery")
	}
	for _, check := range []struct {
		model any
		key   string
	}{{&entity.ChatMediaAsset{}, "id"}, {&entity.ChatMediaReference{}, "asset_id"}} {
		if err := db.Model(check.model).Where(check.key+" IN ?", ids).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("failed migration left committed assets or references: %T count=%d", check.model, count)
		}
	}
	var rolledBack entity.ConversationMessage
	if err := db.Take(&rolledBack, "conversation_id = ? AND position = ?", session.ID, 7).Error; err != nil ||
		rolledBack.Metadata != before.Metadata || rolledBack.AnswerVersion != before.AnswerVersion ||
		rolledBack.Content == nil || *rolledBack.Content != content {
		t.Fatalf("failed migration changed history or answer version: %v", err)
	}
	for _, id := range ids[:2] {
		data, err := storage.GetBounded(ctx, store, chatMediaBucket, session.ID+"/"+id+".wav", chatMediaMaxBytes)
		if err != nil || sha256.Sum256(data) != sha256.Sum256(chatWAV()) {
			t.Fatalf("failed migration lost or modified an original MinIO object: %v", err)
		}
	}
	if err := db.Exec("DROP TRIGGER " + trigger).Error; err != nil {
		t.Fatal(err)
	}
	executed, err := MigrateChatMedia(ctx, db, store, true, cursor, 1)
	if err != nil || executed.Linked != 2 || executed.Manual != 1 || executed.Missing != 1 || executed.Failures != 0 {
		t.Fatalf("execute does not reconcile: %+v %v", executed, err)
	}
	again, err := MigrateChatMedia(ctx, db, store, true, cursor, 1)
	if err != nil || again.Linked != 0 || again.AlreadyLinked != 2 || again.Failures != 0 {
		t.Fatalf("migration is not idempotent: %+v %v", again, err)
	}
	var assets []entity.ChatMediaAsset
	if err := db.Where("session_id = ?", session.ID).Find(&assets).Error; err != nil || len(assets) != 2 {
		t.Fatalf("invalid/missing audio was registered: assets=%d %v", len(assets), err)
	}
	for _, asset := range assets {
		if asset.DurationMs <= 0 || asset.State != "committed" || asset.TurnID != turn {
			t.Fatalf("invalid migrated audio: %+v", asset)
		}
		if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ? AND owner_kind = ? AND owner_id = ?",
			asset.ID, "message", session.ID+":"+turn).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("wrong message association: %d %v", count, err)
		}
	}
	var reloaded entity.ConversationMessage
	if err := db.Take(&reloaded, "conversation_id = ? AND position = ?", session.ID, 7).Error; err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		Assets []map[string]interface{} `json:"media_assets"`
	}
	if err := json.Unmarshal([]byte(reloaded.Metadata), &metadata); err != nil || len(metadata.Assets) != 2 || *reloaded.Content != content || reloaded.AnswerVersion != 2 {
		t.Fatalf("migration changed prose or duplicated metadata: %+v %v", metadata, err)
	}
	_, err = svc.submitChatMedia(ctx, chat, session, []map[string]interface{}{{"id": common.GenerateToken(),
		"role": "user", "content": "question"}}, common.GenerateToken(), "语音", "question", nil)
	if !errors.Is(err, dao.ErrChatMediaMaintenance) {
		t.Fatalf("maintenance admitted a media write: %v", err)
	}
	if err := dao.SetChatMediaMaintenance(ctx, db, false); err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateChatMedia(ctx, db, store, true, cursor, 1); err == nil {
		t.Fatal("execute accepted an unfrozen database")
	}
	t.Log("dry-run=4 recognized/2 eligible/1 invalid/1 missing; SQL commit failure rolled back both assets/references/answer versions without changing original objects; replay from original cursor=2 linked; repeat=0 new/2 existing; stable turn survived position change; freeze admission enforced")
}

func verifyChatWorkerRecovery(t *testing.T, ctx context.Context, db *gorm.DB, store storage.Storage, d *dao.ChatTaskDAO) {
	t.Helper()
	queue := chatqueue.NewNatsEngine("ragflow-chat-test-nats", 4222)
	if err := queue.Init(); err != nil {
		t.Fatal(err)
	}
	namespace := "VERIFY_" + common.GenerateToken()
	if err := queue.InitChatTasks(ctx, namespace, namespace, 250*time.Millisecond, 5); err != nil {
		t.Fatal(err)
	}
	chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	submit := func() *entity.ChatTask {
		t.Helper()
		id := common.GenerateToken()
		now := time.Now().UnixMilli()
		task, _, err := d.Submit(ctx, &entity.ChatTask{ID: id, TenantID: "owner", UserID: "owner",
			SessionID: session.ID, ChatID: chat.ID, TurnID: id, Kind: "voice", Input: "{}",
			InputHash: strings.Repeat("a", 64), IdempotencyKey: id,
			MaxCalls: 8, MaxStageCalls: 4, MaxSwitches: 1, QueueDeadline: now + 60000, Deadline: now + 120000}, 100, 100, nil)
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	task := submit()
	asset := &entity.ChatMediaAsset{ID: common.GenerateToken(), SourceKey: common.GenerateToken(),
		Kind: "audio", State: "staging", CreatedAt: 1, Bucket: chatMediaBucket, ObjectKey: "verify/" + common.GenerateToken()}
	if err := db.Create(asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, chatWAV()); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Namespace, cfg.Consumer = namespace, namespace
	cfg.Scan, cfg.Lease, cfg.AckWait, cfg.CleanupGrace = 50*time.Millisecond, time.Second, time.Minute, 0
	worker := &ChatTaskWorker{config: cfg, dao: d, queue: queue, id: common.GenerateToken()}
	slow := &chatIntegrationRemoval{Storage: store, started: make(chan struct{}), release: make(chan struct{})}
	runCtx, stop := context.WithCancel(ctx)
	defer func() { stop(); worker.wg.Wait() }()
	worker.wg.Add(1)
	go worker.cleanup(runCtx, slow)
	select {
	case <-slow.started:
	case <-ctx.Done():
		t.Fatal("cleanup never reached real MinIO")
	}
	worker.wg.Add(1)
	go worker.scan(runCtx)
	// No consumer executes a model in this test; the real broker must redeliver
	// the same unacknowledged wakeup while the independent dispatcher stays live.
	for {
		msg, err := queue.PullChatTask(ctx, namespace, namespace)
		if err != nil || msg == nil {
			t.Fatalf("real NATS dispatch failed: %v", err)
		}
		if string(msg.Data()) == task.ID {
			break
		}
		if err := msg.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	timer := time.NewTimer(3 * cfg.Lease)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		t.Fatal("heartbeat verification cancelled")
	}
	var heartbeat entity.ChatTaskWorker
	if err := db.Take(&heartbeat, "id = ?", worker.id).Error; err != nil || heartbeat.LeaseUntil <= time.Now().UnixMilli() {
		t.Fatalf("slow real storage expired worker heartbeat: %+v %v", heartbeat, err)
	}
	for {
		msg, err := queue.PullChatTask(ctx, namespace, namespace)
		if err != nil || msg == nil {
			t.Fatalf("broker did not redeliver: %v", err)
		}
		meta, err := msg.Metadata()
		if err != nil {
			t.Fatal(err)
		}
		if err := msg.Ack(); err != nil {
			t.Fatal(err)
		}
		if string(msg.Data()) == task.ID {
			if meta.NumDelivered < 2 {
				t.Fatal("received another publication instead of broker redelivery")
			}
			break
		}
	}
	close(slow.release)
	for deadline := time.Now().Add(3 * time.Second); ; {
		exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
		if err != nil {
			t.Fatal(err)
		}
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("released real MinIO deletion did not complete")
		}
		select {
		case <-time.After(20 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("cleanup verification cancelled")
		}
	}
	stop()
	worker.wg.Wait()
	exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
	if err != nil || exists {
		t.Fatalf("slow cleanup did not finally remove the real object: %v %v", exists, err)
	}
	task, err = d.Claim(ctx, task.ID, "first", time.Minute)
	if err != nil || task == nil {
		t.Fatalf("claim failed: %v", err)
	}
	attempt, err := d.ReserveCall(ctx, task.ID, "first", task.LeaseEpoch, dao.ChatTaskCall{Stage: "planning", Model: "verified-input"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SettleCall(ctx, task.ID, "first", task.LeaseEpoch, attempt.ID, "succeeded", "stopped", 0, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := d.Mutate(ctx, task.ID, "first", task.LeaseEpoch, "output_committed",
		func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
			current.Outputs = entity.JSONMap{"text": map[string]interface{}{"answer": "saved"}}
			return entity.JSONMap{"kind": "text"}, nil
		}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.RecoverExpired(ctx, 100); err != nil {
		t.Fatal(err)
	}
	resumed, err := d.Claim(ctx, task.ID, "second", time.Minute)
	if err != nil || resumed == nil || resumed.Calls != 1 || !dao.HasChatTaskOutput(resumed) || resumed.LeaseEpoch <= task.LeaseEpoch {
		t.Fatalf("checkpoint recovery lost output/budget: %+v %v", resumed, err)
	}
	called := false
	err = d.Mutate(ctx, task.ID, "first", task.LeaseEpoch, "output_committed", func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error) {
		called = true
		return nil, nil
	})
	if !errors.Is(err, dao.ErrChatTaskLease) || called {
		t.Fatalf("expired executor was allowed to write: %v called=%v", err, called)
	}
	if _, err := d.Cancel(ctx, resumed.ID); err != nil {
		t.Fatal(err)
	}
	err = d.Mutate(ctx, resumed.ID, "second", resumed.LeaseEpoch, "output_committed", func(*gorm.DB, *entity.ChatTask) (entity.JSONMap, error) {
		called = true
		return nil, nil
	})
	if !errors.Is(err, dao.ErrChatTaskState) || called {
		t.Fatalf("cancelled executor published late output: %v called=%v", err, called)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", task.ID).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.RecoverExpired(ctx, 100); err != nil {
		t.Fatal(err)
	}
	cancelled, err := d.Get(ctx, task.ID)
	if err != nil || cancelled.State != "cancelled" || !dao.HasChatTaskOutput(cancelled) {
		t.Fatalf("cancellation lost earlier output: %+v %v", cancelled, err)
	}
	unknown := submit()
	unknown, err = d.Claim(ctx, unknown.ID, "lost", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	resource := "verify-" + common.GenerateToken()
	if err := d.EnsureResource(ctx, resource, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReserveCall(ctx, unknown.ID, "lost", unknown.LeaseEpoch,
		dao.ChatTaskCall{Stage: "audio", Model: "unknown-upstream", Resources: []string{resource}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTask{}).Where("id = ?", unknown.ID).Update("lease_until", 1).Error; err != nil {
		t.Fatal(err)
	}
	if err := d.RecoverExpired(ctx, 100); err != nil {
		t.Fatal(err)
	}
	unknown, err = d.Get(ctx, unknown.ID)
	if err != nil || unknown.State != "failed" || unknown.UpstreamStatus != "unknown" || unknown.Calls != 1 {
		t.Fatalf("unknown upstream was silently resumed: %+v %v", unknown, err)
	}
	var held int64
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", unknown.ID).Count(&held).Error; err != nil || held != 1 {
		t.Fatalf("unknown upstream released its physical slot: %d %v", held, err)
	}
	if _, err := d.Claim(ctx, unknown.ID, "unsafe", time.Minute); !errors.Is(err, dao.ErrChatTaskState) {
		t.Fatalf("unknown upstream was claimed again: %v", err)
	}
	if err := d.ReconcileStopped(ctx, unknown.ID, "isolated-test-confirmed-no-call"); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&entity.ChatTaskResourceLease{}).Where("task_id = ?", unknown.ID).Count(&held).Error; err != nil || held != 0 {
		t.Fatalf("reconciliation did not release the slot: %d %v", held, err)
	}
	t.Log("real NATS redelivery>=2; 3s MinIO deletion delay exceeded 1s heartbeat lease without blocking; stopped checkpoint resumed with calls=1; old epoch and cancelled output rejected; unknown upstream isolated until reconciliation")
}
