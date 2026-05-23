// seed.go — helper'ы для tx-level операций над workspace_roles /
// workspace_role_members, чтобы создание воркспейса и invite-accept
// одной транзакцией seed'или роли и проставляли primary-role в
// workspace_role_members.
package role

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

const (
	CodeOwner     = "owner"
	CodeAdmin     = "admin"
	CodeModerator = "moderator"
	CodeMember    = "member"
)

// SeedDefaults вставляет 4 system-роли (owner/admin/moderator/member) для
// нового воркспейса. Идемпотентна через unique (workspace_id, code).
func SeedDefaults(ctx context.Context, q Querier, workspaceID uuid.UUID) error {
	for _, r := range defaultRoles {
		if _, err := q.Exec(ctx,
			`insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, true)
			 on conflict (workspace_id, code) do nothing`,
			uuid.New(), workspaceID, r.Code, r.Name, r.Color, r.Position, r.Hoisted, r.Actions,
		); err != nil {
			return err
		}
	}
	return nil
}

// AssignSystemRole добавляет юзеру membership в роль с заданным code.
// Используется после SeedDefaults / insert workspace_members. ON CONFLICT
// делает операцию идемпотентной.
func AssignSystemRole(ctx context.Context, q Querier, workspaceID, userID uuid.UUID, code string) error {
	_, err := q.Exec(ctx,
		`insert into workspace_role_members (workspace_id, role_id, user_id)
		 select $1, wr.id, $2 from workspace_roles wr
		 where wr.workspace_id = $1 and wr.code = $3
		 on conflict (role_id, user_id) do nothing`,
		workspaceID, userID, code,
	)
	return err
}

// SyncPrimaryRole — синхронизирует workspace_role_members с новым primary
// role_code (workspace_members.role_code). Стирает все назначения юзера
// (кастомные роли тоже) и проставляет одну запись для новой primary role.
// Семантика legacy admin endpoint'а PATCH /members/{userId}: одна роль.
//
// Когда придёт UI для multi-role assignment, отдельный endpoint будет
// дописывать/убирать custom role'ы независимо.
func SyncPrimaryRole(ctx context.Context, q Querier, workspaceID, userID uuid.UUID, code string) error {
	if _, err := q.Exec(ctx,
		`delete from workspace_role_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	); err != nil {
		return err
	}
	return AssignSystemRole(ctx, q, workspaceID, userID, code)
}

// RemoveAllAssignments — при kick'е юзера. workspace_members FK on delete
// cascade сделает то же при удалении membership, но мы вызываем явно,
// чтобы порядок не зависел от deferred constraints.
func RemoveAllAssignments(ctx context.Context, q Querier, workspaceID, userID uuid.UUID) error {
	_, err := q.Exec(ctx,
		`delete from workspace_role_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	)
	return err
}

type defaultRole struct {
	Code     string
	Name     string
	Color    *string
	Position int
	Hoisted  bool
	Actions  []string
}

func strp(s string) *string { return &s }

var defaultRoles = []defaultRole{
	{
		Code:     CodeOwner,
		Name:     "Владелец",
		Color:    strp("#ed4245"),
		Position: 1000,
		Hoisted:  true,
		Actions: []string{
			"channel.create", "channel.update", "channel.delete", "channel.manage_members",
			"message.moderate", "invite.manage", "audit.read", "member.manage_role", "member.kick",
			"message.write", "message.react", "message.attach", "message.mention",
			"workspace.update",
		},
	},
	{
		Code:     CodeAdmin,
		Name:     "Администратор",
		Color:    strp("#5865f2"),
		Position: 100,
		Hoisted:  true,
		Actions: []string{
			"channel.create", "channel.update", "channel.delete", "channel.manage_members",
			"message.moderate", "invite.manage", "audit.read", "member.manage_role", "member.kick",
			"message.write", "message.react", "message.attach", "message.mention",
			"workspace.update",
		},
	},
	{
		Code:     CodeModerator,
		Name:     "Модератор",
		Color:    strp("#3ba55c"),
		Position: 50,
		Hoisted:  true,
		Actions: []string{
			"channel.create", "channel.update", "channel.delete", "channel.manage_members",
			"message.moderate", "invite.manage", "audit.read", "member.kick",
			"message.write", "message.react", "message.attach", "message.mention",
		},
	},
	{
		Code:     CodeMember,
		Name:     "Участник",
		Color:    nil,
		Position: 10,
		Hoisted:  false,
		Actions: []string{
			"message.write", "message.react", "message.attach", "message.mention",
		},
	},
}
