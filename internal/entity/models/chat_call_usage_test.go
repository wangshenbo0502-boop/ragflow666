package models

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"ragflow/internal/common"
)

type chatUsageObserver struct {
	t       *testing.T
	usage   []map[string]interface{}
	callErr []error
}

func (o *chatUsageObserver) Begin(ctx context.Context, stage, model string) (context.Context, func(error), error) {
	o.t.Helper()
	if stage != "language" || model != "metered-model" || common.ModelCallUsage(ctx) == nil {
		o.t.Fatal("model call did not attach its meter before reserving the attempt")
	}
	return ctx, func(err error) {
		o.usage = append(o.usage, common.ModelCallUsage(ctx))
		o.callErr = append(o.callErr, err)
	}, nil
}

func (*chatUsageObserver) Upstream(context.Context, string) error { return nil }

func TestChatModelMetersCallsWithoutCallerUsage(t *testing.T) {
	withSSRFBypass(t)
	for _, stream := range []bool{false, true} {
		for _, callerMeter := range []bool{false, true} {
			t.Run(fmt.Sprintf("stream_%t_caller_meter_%t", stream, callerMeter), func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var request struct {
						Stream bool `json:"stream"`
					}
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if calls == 1 {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					if request.Stream {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n")
						fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":8}}\n\n")
						fmt.Fprint(w, "data: [DONE]\n\n")
						return
					}
					fmt.Fprint(w, `{"choices":[{"message":{"content":"answer"}}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}`)
				}))
				defer server.Close()
				driver := NewDeepSeekModel(map[string]string{"default": server.URL}, URLSuffix{Chat: "chat/completions"})
				name, key := "metered-model", "test-key"
				model := NewChatModel(driver, &name, &APIConfig{ApiKey: &key})
				observer := &chatUsageObserver{t: t}
				ctx := common.WithModelCallObserver(t.Context(), observer)
				var usage *common.ModelUsage
				if callerMeter {
					usage = &common.ModelUsage{}
				}
				for attempt := 0; attempt < 2; attempt++ {
					var err error
					messages := []Message{{Role: "user", Content: "hello"}}
					if stream {
						err = model.ChatStreamlyWithSender(ctx, messages, nil, usage, func(*string, *string) error { return nil })
					} else {
						_, err = model.ChatWithMessages(ctx, messages, nil, usage)
					}
					if (err != nil) != (attempt == 0) {
						t.Fatalf("unexpected attempt %d result: %v", attempt, err)
					}
				}
				if calls != 2 || len(observer.usage) != 2 || observer.callErr[0] == nil || observer.callErr[1] != nil ||
					observer.usage[0]["total_tokens"] != 0 || observer.usage[1]["input_tokens"] != 3 ||
					observer.usage[1]["output_tokens"] != 5 || observer.usage[1]["total_tokens"] != 8 {
					t.Fatalf("attempt usage attribution was lost: %+v", observer.usage)
				}
				if usage != nil && usage.TotalTokens != 8 {
					t.Fatal("caller meter was no longer populated")
				}
			})
		}
	}
}
