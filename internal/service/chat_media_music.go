package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
	"ragflow/internal/storage"
)

const chatMusicVoiceProfile = "Serena voice identity: solo youthful adult female lead, warm sweet soft and clear tone, natural Taiwanese Mandarin pronunciation, intimate and gentle delivery; no male vocals, no choir, no backing vocals"

const chatMusicVoiceReferenceText = "晚风轻轻吹过来，月光落在窗台。今天辛苦你了，先把烦恼放下来，慢慢呼吸，好好休息。明天我们再一起出发。"

func synthesizeLocalMusic(ctx context.Context, plan chatSpeechPlan) (audio []byte, callErr error) {
	endpoint := strings.TrimRight(os.Getenv("RAGFLOW_MUSIC_BASE_URL"), "/")
	if endpoint == "" {
		return nil, errors.New("唱歌服务尚未启动，请使用项目启动脚本")
	}
	if strings.TrimSpace(plan.MusicCaption) == "" {
		return nil, errors.New("缺少歌曲风格，请补充曲风和情绪")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	// Reference the same speaker used for speech, independently of song lyrics.
	reference, err := musicVoiceReference(ctx)
	if err != nil {
		return nil, fmt.Errorf("音色参考未完成：%w", err)
	}
	request, err := json.Marshal(map[string]interface{}{
		"synth_model": "acestep-v15-turbo-Q6_K.gguf",
		"caption":     strings.TrimSpace(plan.MusicCaption) + ", " + chatMusicVoiceProfile, "lyrics": ChatSpeechText(plan.Answer),
		"duration": plan.Duration, "vocal_language": "zh", "inference_steps": 8,
		"guidance_scale": 1.0, "shift": 3.0, "output_format": "wav16",
	})
	if err != nil {
		return nil, err
	}
	var payload bytes.Buffer
	form := multipart.NewWriter(&payload)
	if err := form.WriteField("request", string(request)); err != nil {
		return nil, err
	}
	part, err := form.CreateFormFile("ref_audio", "serena.wav")
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(reference); err != nil {
		return nil, err
	}
	if err := form.Close(); err != nil {
		return nil, err
	}
	ctx, finish, err := common.BeginModelCall(ctx, "music", "acestep-v15-turbo-Q6_K.gguf")
	if err != nil {
		return nil, err
	}
	defer func() { finish(callErr) }()
	body, err := requestChatMediaBody(ctx, endpoint+"/synth", "", &payload, form.FormDataContentType())
	if err != nil {
		return nil, err
	}
	var job struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &job) != nil || job.ID == "" || len(job.ID) > 64 {
		return nil, errors.New("唱歌服务未返回有效任务")
	}
	if err := common.RecordModelUpstream(ctx, job.ID); err != nil {
		return nil, err
	}
	jobURL := endpoint + "/job?id=" + url.QueryEscape(job.ID)
	completed := false
	defer func() {
		if !completed {
			cancelCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
			defer stop()
			_, _ = requestChatMedia(cancelCtx, jobURL+"&cancel=1", "", nil)
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			body, _, err := getMusicJob(ctx, jobURL)
			if err != nil {
				return nil, err
			}
			var status struct {
				Status string `json:"status"`
			}
			if json.Unmarshal(body, &status) != nil {
				return nil, errors.New("唱歌任务状态无效")
			}
			switch status.Status {
			case "done":
				completed = true
				body, contentType, err := getMusicJob(ctx, jobURL+"&result=1")
				if err != nil {
					return nil, &chatUpstreamStoppedError{message: err.Error()}
				}
				audio, err := decodeMusicAudio(body, contentType)
				if err != nil {
					return nil, &chatUpstreamStoppedError{message: err.Error()}
				}
				return audio, err
			case "failed", "cancelled":
				completed = true
				return nil, &chatUpstreamStoppedError{message: "歌曲生成失败，请缩短歌词或调整曲风重试"}
			case "running":
			default:
				return nil, errors.New("唱歌任务状态无效")
			}
		}
	}
}

func getMusicJob(ctx context.Context, endpoint string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", errors.New("唱歌服务连接失败")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", errors.New("唱歌任务读取失败")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*chatMediaMaxBytes+1))
	if err != nil || len(body) > 2*chatMediaMaxBytes {
		return nil, "", errors.New("歌曲数据读取失败或过大")
	}
	return body, response.Header.Get("Content-Type"), nil
}

func decodeMusicAudio(body []byte, contentType string) ([]byte, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/mixed" || params["boundary"] == "" {
		return nil, errors.New("唱歌服务返回了无效音频格式")
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("歌曲音频数据不完整")
		}
		if strings.HasPrefix(part.Header.Get("Content-Type"), "audio/wav") {
			audio, readErr := io.ReadAll(io.LimitReader(part, chatMediaMaxBytes+1))
			if readErr == nil {
				if _, err := validateChatWAV(audio); err == nil {
					return audio, nil
				}
			}
			return nil, errors.New("歌曲 WAV 数据无效")
		}
		_ = part.Close()
	}
	return nil, errors.New("唱歌服务没有返回 WAV 音频")
}

func musicVoiceReference(ctx context.Context) ([]byte, error) {
	execution := chatExecution(ctx)
	if execution == nil {
		return synthesizeLocalSpeech(ctx, chatMusicVoiceReferenceText, chatSpeechPlan{
			Voice: chatVoiceName, Instructions: defaultSpeechInstructions() + " " + chatVoiceIdentityInstruction})
	}
	store := storage.GetStorageFactory().GetStorage()
	if store == nil {
		return nil, errors.New("persistence_failed: media storage unavailable")
	}
	current, err := execution.dao.Get(ctx, execution.task.ID)
	if err != nil {
		return nil, err
	}
	if id := stringValue(current.Outputs["voice_reference"]); id != "" {
		var asset entity.ChatMediaAsset
		if err := dao.DB.WithContext(ctx).Take(&asset,
			"id = ? AND tenant_id = ? AND session_id = ? AND kind = ? AND state IN ?",
			id, current.TenantID, current.SessionID, "voice_reference", []string{"staging", "committed"}).Error; err != nil {
			return nil, fmt.Errorf("checkpoint_incomplete: %w", err)
		}
		data, err := storage.GetBounded(ctx, store, asset.Bucket, asset.ObjectKey, chatMediaMaxBytes)
		if err != nil || int64(len(data)) != asset.Bytes {
			return nil, errors.New("checkpoint_incomplete: saved voice reference is unavailable")
		}
		if _, err := validateChatWAV(data); err != nil {
			return nil, err
		}
		return data, nil
	}
	data, err := synthesizeLocalSpeech(ctx, chatMusicVoiceReferenceText, chatSpeechPlan{
		Voice: chatVoiceName, Instructions: defaultSpeechInstructions() + " " + chatVoiceIdentityInstruction})
	if err != nil {
		return nil, err
	}
	duration, err := validateChatWAV(data)
	if err != nil {
		return nil, err
	}
	finishSave := measureChatTaskPhase(ctx, "save")
	defer finishSave()
	id := common.GenerateToken()
	asset := entity.ChatMediaAsset{ID: id, SourceKey: "voice-reference:" + id, TenantID: current.TenantID,
		SessionID: current.SessionID, TurnID: current.TurnID, TaskID: current.ID, Kind: "voice_reference",
		Bucket: chatMediaBucket, ObjectKey: current.SessionID + "/" + id + ".wav",
		MIMEType: "audio/wav", Bytes: int64(len(data)), DurationMs: duration, State: "staging", CreatedAt: time.Now().UnixMilli()}
	if err := execution.dao.Mutate(ctx, current.ID, execution.owner, execution.task.LeaseEpoch, "output_staging",
		func(tx *gorm.DB, _ *entity.ChatTask) (entity.JSONMap, error) {
			return entity.JSONMap{"asset_id": id}, tx.Create(&asset).Error
		}); err != nil {
		return nil, err
	}
	if err := store.Put(ctx, asset.Bucket, asset.ObjectKey, data); err != nil {
		return nil, fmt.Errorf("persistence_failed: voice reference storage: %w", err)
	}
	if err := execution.dao.Mutate(ctx, current.ID, execution.owner, execution.task.LeaseEpoch, "checkpoint_saved",
		func(tx *gorm.DB, task *entity.ChatTask) (entity.JSONMap, error) {
			if err := dao.ReferenceChatMedia(tx, entity.ChatMediaReference{
				AssetID: id, OwnerKind: "task", OwnerID: current.ID}); err != nil {
				return nil, err
			}
			if task.Outputs == nil {
				task.Outputs = entity.JSONMap{}
			}
			task.Outputs["voice_reference"] = id
			return entity.JSONMap{"kind": "voice_reference", "asset_id": id}, nil
		}); err != nil {
		return nil, err
	}
	return data, nil
}
