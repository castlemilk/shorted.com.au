package engine

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// evaluateGoldenPath is the engine's output golden: the ranked picks and the
// rule outcomes of every registered strategy over a fixed set of candidates, in
// an uptrend and in a downtrend. It is the engine output that
// TestEngineVersionBumpedWithGoldens holds Version to.
const evaluateGoldenPath = "testdata/evaluate.golden"

// The golden's inputs are defined here and nowhere else. A fixture shared with
// other tests (zangerReady, qualityReady, uptrend) would move the golden every
// time one of those tests needed a different stock, and with it the engine
// version's digest.
var (
	goldenAsOf      = *d("2026-09-25")
	goldenUptrend   = Regime{IndexCode: "XJO", Label: RegimeUptrend, Close: new(float64(8800)), SMA50: new(float64(8600)), SMA200: new(float64(8200)), AsOf: d("2026-09-25")}
	goldenDowntrend = Regime{IndexCode: "XJO", Label: RegimeDowntrend, Close: new(float64(8000)), SMA50: new(float64(8600)), SMA200: new(float64(8200)), AsOf: d("2026-09-25")}
	// goldenNeutral is above its 200-day average without a rising 50-day stack,
	// so the regime rule passes at its neutral strength.
	goldenNeutral = Regime{IndexCode: "XJO", Label: RegimeNeutral, Close: new(float64(8300)), SMA50: new(float64(8400)), SMA200: new(float64(8200)), AsOf: d("2026-09-25")}
)

// goldenRegimes are the market regimes the golden renders every strategy in.
func goldenRegimes() []struct {
	name   string
	regime Regime
} {
	return []struct {
		name   string
		regime Regime
	}{{"uptrend", goldenUptrend}, {"neutral", goldenNeutral}, {"downtrend", goldenDowntrend}}
}

// goldenStock is a stock that passes every price, liquidity, relative strength,
// growth and short rule of every strategy, with a 6-month relative strength of
// 20 and a 52-week-high distance of -4.76%. Each golden candidate edits it to
// move one or more rules, so every rule is reached both ways.
func goldenStock(code string) Candidate {
	return Candidate{
		StockCode:       code,
		AsOf:            goldenAsOf,
		Close:           100,
		SMA10:           new(float64(99)),
		SMA20:           new(float64(98)),
		SMA50:           new(float64(90)),
		SMA150:          new(float64(80)),
		SMA200:          new(float64(75)),
		SMA200_1mAgo:    new(float64(72)),
		High52w:         new(float64(105)),
		Low52w:          new(float64(60)),
		PctOff52wHigh:   new(float64(-4.76)),
		DollarVolume20d: new(float64(30_000_000)),
		BaseHigh:        new(float64(98)),
		BaseLow:         new(float64(90)),
		BaseDepthPct:    new(float64(8)),
		BaseLengthDays:  new(int32(30)),
		BreakoutRecent:  new(true),
		BreakoutDate:    d("2026-09-24"),
		RS3mPct:         new(float64(12)),
		RS6mPct:         new(float64(20)),
		ShortPct:        new(float64(9)),
		DaysToCover:     new(float64(8)),
		Growth: &Growth{
			BasisPeriodType: "ttm",
			RevenueYoYPct:   new(float64(40)),
			EPSYoYPct:       new(float64(50)),
		},
	}
}

// goldenQuality is a profitable, cash-generative, modestly geared company.
// Every quality rule passes on it.
func goldenQuality() *Quality {
	return &Quality{
		BasisPeriodType: "annual", BasisPeriodEnd: d("2026-06-30"), Currency: "AUD", BalanceCurrency: "AUD",
		Revenue: new(1e9), NetIncome: new(2e8), FreeCashFlow: new(1.9e8), EBITDA: new(3.5e8),
		TotalEquity: new(1e9), TotalAssets: new(2e9), TotalDebt: new(4e8), NetDebt: new(3e8),
		NetMarginPct: new(float64(20)), ROEPct: new(float64(21)),
	}
}

// goldenCandidates are the fixed candidates of the golden. Each name says what
// it is built to show.
func goldenCandidates() []Candidate {
	return []Candidate{
		// Passes every rule of every strategy: the leader.
		goldenStock("LDR"),
		// Near misses: a 52-week-high distance just past 5% (near_high fails
		// close to its line), a close 2.9% under the pivot without the volume
		// (breakout fails just short of its line), and a 6-month strength under
		// the leader cut-off.
		golden("NRM", func(c *Candidate) {
			c.PctOff52wHigh = new(float64(-8))
			c.BreakoutRecent = new(false)
			c.BaseHigh = new(float64(103))
			c.RS6mPct = new(float64(12))
		}),
		// Deep under the high (off_high passes with a small strength, near_high
		// fails far away), with the trend stack and the 50-day both failing.
		golden("DEEP", func(c *Candidate) {
			c.PctOff52wHigh = new(float64(-22))
			c.SMA150 = new(float64(102))
			c.SMA50 = new(float64(105))
			c.BaseLengthDays = new(int32(10))
			c.RS6mPct = new(float64(18))
			c.Low52w = new(float64(85))
		}),
		// Revenue growth passes and EPS growth falls short: the EPS rules fail
		// with a value while the stock stays a pick on its revenue. Its 6-month
		// strength sits between the cut-off and the top of the universe, and
		// its turnover between the floor and the full-marks level, so both
		// rules pass with a graded strength.
		golden("SLO", func(c *Candidate) {
			c.Growth = &Growth{BasisPeriodType: "ttm", RevenueYoYPct: new(float64(40)), EPSYoYPct: new(float64(10))}
			c.RS6mPct = new(float64(22))
			c.DollarVolume20d = new(float64(5_000_000))
		}),
		// Fails nearly every price and short rule with a value, and the
		// relative strength rules with a value.
		golden("WEK", func(c *Candidate) {
			c.PctOff52wHigh = new(float64(-30))
			c.SMA200_1mAgo = new(float64(80))
			c.Low52w = new(float64(90))
			c.RS6mPct = new(float64(-5))
			c.RS3mPct = new(float64(-3))
			c.DollarVolume20d = new(float64(100_000))
			c.Growth = &Growth{BasisPeriodType: "ttm", RevenueYoYPct: new(float64(12)), EPSYoYPct: new(float64(10))}
			c.ShortPct = new(float64(3))
			c.DaysToCover = new(float64(2))
			c.SMA50 = new(float64(110))
		}),
		// Crowded short: both short rules pass, with different strengths.
		golden("SHT", func(c *Candidate) {
			c.ShortPct = new(float64(7))
			c.DaysToCover = new(float64(9))
			c.RS6mPct = new(float64(25))
			c.PctOff52wHigh = new(float64(-2))
		}),
		// Short interest far above the threshold (full strength) and days to
		// cover just under its threshold.
		golden("HOT", func(c *Candidate) {
			c.ShortPct = new(float64(15))
			c.DaysToCover = new(float64(4.5))
			c.RS6mPct = new(float64(14))
		}),
		// No reported short position: a fail with no value on both short rules.
		// Growth and the 52-week high are missing, so their unknowns show too.
		golden("NSH", func(c *Candidate) {
			c.ShortPct = nil
			c.DaysToCover = nil
			c.Growth = nil
			c.PctOff52wHigh = nil
			c.BreakoutRecent = nil
		}),
		// A reported short position with no volume to divide by.
		golden("NDC", func(c *Candidate) {
			c.ShortPct = new(float64(6))
			c.DaysToCover = nil
			c.PctOff52wHigh = nil
		}),
		// Quality compounders: every quality rule passes with a value.
		golden("QLY", func(c *Candidate) {
			c.SMA200 = new(float64(90))
			c.Growth = &Growth{BasisPeriodType: "annual", RevenueYoYPct: new(float64(6)), LatestAnnualPeriodEnd: d("2026-06-30")}
			c.Quality = goldenQuality()
		}),
		// Quality compounders: every quality rule fails with a value, and the
		// 200-day trigger misses by a little.
		golden("QFL", func(c *Candidate) {
			c.SMA200 = new(float64(110))
			c.Growth = &Growth{BasisPeriodType: "annual", RevenueYoYPct: new(float64(-5)), LatestAnnualPeriodEnd: d("2026-06-30")}
			q := goldenQuality()
			q.ROEPct = new(float64(9))
			q.NetMarginPct = new(float64(5))
			q.FreeCashFlow = new(1e8)
			q.NetDebt = new(9e8)
			c.Quality = q
		}),
		// Quality compounders: a loss makes cash conversion a fail with no
		// value, a negative margin fails with one, and net cash passes leverage.
		golden("QNL", func(c *Candidate) {
			c.SMA200 = new(float64(75))
			c.Growth = &Growth{BasisPeriodType: "annual", RevenueYoYPct: new(float64(6)), LatestAnnualPeriodEnd: d("2026-06-30")}
			q := goldenQuality()
			q.NetIncome = new(float64(-1e8))
			q.NetMarginPct = new(float64(-10))
			q.ROEPct = nil
			q.NetDebt = new(float64(-2e8))
			c.Quality = q
		}),
		// A swing from a loss to a profit with no growth figure: the growth
		// rules pass on the turnaround alone, at its fixed strength.
		golden("TRN", func(c *Candidate) {
			c.Growth = &Growth{BasisPeriodType: "ttm", EPSLatest: new(0.12), EPSPrior: new(-0.05)}
		}),
		// Nothing but a price: every rule that needs more is unknown.
		{StockCode: "NIL", Close: 1},
	}
}

// golden is goldenStock with one candidate's edits applied.
func golden(code string, edit func(*Candidate)) Candidate {
	c := goldenStock(code)
	edit(&c)
	return c
}

// renderEvaluateOutput evaluates every registered strategy over the golden's
// candidates and renders the result line by line. Values are printed to six
// significant figures so a change in a score or a value shows, and a change of
// rounding noise does not.
func renderEvaluateOutput() string {
	cands := goldenCandidates()
	var b strings.Builder
	for _, s := range Registry() {
		for _, reg := range goldenRegimes() {
			fmt.Fprintf(&b, "== %s %s\n", s.ID, reg.name)
			for _, p := range Evaluate(s, cands, reg.regime) {
				fmt.Fprintf(&b, "%d %s %v score=%.6g\n", p.Rank, p.Candidate.StockCode, p.Status, p.Score)
				for _, r := range p.Rules {
					if r.HasValue {
						fmt.Fprintf(&b, "  %s %v value=%.6g\n", r.RuleID, r.Status, r.Value)
					} else {
						fmt.Fprintf(&b, "  %s %v\n", r.RuleID, r.Status)
					}
				}
			}
		}
	}
	return b.String()
}

// TestEvaluateGoldenReachesEveryRule holds the golden to its coverage. Every
// rule id is rendered at least once as a pass and once as a fail that carries a
// value. Each rule function is also called directly on every golden candidate:
// a rule must pass once with a strength strictly between 0 and 1, and a
// failing trigger rule must once carry a proximity strictly between 0 and 1.
// A grade that sits at a clamp is not moved by a change to the grading, so it
// does not count, and the golden would not notice that change.
func TestEvaluateGoldenReachesEveryRule(t *testing.T) {
	passed := map[string]bool{}
	failedWithValue := map[string]bool{}
	gradedPass := map[string]bool{}
	gradedTrigger := map[string]bool{}

	triggers := map[string]bool{}
	for _, s := range Registry() {
		for _, id := range s.TriggerRules {
			triggers[id] = true
		}
	}

	cands := goldenCandidates()
	for _, s := range Registry() {
		for _, reg := range goldenRegimes() {
			for _, p := range Evaluate(s, cands, reg.regime) {
				for _, r := range p.Rules {
					switch {
					case r.Status == RulePass:
						passed[r.RuleID] = true
					case r.Status == RuleFail && r.HasValue:
						failedWithValue[r.RuleID] = true
					}
				}
			}
		}
	}
	for _, reg := range goldenRegimes() {
		env := NewEnv(cands, reg.regime)
		for id, fn := range ruleFuncs {
			for i := range cands {
				out := fn(&cands[i], env)
				if out.Status == RulePass && out.Strength > 0 && out.Strength < 1 {
					gradedPass[id] = true
				}
				if out.Status == RuleFail && out.Proximity > 0 && out.Proximity < 1 {
					gradedTrigger[id] = true
				}
			}
		}
	}

	for id := range ruleFuncs {
		if !passed[id] {
			t.Errorf("rule %s never passes in the evaluate golden", id)
		}
		if !failedWithValue[id] {
			t.Errorf("rule %s never fails with a value in the evaluate golden", id)
		}
		if !gradedPass[id] {
			t.Errorf("rule %s never passes with a strength strictly between 0 and 1 in the evaluate golden", id)
		}
		if triggers[id] && !gradedTrigger[id] {
			t.Errorf("trigger rule %s never fails with a proximity strictly between 0 and 1 in the evaluate golden", id)
		}
	}
}

// TestEvaluateOutputIsPinned holds the engine's output to its golden. A change
// to any output is a change to what the engine means by its version: bump
// Version (TestEngineVersionBumpedWithGoldens) and regenerate the golden with
// UPDATE_ENGINE_GOLDENS=1 in the same commit.
func TestEvaluateOutputIsPinned(t *testing.T) {
	got := renderEvaluateOutput()
	if os.Getenv("UPDATE_ENGINE_GOLDENS") == "1" {
		if err := os.WriteFile(evaluateGoldenPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		return
	}
	want, err := os.ReadFile(evaluateGoldenPath)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if got == string(want) {
		return
	}
	gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
	for i := 0; i < len(gl) || i < len(wl); i++ {
		var g, w string
		if i < len(gl) {
			g = gl[i]
		}
		if i < len(wl) {
			w = wl[i]
		}
		if g != w {
			t.Fatalf("engine output differs from %s at line %d:\n got: %q\nwant: %q", evaluateGoldenPath, i+1, g, w)
		}
	}
}
