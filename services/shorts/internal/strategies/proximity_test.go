package strategies

import (
	"math"
	"strings"
	"testing"
)

func TestProximityMapsTheGapOntoTheUnitInterval(t *testing.T) {
	cases := []struct{ gap, far, want float64 }{
		{0, 10, 1},   // at the line
		{-3, 10, 1},  // past it (above the pivot without the volume)
		{5, 10, 0.5}, // half way
		{10, 10, 0},  // at the far distance
		{25, 10, 0},  // beyond it
		{math.NaN(), 10, 0},
		{1, 0, 0}, // a far distance of zero grades nothing
	}
	for _, c := range cases {
		if got := proximity(c.gap, c.far); math.IsNaN(got) || math.IsInf(got, 0) || math.Abs(got-c.want) > 1e-9 {
			t.Errorf("proximity(%v, %v) = %v, want %v", c.gap, c.far, got, c.want)
		}
	}
}

func TestEveryTriggerRuleGradesItsFail(t *testing.T) {
	near := zangerReady("NEAR")
	near.BreakoutRecent = new(false)
	near.Close = 9.405 // 1% under the 9.5 pivot
	far := zangerReady("FAR")
	far.BreakoutRecent = new(false)
	far.Close = 8.55 // 10% under
	if p := ruleBreakout(&near, nil).Proximity; math.Abs(p-0.9) > 1e-6 {
		t.Errorf("breakout 1%% under the pivot: proximity %v, want 0.9", p)
	}
	if p := ruleBreakout(&far, nil).Proximity; p > 1e-9 {
		t.Errorf("breakout 10%% under the pivot: proximity %v, want 0", p)
	}
	above := zangerReady("ABV")
	above.BreakoutRecent = new(false)
	above.Close = 9.6 // above the pivot, but not on 1.5x volume
	if out := ruleBreakout(&above, nil); out.Status != RuleFail || out.Proximity != 1 {
		t.Errorf("a close over the pivot without the volume fails at the line: %+v", out)
	}
	noPivot := Candidate{StockCode: "NOP", Close: 5, BreakoutRecent: new(false)}
	if out := ruleBreakout(&noPivot, nil); out.Proximity != 0 {
		t.Errorf("no pivot, no proximity: %+v", out)
	}

	c := Candidate{Close: 10, PctOff52wHigh: new(-12.5)}
	if p := ruleNearHigh(&c, nil).Proximity; math.Abs(p-0.5) > 1e-6 {
		t.Errorf("12.5%% off the high is half way to CAN SLIM's 5%% line: %v", p)
	}
	c.PctOff52wHigh = new(-37.5)
	if p := ruleOffHigh(&c, nil).Proximity; math.Abs(p-0.5) > 1e-6 {
		t.Errorf("37.5%% off the high is half way to Minervini's 25%% line: %v", p)
	}

	env := &evalEnv{rs6m: quartile{threshold: 20, max: 60, ok: true}}
	rs := Candidate{RS6mPct: new(float64(10))}
	if p := ruleRSLeader(&rs, env).Proximity; math.Abs(p-0.5) > 1e-6 {
		t.Errorf("10 points under the cut-off: proximity %v, want 0.5", p)
	}

	q := Candidate{Close: 95, SMA200: new(float64(100))}
	if p := ruleAboveSMA200(&q, nil).Proximity; math.Abs(p-0.5) > 1e-6 {
		t.Errorf("5%% under the 200-day: proximity %v, want 0.5", p)
	}

	// A pass carries no proximity, and a rule that is never a trigger grades
	// nothing on a fail.
	if out := ruleAboveSMA200(&Candidate{Close: 105, SMA200: new(float64(100))}, nil); out.Status != RulePass || out.Proximity != 0 {
		t.Errorf("a pass has no proximity: %+v", out)
	}
	if out := ruleLiquidity(&Candidate{DollarVolume20d: new(float64(249_000))}, nil); out.Proximity != 0 {
		t.Errorf("liquidity is never graded: %+v", out)
	}
}

func TestSetupsRankByTriggerProximity(t *testing.T) {
	z, _ := Lookup(IDZangerBreakout)
	near := zangerReady("NEAR")
	near.BreakoutRecent = new(false)
	near.Close = 9.4
	far := zangerReady("FAR")
	far.BreakoutRecent = new(false)
	far.Close = 8.6
	picks := Evaluate(z, []Candidate{far, near}, uptrend)
	if got := codes(picks); strings.Join(got, ",") != "NEAR,FAR" {
		t.Fatalf("order = %v, want the setup nearest its pivot first", got)
	}
	for _, p := range picks {
		if p.Status != StatusSetup {
			t.Errorf("%s is %s, want setup", p.Candidate.StockCode, p.Status)
		}
	}
	// Breakout carries weight 0.25: at the line the credit is 7.5 points,
	// at 10% under it is nothing. NEAR is ~1.05% under (credit ~6.7), FAR
	// ~9.5% under (credit ~0.4).
	if diff := picks[0].Score - picks[1].Score; diff < 5 || diff > 7.5 {
		t.Errorf("proximity credit between the two = %.1f points, want 5..7.5 (scores %v, %v)", diff, picks[0].Score, picks[1].Score)
	}
}

func TestTriggerCreditNeverOutranksAPassAndNeverTouchesATriggeredStock(t *testing.T) {
	if triggerCredit >= passFloor {
		t.Fatalf("triggerCredit %v must stay below passFloor %v so a failing trigger scores less than one passing at the floor", triggerCredit, passFloor)
	}
	z, _ := Lookup(IDZangerBreakout)
	// A marginal breakout (the pass at the floor: 7 days old) against a stock
	// sitting exactly on the pivot without the volume.
	passed := zangerReady("PAS")
	passed.BreakoutDate = d("2026-09-18")
	passed.Close = 9.5
	atLine := zangerReady("LIN")
	atLine.BreakoutRecent = new(false)
	atLine.Close = 9.5
	picks := Evaluate(z, []Candidate{atLine, passed}, uptrend)
	if got := codes(picks); strings.Join(got, ",") != "PAS,LIN" {
		t.Fatalf("order = %v, want the marginal pass above the stock at the line", got)
	}
	if picks[0].Score <= picks[1].Score {
		t.Errorf("a floor pass (%v) must outscore a fail at the line (%v)", picks[0].Score, picks[1].Score)
	}
	// Proximity is irrelevant to a triggered stock: the score is the one the
	// weights give a stock passing every rule.
	ready := zangerReady("RDY")
	single := Evaluate(z, []Candidate{ready}, uptrend)
	if len(single) != 1 || single[0].Status != StatusTriggered || single[0].Score < 60 || single[0].Score > 100 {
		t.Fatalf("triggered stock = %+v", single)
	}
}

func TestTriggerRuleProseStatesTheCredit(t *testing.T) {
	for _, st := range Registry() {
		triggers := triggerRuleSet(st)
		for _, r := range st.Rules {
			has := strings.Contains(r.Evaluation, "scores higher the closer")
			if triggers[r.ID] && !has {
				t.Errorf("%s/%s is a trigger rule and must say how a near miss scores", st.ID, r.ID)
			}
			if !triggers[r.ID] && has {
				t.Errorf("%s/%s is not a trigger rule and must not claim a near-miss credit", st.ID, r.ID)
			}
		}
	}
}
