package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The breaker's three numbers and the state file's shape are the contract these tests pin.
var circuitT0 = time.Date(2026, 10, 30, 19, 30, 0, 0, time.UTC)

// A breaker that opened for Domain, saved, then loaded by a fresh breaker, reads the same streak,
// the same open window and the same backoff.
func TestCircuitStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "circuit-state.json")
	cb := newPersistentCircuitBreaker(2, 5*time.Minute, time.Hour, path, circuitT0)
	cb.record("domain", true, circuitT0)
	opened, cool := cb.record("domain", true, circuitT0.Add(time.Second))
	if !opened || cool <= 0 {
		t.Fatalf("the trip-th block must open the circuit, got opened=%v cool=%s", opened, cool)
	}
	want := *cb.circuit("domain")

	got := newPersistentCircuitBreaker(2, 5*time.Minute, time.Hour, path, circuitT0.Add(time.Second))
	sc := got.circuit("domain")
	if sc.consec != want.consec || sc.backoff != want.backoff || !sc.openUntil.Equal(want.openUntil) {
		t.Fatalf("round trip lost state: got consec=%d backoff=%s openUntil=%s, want consec=%d backoff=%s openUntil=%s",
			sc.consec, sc.backoff, sc.openUntil, want.consec, want.backoff, want.openUntil)
	}
	if open, _ := got.skip("domain", circuitT0.Add(time.Second)); !open {
		t.Fatalf("a circuit open at save time must still be open after the reload")
	}
}

// A clean sweep closes the circuit on disk too, so the next child starts with no backoff.
func TestCircuitStateCleanSweepIsSaved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	cb := newPersistentCircuitBreaker(1, time.Minute, time.Hour, path, circuitT0)
	cb.record("rea", true, circuitT0)
	cb.record("rea", false, circuitT0.Add(time.Minute))
	got := newPersistentCircuitBreaker(1, time.Minute, time.Hour, path, circuitT0.Add(2*time.Minute))
	if sc := got.circuit("rea"); sc.consec != 0 || sc.backoff != 0 || !sc.openUntil.IsZero() {
		t.Fatalf("a clean sweep must reach the file: %+v", *sc)
	}
}

// An entry whose open window and last update are both older than the cap is expired: the next
// child starts that source at the base cooldown, not at the streak it left behind.
func TestCircuitStateExpiresAfterTheCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	const ceiling = time.Hour
	cb := newPersistentCircuitBreaker(1, 5*time.Minute, ceiling, path, circuitT0)
	cb.record("domain", true, circuitT0)
	cb.record("domain", true, circuitT0.Add(time.Minute)) // backoff doubles, openUntil ~ +10m

	late := circuitT0.Add(ceiling + 20*time.Minute) // well past openUntil + cap
	got := newPersistentCircuitBreaker(1, 5*time.Minute, ceiling, path, late)
	if sc := got.circuit("domain"); sc.consec != 0 || sc.backoff != 0 || !sc.openUntil.IsZero() {
		t.Fatalf("an expired entry must be dropped, got %+v", *sc)
	}
	opened, cool := got.record("domain", true, late)
	if !opened || cool > 6*time.Minute {
		t.Fatalf("after expiry the next trip restarts at the base (about 5m), got opened=%v cool=%s", opened, cool)
	}
}

// An entry still inside the cap is carried over, even when its open window has passed.
func TestCircuitStateKeepsRecentEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	cb := newPersistentCircuitBreaker(1, 5*time.Minute, time.Hour, path, circuitT0)
	cb.record("domain", true, circuitT0) // openUntil ~ +5m
	got := newPersistentCircuitBreaker(1, 5*time.Minute, time.Hour, path, circuitT0.Add(20*time.Minute))
	if sc := got.circuit("domain"); sc.backoff != 5*time.Minute {
		t.Fatalf("a recent entry keeps its backoff for the next doubling, got %s", sc.backoff)
	}
}

// A corrupt file is logged and the breaker starts every source closed. It never fails the round.
func TestCircuitStateCorruptFileStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	buf := captureLog(t)
	cb := newPersistentCircuitBreaker(2, 5*time.Minute, time.Hour, path, circuitT0)
	if open, _ := cb.skip("domain", circuitT0); open {
		t.Fatalf("a corrupt file must not open any circuit")
	}
	if !strings.Contains(buf.String(), "unreadable") {
		t.Fatalf("the corrupt file must be logged, got %q", buf.String())
	}
	// The next save replaces the corrupt file with a valid one.
	cb.record("domain", true, circuitT0)
	if _, err := readCircuitState(path); err != nil {
		t.Fatalf("the save after a corrupt start must write a valid file: %v", err)
	}
}

// An unknown version is treated as unreadable, the same as a corrupt file.
func TestCircuitStateUnknownVersionStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	if err := os.WriteFile(path, []byte(`{"version":99,"sources":{"domain":{"consec":5}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	captureLog(t)
	cb := newPersistentCircuitBreaker(2, 5*time.Minute, time.Hour, path, circuitT0)
	if sc := cb.circuit("domain"); sc.consec != 0 {
		t.Fatalf("an unknown version must not be read, got consec=%d", sc.consec)
	}
}

// The file is 0600 and no temp file is left beside it.
func TestCircuitStateFileModeAndNoTempLeft(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "circuit-state.json")
	cb := newPersistentCircuitBreaker(1, time.Minute, time.Hour, path, circuitT0)
	cb.record("domain", true, circuitT0)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %o, want 0600", fi.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("a save must leave only the state file, found %d entries", len(entries))
	}
}

// Two child rounds: the first trips Domain at the base, the second (after the cooldown, inside the
// cap) re-opens it and the backoff doubles. The breaker is rebuilt from disk between them, the way
// a fresh -mode agent process does.
func TestCircuitBackoffDoublesAcrossChildRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	const base, ceiling = 5 * time.Minute, time.Hour

	child1 := newPersistentCircuitBreaker(2, base, ceiling, path, circuitT0)
	child1.record("domain", true, circuitT0)
	child1.record("domain", true, circuitT0.Add(time.Second))
	if b := child1.circuit("domain").backoff; b != base {
		t.Fatalf("first trip backoff = %s, want %s", b, base)
	}

	later := circuitT0.Add(10 * time.Minute) // past the first cooldown, inside the cap
	child2 := newPersistentCircuitBreaker(2, base, ceiling, path, later)
	opened, _ := child2.record("domain", true, later)
	if !opened {
		t.Fatalf("a re-probe blocked again must re-open the circuit")
	}
	if b := child2.circuit("domain").backoff; b != 2*base {
		t.Fatalf("re-open backoff = %s, want %s (doubled across the child boundary)", b, 2*base)
	}

	child3 := newPersistentCircuitBreaker(2, base, ceiling, path, later.Add(time.Minute))
	if b := child3.circuit("domain").backoff; b != 2*base {
		t.Fatalf("the doubled backoff must persist to the next child, got %s", b)
	}
}

// The dry-run and the memory-only breaker never write: an empty path touches no file.
func TestCircuitMemoryOnlyWritesNothing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(circuitStateEnv, filepath.Join(dir, "circuit-state.json"))
	cb := newCircuitBreaker(1, time.Minute, time.Hour)
	cb.record("domain", true, circuitT0)
	if _, err := os.Stat(filepath.Join(dir, "circuit-state.json")); err == nil {
		t.Fatalf("a breaker with no path must not write the state file")
	}
}

// A failed save is logged, and the breaker keeps the in-memory state for the round.
func TestCircuitSaveFailureIsNonFatal(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	buf := captureLog(t)
	cb := newPersistentCircuitBreaker(1, time.Minute, time.Hour, filepath.Join(blocker, "circuit-state.json"), circuitT0)
	opened, _ := cb.record("domain", true, circuitT0)
	if !opened {
		t.Fatalf("the in-memory breaker must still trip when the file cannot be written")
	}
	if !strings.Contains(buf.String(), "not saved") {
		t.Fatalf("the failed save must be logged, got %q", buf.String())
	}
}

// circuitStatePath honours the override, and otherwise sits beside the driver directory.
func TestCircuitStatePathDefault(t *testing.T) {
	t.Setenv(circuitStateEnv, "/tmp/override.json")
	if got := circuitStatePath(); got != "/tmp/override.json" {
		t.Fatalf("override = %q", got)
	}
	t.Setenv(circuitStateEnv, "")
	t.Setenv("HOME", "/Users/example")
	if got := circuitStatePath(); got != "/Users/example/.shorted-housing-crawl/circuit-state.json" {
		t.Fatalf("default = %q", got)
	}
}
