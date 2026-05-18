// Package permission is the single source of truth for "who can do what"
// across the core-api. Modules call Authorize / Can with a semantic action
// instead of doing role string comparisons inline.
package permission

import (
	"context"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// Role codes are duplicated as string literals here (rather than imported
// from the workspace package) to keep this package free of cycles - workspace
// also wants to call Authorize. The canonical source is workspace.RoleOwner
// etc; if you rename them there, update them here too.
const (
	roleOwner     = "owner"
	roleAdmin     = "admin"
	roleModerator = "moderator"
	roleMember    = "member"
)

// Action is a semantic name for a permission check. New actions go here and
// are then mapped to roles in roleActions below.
type Action string

const (
	ChannelCreate        Action = "channel.create"
	ChannelUpdate        Action = "channel.update"
	ChannelDelete        Action = "channel.delete"
	ChannelManageMembers Action = "channel.manage_members"

	MessageModerate Action = "message.moderate" // delete or edit other people's messages

	InviteManage Action = "invite.manage" // create / list / revoke

	AuditRead Action = "audit.read"

	MemberManageRole Action = "member.manage_role" // change another member's role
	MemberKick       Action = "member.kick"        // remove another member from workspace
)

// roleActions is the canonical role-to-actions matrix.
//
// Owner and Admin share the full set today; the distinction is enforced
// outside of this table (only owner can transfer ownership / delete the
// workspace itself). When workspace-level destructive actions appear, they
// should land here as new Actions and be granted to owner only.
var roleActions = map[string]map[Action]struct{}{
	roleOwner: allActions(),
	roleAdmin: allActions(),
	roleModerator: setOf(
		ChannelCreate,
		ChannelUpdate,
		ChannelDelete,
		ChannelManageMembers,
		MessageModerate,
		InviteManage,
		AuditRead,
		MemberKick,
	),
	roleMember: {},
}

// Can reports whether a role is allowed to perform the action.
func Can(role string, action Action) bool {
	actions, ok := roleActions[role]
	if !ok {
		return false
	}
	_, allowed := actions[action]
	return allowed
}

// Authorize resolves the user's role in the workspace and checks the action.
// Three values let callers distinguish "not a member" (return 404 to hide
// existence) from "member but no permission" (return 403).
func Authorize(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID, action Action) (role string, isMember bool, allowed bool) {
	err := db.QueryRow(ctx,
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if err != nil {
		return "", false, false
	}
	return role, true, Can(role, action)
}

func setOf(actions ...Action) map[Action]struct{} {
	out := make(map[Action]struct{}, len(actions))
	for _, a := range actions {
		out[a] = struct{}{}
	}
	return out
}

func allActions() map[Action]struct{} {
	return setOf(
		ChannelCreate,
		ChannelUpdate,
		ChannelDelete,
		ChannelManageMembers,
		MessageModerate,
		InviteManage,
		AuditRead,
		MemberManageRole,
		MemberKick,
	)
}
