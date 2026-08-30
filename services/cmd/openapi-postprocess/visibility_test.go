package main

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
)

// The substantive assertions about what counts as public now live in
// services/pkg/protovisibility. What remains worth testing here is that the
// post-processor actually consults that shared answer rather than a stale copy
// of its own — the whole point of the move.
func TestPublicMethodPathsDelegatesToSharedPackage(t *testing.T) {
	got := PublicMethodPaths()
	want := protovisibility.PublicMethodPaths()

	if len(got) == 0 {
		t.Fatal("no public methods found — are the generated proto packages imported?")
	}
	if len(got) != len(want) {
		t.Fatalf("PublicMethodPaths returned %d paths, shared package says %d", len(got), len(want))
	}
	for p := range want {
		if !got[p] {
			t.Errorf("missing path %q", p)
		}
	}
}
