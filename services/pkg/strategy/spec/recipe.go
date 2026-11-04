package spec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// A recipe says how a backtest trades a version's signals: when it enters,
// when it exits, how much it buys and what each trade costs. It is hashed
// apart from the rules, so the same rules can be traded two ways, and every
// backtest run names both hashes. The r1 recipes are the values the product
// publishes; once a recipe is registered its values and this layout are
// frozen, and a change is a new recipe id.

// RecipeSchema is the layout of Recipe. A change to the layout bumps it, which
// changes every recipe hash.
const RecipeSchema = 1

// The values the backtest engine implements. Validate refuses any other value,
// so a recipe can name only behaviour that exists.
const (
	EntryOnBecomesTriggered = "becomes_triggered"
	EntryFreshNewBreakout   = "new_breakout_date"
	EntryFreshAny           = "any"
	EntryFillNextOpenTraded = "next_open_traded"

	ExitClosePivot    = "close_below_captured_pivot"
	ExitTimeStop      = "time_stop"
	ExitStopLoss      = "stop_loss"
	ExitCloseBelowSMA = "close_below_sma"
	ExitStatusFalls   = "status_falls_to"

	RankScoreDescCodeAsc = "score_desc_code_asc"

	CashRBARate        = "rba_cash_rate"
	ReturnsTotal       = "total"
	BenchmarkXJT       = "XJT"
	DelistingExitLast  = "exit_last_close"
	FundamentalsStrict = "strict"
	FundamentalsApprox = "approx_period_end_plus_2m"

	ReferenceCrowdedShorts  = "liquid_crowded_shorts_ew"
	ReferenceLiquidOrdinary = "liquid_ordinary_ew"

	// WindowComputableFrom is the window start of a fundamentals strategy. The
	// backtest job derives the date (the first session its fundamentals are
	// strict-computable), so the recipe names the rule rather than a date.
	WindowComputableFrom = "computable_from"

	statusWatch = "watch"
	statusNone  = "none"

	// The recipe ids of the r1 recipes.
	RecipeCrowdedShortR1 = "csb-r1"
	RecipeMinerviniR1    = "mtt-r1"
	RecipeZangerR1       = "zb-r1"
	RecipeCANSLIMR1      = "cs-r1"
	RecipeQualityR1      = "qc-r1"
)

// Recipe is one execution recipe. Field order is the canonical encoding's
// field order, so reordering or renaming a field changes every recipe hash.
type Recipe struct {
	Schema            int        `json:"schema"`              // RecipeSchema
	ID                string     `json:"id"`                  // "csb-r1"
	StrategyID        string     `json:"strategy_id"`         // slug, one of the canonical strategies
	Entry             EntryRule  `json:"entry"`               // when and how a signal becomes a buy
	Exits             []ExitRule `json:"exits"`               // checked at each close in order; first hit wins
	Sizing            Sizing     `json:"sizing"`              // how much each position is and how many are held
	Costs             Costs      `json:"costs"`               // what each fill pays
	CooldownSessions  int        `json:"cooldown_sessions"`   // no re-entry for N sessions after an exit
	StaleExitSessions int        `json:"stale_exit_sessions"` // no bar for N sessions exits at the last close
	Capital           float64    `json:"capital"`             // starting capital in AUD
	Cash              string     `json:"cash"`                // "rba_cash_rate"
	Returns           string     `json:"returns"`             // "total"
	Benchmark         string     `json:"benchmark"`           // "XJT"
	Reference         string     `json:"reference"`           // "liquid_crowded_shorts_ew" | "liquid_ordinary_ew"
	Delisting         string     `json:"delisting"`           // "exit_last_close"
	WindowStart       string     `json:"window_start"`        // a date, or "computable_from"
	Fundamentals      string     `json:"fundamentals"`        // "strict" | "approx_period_end_plus_2m"
}

// EntryRule says when a signal buys.
type EntryRule struct {
	On               string   `json:"on"`                            // "becomes_triggered": triggered at t, not at t-1
	Fresh            string   `json:"fresh"`                         // "new_breakout_date" | "any"
	Fill             string   `json:"fill"`                          // "next_open_traded"
	MaxAbovePivotPct *float64 `json:"max_above_pivot_pct,omitempty"` // skip when the open is above pivot*(1+x/100)
}

// ExitRule is one exit. A rule that counts closes (Sessions) defaults to one
// consecutive close when Sessions is zero.
type ExitRule struct {
	Kind     string   `json:"kind"`               // close_below_captured_pivot | time_stop | stop_loss | close_below_sma | status_falls_to
	Sessions int      `json:"sessions,omitempty"` // time_stop: sessions after the entry session; others: consecutive closes
	Pct      float64  `json:"pct,omitempty"`      // stop_loss: exit when the close is at or below entry*(1-pct/100)
	SMA      int      `json:"sma,omitempty"`      // close_below_sma: 50 | 200
	Statuses []string `json:"statuses,omitempty"` // status_falls_to: a subset of ["watch", "none"]
}

// Sizing says how big each position is.
type Sizing struct {
	WeightPct       float64 `json:"weight_pct"`        // % of equity at the decision close
	MaxPositions    int     `json:"max_positions"`     // open positions at once
	CapacityPctDV20 float64 `json:"capacity_pct_dv20"` // notional at most this % of 20-session dollar volume at the decision close
	Rank            string  `json:"rank"`              // "score_desc_code_asc": the live rank
}

// Costs is what a fill pays.
type Costs struct {
	BrokerageBps    float64      `json:"brokerage_bps"`               // per side
	BrokerageMinAUD float64      `json:"brokerage_min_aud"`           // per fill
	SpreadTiers     []SpreadTier `json:"spread_tiers"`                // per side, by 20-session dollar volume at the decision close
	FlatSlippageBps *float64     `json:"flat_slippage_bps,omitempty"` // set: replaces the tiers (a sensitivity, never the house model)
	Multiplier      float64      `json:"multiplier"`                  // scales every cost; 1.0 for the house model
}

// SpreadTier is the spread and impact for volumes from MinDV20AUD up to the
// next tier's minimum.
type SpreadTier struct {
	MinDV20AUD float64 `json:"min_dv20_aud"`
	Bps        float64 `json:"bps"`
}

var recipeIDPattern = regexp.MustCompile(`^[a-z]+-r[1-9][0-9]*$`)

// Validate reports every way the recipe is not one the engine can run. A nil
// error means the recipe is well formed; it does not mean it is registered.
func (r Recipe) Validate() error {
	var problems []string
	add := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}
	if r.Schema != RecipeSchema {
		add("schema %d, want %d", r.Schema, RecipeSchema)
	}
	if !recipeIDPattern.MatchString(r.ID) {
		add("id %q is not <name>-r<n>", r.ID)
	}
	if !slices.Contains(strategyOrder, r.StrategyID) {
		add("strategy %q is not a canonical strategy", r.StrategyID)
	}
	validateEntry(r.Entry, add)
	validateExits(r.Exits, add)
	validateSizing(r.Sizing, add)
	validateCosts(r.Costs, add)
	if r.CooldownSessions < 0 {
		add("cooldown_sessions %d, want zero or more", r.CooldownSessions)
	}
	if r.StaleExitSessions < 1 {
		add("stale_exit_sessions %d, want at least 1", r.StaleExitSessions)
	}
	if !(r.Capital > 0) {
		add("capital %s, want above zero", FormatNumber(r.Capital))
	}
	if r.Cash != CashRBARate {
		add("cash %q, want %s", r.Cash, CashRBARate)
	}
	if r.Returns != ReturnsTotal {
		add("returns %q, want %s", r.Returns, ReturnsTotal)
	}
	if r.Benchmark != BenchmarkXJT {
		add("benchmark %q, want %s", r.Benchmark, BenchmarkXJT)
	}
	if r.Reference != ReferenceCrowdedShorts && r.Reference != ReferenceLiquidOrdinary {
		add("reference %q", r.Reference)
	}
	if r.Delisting != DelistingExitLast {
		add("delisting %q, want %s", r.Delisting, DelistingExitLast)
	}
	if r.WindowStart != WindowComputableFrom {
		if _, err := time.Parse("2006-01-02", r.WindowStart); err != nil {
			add("window_start %q is neither a date nor %s", r.WindowStart, WindowComputableFrom)
		}
	}
	if r.Fundamentals != FundamentalsStrict && r.Fundamentals != FundamentalsApprox {
		add("fundamentals %q", r.Fundamentals)
	}
	if len(problems) > 0 {
		return fmt.Errorf("recipe %q: %s", r.ID, strings.Join(problems, "; "))
	}
	return nil
}

func validateEntry(e EntryRule, add func(string, ...any)) {
	if e.On != EntryOnBecomesTriggered {
		add("entry.on %q, want %s", e.On, EntryOnBecomesTriggered)
	}
	if e.Fresh != EntryFreshNewBreakout && e.Fresh != EntryFreshAny {
		add("entry.fresh %q", e.Fresh)
	}
	if e.Fill != EntryFillNextOpenTraded {
		add("entry.fill %q, want %s", e.Fill, EntryFillNextOpenTraded)
	}
	if e.MaxAbovePivotPct != nil && !(*e.MaxAbovePivotPct > 0) {
		add("entry.max_above_pivot_pct %s, want above zero", FormatNumber(*e.MaxAbovePivotPct))
	}
}

func validateExits(exits []ExitRule, add func(string, ...any)) {
	if len(exits) == 0 {
		add("no exits")
		return
	}
	for i, x := range exits {
		if x.Kind != ExitStopLoss && x.Pct != 0 {
			add("exits[%d] pct is set on %s", i, x.Kind)
		}
		if x.Kind != ExitCloseBelowSMA && x.SMA != 0 {
			add("exits[%d] sma is set on %s", i, x.Kind)
		}
		if x.Kind != ExitStatusFalls && len(x.Statuses) != 0 {
			add("exits[%d] statuses are set on %s", i, x.Kind)
		}
		if x.Sessions < 0 {
			add("exits[%d] sessions %d, want zero or more", i, x.Sessions)
		}
		switch x.Kind {
		case ExitClosePivot:
		case ExitTimeStop:
			if x.Sessions < 1 {
				add("exits[%d] time_stop needs sessions of at least 1", i)
			}
		case ExitStopLoss:
			if x.Sessions != 0 {
				add("exits[%d] stop_loss takes no sessions", i)
			}
			if !(x.Pct > 0 && x.Pct < 100) {
				add("exits[%d] stop_loss pct %s, want between 0 and 100", i, FormatNumber(x.Pct))
			}
		case ExitCloseBelowSMA:
			if x.SMA != 50 && x.SMA != 200 {
				add("exits[%d] close_below_sma sma %d, want 50 or 200", i, x.SMA)
			}
		case ExitStatusFalls:
			if len(x.Statuses) == 0 {
				add("exits[%d] status_falls_to needs statuses", i)
			}
			for _, s := range x.Statuses {
				if s != statusWatch && s != statusNone {
					add("exits[%d] status %q, want watch or none", i, s)
				}
			}
		default:
			add("exits[%d] %q: unknown kind", i, x.Kind)
		}
	}
}

func validateSizing(s Sizing, add func(string, ...any)) {
	if !(s.WeightPct > 0 && s.WeightPct <= 100) {
		add("sizing.weight_pct %s, want above zero and at most 100", FormatNumber(s.WeightPct))
	}
	if s.MaxPositions < 1 {
		add("sizing.max_positions %d, want at least 1", s.MaxPositions)
	}
	if s.WeightPct*float64(s.MaxPositions) > 100 {
		add("sizing: weight_pct x max_positions exceeds 100%% of equity")
	}
	if !(s.CapacityPctDV20 > 0 && s.CapacityPctDV20 <= 100) {
		add("sizing.capacity_pct_dv20 %s, want above zero and at most 100", FormatNumber(s.CapacityPctDV20))
	}
	if s.Rank != RankScoreDescCodeAsc {
		add("sizing.rank %q, want %s", s.Rank, RankScoreDescCodeAsc)
	}
}

func validateCosts(c Costs, add func(string, ...any)) {
	if c.BrokerageBps < 0 {
		add("costs.brokerage_bps %s, want zero or more", FormatNumber(c.BrokerageBps))
	}
	if c.BrokerageMinAUD < 0 {
		add("costs.brokerage_min_aud %s, want zero or more", FormatNumber(c.BrokerageMinAUD))
	}
	if !(c.Multiplier > 0) {
		add("costs.multiplier %s, want above zero", FormatNumber(c.Multiplier))
	}
	if c.FlatSlippageBps != nil {
		if *c.FlatSlippageBps < 0 {
			add("costs.flat_slippage_bps %s, want zero or more", FormatNumber(*c.FlatSlippageBps))
		}
		if len(c.SpreadTiers) > 0 {
			add("flat slippage replaces the spread tiers, which must then be empty")
		}
		return
	}
	if len(c.SpreadTiers) == 0 {
		add("no spread tiers and no flat slippage")
		return
	}
	for i, t := range c.SpreadTiers {
		if t.Bps < 0 {
			add("spread tier %d bps %s, want zero or more", i, FormatNumber(t.Bps))
		}
		if i > 0 && t.MinDV20AUD >= c.SpreadTiers[i-1].MinDV20AUD {
			add("spread tiers must fall strictly by min_dv20_aud")
		}
	}
	if last := c.SpreadTiers[len(c.SpreadTiers)-1]; last.MinDV20AUD != 0 {
		add("the last spread tier must start at 0 so every volume has a tier")
	}
}

// RecipeCanonical is the canonical encoding of r: encoding/json over the struct
// as declared, the same rule as Canonical for a spec.
func RecipeCanonical(r Recipe) ([]byte, error) {
	return json.Marshal(r)
}

// RecipeHash is hex(sha256(RecipeCanonical(r))): 64 hex characters, stored as
// recipe_hash apart from rules_hash.
func RecipeHash(r Recipe) (string, error) {
	b, err := RecipeCanonical(r)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// ptrFloat returns a pointer to v, for the optional fields of a recipe.
func ptrFloat(v float64) *float64 { return &v }

// Shorted chose the r1 recipes to test each screen. They are not the authors'
// trading rules, and the recipe lines say so (RecipePreface).

// windowFromMay2019 is the first full month of XJT's total-return history, so
// every canonical comparison of a non-fundamentals strategy is total return.
const windowFromMay2019 = "2019-05-01"

// houseCosts is the house cost model (5.4): brokerage at 10 bps with a A$10
// minimum per fill, and spread and impact by 20-session dollar volume.
func houseCosts() Costs {
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

// r1Recipe is the part of an r1 recipe the five share: sizing, costs, the
// capital and the data policy. The entry, exits, cooldown and window differ.
func r1Recipe(id, strategyID, reference, windowStart string, cooldown int) Recipe {
	return Recipe{
		Schema:            RecipeSchema,
		ID:                id,
		StrategyID:        strategyID,
		Sizing:            Sizing{WeightPct: 10, MaxPositions: 10, CapacityPctDV20: 5, Rank: RankScoreDescCodeAsc},
		Costs:             houseCosts(),
		CooldownSessions:  cooldown,
		StaleExitSessions: 20,
		Capital:           100000,
		Cash:              CashRBARate,
		Returns:           ReturnsTotal,
		Benchmark:         BenchmarkXJT,
		Reference:         reference,
		Delisting:         DelistingExitLast,
		WindowStart:       windowStart,
		Fundamentals:      FundamentalsStrict,
	}
}

// R1Recipes returns the five r1 recipes, one per canonical strategy, in the
// order of the recipe table. Every call returns fresh values.
//
// Once a recipe is published its values and the Recipe layout are frozen: a
// change is a new recipe id, and TestRecipeHashesArePinned fails until the
// golden moves with it.
func R1Recipes() []Recipe {
	return []Recipe{
		crowdedShortR1(),
		minerviniR1(),
		zangerR1(),
		canSLIMR1(),
		qualityR1(),
	}
}

// crowdedShortR1 enters the session after a breakout is new and skips a stock
// that opens more than 10% over its pivot. It exits below the captured pivot or
// after 20 sessions.
func crowdedShortR1() Recipe {
	r := r1Recipe(RecipeCrowdedShortR1, StrategyCrowdedShortBreakout, ReferenceCrowdedShorts, windowFromMay2019, 10)
	r.Entry = EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshNewBreakout, Fill: EntryFillNextOpenTraded, MaxAbovePivotPct: ptrFloat(10)}
	r.Exits = []ExitRule{{Kind: ExitClosePivot, Sessions: 1}, {Kind: ExitTimeStop, Sessions: 20}}
	return r
}

// minerviniR1 buys the session a stock first passes the trend template. It
// exits on an 8% stop, a close below the 50-day average or a status that falls
// to watch or none.
func minerviniR1() Recipe {
	r := r1Recipe(RecipeMinerviniR1, StrategyMinerviniTrend, ReferenceLiquidOrdinary, windowFromMay2019, 10)
	r.Entry = EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshAny, Fill: EntryFillNextOpenTraded}
	r.Exits = []ExitRule{
		{Kind: ExitStopLoss, Pct: 8},
		{Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1},
		{Kind: ExitStatusFalls, Statuses: []string{statusWatch, statusNone}, Sessions: 1},
	}
	return r
}

// zangerR1 enters a new breakout within 5% of its pivot. It has no time stop:
// Zanger holds winners while they keep acting well, so it exits on the captured
// pivot, an 8% stop or a close below the 50-day average.
func zangerR1() Recipe {
	r := r1Recipe(RecipeZangerR1, StrategyZangerBreakout, ReferenceLiquidOrdinary, WindowComputableFrom, 10)
	r.Entry = EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshNewBreakout, Fill: EntryFillNextOpenTraded, MaxAbovePivotPct: ptrFloat(5)}
	r.Exits = []ExitRule{
		{Kind: ExitClosePivot, Sessions: 1},
		{Kind: ExitStopLoss, Pct: 8},
		{Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1},
	}
	return r
}

// canSLIMR1 enters the session after a stock becomes triggered. It exits on an
// 8% stop, a close below the 50-day average or a status that falls to watch or
// none.
func canSLIMR1() Recipe {
	r := r1Recipe(RecipeCANSLIMR1, StrategyCANSLIM, ReferenceLiquidOrdinary, WindowComputableFrom, 10)
	r.Entry = EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshAny, Fill: EntryFillNextOpenTraded}
	r.Exits = []ExitRule{
		{Kind: ExitStopLoss, Pct: 8},
		{Kind: ExitCloseBelowSMA, SMA: 50, Sessions: 1},
		{Kind: ExitStatusFalls, Statuses: []string{statusWatch, statusNone}, Sessions: 1},
	}
	return r
}

// qualityR1 enters the session after a stock becomes triggered. It exits on five
// consecutive closes below the 200-day average, or five consecutive sessions at
// a status of watch or none. It waits 20 sessions before a re-entry.
func qualityR1() Recipe {
	r := r1Recipe(RecipeQualityR1, StrategyQualityCompounders, ReferenceLiquidOrdinary, WindowComputableFrom, 20)
	r.Entry = EntryRule{On: EntryOnBecomesTriggered, Fresh: EntryFreshAny, Fill: EntryFillNextOpenTraded}
	r.Exits = []ExitRule{
		{Kind: ExitCloseBelowSMA, SMA: 200, Sessions: 5},
		{Kind: ExitStatusFalls, Statuses: []string{statusWatch, statusNone}, Sessions: 5},
	}
	return r
}
