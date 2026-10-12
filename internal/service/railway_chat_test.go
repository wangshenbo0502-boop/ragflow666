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
	if prepared.PromptConfig["reasoning"] != false || chat.PromptConfig["reasoning"] != true {
		t.Fatal("railway retrieval mode must be isolated from saved settings")
	}
	prompt := prepared.PromptConfig["system"].(string)
	if !strings.Contains(prompt, "{knowledge}") || !strings.Contains(prompt, "设备维修手册") {
		t.Fatal("missing retrieval context or equipment boundary")
	}
}

func TestPrepareRailwayOptions(t *testing.T) {
	options := map[string]interface{}{
		"knowledge": "unverified caller content", "reasoning": 4,
		"internet": true, "quote": false, "tools": "external",
		"toolcall_session": "external session", "doc_ids": []string{"doc-1"},
	}
	chat := &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}}
	prepared := prepareRailwayOptions(chat, options)
	if resolveReasoningLevel(prepared, map[string]interface{}(chat.PromptConfig)) != 0 ||
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
	if options["reasoning"] != 4 || options["knowledge"] == nil || options["internet"] != true {
		t.Fatal("caller options must not be mutated")
	}
	generic := prepareRailwayOptions(&entity.Chat{}, options)
	if generic["reasoning"] != 4 || generic["knowledge"] == nil {
		t.Fatal("generic chat options must be preserved")
	}
	if got := prepareRailwayOptions(chat, nil); got["quote"] != true {
		t.Fatal("nil railway options must receive evidence defaults")
	}
}

func TestRailwayEmptyResponse(t *testing.T) {
	chat := &entity.Chat{PromptConfig: entity.JSONMap{"domain": "railway"}}
	if !emptyResponseApplies(chat, 0, "unindexed attachment", true) {
		t.Fatal("attachments cannot replace indexed railway evidence")
	}
	if emptyResponseApplies(chat, 1, "", false) {
		t.Fatal("retrieved evidence must permit generation")
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
