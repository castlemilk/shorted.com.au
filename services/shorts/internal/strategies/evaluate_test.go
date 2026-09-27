package strategies

import (
	"math"
	"math/rand"
	"reflect"
	"testing"
	"time"
)

var uptrend = Regime{IndexCode: "XJO", Label: RegimeUptrend, Close: f(8800), SMA50: f(8600), SMA200: f(8200), AsOf: d("2026-09-25")}

// zangerReady is a stock that passes every Zanger rule.
func zangerReady(code string) Candidate {
	return Candidate{
		StockCode:       code,
		AsOf:            *d("2026-09-25"),
		Close:           10,
		BaseHigh:        f(9.5),
		BaseLow:         f(8),
		BaseDepthPct:    f(15.8),
		BaseLengthDays:  i32(30),
		BreakoutRecent:  b(true),
		BreakoutDate:    d("2026-09-24"),
		DollarVolume20d: f(5_000_000),
		RS3mPct:         f(10),
		RS6mPct:         f(15),
		Growth:          &Growth{RevenueYoYPct: f(40), EPSYoYPct: f(50), BasisPeriodType: "ttm"},
	}
}

func TestQuantile(t *testing.T) {
	cases := []struct {
		name string
		in   []float64
		want float64
		ok   bool
	}{
		{"empty", nil, 0, false},
		{"one value", []float64{5}, 5, true},
		{"four values", []float64{1, 2, 3, 4}, 3.25, true},
		{"unsorted input", []float64{4, 1, 3, 2}, 3.25, true},
		{"eight values", []float64{1, 2, 3, 4, 5, 6, 7, 8}, 6.25, true},
		{"five values lands exactly", []float64{10, 20, 30, 40, 50}, 40, true},
		{"ties", []float64{7, 7, 7, 7}, 7, true},
		{"negatives", []float64{-30, -10, 0, 10, 20}, 10, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := append([]float64(nil), tc.in...)
			q := quantile(in, 0.75)
			if q.ok != tc.ok || math.Abs(q.threshold-tc.want) > 1e-9 {
				t.Fatalf("quantile(%v) = %+v, want threshold %v ok %v", tc.in, q, tc.want, tc.ok)
			}
			if !reflect.DeepEqual(in, append([]float64(nil), tc.in...)) {
				t.Error("quantile mutated its input")
			}
			if tc.ok {
				maxV := tc.in[0]
				for _, v := range tc.in {
					maxV = math.Max(maxV, v)
				}
				if q.max != maxV {
					t.Errorf("max = %v, want %v", q.max, maxV)
				}
			}
		})
	}
}

func TestRS6mQuartileIgnoresMissingAndNonFinite(t *testing.T) {
	cands := []Candidate{
		{RS6mPct: f(1)}, {RS6mPct: f(2)}, {RS6mPct: f(3)}, {RS6mPct: f(4)},
		{}, {RS6mPct: f(math.NaN())}, {RS6mPct: f(math.Inf(1))}, {RS6mPct: f(math.Inf(-1))},
	}
	q := computeRS6mQuartile(cands)
	if !q.ok || q.threshold != 3.25 || q.max != 4 {
		t.Fatalf("quartile = %+v, want 3.25 / max 4", q)
	}
	if computeRS6mQuartile([]Candidate{{}, {}}).ok {
		t.Error("a universe with no RS must not produce a cut-off")
	}
}

// In a universe of four, only the top name clears the top-quartile cut-off.
func TestEvaluateComputesTheQuartileOverTheEvaluatedUniverse(t *testing.T) {
	s, _ := Lookup(IDMinerviniTrendTemplate)
	var cands []Candidate
	for i, code := range []string{"AAA", "BBB", "CCC", "DDD"} {
		cands = append(cands, Candidate{StockCode: code, Close: 10, RS6mPct: f(float64(i + 1)), DollarVolume20d: f(1e6)})
	}
	picks := Evaluate(s, cands, uptrend)
	got := map[string]RuleStatus{}
	for _, p := range picks {
		for _, r := range p.Rules {
			if r.RuleID == RuleRSLeader {
				got[p.Candidate.StockCode] = r.Status
			}
		}
	}
	want := map[string]RuleStatus{"AAA": RuleFail, "BBB": RuleFail, "CCC": RuleFail, "DDD": RulePass}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rs_leader statuses = %v, want %v", got, want)
	}
	// Removing the leader moves the cut-off: the quartile is not a constant.
	picks = Evaluate(s, cands[:3], uptrend)
	for _, p := range picks {
		for _, r := range p.Rules {
			if r.RuleID == RuleRSLeader && p.Candidate.StockCode == "CCC" && r.Status != RulePass {
				t.Errorf("CCC should lead a three-stock universe, got %s", r.Status)
			}
		}
	}
}

func results(pairs ...string) []RuleResult {
	var out []RuleResult
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, RuleResult{RuleID: pairs[i], Status: RuleStatus(pairs[i+1])})
	}
	return out
}

func TestLadder(t *testing.T) {
	const P, F, U = "pass", "fail", "unknown"
	z, _ := Lookup(IDZangerBreakout)
	c, _ := Lookup(IDCANSLIM)
	m, _ := Lookup(IDMinerviniTrendTemplate)
	cs, _ := Lookup(IDCrowdedShortBreakout)

	cases := []struct {
		name     string
		strategy Strategy
		rules    []RuleResult
		want     PickStatus
	}{
		// Zanger: core growth, base, breakout, regime, liquidity; trigger breakout.
		{"zanger all core pass", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, P, RuleLiquidity, P, RuleRS, F), StatusTriggered},
		{"zanger non-core unknown still triggers", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, P, RuleLiquidity, P, RuleRS, U), StatusTriggered},
		{"zanger breakout not yet is setup", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, F, RuleRegime, P, RuleLiquidity, P, RuleRS, P), StatusSetup},
		{"zanger breakout unknown is setup", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, U, RuleRegime, P, RuleLiquidity, P), StatusSetup},
		{"zanger growth unknown cannot trigger", z, results(RuleGrowth, U, RuleBase, P, RuleBreakout, P, RuleRegime, P, RuleLiquidity, P), StatusWatch},
		{"zanger downtrend cannot trigger", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, F, RuleLiquidity, P), StatusWatch},
		{"zanger regime unknown cannot trigger", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, U, RuleLiquidity, P), StatusWatch},
		{"zanger illiquid cannot trigger", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, P, RuleLiquidity, F), StatusWatch},
		{"zanger no base and no breakout is watch", z, results(RuleGrowth, P, RuleBase, F, RuleBreakout, F, RuleRegime, P, RuleLiquidity, P), StatusWatch},
		{"zanger missing core result is not a pass", z, results(RuleGrowth, P, RuleBase, P, RuleBreakout, P, RuleRegime, P), StatusWatch},

		// CAN SLIM: core eps, near_high, rs_leader, regime, liquidity; triggers near_high + rs_leader.
		{"canslim all core", c, results(RuleEPSGrowth, P, RuleRevenueGrowth, F, RuleNearHigh, P, RuleRSLeader, P, RuleRegime, P, RuleLiquidity, P), StatusTriggered},
		{"canslim off the high is setup", c, results(RuleEPSGrowth, P, RuleNearHigh, F, RuleRSLeader, P, RuleRegime, P, RuleLiquidity, P), StatusSetup},
		{"canslim not yet a leader is setup", c, results(RuleEPSGrowth, P, RuleNearHigh, P, RuleRSLeader, F, RuleRegime, P, RuleLiquidity, P), StatusSetup},
		{"canslim neither trigger is still setup", c, results(RuleEPSGrowth, P, RuleNearHigh, F, RuleRSLeader, U, RuleRegime, P, RuleLiquidity, P), StatusSetup},
		{"canslim eps fail is watch", c, results(RuleEPSGrowth, F, RuleNearHigh, P, RuleRSLeader, P, RuleRegime, P, RuleLiquidity, P), StatusWatch},
		{"canslim downtrend is watch", c, results(RuleEPSGrowth, P, RuleNearHigh, P, RuleRSLeader, P, RuleRegime, F, RuleLiquidity, P), StatusWatch},

		// Minervini: triggers off_high + rs_leader.
		{"minervini all core", m, results(RuleTrendStack, P, RuleSMA200Rising, P, RuleAboveLow, P, RuleOffHigh, P, RuleRSLeader, P, RuleAboveSMA50, F, RuleLiquidity, P), StatusTriggered},
		{"minervini far from high is setup", m, results(RuleTrendStack, P, RuleSMA200Rising, P, RuleAboveLow, P, RuleOffHigh, F, RuleRSLeader, P, RuleLiquidity, P), StatusSetup},
		{"minervini rs unknown is setup", m, results(RuleTrendStack, P, RuleSMA200Rising, P, RuleAboveLow, P, RuleOffHigh, P, RuleRSLeader, U, RuleLiquidity, P), StatusSetup},
		{"minervini broken trend is watch", m, results(RuleTrendStack, F, RuleSMA200Rising, P, RuleAboveLow, P, RuleOffHigh, P, RuleRSLeader, P, RuleLiquidity, P), StatusWatch},
		{"minervini 200-day unknown is watch", m, results(RuleTrendStack, P, RuleSMA200Rising, U, RuleAboveLow, P, RuleOffHigh, P, RuleRSLeader, P, RuleLiquidity, P), StatusWatch},

		// Crowded short: core short_interest, breakout, liquidity; trigger breakout; regime NOT core.
		{"crowded triggers in a downtrend", cs, results(RuleShortInterest, P, RuleDaysToCover, F, RuleBreakout, P, RuleRegime, F, RuleLiquidity, P, RuleRS, F), StatusTriggered},
		{"crowded no breakout is setup", cs, results(RuleShortInterest, P, RuleBreakout, F, RuleLiquidity, P), StatusSetup},
		{"crowded not shorted is watch", cs, results(RuleShortInterest, F, RuleBreakout, P, RuleLiquidity, P), StatusWatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Ladder(tc.strategy, tc.rules); got != tc.want {
				t.Errorf("Ladder = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestEvaluateZangerEndToEnd(t *testing.T) {
	s, _ := Lookup(IDZangerBreakout)

	ready := zangerReady("RDY")

	setup := zangerReady("SET")
	setup.BreakoutRecent = b(false)
	setup.Close = 9.2

	noFundamentals := zangerReady("NOF")
	noFundamentals.Growth = nil

	illiquid := zangerReady("ILQ")
	illiquid.DollarVolume20d = f(50_000)

	nothing := Candidate{StockCode: "NIL", Close: 1} // every rule fails or is unknown

	picks := Evaluate(s, []Candidate{nothing, illiquid, noFundamentals, setup, ready}, uptrend)
	if len(picks) != 4 {
		t.Fatalf("got %d picks, want 4 (the stock passing nothing is dropped)", len(picks))
	}
	byCode := map[string]Pick{}
	for _, p := range picks {
		byCode[p.Candidate.StockCode] = p
	}
	if _, ok := byCode["NIL"]; ok {
		t.Error("a stock passing no rule must not be a pick")
	}
	wantStatus := map[string]PickStatus{"RDY": StatusTriggered, "SET": StatusSetup, "NOF": StatusWatch, "ILQ": StatusWatch}
	for code, want := range wantStatus {
		if got := byCode[code].Status; got != want {
			t.Errorf("%s status = %s, want %s", code, got, want)
		}
	}
	if picks[0].Candidate.StockCode != "RDY" || picks[1].Candidate.StockCode != "SET" {
		t.Errorf("order = %v, want RDY then SET first", codes(picks))
	}
	for i, p := range picks {
		if p.Rank != i+1 {
			t.Errorf("pick %d has rank %d", i, p.Rank)
		}
		if len(p.Rules) != len(s.Rules) {
			t.Errorf("%s has %d rule results, want %d", p.Candidate.StockCode, len(p.Rules), len(s.Rules))
		}
		for j, r := range p.Rules {
			if r.RuleID != s.Rules[j].ID {
				t.Errorf("rule results must follow the strategy's rule order: got %s at %d", r.RuleID, j)
			}
		}
		if p.Score < 0 || p.Score > 100 {
			t.Errorf("%s score %v outside 0..100", p.Candidate.StockCode, p.Score)
		}
	}
	// The unknown growth rule is reported as unknown, not silently dropped.
	for _, r := range byCode["NOF"].Rules {
		if r.RuleID == RuleGrowth && (r.Status != RuleUnknown || r.HasValue) {
			t.Errorf("NOF growth = %+v, want unknown with no value", r)
		}
	}
}

func TestEvaluateDowntrendBlocksGatingStrategiesOnly(t *testing.T) {
	down := Regime{IndexCode: "XJO", Label: RegimeDowntrend}
	z, _ := Lookup(IDZangerBreakout)
	for _, p := range Evaluate(z, []Candidate{zangerReady("RDY")}, down) {
		if p.Status == StatusTriggered || p.Status == StatusSetup {
			t.Errorf("zanger must not trigger or set up in a downtrend, got %s", p.Status)
		}
	}
	cs, _ := Lookup(IDCrowdedShortBreakout)
	squeeze := zangerReady("SQZ")
	squeeze.ShortPct = f(12)
	squeeze.DaysToCover = f(8)
	picks := Evaluate(cs, []Candidate{squeeze}, down)
	if len(picks) != 1 || picks[0].Status != StatusTriggered {
		t.Fatalf("crowded short should still trigger in a downtrend: %+v", picks)
	}
}

func TestEvaluateUnknownRegimeNeverTriggersAGatingStrategy(t *testing.T) {
	z, _ := Lookup(IDZangerBreakout)
	picks := Evaluate(z, []Candidate{zangerReady("RDY")}, Regime{})
	if len(picks) != 1 || picks[0].Status != StatusWatch {
		t.Fatalf("with no regime row the regime rule is unknown and nothing can trigger: %+v", picks)
	}
}

func TestEvaluateScoreBounds(t *testing.T) {
	z, _ := Lookup(IDZangerBreakout)
	max := zangerReady("MAX")
	max.BaseDepthPct = f(1)
	max.BreakoutDate = d("2026-09-25")
	max.DollarVolume20d = f(1e9)
	max.RS3mPct = f(80)
	max.Growth = &Growth{RevenueYoYPct: f(500)}
	picks := Evaluate(z, []Candidate{max}, uptrend)
	if len(picks) != 1 || picks[0].Score != 100 {
		t.Fatalf("a stock passing every rule decisively scores 100, got %+v", picks)
	}

	marginal := zangerReady("MRG")
	marginal.BaseDepthPct = f(25)
	marginal.BreakoutDate = d("2026-09-18")
	marginal.DollarVolume20d = f(250_000)
	marginal.RS3mPct = f(0.0001)
	marginal.Growth = &Growth{RevenueYoYPct: f(25)}
	neutral := Regime{IndexCode: "XJO", Label: RegimeNeutral}
	picks = Evaluate(z, []Candidate{marginal}, neutral)
	// Every rule passes at the floor except the neutral regime (half strength).
	want := 60 + 0.10*0.4*0.5*100
	if len(picks) != 1 || math.Abs(picks[0].Score-want) > 0.05 {
		t.Fatalf("a marginal pass-everything stock scores %v, got %+v", want, picks)
	}
}

func TestEvaluateOrderingIsTotalAndStable(t *testing.T) {
	z, _ := Lookup(IDZangerBreakout)
	var cands []Candidate
	// Identical candidates tie on status and score; stock code breaks the tie.
	for _, code := range []string{"DDD", "AAA", "CCC", "BBB"} {
		cands = append(cands, zangerReady(code))
	}
	strong := zangerReady("ZZZ")
	strong.Growth = &Growth{RevenueYoYPct: f(95)}
	cands = append(cands, strong)
	weakSetup := zangerReady("AAB")
	weakSetup.BreakoutRecent = b(false)
	cands = append(cands, weakSetup)

	want := []string{"ZZZ", "AAA", "BBB", "CCC", "DDD", "AAB"}
	got := codes(Evaluate(z, cands, uptrend))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 50; i++ {
		shuffled := append([]Candidate(nil), cands...)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		if got := codes(Evaluate(z, shuffled, uptrend)); !reflect.DeepEqual(got, want) {
			t.Fatalf("order depends on input order: %v", got)
		}
	}
}

func TestEvaluateDoesNotMutateItsInput(t *testing.T) {
	z, _ := Lookup(IDZangerBreakout)
	cands := []Candidate{zangerReady("BBB"), zangerReady("AAA")}
	before := append([]Candidate(nil), cands...)
	Evaluate(z, cands, uptrend)
	if !reflect.DeepEqual(cands, before) {
		t.Fatal("Evaluate reordered or mutated its input")
	}
}

func TestEvaluateEmptyUniverse(t *testing.T) {
	for _, s := range Registry() {
		picks := Evaluate(s, nil, Regime{})
		if picks == nil || len(picks) != 0 {
			t.Errorf("%s: an empty universe must give an empty, non-nil slice", s.ID)
		}
	}
}

func TestEvaluateNonFiniteValuesNeverLeak(t *testing.T) {
	m, _ := Lookup(IDMinerviniTrendTemplate)
	c := Candidate{StockCode: "NAN", Close: 10, SMA50: f(math.Inf(1)), DollarVolume20d: f(1e6)}
	for _, p := range Evaluate(m, []Candidate{c}, uptrend) {
		for _, r := range p.Rules {
			if math.IsNaN(r.Value) || math.IsInf(r.Value, 0) {
				t.Errorf("%s leaked a non-finite value %v", r.RuleID, r.Value)
			}
			if r.HasValue && (math.IsNaN(r.Value) || math.IsInf(r.Value, 0)) {
				t.Errorf("%s claims a value it cannot have", r.RuleID)
			}
		}
	}
}

func TestEveryStrategyEvaluatesARealisticUniverse(t *testing.T) {
	squeeze := zangerReady("SQZ")
	squeeze.ShortPct = f(9)
	squeeze.DaysToCover = f(7)
	trend := Candidate{
		StockCode: "TRD", AsOf: *d("2026-09-25"), Close: 20, SMA50: f(18), SMA150: f(16), SMA200: f(15), SMA200_1mAgo: f(14.5),
		Low52w: f(12), High52w: f(21), PctOff52wHigh: f(-4.8), RS6mPct: f(40), DollarVolume20d: f(3e6),
		Growth: &Growth{EPSYoYPct: f(30)},
	}
	cands := []Candidate{zangerReady("RDY"), squeeze, trend, {StockCode: "LAG", Close: 1, RS6mPct: f(-20), DollarVolume20d: f(1e6)}}
	want := map[string]string{
		IDZangerBreakout:         "RDY",
		IDCANSLIM:                "TRD",
		IDMinerviniTrendTemplate: "TRD",
		IDCrowdedShortBreakout:   "SQZ",
	}
	for _, s := range Registry() {
		picks := Evaluate(s, cands, uptrend)
		if len(picks) == 0 || picks[0].Status != StatusTriggered || picks[0].Candidate.StockCode != want[s.ID] {
			t.Errorf("%s: top pick = %v, want %s triggered", s.ID, summary(picks), want[s.ID])
		}
	}
}

func TestFundamentalsCoverageAndLatestAsOf(t *testing.T) {
	cands := []Candidate{
		{AsOf: *d("2026-09-24"), Growth: &Growth{RevenueYoYPct: f(1)}},
		{AsOf: *d("2026-09-25"), Growth: &Growth{EPSYoYPct: f(1)}},
		{AsOf: *d("2026-09-23"), Growth: &Growth{}}, // a row with no growth figure does not count
		{},
	}
	if got := FundamentalsCoverage(cands); got != 2 {
		t.Errorf("coverage = %d, want 2", got)
	}
	if got := LatestAsOf(cands); !got.Equal(*d("2026-09-25")) {
		t.Errorf("latest as_of = %v", got)
	}
	if !LatestAsOf(nil).Equal(time.Time{}) {
		t.Error("an empty universe has a zero as_of")
	}
}

func TestValidPickStatus(t *testing.T) {
	for _, s := range []string{"triggered", "setup", "watch"} {
		if !ValidPickStatus(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []string{"", "TRIGGERED", "all", "pass"} {
		if ValidPickStatus(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func codes(picks []Pick) []string {
	out := make([]string, len(picks))
	for i, p := range picks {
		out[i] = p.Candidate.StockCode
	}
	return out
}

func summary(picks []Pick) []string {
	out := make([]string, len(picks))
	for i, p := range picks {
		out[i] = p.Candidate.StockCode + ":" + string(p.Status)
	}
	return out
}
