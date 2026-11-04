package engine

import (
	"fmt"
	"math"
	"testing"
)

// signalsUniverse is the realistic universe of TestEveryStrategyEvaluatesARealisticUniverse:
// every strategy has a triggered pick, a setup or watch row to read, and an
// unknown rule somewhere in it.
func signalsUniverse() []Candidate {
	squeeze := zangerReady("SQZ")
	squeeze.ShortPct = new(float64(9))
	squeeze.DaysToCover = new(float64(7))
	trend := Candidate{
		StockCode: "TRD", AsOf: *d("2026-09-25"), Close: 20, SMA50: new(float64(18)), SMA150: new(float64(16)), SMA200: new(float64(15)), SMA200_1mAgo: new(14.5),
		Low52w: new(float64(12)), High52w: new(float64(21)), PctOff52wHigh: new(-4.8), RS6mPct: new(float64(40)), DollarVolume20d: new(3e6),
		Growth: &Growth{EPSYoYPct: new(float64(30))},
	}
	near := zangerReady("NER")
	near.BreakoutRecent = new(false)
	near.Close = 9.405 // 1% under the pivot: a setup, waiting on the breakout
	return []Candidate{zangerReady("RDY"), squeeze, trend, near, {StockCode: "LAG", Close: 1, RS6mPct: new(float64(-20)), DollarVolume20d: new(1e6)}, qualityReady("QLT")}
}

// TestRegistryAnnotatesDefinitionFacts pins the definition-level fields of
// every rule: trigger membership, the score weight and the threshold, each
// read from the one table its surface shares. The expected values are typed
// out here, comparators included, so a change to thresholds.go shows up as a
// change to this table as well.
func TestRegistryAnnotatesDefinitionFacts(t *testing.T) {
	want := map[string]struct {
		value      float64
		unit       string
		comparator string
	}{
		RuleRS:                  {0, "pp", ">"},
		RuleLiquidity:           {LiquidityFloorAUD, "aud", ">="},
		RuleRevenueGrowth:       {revenueGrowthMinPct, "pct", ">="},
		RuleNearHigh:            {nearHighMaxOffPct, "pct", ">="},
		RuleSMA200Rising:        {0, "pct", ">"},
		RuleAboveLow:            {(aboveLowMultiple - 1) * 100, "pct", ">="},
		RuleOffHigh:             {offHighMaxOffPct, "pct", ">="},
		RuleAboveSMA50:          {0, "pct", ">"},
		RuleShortInterest:       {shortInterestMinPct, "pct", ">="},
		RuleDaysToCover:         {daysToCoverMin, "days", ">="},
		RuleROE:                 {roeMinPct, "pct", ">="},
		RuleNetMargin:           {netMarginMinPct, "pct", ">="},
		RuleCashConversion:      {cashConversionMin, "x", ">="},
		RuleLeverage:            {leverageMaxMultiple, "x", "<="},
		RuleAboveSMA200:         {0, "pct", ">"},
		RuleRevenueNotShrinking: {revenueNotShrinkingMin, "pct", ">="},
	}
	// No single number to test: the regime, the trend shape, the breakout's
	// pivot shape, rs_leader (its cut-off is in points, the response's
	// rs_quantile_threshold, not in the rule's own unit), and the rules that
	// pass on more than one condition (base; growth and the EPS rule, which
	// also pass on a turnaround).
	noSingleNumber := map[string]bool{
		RuleBreakout: true, RuleRegime: true, RuleTrendStack: true, RuleRSLeader: true,
		RuleBase: true, RuleGrowth: true, RuleEPSGrowth: true,
	}
	for _, s := range Registry() {
		triggers := triggerRuleSet(s)
		var weightSum float64
		for _, r := range s.Rules {
			if r.Trigger != triggers[r.ID] {
				t.Errorf("%s/%s: Trigger = %v, want %v", s.ID, r.ID, r.Trigger, triggers[r.ID])
			}
			if r.Weight != ruleWeights[s.ID][r.ID] || r.Weight <= 0 {
				t.Errorf("%s/%s: Weight = %v, want the score recipe's %v", s.ID, r.ID, r.Weight, ruleWeights[s.ID][r.ID])
			}
			weightSum += r.Weight
			if noSingleNumber[r.ID] {
				if r.HasThreshold {
					t.Errorf("%s/%s: has_threshold set for a rule with no single number", s.ID, r.ID)
				}
				continue
			}
			w, ok := want[r.ID]
			if !ok {
				t.Errorf("%s/%s: a thresholded rule with no expected threshold", s.ID, r.ID)
				continue
			}
			if !r.HasThreshold || r.Threshold != w.value || r.Unit != w.unit || r.Comparator != w.comparator {
				t.Errorf("%s/%s: threshold %v %q %q (has %v), want %v %q %q", s.ID, r.ID, r.Threshold, r.Unit, r.Comparator, r.HasThreshold, w.value, w.unit, w.comparator)
			}
		}
		if math.Abs(weightSum-1) > 1e-9 {
			t.Errorf("%s: weights sum to %v, want 1", s.ID, weightSum)
		}
	}
}

// TestThresholdAgreesWithStatus: for every rule that publishes a threshold, a
// pass or fail with a value agrees with comparing that value to the threshold.
// A table entry that names a number the rule does not test fails here.
func TestThresholdAgreesWithStatus(t *testing.T) {
	compare := func(v float64, comparator string, threshold float64) bool {
		switch comparator {
		case ">=":
			return v >= threshold-tolerance
		case "<=":
			return v <= threshold+tolerance
		case ">":
			return v > threshold
		}
		t.Fatalf("unknown comparator %q", comparator)
		return false
	}
	cands := signalsUniverse()
	checked := 0
	for _, s := range Registry() {
		thresholds := map[string]Rule{}
		for _, r := range s.Rules {
			if r.HasThreshold {
				thresholds[r.ID] = r
			}
		}
		for i := range cands {
			p, _ := EvaluateOne(s, cands[i], NewEnv(cands, Regime{}))
			for _, res := range p.Rules {
				def, ok := thresholds[res.RuleID]
				if !ok || !res.HasValue || res.Status == RuleUnknown {
					continue
				}
				checked++
				if got := compare(res.Value, def.Comparator, def.Threshold); got != (res.Status == RulePass) {
					t.Errorf("%s/%s on %s: value %v %s %v is %v, but status is %s",
						s.ID, res.RuleID, cands[i].StockCode, res.Value, def.Comparator, def.Threshold, got, res.Status)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no threshold result was checked; the universe no longer exercises the table")
	}
}

// TestUnknownResultsCarryAReason: a reason names the missing input and is set
// on unknown results only.
func TestUnknownResultsCarryAReason(t *testing.T) {
	cases := []struct {
		name string
		fn   ruleFunc
		c    Candidate
		want string
	}{
		{"growth without fundamentals", ruleGrowth, Candidate{StockCode: "X"}, ReasonNoFundamentals},
		{"liquidity without turnover", ruleLiquidity, Candidate{StockCode: "X"}, ReasonNoVolume},
		{"days to cover without volume", ruleDaysToCover, Candidate{StockCode: "X", ShortPct: new(6.0)}, ReasonNoVolume},
		{"trend without averages", ruleTrendStack, Candidate{StockCode: "X"}, ReasonNoPriceHistory},
		{"roe without a quality row", ruleROE, Candidate{StockCode: "X"}, ReasonNoFundamentals},
		{"cash conversion for a bank", ruleCashConversion, Candidate{StockCode: "X", Quality: &Quality{IsFinancial: true}}, ReasonNotMeaningful},
		{"net margin with no revenue", ruleNetMargin, Candidate{StockCode: "X", Quality: &Quality{}}, ReasonNoFundamentals},
		{"net margin with zero revenue", ruleNetMargin, Candidate{StockCode: "X", Quality: &Quality{Revenue: new(0.0)}}, ReasonNotMeaningful},
		{"net margin with negative revenue", ruleNetMargin, Candidate{StockCode: "X", Quality: &Quality{Revenue: new(-5.0)}}, ReasonNotMeaningful},
		{"rs 3m with the index missing", ruleRS, Candidate{StockCode: "X", Ret3mPct: new(8.0)}, ReasonNoIndex},
		{"rs 3m with no history", ruleRS, Candidate{StockCode: "X"}, ReasonNoPriceHistory},
		{"rs leader with the index missing", ruleRSLeader, Candidate{StockCode: "X", Ret6mPct: new(8.0)}, ReasonNoIndex},
		{"rs leader with no history", ruleRSLeader, Candidate{StockCode: "X"}, ReasonNoPriceHistory},
		{"roe withheld by the equity guard", ruleROE, Candidate{StockCode: "X", Quality: &Quality{
			NetIncome: new(10.0), TotalEquity: new(5.0), TotalEquityPrior: new(5.0),
			TotalAssets: new(100.0), TotalAssetsPrior: new(100.0)}}, ReasonNotMeaningful},
		// Year-end equity is 10.2% of assets, but the average is 9.6% of 96.9:
		// the view withholds the ratio, so the reason must say so.
		{"roe withheld on average equity at year end above 10%", ruleROE, Candidate{StockCode: "X", Quality: &Quality{
			NetIncome: new(10.0), TotalEquity: new(10.2), TotalEquityPrior: new(9.0),
			TotalAssets: new(100.0), TotalAssetsPrior: new(93.8)}}, ReasonNotMeaningful},
		{"roe with equity negative a year earlier", ruleROE, Candidate{StockCode: "X", Quality: &Quality{
			NetIncome: new(10.0), TotalEquity: new(50.0), TotalEquityPrior: new(-5.0),
			TotalAssets: new(100.0), TotalAssetsPrior: new(100.0)}}, ReasonNotMeaningful},
		{"roe with missing net profit", ruleROE, Candidate{StockCode: "X", Quality: &Quality{
			TotalEquity: new(50.0), TotalAssets: new(100.0)}}, ReasonNoFundamentals},
		{"roe with no prior balance point", ruleROE, Candidate{StockCode: "X", Quality: &Quality{
			NetIncome: new(10.0), TotalEquity: new(50.0), TotalAssets: new(100.0)}}, ReasonNoFundamentals},
	}
	for _, c := range cases {
		out := c.fn(&c.c, &evalEnv{})
		if out.Status != RuleUnknown || out.Reason != c.want {
			t.Errorf("%s: status %s reason %q, want unknown %q", c.name, out.Status, out.Reason, c.want)
		}
	}
	// The net margin copy is the one the rule has always carried, for a
	// missing revenue and a non-positive one alike; only the reason differs.
	for _, rev := range []*float64{nil, new(0.0)} {
		out := ruleNetMargin(&Candidate{StockCode: "X", Quality: &Quality{Revenue: rev}}, &evalEnv{})
		if out.Detail != "No positive revenue figure to measure a margin against" {
			t.Errorf("net margin detail = %q, want the revenue copy the rule has always carried", out.Detail)
		}
	}
	if out := ruleRegime(&Candidate{}, &evalEnv{}); out.Reason != ReasonNoIndex {
		t.Errorf("regime without a row: reason %q, want %q", out.Reason, ReasonNoIndex)
	}
	if out := ruleZangerPass(); out.Reason != "" {
		t.Errorf("a pass carries no reason: %+v", out)
	}
	for _, s := range Registry() {
		for _, p := range Evaluate(s, signalsUniverse(), uptrend) {
			for _, r := range p.Rules {
				if (r.Reason != "") != (r.Status == RuleUnknown) {
					t.Errorf("%s %s/%s: status %s with reason %q", s.ID, p.Candidate.StockCode, r.RuleID, r.Status, r.Reason)
				}
			}
		}
	}
}

func ruleZangerPass() outcome {
	c := zangerReady("RDY")
	return ruleBase(&c, &evalEnv{})
}

// TestProximityOnlyOnFailingTriggers: proximity is set on a failing trigger
// rule and on nothing else, and always lies in 0..1.
func TestProximityOnlyOnFailingTriggers(t *testing.T) {
	for _, s := range Registry() {
		triggers := triggerRuleSet(s)
		for _, p := range Evaluate(s, signalsUniverse(), uptrend) {
			for _, r := range p.Rules {
				if !r.HasProximity {
					continue
				}
				if r.Status != RuleFail || !triggers[r.RuleID] {
					t.Errorf("%s %s/%s: proximity on status %s (trigger %v)", s.ID, p.Candidate.StockCode, r.RuleID, r.Status, triggers[r.RuleID])
				}
				if r.Proximity < 0 || r.Proximity > 1 || math.IsNaN(r.Proximity) {
					t.Errorf("%s %s/%s: proximity %v outside 0..1", s.ID, p.Candidate.StockCode, r.RuleID, r.Proximity)
				}
			}
		}
	}
}

// TestWaitingOnlyOnSetupRows: a failing trigger on a setup row is waiting; no
// other row, and no other rule, is.
func TestWaitingOnlyOnSetupRows(t *testing.T) {
	sawWaiting := false
	for _, s := range Registry() {
		triggers := triggerRuleSet(s)
		for _, p := range Evaluate(s, signalsUniverse(), uptrend) {
			for _, r := range p.Rules {
				if r.Waiting {
					sawWaiting = true
					if p.Status != StatusSetup || r.Status != RuleFail || !triggers[r.RuleID] {
						t.Errorf("%s %s/%s: waiting on %s row with status %s", s.ID, p.Candidate.StockCode, r.RuleID, p.Status, r.Status)
					}
				}
			}
			if p.Status == StatusSetup {
				// A setup has a trigger that is not yet a pass: failing (waiting
				// for it to fire) or unknown (which is not waiting).
				notPassing := 0
				for _, r := range p.Rules {
					if r.Status == RuleFail && triggers[r.RuleID] && !r.Waiting {
						t.Errorf("%s %s: setup row's failing trigger %s is not waiting", s.ID, p.Candidate.StockCode, r.RuleID)
					}
					if triggers[r.RuleID] && r.Status != RulePass {
						notPassing++
					}
				}
				if notPassing == 0 {
					t.Errorf("%s %s: setup row with every trigger passing", s.ID, p.Candidate.StockCode)
				}
			}
		}
	}
	if !sawWaiting {
		t.Fatal("the universe has no setup row: the waiting rule is untested")
	}
}

// TestRS6mPercentileAndQuantileThreshold: the percentile is the stock's rank on
// the quantile's own scale (type 7: 0 at the lowest, 100 at the highest), and
// absent without a figure.
func TestRS6mPercentileAndQuantileThreshold(t *testing.T) {
	cands := []Candidate{
		{StockCode: "A", RS6mPct: new(10.0)},
		{StockCode: "B", RS6mPct: new(20.0)},
		{StockCode: "C", RS6mPct: new(30.0)},
		{StockCode: "D", RS6mPct: new(40.0)},
		{StockCode: "E"},
	}
	env := NewEnv(cands, uptrend)
	if thr, ok := env.RSQuantileThreshold(); !ok || math.Abs(thr-32.5) > 1e-9 {
		t.Errorf("quartile threshold = %v (ok %v), want 32.5", thr, ok)
	}
	if _, ok := NewEnv(nil, uptrend).RSQuantileThreshold(); ok {
		t.Error("an empty universe has no quartile threshold")
	}
	want := map[string]float64{"A": 0, "B": 100.0 / 3, "C": 200.0 / 3, "D": 100}
	for _, c := range cands {
		p, _ := EvaluateOne(Registry()[0], c, env)
		if c.RS6mPct == nil {
			if p.RS6mPercentile != nil {
				t.Errorf("%s: percentile set without a 6-month figure", c.StockCode)
			}
			continue
		}
		if p.RS6mPercentile == nil || math.Abs(*p.RS6mPercentile-want[c.StockCode]) > 1e-9 {
			t.Errorf("%s: percentile %v, want %v", c.StockCode, p.RS6mPercentile, want[c.StockCode])
		}
	}
}

// TestRS6mPercentileAgreesWithTheRule: a stock's rs_6m_percentile is 75 or
// more exactly when rs_leader passes it, for every universe size, with and
// without a tie at the cut-off.
func TestRS6mPercentileAgreesWithTheRule(t *testing.T) {
	for n := 4; n <= 23; n++ {
		var cands []Candidate
		for i := 0; i < n; i++ {
			// Distinct, uneven figures, so no two stocks share a rank.
			cands = append(cands, Candidate{StockCode: fmt.Sprintf("S%02d", i), RS6mPct: new(float64(i*i) + 0.5*float64(i))})
		}
		// A duplicate of a middle figure: a tie must read one rank for both.
		cands = append(cands, Candidate{StockCode: "TIE", RS6mPct: new(*cands[n/2].RS6mPct)})
		env := NewEnv(cands, uptrend)
		for _, c := range cands {
			p, _ := EvaluateOne(Registry()[0], c, env)
			rule := ruleRSLeader(&c, env)
			if p.RS6mPercentile == nil {
				t.Fatalf("n=%d %s: no percentile", n, c.StockCode)
			}
			inTop := *p.RS6mPercentile >= 75-1e-9
			if inTop != (rule.Status == RulePass) {
				t.Errorf("n=%d %s: percentile %v, rule %s", n, c.StockCode, *p.RS6mPercentile, rule.Status)
			}
		}
	}
}
