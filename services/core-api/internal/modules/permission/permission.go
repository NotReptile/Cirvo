// Package permission — единый резолвер прав. Модули вызывают Authorize /
// AuthorizeChannel с семантическим Action; конкретный набор прав роли
// хранится в workspace_roles.base_action_mask (jsonb), эффективный набор
// юзера — union'у всех его ролей в воркспейсе (workspace_role_members).
//
// До миграции «Кастомные роли» прав-матрица жила в этом файле как хардкод.
// Сейчас хардкод остался только как fallback для двух кейсов:
//   1) Can(role, action) — публичный helper для случаев, где юзер уже
//      резолвлен (используется тестами/документацией). Он бьётся в
//      хардкод-матрицу — это работает для seeded role'ов owner/admin/
//      moderator/member, но НЕ учитывает кастомные роли. Новый код должен
//      использовать Authorize, который сходит в БД.
//   2) baseHardcoded — fallback если в БД нет ни одной роли юзера (теоретически
//      невозможно после миграции, но защищает от panic'а).
package permission

import (
	"context"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

const (
	roleOwner     = "owner"
	roleAdmin     = "admin"
	roleModerator = "moderator"
	roleMember    = "member"
)

type Action string

const (
	ChannelCreate        Action = "channel.create"
	ChannelUpdate        Action = "channel.update"
	ChannelDelete        Action = "channel.delete"
	ChannelManageMembers Action = "channel.manage_members"

	MessageModerate Action = "message.moderate"

	InviteManage Action = "invite.manage"

	AuditRead Action = "audit.read"

	MemberManageRole Action = "member.manage_role"
	MemberKick       Action = "member.kick"

	MessageWrite   Action = "message.write"
	MessageReact   Action = "message.react"
	MessageAttach  Action = "message.attach"
	MessageMention Action = "message.mention"

	WorkspaceUpdate Action = "workspace.update"
	// WorkspaceDelete — удаление воркспейса целиком (cascade). По
	// Discord-семантике даётся только owner-роли; admin'у нет (он может
	// всё внутри, но не может убить сервер). Backfill — миграция 23.
	WorkspaceDelete Action = "workspace.delete"

	// ChannelView — право видеть канал в списке и читать сообщения. Для
	// PUBLIC-каналов наследуется из base_action_mask (есть у всех seeded
	// ролей по умолчанию). Для PRIVATE-каналов AuthorizeChannel игнорирует
	// base и требует явный grant в channel_role_overrides либо запись в
	// channel_members.
	ChannelView Action = "channel.view"
)

// AllActions — единый источник списка для UI / валидации. Совпадает с
// allActions() ниже; держится синхронно вручную (новый Action → обе записи).
var AllActions = []Action{
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
	WorkspaceUpdate,
	WorkspaceDelete,
	ChannelView,
}

// ChannelActions — action'ы, доступные к override per channel.
var ChannelActions = []Action{
	ChannelView,
	MessageWrite,
	MessageReact,
	MessageAttach,
	MessageMention,
	ChannelManageMembers,
	ChannelUpdate,
}

// baseHardcoded — fallback-матрица на случай, если workspace_role_members
// для юзера пустой (теоретически невозможно после миграции). Совпадает с
// предыдущим хардкодом до перехода на jsonb-маски.
var baseHardcoded = map[string]map[Action]struct{}{
	roleOwner: allActions(),
	// admin отличается от owner только отсутствием WorkspaceDelete:
	// удалить воркспейс может только владелец (Discord-семантика).
	roleAdmin: setOf(
		ChannelCreate, ChannelUpdate, ChannelDelete, ChannelManageMembers,
		MessageModerate, InviteManage, AuditRead, MemberManageRole, MemberKick,
		MessageWrite, MessageReact, MessageAttach, MessageMention,
		WorkspaceUpdate,
		ChannelView,
	),
	roleModerator: setOf(
		ChannelCreate, ChannelUpdate, ChannelDelete, ChannelManageMembers,
		MessageModerate, InviteManage, AuditRead, MemberKick,
		MessageWrite, MessageReact, MessageAttach, MessageMention,
		ChannelView,
	),
	roleMember: setOf(
		MessageWrite, MessageReact, MessageAttach, MessageMention,
		ChannelView,
	),
}

// Can — fallback по хардкод-матрице seeded ролей. Не учитывает custom roles
// и не сходит в БД. Используется только в legacy-сценариях где роль уже на
// руках и важна именно базовая seeded-семантика. Новый код — Authorize.
func Can(role string, action Action) bool {
	actions, ok := baseHardcoded[role]
	if !ok {
		return false
	}
	_, allowed := actions[action]
	return allowed
}

// Authorize резолвит права юзера в воркспейсе через workspace_role_members
// + workspace_roles.base_action_mask (union всех ролей).
//
// Возвращает primary role (workspace_members.role_code — для совместимости
// с местами, где значение используется для отображения), isMember и allowed.
func Authorize(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID, action Action) (role string, isMember bool, allowed bool) {
	err := db.QueryRow(ctx,
		`select role_code from workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if err != nil {
		return "", false, false
	}
	allowed = hasActionInRoles(ctx, db, workspaceID, userID, action, role)
	return role, true, allowed
}

// AuthorizeChannel — то же, но с учётом channel_role_overrides.
//
// Эффективный набор = (union(base_action_mask всех ролей юзера) ∨ any(granted))
//   − any(denied)
//
// Owner короткозамыкается на allowed=true (защита от self-lock).
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

	// Один проход: union base masks ролей юзера + флаги granted/denied из
	// channel_role_overrides per role. Сравнение по role_id (новая колонка).
	// Параллельно тащим channels.is_private — для ChannelView в приватном
	// канале base игнорируется, см. ниже.
	rows, err := db.Query(ctx,
		`select wr.base_action_mask, coalesce(cro.granted_actions, '{}'), coalesce(cro.denied_actions, '{}'), c.is_private
		 from workspace_role_members wrm
		 join workspace_roles wr on wr.id = wrm.role_id
		 join channels c on c.id = $3
		 left join channel_role_overrides cro
		   on cro.role_id = wrm.role_id and cro.channel_id = $3
		 where wrm.workspace_id = $1 and wrm.user_id = $2`,
		workspaceID, userID, channelID,
	)
	if err != nil {
		return role, true, fallbackCan(role, action)
	}
	defer rows.Close()

	actStr := string(action)
	var baseAllowed, anyGranted, anyDenied, isPrivate, anyRow bool
	for rows.Next() {
		anyRow = true
		var mask []string
		var granted, denied []string
		var priv bool
		if err := rows.Scan(&mask, &granted, &denied, &priv); err != nil {
			continue
		}
		isPrivate = priv
		if containsStr(mask, actStr) {
			baseAllowed = true
		}
		if containsStr(granted, actStr) {
			anyGranted = true
		}
		if containsStr(denied, actStr) {
			anyDenied = true
		}
	}
	// Для приватного канала view-доступ через base_action_mask не работает —
	// иначе любая роль с дефолтным channel.view в base видела бы все
	// приватные каналы. Только явный grant в override либо channel_members
	// (последнее проверяет channel.Resolve, не permission).
	if isPrivate && action == ChannelView {
		baseAllowed = false
	}
	if !anyRow {
		return role, true, fallbackCan(role, action)
	}
	allowed = (baseAllowed || anyGranted) && !anyDenied
	return role, true, allowed
}

func CanInChannel(ctx context.Context, db *postgres.Pool, workspaceID, channelID, userID uuid.UUID, action Action) bool {
	_, _, ok := AuthorizeChannel(ctx, db, workspaceID, channelID, userID, action)
	return ok
}

// hasActionInRoles — union base_action_mask всех ролей юзера в воркспейсе.
// Если ни одной роли (например, миграция backfill не отработала) — fallback
// на хардкод-матрицу по primary role.
func hasActionInRoles(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID, action Action, primaryRole string) bool {
	rows, err := db.Query(ctx,
		`select wr.base_action_mask
		 from workspace_role_members wrm
		 join workspace_roles wr on wr.id = wrm.role_id
		 where wrm.workspace_id = $1 and wrm.user_id = $2`,
		workspaceID, userID,
	)
	if err != nil {
		return fallbackCan(primaryRole, action)
	}
	defer rows.Close()

	actStr := string(action)
	anyRow := false
	for rows.Next() {
		anyRow = true
		var mask []string
		if err := rows.Scan(&mask); err != nil {
			continue
		}
		if containsStr(mask, actStr) {
			return true
		}
	}
	if !anyRow {
		return fallbackCan(primaryRole, action)
	}
	return false
}

func fallbackCan(role string, action Action) bool {
	actions, ok := baseHardcoded[role]
	if !ok {
		return false
	}
	_, allowed := actions[action]
	return allowed
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
	out := make(map[Action]struct{}, len(AllActions))
	for _, a := range AllActions {
		out[a] = struct{}{}
	}
	return out
}
