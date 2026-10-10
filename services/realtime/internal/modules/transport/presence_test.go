package transport

import "testing"

func TestConnectivityPreservesManualModesAndInvisiblePrivacy(t *testing.T) {
	for _, tc := range []struct {
		mode                 string
		connected            bool
		wantMode, wantCustom string
	}{
		{"online", true, "online", "working"}, {"idle", true, "idle", "working"},
		{"dnd", true, "dnd", "working"}, {"invisible", true, "offline", ""},
		{"dnd", false, "offline", "working"}, {"invisible", false, "offline", ""},
	} {
		mode, custom := visiblePresence(tc.mode, "working", tc.connected)
		if mode != tc.wantMode || custom != tc.wantCustom {
			t.Fatalf("%s connected=%v: %s/%s", tc.mode, tc.connected, mode, custom)
		}
	}
}
