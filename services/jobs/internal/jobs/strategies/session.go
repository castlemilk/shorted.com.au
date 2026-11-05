package strategies

import (
	"fmt"
	"math"
	"sort"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The daily job's pure half: it turns one session's loaded inputs into the
// stored feature rows, and evaluates stored rows under a version. Nothing here
// reads or writes a database, so the same session always gives the same rows.

const (
	// snapshotFeatureSet names the feature set the rows are written under (fs1).
	snapshotFeatureSet = "fs1"
	// snapshotPublicationLag is the short-report publication lag of the
	// latest-complete-published reading (sf1), in sessions.
	snapshotPublicationLag = 4
	// caUpjumpFrom is the first bar the unadjusted up-jump rule reads the
	// day after the last live price re-sync.
	caUpjumpFrom = "2026-09-29"
	// caGuardSessions is how long a known corporate-action suspect keeps a code
	// out of the ordinary universe (pipeline.caGuardSessions).
	caGuardSessions = 260
	// minPricedForOrdinary is the bar history the ordinary universe needs
	// (ordinary_fresh_60).
	minPricedForOrdinary = 60
	// asicWindowDays is the ASIC history the daily job loads: two years, for the
	// share counts the basis guard and the instrument rule read.
	asicWindowDays = 730
	// lookbackDays is the bar history the features read (barLookbackDays).
	lookbackDays = 400
	// priceFloorSessions is how many sessions before D the median count of
	// readiness rule (c) reads.
	priceFloorSessions = 10
	// readinessFraction is the share of the median priced-code count a session
	// must reach (readiness rule c).
	readinessFraction = 0.85
)

// sessionInputs is everything one session reads, loaded as of the session. The
// maps are keyed by upper-case stock code and iterated only through Codes.
type sessionInputs struct {
	D         civil.Date
	Codes     []string
	Bars      map[string][]features.Bar
	XJO       []features.IndexBar
	ASIC      []features.ASICRow
	Ingests   []features.ReportIngest
	ETP       map[string]bool
	Names     map[string]string
	Meta      map[string]pgsource.CompanyMeta
	Dividends map[string][]features.Dividend
	Fund      map[string]features.Fundamentals
}

// sessionRows is one session's stored output: the feature rows, the fundamentals
// bodies they point at, the regime, and the universe facts the run log records.
type sessionRows struct {
	Rows   []snapshot.Row
	Blobs  map[string]features.Fundamentals
	Regime engine.Regime
	Report civil.Date // the newest ASIC report on or before D; zero when none
	Avail  civil.Date // its publication date; zero when none
	XJOBar bool       // the index has a bar dated D
	Priced int        // codes with a priced bar dated D
}

// featureParams is the fs1 parameter set every version shares (spec.v0's).
func featureParams() (spec.FeatureSpec, error) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		return spec.FeatureSpec{}, fmt.Errorf("no live strategy version to take the feature parameters from")
	}
	return reg.Spec.Features, nil
}

// buildSessionRows computes one session's feature rows. A code with no bar on
// the session is still written, with its reason, so the stock page can say why
// it is not evaluated.
func buildSessionRows(in sessionInputs, fs spec.FeatureSpec) sessionRows {
	d := in.D
	cal := sessionCalendar(in)
	reports := features.NewReports(in.ASIC, in.Ingests)
	asicByCode := asicRowsByCode(in.ASIC)
	upjump, _ := civil.ParseDate(caUpjumpFrom)

	out := sessionRows{Blobs: map[string]features.Fundamentals{}}
	out.Regime = features.Regime(in.XJO, d)
	out.XJOBar = hasIndexBar(in.XJO, d)
	out.Report, out.Avail = latestReport(cal, in.ASIC, d)

	for _, code := range in.Codes {
		bars := in.Bars[code]
		asic := asicByCode[code]
		product, shares, _ := newestASIC(asic, d)
		name := in.Names[code]
		if name == "" {
			name = in.Meta[code].Name
		}

		pf, okPrice := features.AsOf(bars, in.XJO, d, fs)
		priced := pricedCount(bars, d.AddDays(-lookbackDays), d)
		barD, onD := barOn(bars, d)
		if onD {
			out.Priced++
		}

		known := features.KnownBy(features.CASuspects(bars, asic, cal, upjump), d)
		sf0 := features.ShortReadingV0(code, d, cal, reports, bars)
		sf1 := features.ShortReadingV1(code, d, cal, reports, bars, known, features.StaleAfterSessions)

		isOrd := instrument.IsOrdinary(code, product, name, shares, in.ETP)
		caGuarded := guardedBy(cal, known, d)
		reason := universeReason(onD, okPrice, priced, isOrd, code, product, name, shares, in.ETP, caGuarded)
		fresh := reason == ""

		row := snapshot.Row{
			AsOf:               d,
			BarDate:            lastBarOnOrBefore(bars, d),
			FeatureSet:         snapshotFeatureSet,
			StockCode:          code,
			IneligibleReason:   reason,
			ShortStatus:        sf1.Status,
			OrdinaryFresh60:    fresh,
			IsOrdinary:         isOrd,
			InASICReport:       sf1.InReport != nil && *sf1.InReport,
			ShortReportDate:    sf1.ReportDate,
			ShortAvailableDate: sf1.AvailableDate,
			CASuspectDate:      latestSuspect(known),
			Features: snapshot.Features{
				Bar:   barFeature(barD, onD),
				ExDiv: exDividend(in.Dividends[code], d),
				FS1:   pf,
				SF0:   sf0,
				SF1:   sf1,
			},
		}
		if !okPrice {
			row.Features.FS1 = features.PriceFeatures{}
		}
		if fund, ok := in.Fund[code]; ok && fund.Hash != "" {
			row.FundamentalsHash = fund.Hash
			out.Blobs[fund.Hash] = fund
		}
		meta, err := snapshot.EncodeMeta(snapshot.Meta{
			Name:           name,
			Industry:       in.Meta[code].Industry,
			LogoURL:        in.Meta[code].LogoURL,
			MarketCap:      in.Meta[code].MarketCap,
			PricedSessions: priced,
		})
		if err != nil {
			// The fields are plain strings and numbers: the encoder cannot fail on
			// them, so a failure here is a programming error.
			panic(err)
		}
		row.Meta = meta
		out.Rows = append(out.Rows, sanitiseRow(row))
	}
	sort.Slice(out.Rows, func(i, j int) bool { return out.Rows[i].StockCode < out.Rows[j].StockCode })
	return out
}

// universeReason is the v1 base universe's reason for a code, in the order the
// stock page reads them. Empty when the code is in the base universe.
func universeReason(onD, okPrice bool, priced int, isOrd bool, code, product, name string, shares float64, etp map[string]bool, caGuarded bool) string {
	if !onD {
		return snapshot.ReasonNoBarOnSession
	}
	if !okPrice || priced < minPricedForOrdinary {
		return snapshot.ReasonShortHistory
	}
	if !isOrd {
		if r := instrument.IneligibleReason(code, product, name, shares, etp, true); r != "" {
			return r
		}
	}
	if caGuarded {
		return "corporate_action_guard"
	}
	return ""
}

// sanitiseRow replaces non-finite floats, which JSON cannot store, with zero.
// A non-finite feature is a missing one by construction (features read NaN as
// "not a number"), so zero is written only where the feature is not present.
func sanitiseRow(r snapshot.Row) snapshot.Row {
	r.Features.Bar = sanitiseBar(r.Features.Bar)
	r.Features.ExDiv = finiteOr0(r.Features.ExDiv)
	return r
}

func sanitiseBar(b snapshot.Bar) snapshot.Bar {
	return snapshot.Bar{O: finiteOr0(b.O), H: finiteOr0(b.H), L: finiteOr0(b.L), C: finiteOr0(b.C), Adj: finiteOr0(b.Adj), V: finiteOr0(b.V)}
}

func finiteOr0(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// sessionCalendar is the session calendar of one run: the index's dates and
// the ASIC report dates, with the publication lag of the short reading.
func sessionCalendar(in sessionInputs) *calendar.Calendar {
	xjo := make([]civil.Date, 0, len(in.XJO))
	for _, b := range in.XJO {
		xjo = append(xjo, b.Date)
	}
	seen := map[civil.Date]bool{}
	var reports []civil.Date
	for _, r := range in.ASIC {
		if !seen[r.ReportDate] {
			seen[r.ReportDate] = true
			reports = append(reports, r.ReportDate)
		}
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Before(reports[j]) })
	return calendar.New(xjo, reports, snapshotPublicationLag)
}

// latestReport is the newest ASIC report on or before d and its publication date.
func latestReport(cal *calendar.Calendar, rows []features.ASICRow, d civil.Date) (civil.Date, civil.Date) {
	var newest civil.Date
	for _, r := range rows {
		if !r.ReportDate.After(d) && r.ReportDate.After(newest) {
			newest = r.ReportDate
		}
	}
	if newest.IsZero() {
		return civil.Date{}, civil.Date{}
	}
	avail, _ := cal.PublishedOn(newest)
	return newest, avail
}

// asicRowsByCode groups the ASIC rows by code, each group in report-date order.
func asicRowsByCode(rows []features.ASICRow) map[string][]features.ASICRow {
	out := map[string][]features.ASICRow{}
	for _, r := range rows {
		out[r.Code] = append(out[r.Code], r)
	}
	for code := range out {
		g := out[code]
		sort.SliceStable(g, func(i, j int) bool { return g[i].ReportDate.Before(g[j].ReportDate) })
	}
	return out
}

// newestASIC is the product name and shares on issue of the newest ASIC row
// dated on or before t, so a session never reads a later classification.
func newestASIC(rows []features.ASICRow, t civil.Date) (string, float64, bool) {
	i := sort.Search(len(rows), func(i int) bool { return rows[i].ReportDate.After(t) })
	if i == 0 {
		return "", 0, false
	}
	return rows[i-1].Product, rows[i-1].Issued, true
}

// pricedCount counts the priced bars dated in [from, to] (the 000130 px filter).
func pricedCount(bars []features.Bar, from, to civil.Date) int {
	n := 0
	for _, b := range bars {
		if !b.Date.Before(from) && !b.Date.After(to) && features.Priced(b.Close) {
			n++
		}
	}
	return n
}

// barOn returns the bar dated d, if the code has one.
func barOn(bars []features.Bar, d civil.Date) (features.Bar, bool) {
	i := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(d) })
	if i < len(bars) && bars[i].Date == d {
		return bars[i], true
	}
	return features.Bar{}, false
}

// lastBarOnOrBefore is the code's newest bar dated on or before d; zero when none.
func lastBarOnOrBefore(bars []features.Bar, d civil.Date) civil.Date {
	i := sort.Search(len(bars), func(i int) bool { return bars[i].Date.After(d) })
	if i == 0 {
		return civil.Date{}
	}
	return bars[i-1].Date
}

// barFeature is the as-of bar of the stored features. A code with no bar on the
// session stores zeros, and the row's bar_date says the bar is not today's.
func barFeature(b features.Bar, ok bool) snapshot.Bar {
	if !ok {
		return snapshot.Bar{}
	}
	return snapshot.Bar{O: b.Open, H: b.High, L: b.Low, C: b.Close, Adj: b.AdjClose, V: b.Volume}
}

// exDividend is the cash per share of the ex-dates on d; zero when none.
func exDividend(divs []features.Dividend, d civil.Date) float64 {
	total := 0.0
	for _, dv := range divs {
		if dv.ExDate == d {
			total += dv.AmountPerShare
		}
	}
	return total
}

// guardedBy reports whether a known suspect still keeps the code out on d.
func guardedBy(cal *calendar.Calendar, known []features.CASuspect, d civil.Date) bool {
	for _, s := range known {
		if cal.SessionsBetween(s.Date, d) < caGuardSessions {
			return true
		}
	}
	return false
}

// latestSuspect is the newest known suspect's date; nil when none is known.
func latestSuspect(known []features.CASuspect) *civil.Date {
	if len(known) == 0 {
		return nil
	}
	newest := known[0].Date
	for _, s := range known[1:] {
		if s.Date.After(newest) {
			newest = s.Date
		}
	}
	return &newest
}

// hasIndexBar reports whether the index has a bar dated d.
func hasIndexBar(xjo []features.IndexBar, d civil.Date) bool {
	for _, b := range xjo {
		if b.Date == d {
			return true
		}
	}
	return false
}

// versionEval is one version's evaluation of one session: each code's status
// and score, for the codes that are picks. A code that is not a pick is absent.
type versionEval struct {
	RulesHash string
	Picks     map[string]pickState
	Eligible  int
}

// pickState is a pick's status ladder position and score.
type pickState struct {
	Status string
	Score  float64
	Rules  []engine.RuleResult
}

// evaluateVersion evaluates the stored rows of one session under one version.
// The universe is the version's eligible rows, rebuilt as candidates from their
// stored features; the regime and the universe statistics are the session's.
func evaluateVersion(rows []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime, v spec.Registered) (versionEval, error) {
	out := versionEval{Picks: map[string]pickState{}}
	hash, err := spec.RulesHash(v.Spec)
	if err != nil {
		return out, fmt.Errorf("hash %s: %w", v.Label, err)
	}
	out.RulesHash = hash

	var cands []engine.Candidate
	for _, r := range rows {
		ok, _ := snapshot.Eligible(r, v.Spec)
		if !ok {
			continue
		}
		c, err := snapshot.ToCandidate(r, v.Spec, blobs[r.FundamentalsHash])
		if err != nil {
			return out, fmt.Errorf("candidate %s: %w", r.StockCode, err)
		}
		cands = append(cands, c)
	}
	out.Eligible = len(cands)
	if len(cands) == 0 {
		return out, nil
	}
	engine.PrepareCandidates(cands)
	env := engine.NewEnvFromStats(regime, engine.UniverseStatsOf(cands))

	strategy, ok := engine.Lookup(v.Spec.StrategyID)
	if !ok {
		return out, fmt.Errorf("no engine strategy for %s", v.Spec.StrategyID)
	}
	for i := range cands {
		pick, isPick := engine.EvaluateOne(strategy, cands[i], env)
		if !isPick {
			continue
		}
		out.Picks[cands[i].StockCode] = pickState{Status: string(pick.Status), Score: pick.Score, Rules: pick.Rules}
	}
	return out, nil
}

// tradingDayTime is a civil date at UTC midnight, the form the ASX calendar takes.
func tradingDayTime(d civil.Date) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
}

// isTradingDay reports whether the ASX was open on d.
func isTradingDay(d civil.Date) bool {
	return asxcalendar.IsTradingDay(tradingDayTime(d))
}

// prevTradingDay is the last trading day before d.
func prevTradingDay(d civil.Date) civil.Date {
	for {
		d = d.AddDays(-1)
		if isTradingDay(d) {
			return d
		}
	}
}

// nextTradingDay is the first trading day after d.
func nextTradingDay(d civil.Date) civil.Date {
	for {
		d = d.AddDays(1)
		if isTradingDay(d) {
			return d
		}
	}
}

// sessionFor is the session a run at the given UTC day processes: today when the
// ASX traded, else the trading day before it.
func sessionFor(today civil.Date) civil.Date {
	if isTradingDay(today) {
		return today
	}
	return prevTradingDay(today)
}

// previousSessions is the n trading days before d, newest first.
func previousSessions(d civil.Date, n int) []civil.Date {
	out := make([]civil.Date, 0, n)
	for len(out) < n {
		d = prevTradingDay(d)
		out = append(out, d)
	}
	return out
}
