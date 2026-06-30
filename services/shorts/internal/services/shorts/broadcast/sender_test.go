package broadcast

import "testing"

func TestChunk(t *testing.T) {
	got := chunk(250, 100)
	if len(got) != 3 || got[0] != 100 || got[2] != 50 {
		t.Fatalf("unexpected chunks: %v", got)
	}
}
