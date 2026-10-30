package main

import (
	"fmt"
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

// A passing warm check re-opens REA for one probe. The streak and the backoff are kept, so one more
// block doubles the cooldown as before, and the reopened state survives a save.
func TestReopenProbeKeepsStreakAndBackoff(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	cb := newPersistentCircuitBreaker(1, 5*time.Minute, time.Hour, path, circuitT0)
	cb.record("rea", true, circuitT0)
	cb.record("rea", true, circuitT0.Add(time.Second)) // consec 2, backoff 10m, open
	if open, _ := cb.skip("rea", circuitT0.Add(2*time.Second)); !open {
		t.Fatalf("setup: REA must be open before the warm check")
	}

	cb.reopenProbe("rea")
	if open, _ := cb.skip("rea", circuitT0.Add(2*time.Second)); open {
		t.Fatalf("after a passing warm check REA must be probeable")
	}
	if sc := cb.circuit("rea"); sc.consec != 2 || sc.backoff != 10*time.Minute {
		t.Fatalf("reopen must keep the streak and backoff, got consec=%d backoff=%s", sc.consec, sc.backoff)
	}

	reloaded := newPersistentCircuitBreaker(1, 5*time.Minute, time.Hour, path, circuitT0.Add(2*time.Second))
	if open, _ := reloaded.skip("rea", circuitT0.Add(2*time.Second)); open {
		t.Fatalf("the reopened probe must persist to the next child")
	}

	opened, cool := cb.record("rea", true, circuitT0.Add(3*time.Second))
	if !opened || cb.circuit("rea").backoff != 20*time.Minute || cool <= 0 {
		t.Fatalf("one more block after the probe must double to 20m, got opened=%v backoff=%s", opened, cb.circuit("rea").backoff)
	}
}

// Both sources open and not yet due: the warm check is skipped. Only one open: it runs.
func TestWarmBlockedOnlyWhenBothSourcesAreOpen(t *testing.T) {
	captureLog(t)
	sources := []string{"rea", "domain"}

	both := newCircuitBreaker(1, 15*time.Minute, time.Hour)
	both.record("rea", true, circuitT0)
	both.record("domain", true, circuitT0)
	if !warmBlockedByCircuit(both, sources, circuitT0.Add(time.Minute)) {
		t.Fatalf("both sources open and not due must skip the warm check")
	}
	if warmBlockedByCircuit(both, sources, circuitT0.Add(time.Hour)) {
		t.Fatalf("once the cooldowns have passed the warm check must run")
	}

	one := newCircuitBreaker(1, 15*time.Minute, time.Hour)
	one.record("rea", true, circuitT0)
	one.record("domain", false, circuitT0)
	if warmBlockedByCircuit(one, sources, circuitT0.Add(time.Minute)) {
		t.Fatalf("with REA open but Domain closed the warm check must still run (it re-opens REA)")
	}
}

// A future-dated entry is not trusted, and a cooldown past the cap plus jitter is clamped.
func TestCircuitStateClampsLoadedValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "circuit-state.json")
	const ceiling = time.Hour
	now := circuitT0
	body := `{"version":1,"sources":{` +
		`"domain":{"consec":2,"open_until":"` + now.Add(10*time.Hour).Format(time.RFC3339) + `","backoff_ns":` + fmt.Sprint(int64(ceiling)) + `,"updated":"` + now.Format(time.RFC3339) + `"},` +
		`"rea":{"consec":1,"open_until":"` + now.Add(time.Minute).Format(time.RFC3339) + `","backoff_ns":1,"updated":"` + now.Add(time.Hour).Format(time.RFC3339) + `"}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	captureLog(t)
	cb := newPersistentCircuitBreaker(2, 5*time.Minute, ceiling, path, now)
	horizon := now.Add(ceiling + ceiling/5)
	if d := cb.circuit("domain"); !d.openUntil.Equal(horizon) {
		t.Fatalf("openUntil must clamp to now+1.2x cap (%s), got %s", horizon, d.openUntil)
	}
	if _, ok := cb.circuits["rea"]; ok {
		if cb.circuit("rea").consec != 0 {
			t.Fatalf("a future-dated entry must not be carried over")
		}
	}
}

// A temp file left by a crashed save is removed on load once it is a minute old. A fresh one, which a
// live writer may still be using, is left alone.
func TestCircuitStateRemovesOnlyStaleTemps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "circuit-state.json")
	stale := filepath.Join(dir, ".circuit-state.json.123456.tmp")
	fresh := filepath.Join(dir, ".circuit-state.json.654321.tmp")
	for _, p := range []string{stale, fresh} {
		if err := os.WriteFile(p, []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-5 * time.Minute)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	newPersistentCircuitBreaker(1, time.Minute, time.Hour, path, time.Now())
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("a stale temp must be removed on load")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a fresh temp must be left alone: %v", err)
	}
}

// A dry run never touches the circuit file: its path is empty, and a breaker built on that path
// writes nothing.
func TestDryRunNeverTouchesTheCircuitFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(circuitStateEnv, filepath.Join(dir, "circuit-state.json"))
	if got := circuitPathForRun(true); got != "" {
		t.Fatalf("a dry run must get no state path, got %q", got)
	}
	if got := circuitPathForRun(false); got == "" {
		t.Fatalf("a real run must get the state path")
	}
	cb := newPersistentCircuitBreaker(1, time.Minute, time.Hour, circuitPathForRun(true), circuitT0)
	cb.record("domain", true, circuitT0)
	cb.reopenProbe("domain")
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("a dry run wrote %d file(s) into the state directory", len(entries))
	}
}

// isolateCircuitState gives one test its own circuit file, so no round it drives shares state with
// another test. The package-wide scratch path in TestMain is only the fallback.
func isolateCircuitState(t *testing.T) {
	t.Helper()
	t.Setenv(circuitStateEnv, filepath.Join(t.TempDir(), "circuit-state.json"))
}
