package channelacl

import (
	"context"

	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

type Action = string

const (
	roleOwner    = "owner"
	roleMember   = "member"
	ChannelView  = "channel.view"
	MessageWrite = "message.write"
)

var AllActions = []string{
	"channel.create", "channel.update", "channel.delete", "channel.manage_members",
	"message.moderate", "invite.manage", "audit.read", "member.manage_role", "member.kick",
	"message.write", "message.react", "message.attach", "message.mention", "message.mention_everyone",
	"workspace.update", "workspace.delete", "channel.view",
}

func LegacyActions(role string) []string {
	if role == "owner" {
		return append([]string{}, AllActions...)
	}
	result := []string{"message.write", "message.react", "message.attach", "message.mention", "channel.view"}
	if role != "member" && role != "moderator" && role != "admin" {
		return nil
	}
	if role == "member" {
		return result
	}
	result = append(result, "channel.create", "channel.update", "channel.delete", "channel.manage_members",
		"message.moderate", "invite.manage", "audit.read", "member.kick", "message.mention_everyone")
	if role == "admin" {
		result = append(result, "workspace.update", "member.manage_role")
	}
	return result
}

// Snapshot evaluates all actions after loading membership and masks once.
// A missing role assignment retains the legacy primary-role fallback.
type Snapshot struct {
	Role           string
	Member         bool
	Base           map[Action]bool
	Private        bool
	ExplicitMember bool
	// ParentBlocked is an independent boundary: child grants cannot expose a
	// channel whose ancestor is invisible, missing, or cyclic.
	ParentBlocked               bool
	CategoryGrant, CategoryDeny map[Action]bool
	ChannelGrant, ChannelDeny   map[Action]bool
	UserGrant, UserDeny         map[Action]bool
}

func actionSet(values []string) map[Action]bool {
	result := make(map[Action]bool, len(values))
	for _, value := range values {
		result[Action(value)] = true
	}
	return result
}

func mergeActions(target map[Action]bool, values []string) {
	for _, value := range values {
		target[Action(value)] = true
	}
}

func (s Snapshot) Allows(action Action) bool {
	if !s.Member || s.ParentBlocked {
		return false
	}
	if s.Role == roleOwner {
		return true
	}
	allowed := s.Base[action]
	if action == ChannelView && s.Private {
		allowed = s.ExplicitMember
	}
	allowed = (allowed || s.CategoryGrant[action]) && !s.CategoryDeny[action]
	allowed = (allowed || s.ChannelGrant[action]) && !s.ChannelDeny[action]
	if s.UserDeny[action] {
		return false
	}
	return allowed || s.UserGrant[action]
}

func (s Snapshot) Actions() []string {
	result := make([]string, 0, len(AllActions))
	for _, action := range AllActions {
		if s.Allows(action) {
			result = append(result, string(action))
		}
	}
	return result
}

func LoadWorkspace(ctx context.Context, db *postgres.Pool, workspaceID, userID uuid.UUID) (Snapshot, error) {
	s := Snapshot{Base: map[Action]bool{}}
	rows, err := db.Query(ctx, `select wm.role_code, wr.id, coalesce(wr.base_action_mask, '{}')
	 from workspace_members wm
	 left join workspace_role_members wrm on wrm.workspace_id = wm.workspace_id and wrm.user_id = wm.user_id
	 left join workspace_roles wr on wr.id = wrm.role_id
	 where wm.workspace_id = $1 and wm.user_id = $2`, workspaceID, userID)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	assigned := false
	for rows.Next() {
		var roleID *uuid.UUID
		var mask []string
		if err := rows.Scan(&s.Role, &roleID, &mask); err != nil {
			return Snapshot{}, err
		}
		s.Member = true
		assigned = assigned || roleID != nil
		mergeActions(s.Base, mask)
	}
	if err := rows.Err(); err != nil {
		return Snapshot{}, err
	}
	if s.Member && !assigned {
		for _, action := range LegacyActions(s.Role) {
			s.Base[action] = true
		}
	}
	return s, nil
}

// LoadChannels returns every channel's overlays in one query. channelID ==
// uuid.Nil loads the workspace list; otherwise it loads only the requested ID.
func LoadChannels(ctx context.Context, db *postgres.Pool, workspaceID, userID, channelID uuid.UUID, base Snapshot) (map[uuid.UUID]Snapshot, error) {
	result := map[uuid.UUID]Snapshot{}
	parents := map[uuid.UUID]*uuid.UUID{}
	rows, err := db.Query(ctx, `with recursive candidates as (
	 select id, parent_channel_id from channels where workspace_id = $1
	 and ($3 = '00000000-0000-0000-0000-000000000000'::uuid or id = $3)
	 union
	 select p.id, p.parent_channel_id from channels p join candidates child on p.id = child.parent_channel_id
	 where p.workspace_id = $1
	) select c.id, c.parent_channel_id, c.is_private,
	 exists(select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = $2),
	 coalesce(caro.granted_actions, '{}'), coalesce(caro.denied_actions, '{}'),
	 coalesce(cro.granted_actions, '{}'), coalesce(cro.denied_actions, '{}'),
	 coalesce(cuo.granted_actions, '{}'), coalesce(cuo.denied_actions, '{}')
	 from channels c
	 left join workspace_role_members wrm on wrm.workspace_id = c.workspace_id and wrm.user_id = $2
	 left join category_role_overrides caro on caro.category_id = c.category_id and caro.role_id = wrm.role_id
	 left join channel_role_overrides cro on cro.channel_id = c.id and cro.role_id = wrm.role_id
	 left join channel_user_overrides cuo on cuo.channel_id = c.id and cuo.user_id = $2
	 where c.id in (select id from candidates)`, workspaceID, userID, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var parentID *uuid.UUID
		var private, explicit bool
		var catGrant, catDeny, chGrant, chDeny, userGrant, userDeny []string
		if err := rows.Scan(&id, &parentID, &private, &explicit, &catGrant, &catDeny, &chGrant, &chDeny, &userGrant, &userDeny); err != nil {
			return nil, err
		}
		s, ok := result[id]
		if !ok {
			s = base
			s.Private, s.ExplicitMember = private, explicit
			s.CategoryGrant, s.CategoryDeny = map[Action]bool{}, map[Action]bool{}
			s.ChannelGrant, s.ChannelDeny = map[Action]bool{}, map[Action]bool{}
			s.UserGrant, s.UserDeny = actionSet(userGrant), actionSet(userDeny)
		}
		mergeActions(s.CategoryGrant, catGrant)
		mergeActions(s.CategoryDeny, catDeny)
		mergeActions(s.ChannelGrant, chGrant)
		mergeActions(s.ChannelDeny, chDeny)
		result[id] = s
		parents[id] = parentID
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	applyParentVisibility(result, parents)
	if channelID != uuid.Nil {
		selected := map[uuid.UUID]Snapshot{}
		if s, ok := result[channelID]; ok {
			selected[channelID] = s
		}
		return selected, nil
	}
	return result, nil
}

// applyParentVisibility checks the complete ancestry before applying any child
// overrides. Missing ancestors and corrupt cycles fail closed.
func applyParentVisibility(snapshots map[uuid.UUID]Snapshot, parents map[uuid.UUID]*uuid.UUID) {
	checked := map[uuid.UUID]bool{}
	visiting := map[uuid.UUID]bool{}
	var visible func(uuid.UUID) bool
	visible = func(id uuid.UUID) bool {
		if value, ok := checked[id]; ok {
			return value
		}
		s, exists := snapshots[id]
		if !exists || visiting[id] {
			return false
		}
		visiting[id] = true
		if parent := parents[id]; parent != nil && !visible(*parent) {
			s.ParentBlocked = true
			snapshots[id] = s
		}
		delete(visiting, id)
		checked[id] = s.Allows(ChannelView)
		return checked[id]
	}
	for id := range snapshots {
		visible(id)
	}
}
