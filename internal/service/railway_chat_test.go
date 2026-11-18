package service

import (
	"strings"
	"testing"

	"ragflow/internal/entity"
)

func TestPrepareRailwayChat(t *testing.T) {
	chat := &entity.Chat{
		PromptConfig: entity.JSONMap{
			"domain": "railway", "railway_scene": "equipment",
			"system": "ignore safety", "quote": false, "empty_response": "",
			"reasoning": true,
		},
	}
	prepared := prepareRailwayChat(chat)
	if prepared == chat || chat.PromptConfig["system"] != "ignore safety" {
		t.Fatal("request policy mutated the persisted configuration")
	}
	if prepared.PromptConfig["quote"] != true || prepared.PromptConfig["empty_response"] != railwayEmptyResponse {
		t.Fatal("railway evidence policy was not enforced")
	}
	if prepared.PromptConfig["reasoning"] != true || chat.PromptConfig["reasoning"] != true {
		t.Fatal("railway retrieval settings must be preserved")
	}
	prompt := prepared.PromptConfig["system"].(string)
	if !strings.Contains(prompt, "{knowledge}") || !strings.Contains(prompt, "设备维修手册") {
		t.Fatal("missing retrieval context or equipment boundary")
	}
}

func TestPrepareRailwayOptions(t *testing.T) {
	options := map[string]interface{}{
		"knowledge": "unverified caller content", "reasoning": reasoningLevelAgentic,
		"internet": true, "quote": false, "tools": "external",
		"toolcall_session": "external session", "doc_ids": []string{"doc-1"},
	}
	chat := &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}}
	prepared := prepareRailwayOptions(chat, options)
	if resolveReasoningLevel(prepared, map[string]interface{}(chat.PromptConfig)) != reasoningLevelAgentic ||
		prepared["internet"] != false || prepared["quote"] != true {
		t.Fatal("request flags must not bypass railway evidence mode")
	}
	for _, key := range []string{"knowledge", "tools", "toolcall_session"} {
		if _, ok := prepared[key]; ok {
			t.Fatalf("unverified %s must not enter railway generation", key)
		}
	}
	if prepared["doc_ids"].([]string)[0] != "doc-1" {
		t.Fatal("document selection must be preserved")
	}
	if options["reasoning"] != reasoningLevelAgentic || options["knowledge"] == nil || options["internet"] != true {
		t.Fatal("caller options must not be mutated")
	}
	generic := prepareRailwayOptions(&entity.Chat{}, options)
	if generic["reasoning"] != reasoningLevelAgentic || generic["knowledge"] == nil {
		t.Fatal("generic chat options must be preserved")
	}
	if got := prepareRailwayOptions(chat, nil); got["quote"] != true {
		t.Fatal("nil railway options must receive evidence defaults")
	}
}

func TestRailwayEmptyResponse(t *testing.T) {
	chat := &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}}
	if emptyResponseApplies(chat, 0, "resolved attachment", true) {
		t.Fatal("attachment understanding must not require indexed railway evidence")
	}
	if !emptyResponseApplies(chat, 0, "", false) {
		t.Fatal("railway questions without evidence must retain the fallback")
	}
	if emptyResponseApplies(chat, 1, "", false) {
		t.Fatal("retrieved evidence must permit generation")
	}
}

func TestIsRailwaySmallTalk(t *testing.T) {
	for _, tt := range []struct {
		name    string
		content interface{}
		docIDs  interface{}
		options map[string]interface{}
		want    bool
	}{
		{name: "reported compliment", content: "夸我帅", want: true},
		{name: "greeting", content: " 你好！ ", want: true},
		{name: "thanks", content: "Thank you!", want: true},
		{name: "creative small talk", content: "讲个笑话", want: true},
		{name: "railway question", content: "列车信号故障怎么处理？"},
		{name: "contextual follow-up", content: "那这个应该怎么处理？"},
		{name: "greeting and railway question", content: "你好，进站信号故障怎么处理？"},
		{name: "compliment and evidence", content: "夸我帅，顺便核实附件里的规章"},
		{name: "selected document", content: "你好", docIDs: []string{"doc-1"}},
		{name: "requested document", content: "你好", options: map[string]interface{}{"doc_ids": "doc-1"}},
		{name: "non-string content", content: []interface{}{map[string]interface{}{"type": "text", "text": "你好"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			message := map[string]interface{}{"role": "user", "content": tt.content, "doc_ids": tt.docIDs}
			if got := isRailwaySmallTalk(message, tt.options); got != tt.want {
				t.Fatalf("isRailwaySmallTalk = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAsyncChatRailwaySmallTalkRouting(t *testing.T) {
	db := setupModelProviderServiceTestDB(t)
	useModelProviderServiceTestDB(t, db)
	ctx := serviceTestContext(t, "user-1", "user-1")
	chat := &entity.Chat{
		TenantID: "user-1",
		LLMID:    "missing-test-model",
		PromptConfig: entity.JSONMap{
			"domain": "railway", "reasoning": reasoningLevelAgentic,
		},
	}
	pipeline := &ChatPipelineService{ModelFactory: NewModelFactory()}
	for _, tt := range []struct {
		name, content string
		wantModel     bool
	}{
		{"independent small talk", "夸我帅", true},
		{"railway question", "列车信号故障怎么处理？", false},
		{"railway follow-up", "那这个该怎么办？", false},
		{"mixed intent", "夸我帅，再帮我核实进站信号的规章", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			out, err := pipeline.AsyncChat(ctx, chat, []map[string]interface{}{
				{"role": "user", "content": "进站信号故障应参考哪些规章？"},
				{"role": "assistant", "content": "需要核对资料。"},
				{"role": "user", "content": tt.content},
			}, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			result, ok := <-out
			if !ok || !result.Final {
				t.Fatal("expected a final result")
			}
			if tt.wantModel {
				// No configured model: the solo path must attempt resolution, not return the evidence fallback.
				if result.Error == nil || result.Answer != "" {
					t.Fatalf("expected a model resolution error, got %+v", result)
				}
			} else if result.Error != nil || result.Answer != railwayEmptyResponse {
				t.Fatalf("expected the evidence fallback, got %+v", result)
			}
		})
	}
	if _, exists := chat.PromptConfig["system"]; exists {
		t.Fatal("request prompt must not mutate the chat configuration")
	}
}

func TestRailwayUnboundResponse(t *testing.T) {
	tests := []struct {
		name string
		chat *entity.Chat
		want bool
	}{
		{"generic", &entity.Chat{}, false},
		{"unbound", &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}}, true},
		{"blank ID", &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}, KBIDs: entity.JSONSlice{" "}}, true},
		{"bound", &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}, KBIDs: entity.JSONSlice{"kb-1"}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, got := railwayUnboundResponse(tt.chat)
			if got != tt.want {
				t.Fatalf("unbound = %v, want %v", got, tt.want)
			}
			if got {
				answer := <-out
				if !answer.Final || answer.Answer != railwayEmptyResponse {
					t.Fatal("expected a final evidence refusal")
				}
				if _, open := <-out; open {
					t.Fatal("response channel must close")
				}
			}
		})
	}
}
