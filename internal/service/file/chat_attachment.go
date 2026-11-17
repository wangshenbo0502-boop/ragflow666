package file

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"

	"ragflow/internal/permission"
	"ragflow/internal/storage"
	"ragflow/internal/utility"
)

const (
	ChatAttachmentMaxCount     = 10
	ChatAttachmentMaxBytes     = 32 << 20
	ChatAttachmentTotalBytes   = 64 << 20
	ChatAttachmentMaxPixels    = 24_000_000
	ChatAttachmentMaxText      = 256_000
	ChatAttachmentParseTimeout = 45 * time.Second
)

type ChatAttachmentResult struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
	Status   string `json:"status"`
	Code     string `json:"code,omitempty"`
	Text     string `json:"-"`
	Image    string `json:"-"`
}

// ChatAttachmentError keeps every per-file result while withholding partial
// content from the model. Clients must explicitly correct or remove a file.
type ChatAttachmentError struct {
	Results []ChatAttachmentResult `json:"attachments"`
}

func (e *ChatAttachmentError) Error() string {
	for _, result := range e.Results {
		if result.Status != "available" {
			return fmt.Sprintf("attachment_unavailable: file %d %q (%s)", result.Position+1, result.Name, result.Code)
		}
	}
	return "attachment_unavailable"
}

func ValidateChatImage(data []byte, declared string) (string, error) {
	if len(data) == 0 || len(data) > ChatAttachmentMaxBytes {
		return "", errors.New("image_size_limit")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return "", errors.New("image_decode_failed")
	}
	if int64(cfg.Width)*int64(cfg.Height) > ChatAttachmentMaxPixels {
		return "", errors.New("image_pixel_limit")
	}
	mime := "image/" + format
	declared = strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	if declared != "" && declared != "application/octet-stream" && declared != mime {
		return "", errors.New("image_mime_mismatch")
	}
	if _, _, err = image.Decode(bytes.NewReader(data)); err != nil {
		return "", errors.New("image_decode_failed")
	}
	return mime, nil
}

func (s *FileService) ResolveChatAttachments(ctx context.Context, descriptors []map[string]interface{}) ([]ChatAttachmentResult, error) {
	uid := permission.UserIDFromContext(ctx)
	if uid == "" {
		return nil, permission.ErrUnauthenticated
	}
	if len(descriptors) > ChatAttachmentMaxCount {
		return nil, errors.New("attachment_count_limit")
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, errors.New("storage not initialized")
	}
	ctx, cancel := context.WithTimeout(ctx, ChatAttachmentParseTimeout)
	defer cancel()
	results := make([]ChatAttachmentResult, 0, len(descriptors))
	total, totalText := 0, 0
	failed := false
	for i, descriptor := range descriptors {
		id, _ := descriptor["id"].(string)
		name, _ := descriptor["name"].(string)
		owner, _ := descriptor["created_by"].(string)
		mime, _ := descriptor["mime_type"].(string)
		result := ChatAttachmentResult{ID: id, Name: name, Position: i, Status: "available"}
		var code string
		switch {
		case id == "" || name == "" || owner == "" || mime == "":
			code = "invalid_descriptor"
		case owner != uid:
			code = "forbidden"
		default:
			limit := min(ChatAttachmentMaxBytes, ChatAttachmentTotalBytes-total)
			data, err := storage.GetBounded(ctx, store, owner+"-downloads", id, int64(limit))
			total += len(data)
			switch {
			case errors.Is(err, storage.ErrObjectTooLarge):
				code = "byte_limit"
			case err != nil || len(data) == 0:
				code = "read_failed"
			case len(data) > ChatAttachmentMaxBytes || total > ChatAttachmentTotalBytes:
				code = "byte_limit"
			case utility.IsVideoFilename(name) || strings.HasPrefix(mime, "video/") || strings.HasPrefix(mime, "audio/"):
				code = "unsupported_format"
			case strings.HasPrefix(mime, "image/") || utility.FilenameType(name) == utility.FileTypeVISUAL:
				actual, imageErr := ValidateChatImage(data, mime)
				if imageErr != nil {
					code = imageErr.Error()
				} else {
					result.Image = "data:" + actual + ";base64," + base64.StdEncoding.EncodeToString(data)
				}
			default:
				if utility.GetFileType(name) == utility.FileTypeOTHER && (!utf8.Valid(data) || bytes.ContainsRune(data, 0)) {
					code = "unsupported_format"
					break
				}
				result.Text, err = parseAgentUploadContent(ctx, name, data, "Plain Text")
				totalText += utf8.RuneCountInString(result.Text)
				if err != nil {
					code = "parse_failed"
				} else if totalText > ChatAttachmentMaxText {
					code = "text_limit"
				}
			}
		}
		if ctx.Err() != nil {
			code = "parse_timeout"
		}
		if code != "" {
			failed = true
			result.Status, result.Code, result.Text, result.Image = "unavailable", code, "", ""
		}
		results = append(results, result)
	}
	if failed {
		return results, &ChatAttachmentError{Results: results}
	}
	return results, nil
}
