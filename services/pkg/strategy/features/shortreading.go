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

type rowKey struct {
	code string
	date civil.Date
}

// Reports is the ASIC report history the readings read: the rows of every code
// for the report dates needed, zero rows included, with the completeness facts
// of each report. Build it once per run and share it across codes.
type Reports struct {
	dates   []civil.Date // distinct report dates, ascending
	pos     map[civil.Date]int
	count   map[civil.Date]int // rows per report date, all codes
	ingests map[civil.Date]ReportIngest
	rows    map[rowKey]ASICRow
	byCode  map[string][]ASICRow // each code's rows, date ascending
}

// NewReports indexes the ASIC rows and the report ingests. Input order does not
// matter; a code's row on a date that appears twice keeps the last one.
func NewReports(rows []ASICRow, ingests []ReportIngest) *Reports {
	r := &Reports{
		pos:     map[civil.Date]int{},
		count:   map[civil.Date]int{},
		ingests: make(map[civil.Date]ReportIngest, len(ingests)),
		rows:    make(map[rowKey]ASICRow, len(rows)),
		byCode:  map[string][]ASICRow{},
	}
	for _, row := range rows {
		r.rows[rowKey{row.Code, row.ReportDate}] = row
	}
	// The map above holds one row per code and date, so the counts and the
	// per-code lists below do not depend on the order the rows arrived in.
	// A row counts toward its report's size only with a finite percentage, the
	// rows the alerts job loads, so the two jobs agree on which reports are partial.
	seen := map[civil.Date]bool{}
	for key, row := range r.rows {
		if !seen[key.date] {
			seen[key.date] = true
			r.dates = append(r.dates, key.date)
		}
		if row.Percent != nil && finite(*row.Percent) {
			r.count[key.date]++
		}
		r.byCode[key.code] = append(r.byCode[key.code], row)
	}
	sort.Slice(r.dates, func(i, j int) bool { return r.dates[i].Before(r.dates[j]) })
	for i, d := range r.dates {
		r.pos[d] = i
	}
	for code := range r.byCode {
		rs := r.byCode[code]
		sort.Slice(rs, func(i, j int) bool { return rs[i].ReportDate.Before(rs[j].ReportDate) })
	}
	for _, in := range ingests {
		r.ingests[in.ReportDate] = in
	}
	return r
}

// Complete reports whether the report for date reached shorts in full. When an
// ingest row records the file's row count, the rule is loaded rows at least the
// file's rows; rows a revised file no longer lists are never deleted, which is
// why the comparison is >=. Otherwise the alerts job's rule applies: a report
// with fewer than half the previous report's rows is partial.
func (r *Reports) Complete(date civil.Date) bool {
	if in, ok := r.ingests[date]; ok && in.FileRows != nil {
		return in.LoadedRows >= *in.FileRows
	}
	i, ok := r.pos[date]
	if !ok {
		return false
	}
	if i == 0 {
		return true
	}
	prev := r.dates[i-1]
	return 2*r.count[date] >= r.count[prev]
}

func (r *Reports) row(code string, date civil.Date) (ASICRow, bool) {
	row, ok := r.rows[rowKey{code, date}]
	return row, ok
}

// latestUsable returns the newest complete report public at asOf, with no age
// limit. A report that is public but partial is skipped, as is one not yet
// public.
func (r *Reports) latestUsable(asOf civil.Date, cal *calendar.Calendar) (civil.Date, bool) {
	for i := len(r.dates) - 1; i >= 0; i-- {
		d := r.dates[i]
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
// bars are the code's bars ascending; suspects are the code's CASuspects.
func ShortReadingV1(code string, asOf civil.Date, cal *calendar.Calendar, reports *Reports, bars []Bar, suspects []CASuspect, maxAgeSessions int) ShortReading {
	report, found := reports.latestUsable(asOf, cal)
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
// no age limit. Its days to cover follows DaysToCoverV0.
func ShortReadingV0(code string, asOf civil.Date, cal *calendar.Calendar, reports *Reports, bars []Bar) ShortReading {
	rows := reports.byCode[code]
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		if row.ReportDate.After(asOf) || !finiteRow(row) || *row.Percent <= 0 {
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
