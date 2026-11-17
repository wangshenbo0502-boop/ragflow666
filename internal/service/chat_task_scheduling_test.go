package service

import "testing"

func TestChatTaskSchedulingUsesActualMediaInput(t *testing.T) {
	for _, tc := range []struct {
		name, kind, mode, planned, want string
	}{
		{"speech", "语音", "voice", "", "interactive"},
		{"fixed-voice", "qwen3-tts", "", "", "interactive"},
		{"music-mode", "语音", "music", "", "normal"},
		{"planned-song", "语音", "voice", "singing", "normal"},
		{"image", "生图", "", "", "normal"},
		{"combined", "image_voice", "", "", "normal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := &chatTaskInput{Kind: tc.kind, Options: map[string]interface{}{"mode": tc.mode}}
			if tc.planned != "" {
				input.Resume = map[string]interface{}{"text": map[string]interface{}{
					"speech_plan": chatSpeechPlan{Mode: tc.planned},
				}}
			}
			if got := chatTaskSchedulingClass(input); got != tc.want {
				t.Fatalf("class=%s, want=%s", got, tc.want)
			}
		})
	}
}

func TestChatTaskPriorityWaitConfiguration(t *testing.T) {
	t.Setenv("RAGFLOW_CHAT_PRIORITY_WAIT", "17s")
	cfg, err := LoadChatTaskConfig()
	if err != nil || cfg.PriorityWait.Seconds() != 17 {
		t.Fatalf("priority wait: %v %v", cfg.PriorityWait, err)
	}
	t.Setenv("RAGFLOW_CHAT_PRIORITY_WAIT", "0s")
	if _, err := LoadChatTaskConfig(); err == nil {
		t.Fatal("unbounded interactive preference accepted")
	}
}

func TestChatTaskCleanupAlertConfiguration(t *testing.T) {
	t.Setenv("RAGFLOW_CHAT_CLEANUP_ALERT_THRESHOLD", "7")
	cfg, err := LoadChatTaskConfig()
	if err != nil || cfg.CleanupAlertThreshold != 7 {
		t.Fatalf("cleanup alert threshold: %d %v", cfg.CleanupAlertThreshold, err)
	}
	for _, invalid := range []string{"0", "-1", "1001", "invalid"} {
		t.Setenv("RAGFLOW_CHAT_CLEANUP_ALERT_THRESHOLD", invalid)
		if _, err := LoadChatTaskConfig(); err == nil {
			t.Fatalf("invalid cleanup alert threshold accepted: %s", invalid)
		}
	}
}

func TestChatModelHealthConfiguration(t *testing.T) {
	t.Setenv("RAGFLOW_CHAT_MODEL_FAILURE_THRESHOLD", "3")
	t.Setenv("RAGFLOW_CHAT_MODEL_FAILURE_WINDOW", "47s")
	t.Setenv("RAGFLOW_CHAT_MODEL_COOLDOWN", "19s")
	cfg, err := LoadChatTaskConfig()
	if err != nil || cfg.ModelFailureThreshold != 3 || cfg.ModelFailureWindow.Seconds() != 47 || cfg.ModelCooldown.Seconds() != 19 {
		t.Fatalf("model health config: %+v %v", cfg, err)
	}
	for _, name := range []string{"MODEL_FAILURE_THRESHOLD", "MODEL_FAILURE_WINDOW", "MODEL_COOLDOWN"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("RAGFLOW_CHAT_"+name, "0")
			if _, err := LoadChatTaskConfig(); err == nil {
				t.Fatal("invalid health policy accepted")
			}
		})
	}
}
