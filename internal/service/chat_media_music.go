package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const chatMusicVoiceProfile = "Serena voice identity: solo youthful adult female lead, warm sweet soft and clear tone, natural Taiwanese Mandarin pronunciation, intimate and gentle delivery; no male vocals, no choir, no backing vocals"

const chatMusicVoiceReferenceText = "晚风轻轻吹过来，月光落在窗台。今天辛苦你了，先把烦恼放下来，慢慢呼吸，好好休息。明天我们再一起出发。"

func synthesizeLocalMusic(ctx context.Context, plan chatSpeechPlan) ([]byte, error) {
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
	reference, err := synthesizeLocalSpeech(ctx, chatMusicVoiceReferenceText, chatSpeechPlan{
		Voice: chatVoiceName, Instructions: defaultSpeechInstructions() + " " + chatVoiceIdentityInstruction,
	})
	if err != nil {
		return nil, errors.New("无法生成 Serena 音色参考，请检查语音服务后重试")
	}
	request, err := json.Marshal(map[string]interface{}{
		"synth_model": "acestep-v15-turbo-Q6_K.gguf",
		"caption":     strings.TrimSpace(plan.MusicCaption) + ", " + chatMusicVoiceProfile, "lyrics": speechReplyText(plan.Answer),
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
				body, contentType, err := getMusicJob(ctx, jobURL+"&result=1")
				if err != nil {
					return nil, err
				}
				audio, err := decodeMusicAudio(body, contentType)
				completed = err == nil
				return audio, err
			case "failed", "cancelled":
				return nil, errors.New("歌曲生成失败，请缩短歌词或调整曲风重试")
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
			if readErr == nil && len(audio) >= 44 && len(audio) <= chatMediaMaxBytes && string(audio[:4]) == "RIFF" && string(audio[8:12]) == "WAVE" {
				return audio, nil
			}
			return nil, errors.New("歌曲 WAV 数据无效")
		}
		_ = part.Close()
	}
	return nil, errors.New("唱歌服务没有返回 WAV 音频")
}
