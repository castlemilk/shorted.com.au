package main

// crawl_portal_events_test.go pins the portal event (per-source circuit state) and the round phase.
// Every test is hermetic: the circuit file is per test (isolateCircuitState), the lock is per test, and
// the listings fixture dir stands in for Chrome, so no test touches a real browser.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// portalEventsOf returns the portal events in raw NDJSON, in order.
func portalEventsOf(t *testing.T, raw string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("event line is not JSON: %v: %s", err, line)
		}
		if m["event"] == "portal" {
			out = append(out, m)
		}
	}
	return out
}

// portalBySource indexes portal events by source, and fails on a duplicate.
func portalBySource(t *testing.T, evs []map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, e := range evs {
		src, _ := e["source"].(string)
		if _, dup := out[src]; dup {
			t.Fatalf("source %q reported twice: %v", src, evs)
		}
		out[src] = e
	}
	return out
}

// runAgentWithEvents runs runAgent against the stubs, with its events on a file this test reads back.
// dryRun is set after the stubs, which default to a real run.
func runAgentWithEvents(t *testing.T, dryRun bool) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv(crawlLockDirEnv, filepath.Join(t.TempDir(), "lockdir"))
	t.Setenv("CRAWL_LISTINGS_FIXTURE_DIR", t.TempDir())

	cl := &stubCallLog{}
	ingest := serveStubIngest(t, &stubIngest{log: cl})
	bb := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bb.Close)
	ctl := httptest.NewServer(&stubControl{secret: "ctl", ttl: time.Hour})
	t.Cleanup(ctl.Close)
	stubAgentEnv(t, ingest.URL, bb.URL, ctl, "ctl")
	t.Setenv("CRAWL_DRY_RUN", strconv.FormatBool(dryRun))

	path := filepath.Join(t.TempDir(), "events.ndjson")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	// The agent owns its own descriptor for the events stream, so hand it a duplicate of this file.
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(crawlEventsFDEnv, strconv.Itoa(fd))

	if got := runAgent(context.Background(), nil); got != 0 {
		t.Fatalf("runAgent = %d, want 0", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// A freshly started agent reports both sources, and the persisted domain circuit is open with its
// streak, backoff and open_until. The rea source, never blocked, is closed and carries no open_until.
func TestPortalEventsAtChildStartReflectPersistedState(t *testing.T) {
	isolateCircuitState(t)
	t.Setenv("CRAWL_CIRCUIT_MAX_S", "3600")
	openUntil := time.Now().UTC().Add(20 * time.Minute).Truncate(time.Second)
	state := map[string]*sourceCircuit{
		"domain": {consec: 3, openUntil: openUntil, backoff: 10 * time.Minute, updated: time.Now().UTC()},
	}
	if err := writeCircuitState(circuitStatePath(), state); err != nil {
		t.Fatal(err)
	}

	by := portalBySource(t, portalEventsOf(t, runAgentWithEvents(t, false)))
	if len(by) != 2 {
		t.Fatalf("portal events for %v, want rea and domain", by)
	}

	rea := by["rea"]
	if rea["state"] != "closed" || rea["consecutive_blocked"] != float64(0) || rea["backoff_s"] != float64(0) {
		t.Fatalf("rea at start = %v, want closed with no streak or backoff", rea)
	}
	if _, has := rea["open_until"]; has {
		t.Fatalf("a closed circuit must omit open_until: %v", rea)
	}

	dom := by["domain"]
	if dom["state"] != "open" || dom["consecutive_blocked"] != float64(3) || dom["backoff_s"] != float64(600) {
		t.Fatalf("domain at start = %v, want open with streak 3 and backoff 600s", dom)
	}
	if dom["open_until"] != openUntil.Format(time.RFC3339) {
		t.Fatalf("domain open_until = %v, want %s", dom["open_until"], openUntil.Format(time.RFC3339))
	}
}

// A dry run reports too: its circuit is memory-only, so both sources start closed.
func TestPortalEventsEmittedOnDryRun(t *testing.T) {
	isolateCircuitState(t)
	by := portalBySource(t, portalEventsOf(t, runAgentWithEvents(t, true)))
	if len(by) != 2 {
		t.Fatalf("a dry run must still report both sources, got %v", by)
	}
	for src, e := range by {
		if e["state"] != "closed" {
			t.Fatalf("dry-run %s = %v, want closed (the dry run never reads the circuit file)", src, e)
		}
	}
	if _, err := os.Stat(circuitStatePath()); err == nil {
		t.Fatal("a dry run wrote the circuit state file")
	}
}

// Open, re-open with a doubled backoff, and close each produce one event; a clean sweep on a closed
// circuit produces none; a source that never blocked produces none. Closed omits open_until.
func TestPortalEventOnOpenReopenAndClose(t *testing.T) {
	var buf lockedBuf
	cb := newCircuitBreaker(1, time.Minute, time.Hour)
	cb.events = newCrawlEvents(&buf)
	t0 := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)

	opened, cd := cb.record("domain", true, t0)
	if !opened {
		t.Fatal("the first block at trip 1 must open the circuit")
	}
	evs := portalEventsOf(t, buf.String())
	if len(evs) != 1 {
		t.Fatalf("open: portal events = %d, want 1: %s", len(evs), buf.String())
	}
	open := evs[0]
	if open["source"] != "domain" || open["state"] != "open" || open["consecutive_blocked"] != float64(1) || open["backoff_s"] != float64(60) {
		t.Fatalf("open event = %v", open)
	}
	if open["open_until"] != t0.Add(cd).Format(time.RFC3339) {
		t.Fatalf("open_until = %v, want the cooldown end %s", open["open_until"], t0.Add(cd).Format(time.RFC3339))
	}

	// The cooldown ends, the probe is blocked again: the circuit re-opens with the backoff doubled.
	t1 := t0.Add(cd + time.Second)
	if opened, _ := cb.record("domain", true, t1); !opened {
		t.Fatal("a blocked probe must re-open the circuit")
	}
	evs = portalEventsOf(t, buf.String())
	if len(evs) != 2 {
		t.Fatalf("re-open: portal events = %d, want 2", len(evs))
	}
	if evs[1]["state"] != "open" || evs[1]["backoff_s"] != float64(120) || evs[1]["consecutive_blocked"] != float64(2) {
		t.Fatalf("re-open event = %v, want open with backoff 120s and streak 2", evs[1])
	}

	// A clean sweep closes it: state closed, no backoff, no open_until.
	cb.record("domain", false, t1.Add(time.Hour))
	evs = portalEventsOf(t, buf.String())
	if len(evs) != 3 {
		t.Fatalf("close: portal events = %d, want 3", len(evs))
	}
	closed := evs[2]
	if closed["state"] != "closed" || closed["backoff_s"] != float64(0) || closed["consecutive_blocked"] != float64(0) {
		t.Fatalf("close event = %v", closed)
	}
	if _, has := closed["open_until"]; has {
		t.Fatalf("a closed circuit must omit open_until: %v", closed)
	}

	// Clean again, and the rea source never blocked: neither reports anything.
	cb.record("domain", false, t1.Add(2*time.Hour))
	cb.record("rea", false, t1)
	if n := len(portalEventsOf(t, buf.String())); n != 3 {
		t.Fatalf("a clean sweep on a closed circuit reported: %d events, want 3", n)
	}
}

// A block below the trip threshold changes no circuit state, so it reports nothing.
func TestPortalEventNotWrittenBelowTheTrip(t *testing.T) {
	var buf lockedBuf
	cb := newCircuitBreaker(2, time.Minute, time.Hour)
	cb.events = newCrawlEvents(&buf)
	cb.record("rea", true, time.Now())
	if n := len(portalEventsOf(t, buf.String())); n != 0 {
		t.Fatalf("one block below trip 2 reported %d events", n)
	}
}

// A probe allowed through after a warm check closes the reported open circuit, so the portal stream
// stops saying open once the probe is allowed.
func TestPortalEventOnReopenProbeCloses(t *testing.T) {
	var buf lockedBuf
	cb := newCircuitBreaker(1, time.Hour, 2*time.Hour)
	cb.events = newCrawlEvents(&buf)
	t0 := time.Now().UTC()
	cb.record("rea", true, t0)
	cb.reopenProbe("rea")
	evs := portalEventsOf(t, buf.String())
	if len(evs) != 2 || evs[1]["state"] != "closed" {
		t.Fatalf("events = %v, want an open then a closed for rea", evs)
	}
}

// The start-up report names each source once, reflecting the loaded state. A source with no state
// is closed.
func TestAnnounceAllReportsEachSourceOnce(t *testing.T) {
	var buf lockedBuf
	cb := newCircuitBreaker(1, time.Minute, time.Hour)
	now := time.Now().UTC()
	cb.circuits["domain"] = &sourceCircuit{consec: 1, openUntil: now.Add(time.Minute), backoff: time.Minute}
	cb.events = newCrawlEvents(&buf)
	cb.announceAll([]string{"rea", "domain"}, now)
	by := portalBySource(t, portalEventsOf(t, buf.String()))
	if by["rea"]["state"] != "closed" || by["domain"]["state"] != "open" {
		t.Fatalf("announceAll = %v", by)
	}
}

// The field values stay in the contract's bounds and sets, whatever the breaker holds. A portal
// event names only its source, state and numbers, never a suburb, URL or job ID.
func TestPortalFieldsStayInBounds(t *testing.T) {
	var buf lockedBuf
	ev := newCrawlEvents(&buf)
	ev.portal("domain", true, time.Now().Add(time.Hour), 5000, 48*time.Hour)
	ev.portal("rea", false, time.Time{}, -4, -time.Second)
	ev.portal("Hinchinbrook Heights", true, time.Now(), 1, time.Minute) // dropped: not a portal
	ev.portal("rea", true, time.Now().Add(time.Hour), 1, time.Minute)

	allowed := map[string]bool{"event": true, "ts": true, "source": true, "state": true,
		"consecutive_blocked": true, "backoff_s": true, "open_until": true}
	evs := portalEventsOf(t, buf.String())
	if len(evs) != 3 {
		t.Fatalf("portal events = %d, want 3 (one source name is outside the enum): %s", len(evs), buf.String())
	}
	for _, e := range evs {
		for k := range e {
			if !allowed[k] {
				t.Fatalf("portal carries %q, which the contract does not name: %v", k, e)
			}
		}
		if s := e["source"]; s != "rea" && s != "domain" {
			t.Fatalf("source = %v, want rea or domain", s)
		}
		if st := e["state"]; st != "open" && st != "closed" {
			t.Fatalf("state = %v, want open or closed", st)
		}
		if n := e["consecutive_blocked"].(float64); n < 0 || n > 1000 {
			t.Fatalf("consecutive_blocked = %v outside 0..1000", n)
		}
		if b := e["backoff_s"].(float64); b < 0 || b > 86400 {
			t.Fatalf("backoff_s = %v outside 0..86400", b)
		}
		_, hasUntil := e["open_until"]
		if hasUntil != (e["state"] == "open") {
			t.Fatalf("open_until must be present exactly when state is open: %v", e)
		}
	}
	if evs[0]["consecutive_blocked"] != float64(1000) || evs[0]["backoff_s"] != float64(86400) {
		t.Fatalf("the clamps did not apply: %v", evs[0])
	}
	if evs[1]["consecutive_blocked"] != float64(0) || evs[1]["backoff_s"] != float64(0) {
		t.Fatalf("negative values must clamp to 0: %v", evs[1])
	}
	if until, _ := evs[0]["open_until"].(string); !strings.HasSuffix(until, "Z") || strings.Contains(until, ".") {
		t.Fatalf("open_until = %q, want RFC 3339 UTC with seconds precision", until)
	}
}

// The cycle parent forwards a child's portal event with type, cycle_id and round added.
func TestCycleForwardsPortalWithRound(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Portal: true, Exit: 0}})
	h.runGuarded(20 * time.Second)
	var got []map[string]any
	for _, e := range h.events() {
		if e["type"] == "portal" {
			got = append(got, e)
		}
	}
	if len(got) != 2 {
		t.Fatalf("forwarded portal events = %d, want 2: %v", len(got), h.events())
	}
	for _, e := range got {
		if e["round"] != float64(1) || e["cycle_id"] != "cyc-test" {
			t.Fatalf("forwarded portal lacks round 1 or the cycle id: %v", e)
		}
	}
}

// Every round starts with the round phase, written just before its round_start, so the in-flight
// phase reads round while the child crawls.
func TestRoundPhaseAtEachRoundStart(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0},
		{Claims: 0, Exit: 0},
	})
	h.runGuarded(20 * time.Second)
	evs := h.events()
	starts := 0
	for i, e := range evs {
		if e["type"] != "round_start" {
			continue
		}
		starts++
		if i == 0 || evs[i-1]["type"] != "phase" || evs[i-1]["name"] != "round" {
			t.Fatalf("round_start at %d is not preceded by the round phase: %v", i, evs)
		}
	}
	if starts != 2 {
		t.Fatalf("round_start events = %d, want 2", starts)
	}
}
