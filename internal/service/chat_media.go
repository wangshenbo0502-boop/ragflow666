package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/service/file"
	"ragflow/internal/storage"
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

// completeMedia runs after the ordinary chat/session permission checks. Media
// bytes live in object storage; the transcript contains authenticated URLs.
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
	var audio []byte
	var err error
	var reply map[string]interface{}
	var imagePlan *chatImagePlan
	extension, mediaType := "", ""
	isSpeech := kind == "语音" || kind == "qwen3-tts"
	if isSpeech {
		reply, err = s.generateSpeechReply(ctx, dialog, messages, kwargs)
		if err != nil {
			return nil, err
		}
		plan := reply["speech_plan"].(chatSpeechPlan)
		if plan.Mode == "singing" {
			audio, err = synthesizeLocalMusic(ctx, plan)
		} else {
			audio, err = synthesizeLocalSpeech(ctx, speechReplyText(plan.Answer), plan)
		}
		extension, mediaType = "wav", "audio/wav"
	} else {
		if utf8.RuneCountInString(prompt) > 8000 {
			return nil, errors.New("图片描述最多支持 8000 个字符")
		}
		plan, planErr := s.planChatImage(ctx, dialog, messages, kwargs)
		if planErr != nil {
			return nil, planErr
		}
		var images []string
		images, err = chatImageReferences(ctx, messages[len(messages)-1]["files"])
		if err != nil {
			return nil, err
		}
		if plan.UsePreviousImage {
			previous, imageErr := s.previousChatImage(ctx, dialog, session)
			if imageErr != nil {
				return nil, imageErr
			}
			images = append([]string{previous}, images...)
		}
		imagePlan = &plan
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
	if err != nil {
		return nil, err
	}
	asset := common.GenerateToken() + "." + extension
	key := session.ID + "/" + asset
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, errors.New("媒体存储不可用")
	}
	if err = store.Put(ctx, chatMediaBucket, key, audio); err != nil {
		return nil, errors.New("媒体保存失败，请重试")
	}
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
	// Commit both sides of the turn together. Returning a successful generation
	// without a persisted answer would lose the result on refresh.
	err = dao.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.chatSessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
			"history_update": dao.ConversationHistoryUpdate{Message: messages[len(messages)-1]},
		}); err != nil {
			return err
		}
		return s.chatSessionDAO.UpdateByID(ctx, tx, session.ID, map[string]interface{}{
			"history_update": dao.ConversationHistoryUpdate{Message: answer, QuestionID: messageID},
		})
	})
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = store.Remove(cleanupCtx, chatMediaBucket, key)
		return nil, errors.New("生成结果未能保存，请重试")
	}
	result := s.structureAnswer(session, content, messageID, session.ID, reference)
	if reply != nil {
		for _, key := range []string{"prompt", "usage", "elapsed_ms"} {
			if value, ok := reply[key]; ok {
				result[key] = value
			}
		}
	}
	result["final"] = true
	result["chat_id"] = dialog.ID
	return result, nil
}

func (s *ChatSessionService) generateSpeechReply(ctx context.Context, dialog *entity.Chat, messages []map[string]interface{}, kwargs map[string]interface{}) (map[string]interface{}, error) {
	directive := speechMediaDirective
	planningCtx := ctx
	routeKnowledge := len(chatDatasetIDs(dialog)) > 0 || isRailwayChat(dialog)
	if routeKnowledge {
		planningCtx = context.WithValue(ctx, chatSpeechPlanningKey{}, true)
		directive += speechRoutingDirective
	}
	for attempt := 0; attempt < 2; attempt++ {
		reply, err := s.generateMediaReply(planningCtx, dialog, messages, kwargs, directive)
		if err != nil {
			return nil, err
		}
		plan, err := parseSpeechPlan(stringValue(reply["answer"]))
		if err == nil && routeKnowledge && plan.UseKnowledge == nil {
			err = errors.New("语音计划缺少 use_knowledge 字段")
		}
		if err == nil {
			if routeKnowledge && *plan.UseKnowledge {
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
			return nil, err
		}
		common.Warn("Retrying invalid speech plan", zap.Error(err))
		directive += "\n上一次回答未通过格式校验：" + err.Error() + "。请重新完整回答当前用户的问题，严格返回上述 JSON 对象，完整闭合所有字段，使用整数 duration，将歌词和回答中的换行写为 \\n，不添加代码围栏或 JSON 以外的说明。"
	}
	return nil, errors.New("语音回答生成失败，请重试")
}

func (s *ChatSessionService) generateMediaReply(ctx context.Context, dialog *entity.Chat, messages []map[string]interface{}, kwargs map[string]interface{}, directive string) (map[string]interface{}, error) {
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
	reply := accumulateNonStreamAnswer(results)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	answer := stringValue(reply["answer"])
	if strings.Contains(answer, "**ERROR**") {
		return nil, errors.New(ExtractVisibleAnswer(answer))
	}
	if ctx.Value(chatImagePlanningKey{}) != true && speechReplyText(answer) == "" {
		return nil, errors.New("模型没有生成可朗读的回答，请重试")
	}
	return reply, nil
}

func speechReplyText(answer string) string {
	source := []byte(CitationMarkerPattern.ReplaceAllString(ExtractVisibleAnswer(answer), ""))
	document := goldmark.DefaultParser().Parse(text.NewReader(source))
	var spoken strings.Builder
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch node := node.(type) {
			case *ast.Image, *ast.HTMLBlock, *ast.RawHTML:
				return ast.WalkSkipChildren, nil
			case *ast.Text:
				spoken.Write(node.Segment.Value(source))
				if node.SoftLineBreak() || node.HardLineBreak() {
					spoken.WriteByte('\n')
				}
			case *ast.String:
				spoken.Write(node.Value)
			case *ast.CodeBlock, *ast.FencedCodeBlock:
				for i := 0; i < node.Lines().Len(); i++ {
					line := node.Lines().At(i)
					spoken.Write(line.Value(source))
				}
			}
		} else if node.Type() == ast.TypeBlock {
			spoken.WriteByte('\n')
		}
		return ast.WalkContinue, nil
	})
	return strings.TrimSpace(stripTTSTags(spoken.String()))
}

func synthesizeLocalSpeech(ctx context.Context, text string, plan chatSpeechPlan) ([]byte, error) {
	endpoint := strings.TrimRight(os.Getenv("RAGFLOW_TTS_BASE_URL"), "/")
	if endpoint == "" {
		return nil, errors.New("Qwen3-TTS 尚未启动，请使用项目启动脚本")
	}
	payload := map[string]interface{}{
		"model": "Qwen3-TTS-12Hz-1.7B-CustomVoice", "input": text,
		"voice": plan.Voice, "language": "zh", "response_format": "wav", "instructions": plan.Instructions,
	}
	body, err := requestChatMedia(ctx, endpoint+"/audio/speech", "", payload)
	if err != nil {
		return nil, fmt.Errorf("Qwen3-TTS 调用失败，请检查项目语音进程：%w", err)
	}
	if len(body) < 44 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WAVE" {
		return nil, errors.New("Qwen3-TTS 返回了无效的 WAV 音频")
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

func generateChatImage(ctx context.Context, prompt, size string, images ...string) ([]byte, string, error) {
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
	if len(images) == 0 {
		body, err = requestChatMedia(ctx, endpoint+"/images/generations", apiKey, map[string]interface{}{
			"model": chatImageModel, "prompt": prompt, "n": 1, "size": size, "quality": "high", "response_format": "b64_json",
		})
	} else {
		var payload bytes.Buffer
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
		body, err = requestChatMediaBody(ctx, endpoint+"/images/edits", apiKey, &payload, form.FormDataContentType())
	}
	if err != nil {
		return nil, "", fmt.Errorf("生图模型调用失败：%w", err)
	}
	return decodeChatImage(body)
}

func decodeChatImage(body []byte) ([]byte, string, error) {
	var result struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil || len(result.Data) == 0 || result.Data[0].Base64 == "" {
		return nil, "", errors.New("生图模型没有返回图片数据")
	}
	image, err := base64.StdEncoding.DecodeString(result.Data[0].Base64)
	if err != nil || len(image) == 0 || len(image) > chatMediaMaxBytes {
		return nil, "", errors.New("生图模型返回的图片数据无效或过大")
	}
	mediaType := http.DetectContentType(image)
	switch mediaType {
	case "image/png", "image/jpeg", "image/webp":
		return image, mediaType, nil
	default:
		return nil, "", errors.New("生图模型返回了不支持的图片格式")
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
		return nil, errors.New("模型连接失败或超时")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Upstream error bodies can contain credentials or internal URLs.
		return nil, fmt.Errorf("模型服务返回 HTTP %d", resp.StatusCode)
	}
	response, err := io.ReadAll(io.LimitReader(resp.Body, 2*chatMediaMaxBytes+1))
	if err != nil || len(response) > 2*chatMediaMaxBytes {
		return nil, errors.New("模型响应读取失败或数据过大")
	}
	return response, nil
}

func (s *ChatSessionService) GetSessionMedia(ctx context.Context, chatID, sessionID, asset string) ([]byte, string, error) {
	if !chatMediaAssetName.MatchString(asset) {
		return nil, "", errors.New("media not found")
	}
	session, _, err := s.GetSession(ctx, chatID, sessionID)
	if err != nil {
		return nil, "", err
	}
	path := fmt.Sprintf("/api/v1/chats/%s/sessions/%s/media/%s", chatID, sessionID, asset)
	found := false
	for _, message := range session.Messages {
		if message["role"] == "assistant" && strings.Contains(stringValue(message["content"]), "]("+path+")") {
			found = true
			break
		}
	}
	if !found {
		return nil, "", errors.New("media not found")
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, "", errors.New("media storage unavailable")
	}
	data, err := store.Get(ctx, chatMediaBucket, sessionID+"/"+asset)
	if err != nil || len(data) == 0 {
		return nil, "", errors.New("media not found")
	}
	return data, http.DetectContentType(data), nil
}
