package common

import "context"

// ModelCallObserver reserves a shared task budget before each driver call.
// Finish must be called once; a transport failure may leave upstream work unknown.
type ModelCallObserver interface {
	Begin(context.Context, string, string) (context.Context, func(error), error)
	Upstream(context.Context, string) error
}

type modelCallObserverKey struct{}

type ModelCallDetails struct {
	Reason        string
	Switch        bool
	CostKnown     bool
	EstimatedCost int64
}

type modelCallDetailsKey struct{}
type modelCallUsageKey struct{}

func WithModelCallUsage(ctx context.Context, usage *ModelUsage) context.Context {
	return context.WithValue(ctx, modelCallUsageKey{}, usage)
}

// ModelCallUsage exposes only metering fields, never provider credentials.
func ModelCallUsage(ctx context.Context) map[string]interface{} {
	usage, _ := ctx.Value(modelCallUsageKey{}).(*ModelUsage)
	if usage == nil {
		return nil
	}
	return map[string]interface{}{"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens,
		"total_tokens": usage.TotalTokens, "response_time_ms": usage.ResponseTimeMS}
}

func WithModelCallDetails(ctx context.Context, details ModelCallDetails) context.Context {
	return context.WithValue(ctx, modelCallDetailsKey{}, details)
}

func ModelCallDetailsFromContext(ctx context.Context) ModelCallDetails {
	details, _ := ctx.Value(modelCallDetailsKey{}).(ModelCallDetails)
	return details
}

func WithModelCallObserver(ctx context.Context, observer ModelCallObserver) context.Context {
	return context.WithValue(ctx, modelCallObserverKey{}, observer)
}

func BeginModelCall(ctx context.Context, stage, model string) (context.Context, func(error), error) {
	if observer, ok := ctx.Value(modelCallObserverKey{}).(ModelCallObserver); ok {
		return observer.Begin(ctx, stage, model)
	}
	return ctx, func(error) {}, nil
}

func RecordModelUpstream(ctx context.Context, id string) error {
	if observer, ok := ctx.Value(modelCallObserverKey{}).(ModelCallObserver); ok {
		return observer.Upstream(ctx, id)
	}
	return nil
}
