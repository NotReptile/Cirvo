package channel

import (
	"context"

	"github.com/google/uuid"

	"github.com/NotReptile/Cirvo/libs/shared-go/postgres"
	"github.com/NotReptile/Cirvo/services/core-api/internal/modules/permission"
)

// Scope describes a channel's workspace context and visibility.
type Scope struct {
	WorkspaceID uuid.UUID
	Kind        string
	IsPrivate   bool
}

// Resolve returns the channel scope if the user is allowed to see the channel.
// Для workspace-каналов: членство и эффективное channel.view с общими
// категорийными, канальными и персональными overrides.
// Для DM-каналов (kind='dm', workspace_id IS NULL): проверка только через
// channel_members — DM существует вне воркспейса, оба участника
// прописаны в channel_members при создании.
func Resolve(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) (Scope, bool) {
	scope, _, ok := ResolveSnapshot(ctx, db, channelID, userID)
	return scope, ok
}

func ResolveSnapshot(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) (Scope, permission.Snapshot, bool) {
	var (
		s    Scope
		wsID *uuid.UUID
	)
	err := db.QueryRow(ctx,
		`select c.workspace_id, c.kind, c.is_private from channels c where c.id = $1`,
		channelID,
	).Scan(&wsID, &s.Kind, &s.IsPrivate)
	if err != nil {
		return Scope{}, permission.Snapshot{}, false
	}
	if wsID != nil {
		s.WorkspaceID = *wsID
		base, err := permission.LoadWorkspace(ctx, db, s.WorkspaceID, userID)
		if err != nil || !base.Member {
			return Scope{}, permission.Snapshot{}, false
		}
		channels, err := permission.LoadChannels(ctx, db, s.WorkspaceID, userID, channelID, base)
		if err != nil {
			return Scope{}, permission.Snapshot{}, false
		}
		snapshot := channels[channelID]
		if !snapshot.Allows(permission.ChannelView) {
			return Scope{}, snapshot, false
		}
		return s, snapshot, true
	}
	// DM-канал — workspace_id отсутствует. Доступ только через channel_members.
	if s.Kind != "dm" {
		return Scope{}, permission.Snapshot{}, false
	}
	if !IsMember(ctx, db, channelID, userID) {
		return Scope{}, permission.Snapshot{}, false
	}
	return s, permission.Snapshot{Member: true, Base: map[permission.Action]bool{
		permission.ChannelView: true, permission.MessageWrite: true,
		permission.MessageReact: true, permission.MessageAttach: true, permission.MessageMention: true,
	}}, true
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
