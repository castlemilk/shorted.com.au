package backtest

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// pagedSessions is a fixture that uses every part of the carried state: AAA
// enters from a triggered status and leaves on a time stop, BBB pays a cash
// dividend on an unadjusted ex-date while it is held, CCC is triggered and
// cancelled for cash, and DDD has a bar on only some sessions (a stale mark).
func pagedSessions() []Session {
	var out []Session
	for i := 0; i < 40; i++ {
		aaa := codeAt("AAA", "setup", mkBar(10, 10))
		if i >= 1 && i <= 2 {
			aaa = codeAt("AAA", statusTriggered, mkBar(10+float64(i)*0.1, 10+float64(i)*0.1))
		}
		bbb := codeAt("BBB", "watch", mkBar(20, 20+float64(i%3)*0.05))
		if i == 3 {
			bbb = codeAt("BBB", statusTriggered, mkBar(20, 20))
		}
		if i == 10 {
			bbb.Dividend = 0.5
			bbb.Bar.AdjClose = bbb.Bar.Close
		}
		ccc := codeAt("CCC", "watch", mkBar(5, 5))
		if i == 2 {
			ccc = codeAt("CCC", statusTriggered, mkBar(5, 5))
		}
		ddd := codeAt("DDD", "watch", mkBar(7, 7))
		if i%4 == 0 {
			ddd.Bar = nil
		}
		s := sessionAt(i, aaa, bbb, ccc, ddd)
		s.CashRate = 0.0435
		out = append(out, s)
	}
	return out
}

func pagedConfig() Config {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitTimeStop, Sessions: 6}}
	cfg.StaleExitSessions = 3
	cfg.MaxPositions = 2
	return cfg
}

func TestCheckpointRestoreStepsLikeTheUninterruptedRun(t *testing.T) {
	cfg := pagedConfig()
	sessions := pagedSessions()

	batch := NewState(cfg)
	for _, s := range sessions {
		Step(batch, s)
	}

	// The same sessions, one run at a time: each step starts from a checkpoint
	// written by the step before, the way the paper track's daily runs do.
	var records []Record
	var closed []Trade
	var events []Event
	st := NewState(cfg)
	for _, s := range sessions {
		Step(st, s)
		records = append(records, st.Records()...)
		closed = append(closed, st.Closed()...)
		events = append(events, st.Events()...)
		raw, err := st.Checkpoint()
		if err != nil {
			t.Fatalf("checkpoint %s: %v", s.Date, err)
		}
		if st, err = RestoreState(cfg, raw); err != nil {
			t.Fatalf("restore %s: %v", s.Date, err)
		}
	}

	if !reflect.DeepEqual(records, batch.Records()) {
		t.Fatal("records differ between the restored run and the uninterrupted run")
	}
	if !reflect.DeepEqual(closed, batch.trades) {
		t.Fatal("closed trades differ between the restored run and the uninterrupted run")
	}
	if !reflect.DeepEqual(events, batch.Events()) {
		t.Fatal("events differ between the restored run and the uninterrupted run")
	}
	want, err := batch.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("the final checkpoint differs from the uninterrupted run's")
	}
	if len(closed) == 0 {
		t.Fatal("the fixture closed no trade: it does not exercise the exit path")
	}
}

func TestCheckpointIsAFunctionOfTheState(t *testing.T) {
	cfg := pagedConfig()
	st := NewState(cfg)
	for _, s := range pagedSessions()[:12] {
		Step(st, s)
	}
	a, err := st.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatal("two checkpoints of one state differ: map order leaks into the bytes")
	}
}

func TestRestoreRefusesAnUnknownLayout(t *testing.T) {
	raw, err := NewState(testConfig()).Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	bumped := strings.Replace(string(raw), `"version":1`, `"version":2`, 1)
	if _, err := RestoreState(testConfig(), []byte(bumped)); err == nil || !strings.Contains(err.Error(), "version 2") {
		t.Fatalf("restore of version 2 = %v, want a version error", err)
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("checkpoint is not JSON: %v", err)
	}
}

func TestLedgerAccessorsFollowTheLifecycle(t *testing.T) {
	cfg := testConfig()
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	pending := st.PendingEntries()
	if len(pending) != 1 || pending[0].Code != "AAA" || pending[0].SignalDate != dayAt(1) {
		t.Fatalf("pending entries = %+v, want AAA signalled on session 1", pending)
	}
	if len(st.Holdings()) != 0 {
		t.Fatal("nothing is held before the fill")
	}
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if len(st.PendingEntries()) != 0 {
		t.Fatal("the entry is no longer pending once it fills")
	}
	h := st.Holdings()
	if len(h) != 1 || h[0].ExitPending || h[0].EntryDate != dayAt(2) || h[0].Quantity <= 0 {
		t.Fatalf("holdings = %+v, want one open AAA filled on session 2", h)
	}
	if h[0].SignalDate != dayAt(1) || h[0].Pivot != 10 {
		t.Fatalf("holding lost its signal: %+v", h[0])
	}
}

// TestCheckpointCarriesEverySimulatorField fails when the simulator's state gains
// a field the checkpoint does not decide about. Every field of the state types is
// either carried by the checkpoint (Checkpoint writes it and RestoreState reads
// it) or named here as an output or configuration that a restore takes from
// elsewhere. A new field must be added to one list, so a field the paper track
// would silently lose across runs cannot appear unnoticed.
func TestCheckpointCarriesEverySimulatorField(t *testing.T) {
	carried := map[string][]string{
		"State":        {"cash", "lastEquity", "peak", "lastIndex", "dividendsDue", "codes", "positions", "exits", "entries"},
		"perCode":      {"mult", "prev", "hasPrev", "lastRaw", "lastPL", "lastPLDate", "prevStatus", "hasPrevStatus", "lastExitIdx", "hasExit", "caKnownIdx", "hasCA", "traded"},
		"position":     {"code", "signalDate", "breakout", "entryDate", "entryIdx", "entryRaw", "entryPL", "qty", "pivot", "score", "dv20", "entryFee", "dividends", "missing", "ruleCount", "flags", "marks"},
		"pendingEntry": {"code", "score", "pivot", "dv20", "signalDate", "breakout", "lag"},
		"pendingExit":  {"code", "reason", "signalDate", "dv20"},
		"mark":         {"date", "raw", "pl"},
	}
	// Not carried: the configuration (the caller supplies it with the recipe) and
	// the outputs the paper track writes out from each step (trades, events and
	// records).
	notCarried := map[string][]string{
		"State": {"cfg", "trades", "events", "records"},
	}
	types := map[string]reflect.Type{
		"State":        reflect.TypeOf(State{}),
		"perCode":      reflect.TypeOf(perCode{}),
		"position":     reflect.TypeOf(position{}),
		"pendingEntry": reflect.TypeOf(pendingEntry{}),
		"pendingExit":  reflect.TypeOf(pendingExit{}),
		"mark":         reflect.TypeOf(mark{}),
	}
	for name, typ := range types {
		want := map[string]bool{}
		for _, f := range carried[name] {
			want[f] = true
		}
		for _, f := range notCarried[name] {
			want[f] = true
		}
		got := map[string]bool{}
		for i := 0; i < typ.NumField(); i++ {
			got[typ.Field(i).Name] = true
		}
		for f := range got {
			if !want[f] {
				t.Errorf("%s gained field %q: the checkpoint must carry it (Checkpoint and RestoreState) or list it as not carried", name, f)
			}
		}
		for f := range want {
			if !got[f] {
				t.Errorf("%s lists field %q, which it no longer has", name, f)
			}
		}
	}
}
