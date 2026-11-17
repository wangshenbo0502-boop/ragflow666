package models

import "context"

// ChatRoute selects authorized models around the same validated driver call.
// Each invocation still passes through the shared model-call budget.
type ChatRoute func(context.Context, *ChatModel, func(context.Context, *ChatModel) error) error

type chatRouteKey struct{}

// ChatPartialError prevents appending another model's answer to partial output.
type ChatPartialError struct{ Err error }

func (e *ChatPartialError) Error() string { return "model stream interrupted after output" }
func (e *ChatPartialError) Unwrap() error { return e.Err }

func WithChatRoute(ctx context.Context, route ChatRoute) context.Context {
	return context.WithValue(ctx, chatRouteKey{}, route)
}

func chatRoute(ctx context.Context) ChatRoute {
	route, _ := ctx.Value(chatRouteKey{}).(ChatRoute)
	return route
}
