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
// A user can see a channel when they are a workspace member, and either the
// channel is public or they appear in channel_members.
func Resolve(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) (Scope, bool) {
	var s Scope
	err := db.QueryRow(ctx,
		`select c.workspace_id, c.kind, c.is_private
		 from channels c
		 join workspace_members m on m.workspace_id = c.workspace_id and m.user_id = $2
		 where c.id = $1`,
		channelID, userID,
	).Scan(&s.WorkspaceID, &s.Kind, &s.IsPrivate)
	if err != nil {
		return Scope{}, false
	}
	if s.IsPrivate {
		if !IsMember(ctx, db, channelID, userID) {
			return Scope{}, false
		}
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
