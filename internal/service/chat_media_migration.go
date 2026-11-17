package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/service/file"
	"ragflow/internal/storage"
)

type ChatMediaMigrationReport struct {
	Execute       bool                      `json:"execute"`
	Messages      int                       `json:"messages"`
	Recognized    int                       `json:"recognized"`
	AlreadyLinked int                       `json:"already_linked"`
	Linked        int                       `json:"linked"`
	Missing       int                       `json:"missing_objects"`
	Manual        int                       `json:"manual_review"`
	Failures      int                       `json:"failures"`
	Cursor        string                    `json:"cursor"`
	Done          bool                      `json:"done"`
	Issues        []ChatMediaMigrationIssue `json:"issues"`
}

type ChatMediaMigrationIssue struct {
	SessionID string `json:"session_id"`
	TurnID    string `json:"turn_id,omitempty"`
	AssetID   string `json:"asset_id,omitempty"`
	Code      string `json:"code"`
}

// MigrateChatMedia converts links once; normal media reads never infer ownership
// from prose. Cursor is a session ID, never a mutable message position.
func MigrateChatMedia(ctx context.Context, db *gorm.DB, store storage.Storage, execute bool, cursor string, batch int) (*ChatMediaMigrationReport, error) {
	if store == nil || batch < 1 || batch > 1000 || len(cursor) > 32 {
		return nil, errors.New("invalid media migration configuration")
	}
	frozen, err := dao.IsChatMediaFrozen(ctx, db)
	if err != nil || execute && !frozen {
		return nil, errors.New("media migration requires --chat-media-action freeze before execute")
	}
	report := &ChatMediaMigrationReport{Execute: execute, Cursor: cursor, Issues: []ChatMediaMigrationIssue{}}
	var sessions []entity.ChatSession
	if err := db.WithContext(ctx).Where("id > ?", cursor).Order("id").Limit(batch + 1).Find(&sessions).Error; err != nil {
		return report, err
	}
	report.Done = len(sessions) <= batch
	if len(sessions) > batch {
		sessions = sessions[:batch]
	}
	for _, session := range sessions {
		var messages []entity.ConversationMessage
		if err := db.WithContext(ctx).Where("conversation_id = ?", session.ID).Order("position").Find(&messages).Error; err != nil {
			return report, err
		}
		var chat entity.Chat
		if err := db.WithContext(ctx).Take(&chat, "id = ?", session.DialogID).Error; err != nil {
			report.Failures++
			report.Issues = append(report.Issues, ChatMediaMigrationIssue{SessionID: session.ID, Code: "chat_unavailable"})
			report.Cursor = session.ID
			continue
		}
		for _, message := range messages {
			report.Messages++
			if message.Role == nil || *message.Role != "assistant" || message.Content == nil {
				continue
			}
			links := chatHistoryMediaLinks(*message.Content)
			for _, link := range links {
				report.Recognized++
				asset, issue := chatHistoryMediaAsset(link, &chat, &session, &message)
				if issue == "" {
					var duplicates int64
					err = db.WithContext(ctx).Model(&entity.ConversationMessage{}).
						Where("conversation_id = ? AND message_id = ? AND role = ?", session.ID, asset.TurnID, "assistant").Count(&duplicates).Error
					if err != nil {
						return report, err
					}
					if duplicates != 1 {
						issue = "ambiguous_turn"
					}
				}
				turn := ""
				if message.MessageID != nil {
					turn = *message.MessageID
				}
				addIssue := func(code string) {
					report.Issues = append(report.Issues, ChatMediaMigrationIssue{SessionID: session.ID, TurnID: turn, AssetID: asset.ID, Code: code})
				}
				if issue != "" {
					report.Manual++
					addIssue(issue)
					continue
				}
				exists, err := store.ObjectExists(ctx, asset.Bucket, asset.ObjectKey)
				if err != nil {
					report.Failures++
					addIssue("storage_unavailable")
					continue
				}
				if !exists {
					report.Missing++
					addIssue("missing_object")
					continue
				}
				data, err := storage.GetBounded(ctx, store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
				if err != nil {
					report.Failures++
					addIssue("object_read_failed")
					continue
				}
				asset.Bytes = int64(len(data))
				if asset.Kind == "image" {
					if _, err := file.ValidateChatImage(data, asset.MIMEType); err != nil {
						report.Manual++
						addIssue("invalid_image")
						continue
					}
					size, _, err := image.DecodeConfig(bytes.NewReader(data))
					if err != nil {
						report.Manual++
						addIssue("invalid_image")
						continue
					}
					asset.Width, asset.Height = size.Width, size.Height
				} else {
					asset.DurationMs, err = validateChatWAV(data)
					if err != nil {
						report.Manual++
						addIssue("invalid_audio")
						continue
					}
				}
				var refs int64
				if err := db.WithContext(ctx).Model(&entity.ChatMediaReference{}).Where("asset_id = ? AND owner_kind = ? AND owner_id = ?",
					asset.ID, "message", session.ID+":"+asset.TurnID).Count(&refs).Error; err != nil {
					return report, err
				}
				if execute {
					if err := migrateChatMediaMessage(ctx, db, &session, &message, asset, link); err != nil {
						report.Failures++
						addIssue("association_failed")
						continue
					}
				}
				if refs > 0 {
					report.AlreadyLinked++
				} else {
					report.Linked++
				}
			}
		}
		report.Cursor = session.ID
	}
	return report, nil
}

func chatHistoryMediaLinks(content string) []string {
	source := []byte(content)
	root := goldmark.New().Parser().Parse(text.NewReader(source))
	seen := map[string]bool{}
	var links []string
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination []byte
		switch node := node.(type) {
		case *ast.Image:
			destination = node.Destination
		case *ast.Link:
			destination = node.Destination
		}
		link := string(destination)
		if strings.Contains(link, "/media/") && strings.Contains(link, "/chats/") && !seen[link] {
			seen[link] = true
			links = append(links, link)
		}
		return ast.WalkContinue, nil
	})
	return links
}

func chatHistoryMediaAsset(link string, chat *entity.Chat, session *entity.ChatSession, message *entity.ConversationMessage) (*entity.ChatMediaAsset, string) {
	asset := &entity.ChatMediaAsset{}
	parsed, err := url.Parse(link)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return asset, "nonlocal_media_link"
	}
	prefix := fmt.Sprintf("/api/v1/chats/%s/sessions/%s/media/", chat.ID, session.ID)
	if !strings.HasPrefix(parsed.Path, prefix) || !chatMediaAssetName.MatchString(strings.TrimPrefix(parsed.Path, prefix)) {
		return asset, "media_owner_mismatch"
	}
	if message.MessageID == nil || strings.TrimSpace(*message.MessageID) == "" {
		return asset, "missing_turn_id"
	}
	name := strings.TrimPrefix(parsed.Path, prefix)
	ext := path.Ext(name)
	asset.ID = strings.TrimSuffix(name, ext)
	asset.TenantID, asset.SessionID, asset.TurnID = chat.TenantID, session.ID, *message.MessageID
	asset.Kind, asset.MIMEType = "image", "image/"+strings.TrimPrefix(ext, ".")
	if ext == ".jpg" {
		asset.MIMEType = "image/jpeg"
	} else if ext == ".wav" {
		asset.Kind, asset.MIMEType = "audio", "audio/wav"
	}
	asset.Bucket, asset.ObjectKey = chatMediaBucket, session.ID+"/"+name
	asset.SourceKey = "history:" + asset.Bucket + "/" + asset.ObjectKey
	asset.State, asset.CreatedAt = "committed", time.Now().UnixMilli()
	return asset, ""
}

func migrateChatMediaMessage(ctx context.Context, db *gorm.DB, session *entity.ChatSession, original *entity.ConversationMessage, asset *entity.ChatMediaAsset, link string) error {
	nextVersion := original.AnswerVersion
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := dao.RequireChatMediaFrozen(tx); err != nil {
			return err
		}
		var locked entity.ChatSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&locked, "id = ?", session.ID).Error; err != nil {
			return err
		}
		var message entity.ConversationMessage
		if err := tx.Take(&message, "conversation_id = ? AND message_id = ? AND role = ?",
			session.ID, asset.TurnID, "assistant").Error; err != nil {
			return err
		}
		if message.Content == nil || *message.Content != *original.Content || message.AnswerVersion != original.AnswerVersion {
			return errors.New("message changed during migration")
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(asset).Error; err != nil {
			return err
		}
		var existing entity.ChatMediaAsset
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Take(&existing, "id = ?", asset.ID).Error; err != nil {
			return err
		}
		if existing.TenantID != asset.TenantID || existing.SessionID != asset.SessionID || existing.ObjectKey != asset.ObjectKey || existing.State != "committed" {
			return errors.New("asset identity conflict")
		}
		ref := entity.ChatMediaReference{AssetID: asset.ID, OwnerKind: "message", OwnerID: session.ID + ":" + asset.TurnID}
		if err := dao.ReferenceChatMedia(tx, ref); err != nil {
			return err
		}
		metadata := map[string]interface{}{}
		if message.Metadata != "" && json.Unmarshal([]byte(message.Metadata), &metadata) != nil {
			return errors.New("invalid message metadata")
		}
		var media []map[string]interface{}
		encoded, _ := json.Marshal(metadata["media_assets"])
		_ = json.Unmarshal(encoded, &media)
		for _, item := range media {
			if item["id"] == asset.ID {
				return nil
			}
		}
		media = append(media, map[string]interface{}{"id": asset.ID, "kind": asset.Kind, "url": link,
			"mime_type": asset.MIMEType, "width": asset.Width, "height": asset.Height, "duration_ms": asset.DurationMs, "parent_id": existing.ParentID})
		metadata["media_assets"] = media
		encoded, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		nextVersion = message.AnswerVersion + 1
		result := tx.Model(&message).Where("answer_version = ?", message.AnswerVersion).
			Updates(map[string]interface{}{"metadata": string(encoded), "answer_version": nextVersion})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return dao.ErrAnswerVersion
		}
		return nil
	})
	if err == nil {
		original.AnswerVersion = nextVersion
	}
	return err
}
