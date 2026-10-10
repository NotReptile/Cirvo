package channelacl

import (
	"context"
	"github.com/google/uuid"
	"github.com/NotReptile/RuCord/libs/shared-go/postgres"
)

// VisibleChannels evaluates a batch without retaining grants between events.
// Outer keys are user IDs, inner keys are channel IDs. Missing entries deny.
// Empty or nil channel/user IDs mean no candidates, never an unrestricted query.
func VisibleChannels(ctx context.Context, db *postgres.Pool, channelIDs, userIDs []uuid.UUID) (map[uuid.UUID]map[uuid.UUID]bool, error) {
	result := map[uuid.UUID]map[uuid.UUID]bool{}
	if len(channelIDs) == 0 || len(userIDs) == 0 {
		return result, nil
	}
	rows, err := db.Query(ctx, `with recursive candidates as (
	 select id, parent_channel_id, workspace_id from channels where id = any($1::uuid[])
	 union
	 select p.id, p.parent_channel_id, p.workspace_id from channels p
	 join candidates child on p.id = child.parent_channel_id and p.workspace_id = child.workspace_id
	) select requested.user_id, c.id, c.parent_channel_id, c.workspace_id, c.kind, c.is_private,
	 wm.role_code, wr.id, coalesce(wr.base_action_mask, '{}'),
	 exists(select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = requested.user_id),
	 coalesce(caro.granted_actions, '{}'), coalesce(caro.denied_actions, '{}'),
	 coalesce(cro.granted_actions, '{}'), coalesce(cro.denied_actions, '{}'),
	 coalesce(cuo.granted_actions, '{}'), coalesce(cuo.denied_actions, '{}')
	 from channels c cross join unnest($2::uuid[]) as requested(user_id)
	 left join workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = requested.user_id
	 left join workspace_role_members wrm on wrm.workspace_id = c.workspace_id and wrm.user_id = requested.user_id
	 left join workspace_roles wr on wr.id = wrm.role_id
	 left join category_role_overrides caro on caro.category_id = c.category_id and caro.role_id = wrm.role_id
	 left join channel_role_overrides cro on cro.channel_id = c.id and cro.role_id = wrm.role_id
	 left join channel_user_overrides cuo on cuo.channel_id = c.id and cuo.user_id = requested.user_id
	 where c.id in (select id from candidates)`, channelIDs, userIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type pair struct{ user, channel uuid.UUID }
	type access struct {
		snapshot Snapshot
		assigned bool
	}
	loaded := map[pair]access{}
	parents := map[uuid.UUID]*uuid.UUID{}
	workspaces := map[uuid.UUID]*uuid.UUID{}
	for rows.Next() {
		var userID, channelID uuid.UUID
		var workspaceID, roleID, parentID *uuid.UUID
		var role *string
		var kind string
		var private, explicit bool
		var mask, catGrant, catDeny, chGrant, chDeny, userGrant, userDeny []string
		if err := rows.Scan(&userID, &channelID, &parentID, &workspaceID, &kind, &private, &role, &roleID, &mask, &explicit,
			&catGrant, &catDeny, &chGrant, &chDeny, &userGrant, &userDeny); err != nil {
			return nil, err
		}
		key := pair{userID, channelID}
		item, exists := loaded[key]
		if !exists {
			s := Snapshot{Member: role != nil, Base: map[Action]bool{}, Private: private, ExplicitMember: explicit,
				CategoryGrant: map[Action]bool{}, CategoryDeny: map[Action]bool{},
				ChannelGrant: map[Action]bool{}, ChannelDeny: map[Action]bool{},
				UserGrant: actionSet(userGrant), UserDeny: actionSet(userDeny)}
			if role != nil {
				s.Role = *role
			}
			if workspaceID == nil && kind == "dm" {
				s.Member = explicit
				s.Private = false
				s.Base[ChannelView] = explicit
			}
			item.snapshot = s
		}
		item.assigned = item.assigned || roleID != nil
		mergeActions(item.snapshot.Base, mask)
		mergeActions(item.snapshot.CategoryGrant, catGrant)
		mergeActions(item.snapshot.CategoryDeny, catDeny)
		mergeActions(item.snapshot.ChannelGrant, chGrant)
		mergeActions(item.snapshot.ChannelDeny, chDeny)
		loaded[key] = item
		parents[channelID] = parentID
		workspaces[channelID] = workspaceID
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byUser := map[uuid.UUID]map[uuid.UUID]Snapshot{}
	for key, item := range loaded {
		if parent := parents[key.channel]; parent != nil {
			workspace, parentWorkspace := workspaces[key.channel], workspaces[*parent]
			if workspace == nil || parentWorkspace == nil || *workspace != *parentWorkspace {
				item.snapshot.ParentBlocked = true
			}
		}
		if item.snapshot.Member && !item.assigned && item.snapshot.Role != "" {
			mergeActions(item.snapshot.Base, LegacyActions(item.snapshot.Role))
		}
		if byUser[key.user] == nil {
			byUser[key.user] = map[uuid.UUID]Snapshot{}
		}
		byUser[key.user][key.channel] = item.snapshot
	}
	for userID, snapshots := range byUser {
		applyParentVisibility(snapshots, parents)
		result[userID] = map[uuid.UUID]bool{}
		for _, channelID := range channelIDs {
			result[userID][channelID] = snapshots[channelID].Allows(ChannelView)
		}
	}
	return result, nil
}

func VisibleMembers(ctx context.Context, db *postgres.Pool, channelID uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	batch, err := VisibleChannels(ctx, db, []uuid.UUID{channelID}, userIDs)
	if err != nil {
		return nil, err
	}
	result := map[uuid.UUID]bool{}
	for userID, channels := range batch {
		result[userID] = channels[channelID]
	}
	return result, nil
}

func VisibleChannel(ctx context.Context, db *postgres.Pool, channelID, userID uuid.UUID) (bool, error) {
	batch, err := VisibleMembers(ctx, db, channelID, []uuid.UUID{userID})
	return batch[userID], err
}
