// Package permission — единый резолвер прав. Модули вызывают Authorize /
// AuthorizeChannel с семантическим Action; конкретный набор прав роли
// хранится в workspace_roles.base_action_mask (text[]), эффективный набор
// юзера — union'у всех его ролей в воркспейсе (workspace_role_members).
//
// До миграции «Кастомные роли» прав-матрица жила в этом файле как хардкод.
// Сейчас хардкод остался только как fallback для двух кейсов:
//  1. Can(role, action) — публичный helper для случаев, где юзер уже
//     резолвлен (используется тестами/документацией). Он бьётся в
//     хардкод-матрицу — это работает для seeded role'ов owner/admin/
//     moderator/member, но НЕ учитывает кастомные роли. Новый код должен
//     использовать Authorize, который сходит в БД.
//  2. baseHardcoded — fallback если в БД нет ни одной роли юзера (теоретически
//     невозможно после миграции, но защищает от panic'а).
package permission

import (
	"context"

	"github.com/google/uuid"

	"github.com/NotReptile/RuCord/libs/shared-go/channelacl"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

const (
	roleOwner     = "owner"
	roleAdmin     = "admin"
	roleModerator = "moderator"
	roleMember    = "member"
)

type Action = channelacl.Action

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
	// MessageMentionEveryone — массовый пинг @everyone/@here. Отдельное от
	// MessageMention право: шумное, по умолчанию только owner/admin/moderator
	// (backfill — миграция 32). Без права токен остаётся обычным текстом.
	MessageMentionEveryone Action = "message.mention_everyone"

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
	MessageMentionEveryone,
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
	MessageMentionEveryone,
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
		MessageWrite, MessageReact, MessageAttach, MessageMention, MessageMentionEveryone,
		WorkspaceUpdate,
		ChannelView,
	),
	roleModerator: setOf(
		ChannelCreate, ChannelUpdate, ChannelDelete, ChannelManageMembers,
		MessageModerate, InviteManage, AuditRead, MemberKick,
		MessageWrite, MessageReact, MessageAttach, MessageMention, MessageMentionEveryone,
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
	snapshot, err := LoadWorkspace(ctx, db, workspaceID, userID)
	if err != nil {
		return "", false, false
	}
	return snapshot.Role, snapshot.Member, snapshot.Allows(action)
}

// AuthorizeChannel — то же, но с учётом override-слоёв (Wave 5):
//
//	base(union ролей) → category_role_overrides → channel_role_overrides
//	  → channel_user_overrides
//
// Каждый role-слой: allowed = (allowed ∨ any(granted)) ∧ ¬any(denied),
// т.е. канальный override перекрывает категорийный. Юзерский слой —
// высший приоритет: его deny бьёт любые grant'ы ролей, его grant бьёт
// любые deny ролей. Owner короткозамыкается на allowed=true (self-lock).
func AuthorizeChannel(ctx context.Context, db *postgres.Pool, workspaceID, channelID, userID uuid.UUID, action Action) (role string, isMember bool, allowed bool) {
	base, err := LoadWorkspace(ctx, db, workspaceID, userID)
	if err != nil || !base.Member {
		return "", false, false
	}
	channels, err := LoadChannels(ctx, db, workspaceID, userID, channelID, base)
	if err != nil {
		return base.Role, true, false
	}
	snapshot, exists := channels[channelID]
	return base.Role, true, exists && snapshot.Allows(action)
}

func CanInChannel(ctx context.Context, db *postgres.Pool, workspaceID, channelID, userID uuid.UUID, action Action) bool {
	_, _, ok := AuthorizeChannel(ctx, db, workspaceID, channelID, userID, action)
	return ok
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
