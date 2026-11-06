package profile

import (
	"encoding/json"
	"testing"
)

func TestAutoIdleFor(t *testing.T) {
	cases := []struct {
		name      string
		mode      string
		automatic bool
		want      bool
	}{
		{name: "automatic idle is marked", mode: "idle", automatic: true, want: true},
		{name: "manual idle is not marked", mode: "idle", automatic: false, want: false},
		{name: "automatic online clears the mark", mode: "online", automatic: true, want: false},
		{name: "manual online clears the mark", mode: "online", automatic: false, want: false},
		{name: "manual dnd clears the mark", mode: "dnd", automatic: false, want: false},
		{name: "automatic flag never marks other modes", mode: "dnd", automatic: true, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := autoIdleFor(tc.mode, tc.automatic); got != tc.want {
				t.Fatalf("autoIdleFor(%q, %v) = %v, want %v", tc.mode, tc.automatic, got, tc.want)
			}
		})
	}
}

func TestStatusRequestDecodesAutomatic(t *testing.T) {
	var req statusRequest
	if err := json.Unmarshal([]byte(`{"mode":"idle","automatic":true,"expectedMode":"online"}`), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !req.Automatic || req.Mode == nil || *req.Mode != "idle" {
		t.Fatalf("unexpected request: %+v", req)
	}

	var manual statusRequest
	if err := json.Unmarshal([]byte(`{"mode":"idle"}`), &manual); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if manual.Automatic {
		t.Fatalf("manual request must not be automatic")
	}
}

func TestMeViewExposesAutoIdle(t *testing.T) {
	raw, err := json.Marshal(meView{AutoIdle: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["autoIdle"] != true {
		t.Fatalf("autoIdle missing from JSON: %s", raw)
	}
}
