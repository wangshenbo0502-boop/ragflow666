//go:build e2e

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

func chatPersistenceStore(t *testing.T) storage.Storage {
	t.Helper()
	var cfg config.MinioConfig
	if err := json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &cfg); err != nil ||
		cfg.Host != "ragflow-chat-test-minio:9000" {
		t.Fatal("requires disposable object storage")
	}
	store, err := storage.NewMinioStorage(cfg)
	if err != nil {
		t.Fatal("cannot open disposable object storage")
	}
	return store
}

func TestChatMediaRealCommitFailureReuse(t *testing.T) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	store := chatPersistenceStore(t)
	chatID, sessionID := e.newMediaSession("Real output commit failure and reuse")
	trigger := "chat_test_commit_" + common.GenerateToken()
	statement := fmt.Sprintf(`CREATE TRIGGER %s BEFORE UPDATE ON chat_media_asset FOR EACH ROW
BEGIN
IF OLD.session_id = '%s' AND OLD.state = 'staging' AND NEW.state = 'committed' THEN
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated output commit fault';
END IF;
END`, trigger, sessionID)
	if err := db.Exec(statement).Error; err != nil {
		t.Fatal("cannot inject isolated database commit failure")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 10*time.Second)
		defer cancel()
		if err := db.WithContext(ctx).Exec("DROP TRIGGER IF EXISTS " + trigger).Error; err != nil {
			t.Error("cannot remove test-owned commit trigger")
		}
	})
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	var admission struct {
		TaskID string `json:"task_id"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "请根据知识库简短回答青禾项目的验收暗号和负责人，保留引用并配音。",
	}, &admission)
	partial := e.waitTask(admission.TaskID)
	if partial.Task.State != "partial_succeeded" || partial.Task.ErrorCode != "persistence_failed" ||
		partial.Task.UpstreamStatus != "stopped" || !reflect.DeepEqual(partial.RetryStages, []string{"audio"}) {
		t.Fatalf("commit failure lost recoverable partial output: %s/%s/%s retry=%v",
			partial.Task.State, partial.Task.ErrorCode, partial.Task.UpstreamStatus, partial.RetryStages)
	}
	answer, ok := partial.Task.Outputs["answer"].(map[string]any)
	if !ok || answer["media_assets"] != nil {
		t.Fatal("failed transaction published uncommitted media")
	}
	var assets []entity.ChatMediaAsset
	if err := db.Where("task_id = ?", partial.Task.ID).Find(&assets).Error; err != nil || len(assets) != 1 {
		t.Fatal("object written before failed commit was not journaled exactly once")
	}
	asset := assets[0]
	data, err := storage.GetBounded(t.Context(), store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
	if err != nil || asset.State != "staging" || asset.Bytes != int64(len(data)) {
		t.Fatal("failed commit lost its staged object")
	}
	duration, err := validateChatWAV(data)
	if err != nil || duration != asset.DurationMs {
		t.Fatal("staged audio is invalid")
	}
	var references int64
	if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ? AND owner_kind = ?", asset.ID, "message").
		Count(&references).Error; err != nil || references != 0 {
		t.Fatal("failed transaction left a visible media reference")
	}
	if err := db.Exec("DROP TRIGGER " + trigger).Error; err != nil {
		t.Fatal("cannot restore database commits")
	}
	var retry entity.ChatTask
	e.request(http.MethodPost, "/chats/tasks/"+partial.Task.ID+"/retry",
		map[string]any{"stage": "audio", "revision": partial.Task.Revision}, &retry)
	completed := e.waitTask(retry.ID)
	if completed.Task.State != "succeeded" || completed.Task.Calls != 0 || len(completed.Attempts) != 0 {
		t.Fatalf("staged output reuse called a model: %s/%s calls=%d attempts=%d",
			completed.Task.State, completed.Task.ErrorCode, completed.Task.Calls, len(completed.Attempts))
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
	found := false
	for _, message := range refreshed.Messages {
		if message["role"] != "assistant" || message["id"] != partial.Task.TurnID {
			continue
		}
		found = true
		outputs, _ := message["media_assets"].([]any)
		version, err := chatAnswerVersion(message)
		oldVersion, oldErr := chatAnswerVersion(answer)
		if len(outputs) != 1 || outputs[0].(map[string]any)["id"] != asset.ID || err != nil || oldErr != nil ||
			*version != *oldVersion+1 || !reflect.DeepEqual(message["reference"], answer["reference"]) {
			t.Fatal("staged reuse changed media identity, answer version or citations")
		}
	}
	if !found {
		t.Fatal("refresh lost the recovered media answer")
	}
	if err := db.Take(&asset, "id = ?", asset.ID).Error; err != nil || asset.State != "committed" {
		t.Fatal("reused object was not committed")
	}
	after := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if after["forwarded"] != before["forwarded"]+1 || after["rejected"] != before["rejected"] {
		t.Fatal("database failure repeated paid audio generation")
	}
	t.Log("PASS real TTS once -> MinIO Put -> MySQL commit rejection -> staged object retained -> audio retry reuses same object with zero calls -> refresh preserves citations and increments answer version")
}

func TestChatMediaRealCrashAfterPut(t *testing.T) {
	runChatMediaRealCrashAfterPut(t, false)
}

func TestChatMediaRealCrashOrphanCleanup(t *testing.T) {
	runChatMediaRealCrashAfterPut(t, true)
}

func runChatMediaRealCrashAfterPut(t *testing.T, cleanupOrphan bool) {
	e := chatMediaE2E(t)
	db := chatFaultDatabase(t)
	store := chatPersistenceStore(t)
	title := "Actual Worker crash after MinIO Put"
	if cleanupOrphan {
		title = "Actual Worker crash orphan cleanup"
	}
	chatID, sessionID := e.newMediaSession(title)
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pool.Conn(t.Context())
	if err != nil {
		t.Fatal("cannot reserve commit barrier connection")
	}
	barrier := "chat_put_" + common.GenerateToken()
	var acquired int
	if err := connection.QueryRowContext(t.Context(), "SELECT GET_LOCK(?, 0)", barrier).Scan(&acquired); err != nil || acquired != 1 {
		connection.Close()
		t.Fatal("cannot acquire test-owned commit barrier")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 10*time.Second)
		defer cancel()
		_, _ = connection.ExecContext(ctx, "SELECT RELEASE_LOCK(?)", barrier)
		_ = connection.Close()
	})
	trigger := "chat_test_put_" + common.GenerateToken()
	statement := fmt.Sprintf(`CREATE TRIGGER %s BEFORE UPDATE ON chat_media_asset FOR EACH ROW
BEGIN
DECLARE acquired INT DEFAULT 0;
IF OLD.session_id = '%s' AND OLD.state = 'staging' AND NEW.state = 'committed' THEN
SET acquired = GET_LOCK('%s', 60);
IF acquired <> 1 THEN
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated commit barrier timeout';
END IF;
DO RELEASE_LOCK('%s');
END IF;
END`, trigger, sessionID, barrier, barrier)
	if err := db.Exec(statement).Error; err != nil {
		t.Fatal("cannot install test-owned commit barrier")
	}
	workerStopped := false
	barrierInstalled := true
	t.Cleanup(func() {
		if workerStopped {
			e.workerFault("start")
		}
	})
	// Restart only after removing the barrier, including when an assertion fails.
	t.Cleanup(func() {
		if !barrierInstalled {
			return
		}
		if !workerStopped {
			e.workerFault("crash")
			workerStopped = true
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 10*time.Second)
		defer cancel()
		_, _ = connection.ExecContext(ctx, "SELECT RELEASE_LOCK(?)", barrier)
		if err := db.WithContext(ctx).Exec("DROP TRIGGER IF EXISTS " + trigger).Error; err != nil {
			t.Error("cannot remove test-owned commit barrier")
		}
	})
	before := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	var admission struct {
		TaskID string `json:"task_id"`
	}
	e.request(http.MethodPost, "/chat/completions", map[string]any{
		"chat_id": chatID, "session_id": sessionID, "mode": "voice", "stream": false,
		"question": "根据知识库用一句话回答青禾项目的验收暗号和负责人，保留引用并配音。",
	}, &admission)
	var asset entity.ChatMediaAsset
	var staged []byte
	until := time.Now().Add(2 * time.Minute)
	for time.Now().Before(until) {
		err := db.Take(&asset, "task_id = ? AND kind = ?", admission.TaskID, "audio").Error
		if err != nil && err != gorm.ErrRecordNotFound {
			t.Fatal("cannot observe staged audio")
		}
		if err == nil {
			staged, err = storage.GetBounded(t.Context(), store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
			if err == nil && len(staged) > 0 {
				break
			}
		}
		details, err := dao.NewChatTaskDAO(db).Details(t.Context(), admission.TaskID)
		if err != nil {
			t.Fatal("cannot read task while waiting for actual Put")
		}
		if dao.IsChatTaskTerminal(details.Task.State) {
			t.Fatalf("task reached terminal state before actual Put barrier: %s",
				chatTaskSnapshotDiagnostic(db, details))
		}
		select {
		case <-t.Context().Done():
			t.Fatal("actual Put barrier wait cancelled")
		case <-time.After(100 * time.Millisecond):
		}
	}
	if asset.State != "staging" || int64(len(staged)) != asset.Bytes || len(staged) == 0 {
		t.Fatal("actual Put did not reach the pre-commit barrier")
	}
	if _, err := validateChatWAV(staged); err != nil {
		t.Fatal("actual Put did not save valid audio")
	}
	var running entity.ChatTask
	if err := db.Take(&running, "id = ?", admission.TaskID).Error; err != nil || running.State != "running" ||
		running.UpstreamStatus != "stopped" || running.Outputs["audio"] != nil || running.CheckpointReady {
		t.Fatal("pre-commit state is not an incomplete, stopped checkpoint")
	}
	e.workerFault("crash")
	workerStopped = true
	if _, err := connection.ExecContext(t.Context(), "SELECT RELEASE_LOCK(?)", barrier); err != nil {
		t.Fatal("cannot release test-owned commit barrier")
	}
	if err := db.Exec("DROP TRIGGER " + trigger).Error; err != nil {
		t.Fatal("cannot remove barrier after actual Worker crash")
	}
	barrierInstalled = false
	e.workerFault("start")
	workerStopped = false
	partial := e.waitTask(admission.TaskID)
	if partial.Task.State != "partial_succeeded" || partial.Task.ErrorCode != "checkpoint_incomplete" ||
		partial.Task.UpstreamStatus != "stopped" || partial.Task.Calls != running.Calls ||
		!reflect.DeepEqual(partial.RetryStages, []string{"audio"}) {
		t.Fatalf("actual crash recovered unsafely: %s/%s upstream=%s calls=%d retry=%v",
			partial.Task.State, partial.Task.ErrorCode, partial.Task.UpstreamStatus, partial.Task.Calls, partial.RetryStages)
	}
	if cleanupOrphan {
		var journal entity.ChatMediaCleanup
		deadline := time.Now().Add(3 * time.Minute)
		for {
			assetErr := db.Take(&asset, "id = ?", asset.ID).Error
			journalErr := db.Take(&journal, "asset_id = ?", asset.ID).Error
			if assetErr == nil && journalErr == nil && asset.State == "deleted" &&
				journal.State == "done" && journal.Attempts == 1 && journal.LastError == "" {
				break
			}
			if (assetErr != nil && assetErr != gorm.ErrRecordNotFound) ||
				(journalErr != nil && journalErr != gorm.ErrRecordNotFound) {
				t.Fatalf("cannot observe orphan cleanup: asset=%v journal=%v", assetErr, journalErr)
			}
			if time.Now().After(deadline) {
				t.Fatalf("background orphan cleanup did not finish: asset=%s journal=%s attempts=%d",
					asset.State, journal.State, journal.Attempts)
			}
			select {
			case <-t.Context().Done():
				t.Fatal("background orphan cleanup wait cancelled")
			case <-time.After(time.Second):
			}
		}
		exists, err := store.ObjectExists(t.Context(), asset.Bucket, asset.ObjectKey)
		if err != nil || exists {
			t.Fatalf("actual orphan remains in MinIO: exists=%t err=%v", exists, err)
		}
		var refs int64
		if err := db.Model(&entity.ChatMediaReference{}).Where("asset_id = ?", asset.ID).Count(&refs).Error; err != nil || refs != 0 {
			t.Fatalf("deleted orphan has references: count=%d err=%v", refs, err)
		}
		if partial.Task.Outputs["answer"] == nil || partial.Task.Outputs["audio"] != nil {
			t.Fatal("orphan cleanup changed the recoverable text output")
		}
		t.Logf("PASS actual MinIO Put -> actual Worker SIGKILL -> natural lease recovery -> background orphan discovery -> MinIO deletion and durable journal completion; task=%s asset=%s",
			admission.TaskID, asset.ID)
		return
	}
	var retry entity.ChatTask
	e.request(http.MethodPost, "/chats/tasks/"+partial.Task.ID+"/retry",
		map[string]any{"stage": "audio", "revision": partial.Task.Revision}, &retry)
	completed := e.waitTask(retry.ID)
	if completed.Task.State != "succeeded" || completed.Task.Calls != 0 || len(completed.Attempts) != 0 {
		t.Fatal("retry after actual Put crash repeated generation or failed")
	}
	outputs, _ := completed.Task.Outputs["audio"].([]any)
	if len(outputs) != 1 || outputs[0].(map[string]any)["id"] != asset.ID {
		t.Fatal("retry did not retain the actual staged object identity")
	}
	after := e.faultControl(map[string]any{"fail_next": 0, "hold_next": 0})
	if after["forwarded"] != before["forwarded"]+1 {
		t.Fatal("actual process crash repeated paid TTS")
	}
	var refreshed ChatSessionPayload
	e.request(http.MethodGet, "/chats/"+chatID+"/sessions/"+sessionID+"?include_reference=true", nil, &refreshed)
	found := false
	for _, message := range refreshed.Messages {
		if message["role"] == "assistant" && message["id"] == partial.Task.TurnID {
			answer, _ := completed.Task.Outputs["answer"].(map[string]any)
			found = reflect.DeepEqual(message["media_assets"], answer["media_assets"]) &&
				reflect.DeepEqual(message["reference"], answer["reference"]) && message["reference"] != nil
		}
	}
	if !found {
		t.Fatal("refresh after actual Put crash lost media or citations")
	}
	t.Logf("PASS real TTS=1 -> actual MinIO Put -> MySQL commit barrier -> actual Worker SIGKILL -> natural lease recovery preserves text/citations without automatic replay -> explicit audio retry reuses object with zero calls; task=%s asset=%s",
		admission.TaskID, asset.ID)
}
