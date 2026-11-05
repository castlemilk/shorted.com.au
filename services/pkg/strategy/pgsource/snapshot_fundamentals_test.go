package pgsource

import (
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// A re-fetch that changes only the provenance timestamps writes the same blob:
// the snapshot keeps one fundamentals body per figures, so an unchanged stock
// costs no new row (4.9).
func TestEncodeFundamentalsIgnoresProvenanceTimestamps(t *testing.T) {
	first := time.Date(2026, 11, 1, 3, 0, 0, 0, time.UTC)
	second := time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC)
	a := &engine.Growth{FetchedAt: &first}
	b := &engine.Growth{FetchedAt: &second}

	fa, err := EncodeFundamentals(a, nil)
	if err != nil {
		t.Fatal(err)
	}
	fb, err := EncodeFundamentals(b, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fa.Hash != fb.Hash {
		t.Fatalf("provenance-only change moved the hash: %s vs %s", fa.Hash, fb.Hash)
	}
	if string(fa.Blob) != string(fb.Blob) {
		t.Fatalf("the blob bytes must be identical for identical figures")
	}
}
