// Package pipeline turns stored rows into the candidates the engine evaluates.
// Inputs is the one set of rows a run reads; CandidateAt and BuildCandidates
// apply the universe policy of the version to them. Both are pure: the
// readers that fill Inputs are pgsource's.
//
// The bars are each code's stock_prices rows as stored, date ascending, with no
// close filter: unpriced closes and zero volume are kept. AsOf, DaysToCover and
// CASuspects drop the rows whose close fails validPrice themselves, while
// DaysToCoverV0 reads the rows as 000080 does, so a reader or backtest must not
// filter them before they reach the features.
package pipeline

import (
	"encoding/json"
	"sort"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Inputs is the set of rows one run reads. Iteration is over Codes, which is
// sorted; the maps are keyed by stock code and are never ranged over for output.
type Inputs struct {
	Codes        []string                         // sorted; the only iteration order
	Bars         map[string][]features.Bar        // per code, date ascending, unfiltered (see above)
	XJO          []features.IndexBar              // regime, RS
	XJT          []features.IndexBar              // benchmark
	ASIC         []features.ASICRow               // shorts rows for the report dates needed, zero rows included
	Ingests      []features.ReportIngest          // asic_report_ingests: report completeness
	ETPSet       map[string]bool                  // ETF and LIC codes, the universe's exclusion list
	Names        map[string]string                // company names, for the ordinary-share rule
	Dividends    map[string][]features.Dividend   // per code, dividend_history: unadjusted ex-dates
	CashRate     []features.RatePoint             // the cash rate target, forward-filled
	Fundamentals map[string]features.Fundamentals // live: the fundamentals blob per code
}

// Ineligible records a code the universe excluded on a session and why.
type Ineligible struct {
	Code   string
	Reason string
}

// Reasons the pipeline decides itself. The instrument reasons are
// instrument.IneligibleReason's; these are the rest of the universe's reasons.
const (
	ReasonNoBarOnSession       = instrument.ReasonNoBarOnSession
	ReasonShortHistory         = "short_history"
	ReasonCorporateActionGuard = "corporate_action_guard"
	ReasonNotInASICReport      = "not_in_asic_report"
)

// index is the per-run state the candidates share: built once, read per code.
type index struct {
	s        spec.Spec
	in       *Inputs
	cal      *calendar.Calendar
	reports  *features.Reports
	asic     map[string][]features.ASICRow // per code, date ascending
	suspects map[string][]features.CASuspect
}

// newIndex builds the shared state of one run under version s.
func newIndex(in *Inputs, s spec.Spec) *index {
	xjoDates := make([]civil.Date, len(in.XJO))
	for i, b := range in.XJO {
		xjoDates[i] = b.Date
	}
	reportDates := map[civil.Date]bool{}
	for _, r := range in.ASIC {
		reportDates[r.ReportDate] = true
	}
	var asicDates []civil.Date
	for d := range reportDates {
		asicDates = append(asicDates, d)
	}
	sort.Slice(asicDates, func(i, j int) bool { return asicDates[i].Before(asicDates[j]) })

	idx := &index{
		s:        s,
		in:       in,
		cal:      calendar.New(xjoDates, asicDates, s.Data.PublicationLagSessions),
		reports:  features.NewReports(in.ASIC, in.Ingests),
		asic:     map[string][]features.ASICRow{},
		suspects: map[string][]features.CASuspect{},
	}
	for _, r := range in.ASIC {
		idx.asic[r.Code] = append(idx.asic[r.Code], r)
	}
	for code, rows := range idx.asic {
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].ReportDate.Before(rows[j].ReportDate) })
		idx.asic[code] = rows
	}
	// The corporate-action suspects are needed by the CA guard and by the
	// short reading's basis check. An unparseable ca_upjump_from is the empty
	// date, which counts every up-jump: the conservative error.
	if s.Universe.CAGuard || s.Data.ShortSource == "latest_complete_published" {
		upjump, _ := civil.ParseDate(s.Data.CAUpjumpFrom)
		for _, code := range in.Codes {
			idx.suspects[code] = features.CASuspects(in.Bars[code], idx.asic[code], idx.cal, upjump)
		}
	}
	return idx
}

// CandidateAt builds the candidate of one code on session t under version s,
// from the rows in in, or the reason the universe excludes it on t. It builds
// the run's shared state on every call, so a run over many codes should use
// BuildCandidates.
//
// The version is a parameter, unlike the seam's first draft: the feature
// parameters and the universe policy the candidate is built under are the
// version's, so a candidate cannot be built without it.
func CandidateAt(code string, t civil.Date, in *Inputs, s spec.Spec) (engine.Candidate, *Ineligible) {
	return candidateAt(code, t, newIndex(in, s))
}

// Index is the shared state of one run under one version, built once from
// its rows. A run that evaluates many codes on many sessions reads candidates
// through an Index: each CandidateAt call is the package-level CandidateAt
// without the per-call rebuild, so the two agree on every input.
type Index struct {
	idx *index
}

// NewIndex builds the shared state of a run over in under version s.
func NewIndex(in *Inputs, s spec.Spec) *Index {
	return &Index{idx: newIndex(in, s)}
}

// CandidateAt is the package-level CandidateAt over the built index.
func (x *Index) CandidateAt(code string, t civil.Date) (engine.Candidate, *Ineligible) {
	return candidateAt(code, t, x.idx)
}

// PriceCandidateAt is the price features of a code on session t, whatever the
// universe decides about the code on t. They are the features as of the code's
// last priced bar on or before t, the same rows the feature store keeps, so a
// session with no bar of its own still carries them. It is built when the
// history reads as of t, and ok is false otherwise. No universe rule is
// applied, so the candidate's short, fundamentals and name fields are unset: a
// caller reads its price fields (the 20-session dollar volume, the moving
// averages, the pivot) for a code the universe excludes.
func (x *Index) PriceCandidateAt(code string, t civil.Date) (engine.Candidate, bool) {
	bars := x.idx.in.Bars[code]
	pf, ok := features.AsOf(bars, x.idx.in.XJO, t, x.idx.s.Features)
	if !ok {
		return engine.Candidate{}, false
	}
	return candidateFromPrice(code, pf), true
}

// Suspects returns the corporate-action suspects of a code over the whole of
// the run's rows. A suspect is used on the session it is KnownAt, through
// KnownBy, so a caller may read the full list and select by session.
func (x *Index) Suspects(code string) []features.CASuspect {
	return x.idx.suspects[code]
}

// Calendar is the session calendar the run's short-position rules read.
func (x *Index) Calendar() *calendar.Calendar {
	return x.idx.cal
}

// candidateAt is CandidateAt over a built index. The checks run in a fixed
// order: the bar on the session, the history, the instrument, the CA guard,
// then the short-report membership.
func candidateAt(code string, t civil.Date, idx *index) (engine.Candidate, *Ineligible) {
	s, in := idx.s, idx.in
	bars := in.Bars[code]
	inel := func(reason string) (engine.Candidate, *Ineligible) {
		return engine.Candidate{}, &Ineligible{Code: code, Reason: reason}
	}

	if s.Universe.Freshness == "bar_on_session" && !pricedOn(bars, t) {
		return inel(ReasonNoBarOnSession)
	}
	if priced(bars, t.AddDays(-s.Universe.LookbackDays), t) < s.Universe.MinSessions {
		return inel(ReasonShortHistory)
	}
	pf, ok := features.AsOf(bars, in.XJO, t, s.Features)
	if !ok {
		return inel(ReasonShortHistory)
	}

	product, shares, _ := newestASIC(idx.asic[code], t)
	company := in.Names[code]
	if s.Universe.Instruments == "ordinary" {
		if r := instrument.IneligibleReason(code, product, company, shares, in.ETPSet, true); r != "" {
			return inel(r)
		}
	}

	known := features.KnownBy(idx.suspects[code], t)
	if s.Universe.CAGuard && caGuarded(idx.cal, known, t) {
		return inel(ReasonCorporateActionGuard)
	}

	var sr features.ShortReading
	if s.Data.ShortSource == "latest_complete_published" {
		sr = features.ShortReadingV1(code, t, idx.cal, idx.reports, bars, known, s.Data.MaxReportAgeSessions)
	} else {
		sr = features.ShortReadingV0(code, t, idx.cal, idx.reports, bars)
	}
	if s.Universe.ASICReported && (sr.InReport == nil || !*sr.InReport) {
		return inel(ReasonNotInASICReport)
	}

	c := candidateFromPrice(code, pf)
	c.CompanyName = company
	ApplyShortReading(&c, sr)
	c.InASICReport = sr.InReport != nil && *sr.InReport
	c.ShortReportDate = timePtr(sr.ReportDate)
	applyFundamentals(&c, in.Fundamentals[code])
	return c, nil
}

// CAGuardSessions is how long a known corporate-action suspect keeps its code
// out of the v1 universe: the code is ineligible from the suspect's known date
// until this many sessions after the suspect's bar, and eligible again on that
// session.
const CAGuardSessions = 260

// caGuarded reports whether one of the known suspects still excludes the code
// on session t. The window is counted from the suspect's bar, not from the day
// it became known, so a suspect expires after CAGuardSessions sessions however
// far back the caller's bars reach.
func caGuarded(cal *calendar.Calendar, known []features.CASuspect, t civil.Date) bool {
	for _, s := range known {
		if cal.SessionsBetween(s.Date, t) < CAGuardSessions {
			return true
		}
	}
	return false
}

// BuildCandidates builds every eligible candidate on session D under the
// version s, with the statistics the rules read across the universe. The
// candidates are in Codes order and not yet prepared. The rows this package
// reads do not carry the industry, the logo or the metadata market cap, so the
// caller attaches them (pgsource.MergeMetadata) before engine.PrepareCandidates,
// whose financials rule reads the industry. Ineligible codes come back with
// their reason, in Codes order.
func BuildCandidates(D civil.Date, in *Inputs, s spec.Spec) ([]engine.Candidate, engine.UniverseStats, []Ineligible) {
	idx := newIndex(in, s)
	var (
		cands []engine.Candidate
		out   []Ineligible
	)
	for _, code := range in.Codes {
		c, bad := candidateAt(code, D, idx)
		if bad != nil {
			out = append(out, *bad)
			continue
		}
		cands = append(cands, c)
	}
	stats := engine.UniverseStatsOf(cands)
	stats.Session = D
	return cands, stats, out
}

// pricedOn reports whether bars holds a priced bar dated t.
func pricedOn(bars []features.Bar, t civil.Date) bool {
	i := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(t) })
	return i < len(bars) && bars[i].Date == t && features.Priced(bars[i].Close)
}

// priced counts the priced bars dated in [from, to].
func priced(bars []features.Bar, from, to civil.Date) int {
	lo := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(from) })
	hi := sort.Search(len(bars), func(i int) bool { return bars[i].Date.After(to) })
	n := 0
	for _, b := range bars[lo:hi] {
		if features.Priced(b.Close) {
			n++
		}
	}
	return n
}

// newestASIC returns the product name and shares on issue of the newest ASIC
// row dated on or before t: point-in-time, so a backtest never reads a later
// classification. ok is false when the code has no row yet.
func newestASIC(rows []features.ASICRow, t civil.Date) (product string, shares float64, ok bool) {
	i := sort.Search(len(rows), func(i int) bool { return rows[i].ReportDate.After(t) })
	if i == 0 {
		return "", 0, false
	}
	r := rows[i-1]
	return r.Product, r.Issued, true
}

// CandidateFromPrice maps one price-feature row onto the evaluator's candidate.
// The snapshot reader builds candidates from its stored rows with it, so a
// stored session and a live build share one mapping.
func CandidateFromPrice(code string, p features.PriceFeatures) engine.Candidate {
	return candidateFromPrice(code, p)
}

// ApplyFundamentals decodes a stock's frozen fundamentals onto its candidate,
// as the live build does. A missing or undecodable blob leaves the candidate
// without fundamentals.
func ApplyFundamentals(c *engine.Candidate, f features.Fundamentals) {
	applyFundamentals(c, f)
}

// ApplyShortReading puts a short reading on a candidate: the figure and the
// days to cover, and the reasons the short rules are unknown. A stale or
// unavailable reading (v1) keeps its reason, so the rules read unknown rather
// than fail; an absent or zero reading has no reason and reads as a fail.
func ApplyShortReading(c *engine.Candidate, sr features.ShortReading) {
	c.ShortPct = sr.Pct
	c.DaysToCover = sr.DaysToCover
	c.ShortReason = ""
	if sr.Status == features.StatusStale || sr.Status == features.StatusUnavailable {
		c.ShortReason = sr.Reason
	}
	c.DaysToCoverReason = sr.DaysToCoverReason
}

// candidateFromPrice maps one price-feature row onto the evaluator's candidate.
func candidateFromPrice(code string, p features.PriceFeatures) engine.Candidate {
	volume := p.Volume
	breakout := p.BreakoutRecent
	var baseLength *int32
	if p.BaseLengthDays != nil {
		n := int32(*p.BaseLengthDays)
		baseLength = &n
	}
	return engine.Candidate{
		StockCode:         code,
		AsOf:              time.Date(p.AsOf.Year, p.AsOf.Month, p.AsOf.Day, 0, 0, 0, 0, time.UTC),
		Close:             p.Close,
		PrevClose:         p.PrevClose,
		SMA10:             p.SMA10,
		SMA20:             p.SMA20,
		SMA50:             p.SMA50,
		SMA150:            p.SMA150,
		SMA200:            p.SMA200,
		SMA200_1mAgo:      p.SMA200OneMonthAgo,
		High52w:           p.High52w,
		Low52w:            p.Low52w,
		PctOff52wHigh:     p.PctOff52wHigh,
		PctAbove52wLow:    p.PctAbove52wLow,
		Volume:            &volume,
		AvgVolume50d:      p.AvgVolume50d,
		VolumeRatio50d:    p.VolumeRatio50d,
		DollarVolume20d:   p.DollarVolume20d,
		BaseHigh:          p.BaseHigh,
		BaseLow:           p.BaseLow,
		BaseDepthPct:      p.BaseDepthPct,
		BaseLengthDays:    baseLength,
		BreakoutRecent:    &breakout,
		BreakoutDate:      timePtr(p.BreakoutDate),
		Ret1mPct:          p.Ret1mPct,
		Ret3mPct:          p.Ret3mPct,
		Ret6mPct:          p.Ret6mPct,
		Ret12mPct:         p.Ret12mPct,
		RS3mPct:           p.RS3mPct,
		RS6mPct:           p.RS6mPct,
		SessionsAvailable: int32(p.SessionsAvailable),
	}
}

// applyFundamentals decodes a stock's frozen fundamentals onto its candidate.
// A blob this package cannot decode is treated as no fundamentals: the
// encoder writes these bytes from the same type, so that does not happen in a
// run that reads its own snapshot.
func applyFundamentals(c *engine.Candidate, f features.Fundamentals) {
	if len(f.Blob) == 0 {
		return
	}
	var body features.FundamentalsBody
	if err := json.Unmarshal(f.Blob, &body); err != nil {
		return
	}
	c.Growth = body.Growth
	c.Quality = body.Quality
	c.ValuationInputs = body.ValuationInputs
}

// timePtr converts an optional civil date to the candidate's time form.
func timePtr(d *civil.Date) *time.Time {
	if d == nil {
		return nil
	}
	t := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
	return &t
}
