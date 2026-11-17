package dao

import (
	"encoding/json"
	"errors"
	"testing"

	"ragflow/internal/entity"
)

func TestAnswerVersionProtectsSameContentChanges(t *testing.T) {
	for _, table := range []string{conversationMessageTable, apiConversationMessageTable} {
		t.Run(table, func(t *testing.T) {
			db := setupChatSessionDAOTestDB(t)
			ctx := t.Context()
			if err := createHistory(ctx, db, table, "message", "session",
				json.RawMessage(`[{"id":"turn","role":"user","content":"question"}]`)); err != nil {
				t.Fatal(err)
			}
			first := map[string]interface{}{"id": "turn", "role": "assistant", "content": "same text",
				"reference": map[string]interface{}{"chunks": []string{"old"}}}
			if err := updateConversationHistory(ctx, db, table, "session",
				ConversationHistoryUpdate{QuestionID: "turn", Message: first, ExpectedAbsent: true}); err != nil {
				t.Fatal(err)
			}
			version := first["answer_version"].(int64)
			newer := map[string]interface{}{"id": "turn", "role": "assistant", "content": "same text",
				"reference": map[string]interface{}{"chunks": []string{"new"}}, "media_assets": []string{"new-media"}}
			if err := updateConversationHistory(ctx, db, table, "session",
				ConversationHistoryUpdate{QuestionID: "turn", Message: newer, ExpectedVersion: &version}); err != nil {
				t.Fatal(err)
			}
			for _, stale := range []ConversationHistoryUpdate{
				{QuestionID: "turn", Message: first, ExpectedVersion: &version},
				{QuestionID: "turn", Message: first, ExpectedAbsent: true},
			} {
				if err := updateConversationHistory(ctx, db, table, "session", stale); !errors.Is(err, ErrAnswerVersion) {
					t.Fatalf("stale tab/late output accepted: %v", err)
				}
			}
			var saved entity.ConversationMessage
			if err := db.Table(table).Take(&saved, "conversation_id = ? AND position = ?", "session", 1).Error; err != nil {
				t.Fatal(err)
			}
			if saved.AnswerVersion != version+1 || string(saved.Reference) != `{"chunks":["new"]}` ||
				saved.Metadata != `{"media_assets":["new-media"]}` {
				t.Fatalf("newer answer changed: %+v", saved.ConversationMessageFields)
			}
			if err := db.Table(table).Where("conversation_id = ? AND position = ?", "session", 1).Delete(map[string]interface{}{}).Error; err != nil {
				t.Fatal(err)
			}
			if err := updateConversationHistory(ctx, db, table, "session",
				ConversationHistoryUpdate{QuestionID: "turn", Message: first, ExpectedVersion: &version}); !errors.Is(err, ErrAnswerVersion) {
				t.Fatalf("deleted answer resurrected: %v", err)
			}
		})
	}
}
