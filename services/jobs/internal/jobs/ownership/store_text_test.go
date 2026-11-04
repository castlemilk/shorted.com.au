package ownership

import "testing"

// A notice's detail is stored as valid UTF-8, whatever its text layer carried:
// recording an outcome once failed with "invalid byte sequence for encoding UTF8:
// 0xff" (execution shorted-ownership-q64kz, 2026-11-04), and the notice was then
// re-selected on every run.
func TestTruncateStoresValidUTF8OnARuneBoundary(t *testing.T) {
	t.Parallel()
	if got := truncate("ab\xffcd", 10); got != "abcd" {
		t.Fatalf("invalid byte kept: %q", got)
	}
	// "é" is two bytes: a cut inside it lands before it.
	if got := truncate("aé", 2); got != "a" {
		t.Fatalf("rune split: %q", got)
	}
	if got := truncate("aé", 3); got != "aé" {
		t.Fatalf("whole rune cut: %q", got)
	}
	if got := truncate("short", 500); got != "short" {
		t.Fatalf("short text changed: %q", got)
	}
}
