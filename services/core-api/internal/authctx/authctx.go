package authctx

import (
	"context"

	"github.com/google/uuid"
)

type contextKey string

const (
	userIDKey    contextKey = "userID"
	sessionIDKey contextKey = "sessionID"
)

func With(ctx context.Context, userID, sessionID uuid.UUID) context.Context {
	ctx = context.WithValue(ctx, userIDKey, userID)
	ctx = context.WithValue(ctx, sessionIDKey, sessionID)
	return ctx
}

func UserID(ctx context.Context) (uuid.UUID, bool) {
	v, ok := ctx.Value(userIDKey).(uuid.UUID)
	return v, ok
}

func SessionID(ctx context.Context) (uuid.UUID, bool) {
	v, ok := ctx.Value(sessionIDKey).(uuid.UUID)
	return v, ok
}

func MustUserID(ctx context.Context) uuid.UUID {
	id, ok := UserID(ctx)
	if !ok {
		panic("authctx: user id not present in context")
	}
	return id
}
