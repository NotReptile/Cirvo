package channelacl

import (
	"testing"

	"github.com/google/uuid"
)

func TestAncestorVisibilityCannotBeOverriddenByChild(t *testing.T) {
	parent, child, leaf := uuid.New(), uuid.New(), uuid.New()
	parents := map[uuid.UUID]*uuid.UUID{child: &parent, leaf: &child}
	for _, role := range []string{"member", "owner"} {
		s := map[uuid.UUID]Snapshot{
			parent: {Member: true, Role: "member", Base: actionSet([]string{ChannelView}), Private: true},
			child:  {Member: true, Role: role, Base: actionSet(AllActions), UserGrant: actionSet(AllActions)},
			leaf:   {Member: true, Role: role, Base: actionSet(AllActions)},
		}
		applyParentVisibility(s, parents)
		for _, id := range []uuid.UUID{child, leaf} {
			if s[id].Allows(ChannelView) || s[id].Allows(MessageWrite) {
				t.Fatalf("%s child bypassed hidden ancestor", role)
			}
		}
	}
}

func TestAncestorVisibilityAuthorizedAndCorruptChains(t *testing.T) {
	parent, child := uuid.New(), uuid.New()
	for _, tc := range []struct {
		name    string
		parents map[uuid.UUID]*uuid.UUID
		want    bool
	}{
		{"visible", map[uuid.UUID]*uuid.UUID{child: &parent}, true},
		{"missing", map[uuid.UUID]*uuid.UUID{child: func() *uuid.UUID { id := uuid.New(); return &id }()}, false},
		{"cycle", map[uuid.UUID]*uuid.UUID{child: &parent, parent: &child}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := map[uuid.UUID]Snapshot{
				parent: {Member: true, Role: "owner", Base: actionSet(AllActions)},
				child:  {Member: true, Role: "owner", Base: actionSet(AllActions)},
			}
			applyParentVisibility(s, tc.parents)
			if s[child].Allows(ChannelView) != tc.want {
				t.Fatalf("child view = %v, want %v", s[child].Allows(ChannelView), tc.want)
			}
		})
	}
}
