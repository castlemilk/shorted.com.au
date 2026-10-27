package main

// golden_events_test.go pins EVERY contract event's fields against the design doc, not only the
// summary. Four scenarios emit every event type the contract names. For each type, the test checks
// that the doc's events row names each field, that every emitted instance carries only the fields
// the contract names (plus the common ones), that each instance carries the required fields, and that
// each optional field appears in some instance. The doc is the source; a drift in either the code or
// the doc fails here.

import (
	"encoding/json"
	"strings"
	"syscall"
	"testing"
	"time"
)

// contractEventFields is the contract's field list for each event type. Common to every event:
// type, ts, cycle_id; a forwarded child event also carries round and may keep the legacy event key.
var contractEventFields = map[string]struct{ required, optional []string }{
	"cycle_start":  {required: []string{"job", "dry_run", "collector"}},
	"phase":        {required: []string{"name"}, optional: []string{"until"}},
	"preflight":    {required: []string{"lock", "env", "ingest"}},
	"round_start":  {required: []string{"round", "pid", "pgid"}},
	"round_done":   {required: []string{"round", "exit_code", "counts"}},
	"ingest_ok":    {required: []string{"probe"}, optional: []string{"job_id", "source", "applied", "replayed", "quarantined"}},
	"ingest_error": {required: []string{"probe", "code"}},
	"cycle_done":   {required: []string{"outcome", "exit_code"}},
	"startup":      {required: []string{"step", "stage"}, optional: []string{"outcome"}},
}

// contractEventRow is the doc's events-table row for typ.
func contractEventRow(section, typ string) string {
	for _, line := range strings.Split(section, "\n") {
		if strings.HasPrefix(line, "| `"+typ+"`") {
			return line
		}
	}
	return ""
}

// collectContractEvents runs the scenarios that together emit every contract event type, and returns
// the emitted events by type.
func collectContractEvents(t *testing.T) map[string][]map[string]any {
	t.Helper()
	out := map[string][]map[string]any{}
	add := func(h *cycleHarness) {
		for _, e := range h.events() {
			typ, _ := e["type"].(string)
			out[typ] = append(out[typ], e)
		}
	}

	// A drain: preflight, the probe, a re-warm with its cooldown, pushes, a push error, and a start-up.
	h := newCycleHarness(t, []fakeStep{
		{Claims: 1, Processed: 1, Succeeded: 1, Pushed: 2, Quarantined: 1, PushFailed: 1, Startup: true, Exit: 3},
		{Claims: 0, Exit: 0},
	})
	h.cfg.rewarmCooldown = time.Millisecond
	h.runGuarded(20 * time.Second)
	add(h)

	// A refused probe: ingest_error with probe true.
	h = newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.probeCode, h.probeWord = 13, "unauthenticated"
	h.runGuarded(20 * time.Second)
	add(h)

	// A repair: its phases, and a forced install.
	h = newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobRepair
	h.runGuarded(20 * time.Second)
	add(h)

	// A stop by signal: the stopping phase.
	h = newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "exit10"}})
	h.cfg.hungAfter = 10 * time.Minute
	h.signalAfterStart(syscall.SIGTERM, 100*time.Millisecond, 1)
	h.runGuarded(20 * time.Second)
	add(h)
	return out
}

func TestEveryEventTypeIsPinnedAgainstTheDoc(t *testing.T) {
	section := contractSection(t)
	events := collectContractEvents(t)
	common := map[string]bool{"type": true, "ts": true, "cycle_id": true, "round": true, "event": true}

	for typ, spec := range contractEventFields {
		row := contractEventRow(section, typ)
		if row == "" {
			t.Fatalf("the contract has no events row for %s", typ)
		}
		insts := events[typ]
		if len(insts) == 0 {
			t.Fatalf("the scenarios emitted no %s event", typ)
		}
		allowed := map[string]bool{}
		for _, f := range append(append([]string{}, spec.required...), spec.optional...) {
			allowed[f] = true
			if !strings.Contains(row, "`"+f) {
				t.Fatalf("the contract's %s row does not name the field %q", typ, f)
			}
		}
		for _, inst := range insts {
			for k := range inst {
				if !common[k] && !allowed[k] {
					t.Fatalf("%s emitted %q, which the contract does not name (instance %v)", typ, k, inst)
				}
			}
			for _, f := range spec.required {
				if _, ok := inst[f]; !ok {
					t.Fatalf("%s is missing its required field %q (instance %v)", typ, f, inst)
				}
			}
		}
		for _, f := range spec.optional {
			seen := false
			for _, inst := range insts {
				if _, ok := inst[f]; ok {
					seen = true
				}
			}
			if !seen {
				t.Fatalf("no %s event carried the optional field %q: the scenarios do not cover it", typ, f)
			}
		}
	}
}

// The startup outcome follows the contract per step: a warm probe's outcome is warm, cold, unusable or
// env_broken; a ProbeAuth's is ok or an ingest code word; outcome is present only on stage done.
func TestStartupOutcomeFollowsTheContractPerStep(t *testing.T) {
	row := contractEventRow(contractSection(t), "startup")
	for _, w := range []string{"warm", "cold", "unusable", "env_broken"} {
		if !strings.Contains(row, w) {
			t.Fatalf("the contract's startup row does not name the warm word %q", w)
		}
	}
	var buf lockedBuf
	ev := newCrawlEvents(&buf)
	ev.startup("warm_probe", "start", "warm")
	ev.startup("warm_probe", "done", warmProbeOutcome(0))
	ev.startup("warm_probe", "done", warmProbeOutcome(5))
	ev.startup("warm_probe", "done", warmProbeOutcome(4))
	ev.startup("warm_probe", "done", warmProbeOutcome(8))
	ev.startup("warm_probe", "done", warmProbeOutcome(99))
	ev.startup("probe_auth", "done", "unauthenticated")
	ev.startup("probe_auth", "start", "ok")
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	want := []string{"", "warm", "cold", "unusable", "env_broken", "unusable", "unauthenticated", ""}
	if len(lines) != len(want) {
		t.Fatalf("startup events = %d, want %d: %q", len(lines), len(want), buf.String())
	}
	for i, line := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line %d is not JSON: %v", i, err)
		}
		got, has := m["outcome"].(string)
		if want[i] == "" {
			if has {
				t.Fatalf("line %d carries outcome %q, but a start event or an unset outcome must not", i, got)
			}
			continue
		}
		if !has || got != want[i] {
			t.Fatalf("line %d outcome = %q (present %v), want %q", i, got, has, want[i])
		}
	}
}

// The events the cycle writes carry type, ts and cycle_id; the contract says every event does.
func TestEveryCycleEventCarriesTypeTsAndCycleID(t *testing.T) {
	for typ, insts := range collectContractEvents(t) {
		for _, inst := range insts {
			for _, k := range []string{"type", "ts", "cycle_id"} {
				if _, ok := inst[k]; !ok {
					t.Fatalf("%s is missing %s", typ, k)
				}
			}
		}
	}
}
