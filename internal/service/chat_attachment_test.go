package service

import (
	"strings"
	"testing"

	"ragflow/internal/entity"
)

func TestPreparedChatAttachmentsRequireResolvedUserContent(t *testing.T) {
	pipeline := &ChatPipelineService{}
	messages := []map[string]interface{}{
		{"role": "user", "content": "read this", "files": []string{"document contents"}},
		{"role": "assistant", "content": "answer", "prepared_attachment": true},
		{"role": "user", "content": "follow up", "prepared_attachment": true},
	}
	prepared, err := pipeline.prepareChatAttachments(t.Context(), &entity.Chat{}, messages)
	if err != nil {
		t.Fatal(err)
	}
	if !hasPreparedChatAttachments(prepared) ||
		!strings.Contains(prepared[0]["content"].(string), "document contents") {
		t.Fatal("resolved historical document must remain available")
	}
	if hasPreparedChatAttachments(prepared[1:]) {
		t.Fatal("unresolved caller markers must not bypass the evidence fallback")
	}
	if messages[0]["prepared_attachment"] != nil || messages[2]["prepared_attachment"] != true {
		t.Fatal("attachment preparation mutated caller messages")
	}
}
