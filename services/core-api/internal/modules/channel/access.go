package channel

import (
	"context"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// Scope describes a channel's workspace context and visibility.
type Scope struct {
	WorkspaceID uuid.UUID
	Kind        string
	IsPrivate   bool
}

// Resolve returns the channel scope if the user is allowed to see the channel.
// Для workspace-каналов: пользователь должен быть участником воркспейса, и
// либо канал публичный, либо есть запись в channel_members.
// Для DM-каналов (kind='dm', workspace_id IS NULL): проверка только через
// channel_members — DM существует вне воркспейса, оба участника
// прописаны в channel_members при создании.
func Resolve(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) (Scope, bool) {
	var (
		s          Scope
		wsID       *uuid.UUID
	)
	err := db.QueryRow(ctx,
		`select c.workspace_id, c.kind, c.is_private from channels c where c.id = $1`,
		channelID,
	).Scan(&wsID, &s.Kind, &s.IsPrivate)
	if err != nil {
		return Scope{}, false
	}
	if wsID != nil {
		s.WorkspaceID = *wsID
		// Workspace-канал: проверяем членство в воркспейсе.
		var memberExists bool
		if err := db.QueryRow(ctx,
			`select exists(select 1 from workspace_members where workspace_id = $1 and user_id = $2)`,
			s.WorkspaceID, userID,
		).Scan(&memberExists); err != nil || !memberExists {
			return Scope{}, false
		}
		if s.IsPrivate {
			if !IsMember(ctx, db, channelID, userID) {
				return Scope{}, false
			}
		}
		return s, true
	}
	// DM-канал — workspace_id отсутствует. Доступ только через channel_members.
	if s.Kind != "dm" {
		return Scope{}, false
	}
	if !IsMember(ctx, db, channelID, userID) {
		return Scope{}, false
	}
	return s, true
}

// IsMember reports whether the user is explicitly listed in channel_members.
func IsMember(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) bool {
	var exists bool
	err := db.QueryRow(ctx,
		`select exists(select 1 from channel_members where channel_id = $1 and user_id = $2)`,
		channelID, userID,
	).Scan(&exists)
	return err == nil && exists
}
