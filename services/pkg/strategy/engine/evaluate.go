package engine

import (
	"math"
	"sort"
	"time"

	"cloud.google.com/go/civil"
)

// quartile is the top-quartile cut-off of one cross-sectional metric.
type quartile struct {
	threshold float64 // the 75th percentile (linear interpolation)
	max       float64
	ok        bool      // false when no candidate carries the metric
	sorted    []float64 // every value, ascending, for percentile ranks
}

// percentileOf is v's rank in the universe on the same scale as the quantile
// it is compared with (type 7): the sorted position of v, interpolated between
// neighbours, divided by n-1, 0-100. So percentileOf(v) >= 75 holds exactly
// when v >= the 75th-percentile cut-off, whatever the universe's size. A tie
// takes the highest position of its values. nil when v is nil or non-finite,
// or the universe carries no values.
func (q quartile) percentileOf(v *float64) *float64 {
	if v == nil || !isFinite(*v) || len(q.sorted) == 0 {
		return nil
	}
	n := len(q.sorted)
	// idx is the highest position whose value is at or below v; -1 when v is
	// below every value.
	idx := sort.Search(n, func(i int) bool { return q.sorted[i] > *v }) - 1
	var p float64
	switch {
	case idx < 0:
		p = 0
	case n == 1:
		p = 100
	case idx == n-1 || q.sorted[idx] == *v:
		p = float64(idx) / float64(n-1) * 100
	default:
		frac := (*v - q.sorted[idx]) / (q.sorted[idx+1] - q.sorted[idx])
		p = (float64(idx) + frac) / float64(n-1) * 100
	}
	return &p
}

// RSQuantileThreshold is the universe's top-quartile cut-off of rs_6m_pct, the
// figure rs_leader reads. ok is false when no candidate carries the metric.
func (e *evalEnv) RSQuantileThreshold() (float64, bool) {
	if e == nil || !e.rs6m.ok {
		return 0, false
	}
	return e.rs6m.threshold, true
}

// computeRS6mQuartile returns the 75th percentile of rs_6m_pct across every
// candidate that has one. It is computed INSIDE Evaluate, over exactly the
// universe being ranked, so "top quartile" always means the top quartile of
// what the caller sees. NaN and Inf are ignored (the store already drops
// them; this is belt and braces).
func computeRS6mQuartile(cands []Candidate) quartile {
	return quantile(UniverseStatsOf(cands).RS6m, rsLeaderQuantile)
}

// quantile is the linear-interpolation quantile (the numpy / R type 7
// default): position p x (n-1) between the sorted values.
func quantile(vals []float64, p float64) quartile {
	if len(vals) == 0 {
		return quartile{}
	}
	sorted := append([]float64(nil), vals...)
	sort.Float64s(sorted)
	pos := p * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	frac := pos - float64(lo)
	return quartile{
		threshold: sorted[lo] + (sorted[hi]-sorted[lo])*frac,
		max:       sorted[len(sorted)-1],
		ok:        true,
		sorted:    sorted,
	}
}

// Env is the per-universe context every rule may read: the market regime and
// cross-sectional statistics of the evaluated universe (the rs_6m quartile).
// Build it once per universe with NewEnv and share it: GetStockStrategyFit
// re-evaluates one stock against the cached Env, so a stock's rule results
// there match the ones its row carries in the ranked list.
type Env = evalEnv

// UniverseStats is the cross-sectional part of an evaluated universe: what the
// rules read from the other stocks, computed once per universe. The backtest
// builds it from each session's eligible codes; the live path builds it from
// the candidates it already holds (UniverseStatsOf).
type UniverseStats struct {
	Session civil.Date
	RS6m    []float64 // rs_6m_pct of the version's eligible codes on Session, sorted ascending
}

// UniverseStatsOf reads the statistics of a built candidate slice: the finite
// rs_6m_pct values in ascending order, and the newest price date.
func UniverseStatsOf(cands []Candidate) UniverseStats {
	vals := make([]float64, 0, len(cands))
	for i := range cands {
		if v := cands[i].RS6mPct; v != nil && isFinite(*v) {
			vals = append(vals, *v)
		}
	}
	sort.Float64s(vals)
	var session civil.Date
	if latest := LatestAsOf(cands); !latest.IsZero() {
		session = civil.DateOf(latest)
	}
	return UniverseStats{Session: session, RS6m: vals}
}

// NewEnvFromStats computes the evaluation environment of a universe from its
// statistics. Non-finite RS values are ignored, as they are everywhere else.
func NewEnvFromStats(regime Regime, stats UniverseStats) *Env {
	vals := make([]float64, 0, len(stats.RS6m))
	for _, v := range stats.RS6m {
		if isFinite(v) {
			vals = append(vals, v)
		}
	}
	return &evalEnv{regime: regime, rs6m: quantile(vals, rsLeaderQuantile)}
}

// NewEnv computes the evaluation environment of a universe. It is
// NewEnvFromStats over the universe's own statistics.
func NewEnv(cands []Candidate, regime Regime) *Env {
	return NewEnvFromStats(regime, UniverseStatsOf(cands))
}

// Regime returns the market regime the environment was built with.
func (e *evalEnv) Regime() Regime {
	if e == nil {
		return Regime{}
	}
	return e.regime
}

// Evaluate runs every rule of strategy against every candidate and returns
// the ranked picks: status first (triggered, setup, watch), then score
// descending, then stock code ascending, so the order is total and stable.
//
// A candidate on which no stock-specific rule passes (the market regime rule
// does not count) is not a pick and is left out.
// Rank is 1-based across the returned list.
func Evaluate(strategy Strategy, cands []Candidate, regime Regime) []Pick {
	return EvaluateWithEnv(strategy, cands, NewEnv(cands, regime))
}

// EvaluateWithEnv is Evaluate over an environment built beforehand (NewEnv
// over the same candidates), so several strategies share one.
func EvaluateWithEnv(strategy Strategy, cands []Candidate, env *Env) []Pick {
	picks := make([]Pick, 0, len(cands))
	for i := range cands {
		if p, ok := EvaluateOne(strategy, cands[i], env); ok {
			picks = append(picks, p)
		}
	}

	sort.SliceStable(picks, func(a, b int) bool {
		ra, rb := statusRank(picks[a].Status), statusRank(picks[b].Status)
		if ra != rb {
			return ra < rb
		}
		if picks[a].Score != picks[b].Score {
			return picks[a].Score > picks[b].Score
		}
		return picks[a].Candidate.StockCode < picks[b].Candidate.StockCode
	})
	for i := range picks {
		picks[i].Rank = i + 1
	}
	return picks
}

// EvaluateOne runs every rule of strategy against one candidate: the body of
// the Evaluate loop. The Pick has no rank (0). ok reports whether the stock is
// a pick at all, that is whether a stock-specific rule passed; the market
// regime rule passing alone does not make a stock a pick. A nil env reads as
// an unknown regime over an empty universe.
func EvaluateOne(strategy Strategy, c Candidate, env *Env) (Pick, bool) {
	if env == nil {
		env = &evalEnv{}
	}
	weights := ruleWeights[strategy.ID]
	triggers := triggerRuleSet(strategy)
	results := make([]RuleResult, 0, len(strategy.Rules))
	var score float64
	anyPass := false
	for _, rule := range strategy.Rules {
		out := evaluateRule(rule.ID, &c, env)
		switch {
		case out.Status == RulePass:
			// The regime rule says nothing about the stock, so passing it
			// alone does not make a stock a pick.
			if rule.ID != RuleRegime {
				anyPass = true
			}
			score += weights[rule.ID] * (passFloor + passStrength*clamp01(out.Strength)) * 100
		case out.Status == RuleFail && triggers[rule.ID]:
			// A trigger that has not fired yet earns a share of its weight for
			// how close it is (proximity.go), so a setup about to break out ranks
			// above one far from its pivot.
			score += weights[rule.ID] * triggerCredit * clamp01(out.Proximity) * 100
		}
		res := RuleResult{
			RuleID:   rule.ID,
			Status:   out.Status,
			Detail:   out.Detail,
			Value:    finiteOrZero(out.Value),
			HasValue: out.HasValue && isFinite(out.Value),
			Reason:   out.Reason,
		}
		// Proximity grades a failing trigger and nothing else.
		if out.Status == RuleFail && triggers[rule.ID] && out.HasProximity {
			res.Proximity, res.HasProximity = clamp01(out.Proximity), true
		}
		results = append(results, res)
	}
	status := Ladder(strategy, results)
	if status == StatusSetup {
		// The failing triggers of a setup are what it is waiting for.
		for i := range results {
			results[i].Waiting = results[i].Status == RuleFail && triggers[results[i].RuleID]
		}
	}
	return Pick{
		Candidate:      c,
		Status:         status,
		Score:          math.Min(100, math.Max(0, math.Round(score*10)/10)),
		Rules:          results,
		RS6mPercentile: env.rs6m.percentileOf(c.RS6mPct),
	}, anyPass
}

// PrepareCandidates applies the Go-side decisions to a freshly read universe,
// in place and once per fill, before any rule reads it: the financials
// decision on every quality row (ApplyQualityRules, which withholds the
// not-meaningful ratios) and the valuation from the latest close (Valuate).
func PrepareCandidates(cands []Candidate) {
	for i := range cands {
		c := &cands[i]
		ApplyQualityRules(c.Quality, c.Industry)
		c.Valuation = Valuate(c.Close, c.AsOf, c.ValuationInputs, c.Quality)
	}
}

func evaluateRule(id string, c *Candidate, env *evalEnv) outcome {
	fn, ok := ruleFuncs[id]
	if !ok {
		return unknown("Rule not evaluated")
	}
	return fn(c, env)
}

// Ladder applies the status ladder to one stock's rule results. The ladder
// is the version's (Strategy.UnknownStatus):
//
// v0 (UnknownStatus false):
//   - triggered: every core rule passes (an unknown core rule is not a pass);
//   - setup: every core rule OUTSIDE the trigger rules passes, and at least one
//     trigger rule has not (yet), unknown included;
//   - watch: anything else.
//
// v1 (UnknownStatus true), in order:
//   - watch: a core non-trigger rule fails;
//   - unknown: otherwise, a core rule is unknown;
//   - setup: otherwise, a trigger rule fails;
//   - triggered: otherwise.
//
// A core rule with no result at all counts as not passing.
func Ladder(strategy Strategy, results []RuleResult) PickStatus {
	status := make(map[string]RuleStatus, len(results))
	for _, r := range results {
		status[r.RuleID] = r.Status
	}
	trigger := make(map[string]bool, len(strategy.TriggerRules))
	for _, id := range strategy.TriggerRules {
		trigger[id] = true
	}
	if strategy.UnknownStatus {
		return ladderV1(strategy, status, trigger)
	}
	allCore, setupCore := true, true
	for _, rule := range strategy.Rules {
		if !rule.Core || status[rule.ID] == RulePass {
			continue
		}
		allCore = false
		if !trigger[rule.ID] {
			setupCore = false
		}
	}
	switch {
	case allCore:
		return StatusTriggered
	case setupCore:
		return StatusSetup
	default:
		return StatusWatch
	}
}

// ladderV1 is the v1 status ladder over the rule statuses (see Ladder).
func ladderV1(strategy Strategy, status map[string]RuleStatus, trigger map[string]bool) PickStatus {
	anyUnknown, anyTriggerFail := false, false
	for _, rule := range strategy.Rules {
		if !rule.Core {
			continue
		}
		st, ok := status[rule.ID]
		if !ok {
			st = RuleFail
		}
		switch {
		case st == RulePass:
		case !trigger[rule.ID] && st == RuleFail:
			return StatusWatch
		case st == RuleUnknown:
			anyUnknown = true
		case trigger[rule.ID]:
			anyTriggerFail = true
		}
	}
	switch {
	case anyUnknown:
		return StatusUnknown
	case anyTriggerFail:
		return StatusSetup
	default:
		return StatusTriggered
	}
}

// FundamentalsCoverage counts candidates with at least one growth figure.
func FundamentalsCoverage(cands []Candidate) int {
	n := 0
	for i := range cands {
		if cands[i].Growth.HasGrowthData() {
			n++
		}
	}
	return n
}

// QualityCoverage counts candidates with a quality row (mv_fundamentals_quality).
func QualityCoverage(cands []Candidate) int {
	n := 0
	for i := range cands {
		if cands[i].Quality != nil {
			n++
		}
	}
	return n
}

// FundamentalsRows counts candidates with any reported fundamentals row
// (GetStrategyPicksResponse.fundamentals_rows_count).
func FundamentalsRows(cands []Candidate) int {
	n := 0
	for i := range cands {
		if cands[i].HasFundamentalsRow() {
			n++
		}
	}
	return n
}

// LatestAsOf returns the newest price date across the candidates (zero when
// there are none).
func LatestAsOf(cands []Candidate) time.Time {
	var latest time.Time
	for i := range cands {
		if cands[i].AsOf.After(latest) {
			latest = cands[i].AsOf
		}
	}
	return latest
}

func isFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func finiteOrZero(v float64) float64 {
	if isFinite(v) {
		return v
	}
	return 0
}
