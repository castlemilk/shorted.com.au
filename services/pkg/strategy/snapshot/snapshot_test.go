package snapshot

import (
	"encoding/json"
	"testing"
)

// The stored feature object's keys are read by the snapshot writer and by any
// reader of the stored rows, so they are pinned.
func TestFeaturesKeysAreTheStoredNames(t *testing.T) {
	raw, err := json.Marshal(Features{})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := []string{"bar", "ex_div", "fs1", "sf0", "sf1"}
	if len(got) != len(want) {
		t.Fatalf("features keys = %v, want exactly %v", keysOf(got), want)
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("features has no %q key; keys = %v", k, keysOf(got))
		}
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
