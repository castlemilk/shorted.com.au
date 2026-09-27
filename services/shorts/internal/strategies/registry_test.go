package strategies

import (
	"math"
	"strings"
	"testing"
	"unicode"
)

func TestRegistryHasTheFourLaunchStrategiesInOrder(t *testing.T) {
	want := []string{IDZangerBreakout, IDCANSLIM, IDMinerviniTrendTemplate, IDCrowdedShortBreakout}
	got := Registry()
	if len(got) != len(want) {
		t.Fatalf("Registry() has %d strategies, want %d", len(got), len(want))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Errorf("Registry()[%d].ID = %q, want %q", i, got[i].ID, id)
		}
	}
	// The ids are binding (URLs, API and MCP arguments): pin the literals.
	if IDZangerBreakout != "zanger-breakout" || IDCANSLIM != "canslim" ||
		IDMinerviniTrendTemplate != "minervini-trend-template" || IDCrowdedShortBreakout != "crowded-short-breakout" {
		t.Fatal("a strategy id literal changed; ids are part of the public contract")
	}
}

func TestRegistryStructure(t *testing.T) {
	allowedSources := map[string]bool{SourceFundamentals: true, SourcePrices: true, SourceIndex: true, SourceShorts: true}
	seenIDs := map[string]bool{}
	for _, s := range Registry() {
		s := s
		t.Run(s.ID, func(t *testing.T) {
			if seenIDs[s.ID] {
				t.Fatalf("duplicate strategy id %q", s.ID)
			}
			seenIDs[s.ID] = true

			for name, v := range map[string]string{"name": s.Name, "author": s.Author, "tagline": s.Tagline} {
				if strings.TrimSpace(v) == "" {
					t.Errorf("%s is empty", name)
				}
			}
			if n := len(s.Description); n < 2 || n > 4 {
				t.Errorf("description has %d paragraphs, want 2-4", n)
			}
			for i, p := range s.Description {
				if len(p) < 120 {
					t.Errorf("description paragraph %d is too thin to be a paragraph (%d chars)", i, len(p))
				}
			}
			if len(s.Rules) == 0 {
				t.Fatal("no rules")
			}
			ruleIDs := map[string]bool{}
			core := 0
			for _, r := range s.Rules {
				if ruleIDs[r.ID] {
					t.Errorf("duplicate rule id %q", r.ID)
				}
				ruleIDs[r.ID] = true
				if r.Core {
					core++
				}
				if strings.TrimSpace(r.Title) == "" || strings.TrimSpace(r.RuleText) == "" || strings.TrimSpace(r.Evaluation) == "" {
					t.Errorf("rule %q has empty prose", r.ID)
				}
				if !allowedSources[r.DataSource] {
					t.Errorf("rule %q has data source %q, not one of the four allowed", r.ID, r.DataSource)
				}
				if _, ok := ruleFuncs[r.ID]; !ok {
					t.Errorf("rule %q has no evaluation function", r.ID)
				}
			}
			if core == 0 {
				t.Error("no core rule: nothing could ever trigger")
			}
			m := s.Metadata
			for name, v := range map[string]string{
				"style": m.Style, "holding_period": m.HoldingPeriod, "risk_posture": m.RiskPosture,
				"universe": m.Universe, "refresh_cadence": m.RefreshCadence,
			} {
				if strings.TrimSpace(v) == "" {
					t.Errorf("metadata.%s is empty", name)
				}
			}
			if len(s.Caveats) == 0 {
				t.Error("no caveats")
			}
			if len(s.Sources) == 0 {
				t.Error("no sources")
			}
			if len(s.TriggerRules) == 0 {
				t.Error("no trigger rules: status setup would be unreachable")
			}
			for _, id := range s.TriggerRules {
				found := false
				for _, r := range s.Rules {
					if r.ID == id {
						found = true
						if !r.Core {
							t.Errorf("trigger rule %q is not core; only core rules gate the ladder", id)
						}
					}
				}
				if !found {
					t.Errorf("trigger rule %q is not a rule of this strategy", id)
				}
			}
			regimeCore := false
			for _, r := range s.Rules {
				if r.ID == RuleRegime && r.Core {
					regimeCore = true
				}
			}
			if s.RegimeGates != regimeCore {
				t.Errorf("RegimeGates = %v but regime rule core = %v; the verdict would contradict the ladder", s.RegimeGates, regimeCore)
			}
			// Every strategy must be able to exclude sub-cent stocks: the
			// caveat promises it, so liquidity must gate triggering.
			liquidityCore := false
			for _, r := range s.Rules {
				if r.ID == RuleLiquidity && r.Core {
					liquidityCore = true
				}
			}
			if !liquidityCore {
				t.Error("liquidity is not a core rule, but every strategy's caveats promise sub-cent stocks are excluded")
			}
		})
	}
}

// The core sets are a design decision (plan §1 + the stream brief); pin them
// so a change is deliberate.
func TestCoreRuleSets(t *testing.T) {
	want := map[string][]string{
		IDZangerBreakout:         {RuleGrowth, RuleBase, RuleBreakout, RuleRegime, RuleLiquidity},
		IDCANSLIM:                {RuleEPSGrowth, RuleNearHigh, RuleRSLeader, RuleRegime, RuleLiquidity},
		IDMinerviniTrendTemplate: {RuleTrendStack, RuleSMA200Rising, RuleAboveLow, RuleOffHigh, RuleRSLeader, RuleLiquidity},
		IDCrowdedShortBreakout:   {RuleShortInterest, RuleBreakout, RuleLiquidity},
	}
	for _, s := range Registry() {
		got := s.CoreRuleIDs()
		if strings.Join(got, ",") != strings.Join(want[s.ID], ",") {
			t.Errorf("%s core rules = %v, want %v", s.ID, got, want[s.ID])
		}
	}
}

func TestWeightsCoverEveryRule(t *testing.T) {
	registry := map[string]Strategy{}
	for _, s := range Registry() {
		registry[s.ID] = s
		w, ok := ruleWeights[s.ID]
		if !ok {
			t.Errorf("%s has no weights", s.ID)
			continue
		}
		sum := 0.0
		for _, r := range s.Rules {
			weight, ok := w[r.ID]
			if !ok {
				t.Errorf("%s rule %q has no weight", s.ID, r.ID)
			}
			if weight <= 0 {
				t.Errorf("%s rule %q weight %v must be positive", s.ID, r.ID, weight)
			}
			sum += weight
		}
		if len(w) != len(s.Rules) {
			t.Errorf("%s has %d weights for %d rules", s.ID, len(w), len(s.Rules))
		}
		if math.Abs(sum-1) > 1e-9 {
			t.Errorf("%s weights sum to %v, want 1", s.ID, sum)
		}
	}
	for id := range ruleWeights {
		if _, ok := registry[id]; !ok {
			t.Errorf("weights exist for unknown strategy %q", id)
		}
	}
}

// allStrings walks every UI-facing string a strategy produces.
func allStrings(s Strategy) []string {
	out := []string{s.ID, s.Name, s.Author, s.Tagline,
		s.Metadata.Style, s.Metadata.HoldingPeriod, s.Metadata.RiskPosture, s.Metadata.Universe, s.Metadata.RefreshCadence}
	out = append(out, s.Description...)
	out = append(out, s.CaveatsWithCoverage(812, 1904)...)
	out = append(out, s.CaveatsWithCoverage(0, -1)...)
	out = append(out, s.Sources...)
	for _, r := range s.Rules {
		out = append(out, r.ID, r.Title, r.RuleText, r.Evaluation, r.DataSource)
	}
	for _, label := range []string{RegimeUptrend, RegimeNeutral, RegimeDowntrend, ""} {
		out = append(out, s.RegimeVerdict(Regime{IndexCode: "XJO", Label: label}), NeutralRegimeVerdict(Regime{Label: label}))
	}
	return out
}

// DESIGN.md: no em dashes in UI copy. En dashes are banned too; they are the
// same defect wearing a shorter coat.
func TestProseHasNoDashCharactersOrStrayWhitespace(t *testing.T) {
	for _, s := range Registry() {
		for _, str := range allStrings(s) {
			if strings.ContainsRune(str, '—') {
				t.Errorf("%s: em dash in %q", s.ID, str)
			}
			if strings.ContainsRune(str, '–') {
				t.Errorf("%s: en dash in %q", s.ID, str)
			}
			if str != strings.TrimSpace(str) {
				t.Errorf("%s: leading/trailing whitespace in %q", s.ID, str)
			}
			if strings.Contains(str, "  ") {
				t.Errorf("%s: double space in %q", s.ID, str)
			}
			for _, r := range str {
				if r > unicode.MaxASCII && r != '’' {
					t.Errorf("%s: unexpected non-ASCII rune %q in %q", s.ID, r, str)
					break
				}
			}
		}
	}
}

// The evaluation prose must state the numbers the code actually uses.
func TestEvaluationProseStatesTheThresholds(t *testing.T) {
	mustContain := map[string][]string{
		RuleGrowth:        {"25%", "loss to a net profit", "Unknown when neither", "half-year result from the company's own filing", "same half a year earlier"},
		RuleBase:          {"at least 20 sessions", "25% deep", "base low", "do not classify its shape"},
		RuleBreakout:      {"last 5 sessions", "40 sessions", "1.5 times the 50-day average", "pivot"},
		RuleRegime:        {"50-day", "200-day", "downtrend"},
		RuleRS:            {"3-month", "above zero"},
		RuleLiquidity:     {"A$250,000", "20 sessions", "sub-cent", "2 decimal places"},
		RuleEPSGrowth:     {"25%", "half-yearly", "loss to a net profit", "company's own filing", "same half a year earlier"},
		RuleRevenueGrowth: {"20%", "company's own filing", "same half a year earlier"},
		RuleNearHigh:      {"within 5%", "52-week high"},
		RuleRSLeader:      {"top quartile", "75th percentile", "6-month"},
		RuleTrendStack:    {"150-day", "200-day"},
		RuleSMA200Rising:  {"200-day", "one month"},
		RuleAboveLow:      {"1.3 times", "52-week low"},
		RuleOffHigh:       {"25% below", "52-week high"},
		RuleAboveSMA50:    {"50-day"},
		RuleShortInterest: {"5% of shares on issue", "ASIC"},
		RuleDaysToCover:   {"20-day average daily volume", "5 days"},
	}
	for _, s := range Registry() {
		for _, r := range s.Rules {
			for _, frag := range mustContain[r.ID] {
				if !strings.Contains(r.Evaluation, frag) {
					t.Errorf("%s/%s evaluation does not mention %q: %s", s.ID, r.ID, frag, r.Evaluation)
				}
			}
		}
	}
}

func TestSourcesAndCaveatsCarryTheRequiredAttributions(t *testing.T) {
	need := map[string][]string{
		IDZangerBreakout:         {"Fortune", "December 2000", "Guinness", "29,233%"},
		IDCANSLIM:                {"How to Make Money in Stocks", "O'Neil"},
		IDMinerviniTrendTemplate: {"Trade Like a Stock Market Wizard"},
		IDCrowdedShortBreakout:   {"ASIC"},
	}
	for _, s := range Registry() {
		joined := strings.Join(s.Sources, "\n")
		for _, frag := range need[s.ID] {
			if !strings.Contains(joined, frag) {
				t.Errorf("%s sources do not mention %q", s.ID, frag)
			}
		}
		caveats := strings.Join(s.Caveats, "\n")
		if !strings.Contains(caveats, "sub-cent") {
			t.Errorf("%s caveats do not explain the sub-cent exclusion", s.ID)
		}
		if !strings.Contains(caveats, "not financial advice") && !strings.Contains(caveats, "Nothing here is financial advice") {
			t.Errorf("%s caveats do not carry the not-advice line", s.ID)
		}
	}
	z, _ := Lookup(IDZangerBreakout)
	if !strings.Contains(strings.Join(z.Caveats, "\n"), "we do not classify cup-and-handle") {
		t.Error("zanger caveats must say we detect a base but do not classify its shape")
	}
}

func TestCaveatsWithCoverage(t *testing.T) {
	for _, s := range Registry() {
		got := s.CaveatsWithCoverage(812, 1904)
		if s.UsesFundamentals() {
			if len(got) != len(s.Caveats)+1 {
				t.Fatalf("%s: want the coverage caveat prepended", s.ID)
			}
			if got[0] != "Reported fundamentals cover 812 of the 1904 stocks evaluated. Where growth data is missing the growth rules read unknown, never pass, so those stocks cannot trigger." {
				t.Errorf("%s: coverage caveat = %q", s.ID, got[0])
			}
			generic := s.CaveatsWithCoverage(0, -1)[0]
			if strings.ContainsAny(generic, "0123456789") {
				t.Errorf("%s: unmeasured coverage caveat must not state numbers: %q", s.ID, generic)
			}
		} else if len(got) != len(s.Caveats) {
			t.Errorf("%s reads no fundamentals and must not carry a coverage caveat", s.ID)
		}
	}
	uses := map[string]bool{}
	for _, s := range Registry() {
		uses[s.ID] = s.UsesFundamentals()
	}
	if !uses[IDZangerBreakout] || !uses[IDCANSLIM] || uses[IDMinerviniTrendTemplate] || uses[IDCrowdedShortBreakout] {
		t.Errorf("UsesFundamentals = %v", uses)
	}
}

func TestLookup(t *testing.T) {
	for _, s := range Registry() {
		got, ok := Lookup(s.ID)
		if !ok || got.ID != s.ID {
			t.Errorf("Lookup(%q) = %q, %v", s.ID, got.ID, ok)
		}
	}
	for _, id := range []string{"", "ZANGER-BREAKOUT", "zanger", "canslim "} {
		if _, ok := Lookup(id); ok {
			t.Errorf("Lookup(%q) found a strategy; ids are exact", id)
		}
	}
}

func TestRegistryReturnsFreshCopies(t *testing.T) {
	a := Registry()
	a[0].Name = "mutated"
	a[0].Rules[0].Title = "mutated"
	a[0].Caveats[0] = "mutated"
	b := Registry()
	if b[0].Name == "mutated" || b[0].Rules[0].Title == "mutated" || b[0].Caveats[0] == "mutated" {
		t.Fatal("Registry() shares state between calls")
	}
}

func TestRegimeVerdicts(t *testing.T) {
	down := Regime{IndexCode: "XJO", Label: RegimeDowntrend}
	for _, s := range Registry() {
		v := s.RegimeVerdict(down)
		if s.RegimeGates && !strings.HasPrefix(v, "Stand aside: ") {
			t.Errorf("%s downtrend verdict = %q, want a Stand aside sentence", s.ID, v)
		}
		if !s.RegimeGates && !strings.HasPrefix(v, "Caution: ") {
			t.Errorf("%s downtrend verdict = %q, want a Caution sentence (regime does not gate it)", s.ID, v)
		}
		if !strings.Contains(v, "XJO") {
			t.Errorf("%s verdict does not name the index: %q", s.ID, v)
		}
		if u := s.RegimeVerdict(Regime{}); !strings.HasPrefix(u, "Market regime unavailable") || !strings.Contains(u, "XJO") {
			t.Errorf("%s unknown-regime verdict = %q", s.ID, u)
		}
		for _, label := range []string{RegimeUptrend, RegimeNeutral} {
			if v := s.RegimeVerdict(Regime{Label: label}); strings.HasPrefix(v, "Stand aside") {
				t.Errorf("%s %s verdict must not say stand aside: %q", s.ID, label, v)
			}
		}
	}
	if v := NeutralRegimeVerdict(Regime{Label: RegimeUptrend}); !strings.HasPrefix(v, "Uptrend: XJO") {
		t.Errorf("neutral uptrend verdict = %q", v)
	}
	if v := NeutralRegimeVerdict(Regime{Label: "sideways"}); !strings.HasPrefix(v, "Market regime unavailable") {
		t.Errorf("an unrecognised label must read as unavailable, got %q", v)
	}
}
