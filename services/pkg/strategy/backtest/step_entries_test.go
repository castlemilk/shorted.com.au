package backtest

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// scheduledCodes are the codes queued to fill at the next open, in queue order.
func scheduledCodes(st *State) []string {
	out := make([]string, 0, len(st.entries))
	for _, e := range st.entries {
		out = append(out, e.code)
	}
	return out
}

// cancelledFor is the cancellation reason of the entry order on code, or "".
func cancelledFor(st *State, code string) string {
	for _, e := range st.Events() {
		if e.Code == code && e.Kind == EventEntryCancelled {
			return e.Reason
		}
	}
	return ""
}

// TestEntriesRankByScoreThenCodeUpToTheSlots: candidates queue best score first,
// ties broken by code ascending, and only as many as the free slots.
func TestEntriesRankByScoreThenCodeUpToTheSlots(t *testing.T) {
	cfg := testConfig()
	cfg.MaxPositions = 3
	st := NewState(cfg)
	scores := map[string]float64{"AAA": 1, "BBB": 3, "CCC": 2, "DDD": 3, "EEE": 0.5}
	codes := []string{"AAA", "BBB", "CCC", "DDD", "EEE"}
	setup := make([]CodeSession, 0, len(codes))
	triggered := make([]CodeSession, 0, len(codes))
	for _, code := range codes {
		setup = append(setup, codeAt(code, "setup", mkBar(10, 10)))
		c := codeAt(code, statusTriggered, mkBar(10, 10))
		c.Score = scores[code]
		triggered = append(triggered, c)
	}
	Step(st, sessionAt(0, setup...))
	Step(st, sessionAt(1, triggered...))
	want := []string{"BBB", "DDD", "CCC"}
	got := scheduledCodes(st)
	if len(got) != len(want) {
		t.Fatalf("scheduled %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("scheduled %v, want %v", got, want)
		}
	}
}

// TestAQueuedExitFreesItsSlotOnThatClose: a position whose exit is queued at a
// close no longer holds its slot, so a candidate on the same close takes it.
// The exit's proceeds then fund the entry at the next open: exits fill before
// entries. Entries filled first would leave BBB without the cash.
func TestAQueuedExitFreesItsSlotOnThatClose(t *testing.T) {
	cfg := testConfig()
	cfg.Capital = 1000
	cfg.WeightPct = 100
	cfg.MaxPositions = 1
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("AAA not held after its entry session")
	}
	// Session 3: AAA closes below its pivot, so its exit is queued, and BBB
	// triggers on the same close. The slot AAA held is free for BBB.
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(9, 9)), codeAt("BBB", statusTriggered, mkBar(10, 10))))
	if got := scheduledCodes(st); len(got) != 1 || got[0] != "BBB" {
		t.Fatalf("scheduled %v on the exit's close, want [BBB]", got)
	}
	// Session 4: the exit fills at the open, then BBB's entry fills from the
	// proceeds.
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(9, 9)), codeAt("BBB", statusTriggered, mkBar(10, 10))))
	if _, ok := st.positions["BBB"]; !ok {
		t.Fatalf("BBB not filled from the exit's proceeds; cancelled %q", cancelledFor(st, "BBB"))
	}
	if r := cancelledFor(st, "BBB"); r != "" {
		t.Fatalf("BBB cancelled %q although the exit funds it", r)
	}
}

// TestTheHigherScoreFillsFirstAndTheRestAreCancelledForCash: with the whole
// equity sized to each entry, the better score takes the cash and the other is
// cancelled for cash at the same open.
func TestTheHigherScoreFillsFirstAndTheRestAreCancelledForCash(t *testing.T) {
	cfg := testConfig()
	cfg.WeightPct = 100
	st := NewState(cfg)
	bbb := codeAt("BBB", statusTriggered, mkBar(10, 10))
	bbb.Score = 2
	aaa := codeAt("AAA", statusTriggered, mkBar(10, 10))
	aaa.Score = 1
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, aaa, bbb))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10)), codeAt("BBB", statusTriggered, mkBar(10, 10))))
	if _, ok := st.positions["BBB"]; !ok {
		t.Fatal("the higher score did not fill")
	}
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("the lower score filled with no cash left")
	}
	if r := cancelledFor(st, "AAA"); r != CancelCash {
		t.Fatalf("AAA cancellation = %q, want %q", r, CancelCash)
	}
}

// TestConfigOfCarriesTheRecipe: a recipe's sizing, costs, exits and fresh rule
// reach the simulator unchanged, and a change to the copy does not reach the
// recipe.
func TestConfigOfCarriesTheRecipe(t *testing.T) {
	r := spec.R1Recipes()[0]
	cfg := ConfigOf(r)
	if cfg.Capital != r.Capital || cfg.WeightPct != r.Sizing.WeightPct || cfg.MaxPositions != r.Sizing.MaxPositions {
		t.Fatalf("sizing not carried: %+v", cfg)
	}
	if !cfg.NewBreakoutOnly {
		t.Fatal("csb-r1 is a fresh new-breakout recipe")
	}
	if cfg.MaxAbovePivotPct == nil || *cfg.MaxAbovePivotPct != 10 {
		t.Fatalf("max above pivot = %v, want 10", cfg.MaxAbovePivotPct)
	}
	if len(cfg.ExitRules) != len(r.Exits) || cfg.ExitRules[0].Kind != spec.ExitClosePivot {
		t.Fatalf("exits not carried: %+v", cfg.ExitRules)
	}
	cfg.ExitRules[0].Sessions = 99
	*cfg.MaxAbovePivotPct = 1
	if r.Exits[0].Sessions == 99 || *r.Entry.MaxAbovePivotPct == 1 {
		t.Fatal("the config shares storage with the recipe")
	}
	near(t, "house fee", feeFor(cfg.Costs, 10000, 1e9), 10+5, 1e-9)

	// The cost model is copied too: a tier edited in place, or the flat slippage
	// changed through its pointer, leaves the recipe and its hash as they were.
	flat := 5.0
	r.Costs.FlatSlippageBps = &flat
	before, err := spec.RecipeHash(r)
	if err != nil {
		t.Fatal(err)
	}
	cfg = ConfigOf(r)
	cfg.Costs.SpreadTiers[0].Bps = 99
	*cfg.Costs.FlatSlippageBps = 99
	if r.Costs.SpreadTiers[0].Bps == 99 || *r.Costs.FlatSlippageBps == 99 {
		t.Fatal("the config's cost model shares storage with the recipe")
	}
	after, err := spec.RecipeHash(r)
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("recipe hash changed from %s to %s after editing the copy", before, after)
	}
	r.Costs.SpreadTiers = nil
	if ConfigOf(r).Costs.SpreadTiers != nil {
		t.Fatal("a nil spread tier list must stay nil")
	}
}
