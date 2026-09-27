package strategies

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// outcome is what one rule function returns for one stock: the status, a
// human-readable detail, the number it tested (when there is one), and a 0..1
// strength that grades how decisively a PASS passed (ignored otherwise).
type outcome struct {
	Status   RuleStatus
	Detail   string
	Value    float64
	HasValue bool
	Strength float64
}

// evalEnv is the per-Evaluate context rules may read: the market regime and
// cross-sectional statistics of the evaluated universe.
type evalEnv struct {
	regime Regime
	rs6m   quartile
}

type ruleFunc func(c *Candidate, env *evalEnv) outcome

// ruleFuncs maps every rule id to its single evaluation function.
var ruleFuncs = map[string]ruleFunc{
	RuleGrowth:        ruleGrowth,
	RuleBase:          ruleBase,
	RuleBreakout:      ruleBreakout,
	RuleRegime:        ruleRegime,
	RuleRS:            ruleRS,
	RuleLiquidity:     ruleLiquidity,
	RuleEPSGrowth:     ruleEPSGrowth,
	RuleRevenueGrowth: ruleRevenueGrowth,
	RuleNearHigh:      ruleNearHigh,
	RuleRSLeader:      ruleRSLeader,
	RuleTrendStack:    ruleTrendStack,
	RuleSMA200Rising:  ruleSMA200Rising,
	RuleAboveLow:      ruleAboveLow,
	RuleOffHigh:       ruleOffHigh,
	RuleAboveSMA50:    ruleAboveSMA50,
	RuleShortInterest: ruleShortInterest,
	RuleDaysToCover:   ruleDaysToCover,
}

// Thresholds. Named so the tests and the prose in registry.go can be checked
// against one number each.
const (
	growthMinPct        = 25.0
	revenueGrowthMinPct = 20.0
	baseMinSessions     = 20
	// baseWindowSessions is the view's base window ([t-40, t-1] as at the anchor
	// session), so base_length_days is always 1..40 and this is the only ceiling.
	baseWindowSessions = 40
	baseMaxDepthPct    = 25.0
	// breakoutWindowSessions is how far back breakout_recent looks (plan §2.3).
	breakoutWindowSessions = 5
	nearHighMaxOffPct      = -5.0
	offHighMaxOffPct       = -25.0
	aboveLowMultiple       = 1.3
	shortInterestMinPct    = 5.0
	daysToCoverMin         = 5.0
	rsLeaderQuantile       = 0.75

	// tolerance absorbs float noise on derived comparisons (1.3 x low).
	tolerance = 1e-9
)

func pass(detail string, value float64, hasValue bool, strength float64) outcome {
	return outcome{Status: RulePass, Detail: detail, Value: value, HasValue: hasValue, Strength: clamp01(strength)}
}

func fail(detail string, value float64, hasValue bool) outcome {
	return outcome{Status: RuleFail, Detail: detail, Value: value, HasValue: hasValue}
}

func unknown(detail string) outcome {
	return outcome{Status: RuleUnknown, Detail: detail}
}

// ---------------------------------------------------------------- growth

// ruleGrowth (Zanger): revenue YoY >= 25% OR EPS YoY >= 25% OR a swing from a
// net loss to a net profit. Unknown only when BOTH growth figures are missing
// and there is no turnaround to go on.
func ruleGrowth(c *Candidate, _ *evalEnv) outcome {
	g := c.Growth
	if g == nil {
		return unknown("No reported fundamentals for this stock yet")
	}
	rev, eps := g.RevenueYoYPct, g.EPSYoYPct
	turn := g.Turnaround()

	var parts []string
	if rev != nil {
		parts = append(parts, growthPhrase("Revenue", *rev, g.RevenueYoYPriorPct, revenueLabel(g)))
	}
	if eps != nil {
		parts = append(parts, growthPhrase("EPS", *eps, g.EPSYoYPriorPct, epsLabel(g)))
	}
	if turn {
		parts = append(parts, "swung from a net loss to a net profit")
	}
	parts = append(parts, halfYearEvidence(g)...)

	best, hasBest := maxKnown(rev, eps)
	passed := (rev != nil && *rev >= growthMinPct) || (eps != nil && *eps >= growthMinPct) || turn
	switch {
	case passed:
		strength := 0.5 // a turnaround alone
		if hasBest && best >= growthMinPct {
			strength = (best - growthMinPct) / 75 // +100% scores full marks
		}
		return pass(sentence(parts), best, hasBest, strength)
	case rev == nil && eps == nil:
		return unknown("No revenue or EPS growth figure yet")
	default:
		return fail(sentence(append(parts, "below the +25% threshold")), best, hasBest)
	}
}

// ruleEPSGrowth (CAN SLIM C and A): EPS YoY >= 25% or a loss-to-profit swing.
func ruleEPSGrowth(c *Candidate, _ *evalEnv) outcome {
	g := c.Growth
	if g == nil {
		return unknown("No reported fundamentals for this stock yet")
	}
	eps := g.EPSYoYPct
	turn := g.Turnaround()
	var parts []string
	if eps != nil {
		parts = append(parts, growthPhrase("EPS", *eps, g.EPSYoYPriorPct, epsLabel(g)))
	}
	if turn {
		parts = append(parts, "swung from a net loss to a net profit")
	}
	switch {
	case eps != nil && *eps >= growthMinPct:
		return pass(sentence(parts), *eps, true, (*eps-growthMinPct)/75)
	case turn:
		if eps != nil {
			return pass(sentence(parts), *eps, true, 0.5)
		}
		return pass(sentence(parts), 0, false, 0.5)
	case eps == nil:
		return unknown("No EPS growth figure yet")
	default:
		return fail(sentence(append(parts, "below the +25% threshold")), *eps, true)
	}
}

// ruleRevenueGrowth (CAN SLIM): revenue YoY >= 20% on revenue_basis_period_type
// (latest annual, or the latest filed half vs the same half a year earlier).
func ruleRevenueGrowth(c *Candidate, _ *evalEnv) outcome {
	g := c.Growth
	if g == nil {
		return unknown("No reported fundamentals for this stock yet")
	}
	if g.RevenueYoYPct == nil {
		return unknown("No revenue growth figure yet")
	}
	rev := *g.RevenueYoYPct
	parts := append([]string{growthPhrase("Revenue", rev, g.RevenueYoYPriorPct, revenueLabel(g))}, halfYearEvidence(g)...)
	if rev >= revenueGrowthMinPct {
		return pass(sentence(parts), rev, true, (rev-revenueGrowthMinPct)/60)
	}
	return fail(sentence(append(parts, "below the +20% threshold")), rev, true)
}

// ---------------------------------------------------------------- price structure

// ruleBase (Zanger): base_length_days >= 20, base_depth_pct <= 25 and
// close >= base_low.
//
// mv_price_features anchors the base: with a breakout in the last 5 sessions
// the base columns describe the consolidation as at the breakout session (the
// level it cleared and how long it took to build), otherwise the 40 sessions
// before as_of. base_length_days counts from the FIRST session within 2% of
// the base high, so a flat base or a retest reads as its full length and the
// value is bounded by the 40-session window. There is therefore no upper bound
// to test here and nothing to special-case after a breakout.
func ruleBase(c *Candidate, _ *evalEnv) outcome {
	if c.BaseDepthPct == nil || c.BaseLengthDays == nil || c.BaseLow == nil {
		return unknown("Base cannot be measured from price history yet")
	}
	depth, length, low := *c.BaseDepthPct, int(*c.BaseLengthDays), *c.BaseLow

	var reasons []string
	if length < baseMinSessions {
		reasons = append(reasons, fmt.Sprintf("only %d sessions since the pivot high was first set, under %d", length, baseMinSessions))
	}
	if depth > baseMaxDepthPct {
		reasons = append(reasons, fmt.Sprintf("%.1f%% deep, deeper than 25%%", depth))
	}
	if c.Close < low {
		reasons = append(reasons, fmt.Sprintf("close %s is below the base low %s", price(c.Close), price(low)))
	}
	if len(reasons) > 0 {
		return fail("No tight base: "+strings.Join(reasons, "; "), depth, true)
	}
	detail := fmt.Sprintf("%d-session base, %.1f%% deep; close %s holds above the base low %s", length, depth, price(c.Close), price(low))
	return pass(detail, depth, true, (baseMaxDepthPct-depth)/20)
}

// ruleBreakout: breakout_recent (a close above the prior-40 high on
// volume_ratio_50d >= 1.5 within the last 5 sessions). The value is the close
// relative to the pivot, in percent.
func ruleBreakout(c *Candidate, _ *evalEnv) outcome {
	if c.BreakoutRecent == nil {
		return unknown("Breakout cannot be measured from price history yet")
	}
	value, hasValue := 0.0, false
	if c.BaseHigh != nil && *c.BaseHigh > 0 {
		value, hasValue = (c.Close / *c.BaseHigh - 1)*100, true
	}
	if *c.BreakoutRecent {
		detail := "Broke out in the last 5 sessions"
		strength := 0.5
		if c.BreakoutDate != nil {
			detail = "Broke out on " + day(*c.BreakoutDate)
			if !c.AsOf.IsZero() {
				daysSince := c.AsOf.Sub(*c.BreakoutDate).Hours() / 24
				strength = 1 - daysSince/7
			}
		}
		detail += ": a close above the prior 40-session high on at least 1.5x average volume"
		// mv_price_features anchors the base at the breakout session, so
		// base_high is the level the stock cleared: the invalidation level.
		if c.BaseHigh != nil {
			detail += fmt.Sprintf("; pivot %s", price(*c.BaseHigh))
		}
		return pass(detail, value, hasValue, strength)
	}
	detail := "No close above the prior 40-session high on 1.5x volume in the last 5 sessions"
	if c.BaseHigh != nil {
		detail = fmt.Sprintf("No close above the %s pivot on 1.5x volume in the last 5 sessions", price(*c.BaseHigh))
		if hasValue {
			detail += fmt.Sprintf("; close is %s from the pivot", pct(value))
		}
	}
	return fail(detail, value, hasValue)
}

// ruleNearHigh (CAN SLIM N): pct_off_52w_high >= -5.
func ruleNearHigh(c *Candidate, _ *evalEnv) outcome {
	if c.PctOff52wHigh == nil {
		return unknown("No 52-week high yet")
	}
	off := *c.PctOff52wHigh
	if off >= nearHighMaxOffPct {
		return pass(offHighPhrase(off), off, true, (off-nearHighMaxOffPct)/-nearHighMaxOffPct)
	}
	return fail(offHighPhrase(off)+", more than 5% away", off, true)
}

// ruleOffHigh (Minervini): pct_off_52w_high >= -25.
func ruleOffHigh(c *Candidate, _ *evalEnv) outcome {
	if c.PctOff52wHigh == nil {
		return unknown("No 52-week high yet")
	}
	off := *c.PctOff52wHigh
	if off >= offHighMaxOffPct {
		return pass(offHighPhrase(off), off, true, (off-offHighMaxOffPct)/-offHighMaxOffPct)
	}
	return fail(offHighPhrase(off)+", more than 25% away", off, true)
}

// ruleTrendStack (Minervini): close > sma150 > sma200.
func ruleTrendStack(c *Candidate, _ *evalEnv) outcome {
	if c.SMA150 == nil || c.SMA200 == nil || *c.SMA200 <= 0 {
		return unknown("Not enough history for the 150-day and 200-day averages")
	}
	s150, s200 := *c.SMA150, *c.SMA200
	value := (c.Close/s200 - 1) * 100
	detail := fmt.Sprintf("Close %s, 150-day %s, 200-day %s", price(c.Close), price(s150), price(s200))
	if c.Close > s150 && s150 > s200 {
		return pass(detail+": stacked in order", value, true, value/50)
	}
	var reasons []string
	if c.Close <= s150 {
		reasons = append(reasons, "close is not above the 150-day")
	}
	if s150 <= s200 {
		reasons = append(reasons, "150-day is not above the 200-day")
	}
	return fail(detail+": "+strings.Join(reasons, "; "), value, true)
}

// ruleSMA200Rising (Minervini): sma200 > sma200_1m_ago.
func ruleSMA200Rising(c *Candidate, _ *evalEnv) outcome {
	if c.SMA200 == nil || c.SMA200_1mAgo == nil || *c.SMA200_1mAgo <= 0 {
		return unknown("Not enough history to compare the 200-day average with a month ago")
	}
	now, then := *c.SMA200, *c.SMA200_1mAgo
	slope := (now/then - 1) * 100
	detail := fmt.Sprintf("200-day average %s vs %s a month ago (%s)", price(now), price(then), pct(slope))
	if now > then {
		return pass(detail, slope, true, slope/5)
	}
	return fail(detail+": not rising", slope, true)
}

// ruleAboveLow (Minervini): close >= 1.3 x low_52w.
func ruleAboveLow(c *Candidate, _ *evalEnv) outcome {
	if c.Low52w == nil || *c.Low52w <= 0 {
		return unknown("No 52-week low yet")
	}
	low := *c.Low52w
	ratio := c.Close / low
	value := (ratio - 1) * 100
	detail := fmt.Sprintf("Close %s is %s above the 52-week low of %s", price(c.Close), pctAbs(value), price(low))
	if c.Close >= aboveLowMultiple*low-tolerance {
		return pass(detail, value, true, (ratio-aboveLowMultiple)/1.7)
	}
	return fail(detail+", under the 30% minimum", value, true)
}

// ruleAboveSMA50 (Minervini): close > sma50.
func ruleAboveSMA50(c *Candidate, _ *evalEnv) outcome {
	if c.SMA50 == nil || *c.SMA50 <= 0 {
		return unknown("Not enough history for the 50-day average")
	}
	s50 := *c.SMA50
	value := (c.Close/s50 - 1) * 100
	detail := fmt.Sprintf("Close %s vs 50-day average %s (%s)", price(c.Close), price(s50), pct(value))
	if c.Close > s50 {
		return pass(detail, value, true, value/20)
	}
	return fail(detail, value, true)
}

// ---------------------------------------------------------------- market and relative strength

// ruleRegime: pass on uptrend or neutral, fail on downtrend, unknown without
// an index row. The value is the index close relative to its 200-day.
func ruleRegime(_ *Candidate, env *evalEnv) outcome {
	r := env.regime
	if !r.Known() {
		return unknown("Not enough recent S&P/ASX 200 data to read the market trend")
	}
	code := indexCode(r)
	value, hasValue := 0.0, false
	if r.Close != nil && r.SMA200 != nil && *r.SMA200 > 0 {
		value, hasValue = (*r.Close / *r.SMA200 - 1)*100, true
	}
	switch r.Label {
	case RegimeUptrend:
		return pass(code+" in an uptrend: above its 50-day average, with the 50-day above the 200-day", value, hasValue, 1)
	case RegimeNeutral:
		return pass(code+" neutral: above its 200-day average without a rising 50-day stack", value, hasValue, 0.5)
	default:
		return fail(code+" in a downtrend: below its 200-day average", value, hasValue)
	}
}

// ruleRS (Zanger, crowded short): rs_3m_pct > 0.
func ruleRS(c *Candidate, _ *evalEnv) outcome {
	if c.RS3mPct == nil {
		return unknown("Not enough history for 3-month relative strength")
	}
	rs := *c.RS3mPct
	if rs > 0 {
		return pass(fmt.Sprintf("Beat the S&P/ASX 200 by %.1f points over 3 months", rs), rs, true, rs/30)
	}
	if rs == 0 {
		return fail("Matched the S&P/ASX 200 over 3 months", rs, true)
	}
	return fail(fmt.Sprintf("Lagged the S&P/ASX 200 by %.1f points over 3 months", -rs), rs, true)
}

// ruleRSLeader (CAN SLIM L, Minervini): rs_6m_pct at or above the 75th
// percentile of the evaluated universe.
func ruleRSLeader(c *Candidate, env *evalEnv) outcome {
	if c.RS6mPct == nil || !env.rs6m.ok {
		return unknown("Not enough history for 6-month relative strength")
	}
	rs, q := *c.RS6mPct, env.rs6m
	if rs >= q.threshold-tolerance {
		strength := 1.0
		if q.max > q.threshold {
			strength = (rs - q.threshold) / (q.max - q.threshold)
		}
		return pass(fmt.Sprintf("6-month relative strength %s points, in the top quartile (cut-off %s)", signed(rs), signed(q.threshold)), rs, true, strength)
	}
	return fail(fmt.Sprintf("6-month relative strength %s points, below the top-quartile cut-off of %s", signed(rs), signed(q.threshold)), rs, true)
}

// ruleLiquidity: dollar_volume_20d >= A$250,000.
func ruleLiquidity(c *Candidate, _ *evalEnv) outcome {
	if c.DollarVolume20d == nil {
		return unknown("Not enough history to measure turnover")
	}
	dv := *c.DollarVolume20d
	detail := money(dv) + " average daily turnover over 20 sessions"
	if dv >= LiquidityFloorAUD {
		return pass(detail, dv, true, math.Log10(dv/LiquidityFloorAUD)/2) // A$25M scores full marks
	}
	return fail(detail+", below the A$250k floor", dv, true)
}

// ---------------------------------------------------------------- short interest

// ruleShortInterest: short_pct >= 5. No reported position is a fail, not an
// unknown: absence from the ASIC report means no reportable short.
func ruleShortInterest(c *Candidate, _ *evalEnv) outcome {
	if c.ShortPct == nil {
		return fail("No reported short position", 0, false)
	}
	s := *c.ShortPct
	detail := fmt.Sprintf("%.2f%% of shares on issue reported short", s)
	if s >= shortInterestMinPct {
		return pass(detail, s, true, (s-shortInterestMinPct)/10)
	}
	return fail(detail+", under 5%", s, true)
}

// ruleDaysToCover: days_to_cover >= 5.
func ruleDaysToCover(c *Candidate, _ *evalEnv) outcome {
	if c.ShortPct == nil {
		return fail("No reported short position", 0, false)
	}
	if c.DaysToCover == nil {
		return unknown("No recent volume to measure days to cover")
	}
	d := *c.DaysToCover
	detail := fmt.Sprintf("%.1f days of average volume to cover", d)
	if d >= daysToCoverMin {
		return pass(detail, d, true, (d-daysToCoverMin)/10)
	}
	return fail(detail+", under 5", d, true)
}

// ---------------------------------------------------------------- formatting

func clamp01(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func maxKnown(vals ...*float64) (float64, bool) {
	best, ok := 0.0, false
	for _, v := range vals {
		if v != nil && (!ok || *v > best) {
			best, ok = *v, true
		}
	}
	return best, ok
}

func pct(v float64) string    { return fmt.Sprintf("%+.1f%%", v) }
func pctAbs(v float64) string { return fmt.Sprintf("%.1f%%", v) }
func signed(v float64) string { return fmt.Sprintf("%+.1f", v) }
func day(t time.Time) string  { return t.Format("2006-01-02") }

func price(v float64) string { return fmt.Sprintf("A$%.2f", v) }

func money(v float64) string {
	switch {
	case v >= 1e9:
		return fmt.Sprintf("A$%.1fb", v/1e9)
	case v >= 1e6:
		return fmt.Sprintf("A$%.1fm", v/1e6)
	case v >= 1e3:
		return fmt.Sprintf("A$%.0fk", v/1e3)
	default:
		return fmt.Sprintf("A$%.0f", v)
	}
}

// sentence joins detail fragments and capitalises the first letter.
func sentence(parts []string) string {
	s := strings.Join(parts, "; ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func growthPhrase(label string, yoy float64, prior *float64, basis string) string {
	s := fmt.Sprintf("%s %s YoY", label, pct(yoy))
	if basis != "" {
		s += " (" + basis + ")"
	}
	if prior != nil && yoy > *prior {
		s += fmt.Sprintf(", accelerating from %s", pct(*prior))
	}
	return s
}

// revenueLabel names the series revenue growth is computed on
// (revenue_basis_period_type): the latest half-year from a company filing
// against the same half a year earlier, or the latest annual.
func revenueLabel(g *Growth) string {
	if g.RevenueBasisPeriodType == "half" {
		return halfLabel(g)
	}
	if g.LatestAnnualPeriodEnd != nil {
		return "FY ending " + day(*g.LatestAnnualPeriodEnd)
	}
	return "annual"
}

// halfLabel names a half-on-half comparison.
func halfLabel(g *Growth) string {
	if g.HalfLatestPeriodEnd != nil {
		return "half-year to " + day(*g.HalfLatestPeriodEnd) + " vs same half a year earlier"
	}
	return "half-year vs same half a year earlier"
}

// epsLabel names the series EPS growth is computed on (basis_period_type).
func epsLabel(g *Growth) string {
	switch g.BasisPeriodType {
	case "half":
		if g.HalfLatestPeriodEnd == nil && g.LatestPeriodEnd != nil {
			return "half-year to " + day(*g.LatestPeriodEnd) + " vs same half a year earlier"
		}
		return halfLabel(g)
	case "ttm":
		if g.LatestPeriodEnd != nil {
			return "12 months to " + day(*g.LatestPeriodEnd)
		}
		return "trailing 12 months"
	case "annual":
		if g.LatestAnnualPeriodEnd != nil {
			return "FY ending " + day(*g.LatestAnnualPeriodEnd)
		}
		if g.LatestPeriodEnd != nil {
			return "FY ending " + day(*g.LatestPeriodEnd)
		}
		return "annual"
	}
	return ""
}

// halfYearEvidence reports a latest half that beat the same half a year
// earlier. Sign only, never a percentage, and never a pass condition.
//
// When revenue is already measured on the half basis the revenue line would
// restate the headline figure, so it is left out.
func halfYearEvidence(g *Growth) []string {
	var out []string
	if g.RevenueBasisPeriodType != "half" && g.RevenueHalfDelta != nil && *g.RevenueHalfDelta > 0 {
		out = append(out, "latest half-year revenue up on the same half a year earlier")
	}
	if g.NetIncomeHalfDelta != nil && *g.NetIncomeHalfDelta > 0 {
		out = append(out, "latest half-year profit up on the same half a year earlier")
	}
	return out
}

func offHighPhrase(off float64) string {
	if off >= 0 {
		return "At its 52-week high"
	}
	return fmt.Sprintf("%.1f%% below the 52-week high", -off)
}

func indexCode(r Regime) string {
	if r.IndexCode != "" {
		return r.IndexCode
	}
	return DefaultIndexCode
}
