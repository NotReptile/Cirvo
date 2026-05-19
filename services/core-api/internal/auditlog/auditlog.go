package auditlog

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// Action codes used across modules.
const (
	ActionWorkspaceCreated     = "workspace.created"
	ActionWorkspaceMemberAdded = "workspace.member.added"
	ActionChannelCreated       = "channel.created"
	ActionChannelMemberAdded   = "channel.member.added"
	ActionChannelMemberRemoved = "channel.member.removed"
	ActionMessageDeleted       = "message.deleted"
	ActionInviteCreated        = "invite.created"
	ActionInviteRevoked        = "invite.revoked"
	ActionInviteUsed           = "invite.used"
	ActionProfileUpdated       = "profile.updated"
	ActionUserBanned           = "user.banned"
	ActionUserUnbanned         = "user.unbanned"
	ActionUserDeleted          = "user.deleted"
	ActionServerSettingsUpdate = "server.settings.updated"
	ActionRetentionSweep       = "server.retention.sweep"
)

// Entry describes a single audit log entry to be persisted.
type Entry struct {
	ActorID     uuid.UUID
	WorkspaceID uuid.UUID
	Action      string
	TargetType  string
	TargetID    string
}

// Record best-effort writes an entry. Failures are logged but never surfaced
// to callers — audit MUST NOT block the originating action.
func Record(ctx context.Context, db *postgres.Pool, logger *slog.Logger, entry Entry) {
	if db == nil {
		return
	}
	id := uuid.New()
	var actor, ws any
	if entry.ActorID != uuid.Nil {
		actor = entry.ActorID
	}
	if entry.WorkspaceID != uuid.Nil {
		ws = entry.WorkspaceID
	}
	_, err := db.Exec(ctx,
		`insert into audit_log (id, actor_user_id, workspace_id, action_code, target_type, target_id, created_at)
		 values ($1, $2, $3, $4, $5, $6, now())`,
		id, actor, ws, entry.Action, entry.TargetType, entry.TargetID,
	)
	if err != nil && logger != nil {
		logger.Warn("audit record failed",
			slog.String("action", entry.Action),
			slog.String("target_type", entry.TargetType),
			slog.String("target_id", entry.TargetID),
			slog.String("error", err.Error()),
		)
	}
}
