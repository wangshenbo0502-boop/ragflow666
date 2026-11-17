package dao

import (
	"testing"

	"ragflow/internal/common"
	"ragflow/internal/entity"
)

func TestDocumentHasCompletedChunksUsesLatestVisibleDocumentStatus(t *testing.T) {
	db := setupDocumentTestDB(t)
	if err := db.AutoMigrate(&entity.File{}, &entity.File2Document{}, &entity.IngestionTask{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("DROP INDEX idx_ingestion_task_document_id").Error; err != nil {
		t.Fatal(err)
	}
	fileID, docID := "file-1", "doc-1"
	oldTime, newTime := int64(100), int64(200)
	for _, row := range []interface{}{
		&entity.Document{ID: docID, KbID: "kb-1", CreatedBy: "user-1", ParserConfig: entity.JSONMap{}, ChunkNum: 10},
		&entity.File{ID: fileID, ParentID: "root", TenantID: "user-1", CreatedBy: "user-1", Name: "railway.pdf", Type: "document"},
		&entity.File2Document{ID: "link-1", FileID: &fileID, DocumentID: &docID},
		&entity.IngestionTask{
			ID: "task-a", DocumentID: docID, Status: common.COMPLETED,
			BaseModel: entity.BaseModel{CreateTime: &oldTime},
		},
		&entity.IngestionTask{
			ID: "task-b", DocumentID: docID, Status: common.RUNNING,
			BaseModel: entity.BaseModel{CreateTime: &newTime},
		},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	assertReady := func(kbID string, want bool) {
		t.Helper()
		got, err := NewDocumentDAO().HasCompletedChunks(t.Context(), db, kbID)
		if err != nil || got != want {
			t.Fatalf("HasCompletedChunks(%q) = %v, %v; want %v", kbID, got, err, want)
		}
	}
	assertReady("kb-1", false)
	if err := db.Model(&entity.IngestionTask{}).Where("id = ?", "task-b").Update("status", common.COMPLETED).Error; err != nil {
		t.Fatal(err)
	}
	assertReady("kb-1", true)
	assertReady("other-kb", false)
	if err := db.Model(&entity.IngestionTask{}).Where("id = ?", "task-a").
		Updates(map[string]interface{}{"create_time": newTime, "status": common.FAILED}).Error; err != nil {
		t.Fatal(err)
	}
	assertReady("kb-1", true)
	if err := db.Where("id = ?", fileID).Delete(&entity.File{}).Error; err != nil {
		t.Fatal(err)
	}
	assertReady("kb-1", false)
}
