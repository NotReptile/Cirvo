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

	// D.4 — channel-scoped actions, поддерживают override через
	// channel_role_overrides. Базовые grants ниже, эффективный набор
	// решает AuthorizeChannel.
	MessageWrite   Action = "message.write"   // отправлять сообщения в канал
	MessageReact   Action = "message.react"   // ставить/снимать реакции
	MessageAttach  Action = "message.attach"  // прикреплять файлы к сообщению
	MessageMention Action = "message.mention" // упоминать @username (deny → mentions молча игнорируются)
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
		// channel-scoped — moderator по умолчанию пишет/реагирует/прикрепляет
		MessageWrite,
		MessageReact,
		MessageAttach,
		MessageMention,
	),
	roleMember: setOf(
		// обычный участник может писать в канал (если он в нём виден),
		// ставить реакции, прикреплять файлы и упоминать
		MessageWrite,
		MessageReact,
		MessageAttach,
		MessageMention,
	),
}

// ChannelActions — список action'ов, доступных к override per channel.
// Используется UI чтобы знать, какие чекбоксы рендерить. Совпадает с
// channel-scoped константами выше.
var ChannelActions = []Action{
	MessageWrite,
	MessageReact,
	MessageAttach,
	MessageMention,
	ChannelManageMembers,
	ChannelUpdate,
}

// Can reports whether a role is allowed to perform the action at the
// workspace level (без учёта channel overrides).
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

// AuthorizeChannel — D.4. То же, что Authorize, но дополнительно применяет
// channel_role_overrides поверх workspace-роли.
//
// Effective = (Can(role, action) ∨ granted) ∧ ¬denied.
//
// Семантика «защиты от самоблокировки»: owner всегда сохраняет полный
// доступ — overrides на owner просто игнорируются (admin под overrides
// попадает; намеренно, чтобы owner мог делегировать модерацию админу с
// узкими правами на конкретный канал).
//
// Возвращает (role, isMember, allowed). Не-член workspace → isMember=false.
func AuthorizeChannel(ctx context.Context, db *postgres.Pool, workspaceID, channelID, userID uuid.UUID, action Action) (role string, isMember bool, allowed bool) {
	err := db.QueryRow(ctx,
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if err != nil {
		return "", false, false
	}
	if role == roleOwner {
		return role, true, true
	}
	base := Can(role, action)
	allowed = base
	var granted, denied []string
	err = db.QueryRow(ctx,
		`select coalesce(granted_actions, '{}'), coalesce(denied_actions, '{}')
		 from channel_role_overrides where channel_id = $1 and role_code = $2`,
		channelID, role,
	).Scan(&granted, &denied)
	if err == nil {
		actStr := string(action)
		if !allowed && containsStr(granted, actStr) {
			allowed = true
		}
		if containsStr(denied, actStr) {
			allowed = false
		}
	}
	return role, true, allowed
}

// CanInChannel — удобный wrapper для случаев, когда у вызывающего уже есть
// channel.Scope (т.е. видимость канала уже проверена). Не сходит в БД за
// ролью повторно — берёт через AuthorizeChannel.
func CanInChannel(ctx context.Context, db *postgres.Pool, workspaceID, channelID, userID uuid.UUID, action Action) bool {
	_, _, ok := AuthorizeChannel(ctx, db, workspaceID, channelID, userID, action)
	return ok
}

func containsStr(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
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
		MessageWrite,
		MessageReact,
		MessageAttach,
		MessageMention,
	)
}
