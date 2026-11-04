package spec

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// testRecipe is a well-formed recipe every mutation test starts from. It
// returns a fresh value on each call, so a test may change any field.
func testRecipe() Recipe {
	return Recipe{
		Schema:            RecipeSchema,
		ID:                "tst-r1",
		StrategyID:        StrategyCrowdedShortBreakout,
		Entry:             EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshNewBreakout, Fill: EntryFillNextOpenTraded},
		Exits:             []ExitRule{{Kind: ExitClosePivot, Sessions: 1}, {Kind: ExitTimeStop, Sessions: 20}},
		Sizing:            Sizing{WeightPct: 10, MaxPositions: 10, CapacityPctDV20: 5, Rank: RankScoreDescCodeAsc},
		Costs:             testCosts(),
		Capital:           100000,
		Cash:              CashRBARate,
		Returns:           ReturnsTotal,
		Benchmark:         BenchmarkXJT,
		Reference:         ReferenceCrowdedShorts,
		Delisting:         DelistingExitLast,
		WindowStart:       "2019-05-01",
		Fundamentals:      FundamentalsStrict,
		CooldownSessions:  10,
		StaleExitSessions: 20,
	}
}

func testCosts() Costs {
	return Costs{
		BrokerageBps:    10,
		BrokerageMinAUD: 10,
		SpreadTiers: []SpreadTier{
			{MinDV20AUD: 20000000, Bps: 5},
			{MinDV20AUD: 5000000, Bps: 10},
			{MinDV20AUD: 1000000, Bps: 25},
			{MinDV20AUD: 250000, Bps: 50},
			{MinDV20AUD: 0, Bps: 75},
		},
		Multiplier: 1,
	}
}

func TestRecipeValidAcceptsWellFormed(t *testing.T) {
	if err := testRecipe().Validate(); err != nil {
		t.Fatalf("well-formed recipe refused: %v", err)
	}

	flat := testRecipe()
	flat.Costs = Costs{BrokerageBps: 10, BrokerageMinAUD: 10, FlatSlippageBps: ptrFloat(5), Multiplier: 1}
	if err := flat.Validate(); err != nil {
		t.Fatalf("flat-slippage sensitivity refused: %v", err)
	}

	stale := testRecipe()
	stale.WindowStart = WindowComputableFrom
	stale.Entry.MaxAbovePivotPct = ptrFloat(5)
	stale.Exits = []ExitRule{{Kind: ExitStopLoss, Pct: 8}, {Kind: ExitCloseBelowSMA, SMA: 200, Sessions: 5}, {Kind: ExitStatusFalls, Statuses: []string{statusWatch, statusNone}, Sessions: 5}}
	if err := stale.Validate(); err != nil {
		t.Fatalf("fundamentals-window recipe refused: %v", err)
	}
}

func TestRecipeValidationRefusesEachBrokenField(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Recipe)
		want   string
	}{
		{"schema", func(r *Recipe) { r.Schema = 2 }, "schema 2"},
		{"id", func(r *Recipe) { r.ID = "csb" }, "is not <name>-r<n>"},
		{"strategy", func(r *Recipe) { r.StrategyID = "nope" }, "not a canonical strategy"},
		{"entry on", func(r *Recipe) { r.Entry.On = "on_close" }, "entry.on"},
		{"entry fresh", func(r *Recipe) { r.Entry.Fresh = "sometime" }, "entry.fresh"},
		{"entry fill", func(r *Recipe) { r.Entry.Fill = "next_close" }, "entry.fill"},
		{"entry max above pivot", func(r *Recipe) { r.Entry.MaxAbovePivotPct = ptrFloat(0) }, "max_above_pivot_pct"},
		{"no exits", func(r *Recipe) { r.Exits = nil }, "no exits"},
		{"unknown exit kind", func(r *Recipe) { r.Exits = []ExitRule{{Kind: "trail"}} }, "unknown kind"},
		{"time stop without sessions", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitTimeStop}} }, "time_stop needs sessions"},
		{"stop loss pct", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitStopLoss, Pct: 100}} }, "stop_loss pct"},
		{"stop loss with sessions", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitStopLoss, Pct: 8, Sessions: 2}} }, "stop_loss takes no sessions"},
		{"sma length", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitCloseBelowSMA, SMA: 100}} }, "close_below_sma sma"},
		{"status value", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitStatusFalls, Statuses: []string{"setup"}}} }, "want watch or none"},
		{"status empty", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitStatusFalls}} }, "needs statuses"},
		{"pct on a pivot exit", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitClosePivot, Pct: 8}} }, "pct is set"},
		{"sma on a time stop", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitTimeStop, Sessions: 3, SMA: 50}} }, "sma is set"},
		{"negative consecutive sessions", func(r *Recipe) { r.Exits = []ExitRule{{Kind: ExitClosePivot, Sessions: -1}} }, "sessions -1"},
		{"weight exposure", func(r *Recipe) { r.Sizing.WeightPct = 20 }, "exceeds 100%"},
		{"no positions", func(r *Recipe) { r.Sizing.MaxPositions = 0 }, "max_positions"},
		{"capacity", func(r *Recipe) { r.Sizing.CapacityPctDV20 = 0 }, "capacity_pct_dv20"},
		{"rank", func(r *Recipe) { r.Sizing.Rank = "random" }, "sizing.rank"},
		{"no spread tiers", func(r *Recipe) { r.Costs.SpreadTiers = nil }, "no spread tiers"},
		{"tiers not descending", func(r *Recipe) {
			r.Costs.SpreadTiers = []SpreadTier{{MinDV20AUD: 1000000, Bps: 25}, {MinDV20AUD: 5000000, Bps: 10}, {MinDV20AUD: 0, Bps: 75}}
		}, "fall strictly"},
		{"tiers without catch-all", func(r *Recipe) {
			r.Costs.SpreadTiers = []SpreadTier{{MinDV20AUD: 20000000, Bps: 5}, {MinDV20AUD: 250000, Bps: 75}}
		}, "start at 0"},
		{"negative tier bps", func(r *Recipe) {
			r.Costs.SpreadTiers = []SpreadTier{{MinDV20AUD: 20000000, Bps: 5}, {MinDV20AUD: 0, Bps: -1}}
		}, "want zero or more"},
		{"flat with tiers", func(r *Recipe) { r.Costs.FlatSlippageBps = ptrFloat(5) }, "must then be empty"},
		{"negative flat", func(r *Recipe) { r.Costs = Costs{FlatSlippageBps: ptrFloat(-5), Multiplier: 1} }, "flat_slippage_bps"},
		{"brokerage", func(r *Recipe) { r.Costs.BrokerageBps = -1 }, "brokerage_bps"},
		{"brokerage minimum", func(r *Recipe) { r.Costs.BrokerageMinAUD = -1 }, "brokerage_min_aud"},
		{"multiplier", func(r *Recipe) { r.Costs.Multiplier = 0 }, "multiplier"},
		{"cooldown", func(r *Recipe) { r.CooldownSessions = -1 }, "cooldown_sessions"},
		{"stale exit", func(r *Recipe) { r.StaleExitSessions = 0 }, "stale_exit_sessions"},
		{"capital", func(r *Recipe) { r.Capital = 0 }, "capital"},
		{"cash", func(r *Recipe) { r.Cash = "zero" }, "cash"},
		{"returns", func(r *Recipe) { r.Returns = "price" }, "returns"},
		{"benchmark", func(r *Recipe) { r.Benchmark = "ASX200" }, "benchmark"},
		{"reference", func(r *Recipe) { r.Reference = "all" }, "reference"},
		{"delisting", func(r *Recipe) { r.Delisting = "ignore" }, "delisting"},
		{"window start", func(r *Recipe) { r.WindowStart = "2019-13-01" }, "neither a date nor computable_from"},
		{"fundamentals", func(r *Recipe) { r.Fundamentals = "loose" }, "fundamentals"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := testRecipe()
			tc.mutate(&r)
			err := r.Validate()
			if err == nil {
				t.Fatalf("recipe with a broken %s was accepted", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not name %q", err, tc.want)
			}
		})
	}
}

func TestRecipeHashFollowsEveryField(t *testing.T) {
	base, err := RecipeHash(testRecipe())
	if err != nil {
		t.Fatal(err)
	}
	if len(base) != 64 {
		t.Fatalf("recipe hash %q is not 64 hex characters", base)
	}
	again, err := RecipeHash(testRecipe())
	if err != nil {
		t.Fatal(err)
	}
	if again != base {
		t.Fatalf("recipe hash is not stable: %s then %s", base, again)
	}
	changed := testRecipe()
	changed.Exits[1].Sessions = 21
	other, err := RecipeHash(changed)
	if err != nil {
		t.Fatal(err)
	}
	if other == base {
		t.Fatal("changing a time stop did not change the recipe hash")
	}
}

// TestRecipeHashesArePinned holds the recipe hash of every r1 recipe to the
// golden file. A change to a recipe value or to the Recipe layout changes its
// hash, and the golden moves only with a new recipe id.
func TestRecipeHashesArePinned(t *testing.T) {
	want := readGolden(t, filepath.Join("testdata", "recipe_hashes.golden"))
	var got []string
	for _, r := range R1Recipes() {
		if err := r.Validate(); err != nil {
			t.Fatalf("%s: %v", r.ID, err)
		}
		h, err := RecipeHash(r)
		if err != nil {
			t.Fatalf("%s: hash: %v", r.ID, err)
		}
		got = append(got, fmt.Sprintf("%s %s %s", r.StrategyID, r.ID, h))
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("recipe hashes do not match testdata/recipe_hashes.golden.\ncomputed:\n%s\ngolden:\n%s",
			strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestR1RecipesCoverEveryStrategyOnce holds the r1 set to the canonical
// strategies: one recipe each, every one well formed.
func TestR1RecipesCoverEveryStrategyOnce(t *testing.T) {
	seen := map[string]string{}
	for _, r := range R1Recipes() {
		if err := r.Validate(); err != nil {
			t.Errorf("%s: %v", r.ID, err)
		}
		if prev, dup := seen[r.StrategyID]; dup {
			t.Errorf("strategy %s has two r1 recipes: %s and %s", r.StrategyID, prev, r.ID)
		}
		seen[r.StrategyID] = r.ID
	}
	for _, id := range strategyOrder {
		if _, ok := seen[id]; !ok {
			t.Errorf("strategy %s has no r1 recipe", id)
		}
	}
}

// TestR1ExitsMatchTheScreen states the exits, entries and windows of the five
// r1 recipes as the recipe table gives them (5.3). In particular Zanger has no
// time stop.
func TestR1ExitsMatchTheScreen(t *testing.T) {
	want := map[string]struct {
		fresh    string
		maxAbove *float64
		exits    []ExitRule
		cooldown int
		window   string
	}{
		RecipeCrowdedShortR1: {EntryFreshNewBreakout, ptrFloat(10), []ExitRule{{Kind: ExitClosePivot, Sessions: 1}, {Kind: ExitTimeStop, Sessions: 20}}, 10, "2019-05-01"},
		RecipeMinerviniR1:    {EntryFreshAny, nil, []ExitRule{{Kind: ExitStopLoss, Pct: 8}, {Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1}, {Kind: ExitStatusFalls, Statuses: []string{"watch", "none"}, Sessions: 1}}, 10, "2019-05-01"},
		RecipeZangerR1:       {EntryFreshNewBreakout, ptrFloat(5), []ExitRule{{Kind: ExitClosePivot, Sessions: 1}, {Kind: ExitStopLoss, Pct: 8}, {Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1}}, 10, WindowComputableFrom},
		RecipeCANSLIMR1:      {EntryFreshAny, nil, []ExitRule{{Kind: ExitStopLoss, Pct: 8}, {Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1}, {Kind: ExitStatusFalls, Statuses: []string{"watch", "none"}, Sessions: 1}}, 10, WindowComputableFrom},
		RecipeQualityR1:      {EntryFreshAny, nil, []ExitRule{{Kind: ExitCloseBelowSMA, SMA: 200, Sessions: 5}, {Kind: ExitStatusFalls, Statuses: []string{"watch", "none"}, Sessions: 5}}, 20, WindowComputableFrom},
	}
	got := R1Recipes()
	if len(got) != len(want) {
		t.Fatalf("r1 set has %d recipes, want %d", len(got), len(want))
	}
	for _, r := range got {
		w, ok := want[r.ID]
		if !ok {
			t.Errorf("unexpected recipe %s", r.ID)
			continue
		}
		if r.Entry.On != EntryOnBecomesTriggered || r.Entry.Fill != EntryFillNextOpenTraded {
			t.Errorf("%s: entry %+v, want becomes_triggered filled at the next traded open", r.ID, r.Entry)
		}
		if r.Entry.Fresh != w.fresh {
			t.Errorf("%s: fresh %q, want %q", r.ID, r.Entry.Fresh, w.fresh)
		}
		if (r.Entry.MaxAbovePivotPct == nil) != (w.maxAbove == nil) ||
			(w.maxAbove != nil && *r.Entry.MaxAbovePivotPct != *w.maxAbove) {
			t.Errorf("%s: max above pivot %v, want %v", r.ID, r.Entry.MaxAbovePivotPct, w.maxAbove)
		}
		if fmt.Sprint(r.Exits) != fmt.Sprint(w.exits) {
			t.Errorf("%s: exits %+v, want %+v", r.ID, r.Exits, w.exits)
		}
		if r.CooldownSessions != w.cooldown {
			t.Errorf("%s: cooldown %d, want %d", r.ID, r.CooldownSessions, w.cooldown)
		}
		if r.WindowStart != w.window {
			t.Errorf("%s: window start %q, want %q", r.ID, r.WindowStart, w.window)
		}
		if r.Sizing.WeightPct != 10 || r.Sizing.MaxPositions != 10 || r.Sizing.CapacityPctDV20 != 5 {
			t.Errorf("%s: sizing %+v, want 10%% x 10 positions, capacity 5%% of DV20", r.ID, r.Sizing)
		}
		if r.Costs.FlatSlippageBps != nil {
			t.Errorf("%s: the house model must not use flat slippage", r.ID)
		}
	}
}
