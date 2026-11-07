package backtest

import (
	"fmt"
	"math"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// CoverageMinPct is the short position a name must report to qualify for the
// Crowded-Short measure: the rule's own threshold, 5% of shares on issue.
const CoverageMinPct = 5.0

// The two coverage measures. Every coverage figure names which one it uses.
const (
	MeasureQualifying  = "qualifying_5pct_short"
	MeasureAllReported = "all_reported"
)

// Survivorship measurement values, machine-readable.
const (
	MeasurementMeasured      = "measured"
	MeasurementASICOnly      = "asic_reported_only"
	MeasurementNotMeasurable = "not_measurable"
	DirectionFlatters        = "flatters"
)

// reportSet resolves R*(t): the newest complete ASIC report published by t, as
// the short reading does. It holds each report's rows by code.
type reportSet struct {
	cal     *calendar.Calendar
	reports *features.Reports
	dates   []civil.Date // report dates, ascending
	rows    map[civil.Date]map[string]features.ASICRow
}

// newReportSet indexes the run's ASIC rows under the calendar of version s.
func newReportSet(in Inputs, s spec.Spec) (*reportSet, error) {
	pin, mkt, err := pipelineInputs(in)
	if err != nil {
		return nil, err
	}
	idx := pipeline.NewIndex(pin, s)
	rs := &reportSet{
		cal:     idx.Calendar(),
		reports: features.NewReports(mkt.ASIC, mkt.Ingests),
		rows:    map[civil.Date]map[string]features.ASICRow{},
	}
	for _, row := range mkt.ASIC {
		if rs.rows[row.ReportDate] == nil {
			rs.rows[row.ReportDate] = map[string]features.ASICRow{}
			rs.dates = append(rs.dates, row.ReportDate)
		}
		rs.rows[row.ReportDate][row.Code] = row
	}
	sort.Slice(rs.dates, func(i, j int) bool { return rs.dates[i].Before(rs.dates[j]) })
	return rs, nil
}

// at is R*(t) and its date, false when no complete report is public on t.
func (rs *reportSet) at(t civil.Date) (civil.Date, bool) {
	i := sort.Search(len(rs.dates), func(i int) bool { return rs.dates[i].After(t) })
	for i--; i >= 0; i-- {
		d := rs.dates[i]
		if rs.cal.Usable(d, t) && rs.reports.Complete(d) {
			return d, true
		}
	}
	return civil.Date{}, false
}

// ordinaryRows are the rows of R*(t) whose codes are ordinary shares, the
// universe's own rule for a reported name.
func (rs *reportSet) ordinaryRows(in Inputs, t civil.Date) map[string]features.ASICRow {
	d, ok := rs.at(t)
	if !ok {
		return nil
	}
	mkt := in.Market()
	out := map[string]features.ASICRow{}
	for code, row := range rs.rows[d] {
		if instrument.IneligibleReason(code, row.Product, mkt.Names[code], row.Issued, mkt.ETPs, true) != "" {
			continue
		}
		out[code] = row
	}
	return out
}

// qualifying are the ordinary rows of R*(t) with a finite percentage at or above
// min.
func qualifying(rows map[string]features.ASICRow, min float64) []string {
	var out []string
	for code, row := range rows {
		if row.Percent != nil && finite(*row.Percent) && *row.Percent >= min {
			out = append(out, code)
		}
	}
	sort.Strings(out)
	return out
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// CoveragePeriod is the coverage of one year or one month: name-days that qualify
// and the ones with a bar on their session.
type CoveragePeriod struct {
	Period     string
	Qualifying int
	Priced     int
	// Ratio is Priced / Qualifying. It is shown only when Qualifying is positive.
	Ratio float64
}

// CoverageMeasure is coverage under one measure, by year, month and the window.
type CoverageMeasure struct {
	Measure string
	Years   []CoveragePeriod
	Months  []CoveragePeriod
	Total   CoveragePeriod
}

// Coverage is both measures over the same sessions. Every figure built from it
// names its measure.
type Coverage struct {
	Qualifying  CoverageMeasure
	AllReported CoverageMeasure
}

// MeasureCoverage counts, per session of sessions, the name-days of R*(t) under
// both measures and how many of them have a priced bar on the session. The
// qualifying measure counts ordinary names reporting at least minPct; the
// all-reported measure counts every ordinary name in R*(t).
func MeasureCoverage(in Inputs, s spec.Spec, sessions []civil.Date, minPct float64) (Coverage, error) {
	rs, err := newReportSet(in, s)
	if err != nil {
		return Coverage{}, err
	}
	pin, _, err := pipelineInputs(in)
	if err != nil {
		return Coverage{}, err
	}
	q := newPeriods(MeasureQualifying)
	a := newPeriods(MeasureAllReported)
	for _, t := range sessions {
		rows := rs.ordinaryRows(in, t)
		for _, code := range qualifying(rows, minPct) {
			q.add(t, 1, barOn(pin.Bars[code], t) != nil)
		}
		for code := range rows {
			a.add(t, 1, barOn(pin.Bars[code], t) != nil)
		}
	}
	return Coverage{Qualifying: q.finish(), AllReported: a.finish()}, nil
}

// periods accumulates name-days by year, month and the whole window.
type periods struct {
	measure string
	years   map[string]*CoveragePeriod
	months  map[string]*CoveragePeriod
	total   CoveragePeriod
}

func newPeriods(measure string) *periods {
	return &periods{measure: measure, years: map[string]*CoveragePeriod{}, months: map[string]*CoveragePeriod{}}
}

func (p *periods) add(t civil.Date, n int, priced bool) {
	y := fmt.Sprintf("%04d", t.Year)
	m := fmt.Sprintf("%04d-%02d", t.Year, t.Month)
	for _, bucket := range []struct {
		m map[string]*CoveragePeriod
		k string
	}{{p.years, y}, {p.months, m}} {
		if bucket.m[bucket.k] == nil {
			bucket.m[bucket.k] = &CoveragePeriod{Period: bucket.k}
		}
		bump(bucket.m[bucket.k], n, priced)
	}
	bump(&p.total, n, priced)
}

func bump(c *CoveragePeriod, n int, priced bool) {
	c.Qualifying += n
	if priced {
		c.Priced += n
	}
}

func (p *periods) finish() CoverageMeasure {
	out := CoverageMeasure{Measure: p.measure, Total: p.total}
	out.Total.Ratio = ratio(p.total)
	for _, c := range p.years {
		c.Ratio = ratio(*c)
		out.Years = append(out.Years, *c)
	}
	for _, c := range p.months {
		c.Ratio = ratio(*c)
		out.Months = append(out.Months, *c)
	}
	sort.Slice(out.Years, func(i, j int) bool { return out.Years[i].Period < out.Years[j].Period })
	sort.Slice(out.Months, func(i, j int) bool { return out.Months[i].Period < out.Months[j].Period })
	return out
}

func ratio(c CoveragePeriod) float64 {
	if c.Qualifying == 0 {
		return 0
	}
	return float64(c.Priced) / float64(c.Qualifying)
}

// Survivorship is the survivorship block a run carries. Measurement is
// machine-readable; Copy and Caveat are what the page prints.
type Survivorship struct {
	Measurement string
	Direction   string
	Copy        string
	Caveat      string
}

// The statement a run with measured coverage prints.
const survivorshipCopy = "Prices are missing for companies that delisted before about 2025. " +
	"Heavily shorted companies that later failed are over-represented among them, so these results flatter the strategy, " +
	"most in the earlier years; by how much cannot be measured."

// SurvivorshipOf is the block of recipe r. A Minervini run adds the measurement
// caveat, and an approximate run (fundamentals from period end plus two months)
// is not measurable.
func SurvivorshipOf(r spec.Recipe) Survivorship {
	if r.Fundamentals == spec.FundamentalsApprox {
		return Survivorship{
			Measurement: MeasurementNotMeasurable,
			Direction:   DirectionFlatters,
			Copy: "Only companies still listed in September 2026 have fundamentals, so these results flatter the strategy; " +
				"by how much cannot be measured.",
		}
	}
	if r.StrategyID == spec.StrategyMinerviniTrend {
		return Survivorship{
			Measurement: MeasurementASICOnly,
			Direction:   DirectionFlatters,
			Copy:        survivorshipCopy,
			Caveat: "Coverage is measured on ASIC-reported names only; the gap cannot be measured for companies " +
				"that were never reported short.",
		}
	}
	return Survivorship{Measurement: MeasurementMeasured, Direction: DirectionFlatters, Copy: survivorshipCopy}
}

// DataQuality counts what a run excluded or could not price: delisting
// exits, corporate-action exits and suspects, fallback closes, price-return
// positions, capacity caps and the entries cancelled on each reason.
type DataQuality struct {
	DelistingExits      int
	CorporateActionExit int
	CASuspects          int
	FallbackClose       int
	PriceReturnTrades   int
	CapacityCapped      int
	StaleMarkTrades     int
	DelayedExits        int
	CancelledEntries    map[string]int
	DividendsCredited   int
}

// DataQualityOf counts a run's trades and events.
func DataQualityOf(res Result) DataQuality {
	dq := DataQuality{CancelledEntries: map[string]int{}}
	for _, t := range res.Trades {
		if t.OpenAtEnd {
			continue
		}
		switch t.ExitReason {
		case ReasonDelisted:
			dq.DelistingExits++
		case ReasonCorporateAction:
			dq.CorporateActionExit++
		}
		for _, f := range t.Flags {
			switch f {
			case FlagFallbackClose:
				dq.FallbackClose++
			case FlagPriceReturnOnly:
				dq.PriceReturnTrades++
			case FlagCapacityCapped:
				dq.CapacityCapped++
			case FlagStaleMarks:
				dq.StaleMarkTrades++
			}
		}
	}
	for _, e := range res.Events {
		switch e.Kind {
		case EventEntryCancelled:
			dq.CancelledEntries[e.Reason]++
		case EventExitDelayed:
			dq.DelayedExits++
		case EventDividendCredit:
			dq.DividendsCredited++
		}
	}
	return dq
}
