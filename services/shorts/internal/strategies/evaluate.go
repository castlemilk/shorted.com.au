package strategies

import (
	"math"
	"sort"
	"time"
)

// quartile is the top-quartile cut-off of one cross-sectional metric.
type quartile struct {
	threshold float64 // the 75th percentile (linear interpolation)
	max       float64
	ok        bool // false when no candidate carries the metric
}

// computeRS6mQuartile returns the 75th percentile of rs_6m_pct across every
// candidate that has one. It is computed INSIDE Evaluate, over exactly the
// universe being ranked, so "top quartile" always means the top quartile of
// what the caller sees. NaN and Inf are ignored (the store already drops
// them; this is belt and braces).
func computeRS6mQuartile(cands []Candidate) quartile {
	vals := make([]float64, 0, len(cands))
	for i := range cands {
		if v := cands[i].RS6mPct; v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) {
			vals = append(vals, *v)
		}
	}
	return quantile(vals, rsLeaderQuantile)
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
	}
}

// Env is the per-universe context every rule may read: the market regime and
// cross-sectional statistics of the evaluated universe (the rs_6m quartile).
// Build it once per universe with NewEnv and share it: GetStockStrategyFit
// re-evaluates one stock against the cached Env, so a stock's rule results
// there match the ones its row carries in the ranked list.
type Env = evalEnv

// NewEnv computes the evaluation environment of a universe.
func NewEnv(cands []Candidate, regime Regime) *Env {
	return &evalEnv{regime: regime, rs6m: computeRS6mQuartile(cands)}
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
	results := make([]RuleResult, 0, len(strategy.Rules))
	var score float64
	anyPass := false
	for _, rule := range strategy.Rules {
		out := evaluateRule(rule.ID, &c, env)
		if out.Status == RulePass {
			// The regime rule says nothing about the stock, so passing it
			// alone does not make a stock a pick.
			if rule.ID != RuleRegime {
				anyPass = true
			}
			score += weights[rule.ID] * (passFloor + passStrength*clamp01(out.Strength)) * 100
		}
		results = append(results, RuleResult{
			RuleID:   rule.ID,
			Status:   out.Status,
			Detail:   out.Detail,
			Value:    finiteOrZero(out.Value),
			HasValue: out.HasValue && isFinite(out.Value),
		})
	}
	return Pick{
		Candidate: c,
		Status:    Ladder(strategy, results),
		Score:     math.Min(100, math.Max(0, math.Round(score*10)/10)),
		Rules:     results,
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

// Ladder applies the status ladder to one stock's rule results:
//
//   - triggered: every core rule passes (an unknown core rule is not a pass);
//   - setup: every core rule OUTSIDE strategy.TriggerRules passes, and at
//     least one trigger rule has not (yet);
//   - watch: anything else.
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
