package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"reflect"
	"strings"
	"testing"

	"ragflow/internal/entity"
)

func TestSpeechPlanKeepsAnswerAndEmotion(t *testing.T) {
	plan, err := parseSpeechPlan("```json\n" + `{"answer":"答案是 **42**。[ID:0]","voice":"serena","instructions":"台湾国语，开心又温柔","mode":"speech"}` + "\n```")
	if err != nil || plan.Answer != "答案是 **42**。[ID:0]" || !strings.Contains(plan.Instructions, chatVoiceIdentityInstruction) {
		t.Fatalf("answer or emotion lost: %+v %v", plan, err)
	}
	plan, err = parseSpeechPlan(`{"answer":"月光轻轻落下来","voice":"unavailable","mode":"singing","music_caption":"Sweet Mandarin female lullaby","duration":500}`)
	if err != nil || plan.Mode != "singing" || plan.Duration != 45 || plan.Voice != chatVoiceName || plan.Instructions == "" {
		t.Fatalf("song plan invalid: %+v %v", plan, err)
	}
	plan, err = parseSpeechPlan(`{"answer":"你好","voice":"ryan","mode":"speech"}`)
	if err != nil || plan.Voice != chatVoiceName {
		t.Fatalf("speech voice changed from the shared voice: %+v %v", plan, err)
	}
	plan, err = parseSpeechPlan(`{"answer":"月光轻轻落下来","mode":"singing","music_caption":"Soft Mandarin lullaby","duration":"约20秒"}`)
	if err != nil || plan.Duration != 20 || plan.Mode != "singing" {
		t.Fatalf("duration with units was rejected: %+v %v", plan, err)
	}
	for _, invalid := range []string{`{"answer":""}`, `{"answer":"ok"`, `{"answer":"![图](x)"}`, `{"voice":"serena"}`, `{"answer":null}`} {
		if _, err := parseSpeechPlan(invalid); err == nil {
			t.Fatalf("accepted invalid speech JSON %q", invalid)
		}
	}
}

func TestSpeechPlanRepairsMultilineLyrics(t *testing.T) {
	plan, err := parseSpeechPlan("```json\n" + `{
"answer":"晚风轻轻吹过来
月光落在你窗台",
"instructions":"台湾国语，温柔女声",
"mode":"singing",
"music_caption":"Soft Mandarin female lullaby",
"duration":20,
}` + "\n```")
	if err != nil || plan.Answer != "晚风轻轻吹过来\n月光落在你窗台" || plan.Mode != "singing" || plan.Duration != 20 {
		t.Fatalf("multiline lyrics were not repaired: %+v %v", plan, err)
	}
}

type speechPlanRetryPipeline struct {
	calls int
}

func (p *speechPlanRetryPipeline) AsyncChat(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}, stream bool, kwargs map[string]interface{}) (<-chan AsyncChatResult, error) {
	p.calls++
	answer := `{"answer":"truncated`
	if p.calls == 2 {
		answer = `{"answer":"好好休息，明天再慢慢来。","instructions":"台湾国语，轻柔安慰","voice":"serena","mode":"speech"}`
	}
	return makeResultChan(AsyncChatResult{Answer: answer, Final: true}), nil
}

func TestSpeechPlanRetriesTruncatedAnswer(t *testing.T) {
	pipeline := &speechPlanRetryPipeline{}
	service := &ChatSessionService{pipeline: pipeline}
	reply, err := service.generateSpeechReply(t.Context(), &entity.Chat{LLMID: "selected"}, []map[string]interface{}{
		{"role": "user", "content": "@语音 今天好累"},
	}, nil)
	if err != nil || pipeline.calls != 2 || reply["answer"] != "好好休息，明天再慢慢来。" {
		t.Fatalf("failed to regenerate malformed answer: calls=%d reply=%+v err=%v", pipeline.calls, reply, err)
	}
}

type speechRoutingPipeline struct {
	results    []AsyncChatResult
	planning   []bool
	chats      []*entity.Chat
	directives []string
}

func (p *speechRoutingPipeline) AsyncChat(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}, stream bool, kwargs map[string]interface{}) (<-chan AsyncChatResult, error) {
	p.planning = append(p.planning, ctx.Value(chatSpeechPlanningKey{}) == true)
	prepared := applyChatMediaDirective(ctx, chat)
	p.chats = append(p.chats, prepared)
	p.directives = append(p.directives, stringValue(prepared.PromptConfig["system"]))
	result := p.results[min(len(p.planning)-1, len(p.results)-1)]
	return makeResultChan(result), nil
}

func TestSpeechRoutingSeparatesCreativeRequestsFromKnowledgeAnswers(t *testing.T) {
	for _, creative := range []bool{false, true} {
		t.Run(map[bool]string{false: "knowledge", true: "singing"}[creative], func(t *testing.T) {
			chat := &entity.Chat{
				LLMID: "selected-model", KBIDs: entity.JSONSlice{"selected-kb"},
				PromptConfig: entity.JSONMap{"domain": "railway", "system": "Evidence rules", "tts": true},
			}
			plan := `{"answer":"","mode":"speech","instructions":"清晰冷静","use_knowledge":true}`
			if creative {
				plan = `{"answer":"月光轻轻落下来","mode":"singing","instructions":"温柔亲切","use_knowledge":false}`
			}
			reference := map[string]interface{}{"chunks": []interface{}{map[string]interface{}{"id": "source-1"}}}
			pipeline := &speechRoutingPipeline{results: []AsyncChatResult{
				{Answer: plan, Final: true},
				{Answer: "有依据的答案。[ID:0]", Reference: reference, Prompt: "grounded prompt",
					Usage: &ChatTurnUsage{TotalTokens: 12}, Final: true},
			}}
			service := &ChatSessionService{pipeline: pipeline}
			reply, err := service.generateSpeechReply(t.Context(), chat, []map[string]interface{}{
				{"role": "user", "content": "@语音 当前请求"},
			}, map[string]interface{}{"agent_mode": "smart-reasoning"})
			if err != nil {
				t.Fatal(err)
			}
			wantPlanning := []bool{true, false}
			wantAnswer, wantMode := "有依据的答案。[ID:0]", "speech"
			if creative {
				wantPlanning = []bool{true}
				wantAnswer, wantMode = "月光轻轻落下来", "singing"
			}
			if !reflect.DeepEqual(pipeline.planning, wantPlanning) {
				t.Fatalf("wrong retrieval routing: %v", pipeline.planning)
			}
			if strings.Contains(pipeline.directives[0], "Evidence rules") ||
				!strings.Contains(pipeline.directives[0], speechRoutingDirective) {
				t.Fatal("creative intent was constrained by the knowledge QA prompt")
			}
			speechPlan := reply["speech_plan"].(chatSpeechPlan)
			if reply["answer"] != wantAnswer || speechPlan.Answer != wantAnswer ||
				speechPlan.Mode != wantMode || speechPlan.Voice != chatVoiceName {
				t.Fatalf("answer or voice lost: %+v", reply)
			}
			if !creative && (pipeline.directives[1] != "Evidence rules" ||
				!reflect.DeepEqual(reply["reference"], reference) || reply["prompt"] != "grounded prompt" || reply["usage"] == nil) {
				t.Fatalf("knowledge answer lost its evidence or metadata: %+v", reply)
			}
			for _, prepared := range pipeline.chats {
				if prepared.LLMID != chat.LLMID || !reflect.DeepEqual(prepared.KBIDs, chat.KBIDs) || prepared.PromptConfig["tts"] != false {
					t.Fatal("routing changed the selected model, datasets, or synthesis count")
				}
			}
			if chat.PromptConfig["system"] != "Evidence rules" || chat.PromptConfig["tts"] != true {
				t.Fatal("routing mutated the saved chat")
			}
		})
	}
}

func TestSpeechRoutingRetriesMissingKnowledgeDecision(t *testing.T) {
	pipeline := &speechRoutingPipeline{results: []AsyncChatResult{
		{Answer: `{"answer":"没有路由决定","mode":"speech"}`, Final: true},
		{Answer: `{"answer":"晚安","mode":"speech","use_knowledge":false}`, Final: true},
	}}
	service := &ChatSessionService{pipeline: pipeline}
	reply, err := service.generateSpeechReply(t.Context(), &entity.Chat{KBIDs: entity.JSONSlice{"selected-kb"}},
		[]map[string]interface{}{{"role": "user", "content": "@语音 晚安"}}, nil)
	if err != nil || reply["answer"] != "晚安" || !reflect.DeepEqual(pipeline.planning, []bool{true, true}) ||
		!strings.Contains(pipeline.directives[1], "use_knowledge") {
		t.Fatalf("missing routing decision was not retried: reply=%+v err=%v", reply, err)
	}
}

func TestSpeechPlanAcceptsEmptyAnswerOnlyForKnowledgeRetrieval(t *testing.T) {
	for _, decision := range []string{"true", "false", "null"} {
		plan, err := parseSpeechPlan(`{"answer":"","use_knowledge":` + decision + `}`)
		if decision == "true" {
			if err != nil || plan.UseKnowledge == nil || !*plan.UseKnowledge {
				t.Fatalf("retrieval plan rejected: %+v %v", plan, err)
			}
		} else if err == nil {
			t.Fatalf("empty direct answer accepted with decision %s", decision)
		}
	}
}

func TestMediaDirectivePreservesSelectedChatAndSystem(t *testing.T) {
	chat := &entity.Chat{LLMID: "selected", KBIDs: entity.JSONSlice{"selected-kb"}, PromptConfig: entity.JSONMap{"system": "Evidence rules", "tts": false}}
	ctx := context.WithValue(t.Context(), chatMediaDirectiveKey{}, speechMediaDirective)
	prepared := applyChatMediaDirective(ctx, chat)
	if !strings.HasPrefix(stringValue(prepared.PromptConfig["system"]), "Evidence rules\n\n") ||
		!strings.Contains(stringValue(prepared.PromptConfig["system"]), `"instructions"`) ||
		prepared.LLMID != chat.LLMID || prepared.KBIDs[0] != "selected-kb" {
		t.Fatalf("chat selection or system lost: %+v", prepared)
	}
	if chat.PromptConfig["system"] != "Evidence rules" || applyChatMediaDirective(t.Context(), chat) != chat {
		t.Fatal("normal chat mutated")
	}
}

func TestSpeechPlanAllowsFormattingWithShortAnswerBudget(t *testing.T) {
	chat := &entity.Chat{LLMID: "selected", LLMSetting: entity.JSONMap{"max_tokens": 64, "temperature": 0.3}}
	pipeline := &speechReplyPipeline{fakePipeline: fakePipeline{resultChan: makeResultChan(AsyncChatResult{
		Answer: `{"answer":"辛苦了，先休息一下吧。","voice":"serena","instructions":"台湾国语，温柔甜美女声，轻柔安慰、放慢语速","mode":"speech"}`, Final: true,
	})}}
	service := &ChatSessionService{pipeline: pipeline}
	options := map[string]interface{}{"max_tokens": 32, "temperature": 0.4}
	reply, err := service.generateSpeechReply(t.Context(), chat, []map[string]interface{}{
		{"role": "user", "content": "@语音 今天加班好累"},
	}, options)
	if err != nil {
		t.Fatal(err)
	}
	plan := reply["speech_plan"].(chatSpeechPlan)
	if plan.Answer != "辛苦了，先休息一下吧。" || !strings.Contains(plan.Instructions, "台湾国语") || pipeline.chat.LLMSetting["max_tokens"] != 1024 {
		t.Fatalf("voice plan or formatting budget lost: %+v", plan)
	}
	if chat.LLMSetting["max_tokens"] != 64 || pipeline.chat.LLMSetting["temperature"] != 0.3 || pipeline.chat.LLMID != chat.LLMID {
		t.Fatal("selected model settings mutated")
	}
	if options["max_tokens"] != 32 || pipeline.options["max_tokens"] != 1024 || pipeline.options["temperature"] != 0.4 {
		t.Fatal("request budget overrides media budget or caller settings mutated")
	}
}

func TestChatImagePlanAndNativeSizes(t *testing.T) {
	for _, size := range []string{"2048x2048", "2048x1152", "1152x2048", "3840x2160", "3072x3072"} {
		if !validChatImageSize(size) {
			t.Errorf("rejected valid size %s", size)
		}
	}
	for _, size := range []string{"auto", "0x2048", "-16x2048", "2049x2048", "4096x4096", "3840x3840", "3840x256", "999999999999999x16"} {
		if validChatImageSize(size) {
			t.Errorf("accepted unsafe size %s", size)
		}
	}
	pipeline := &fakePipeline{resultChan: makeResultChan(AsyncChatResult{
		Answer: `{"prompt":"Only replace the background with sunset; preserve train and title 向山而行.","size":"2048x1152","use_previous_image":true}`, Final: true,
	})}
	service := &ChatSessionService{pipeline: pipeline}
	plan, err := service.planChatImage(t.Context(), &entity.Chat{}, []map[string]interface{}{
		{"role": "user", "content": "@生图 高铁海报，标题向山而行"},
		{"role": "assistant", "content": "![生成的图片](/api/v1/chats/ab/sessions/cd/media/ef.png)"},
		{"role": "user", "content": "@生图 只改成夕阳"},
	}, nil)
	if err != nil || !plan.UsePreviousImage || plan.Size != "2048x1152" || !strings.Contains(plan.Prompt, "向山而行") {
		t.Fatalf("edit intent lost: %+v %v", plan, err)
	}
	if len(pipeline.messages) != 3 || pipeline.messages[2]["content"] != "只改成夕阳" {
		t.Fatal("image planning lost conversation")
	}
}

func TestLocalSingingJobAndCancellation(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "audio", true: "cancel-failed-job"}[fail], func(t *testing.T) {
			cancelled := false
			referenceCalls := 0
			wav := make([]byte, 48)
			copy(wav, "RIFF")
			copy(wav[8:], "WAVE")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/audio/speech":
					var payload map[string]interface{}
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
					}
					if payload["voice"] != chatVoiceName || payload["input"] != chatMusicVoiceReferenceText ||
						payload["instructions"] != defaultSpeechInstructions()+" "+chatVoiceIdentityInstruction {
						t.Errorf("reference must use the speech speaker: %+v", payload)
					}
					referenceCalls++
					_, _ = w.Write(wav)
				case r.URL.Path == "/synth":
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						http.Error(w, "invalid multipart", http.StatusBadRequest)
						return
					}
					defer r.MultipartForm.RemoveAll()
					var payload map[string]interface{}
					if err := json.Unmarshal([]byte(r.FormValue("request")), &payload); err != nil {
						t.Error(err)
					}
					reference, _, err := r.FormFile("ref_audio")
					if err != nil {
						t.Error("missing Serena reference audio:", err)
						http.Error(w, "missing reference", http.StatusBadRequest)
						return
					}
					defer reference.Close()
					audio, err := io.ReadAll(reference)
					if err != nil || !bytes.Equal(audio, wav) || len(r.MultipartForm.File["audio"]) != 0 {
						t.Error("reference must condition timbre without becoming source audio")
					}
					caption := payload["caption"].(string)
					if payload["lyrics"] != "月光轻轻落下来" || payload["output_format"] != "wav16" || payload["vocal_language"] != "zh" ||
						!strings.Contains(caption, chatMusicVoiceProfile) {
						t.Errorf("invalid singing request: %+v", payload)
					}
					_, _ = w.Write([]byte(`{"id":"test-job"}`))
				case r.URL.Query().Get("cancel") == "1":
					if r.Method != http.MethodPost {
						t.Error("job cancellation requires POST")
					}
					cancelled = true
					_, _ = w.Write([]byte(`{"status":"cancelled"}`))
				case r.URL.Query().Get("result") == "1":
					writer := multipart.NewWriter(w)
					w.Header().Set("Content-Type", "multipart/mixed; boundary="+writer.Boundary())
					part, _ := writer.CreatePart(textproto.MIMEHeader{"Content-Type": []string{"audio/wav"}})
					_, _ = part.Write(wav)
					_ = writer.Close()
				default:
					status := "done"
					if fail {
						status = "failed"
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
				}
			}))
			defer server.Close()
			t.Setenv("RAGFLOW_MUSIC_BASE_URL", server.URL)
			t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
			audio, err := synthesizeLocalMusic(t.Context(), chatSpeechPlan{
				Answer: "月光轻轻落下来", MusicCaption: "Sweet female Mandarin lullaby", Duration: 15,
			})
			if referenceCalls != 1 {
				t.Fatalf("expected one Serena reference, got %d", referenceCalls)
			}
			if fail {
				if err == nil || !cancelled {
					t.Fatalf("failed job not cancelled: %v %v", err, cancelled)
				}
			} else if err != nil || string(audio) != string(wav) || cancelled {
				t.Fatalf("song decode failed: %v", err)
			}
		})
	}
}

func TestLocalSingingRequiresVoiceReference(t *testing.T) {
	synthCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/synth" {
			synthCalled = true
		}
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	t.Setenv("RAGFLOW_MUSIC_BASE_URL", server.URL)
	t.Setenv("RAGFLOW_TTS_BASE_URL", server.URL)
	_, err := synthesizeLocalMusic(t.Context(), chatSpeechPlan{MusicCaption: "Soft Mandarin lullaby"})
	if err == nil || !strings.Contains(err.Error(), "音色参考") || synthCalled {
		t.Fatalf("singing must not silently drop the voice reference: called=%v err=%v", synthCalled, err)
	}
}
