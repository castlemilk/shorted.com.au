package picks

import (
	"math"
	"regexp"
	"strings"
	"time"
)

// Storable magnitude bounds, identical to the table's
// stock_fundamentals_finite_check (000129). A value is stored when it is zero
// or finite with 1e-12 <= |v| <= 1e18. NaN and ±Inf fail (the key_metrics
// incident: encoding/json refuses ±Inf and took MCP down with it); so do
// denormal-scale values, which no statement line has and which are the only way
// a growth ratio in mv_fundamentals_growth could overflow.
const (
	minStorableAbs = 1e-12
	maxStorableAbs = 1e18
)

// storable is the write funnel's value check. The DB CHECK is the backstop;
// this keeps a real write from ever tripping it (which would fail the whole
// multi-row upsert for the code).
func storable(v float64) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return false
	}
	if v == 0 {
		return true
	}
	a := math.Abs(v)
	return a >= minStorableAbs && a <= maxStorableAbs
}

var currencyRe = regexp.MustCompile(`^[A-Z]{3,8}$`)

// sanitizeRows is the last step before a write: every non-storable value is
// set to NULL (and counted), and a row is dropped when its period type is not
// one this job writes ('half' only from the filing source), its currency is
// not a plausible code, it has no period end, or no value survives.
func sanitizeRows(rows []PeriodRow) (out []PeriodRow, rejectedValues int) {
	out = make([]PeriodRow, 0, len(rows))
	for _, r := range rows {
		switch {
		case r.PeriodType == periodAnnual || r.PeriodType == periodTTM:
		case r.PeriodType == periodHalf && r.Source == sourceFiling:
			// Half rows come only from filings; a vendor claiming one is a
			// parser bug, not data.
		default:
			continue
		}
		if r.PeriodEnd.IsZero() || !currencyRe.MatchString(r.Currency) || r.Source == "" {
			continue
		}
		for _, v := range r.values() {
			if *v != nil && !storable(**v) {
				*v = nil
				rejectedValues++
			}
		}
		if !r.hasValues() {
			continue
		}
		out = append(out, r)
	}
	return out, rejectedValues
}

// defaultFYEMonth is the ASX default balance date: 30 June.
const defaultFYEMonth = time.June

// effectiveMonthShift folds a 52/53-week year's balance date back into the
// month it belongs to: a year ending Sunday 2 July 2023 is the June 2023 year.
const effectiveMonthShift = -7

// fiscalYearEndMonth is the company's balance-date month, read from its latest
// annual row; June (the ASX default) when there is none.
func fiscalYearEndMonth(rows []PeriodRow) time.Month {
	var latest time.Time
	for _, r := range rows {
		if r.PeriodType == periodAnnual && r.PeriodEnd.After(latest) {
			latest = r.PeriodEnd
		}
	}
	if latest.IsZero() {
		return defaultFYEMonth
	}
	return latest.AddDate(0, 0, effectiveMonthShift).Month()
}

// fiscalYear is the FY a period ending on end belongs to, for a company whose
// year ends in fyeMonth: FYs are named by the calendar year they END in, so a
// period ending after the balance-date month belongs to next year's FY.
//
// With the ASX default (June) this is exactly "month >= 7 -> year+1, else
// year": H1 FY26 ends 31 Dec 2025 and is FY2026. It also gets December
// balance dates right (DRO's year to 31 Dec 2025 is FY2025, where the June
// rule would call it FY2026) and 52/53-week years (see effectiveMonthShift).
func fiscalYear(end time.Time, fyeMonth time.Month) int16 {
	eff := end.AddDate(0, 0, effectiveMonthShift)
	y := eff.Year()
	if eff.Month() > fyeMonth {
		y++
	}
	return int16(y)
}

// assignFiscalYears derives fiscal_year for every row from the company's own
// balance date. The source's period_end is stored untouched.
func assignFiscalYears(rows []PeriodRow) {
	fye := fiscalYearEndMonth(rows)
	for i := range rows {
		fy := fiscalYear(rows[i].PeriodEnd, fye)
		rows[i].FiscalYear = &fy
	}
}

// staleAnnualAfter: when a code's latest annual row is older than this, a
// newer year should have been filed (ASX: the 4E within two months of the
// balance date, the annual report within three), so the fallback is asked
// whether it has one.
const staleAnnualAfter = 15 * 30 * 24 * time.Hour // ~15 months

// needsFallback reports whether the Markit fallback should be asked for this
// code (plan §2.7: "when Yahoo fails for a code or its latest annual
// period_end is older than Markit's"). Knowing Markit's is newer means asking
// it, so it is asked when Yahoo's annual series is visibly behind:
//   - Yahoo failed or published nothing;
//   - Yahoo has no annual row at all;
//   - Yahoo already has a TTM point at least a year past its latest annual
//     (the small-cap lag measured on SKS/4DX: trailing to Jun-26, annual still
//     Jun-25); or
//   - the latest annual is older than ~15 months.
func needsFallback(yahoo []PeriodRow, yahooErr error, now time.Time) bool {
	if yahooErr != nil || len(yahoo) == 0 {
		return true
	}
	var latestAnnual, latestTTM time.Time
	for _, r := range yahoo {
		switch r.PeriodType {
		case periodAnnual:
			if r.PeriodEnd.After(latestAnnual) {
				latestAnnual = r.PeriodEnd
			}
		case periodTTM:
			if r.PeriodEnd.After(latestTTM) {
				latestTTM = r.PeriodEnd
			}
		}
	}
	if latestAnnual.IsZero() {
		return true
	}
	if !latestTTM.IsZero() && !latestTTM.Before(latestAnnual.AddDate(0, 11, 0)) {
		return true
	}
	return now.Sub(latestAnnual) > staleAnnualAfter
}

// mergeFallback adds to the primary (Yahoo) rows only the fallback's annual
// rows for balance dates AFTER Yahoo's latest annual: the years Yahoo has not
// caught up with. Yahoo stays authoritative for every period it has, so the two
// sources never mix inside one period, and the fallback's row is replaced by
// Yahoo's the run after Yahoo catches up (same key; see upsertSQL).
func mergeFallback(primary, fallback []PeriodRow) []PeriodRow {
	if len(primary) == 0 {
		out := append([]PeriodRow(nil), fallback...)
		sortRows(out)
		return out
	}
	var latestAnnual time.Time
	for _, r := range primary {
		if r.PeriodType == periodAnnual && r.PeriodEnd.After(latestAnnual) {
			latestAnnual = r.PeriodEnd
		}
	}
	out := append([]PeriodRow(nil), primary...)
	for _, r := range fallback {
		if r.PeriodType == periodAnnual && r.PeriodEnd.After(latestAnnual) {
			out = append(out, r)
		}
	}
	sortRows(out)
	return out
}

// codeRe is what an ASX code may look like before it is put in a URL path.
var codeRe = regexp.MustCompile(`^[A-Z0-9]{1,10}$`)

// normalizeCode upper-cases and trims a code, returning "" when it is not a
// plausible ASX code (stock_code is VARCHAR(10)).
func normalizeCode(code string) string {
	c := strings.ToUpper(strings.TrimSpace(code))
	if !codeRe.MatchString(c) {
		return ""
	}
	return c
}
