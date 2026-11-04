package engine

import (
	"testing"

	specpkg "github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// expectedV0Params is what each rule id's parameters must be in the v0 spec,
// read from the engine's own constants where the engine has one. The few
// literals with no constant (the volume multiple, the 150- and 200-day
// averages, the 21-session lag) are the values the evaluation functions use;
// the fs1 literals are pinned to their SQL by the spec package's test.
func expectedV0Params() map[string]map[string]float64 {
	return map[string]map[string]float64{
		"growth":                {"min_pct": growthMinPct},
		"eps_growth":            {"min_pct": growthMinPct},
		"revenue_growth":        {"min_pct": revenueGrowthMinPct},
		"base":                  {"min_sessions": baseMinSessions, "max_depth_pct": baseMaxDepthPct, "window_sessions": baseWindowSessions},
		"breakout":              {"window_sessions": breakoutWindowSessions, "prior_sessions": 40, "volume_multiple": 1.5, "volume_sessions": 50},
		"regime":                {"sma_fast": 50, "sma_slow": 200},
		"rs":                    {"lookback_months": 3, "min_points": 0},
		"liquidity":             {"min_aud": LiquidityFloorAUD, "sessions": 20},
		"near_high":             {"max_off_pct": nearHighMaxOffPct},
		"rs_leader":             {"quantile": rsLeaderQuantile},
		"trend_stack":           {"sma_mid": 150, "sma_slow": 200},
		"sma200_rising":         {"sma_slow": 200, "lag_sessions": 21},
		"above_low":             {"multiple": aboveLowMultiple},
		"off_high":              {"max_off_pct": offHighMaxOffPct},
		"above_sma50":           {"sma": 50},
		"short_interest":        {"min_pct": shortInterestMinPct},
		"days_to_cover":         {"min": daysToCoverMin},
		"roe":                   {"min_pct": roeMinPct},
		"net_margin":            {"min_pct": netMarginMinPct},
		"cash_conversion":       {"min": cashConversionMin},
		"leverage":              {"max_multiple": leverageMaxMultiple},
		"above_sma200":          {"sma": 200},
		"revenue_not_shrinking": {"min_pct": revenueNotShrinkingMin},
	}
}

// expectedFar is the proximity distance of each trigger rule (proximity.go).
var expectedFar = map[string]float64{
	"breakout":     breakoutFarPct,
	"near_high":    nearHighFarPct,
	"off_high":     offHighFarPct,
	"rs_leader":    rsLeaderFarPoints,
	"above_sma200": aboveSMA200FarPct,
}

// TestV0SpecMatchesCode pins the v0 registered spec to the engine: the same
// strategies, rules in the same order with the same roles, weights, far
// distances and parameters, and the same score shares, regime and ladder
// behaviour. The engine keeps its constants, so a change to either side fails
// here until both agree.
func TestV0SpecMatchesCode(t *testing.T) {
	ids := map[string]string{
		IDZangerBreakout:         specpkg.StrategyZangerBreakout,
		IDCANSLIM:                specpkg.StrategyCANSLIM,
		IDMinerviniTrendTemplate: specpkg.StrategyMinerviniTrend,
		IDCrowdedShortBreakout:   specpkg.StrategyCrowdedShortBreakout,
		IDQualityCompounders:     specpkg.StrategyQualityCompounders,
	}
	// The ids are binding (URLs, API and MCP arguments): the spec's names must
	// be the engine's literals.
	for engineID, specID := range ids {
		if engineID != specID {
			t.Errorf("spec strategy id %q does not match engine id %q", specID, engineID)
		}
	}
	want := expectedV0Params()
	strategies := Registry()
	if len(strategies) != len(ids) {
		t.Fatalf("engine has %d strategies, the spec pins %d", len(strategies), len(ids))
	}
	for _, s := range strategies {
		live, ok := specpkg.Live(ids[s.ID])
		if !ok {
			t.Fatalf("no live spec for %s", s.ID)
		}
		sp := live.Spec
		if !live.Live || live.Label != "v0" {
			t.Errorf("%s: live version is %q, want v0", s.ID, live.Label)
		}
		if len(sp.Rules) != len(s.Rules) {
			t.Fatalf("%s: spec has %d rules, engine has %d", s.ID, len(sp.Rules), len(s.Rules))
		}
		triggers := triggerRuleSet(s)
		for i, r := range s.Rules {
			sr := sp.Rules[i]
			if sr.ID != r.ID {
				t.Errorf("%s rule %d: spec %q, engine %q", s.ID, i, sr.ID, r.ID)
				continue
			}
			if _, ok := ruleFuncs[r.ID]; !ok {
				t.Errorf("%s/%s: no evaluation function", s.ID, r.ID)
			}
			if sr.Core != r.Core {
				t.Errorf("%s/%s: core spec %v, engine %v", s.ID, r.ID, sr.Core, r.Core)
			}
			if sr.Trigger != triggers[r.ID] {
				t.Errorf("%s/%s: trigger spec %v, engine %v", s.ID, r.ID, sr.Trigger, triggers[r.ID])
			}
			if sr.Weight != ruleWeights[s.ID][r.ID] {
				t.Errorf("%s/%s: weight spec %v, engine %v", s.ID, r.ID, sr.Weight, ruleWeights[s.ID][r.ID])
			}
			wantFar := 0.0
			if triggers[r.ID] {
				wantFar = expectedFar[r.ID]
			}
			if sr.Far != wantFar {
				t.Errorf("%s/%s: far spec %v, engine %v", s.ID, r.ID, sr.Far, wantFar)
			}
			wantParams, ok := want[r.ID]
			if !ok {
				t.Errorf("%s/%s: no pinned parameters", s.ID, r.ID)
				continue
			}
			if len(sr.Params) != len(wantParams) {
				t.Errorf("%s/%s: spec params %v, want keys %v", s.ID, r.ID, sr.Params, wantParams)
			}
			for k, v := range wantParams {
				if got, ok := sr.Params[k]; !ok || got != v {
					t.Errorf("%s/%s: param %s = %v, engine %v", s.ID, r.ID, k, got, v)
				}
			}
		}
	}

	live, _ := specpkg.Live(specpkg.StrategyZangerBreakout)
	if sc := live.Spec.Score; sc.PassFloor != passFloor || sc.PassStrength != passStrength || sc.TriggerCredit != triggerCredit {
		t.Errorf("score spec %+v, engine %v %v %v", sc, passFloor, passStrength, triggerCredit)
	}
	if live.Spec.Regime.Index != DefaultIndexCode || live.Spec.Regime.SMAFast != 50 || live.Spec.Regime.SMASlow != 200 {
		t.Errorf("regime spec %+v, engine index %s", live.Spec.Regime, DefaultIndexCode)
	}
	if live.Spec.Ladder.UnknownStatus || !live.Spec.Ladder.PickRequiresStockPass {
		t.Errorf("ladder spec %+v: v0 must read an unknown trigger as setup and need a stock pass", live.Spec.Ladder)
	}
	if got := live.Spec.Features.Params["breakout_volume_multiple"]; got != 1.5 {
		t.Errorf("fs1 volume multiple %v", got)
	}

	// The moving-average rules pass only strictly above their average, so a
	// close exactly at it fails. The spec's compare must say so, because the
	// compare is part of the hashed rules and is shown to the reader.
	for _, c := range []struct {
		strategy, rule string
		fn             ruleFunc
		at             Candidate
	}{
		{specpkg.StrategyMinerviniTrend, "above_sma50", ruleAboveSMA50, Candidate{Close: 10, SMA50: new(float64(10))}},
		{specpkg.StrategyQualityCompounders, "above_sma200", ruleAboveSMA200, Candidate{Close: 10, SMA200: new(float64(10))}},
	} {
		live, _ := specpkg.Live(c.strategy)
		found := false
		for _, r := range live.Spec.Rules {
			if r.ID != c.rule {
				continue
			}
			found = true
			if r.Compare != ">" {
				t.Errorf("%s/%s: spec compare %q, the engine passes only on >", c.strategy, c.rule, r.Compare)
			}
		}
		if !found {
			t.Errorf("%s: spec has no rule %s", c.strategy, c.rule)
		}
		var env evalEnv
		if out := c.fn(&c.at, &env); out.Status == RulePass {
			t.Errorf("%s/%s: a close equal to its average passes in the engine", c.strategy, c.rule)
		}
	}

	// The ladder behaviour the spec describes: an unknown trigger is not a
	// pass, so with every other core rule passing it reads as setup.
	zanger, _ := Lookup(IDZangerBreakout)
	var results []RuleResult
	for _, r := range zanger.Rules {
		st := RulePass
		if r.ID == RuleBreakout {
			st = RuleUnknown
		}
		results = append(results, RuleResult{RuleID: r.ID, Status: st})
	}
	if got := Ladder(zanger, results); got != StatusSetup {
		t.Errorf("unknown trigger read as %v, the v0 spec says setup", got)
	}
}

// TestSpecEngineMajorMatches checks that the spec's engine major is the
// engine's, so a semantic engine change cannot leave the old hashes in place.
func TestSpecEngineMajorMatches(t *testing.T) {
	if specpkg.EngineMajor != Major {
		t.Fatalf("spec.EngineMajor = %d, engine.Major = %d", specpkg.EngineMajor, Major)
	}
}
