package engine

import (
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
// read from the one table its surface shares.
func TestRegistryAnnotatesDefinitionFacts(t *testing.T) {
	want := map[string]struct {
		value float64
		unit  string
	}{
		RuleGrowth:              {growthMinPct, "%"},
		RuleBase:                {baseMaxDepthPct, "%"},
		RuleLiquidity:           {LiquidityFloorAUD, "A$"},
		RuleEPSGrowth:           {growthMinPct, "%"},
		RuleRevenueGrowth:       {revenueGrowthMinPct, "%"},
		RuleNearHigh:            {nearHighMaxOffPct, "%"},
		RuleOffHigh:             {offHighMaxOffPct, "%"},
		RuleRSLeader:            {75, "percentile"},
		RuleShortInterest:       {shortInterestMinPct, "%"},
		RuleDaysToCover:         {daysToCoverMin, "days"},
		RuleROE:                 {roeMinPct, "%"},
		RuleNetMargin:           {netMarginMinPct, "%"},
		RuleCashConversion:      {cashConversionMin, "x"},
		RuleLeverage:            {leverageMaxMultiple, "x"},
		RuleRevenueNotShrinking: {revenueNotShrinkingMin, "%"},
	}
	noSingleNumber := map[string]bool{RuleBreakout: true, RuleRegime: true, RuleTrendStack: true}
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
			if w, ok := want[r.ID]; ok {
				if !r.HasThreshold || r.Threshold != w.value || r.Unit != w.unit {
					t.Errorf("%s/%s: threshold %v %q (has %v), want %v %q", s.ID, r.ID, r.Threshold, r.Unit, r.HasThreshold, w.value, w.unit)
				}
			}
		}
		if math.Abs(weightSum-1) > 1e-9 {
			t.Errorf("%s: weights sum to %v, want 1", s.ID, weightSum)
		}
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
	}
	for _, c := range cases {
		out := c.fn(&c.c, &evalEnv{})
		if out.Status != RuleUnknown || out.Reason != c.want {
			t.Errorf("%s: status %s reason %q, want unknown %q", c.name, out.Status, out.Reason, c.want)
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

// TestRS6mPercentileAndQuantileThreshold: the percentile is the share of the
// universe at or below the stock, and absent without a figure.
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
	want := map[string]float64{"A": 25, "B": 50, "C": 75, "D": 100}
	for _, c := range cands {
		p, _ := EvaluateOne(Registry()[0], c, env)
		if c.RS6mPct == nil {
			if p.RS6mPercentile != nil {
				t.Errorf("%s: percentile set without a 6-month figure", c.StockCode)
			}
			continue
		}
		if p.RS6mPercentile == nil || *p.RS6mPercentile != want[c.StockCode] {
			t.Errorf("%s: percentile %v, want %v", c.StockCode, p.RS6mPercentile, want[c.StockCode])
		}
	}
}
