package features

import (
	"math"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
)

// StaleAfterSessions is the v1 policy's max_report_age_sessions: the age, in
// sessions, past which the newest complete ASIC report no longer counts as
// current. It is passed to ShortReadingV1, so a sensitivity run can change it.
const StaleAfterSessions = 8

// Short-reading statuses. sf1 reports reported, zero, absent, unavailable or
// stale. sf0 reports reported or none (no filtered row with a positive
// percentage exists on or before the decision date).
const (
	StatusReported    = "reported"
	StatusZero        = "zero"
	StatusAbsent      = "absent"
	StatusUnavailable = "unavailable"
	StatusStale       = "stale"
	StatusNone        = "none"
)

// Reasons a reading or its days-to-cover is unknown. They are the reasons the
// short rules and the display name, so each one is a stable string.
const (
	ReasonASICValueMissing = "asic_value_missing"
	ReasonASICReportStale  = "asic_report_stale"
	ReasonBasisChange      = "basis_change"
	ReasonNoVolume         = "no_volume"
)

// ReportCompleteness holds what the completeness rule reads of the ASIC reports:
// the distinct report dates, the rows each report carries with a finite
// percentage, and the ingests. It holds no copy of the rows, so a caller that
// only asks whether a report is complete (the backtest's coverage and reference)
// builds it without the rows' memory. Reports.Complete is this rule.
type ReportCompleteness struct {
	dates   []civil.Date // distinct report dates, ascending
	pos     map[civil.Date]int
	count   map[civil.Date]int // rows per report date, all codes
	ingests map[civil.Date]ReportIngest
}

// NewReportCompleteness counts each report's rows. A (code, date) pair that
// appears twice counts once, with its last row, as Reports keeps it; a row counts
// toward its report's size only with a finite percentage, the rows the alerts job
// loads. Input order does not change the result except through that last row. A
// report's ingest is the last one given for its date.
func NewReportCompleteness(rows []ASICRow, ingests []ReportIngest) ReportCompleteness {
	c := ReportCompleteness{
		pos:     map[civil.Date]int{},
		count:   map[civil.Date]int{},
		ingests: make(map[civil.Date]ReportIngest, len(ingests)),
	}
	byDate := map[civil.Date][]int32{}
	for i := range rows {
		d := rows[i].ReportDate
		byDate[d] = append(byDate[d], int32(i))
	}
	for d := range byDate {
		c.dates = append(c.dates, d)
	}
	sort.Slice(c.dates, func(i, j int) bool { return c.dates[i].Before(c.dates[j]) })
	for i, d := range c.dates {
		c.pos[d] = i
		// The last row of each code on the date is the one the rule counts.
		last := make(map[string]bool, len(byDate[d]))
		for _, idx := range byDate[d] {
			row := &rows[idx]
			last[row.Code] = row.Percent != nil && finite(*row.Percent)
		}
		n := 0
		for _, finiteRow := range last {
			if finiteRow {
				n++
			}
		}
		c.count[d] = n
	}
	for _, in := range ingests {
		c.ingests[in.ReportDate] = in
	}
	return c
}

// Reports is the ASIC report history the readings read: the rows of every code
// for the report dates needed, zero rows included, with the completeness facts
// of each report. Build it once per run and share it across codes.
type Reports struct {
	comp ReportCompleteness
	// rows is the input slice, shared with the caller and not copied: the caller
	// must not change it after NewReports.
	rows   []ASICRow
	byCode map[string][]int32 // each code's indices into rows: one per date (the last given), date ascending
}

// NewReports indexes the ASIC rows and the report ingests. Input order does not
// matter; a code's row on a date that appears twice keeps the last one.
func NewReports(rows []ASICRow, ingests []ReportIngest) *Reports {
	r := &Reports{
		comp:   NewReportCompleteness(rows, ingests),
		rows:   rows,
		byCode: map[string][]int32{},
	}
	for i := range rows {
		r.byCode[rows[i].Code] = append(r.byCode[rows[i].Code], int32(i))
	}
	// A stable sort by date keeps input order among a date's rows, so the last of
	// each date run is the last given, which is the row a (code, date) pair keeps.
	for code, idxs := range r.byCode {
		sort.SliceStable(idxs, func(a, b int) bool { return rows[idxs[a]].ReportDate.Before(rows[idxs[b]].ReportDate) })
		kept := idxs[:0]
		for k, i := range idxs {
			if k+1 < len(idxs) && rows[idxs[k+1]].ReportDate == rows[i].ReportDate {
				continue
			}
			kept = append(kept, i)
		}
		r.byCode[code] = kept
	}
	return r
}

// Complete is ReportCompleteness.Complete over the reports' own rows.
func (r *Reports) Complete(date civil.Date) bool { return r.comp.Complete(date) }

// Complete reports whether the report for date reached shorts in full. When an
// ingest row records the file's row count, the rule is loaded rows at least the
// file's rows; rows a revised file no longer lists are never deleted, which is
// why the comparison is >=. Otherwise the alerts job's rule applies: a report
// with fewer than half the previous report's rows is partial.
func (c ReportCompleteness) Complete(date civil.Date) bool {
	if in, ok := c.ingests[date]; ok && in.FileRows != nil {
		return in.LoadedRows >= *in.FileRows
	}
	i, ok := c.pos[date]
	if !ok {
		return false
	}
	if i == 0 {
		return true
	}
	prev := c.dates[i-1]
	return 2*c.count[date] >= c.count[prev]
}

func (r *Reports) row(code string, date civil.Date) (ASICRow, bool) {
	idxs := r.byCode[code]
	i := sort.Search(len(idxs), func(i int) bool { return !r.rows[idxs[i]].ReportDate.Before(date) })
	if i < len(idxs) && r.rows[idxs[i]].ReportDate == date {
		return r.rows[idxs[i]], true
	}
	return ASICRow{}, false
}

// LatestUsable returns R*(asOf): the newest complete report public at asOf,
// with no age limit. A report that is public but partial is skipped, as is one
// not yet public.
func (r *Reports) LatestUsable(asOf civil.Date, cal *calendar.Calendar) (civil.Date, bool) {
	for i := len(r.comp.dates) - 1; i >= 0; i-- {
		d := r.comp.dates[i]
		if d.After(asOf) || !cal.Usable(d, asOf) || !r.Complete(d) {
			continue
		}
		return d, true
	}
	return civil.Date{}, false
}

// finiteRow reports whether a row carries a percentage and positions that can
// be encoded and divided: SQL NULL, NaN and infinities are not values.
func finiteRow(row ASICRow) bool {
	return row.Percent != nil && finite(*row.Percent) && finite(row.Positions)
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// ShortReadingV1 is sf1, the reading the v1 rules use: the newest complete
// report that was public at asOf (R*), with no age limit. R* more than
// maxAgeSessions sessions old leaves the reading stale, with R*'s dates and
// whether the code is in R* still set, so a caller can keep a listed code in
// the universe with its short rules unknown. Days to cover is unknown when a
// corporate-action suspect dated after the report was known by asOf, because
// the report's positions are then in pre-event shares while the volume is
// post-event.
//
// bars are the code's stock_prices rows ascending and unfiltered (DaysToCover
// drops the rows without a priced close); suspects are the code's CASuspects.
func ShortReadingV1(code string, asOf civil.Date, cal *calendar.Calendar, reports *Reports, bars []Bar, suspects []CASuspect, maxAgeSessions int) ShortReading {
	report, found := reports.LatestUsable(asOf, cal)
	if !found {
		return ShortReading{Status: StatusStale, Reason: ReasonASICReportStale}
	}

	available, _ := cal.PublishedOn(report)
	reading := ShortReading{ReportDate: dateRef(report), AvailableDate: dateRef(available)}

	row, present := reports.row(code, report)
	reading.InReport = &present
	if cal.SessionsBetween(report, asOf) > maxAgeSessions {
		reading.Status = StatusStale
		reading.Reason = ReasonASICReportStale
		return reading
	}
	if !present {
		reading.Status = StatusAbsent
		return reading
	}
	if !finiteRow(row) || *row.Percent < 0 {
		reading.Status = StatusUnavailable
		reading.Reason = ReasonASICValueMissing
		return reading
	}

	pct, positions := *row.Percent, row.Positions
	reading.Pct = &pct
	reading.Positions = &positions
	reading.Status = StatusReported
	if pct == 0 {
		reading.Status = StatusZero
	}

	if basisChanged(suspects, report, asOf) {
		reading.DaysToCoverReason = ReasonBasisChange
		return reading
	}
	dtc, reason := DaysToCover(bars, asOf, positions)
	if reason != "" {
		reading.DaysToCoverReason = reason
		return reading
	}
	reading.DaysToCover = &dtc
	return reading
}

// ShortReadingV0 is sf0, the reading v0's rules were calibrated on: the latest
// row for the code, dated on or before asOf, with a positive percentage and
// the instrument filters the v0 picker applied (ordinary shares only). It has
// no age limit. Its days to cover follows DaysToCoverV0, so bars are the code's
// stock_prices rows as stored, with no close filter.
//
// The v0 filters are 000080's: a share count of zero or below is excluded, and
// so is an empty product name, while a NULL share count (NaN here) passes, as
// it does in SQL. Rows with a non-finite percentage are skipped here, which
// 000080 does not do (it takes +Inf and NaN as positive); that is a known
// exclusion, not a figure.
func ShortReadingV0(code string, asOf civil.Date, cal *calendar.Calendar, reports *Reports, bars []Bar) ShortReading {
	idxs := reports.byCode[code]
	for i := len(idxs) - 1; i >= 0; i-- {
		row := reports.rows[idxs[i]]
		if row.ReportDate.After(asOf) || !finiteRow(row) || *row.Percent <= 0 {
			continue
		}
		if row.Product == "" || row.Issued <= 0 {
			continue
		}
		if instrument.ClassifySecurity(row.Product, row.Code, row.Issued) != instrument.SecurityTypeOrdinary {
			continue
		}
		pct, positions := *row.Percent, row.Positions
		reading := ShortReading{
			Status:     StatusReported,
			ReportDate: dateRef(row.ReportDate),
			Pct:        &pct,
			Positions:  &positions,
		}
		if available, ok := cal.PublishedOn(row.ReportDate); ok {
			reading.AvailableDate = dateRef(available)
		}
		if dtc, reason := DaysToCoverV0(bars, asOf, positions); reason == "" {
			reading.DaysToCover = &dtc
		} else {
			reading.DaysToCoverReason = reason
		}
		return reading
	}
	return ShortReading{Status: StatusNone}
}

// basisChanged reports whether a corporate-action suspect dated after the
// report was known by asOf.
func basisChanged(suspects []CASuspect, report, asOf civil.Date) bool {
	for _, s := range suspects {
		if s.Date.After(report) && !s.KnownAt.After(asOf) {
			return true
		}
	}
	return false
}

func dateRef(d civil.Date) *civil.Date { return &d }
