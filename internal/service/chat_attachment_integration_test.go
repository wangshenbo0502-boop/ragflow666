//go:build integration

package service

import (
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/permission"
	"ragflow/internal/server/config"
	"ragflow/internal/storage"
)

// This diagnostic reads saved attachments without invoking models.
func TestChatAttachmentSavedTaskPreflight(t *testing.T) {
	taskID := os.Getenv("RAGFLOW_TEST_CHAT_PREFLIGHT_TASK")
	sessionID := os.Getenv("RAGFLOW_TEST_CHAT_PREFLIGHT_SESSION")
	if taskID == "" && sessionID == "" {
		t.Skip("requires a saved task or session, read-only database access and its object store")
	}
	db, err := gorm.Open(mysql.Open(os.Getenv("RAGFLOW_TEST_CHAT_MYSQL_DSN")), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal("cannot connect to the task database")
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx := db.Begin(&sql.TxOptions{ReadOnly: true})
	if tx.Error != nil {
		t.Fatal("cannot start read-only diagnostic")
	}
	defer tx.Rollback()
	previousDB := dao.DB
	dao.DB = tx
	defer func() { dao.DB = previousDB }()
	var input chatTaskInput
	var userID string
	if sessionID != "" {
		session, err := dao.NewChatSessionDAO().GetByID(t.Context(), tx, sessionID)
		if err != nil || session.UserID == nil {
			t.Fatal("saved session unavailable")
		}
		chat, err := dao.NewChatDAO().GetByID(t.Context(), tx, session.DialogID)
		if err != nil {
			t.Fatal("saved chat unavailable")
		}
		turnID := os.Getenv("RAGFLOW_TEST_CHAT_PREFLIGHT_TURN")
		for _, message := range parseMessages(session.Message) {
			if turnID != "" && message["id"] == turnID && message["role"] == "user" {
				input.Messages = []map[string]interface{}{message}
				break
			}
		}
		if len(input.Messages) == 0 {
			t.Fatal("saved user message not found; set RAGFLOW_TEST_CHAT_PREFLIGHT_TURN")
		}
		userID, input.Chat = *session.UserID, *chat
	} else {
		var task entity.ChatTask
		if err := tx.Take(&task, "id = ?", taskID).Error; err != nil {
			t.Fatal("saved task unavailable")
		}
		if json.Unmarshal([]byte(task.Input), &input) != nil {
			t.Fatal("invalid saved input")
		}
		userID = task.UserID
	}
	var minioConfig config.MinioConfig
	if json.Unmarshal([]byte(os.Getenv("RAGFLOW_TEST_CHAT_MINIO")), &minioConfig) != nil {
		t.Fatal("invalid object store configuration")
	}
	store, err := storage.NewMinioStorage(minioConfig)
	if err != nil {
		t.Fatal("object store unavailable")
	}
	factory := storage.GetStorageFactory()
	previousStore := factory.GetStorage()
	factory.SetStorage(store)
	defer factory.SetStorage(previousStore)
	ctx := permission.WithIdentity(t.Context(), userID, input.Chat.TenantID)
	pipeline := NewChatPipelineService()
	ctx, chat, err := pipeline.prepareChatRoute(ctx, &input.Chat, input.Messages, input.Options)
	if err != nil {
		t.Fatal("route preparation failed")
	}
	prepared, err := pipeline.prepareChatAttachments(ctx, chat, input.Messages)
	if err != nil {
		t.Fatal("saved attachments failed preparation")
	}
	if !hasPreparedChatAttachments(prepared) {
		t.Fatal("diagnostic requires real saved attachments")
	}
	info, err := NewModelFactory().ResolveInfo(ctx, entity.ModelTypeChat, chat.LLMID)
	if err != nil || !chatRouteCompatible(info, info, true) {
		t.Fatal("selected model rejected its own enrolled vision capability")
	}
	imageCount := 0
	expectedMIME := os.Getenv("RAGFLOW_TEST_CHAT_PREFLIGHT_IMAGE_MIME")
	for _, message := range prepared {
		if images, ok := message["files"].([]string); ok {
			imageCount += len(images)
		}
		wire, err := preparedChatMessage(message, info.ProviderName)
		if err != nil {
			t.Fatal("prepared attachment cannot become a model message")
		}
		if images, _ := message["files"].([]string); expectedMIME != "" && len(images) > 0 {
			content, err := json.Marshal(wire["content"])
			if err != nil || !strings.Contains(string(content), images[0]) ||
				!strings.HasPrefix(images[0], "data:"+expectedMIME+";base64,") {
				t.Fatal("prepared model message did not contain the expected image")
			}
		}
	}
	if imageCount == 0 {
		t.Fatal("saved images were lost")
	}
	t.Logf("read-only saved attachment preflight passed: prepared_images=%d; no model request sent", imageCount)
}
