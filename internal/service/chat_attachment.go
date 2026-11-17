package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"strings"

	"ragflow/internal/common"
	"ragflow/internal/entity"
	"ragflow/internal/service/file"
)

func chatImageTokenEstimate(value interface{}) int {
	uri := ""
	switch value := value.(type) {
	case *common.ImageURL:
		uri = value.URL
	case map[string]interface{}:
		uri, _ = value["url"].(string)
	}
	_, encoded, ok := strings.Cut(uri, ";base64,")
	if ok {
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil {
			cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
			if err == nil && cfg.Width > 0 && cfg.Height > 0 {
				return 85 + 170*((cfg.Width+511)/512)*((cfg.Height+511)/512)
			}
		}
	}
	// Unknown provider image shape is charged conservatively.
	return 16384
}

// Resolve before selecting any pipeline so agentic, solo and retrieval paths
// all receive the same authorized, complete attachment content.
func (s *ChatPipelineService) prepareChatAttachments(ctx context.Context, chat *entity.Chat, messages []map[string]interface{}) ([]map[string]interface{}, error) {
	out := make([]map[string]interface{}, len(messages))
	modelType := ""
	for i, original := range messages {
		message := make(map[string]interface{}, len(original))
		for key, value := range original {
			message[key] = value
		}
		out[i] = message
		if message["role"] != "user" || message["files"] == nil {
			continue
		}
		var texts, images []string
		if descriptors, ok := parseFileDicts(message["files"]); ok {
			var err error
			texts, images, err = file.NewFileService(nil).GetFileContents(ctx, descriptors)
			if err != nil {
				return nil, err
			}
		} else {
			switch values := message["files"].(type) {
			case []string:
				for _, value := range values {
					classifyChatAttachment(value, &texts, &images)
				}
			case []interface{}:
				for _, value := range values {
					text, ok := value.(string)
					if !ok {
						return nil, errors.New("attachment_unavailable: invalid descriptor")
					}
					classifyChatAttachment(text, &texts, &images)
				}
			default:
				return nil, errors.New("attachment_unavailable: invalid attachment list")
			}
			if len(texts)+len(images) > file.ChatAttachmentMaxCount {
				return nil, errors.New("attachment_unavailable: attachment_count_limit")
			}
			for _, uri := range images {
				if len(uri) > base64.StdEncoding.EncodedLen(file.ChatAttachmentMaxBytes)+128 {
					return nil, errors.New("attachment_unavailable: byte_limit")
				}
				header, encoded, ok := strings.Cut(uri, ";base64,")
				if !ok {
					return nil, errors.New("attachment_unavailable: invalid image data URI")
				}
				data, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					return nil, errors.New("attachment_unavailable: invalid image encoding")
				}
				if _, err = file.ValidateChatImage(data, strings.TrimPrefix(header, "data:")); err != nil {
					return nil, err
				}
			}
		}
		if len(images) > 0 && ctx.Value(chatImagePlanningKey{}) == true {
			// The image adapter receives the original bytes; a text planner
			// describes their intended use without claiming to inspect them.
			content, ok := message["content"].(string)
			if !ok {
				return nil, errors.New("attachment_unavailable: image planning requires text content")
			}
			message["content"] = content + fmt.Sprintf("\n\n本条消息附有 %d 张参考图片，按上传顺序编号；原图由图片工具读取，本规划步骤不读取图片内容，不得臆测。", len(images))
			images = nil
		}
		if len(images) > 0 {
			if modelType == "" {
				config, _, _, _, err := s.getLLMModelConfig(ctx, chat)
				if err != nil {
					return nil, err
				}
				modelType, _ = config["model_type"].(string)
			}
			if modelType != "image2text" {
				return nil, fmt.Errorf("unsupported_capability: model %s cannot read images; select a vision model or an authorized automatic routing policy", chat.LLMID)
			}
		}
		if len(texts) > 0 {
			content, ok := message["content"].(string)
			if !ok {
				return nil, errors.New("attachment_unavailable: attachment text requires text content")
			}
			message["content"] = content + "\n\n" + strings.Join(texts, "\n\n")
		}
		// Only already-resolved images remain; document text participates in
		// history, retrieval and token accounting on every subsequent branch.
		message["files"] = images
	}
	return out, nil
}

func classifyChatAttachment(value string, texts, images *[]string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	if strings.HasPrefix(value, "data:") {
		*images = append(*images, value)
	} else {
		*texts = append(*texts, value)
	}
}

// fitFinalChatContext removes oldest complete history turns only. System
// constraints and the current user's complete evidence are never truncated.
func (s *ChatPipelineService) fitFinalChatContext(messages []map[string]interface{}, budget int) (int, []map[string]interface{}, error) {
	if budget <= 0 || len(messages) == 0 {
		return 0, nil, errors.New("invalid context budget")
	}
	out := append([]map[string]interface{}(nil), messages...)
	for s.countAllTokens(out) > budget {
		latestUser := -1
		for i := range out {
			if out[i]["role"] == "user" {
				latestUser = i
			}
		}
		start, end := -1, -1
		for i := 0; i < latestUser; i++ {
			if out[i]["role"] == "user" {
				start = i
				break
			}
		}
		if start < 0 {
			break
		}
		end = latestUser
		for i := start + 1; i < latestUser; i++ {
			if out[i]["role"] == "user" {
				end = i
				break
			}
		}
		kept := make([]map[string]interface{}, 0, len(out))
		for i, message := range out {
			if i < start || i >= end || message["role"] == "system" {
				kept = append(kept, message)
			}
		}
		out = kept
	}
	tokens := s.countAllTokens(out)
	if tokens > budget {
		return 0, nil, errors.New("context_budget_exceeded: required system instructions, question and attachments exceed the model context; reduce attachments or choose a larger context model")
	}
	return tokens, out, nil
}
