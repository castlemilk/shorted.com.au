package picks

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// Period resolution for filing extractions (-mode filings).
//
// The report-extractor's LLM writes a free-text `period` beside every metric
// ("H1 FY2025", "1H26", "FY2025", "full year ended 30 June 2025",
// "half-year ended 31 December 2024"). stock_fundamentals needs a typed
// (period_type, period_end). The rules, in order (docs/plans/stock-picker.md
// §2.6 carries the same list; docs/plans/fundamentals-coverage.md §4.2
// tightened rules 1 and 5 and added gate 4):
//
//  1. The DOCUMENT gates the whole report (gate 1,
//     extractiontrust.IsResultsDocument over the headline and
//     document_meta.report_kind): only statutory results documents are read.
//     Scheduling notices, webinars, "Notice of ...", AGM results, dividend
//     admin, presentations without an Appendix 4D/4E, Pillar 3, and every
//     quarterly / Appendix 4C / activities report are rejected before any
//     metric is read.
//  2. A period string naming a quarter, nine months, year-to-date, guidance,
//     a forecast or a comparative ("pcp", "prior year") is rejected.
//  3. Type: half-year words (H1, 1H, HY, 2H, half-year, interim, six months)
//     win over annual words (FY, full year, annual, twelve months, year),
//     because "half-year" contains "year". With neither ("period ended 31
//     December 2024") the headline decides (Appendix 4D / half-year -> half,
//     Appendix 4E / annual report / full year / preliminary final -> annual),
//     else the metric is rejected.
//  4. End date: an explicit date in the period string wins ("30 June 2025",
//     "31/12/2024", "December 2024" -> month end). Otherwise a fiscal-year
//     label (FY25, FY2025, 1H26, H1 FY2025, 2025/26, CY2025) is placed on the
//     company's balance date: H1 of FY Y ends six months before FY Y does, so
//     with the ASX default (June) H1 FY26 ends 31 December 2025, and with a
//     December balance date (DroneShield) it ends 30 June 2026. A label with
//     no year at all ("H1", "full year") takes the latest such period end on
//     or before the report date. No year and no report date: rejected.
//  5. The balance-date month comes from, in order: an explicit date in the
//     period string, the company's vendor annual rows, else a dated headline
//     ("...for the year ended 31 December 2025"; a dated half-year headline is
//     its month + 6). There is NO default: the June balance date the ingest
//     used to assume dated December filers (DRO) in June. With none of the
//     three the metric is rejected. (The ingest requires vendor context
//     before it resolves anything, so in practice the vendor's month decides.)
//  6. When the report date is known the period must end no later than seven
//     days after it (a later end is guidance or a forecast) and no more than
//     15 months before it (older is a comparative or a restatement, which the
//     report for that period carries first-hand).
//  7. Every resolved end is canonicalised to a month end, shifted like a
//     52/53-week year (a year to Sunday 2 July 2023 is June 2023), so the same
//     half read from two documents lands on one key.
//  8. Gate 4 (documentPeriod): the resolved period must BE the document's own
//     period, document_meta.period_end when the extractor read one, else the
//     latest half or annual end on or before the report date on the
//     company's balance date, within five months. A comparative quoted in a
//     results document (CBA's prior-half NPAT labelled as current) resolves
//     to another period and is dropped.

// resolvedPeriod is a typed period.
type resolvedPeriod struct {
	Type string    // periodHalf | periodAnnual
	End  time.Time // canonical month end, midnight UTC
}

// periodContext is what the parser may use besides the period string.
type periodContext struct {
	Headline   string
	ReportDate time.Time  // zero when unknown
	VendorFYE  time.Month // balance-date month from vendor annual rows; 0 = none
}

const (
	// periodFutureGrace: a period may end this long after the report date
	// (reports dated a day or two before the balance date do exist).
	periodFutureGrace = 7 * 24 * time.Hour
	// periodMaxAgeMonths: older than this relative to the report is a
	// comparative, not the report's own period.
	periodMaxAgeMonths = 15
	// noYearMaxLagMonths: a label without a year resolves to the latest
	// period end on or before the report date, but only within this lag (4D
	// and 4E are due within two months; the annual report within four).
	noYearMaxLagMonths = 5
)

var (
	// Period-string rejections (rule 2).
	periodRejectRe = regexp.MustCompile(`(?i)\bq[1-4]\b|\b[1-4]q\b|\b[1-4]q\s?(?:fy)?\d{2}|\bquarter|\bnine[- ]months?\b|\b9[- ]?months?\b|\b9m\b|\bthree[- ]months?\b|\b3[- ]?months?\b|\bytd\b|year[- ]to[- ]date|\bguidance\b|\bforecast|\boutlook\b|\bexpected\b|\btarget\b|\bbudget\b|\bestimate|\bpcp\b|\bprior\b|\bprevious\b|\bcomparative\b|\blast year\b|\d{2,4}\s?[ef]\b`)

	periodHalfRe   = regexp.MustCompile(`(?i)\b(?:[12]h|h[12]|hy)(?:\s?fy)?\s?'?(?:\d{4}|\d{2})?\b|\bhalf[- ]?years?\b|\bhalf[- ]?yearly\b|\bhalf\b|\binterim\b|\bsix[- ]months?\b|\b6[- ]?months?\b|\b6m\b`)
	periodSecondRe = regexp.MustCompile(`(?i)\b(?:2h|h2)(?:\s?fy)?\s?'?(?:\d{4}|\d{2})?\b|\bsecond[- ]half\b`)
	periodAnnualRe = regexp.MustCompile(`(?i)\b(?:fy|cy)\s?'?(?:\d{4}|\d{2})?\b|\bfull[- ]?year\b|\bannual\b|\btwelve[- ]months?\b|\b12[- ]?months?\b|\b12m\b|\byears?\b|\bfinancial[- ]year\b`)
	calendarRe     = regexp.MustCompile(`(?i)\bcy\s?'?(\d{4}|\d{2})\b`)

	headlineHalfRe   = regexp.MustCompile(`(?i)\bappendix\s*4d\b|\bhalf[- ]?year(?:ly)?\b|\binterim\b|\b[12]h\s?(?:fy)?\d{2}\b|\bhy\s?\d{2}\b`)
	headlineAnnualRe = regexp.MustCompile(`(?i)\bappendix\s*4e\b|\bannual\s+report\b|\bfull[- ]?year\b|\bpreliminary\s+final\b|\bfy\s?\d{2,4}\b|\byear\s+end(?:ed|ing)\b`)

	// FY-style labels with a year. Order matters: the most specific first.
	fySpanRe  = regexp.MustCompile(`(?:^|\D)(20\d{2})\s?[/-]\s?(\d{2}|20\d{2})\b`)                              // 2025/26, 2025-2026
	fyLabelRe = regexp.MustCompile(`(?i)(?:\bfy|\bhy|\bh[12]|\b[12]h|\bcy)\s?(?:fy|cy)?\s?'?(20\d{2}|\d{2})\b`) // fy25, h1 fy2025, 1h26, 1hfy26, hy25
	year4Re   = regexp.MustCompile(`\b(20\d{2})\b`)

	monthNames = map[string]time.Month{
		"jan": time.January, "january": time.January, "feb": time.February, "february": time.February,
		"mar": time.March, "march": time.March, "apr": time.April, "april": time.April, "may": time.May,
		"jun": time.June, "june": time.June, "jul": time.July, "july": time.July,
		"aug": time.August, "august": time.August, "sep": time.September, "sept": time.September,
		"september": time.September, "oct": time.October, "october": time.October,
		"nov": time.November, "november": time.November, "dec": time.December, "december": time.December,
	}
	dayMonthYearRe = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(20\d{2})\b`)
	monthYearRe    = regexp.MustCompile(`(?i)\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(20\d{2})\b`)
	numericDateRe  = regexp.MustCompile(`\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b`)
)

// parsePeriod resolves one metric's period string (rules 2-7). ok=false
// carries the reason, which the job logs in aggregate.
func parsePeriod(period string, pc periodContext) (resolvedPeriod, string, bool) {
	p := normalizePeriodText(period)
	fromHeadline := false
	if p == "" {
		p = normalizePeriodText(pc.Headline)
		fromHeadline = true
		if p == "" {
			return resolvedPeriod{}, "no period", false
		}
	}
	if periodRejectRe.MatchString(p) {
		return resolvedPeriod{}, "quarter, partial, forecast or comparative period", false
	}

	typ := ""
	switch {
	case periodHalfRe.MatchString(p):
		typ = periodHalf
	case periodAnnualRe.MatchString(p):
		typ = periodAnnual
	default:
		typ = headlineType(pc.Headline)
	}
	if typ == "" && fromHeadline {
		return resolvedPeriod{}, "no period", false
	}
	if typ == "" {
		return resolvedPeriod{}, "period type unknown", false
	}

	var end time.Time
	if d, ok := explicitDate(p); ok {
		end = d
	} else {
		fye := balanceMonth(pc)
		if m := calendarRe.FindStringSubmatch(p); m != nil {
			fye = time.December
		}
		if fye == 0 {
			return resolvedPeriod{}, "no balance date (no vendor annual row and no dated headline)", false
		}
		year, hasYear := labelYear(p)
		second := periodSecondRe.MatchString(p)
		switch {
		case hasYear:
			end = periodEndForFY(year, fye, typ, second)
		case !pc.ReportDate.IsZero():
			end = latestPeriodEnd(pc.ReportDate, fye, typ, second)
			if monthsBetween(end, pc.ReportDate) > noYearMaxLagMonths {
				return resolvedPeriod{}, "no year and no period end near the report date", false
			}
		default:
			return resolvedPeriod{}, "no year and no report date", false
		}
	}
	end = canonicalMonthEnd(end)

	if !pc.ReportDate.IsZero() {
		if end.After(pc.ReportDate.Add(periodFutureGrace)) {
			return resolvedPeriod{}, "period ends after the report (guidance or forecast)", false
		}
		if monthsBetween(end, pc.ReportDate) > periodMaxAgeMonths {
			return resolvedPeriod{}, "period ends more than 15 months before the report (a comparative)", false
		}
	}
	return resolvedPeriod{Type: typ, End: end}, "", true
}

// normalizePeriodText lower-cases, folds dashes, apostrophes and odd spaces,
// and collapses whitespace.
func normalizePeriodText(s string) string {
	r := strings.NewReplacer(
		"–", "-", "—", "-", "‑", "-", "‐", "-",
		" ", " ", " ", " ", "’", "'", "‘", "'", "′", "'",
	)
	s = strings.ToLower(r.Replace(s))
	return strings.Join(strings.Fields(s), " ")
}

// headlineType is the period type a headline implies, or "".
func headlineType(headline string) string {
	h := normalizePeriodText(headline)
	switch {
	case h == "":
		return ""
	case headlineHalfRe.MatchString(h):
		return periodHalf
	case headlineAnnualRe.MatchString(h):
		return periodAnnual
	}
	return ""
}

// explicitDate finds a calendar date in s: "30 June 2025", "31/12/2024"
// (Australian day/month order) or "December 2024" (the month's last day).
func explicitDate(s string) (time.Time, bool) {
	if m := dayMonthYearRe.FindStringSubmatch(s); m != nil {
		day, _ := strconv.Atoi(m[1])
		mon := monthNames[strings.ToLower(m[2])]
		year, _ := strconv.Atoi(m[3])
		if d, ok := validDate(year, mon, day); ok {
			return d, true
		}
	}
	if m := numericDateRe.FindStringSubmatch(s); m != nil {
		day, _ := strconv.Atoi(m[1])
		mon, _ := strconv.Atoi(m[2])
		year, _ := strconv.Atoi(m[3])
		if mon >= 1 && mon <= 12 {
			if d, ok := validDate(year, time.Month(mon), day); ok {
				return d, true
			}
		}
	}
	if m := monthYearRe.FindStringSubmatch(s); m != nil {
		mon := monthNames[strings.ToLower(m[1])]
		year, _ := strconv.Atoi(m[2])
		return lastDayOfMonth(year, mon), true
	}
	return time.Time{}, false
}

func validDate(year int, mon time.Month, day int) (time.Time, bool) {
	if mon < time.January || mon > time.December || day < 1 || day > 31 {
		return time.Time{}, false
	}
	d := time.Date(year, mon, day, 0, 0, 0, 0, time.UTC)
	if d.Month() != mon {
		return time.Time{}, false // 31 June
	}
	return d, true
}

// labelYear reads the fiscal year a label names: "2025/26" -> 2026, "FY25" ->
// 2025, "1H26" -> 2026, "H1 FY2025" -> 2025; a bare four-digit year last.
func labelYear(p string) (int, bool) {
	if m := fySpanRe.FindStringSubmatch(p); m != nil {
		first, _ := strconv.Atoi(m[1])
		second, _ := strconv.Atoi(m[2])
		if second < 100 {
			second += first / 100 * 100
		}
		if second == first+1 {
			return second, true
		}
	}
	if m := fyLabelRe.FindStringSubmatch(p); m != nil {
		return expandYear(m[1]), true
	}
	if m := year4Re.FindStringSubmatch(p); m != nil {
		y, _ := strconv.Atoi(m[1])
		return y, true
	}
	return 0, false
}

func expandYear(s string) int {
	y, _ := strconv.Atoi(s)
	if y < 100 {
		y += 2000
	}
	return y
}

// balanceMonth is rule 5 minus the period string's own date (handled by the
// caller): the vendor's rows, then a dated headline, else 0 (unknown; no
// default).
func balanceMonth(pc periodContext) time.Month {
	if pc.VendorFYE != 0 {
		return pc.VendorFYE
	}
	h := normalizePeriodText(pc.Headline)
	if d, ok := explicitDate(h); ok {
		switch headlineType(pc.Headline) {
		case periodAnnual:
			return canonicalMonthEnd(d).Month()
		case periodHalf:
			// A dated half-year headline names the first half, so the year
			// ends six months later. Month arithmetic, not AddDate: 31
			// December + 6 months is "31 June", which AddDate normalises to
			// 1 July.
			return addMonths(canonicalMonthEnd(d).Month(), 6)
		}
	}
	return 0
}

var (
	// quotePeriodPhraseRe: a period-end phrase inside a quote ("for the half
	// year ended 31 December 2024", "year to June 2026").
	quotePeriodPhraseRe = regexp.MustCompile(`(?i)\b(?:half[- ]?year|half|six[- ]months?|6[- ]months?|full[- ]year|financial[- ]year|year|twelve[- ]months?|12[- ]months?|period)\s+(?:ended|ending|to)\s+((?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+20\d{2})\b`)
	// quotePeriodLabelRe: a fiscal-period label inside a quote (FY25, 1H26,
	// H1 FY2031, HY25, 2H25, CY2025).
	quotePeriodLabelRe = regexp.MustCompile(`(?i)\b(fy|cy|hy|h[12]|[12]h)\s?(?:fy)?\s?'?(20\d{2}|\d{2})\b`)
	// comparisonLeadRe: words that make a period mention a COMPARISON
	// reference ("up 7% on the half year ended ...", "compared with 1H25"),
	// which says nothing about the period the quoted figure is for.
	comparisonLeadRe = regexp.MustCompile(`(?i)(?:\bon|\bfrom|\bversus|\bvs\.?|\bagainst|\bcompared\s+(?:to|with)|\bthan|\bover|\brelative\s+to)(?:\s+the)?(?:\s+(?:prior|previous|corresponding|same))*\s*$`)
)

// quoteNamesOnlyOtherPeriods is gate 4 applied to the quote itself: true when
// the quote names at least one period (a period-end phrase, or a fiscal label
// placed on the balance month fye) outside a comparison reference, and none of
// them is own. "Statutory NPAT for the half year ended 31 December 2024 was
// $4,748m" in a December 2025 half-year document is a comparative, whatever
// period label the model attached to it (CBA). A mention inside parentheses
// or after a comparison word ("up 7% on 1H25", "(1H25: $3.6bn)") is not a
// claim about the figure and is ignored; a quote naming no period passes.
func quoteNamesOnlyOtherPeriods(text string, own resolvedPeriod, fye time.Month) bool {
	t := normalizePeriodText(text)
	comparison := func(pos int) bool {
		before := t[:pos]
		if strings.Count(before, "(") > strings.Count(before, ")") {
			return true
		}
		return comparisonLeadRe.MatchString(before)
	}
	named, ownNamed := false, false
	note := func(end time.Time) {
		named = true
		if canonicalMonthEnd(end).Equal(own.End) {
			ownNamed = true
		}
	}
	for _, m := range quotePeriodPhraseRe.FindAllStringSubmatchIndex(t, -1) {
		if comparison(m[0]) {
			continue
		}
		if d, ok := explicitDate(t[m[2]:m[3]]); ok {
			note(d)
		}
	}
	if fye != 0 {
		for _, m := range quotePeriodLabelRe.FindAllStringSubmatchIndex(t, -1) {
			if comparison(m[0]) {
				continue
			}
			prefix, year := strings.ToLower(t[m[2]:m[3]]), expandYear(t[m[4]:m[5]])
			switch prefix {
			case "fy":
				note(periodEndForFY(year, fye, periodAnnual, false))
			case "cy":
				note(lastDayOfMonth(year, time.December))
			case "hy", "h1", "1h":
				note(periodEndForFY(year, fye, periodHalf, false))
			case "h2", "2h":
				note(periodEndForFY(year, fye, periodHalf, true))
			}
		}
	}
	return named && !ownNamed
}

// ownPeriodMaxLagMonths: gate 4 without document_meta.period_end takes the
// latest period end on or before the report date, but only within this lag
// (4D and 4E are due within two months, the annual report within four).
const ownPeriodMaxLagMonths = 5

// documentPeriod is gate 4's reference (plan fundamentals-coverage.md §4.2):
// the period the document itself reports.
//
//   - document_meta.period_end, when the extractor read one, is the end
//     (canonicalised to its month end, so a 52/53-week "29 June" is June);
//   - otherwise the latest half or annual end on or before the report date on
//     the company's balance date fye, when it lies within five months of the
//     report date; with no report date or no balance date there is no own
//     period and every metric in the document is withheld.
//
// The type is document_meta.period_type when present, else the headline's
// (Appendix 4D / half-year -> half, Appendix 4E / annual / full year ->
// annual), else the end's month (the balance month is annual, the other half
// end is a half).
func documentPeriod(meta extractiontrust.DocumentMeta, headline string, reportDate time.Time, fye time.Month) (resolvedPeriod, string, bool) {
	typeFor := func(end time.Time) string {
		switch meta.PeriodType {
		case extractiontrust.PeriodTypeAnnual:
			return periodAnnual
		case extractiontrust.PeriodTypeHalf:
			return periodHalf
		}
		if t := headlineType(headline); t != "" {
			return t
		}
		if end.Month() == fye {
			return periodAnnual
		}
		return periodHalf
	}
	if d, ok := meta.PeriodEndDate(); ok {
		end := canonicalMonthEnd(d)
		return resolvedPeriod{Type: typeFor(end), End: end}, "", true
	}
	if reportDate.IsZero() {
		return resolvedPeriod{}, "no document period and no report date", false
	}
	if fye == 0 {
		return resolvedPeriod{}, "no balance date", false
	}
	end := latestPeriodEnd(reportDate, fye, periodAnnual, false)
	if h := latestPeriodEnd(reportDate, fye, periodHalf, false); h.After(end) {
		end = h
	}
	if end.IsZero() || monthsBetween(end, reportDate) > ownPeriodMaxLagMonths {
		return resolvedPeriod{}, "no period end within five months before the report", false
	}
	return resolvedPeriod{Type: typeFor(end), End: end}, "", true
}

// periodEndForFY places a fiscal-year label on the balance date: FY Y ends on
// the last day of fye in year Y; its first half ends six months earlier, its
// second half with the year.
func periodEndForFY(year int, fye time.Month, typ string, second bool) time.Time {
	fyEnd := lastDayOfMonth(year, fye)
	if typ == periodAnnual || second {
		return fyEnd
	}
	m := int(fye) - 6
	y := year
	if m <= 0 {
		m += 12
		y--
	}
	return lastDayOfMonth(y, time.Month(m))
}

// latestPeriodEnd is the latest period end of the given kind on or before
// the report date: annual and second halves end in the fye month, first
// halves six months before it.
func latestPeriodEnd(reportDate time.Time, fye time.Month, typ string, second bool) time.Time {
	for y := reportDate.Year() + 1; y >= reportDate.Year()-2; y-- {
		end := periodEndForFY(y, fye, typ, second)
		if !end.After(reportDate) {
			return end
		}
	}
	return time.Time{}
}

// canonicalMonthEnd folds a date onto the month end it belongs to, with the
// 52/53-week shift fiscalYear uses: 2 July 2023 and 28 June 2023 are both
// June 2023.
func canonicalMonthEnd(d time.Time) time.Time {
	eff := d.AddDate(0, 0, effectiveMonthShift)
	if d.Day() >= 24 {
		// A late-month date (the 52/53-week "last Sunday" case) is that
		// month, not the one the shift lands in.
		eff = d
	}
	return lastDayOfMonth(eff.Year(), eff.Month())
}

// addMonths is month-of-year arithmetic (wraps December into January).
func addMonths(m time.Month, n int) time.Month {
	return time.Month((int(m)-1+n%12+12)%12 + 1)
}

func lastDayOfMonth(year int, m time.Month) time.Time {
	return time.Date(year, m+1, 0, 0, 0, 0, 0, time.UTC)
}

// monthsBetween is the whole months from a to b (b later), rounded down.
func monthsBetween(a, b time.Time) int {
	if a.IsZero() || b.IsZero() {
		return 0
	}
	n := (b.Year()-a.Year())*12 + int(b.Month()) - int(a.Month())
	if b.Day() < a.Day() && b.Day() < lastDayOfMonth(b.Year(), b.Month()).Day() {
		n--
	}
	return n
}
