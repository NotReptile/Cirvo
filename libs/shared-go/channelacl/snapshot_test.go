package channelacl

import "testing"

func TestSnapshotLayerPrecedence(t *testing.T) {
	s := Snapshot{Member: true, Role: roleMember, Base: actionSet([]string{"message.write", "channel.view"}),
		CategoryDeny: actionSet([]string{"message.write"}), ChannelGrant: actionSet([]string{"message.write"})}
	if !s.Allows(MessageWrite) {
		t.Fatal("channel grant must override category deny")
	}
	s.UserDeny = actionSet([]string{"message.write"})
	if s.Allows(MessageWrite) {
		t.Fatal("user deny must override every grant")
	}
	s.UserDeny = nil
	s.ChannelDeny = actionSet([]string{"message.write"})
	s.UserGrant = actionSet([]string{"message.write"})
	if !s.Allows(MessageWrite) {
		t.Fatal("user grant must override role deny")
	}
	s.UserDeny = actionSet([]string{"message.write"})
	if s.Allows(MessageWrite) {
		t.Fatal("same-layer deny must win")
	}
}

func TestSnapshotVisibility(t *testing.T) {
	s := Snapshot{Member: true, Role: roleMember, Base: actionSet([]string{"channel.view"})}
	if !s.Allows(ChannelView) {
		t.Fatal("public base view")
	}
	s.ChannelDeny = actionSet([]string{"channel.view"})
	if s.Allows(ChannelView) {
		t.Fatal("public view deny must hide the channel")
	}
	s.ChannelDeny = nil
	s.Private = true
	if s.Allows(ChannelView) {
		t.Fatal("base must not expose a private channel")
	}
	s.CategoryGrant = actionSet([]string{"channel.view"})
	if !s.Allows(ChannelView) {
		t.Fatal("category grant must expose a private channel")
	}
	s.CategoryGrant = nil
	s.ExplicitMember = true
	if !s.Allows(ChannelView) {
		t.Fatal("explicit member must see private channel")
	}
	s.UserDeny = actionSet([]string{"channel.view"})
	if s.Allows(ChannelView) {
		t.Fatal("explicit membership cannot bypass a user deny")
	}
	s.Role = roleOwner
	if !s.Allows(ChannelView) {
		t.Fatal("owner cannot be locked out")
	}
	s.Member = false
	if s.Allows(ChannelView) {
		t.Fatal("nonmember has no capability")
	}
}
