package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extensionast "github.com/yuin/goldmark/extension/ast"
	markdownhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/entity/models"
	"ragflow/internal/service/file"
	"ragflow/internal/storage"
	"ragflow/internal/utility"
)

const chatMediaBucket = "chat-media"
const chatMediaMaxBytes = 32 << 20
const chatImageModel = "gpt-image-2.5-sunburst"

var chatMediaCommand = regexp.MustCompile(`(?i)^@(语音|Qwen3-TTS|生图)(?:\s+|[：:])([\s\S]*)$`)
var chatMediaAssetName = regexp.MustCompile(`^[a-f0-9]{32}\.(png|jpg|webp|wav)$`)
var chatSpeechLink = regexp.MustCompile(`\[(?:Qwen3-TTS )?语音\]\(/api/v1/chats/[a-f0-9]+/sessions/[a-f0-9]+/media/[a-f0-9]+\.wav\)`)

func parseChatMediaCommand(content string) (string, string, bool) {
	content = strings.TrimSpace(content)
	for _, command := range []string{"@语音", "@Qwen3-TTS", "@生图"} {
		if strings.EqualFold(content, command) {
			return strings.ToLower(strings.TrimPrefix(command, "@")), "", true
		}
	}
	match := chatMediaCommand.FindStringSubmatch(content)
	if match == nil {
		return "", "", false
	}
	return strings.ToLower(match[1]), strings.TrimSpace(match[2]), true
}

func chatMediaCommandMode(kind, mode string) string {
	if kind == "生图" {
		return "image"
	}
	if mode == "music" {
		return mode
	}
	return "voice"
}

// completeMedia is executed under the durable worker's lease.
func (s *ChatSessionService) completeMedia(ctx context.Context, dialog *entity.Chat, session *entity.ChatSession, messages []map[string]interface{}, messageID, kind, prompt string, kwargs map[string]interface{}) (map[string]interface{}, error) {
	if prompt == "" {
		return nil, errors.New("请在 @ 指令后输入要生成的内容")
	}
	if session == nil {
		return nil, errors.New("请在已保存的聊天会话中使用生图和语音")
	}
	if tenant := strings.TrimSpace(os.Getenv("RAGFLOW_MEDIA_TENANT_ID")); tenant == "" || tenant != dialog.TenantID {
		return nil, errors.New("当前工作空间尚未配置生图和语音")
	}
	execution := chatExecution(ctx)
	if execution == nil || execution.input == nil {
		return nil, errors.New("media execution requires a durable task lease")
	}
	if err := validateChatMediaRoute(kwargs); err != nil {
		return nil, err
	}
	input := execution.input
	if input.Resume != nil {
		if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "output_reused",
			func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
				task.Outputs = input.Resume
				return entity.JSONMap{"retry_of": task.RetryOf}, nil
			}); err != nil {
			return nil, err
		}
	}
	if kind == "image_voice" {
		return s.completeChatImageVoice(ctx, dialog, session, messages, messageID, prompt, kwargs)
	}
	return s.completeMediaBranch(ctx, dialog, session, messages, messageID, kind, prompt, kwargs)
}

func (s *ChatSessionService) completeMediaBranch(ctx context.Context, dialog *entity.Chat, session *entity.ChatSession, messages []map[string]interface{}, messageID, kind, prompt string, kwargs map[string]interface{}) (map[string]interface{}, error) {
	execution := chatExecution(ctx)
	input := execution.input
	var audio []byte
	var err error
	var reply map[string]interface{}
	var imagePlan *chatImagePlan
	extension, mediaType := "", ""
	isSpeech := kind == "语音" || kind == "qwen3-tts"
	outputKind := "image"
	if isSpeech {
		outputKind = "audio"
	}
	if input.Resume[outputKind] != nil {
		if answer, ok := input.Resume["answer"].(map[string]interface{}); ok {
			return answer, nil
		}
		return nil, errors.New("checkpoint_incomplete: saved media has no answer")
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, errors.New("persistence_failed: media storage unavailable")
	}
	reused, err := reusableChatMedia(ctx, execution, store, isSpeech)
	if err != nil {
		return nil, err
	}
	if isSpeech {
		if saved, ok := input.Resume["text"].(map[string]interface{}); ok {
			reply = saved
		} else {
			reply, err = s.generateSpeechReply(ctx, dialog, messages, kwargs)
			if err != nil {
				return nil, err
			}
		}
		var plan chatSpeechPlan
		encoded, _ := json.Marshal(reply["speech_plan"])
		if json.Unmarshal(encoded, &plan) != nil || plan.Answer == "" || plan.Voice != chatVoiceName {
			return nil, errors.New("checkpoint_incomplete: invalid saved speech plan")
		}
		answer := chatTextAnswer(messageID, reply)
		if input.Resume["text"] == nil {
			if err := execution.commitText(ctx, reply, answer); err != nil {
				return nil, err
			}
		}
		if reused != nil {
			mediaType = reused.MIMEType
		} else if plan.Mode == "singing" {
			audio, err = synthesizeLocalMusic(ctx, plan)
		} else {
			audio, err = synthesizeLocalSpeech(ctx, ChatSpeechText(plan.Answer), plan)
		}
		extension, mediaType = "wav", "audio/wav"
	} else if kind == "生图" {
		if utf8.RuneCountInString(prompt) > 8000 {
			return nil, errors.New("图片描述最多支持 8000 个字符")
		}
		plan, saved := readChatImagePlan(input.Resume["image_plan"])
		if !saved {
			var planErr error
			plan, planErr = s.planChatImage(ctx, dialog, messages, kwargs)
			if planErr != nil {
				return nil, planErr
			}
			if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "plan_saved",
				func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
					if task.Outputs == nil {
						task.Outputs = entity.JSONMap{}
					}
					task.Outputs["image_plan"] = plan
					return entity.JSONMap{"stage": "image"}, nil
				}); err != nil {
				return nil, err
			}
		}
		imagePlan = &plan
		if reused == nil {
			var images []string
			images, err = chatImageReferences(ctx, messages[len(messages)-1]["files"])
			if err != nil {
				return nil, err
			}
			if plan.UsePreviousImage {
				previous, imageErr := s.chatImageAsset(ctx, dialog, session, input.ParentID)
				if imageErr != nil {
					return nil, imageErr
				}
				images = append([]string{previous}, images...)
			}
			audio, mediaType, err = generateChatImage(ctx, buildChatImagePrompt(plan, prompt, len(images)), plan.Size, images...)
			switch mediaType {
			case "image/png":
				extension = "png"
			case "image/jpeg":
				extension = "jpg"
			case "image/webp":
				extension = "webp"
			}
		}
	} else {
		return nil, errors.New("unsupported_capability: this media mode is unavailable")
	}
	if err != nil {
		return nil, err
	}
	finishSave := measureChatTaskPhase(ctx, "save")
	defer finishSave()
	record := reused
	if record == nil {
		assetID := common.GenerateToken()
		key := session.ID + "/" + assetID + "." + extension
		record = &entity.ChatMediaAsset{ID: assetID, SourceKey: "task:" + execution.task.ID + ":" + assetID,
			TenantID: dialog.TenantID, SessionID: session.ID, TurnID: messageID, TaskID: execution.task.ID,
			Kind: "image", Bucket: chatMediaBucket, ObjectKey: key,
			MIMEType: mediaType, Bytes: int64(len(audio)), State: "staging", CreatedAt: time.Now().UnixMilli()}
		if isSpeech {
			record.Kind, record.ParentID = "audio", ""
			record.DurationMs, err = validateChatWAV(audio)
			if err != nil {
				return nil, err
			}
		} else if dimensions, _, decodeErr := image.DecodeConfig(bytes.NewReader(audio)); decodeErr == nil {
			record.Width, record.Height = dimensions.Width, dimensions.Height
		}
		if imagePlan != nil && imagePlan.UsePreviousImage {
			record.ParentID = input.ParentID
		}
		// Journal the object before Put so a crash cannot leave an undiscoverable object.
		err = execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "output_staging",
			func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
				record.OutputRevision = task.Revision + 1
				return entity.JSONMap{"asset_id": assetID}, tx.Create(record).Error
			})
		if err != nil {
			return nil, err
		}
		for attempt := 0; attempt < 3; attempt++ {
			err = store.Put(ctx, chatMediaBucket, key, audio)
			if err == nil || ctx.Err() != nil {
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(1<<attempt) * 100 * time.Millisecond):
			}
		}
		if err != nil {
			return nil, fmt.Errorf("persistence_failed: media storage: %w", err)
		}
	}
	assetID := record.ID
	asset := strings.TrimPrefix(record.ObjectKey, session.ID+"/")
	mediaType = record.MIMEType
	assetURL := fmt.Sprintf("/api/v1/chats/%s/sessions/%s/media/%s", dialog.ID, session.ID, asset)
	content := "![生成的图片](" + assetURL + ")"
	if isSpeech {
		content = stringValue(reply["answer"]) + "\n\n[语音](" + assetURL + ")"
	}
	answer := map[string]interface{}{
		"id": messageID, "role": "assistant", "content": content,
		"created_at": float64(time.Now().UnixNano()) / 1e9,
	}
	if imagePlan != nil {
		answer["image_plan"] = *imagePlan
	}
	answer["media_assets"] = []interface{}{map[string]interface{}{
		"id": assetID, "kind": record.Kind, "url": assetURL, "parent_id": record.ParentID, "mime_type": mediaType,
		"width": record.Width, "height": record.Height, "duration_ms": record.DurationMs, "output_revision": record.OutputRevision}}
	var reference []interface{}
	if reply != nil {
		for _, key := range []string{"reference", "prompt", "usage", "elapsed_ms"} {
			if value, ok := reply[key]; ok {
				answer[key] = value
			}
		}
		if ref, ok := reply["reference"].(map[string]interface{}); ok {
			reference = []interface{}{ref}
		}
	}
	err = execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "output_committed",
		func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			if task.Outputs == nil {
				task.Outputs = entity.JSONMap{}
			}
			locked, err := dao.LockChatMediaAssets(tx, record.ID, record.ParentID)
			if err != nil {
				return nil, err
			}
			if locked[record.ID].State != "staging" {
				return nil, dao.ErrChatMediaReclaimed
			}
			if record.ParentID != "" && locked[record.ParentID].State != "committed" {
				return nil, dao.ErrChatMediaReclaimed
			}
			record.State = "committed"
			if err := tx.Save(record).Error; err != nil {
				return nil, err
			}
			ref := entity.ChatMediaReference{AssetID: assetID, OwnerKind: "message", OwnerID: session.ID + ":" + messageID}
			refs := []entity.ChatMediaReference{ref}
			if record.ParentID != "" {
				parent := entity.ChatMediaReference{AssetID: record.ParentID, OwnerKind: "parent", OwnerID: assetID}
				refs = append(refs, parent)
			}
			if err := dao.ReferenceChatMedia(tx, refs...); err != nil {
				return nil, err
			}
			task.Outputs[record.Kind], task.Outputs["answer"] = answer["media_assets"], answer
			if imagePlan != nil {
				task.Outputs["image_plan"] = *imagePlan
			}
			answer = mergeChatMediaAnswer(task, answer)
			task.Outputs["answer"] = answer
			return entity.JSONMap{"asset_id": assetID, "kind": record.Kind},
				s.chatSessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
					"history_update": dao.ConversationHistoryUpdate{Message: answer, QuestionID: messageID,
						ExpectedVersion: input.ExpectedAnswerVersion, ExpectedAbsent: input.ExpectedAnswerAbsent},
				})
		})
	if err != nil {
		return nil, fmt.Errorf("persistence_failed: media commit: %w", err)
	}
	execution.advanceAnswerVersion(answer)
	result := s.structureAnswer(session, stringValue(answer["content"]), messageID, session.ID, reference)
	if reply != nil {
		for _, key := range []string{"prompt", "usage", "elapsed_ms"} {
			if value, ok := reply[key]; ok {
				result[key] = value
			}
		}
	}
	result["final"] = true
	result["chat_id"] = dialog.ID
	result["media_assets"] = answer["media_assets"]
	for _, key := range []string{"reference", "prompt", "usage", "elapsed_ms", "image_plan", "output_revision"} {
		if value := answer[key]; value != nil {
			result[key] = value
		}
	}
	return result, nil
}

func reusableChatMedia(ctx context.Context, execution *chatTaskExecution, store storage.Storage, speech bool) (*entity.ChatMediaAsset, error) {
	kind := "image"
	if speech {
		kind = "audio"
	}
	var assets []entity.ChatMediaAsset
	err := dao.DB.WithContext(ctx).Where("session_id = ? AND tenant_id = ? AND turn_id = ? AND kind = ? AND state = ? AND (task_id = ? OR id IN (?))",
		execution.task.SessionID, execution.task.TenantID, execution.task.TurnID, kind, "staging", execution.task.ID,
		dao.DB.Model(&entity.ChatMediaReference{}).Select("asset_id").Where("owner_kind = ? AND owner_id = ?", "task", execution.task.ID)).
		Order("created_at DESC").Order("id").Find(&assets).Error
	if err != nil {
		return nil, err
	}
	for i := range assets {
		asset := &assets[i]
		exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
		if err != nil {
			return nil, errors.New("媒体存储不可用")
		}
		if !exists {
			continue
		}
		data, err := storage.GetBounded(ctx, store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
		if err != nil || int64(len(data)) != asset.Bytes {
			return nil, errors.New("saved media is incomplete")
		}
		if kind == "image" {
			if _, err := file.ValidateChatImage(data, asset.MIMEType); err != nil {
				return nil, err
			}
		} else {
			asset.DurationMs, err = validateChatWAV(data)
			if err != nil {
				return nil, err
			}
		}
		return asset, nil
	}
	return nil, nil
}

func chatTextAnswer(messageID string, reply map[string]interface{}) map[string]interface{} {
	answer := map[string]interface{}{"id": messageID, "role": "assistant", "content": reply["answer"],
		"created_at": float64(time.Now().UnixNano()) / 1e9}
	for _, key := range []string{"reference", "prompt", "usage", "elapsed_ms"} {
		if value := reply[key]; value != nil {
			answer[key] = value
		}
	}
	return answer
}

func mergeChatMediaAnswer(task *entity.ChatTask, answer map[string]interface{}) map[string]interface{} {
	if reply, ok := task.Outputs["text"].(map[string]interface{}); ok {
		answer["content"] = stringValue(reply["answer"])
		for _, key := range []string{"reference", "prompt", "usage", "elapsed_ms"} {
			if value := reply[key]; value != nil {
				answer[key] = value
			}
		}
	} else {
		answer["content"] = ""
	}
	assets := []interface{}{}
	for _, kind := range []string{"image", "audio"} {
		outputs, _ := task.Outputs[kind].([]interface{})
		for _, output := range outputs {
			asset, ok := output.(map[string]interface{})
			if !ok {
				continue
			}
			assets = append(assets, asset)
			link := "[语音](" + stringValue(asset["url"]) + ")"
			if kind == "image" {
				link = "![生成的图片](" + stringValue(asset["url"]) + ")"
			}
			answer["content"] = strings.TrimSpace(stringValue(answer["content"]) + "\n\n" + link)
		}
	}
	if plan := task.Outputs["image_plan"]; plan != nil {
		answer["image_plan"] = plan
	}
	answer["media_assets"], answer["task_id"], answer["output_revision"] = assets, task.ID, task.Revision+1
	return answer
}

func (s *ChatSessionService) generateSpeechReply(ctx context.Context, dialog *entity.Chat, messages []map[string]interface{}, kwargs map[string]interface{}) (map[string]interface{}, error) {
	directive := speechMediaDirective
	if stringValue(kwargs["mode"]) == "music" {
		directive += "\n当前用户已明确选择唱歌模式，必须返回 mode=\"singing\"、完整歌词及 music_caption。"
	}
	planningCtx := ctx
	routeKnowledge := len(chatDatasetIDs(dialog)) > 0 || isRailwayChat(dialog)
	if routeKnowledge {
		planningCtx = context.WithValue(ctx, chatSpeechPlanningKey{}, true)
		directive = strings.Replace(directive, speechPlanExample, speechRoutingPlanExample, 1)
		directive += speechRoutingDirective
	}
	for attempt := 0; attempt < 2; attempt++ {
		var reply map[string]interface{}
		var err error
		execution := chatExecution(ctx)
		if execution != nil {
			reply, _ = execution.input.Resume["speech_planning"].(map[string]interface{})
		}
		if reply == nil {
			reply, err = s.generateMediaReply(planningCtx, dialog, messages, kwargs, directive)
		}
		if err != nil {
			return nil, err
		}
		plan, err := parseSpeechPlan(stringValue(reply["answer"]))
		if err == nil && routeKnowledge && plan.UseKnowledge == nil {
			err = errors.New("语音计划缺少 use_knowledge 字段")
		}
		if err == nil {
			if stringValue(kwargs["mode"]) == "music" && plan.Mode != "singing" && !routeKnowledge {
				return nil, errors.New("invalid_plan: music mode requires a singing plan")
			}
			if routeKnowledge && *plan.UseKnowledge {
				if execution != nil && execution.input.Resume["speech_planning"] == nil {
					if err := execution.dao.Mutate(ctx, execution.task.ID, execution.owner, execution.task.LeaseEpoch, "plan_saved",
						func(_ *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
							if task.Outputs == nil {
								task.Outputs = entity.JSONMap{}
							}
							task.Outputs["speech_planning"] = reply
							return entity.JSONMap{"stage": "answer"}, nil
						}); err != nil {
						return nil, err
					}
					if execution.input.Resume == nil {
						execution.input.Resume = map[string]interface{}{}
					}
					execution.input.Resume["speech_planning"] = reply
				}
				// Retrieve with the ordinary QA policy; the speech plan controls
				// delivery, while the grounded answer owns text and citations.
				reply, err = s.generateMediaReply(ctx, dialog, messages, kwargs, "")
				if err != nil {
					return nil, err
				}
				plan.Answer = stringValue(reply["answer"])
				plan.Mode = "speech"
			}
			reply["answer"], reply["speech_plan"] = plan.Answer, plan
			return reply, nil
		}
		if attempt == 1 || ctx.Err() != nil {
			return nil, fmt.Errorf("invalid_plan: %w", err)
		}
		common.Warn("Retrying invalid speech plan", zap.Error(err))
		directive += "\n上一次回答未通过格式校验：" + err.Error() + "。请重新完整回答当前用户的问题，严格返回上述 JSON 对象，完整闭合所有字段，使用整数 duration，将歌词和回答中的换行写为 \\n，不添加代码围栏或 JSON 以外的说明。"
	}
	return nil, errors.New("语音回答生成失败，请重试")
}

func (s *ChatSessionService) generateMediaReply(ctx context.Context, dialog *entity.Chat, messages []map[string]interface{}, kwargs map[string]interface{}, directive string) (map[string]interface{}, error) {
	if directive != "" {
		finishPlanning := measureChatTaskPhase(ctx, "planning")
		defer finishPlanning()
	}
	history := make([]map[string]interface{}, len(messages))
	for i, message := range messages {
		copy := make(map[string]interface{}, len(message))
		for key, value := range message {
			copy[key] = value
		}
		if content, ok := copy["content"].(string); ok {
			if _, prompt, matched := parseChatMediaCommand(content); matched && copy["role"] == "user" {
				content = prompt
			}
			if copy["role"] == "assistant" {
				content = strings.TrimSpace(chatSpeechLink.ReplaceAllString(content, ""))
			}
			copy["content"] = content
		}
		history[i] = copy
	}
	// Keep the selected model; the private directive selects the media flow.
	chat := *dialog
	chat.PromptConfig = make(entity.JSONMap, len(dialog.PromptConfig)+1)
	for key, value := range dialog.PromptConfig {
		chat.PromptConfig[key] = value
	}
	chat.PromptConfig["tts"] = false
	chat.LLMSetting = make(entity.JSONMap, len(dialog.LLMSetting)+1)
	for key, value := range dialog.LLMSetting {
		chat.LLMSetting[key] = value
	}
	minBudget := 1024
	if ctx.Value(chatImagePlanningKey{}) == true {
		minBudget = 8192
	}
	// Private plans need enough room to preserve detailed user constraints.
	if budget, ok := chatConfigPositiveInt(chat.LLMSetting["max_tokens"]); (ok && budget < minBudget) || (!ok && ctx.Value(chatImagePlanningKey{}) == true) {
		chat.LLMSetting["max_tokens"] = minBudget
	}
	options := make(map[string]interface{}, len(kwargs))
	for key, value := range kwargs {
		options[key] = value
	}
	if budget, ok := chatConfigPositiveInt(options["max_tokens"]); ok && budget < minBudget {
		options["max_tokens"] = minBudget
	}
	if ctx.Value(chatImagePlanningKey{}) == true {
		chat.LLMSetting["temperature"] = 0.2
		options["temperature"] = 0.2
	}
	ctx = context.WithValue(ctx, chatMediaDirectiveKey{}, directive)
	results, err := s.pipeline.AsyncChat(ctx, &chat, history, false, options)
	if err != nil {
		return nil, err
	}
	reply, resultErr := accumulateNonStreamAnswer(results)
	if execution := chatExecution(ctx); execution != nil && execution.deferred.Load() {
		return nil, errChatTaskDeferred
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if resultErr != nil {
		return nil, resultErr
	}
	answer := stringValue(reply["answer"])
	if ctx.Value(chatImagePlanningKey{}) != true && ChatSpeechText(answer) == "" {
		return nil, errors.New("模型没有生成可朗读的回答，请重试")
	}
	return reply, nil
}

// ChatSpeechText is the spoken form used by both generated replies and read aloud.
// Code, tables, images and citations are omitted; link labels remain readable.
func ChatSpeechText(answer string) string {
	source := []byte(CitationMarkerPattern.ReplaceAllString(ExtractVisibleAnswer(answer), ""))
	document := goldmark.New(goldmark.WithExtensions(extension.Table)).Parser().Parse(text.NewReader(source))
	var spoken strings.Builder
	writer := bufio.NewWriter(&spoken)
	// Goldmark's writer resolves Markdown escapes and entities without decoding escaped entities twice.
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch node := node.(type) {
			case *ast.Image, *ast.HTMLBlock, *ast.RawHTML, *ast.CodeSpan, *ast.CodeBlock, *ast.FencedCodeBlock, *extensionast.Table:
				return ast.WalkSkipChildren, nil
			case *ast.Text:
				if node.IsRaw() {
					markdownhtml.DefaultWriter.RawWrite(writer, node.Segment.Value(source))
				} else {
					markdownhtml.DefaultWriter.Write(writer, node.Segment.Value(source))
				}
				if node.SoftLineBreak() || node.HardLineBreak() {
					_ = writer.WriteByte('\n')
				}
			case *ast.String:
				if node.IsRaw() || node.IsCode() {
					markdownhtml.DefaultWriter.RawWrite(writer, node.Value)
				} else {
					markdownhtml.DefaultWriter.Write(writer, node.Value)
				}
			case *ast.AutoLink:
				markdownhtml.DefaultWriter.RawWrite(writer, node.Label(source))
			}
		} else if node.Type() == ast.TypeBlock {
			_ = writer.WriteByte('\n')
		}
		return ast.WalkContinue, nil
	})
	_ = writer.Flush()
	return strings.TrimSpace(html.UnescapeString(spoken.String()))
}

func synthesizeLocalSpeech(ctx context.Context, text string, plan chatSpeechPlan) (audio []byte, callErr error) {
	endpoint := strings.TrimRight(os.Getenv("RAGFLOW_TTS_BASE_URL"), "/")
	if endpoint == "" {
		return nil, errors.New("Qwen3-TTS 尚未启动，请使用项目启动脚本")
	}
	ctx, finish, err := common.BeginModelCall(ctx, "audio", "Qwen3-TTS-12Hz-1.7B-CustomVoice")
	if err != nil {
		return nil, err
	}
	defer func() { finish(callErr) }()
	payload := map[string]interface{}{
		"model": "Qwen3-TTS-12Hz-1.7B-CustomVoice", "input": text,
		"voice": plan.Voice, "language": "zh", "response_format": "wav", "instructions": plan.Instructions,
	}
	body, err := requestChatMedia(ctx, endpoint+"/audio/speech", "", payload)
	if err != nil {
		return nil, fmt.Errorf("Qwen3-TTS 调用失败，请检查项目语音进程：%w", err)
	}
	if _, err := validateChatWAV(body); err != nil {
		return nil, &chatUpstreamStoppedError{message: err.Error()}
	}
	return body, nil
}

func chatImageReferences(ctx context.Context, attachments interface{}) ([]string, error) {
	descriptors, ok := parseFileDicts(attachments)
	if !ok {
		return nil, nil
	}
	_, images, err := file.NewFileService(nil).GetFileContents(ctx, descriptors)
	if err != nil {
		return nil, errors.New("无法读取参考图片，请重新上传")
	}
	if len(images) != len(descriptors) {
		return nil, errors.New("@生图 的参考附件必须是可读取的图片，请移除文档或重新上传")
	}
	return images, nil
}

func generateChatImage(ctx context.Context, prompt, size string, images ...string) (data []byte, mime string, callErr error) {
	if !validChatImageSize(size) {
		return nil, "", errors.New("图片尺寸不支持")
	}
	endpoint := strings.TrimRight(os.Getenv("RAGFLOW_IMAGE_BASE_URL"), "/")
	apiKey := os.Getenv("RAGFLOW_IMAGE_API_KEY")
	if endpoint == "" || apiKey == "" {
		return nil, "", errors.New("生图模型尚未配置")
	}
	var body []byte
	var err error
	var payload bytes.Buffer
	contentType := "application/json"
	path := "/images/generations"
	if len(images) == 0 {
		body, err = json.Marshal(map[string]interface{}{
			"model": chatImageModel, "prompt": prompt, "n": 1, "size": size, "quality": "high", "response_format": "b64_json",
		})
		if err != nil {
			return nil, "", err
		}
		payload.Write(body)
	} else {
		form := multipart.NewWriter(&payload)
		for key, value := range map[string]string{
			"model": chatImageModel, "prompt": prompt, "n": "1", "size": size, "quality": "high", "response_format": "b64_json",
		} {
			if err := form.WriteField(key, value); err != nil {
				return nil, "", err
			}
		}
		for i, image := range images {
			_, encoded, ok := strings.Cut(image, ";base64,")
			data, decodeErr := base64.StdEncoding.DecodeString(encoded)
			if !ok || decodeErr != nil || len(data) == 0 || len(data) > chatMediaMaxBytes {
				return nil, "", errors.New("参考图片无效或超过 32 MB，请重新上传")
			}
			extension := ""
			switch http.DetectContentType(data) {
			case "image/png":
				extension = "png"
			case "image/jpeg":
				extension = "jpg"
			case "image/webp":
				extension = "webp"
			default:
				return nil, "", errors.New("参考图片支持 PNG、JPEG 和 WebP 格式")
			}
			field := "image"
			if len(images) > 1 {
				field = "image[]"
			}
			part, partErr := form.CreateFormFile(field, fmt.Sprintf("reference-%d.%s", i+1, extension))
			if partErr != nil {
				return nil, "", partErr
			}
			if _, err = part.Write(data); err != nil {
				return nil, "", err
			}
			if payload.Len() > 2*chatMediaMaxBytes {
				return nil, "", errors.New("参考图片总大小不能超过 64 MB")
			}
		}
		if err = form.Close(); err != nil {
			return nil, "", err
		}
		contentType, path = form.FormDataContentType(), "/images/edits"
	}
	ctx, finish, beginErr := common.BeginModelCall(ctx, "image", chatImageModel)
	if beginErr != nil {
		return nil, "", beginErr
	}
	defer func() { finish(callErr) }()
	body, err = requestChatMediaBody(ctx, endpoint+path, apiKey, &payload, contentType)
	if err != nil {
		return nil, "", fmt.Errorf("生图模型调用失败：%w", err)
	}
	return decodeChatImage(ctx, body)
}

func decodeChatImage(ctx context.Context, body []byte) ([]byte, string, error) {
	var result struct {
		Data []struct {
			Base64 string `json:"b64_json"`
			URL    string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, "", &chatUpstreamStoppedError{cause: "image_response_invalid_json", message: "生图服务返回的不是有效图片响应"}
	}
	if len(result.Data) == 0 {
		return nil, "", &chatUpstreamStoppedError{cause: "image_response_missing_data", message: "生图服务没有返回图片数据"}
	}
	entry := result.Data[0]
	var image []byte
	var err error
	switch {
	case entry.Base64 != "":
		image, err = base64.StdEncoding.DecodeString(entry.Base64)
		if err != nil || len(image) == 0 || len(image) > chatMediaMaxBytes {
			return nil, "", &chatUpstreamStoppedError{cause: "image_response_invalid_base64", message: "生图服务返回的图片数据无效或过大"}
		}
	case entry.URL != "":
		image, err = utility.FetchPublicFileSafely(ctx, entry.URL, chatMediaMaxBytes)
		if err != nil {
			return nil, "", &chatUpstreamStoppedError{cause: "image_response_download_failed", message: "生图服务已返回结果，但未能下载图片"}
		}
	default:
		return nil, "", &chatUpstreamStoppedError{cause: "image_response_missing_data", message: "生图服务没有返回图片数据"}
	}
	mediaType, validationErr := file.ValidateChatImage(image, "")
	if validationErr != nil {
		return nil, "", &chatUpstreamStoppedError{cause: "image_response_invalid_file", message: "生图服务返回了损坏的图片"}
	}
	switch mediaType {
	case "image/png", "image/jpeg", "image/webp":
		return image, mediaType, nil
	default:
		return nil, "", &chatUpstreamStoppedError{cause: "image_response_invalid_file", message: "生图服务返回了不支持的图片格式"}
	}
}

func requestChatMedia(ctx context.Context, endpoint, apiKey string, payload map[string]interface{}) ([]byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return requestChatMediaBody(ctx, endpoint, apiKey, bytes.NewReader(data), "application/json")
}

func requestChatMediaBody(ctx context.Context, endpoint, apiKey string, body io.Reader, contentType string) ([]byte, error) {
	target, err := url.Parse(endpoint)
	if err != nil || target.Host == "" || (target.Scheme != "https" && target.Scheme != "http") {
		return nil, errors.New("模型地址配置无效")
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, body)
	if err != nil {
		return nil, errors.New("无法创建模型请求")
	}
	req.Header.Set("Content-Type", contentType)
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var dialErr *net.OpError
		if errors.As(err, &dialErr) && dialErr.Op == "dial" {
			// No connection was established, so this request cannot still generate.
			return nil, &chatUpstreamStoppedError{cause: "upstream_connection_failed", message: "模型连接失败，请检查模型服务是否已启动"}
		}
		return nil, errChatMediaTransport
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Upstream error bodies can contain credentials or internal URLs.
		return nil, &models.APIStatusError{Status: resp.StatusCode}
	}
	response, err := io.ReadAll(io.LimitReader(resp.Body, 2*chatMediaMaxBytes+1))
	if err != nil {
		return nil, errChatMediaResponseRead
	}
	if len(response) > 2*chatMediaMaxBytes {
		return nil, errChatMediaResponseTooLarge
	}
	return response, nil
}

type chatUpstreamStoppedError struct {
	message string
	cause   string
}

func (e *chatUpstreamStoppedError) Error() string { return e.message }

var (
	errChatMediaTransport        = errors.New("模型连接中断或超时")
	errChatMediaResponseRead     = errors.New("模型响应未能完整读取")
	errChatMediaResponseTooLarge = errors.New("模型响应超过大小上限")
)

func (s *ChatSessionService) chatImageAsset(ctx context.Context, dialog *entity.Chat, session *entity.ChatSession, id string) (string, error) {
	var asset entity.ChatMediaAsset
	if id == "" {
		return "", errors.New("当前会话没有选中的编辑图片")
	}
	if err := dao.DB.WithContext(ctx).Take(&asset, "id = ? AND session_id = ? AND tenant_id = ? AND state = ? AND kind = ?",
		id, session.ID, dialog.TenantID, "committed", "image").Error; err != nil {
		return "", errors.New("编辑图片不可用")
	}
	var references int64
	if err := dao.DB.WithContext(ctx).Model(&entity.ChatMediaReference{}).
		Where("asset_id = ? AND owner_kind = ?", id, "message").Count(&references).Error; err != nil || references == 0 {
		return "", errors.New("编辑图片不可用")
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return "", errors.New("media storage unavailable")
	}
	data, err := storage.GetBounded(ctx, store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
	if err != nil {
		return "", errors.New("无法读取选中的图片")
	}
	mime, err := file.ValidateChatImage(data, asset.MIMEType)
	if err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func (s *ChatSessionService) GetSessionMedia(ctx context.Context, chatID, sessionID, asset string) ([]byte, string, error) {
	if !chatMediaAssetName.MatchString(asset) {
		return nil, "", errors.New("media not found")
	}
	session, _, err := s.GetSession(ctx, chatID, sessionID)
	if err != nil {
		return nil, "", err
	}
	dialog, err := dao.NewChatDAO().GetByIDAndStatus(ctx, dao.DB, chatID, string(entity.StatusValid))
	if err != nil {
		return nil, "", errors.New("media not found")
	}
	assetID, _, _ := strings.Cut(asset, ".")
	var record entity.ChatMediaAsset
	if err := dao.DB.WithContext(ctx).Take(&record,
		"id = ? AND session_id = ? AND tenant_id = ? AND state = ?",
		assetID, session.ID, dialog.TenantID, "committed").Error; err != nil {
		return nil, "", errors.New("media not found")
	}
	var references int64
	if err := dao.DB.WithContext(ctx).Model(&entity.ChatMediaReference{}).
		Where("asset_id = ? AND owner_kind = ?", assetID, "message").Count(&references).Error; err != nil || references == 0 {
		return nil, "", errors.New("media not found")
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, "", errors.New("media storage unavailable")
	}
	data, err := storage.GetBounded(ctx, store, record.Bucket, record.ObjectKey, chatMediaMaxBytes)
	if err != nil || len(data) == 0 {
		return nil, "", errors.New("media not found")
	}
	return data, record.MIMEType, nil
}
