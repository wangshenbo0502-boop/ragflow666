package service

import (
	"strings"
	"testing"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

func setupRailwayChatCreationTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := setupChatRESTUpdateServiceTestDB(t)
	if err := db.AutoMigrate(
		&entity.Document{}, &entity.File{}, &entity.File2Document{}, &entity.IngestionTask{},
	); err != nil {
		t.Fatal(err)
	}
	name, fileID, docID := "railway.pdf", "file-railway", "doc-railway"
	status := string(entity.StatusValid)
	for _, row := range []interface{}{
		&entity.Knowledgebase{
			ID: "kb-railway", TenantID: "user-1", CreatedBy: "user-1", Name: "railway",
			ChunkNum: 10, Permission: string(entity.TenantPermissionMe), Status: &status,
		},
		&entity.Document{
			ID: docID, KbID: "kb-railway", CreatedBy: "user-1", Name: &name,
			ParserConfig: entity.JSONMap{}, ChunkNum: 10,
		},
		&entity.File{
			ID: fileID, ParentID: "root", TenantID: "user-1", CreatedBy: "user-1",
			Name: name, Type: "document",
		},
		&entity.File2Document{ID: "link-railway", FileID: &fileID, DocumentID: &docID},
		&entity.IngestionTask{
			ID: "task-railway", UserID: "user-1", DocumentID: docID,
			DatasetID: "kb-railway", Status: common.COMPLETED,
		},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatalf("seed railway creation: %v", err)
		}
	}
	return db
}

func TestRailwayChatCreationPersistsSelectedConfiguration(t *testing.T) {
	for _, scene := range []string{"safety", "passenger", "equipment", "training"} {
		t.Run(scene, func(t *testing.T) {
			db := setupRailwayChatCreationTestDB(t)
			ctx := t.Context()
			response, code, err := NewChatService().Create(ctx, "user-1", map[string]interface{}{
				"name": "renamable assistant", "dataset_ids": []string{"kb-railway"},
				"llm_id": "model-a",
				"prompt_config": map[string]interface{}{
					"domain": "railway", "railway_scene": scene,
				},
			})
			if err != nil || code != common.CodeSuccess {
				t.Fatalf("Create = %v, %v", code, err)
			}
			id, ok := response["id"].(string)
			if !ok || id == "" {
				t.Fatalf("missing saved ID: %v", response)
			}
			chat, err := dao.NewChatDAO().GetByID(ctx, db, id)
			if err != nil {
				t.Fatal(err)
			}
			if !isRailwayChat(chat) || chat.PromptConfig["railway_scene"] != scene ||
				chat.TenantLLMID == nil || *chat.TenantLLMID != "model-a" ||
				len(chat.KBIDs) != 1 || chat.KBIDs[0] != "kb-railway" {
				t.Fatalf("incorrect saved railway configuration: %+v", chat)
			}
		})
	}
}

func TestRailwayChatCreationRejectsInvalidConfigurationWithoutSaving(t *testing.T) {
	tests := []struct {
		name  string
		scene interface{}
		model string
		kbIDs []string
		alter func(*gorm.DB) error
		want  string
	}{
		{name: "unknown scene", scene: "other", model: "model-a", kbIDs: []string{"kb-railway"}, want: "场景"},
		{name: "missing scene", model: "model-a", kbIDs: []string{"kb-railway"}, want: "场景"},
		{name: "object scene", scene: map[string]interface{}{}, model: "model-a", kbIDs: []string{"kb-railway"}, want: "场景"},
		{name: "no model", scene: "safety", kbIDs: []string{"kb-railway"}, want: "模型"},
		{name: "unknown model", scene: "safety", model: "missing", kbIDs: []string{"kb-railway"}, want: "llm_id"},
		{name: "unbound", scene: "safety", model: "model-a", want: "知识库"},
		{name: "missing dataset", scene: "safety", model: "model-a", kbIDs: []string{"missing"}},
		{name: "private dataset", scene: "safety", model: "model-a", kbIDs: []string{"kb-private"},
			alter: func(db *gorm.DB) error {
				status := string(entity.StatusValid)
				return db.Create(&entity.Knowledgebase{
					ID: "kb-private", TenantID: "other-user", CreatedBy: "other-user",
					Name: "private", ChunkNum: 10, Permission: string(entity.TenantPermissionMe),
					Status: &status,
				}).Error
			}},
		{name: "failed parsing", scene: "safety", model: "model-a", kbIDs: []string{"kb-railway"},
			alter: func(db *gorm.DB) error {
				return db.Model(&entity.IngestionTask{}).Where("id = ?", "task-railway").Update("status", common.FAILED).Error
			}, want: "解析"},
		{name: "running parsing", scene: "safety", model: "model-a", kbIDs: []string{"kb-railway"},
			alter: func(db *gorm.DB) error {
				return db.Model(&entity.IngestionTask{}).Where("id = ?", "task-railway").Update("status", common.RUNNING).Error
			}, want: "解析"},
		{name: "zero document chunks", scene: "safety", model: "model-a", kbIDs: []string{"kb-railway"},
			alter: func(db *gorm.DB) error {
				return db.Model(&entity.Document{}).Where("id = ?", "doc-railway").Update("chunk_num", 0).Error
			}, want: "解析"},
		{name: "deleted file", scene: "safety", model: "model-a", kbIDs: []string{"kb-railway"},
			alter: func(db *gorm.DB) error {
				return db.Where("id = ?", "file-railway").Delete(&entity.File{}).Error
			}, want: "解析"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := setupRailwayChatCreationTestDB(t)
			if tt.alter != nil {
				if err := tt.alter(db); err != nil {
					t.Fatal(err)
				}
			}
			_, code, err := NewChatService().Create(t.Context(), "user-1", map[string]interface{}{
				"name": "railway assistant", "dataset_ids": tt.kbIDs, "llm_id": tt.model,
				"prompt_config": map[string]interface{}{"domain": "railway", "railway_scene": tt.scene},
			})
			if err == nil || code == common.CodeSuccess || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Create = %v, %v; want rejection containing %q", code, err, tt.want)
			}
			var count int64
			if err := db.Model(&entity.Chat{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("rejected request saved %d assistants: %v", count, err)
			}
		})
	}
}

func TestRailwayNamedGenericChatDoesNotRequireRailwayConfiguration(t *testing.T) {
	setupChatRESTUpdateServiceTestDB(t)
	response, code, err := NewChatService().Create(t.Context(), "user-1", map[string]interface{}{
		"name": "铁路安全培训助手",
	})
	if err != nil || code != common.CodeSuccess || response["id"] == nil {
		t.Fatalf("generic Create = %v, %v", code, err)
	}
}
