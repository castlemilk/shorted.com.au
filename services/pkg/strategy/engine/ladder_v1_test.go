package engine

import "testing"

// v1Of is a registered strategy evaluated under the v1 ladder.
func v1Of(t *testing.T, id string) Strategy {
	t.Helper()
	s, ok := Lookup(id)
	if !ok {
		t.Fatalf("no engine strategy %s", id)
	}
	s.UnknownStatus = true
	return s
}

// referenceV1 is the v1 ladder written out as the spec states it (6.2), so the
// engine's implementation is checked against the words rather than itself.
func referenceV1(s Strategy, status map[string]RuleStatus) PickStatus {
	trigger := map[string]bool{}
	for _, id := range s.TriggerRules {
		trigger[id] = true
	}
	anyCoreUnknown, anyTriggerFail := false, false
	for _, r := range s.Rules {
		if !r.Core {
			continue
		}
		st, ok := status[r.ID]
		if !ok {
			st = RuleFail
		}
		if !trigger[r.ID] && st == RuleFail {
			return StatusWatch
		}
		if st == RuleUnknown {
			anyCoreUnknown = true
		}
		if trigger[r.ID] && st == RuleFail {
			anyTriggerFail = true
		}
	}
	switch {
	case anyCoreUnknown:
		return StatusUnknown
	case anyTriggerFail:
		return StatusSetup
	}
	return StatusTriggered
}

// TestLadderV1 covers every combination of the core rules' statuses for each
// registered strategy, and holds the v1 ladder to the reference above.
func TestLadderV1(t *testing.T) {
	statuses := []RuleStatus{RulePass, RuleFail, RuleUnknown}
	for _, s := range Registry() {
		v1 := s
		v1.UnknownStatus = true
		var core []string
		for _, r := range s.Rules {
			if r.Core {
				core = append(core, r.ID)
			}
		}
		combos := 1
		for range core {
			combos *= len(statuses)
		}
		for n := 0; n < combos; n++ {
			status := map[string]RuleStatus{}
			var results []RuleResult
			m := n
			for _, id := range core {
				st := statuses[m%len(statuses)]
				m /= len(statuses)
				status[id] = st
				results = append(results, RuleResult{RuleID: id, Status: st})
			}
			want := referenceV1(v1, status)
			if got := Ladder(v1, results); got != want {
				t.Errorf("%s %v: v1 ladder = %s, want %s", s.ID, status, got, want)
			}
		}
	}
}

// TestLadderV1Cases names the outcomes the changelog describes, for both
// ladders side by side: an unknown trigger is setup under v0 and unknown under
// v1, and an unknown growth rule is watch under v0 and unknown under v1.
func TestLadderV1Cases(t *testing.T) {
	const P, F, U = RulePass, RuleFail, RuleUnknown
	z, _ := Lookup(IDZangerBreakout)
	zv1 := v1Of(t, IDZangerBreakout)
	cs, _ := Lookup(IDCrowdedShortBreakout)
	csv1 := v1Of(t, IDCrowdedShortBreakout)

	cases := []struct {
		name     string
		strategy Strategy
		rules    []RuleResult
		want     PickStatus
	}{
		{"unknown trigger is unknown, not setup", zv1, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(U), RuleRegime, string(P), RuleLiquidity, string(P)), StatusUnknown},
		{"unknown growth is unknown, not watch", zv1, results(RuleGrowth, string(U), RuleBase, string(P), RuleBreakout, string(P), RuleRegime, string(P), RuleLiquidity, string(P)), StatusUnknown},
		{"failing regime beats an unknown trigger", zv1, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(U), RuleRegime, string(F), RuleLiquidity, string(P)), StatusWatch},
		{"downtrend demotion is kept in v1", zv1, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(P), RuleRegime, string(F), RuleLiquidity, string(P)), StatusWatch},
		{"a failing trigger is setup in v1", zv1, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(F), RuleRegime, string(P), RuleLiquidity, string(P)), StatusSetup},
		{"all core pass is triggered in v1", zv1, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(P), RuleRegime, string(P), RuleLiquidity, string(P)), StatusTriggered},
		{"v0 still reads an unknown trigger as setup", z, results(RuleGrowth, string(P), RuleBase, string(P), RuleBreakout, string(U), RuleRegime, string(P), RuleLiquidity, string(P)), StatusSetup},
		{"v1 crowded short: short unknown is unknown", csv1, results(RuleShortInterest, string(U), RuleBreakout, string(P), RuleLiquidity, string(P)), StatusUnknown},
		{"v1 crowded short: absent is watch", csv1, results(RuleShortInterest, string(F), RuleBreakout, string(P), RuleLiquidity, string(P)), StatusWatch},
		{"v0 crowded short: unknown short is watch", cs, results(RuleShortInterest, string(U), RuleBreakout, string(P), RuleLiquidity, string(P)), StatusWatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Ladder(tc.strategy, tc.rules); got != tc.want {
				t.Errorf("Ladder = %s, want %s", got, tc.want)
			}
		})
	}
}

// TestUnknownStatusSortsBetweenSetupAndWatch holds the v1 status order.
func TestUnknownStatusSortsBetweenSetupAndWatch(t *testing.T) {
	order := []PickStatus{StatusTriggered, StatusSetup, StatusUnknown, StatusWatch}
	for i := 0; i+1 < len(order); i++ {
		if statusRank(order[i]) >= statusRank(order[i+1]) {
			t.Errorf("%s ranks %d, %s ranks %d: want strictly ascending", order[i], statusRank(order[i]), order[i+1], statusRank(order[i+1]))
		}
	}
	if !ValidPickStatus("unknown") {
		t.Error("unknown is a filter value for v1")
	}
}

// TestShortRulesReadUnknownWhenTheReadingIsNotCurrent holds the two short
// rules to the v1 reading: a stale report or a missing value is unknown with
// its reason, a basis change leaves days to cover unknown, and a stock with no
// reported position still fails.
func TestShortRulesReadUnknownWhenTheReadingIsNotCurrent(t *testing.T) {
	env := &evalEnv{}
	stale := Candidate{StockCode: "AAA", ShortReason: ReasonASICReportStale}
	if out := ruleShortInterest(&stale, env); out.Status != RuleUnknown || out.Reason != ReasonASICReportStale {
		t.Errorf("stale short interest: %+v, want unknown asic_report_stale", out)
	}
	if out := ruleDaysToCover(&stale, env); out.Status != RuleUnknown || out.Reason != ReasonASICReportStale {
		t.Errorf("stale days to cover: %+v, want unknown asic_report_stale", out)
	}

	basis := Candidate{StockCode: "AAA", ShortPct: new(9.0), DaysToCoverReason: ReasonBasisChange}
	if out := ruleDaysToCover(&basis, env); out.Status != RuleUnknown || out.Reason != ReasonBasisChange {
		t.Errorf("basis change: %+v, want unknown basis_change", out)
	}
	if out := ruleShortInterest(&basis, env); out.Status != RulePass {
		t.Errorf("a 9%% reading with a basis change still passes the short rule: %+v", out)
	}

	absent := Candidate{StockCode: "AAA"}
	if out := ruleShortInterest(&absent, env); out.Status != RuleFail {
		t.Errorf("no reported position: %+v, want fail", out)
	}
}
