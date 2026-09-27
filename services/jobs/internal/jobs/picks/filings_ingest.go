package picks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// -mode filings: financial_report_extractions.metrics -> stock_fundamentals.
//
// The report-extractor (services/jobs/internal/jobs/reportextract, still the
// Python image in prod) asks Gemini for the headline numbers of each ASX
// results document and stores them as JSONB:
//
//	{"revenue":    {"source_text": "...", "value_millions": "5142", "period": "H1 FY2025", "change_pct": "+8"},
//	 "net_profit": {...}, "eps": {"source_text": "...", "value_cents": "94.2", "period": "H1 FY2025"},
//	 "dividend": ..., "guidance": ...}
//
// A repeated class becomes a list of those objects. Filings are the only
// source of HALF-YEAR totals for ASX companies (Yahoo carries none), which is
// what the half-on-half growth in mv_fundamentals_growth needs.
//
// The mode is a pure, deterministic rebuild: every run reads every extraction
// with metrics, merges them in memory to one row per (code, period_type,
// period_end) and upserts. Nothing is fetched, nothing is sent to an LLM.
//
// What is read, and the rules that keep an LLM's mistake out of the table:
//
//   - Only revenue, net profit and EPS. A metric is taken only when its value
//     can be FOUND in its own source_text (the model is asked to quote the
//     sentence), in a unit the text makes unambiguous. Otherwise it is
//     skipped, never guessed: filingMoney and filingEPS.
//   - value_millions -> whole currency units (x 1e6). The text decides the
//     scale ("$45.2 million", "$1.2bn", "$45,213,000"); a bare "45.2" with no
//     unit and no "$m" marker is ambiguous (the same digits are thousands in
//     a $'000 table) and is skipped.
//   - EPS is stored in currency units per share (dollars, like Yahoo), from
//     cents when the number in the text is followed by c / cents / cps / ¢,
//     from dollars when it is written "$0.94" with no scale. A number with no
//     unit falls back to the attribute name (value_cents / value_dollars);
//     nothing else is guessed. "Loss per share" or a parenthesised number is
//     negative. Diluted when the text says diluted (and not basic), else
//     basic; "basic and diluted" sets both. When net profit and a vendor
//     share count are known, an EPS more than 5x away from NPAT / shares (a
//     cents-vs-dollars slip is 100x) is dropped.
//   - Net profit is statutory: text naming underlying / normalised /
//     adjusted / pro forma / EBITDA / segment figures is skipped. A loss
//     ("net loss after tax of $3.2 million") is stored negative.
//   - Currency: an explicit marker in the text (US$, USD, US cents, NZ$, £,
//     €, A$) wins; with none, the company's vendor reporting currency (BHP's
//     "$" in its own 4E is USD) and, with no vendor rows, AUD. Two different
//     markers in one quote: skipped.
//   - Periods: parsePeriod (filings_period.go) and its rules.
//   - Magnitude: a revenue more than 10x, or under 1/50th of, the company's
//     nearest vendor annual revenue (within two years) is dropped. That
//     catches a thousand-fold unit slip in either direction and leaves real
//     hyper-growth alone.
//   - Several documents for one period: per column, a statutory Appendix
//     4D/4E beats another results document, which beats anything else; then
//     the document filed closest after the period end (the first-hand
//     report, not a later comparative); then the URL, for determinism.
//
// Conflict with vendor rows (filingUpsertSQL): a filing NEVER overwrites a
// vendor's non-null value for the same (code, period_type, period_end); it
// only fills the vendor row's NULL columns, and only when the currencies
// agree. Filing rows for periods the vendor lacks (every 'half' row, and
// annual rows Yahoo has not caught up with) are inserted whole, and a filing
// row is replaced whole by the next run's merge. When Yahoo later publishes
// that annual period, the vendor upsert (upsertSQL) takes the row over: its
// values win and the filing's survive only where Yahoo has none.

// filingExtraction is one financial_report_extractions row with metrics.
type filingExtraction struct {
	Code       string
	URL        string
	Type       string
	Title      string
	ReportDate time.Time // zero when NULL
	Metrics    string    // the metrics JSONB as text
}

// vendorAnnual is one vendor annual row, the context the filing rules read.
type vendorAnnual struct {
	PeriodEnd time.Time
	Currency  string
	Revenue   *float64
	Shares    *float64
}

// filingMetricClasses maps the extractor's class names onto the columns.
// The few-shot prompt uses revenue / net_profit / eps; the aliases cover
// what a model has been seen to vary into.
var filingMetricClasses = map[string]string{
	"revenue":            "revenue",
	"total_revenue":      "revenue",
	"net_profit":         "net_income",
	"npat":               "net_income",
	"net_income":         "net_income",
	"statutory_npat":     "net_income",
	"eps":                "eps",
	"basic_eps":          "eps",
	"diluted_eps":        "eps",
	"earnings_per_share": "eps",
}

// filingKeys is the JSONB prefilter: an extraction without any of these keys
// is not read at all.
func filingKeys() []string {
	keys := make([]string, 0, len(filingMetricClasses))
	for k := range filingMetricClasses {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// filingValue is one candidate column value with its provenance rank.
type filingValue struct {
	value    float64
	currency string
	rank     int           // 0 statutory 4D/4E, 1 other results document, 2 other
	lag      time.Duration // report date - period end (MaxInt64 when unknown)
	url      string
}

func (a filingValue) better(b filingValue) bool {
	if a.rank != b.rank {
		return a.rank < b.rank
	}
	if a.lag != b.lag {
		return a.lag < b.lag
	}
	return a.url < b.url
}

type filingKey struct {
	code string
	typ  string
	end  time.Time
}

// filingCols holds the best candidate per column for one key.
type filingCols struct {
	revenue, netIncome, epsBasic, epsDiluted *filingValue
}

func (c *filingCols) slot(col string) **filingValue {
	switch col {
	case "revenue":
		return &c.revenue
	case "net_income":
		return &c.netIncome
	case "eps_basic":
		return &c.epsBasic
	case "eps_diluted":
		return &c.epsDiluted
	}
	return nil
}

// filingStats is the run's tally, logged at the end.
type filingStats struct {
	Extractions, HeadlineRejected, BadJSON int
	Metrics, Accepted                      int
	Skipped                                map[string]int // reason -> count
	Rows, Half, Annual, Codes              int
	EPSCrossChecked, MagnitudeDropped      int
	Written, Failed                        int
}

func (s *filingStats) skip(reason string) {
	if s.Skipped == nil {
		s.Skipped = map[string]int{}
	}
	s.Skipped[reason]++
}

func (s filingStats) String() string {
	reasons := make([]string, 0, len(s.Skipped))
	for r, n := range s.Skipped {
		reasons = append(reasons, fmt.Sprintf("%q=%d", r, n))
	}
	sort.Strings(reasons)
	return fmt.Sprintf("extractions=%d headline_rejected=%d bad_json=%d metrics=%d accepted=%d rows=%d (half=%d annual=%d) codes=%d eps_cross_check_dropped=%d magnitude_dropped=%d written=%d failed=%d skipped={%s}",
		s.Extractions, s.HeadlineRejected, s.BadJSON, s.Metrics, s.Accepted, s.Rows, s.Half, s.Annual, s.Codes,
		s.EPSCrossChecked, s.MagnitudeDropped, s.Written, s.Failed, strings.Join(reasons, " "))
}

// buildFilingRows turns extractions into stock_fundamentals rows, grouped by
// code. vendor holds each code's vendor annual rows.
func buildFilingRows(exts []filingExtraction, vendor map[string][]vendorAnnual, st *filingStats) map[string][]PeriodRow {
	merged := map[filingKey]*filingCols{}
	for _, ext := range exts {
		st.Extractions++
		code := normalizeCode(ext.Code)
		if code == "" {
			st.skip("bad stock code")
			continue
		}
		if reason := filingHeadlineRejection(ext.Title); reason != "" {
			st.HeadlineRejected++
			continue
		}
		var metrics map[string]json.RawMessage
		if err := json.Unmarshal([]byte(ext.Metrics), &metrics); err != nil {
			st.BadJSON++
			continue
		}
		rank := filingRank(ext.Title)
		pc := periodContext{Headline: ext.Title, ReportDate: ext.ReportDate, VendorFYE: vendorFYE(vendor[code])}
		defaultCurrency := vendorCurrency(vendor[code])

		// One document: collect candidates per (key, column), then keep a
		// column only when the document is unambiguous about it.
		type docKey struct {
			key filingKey
			col string
		}
		doc := map[docKey][]float64{}
		docCur := map[docKey]string{}
		classes := make([]string, 0, len(metrics))
		for class := range metrics {
			classes = append(classes, class)
		}
		sort.Strings(classes)
		for _, class := range classes {
			col, ok := filingMetricClasses[strings.ToLower(class)]
			if !ok {
				continue
			}
			for _, entry := range metricEntries(metrics[class]) {
				st.Metrics++
				period, reason, ok := parsePeriod(attrString(entry, "period"), pc)
				if !ok {
					st.skip(reason)
					continue
				}
				text := attrString(entry, "source_text")
				currency, ok := textCurrency(text, defaultCurrency)
				if !ok {
					st.skip("two currencies in one quote")
					continue
				}
				key := filingKey{code: code, typ: period.Type, end: period.End}
				switch col {
				case "revenue", "net_income":
					v, reason, ok := filingMoney(entry, col)
					if !ok {
						st.skip(reason)
						continue
					}
					dk := docKey{key, col}
					doc[dk] = append(doc[dk], v)
					docCur[dk] = currency
				case "eps":
					e, reason, ok := filingEPS(entry)
					if !ok {
						st.skip(reason)
						continue
					}
					for _, c := range e.cols {
						dk := docKey{key, c}
						doc[dk] = append(doc[dk], e.dollars)
						docCur[dk] = currency
					}
				}
			}
		}
		dks := make([]docKey, 0, len(doc))
		for dk := range doc {
			dks = append(dks, dk)
		}
		for _, dk := range dks {
			v, ok := agree(doc[dk])
			if !ok {
				st.skip("one document gives two values for one period")
				continue
			}
			st.Accepted++
			lag := time.Duration(math.MaxInt64)
			if !ext.ReportDate.IsZero() {
				lag = ext.ReportDate.Sub(dk.key.end)
			}
			cand := filingValue{value: v, currency: docCur[dk], rank: rank, lag: lag, url: ext.URL}
			cols := merged[dk.key]
			if cols == nil {
				cols = &filingCols{}
				merged[dk.key] = cols
			}
			slot := cols.slot(dk.col)
			if *slot == nil || cand.better(**slot) {
				c := cand
				*slot = &c
			}
		}
	}

	out := map[string][]PeriodRow{}
	keys := make([]filingKey, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].code != keys[j].code {
			return keys[i].code < keys[j].code
		}
		if !keys[i].end.Equal(keys[j].end) {
			return keys[i].end.Before(keys[j].end)
		}
		return keys[i].typ < keys[j].typ
	})
	for _, k := range keys {
		row, ok := filingRow(k, merged[k], vendor[k.code], st)
		if !ok {
			continue
		}
		out[k.code] = append(out[k.code], row)
	}
	for code, rows := range out {
		rows, rejected := sanitizeRows(rows)
		if rejected > 0 {
			st.skip("non-finite or implausible value")
		}
		if len(rows) == 0 {
			delete(out, code)
			continue
		}
		out[code] = rows
		st.Codes++
		for _, r := range rows {
			st.Rows++
			if r.PeriodType == periodHalf {
				st.Half++
			} else {
				st.Annual++
			}
		}
	}
	return out
}

// filingRow assembles one merged key into a row: one currency, the vendor
// cross-checks, the snap onto a vendor annual date, the fiscal year.
func filingRow(k filingKey, cols *filingCols, vendor []vendorAnnual, st *filingStats) (PeriodRow, bool) {
	// One currency per row: the revenue's, else the profit's, else the EPS's.
	// A column in another currency is dropped rather than mixed in.
	currency := ""
	for _, v := range []*filingValue{cols.revenue, cols.netIncome, cols.epsBasic, cols.epsDiluted} {
		if v != nil {
			currency = v.currency
			break
		}
	}
	take := func(v *filingValue) *float64 {
		if v == nil {
			return nil
		}
		if v.currency != currency {
			st.skip("column in a different currency from the row")
			return nil
		}
		x := v.value
		return &x
	}
	end := k.end
	if k.typ == periodAnnual {
		end = snapToVendorAnnual(end, vendor)
	}
	row := PeriodRow{
		PeriodType: k.typ,
		PeriodEnd:  end,
		Currency:   currency,
		Revenue:    take(cols.revenue),
		NetIncome:  take(cols.netIncome),
		EPSBasic:   take(cols.epsBasic),
		EPSDiluted: take(cols.epsDiluted),
		Source:     sourceFiling,
	}

	if row.Revenue != nil {
		if ref := nearestVendorRevenue(end, currency, vendor); ref > 0 {
			r := math.Abs(*row.Revenue)
			if r > ref*10 || r < ref/50 {
				st.MagnitudeDropped++
				row.Revenue = nil
			}
		}
	}
	if row.NetIncome != nil {
		if shares := latestVendorShares(vendor); shares > 0 {
			implied := *row.NetIncome / shares
			for _, eps := range []**float64{&row.EPSBasic, &row.EPSDiluted} {
				if *eps != nil && !epsConsistent(**eps, implied) {
					st.EPSCrossChecked++
					*eps = nil
				}
			}
		}
	}
	if !row.hasValues() {
		return PeriodRow{}, false
	}
	fy := fiscalYear(end, fiscalYearEndMonthFromVendor(vendor, k))
	row.FiscalYear = &fy
	return row, true
}

// epsConsistent: a reported EPS within 5x of NPAT / shares, same sign. Share
// counts move (raises, buy-backs, weighted averages), a cents/dollars slip is
// 100x. An EPS or implied EPS of ~zero is not checkable and passes.
func epsConsistent(eps, implied float64) bool {
	if math.Abs(eps) < 1e-6 || math.Abs(implied) < 1e-6 {
		return true
	}
	if (eps > 0) != (implied > 0) {
		return false
	}
	ratio := math.Abs(eps / implied)
	return ratio <= 5 && ratio >= 0.2
}

// filingRank orders documents: statutory Appendix 4D/4E first.
func filingRank(title string) int {
	switch classifyResultsFiling(title) {
	case filingAppendix4DE:
		return 0
	case filingAnnualReport, filingPeriodResults:
		return 1
	}
	return 2
}

// metricEntries accepts both stored shapes: one object, or a list of them.
func metricEntries(raw json.RawMessage) []map[string]any {
	var one map[string]any
	if err := json.Unmarshal(raw, &one); err == nil {
		return []map[string]any{one}
	}
	var many []map[string]any
	if err := json.Unmarshal(raw, &many); err == nil {
		return many
	}
	return nil
}

// attrString reads an attribute as a string (the model sometimes returns a
// JSON number).
func attrString(entry map[string]any, key string) string {
	switch v := entry[key].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	}
	return ""
}

// agree collapses one document's candidates for one column: identical within
// 0.1% is one value; anything else is ambiguous.
func agree(vs []float64) (float64, bool) {
	if len(vs) == 0 {
		return 0, false
	}
	for _, v := range vs[1:] {
		if !approxEqual(v, vs[0]) {
			return 0, false
		}
	}
	return vs[0], true
}

// approxEqual is equality within 0.1%: enough for "$45,213,456" read as
// 45.21 million, too tight for two different EPS figures (94.2 vs 93.8 is
// 0.4%) to pass as one.
func approxEqual(a, b float64) bool {
	return withinRel(a, b, 0.001)
}

// sameNumber is equality up to float noise: an EPS value must appear in its
// quote as written.
func sameNumber(a, b float64) bool {
	return withinRel(a, b, 1e-9)
}

func withinRel(a, b, rel float64) bool {
	if a == b {
		return true
	}
	d := math.Abs(a - b)
	m := math.Max(math.Abs(a), math.Abs(b))
	return d <= rel*m || d < 1e-12
}

// ------------------------------------------------------------------ values

var (
	// A number in text: optional sign or parenthesis, digits with thousands
	// separators, optional decimals.
	numberRe = regexp.MustCompile(`\(?-?\d[\d,]*(?:\.\d+)?\)?`)
	// Scale words directly after a number.
	scaleRe = regexp.MustCompile(`(?i)^\s*(billion|bn|b|million|mn|mill|m|thousand|k|'000|000s)\b`)
	// Table-heading markers that say bare numbers are millions / thousands.
	millionsMarkerRe  = regexp.MustCompile(`(?i)\$\s?m\b|\$\s?million\b|\(\s?\$?m\s?\)|\$'?m\b|\bm\$|\bin millions\b`)
	thousandsMarkerRe = regexp.MustCompile(`(?i)\$\s?'?000\b|\$000s?\b|\bin thousands\b|\(\s?\$?'000\s?\)`)
	nonStatutoryRe    = regexp.MustCompile(`(?i)\bunderlying\b|\bnormali[sz]ed\b|\badjusted\b|\bpro[- ]?forma\b|\bebitda\b|\bebit\b|\bsegment\b|\bexcluding\b|\bgross profit\b|\bother income\b|\binterest (?:income|revenue)\b|\bcash receipts\b`)
	lossRe            = regexp.MustCompile(`(?i)\bloss\b`)
	profitRe          = regexp.MustCompile(`(?i)\bprofit\b`)
)

// textNumber is one number found in a quote, with what surrounds it.
type textNumber struct {
	value    float64
	negative bool   // parenthesised or signed
	dollar   bool   // preceded by $ (A$, US$, ...)
	scale    string // billion | million | thousand | ""
	after    string // the text right after it (lower case, for unit words)
	digits   int    // integer digits, separators excluded
	pos      int    // byte offset in the quote
}

func findNumbers(text string) []textNumber {
	var out []textNumber
	for _, loc := range numberRe.FindAllStringIndex(text, -1) {
		raw := text[loc[0]:loc[1]]
		neg := strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") || strings.HasPrefix(strings.TrimPrefix(raw, "("), "-")
		clean := strings.NewReplacer("(", "", ")", "", ",", "", "-", "").Replace(raw)
		v, err := strconv.ParseFloat(clean, 64)
		if err != nil {
			continue
		}
		intPart := clean
		if i := strings.IndexByte(clean, '.'); i >= 0 {
			intPart = clean[:i]
		}
		n := textNumber{value: v, negative: neg, digits: len(strings.TrimLeft(intPart, "0")), pos: loc[0]}
		before := strings.TrimRight(text[:loc[0]], " ")
		n.dollar = strings.HasSuffix(before, "$")
		rest := text[loc[1]:]
		if m := scaleRe.FindStringSubmatch(rest); m != nil {
			switch strings.ToLower(m[1]) {
			case "billion", "bn", "b":
				n.scale = "billion"
			case "million", "mn", "mill", "m":
				n.scale = "million"
			default:
				n.scale = "thousand"
			}
		}
		if len(rest) > 40 {
			rest = rest[:40]
		}
		n.after = strings.ToLower(rest)
		out = append(out, n)
	}
	return out
}

// parseAttrNumber reads a numeric attribute ("5,142", "-3.2", "(3.2)", 94.2).
func parseAttrNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	neg := strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")")
	s = strings.NewReplacer("(", "", ")", "", ",", "", "$", "", " ", "", "+", "").Replace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	if neg {
		v = -math.Abs(v)
	}
	return v, true
}

// filingMoney reads revenue / net profit: value_millions, verified against
// the quote's own number and scale, returned in whole currency units.
func filingMoney(entry map[string]any, col string) (float64, string, bool) {
	text := attrString(entry, "source_text")
	if text == "" {
		return 0, "no source text", false
	}
	if nonStatutoryRe.MatchString(text) {
		return 0, "not a statutory figure", false
	}
	mill, ok := parseAttrNumber(attrString(entry, "value_millions"))
	if !ok {
		return 0, "no value_millions", false
	}
	millionsTable := millionsMarkerRe.MatchString(text)
	thousandsTable := thousandsMarkerRe.MatchString(text)
	found, negative := false, false
	for _, n := range findNumbers(text) {
		var interp []float64
		switch n.scale {
		case "billion":
			interp = []float64{n.value * 1000}
		case "million":
			interp = []float64{n.value}
		case "thousand":
			interp = []float64{n.value / 1000}
		default:
			switch {
			case n.digits >= 7 && !thousandsTable:
				interp = []float64{n.value / 1e6} // whole units: 45,213,000
			case millionsTable && !thousandsTable:
				interp = []float64{n.value}
			case thousandsTable && !millionsTable:
				interp = []float64{n.value / 1000}
			}
		}
		for _, v := range interp {
			if v != 0 && approxEqual(v, math.Abs(mill)) {
				found = true
				negative = n.negative
			}
		}
		if found {
			break
		}
	}
	if !found {
		return 0, "value not found in its quote with an unambiguous scale", false
	}
	v := math.Abs(mill) * 1e6
	switch col {
	case "revenue":
		if mill < 0 || negative {
			return 0, "negative revenue", false
		}
	case "net_income":
		loss := mill < 0 || negative || (lossRe.MatchString(text) && !profitRe.MatchString(text))
		if loss {
			v = -v
		}
	}
	return v, "", true
}

// epsReading is one EPS in dollars per share and the columns it belongs to.
type epsReading struct {
	dollars float64
	cols    []string // eps_basic and/or eps_diluted
}

var (
	centsAfterRe     = regexp.MustCompile(`^\s*(?:c\b|¢|cents?\b|cps\b|cent\b|us\s?cents?\b|us\s?c\b)`)
	centsAnywhereRe  = regexp.MustCompile(`(?i)\bcents?\b|\bcps\b|¢`)
	dilutedRe        = regexp.MustCompile(`(?i)\bdiluted\b`)
	bothEPSRe        = regexp.MustCompile(`(?i)\bbasic\s*(?:and|&|/)\s*diluted\b|\bdiluted\s*(?:and|&|/)\s*basic\b`)
	basicRe          = regexp.MustCompile(`(?i)\bbasic\b`)
	lossPerShareRe   = regexp.MustCompile(`(?i)\bloss(?:es)?\s+per\s+share\b|\bnegative\b`)
	maxPlausibleEPS  = 1000.0 // dollars per share
	epsDollarKeys    = []string{"value_dollars", "value_aud", "value_per_share"}
	epsCentsKeys     = []string{"value_cents", "value_cps"}
	epsUnitlessKeys  = []string{"value"}
	epsAnyValueOrder = append(append(append([]string{}, epsCentsKeys...), epsDollarKeys...), epsUnitlessKeys...)
)

// filingEPS reads an EPS entry. The unit comes from the text around the
// value's own number: cents when followed by c / cents / cps / ¢, dollars
// when written $x with no scale. No unit next to the number: "cents" elsewhere
// in the quote, else the attribute's name. Anything else is skipped.
func filingEPS(entry map[string]any) (epsReading, string, bool) {
	text := attrString(entry, "source_text")
	if text == "" {
		return epsReading{}, "no source text", false
	}
	if nonStatutoryRe.MatchString(text) {
		return epsReading{}, "not a statutory figure", false
	}
	key, raw := "", ""
	for _, k := range epsAnyValueOrder {
		if s := attrString(entry, k); s != "" {
			key, raw = k, s
			break
		}
	}
	if raw == "" {
		return epsReading{}, "no EPS value (or only value_millions)", false
	}
	v, ok := parseAttrNumber(raw)
	if !ok {
		return epsReading{}, "unparseable EPS value", false
	}

	var match *textNumber
	for _, n := range findNumbers(text) {
		if sameNumber(n.value, math.Abs(v)) && n.scale == "" {
			n := n
			match = &n
			break
		}
	}
	if match == nil {
		return epsReading{}, "EPS value not found in its quote", false
	}
	unit := ""
	switch {
	case centsAfterRe.MatchString(match.after) && match.dollar:
		return epsReading{}, "EPS written as both $ and cents", false
	case centsAfterRe.MatchString(match.after):
		unit = "cents"
	case match.dollar:
		unit = "dollars"
	case centsAnywhereRe.MatchString(text):
		unit = "cents"
	case containsKey(epsCentsKeys, key):
		unit = "cents"
	case containsKey(epsDollarKeys, key):
		unit = "dollars"
	default:
		return epsReading{}, "EPS unit ambiguous (cents or dollars)", false
	}
	dollars := math.Abs(v)
	if unit == "cents" {
		dollars /= 100
	}
	if v < 0 || match.negative || lossPerShareRe.MatchString(text) {
		dollars = -dollars
	}
	if math.Abs(dollars) > maxPlausibleEPS {
		return epsReading{}, "implausible EPS", false
	}
	return epsReading{dollars: dollars, cols: epsColumns(text, match.pos)}, "", true
}

// epsColumns decides basic vs diluted: "basic and diluted" (either order, or
// "basic/diluted") is both; otherwise the qualifier nearest BEFORE the number
// ("Basic EPS 94.2c, diluted 93.8c" gives 94.2 to basic); no qualifier is
// basic, the Appendix 4D/4E default.
func epsColumns(text string, pos int) []string {
	if bothEPSRe.MatchString(text) {
		return []string{"eps_basic", "eps_diluted"}
	}
	before := text[:pos]
	b := lastIndex(basicRe, before)
	d := lastIndex(dilutedRe, before)
	if d > b {
		return []string{"eps_diluted"}
	}
	if b < 0 && d < 0 && dilutedRe.MatchString(text) && !basicRe.MatchString(text) {
		return []string{"eps_diluted"} // "... 93.8 cents (diluted)"
	}
	return []string{"eps_basic"}
}

func lastIndex(rx *regexp.Regexp, s string) int {
	locs := rx.FindAllStringIndex(s, -1)
	if len(locs) == 0 {
		return -1
	}
	return locs[len(locs)-1][0]
}

func containsKey(keys []string, k string) bool {
	for _, x := range keys {
		if x == k {
			return true
		}
	}
	return false
}

var currencyMarkers = []struct {
	code string
	rx   *regexp.Regexp
}{
	{"USD", regexp.MustCompile(`(?i)\bUS\s?\$|\bUSD\b|\bUS\s?dollars?\b|\bUS\s?cents?\b|\bUSc\b`)},
	{"NZD", regexp.MustCompile(`(?i)\bNZ\s?\$|\bNZD\b|\bNZ\s?cents?\b`)},
	{"GBP", regexp.MustCompile(`£|\bGBP\b|\bpence\b`)},
	{"EUR", regexp.MustCompile(`€|\bEUR\b`)},
	{"CAD", regexp.MustCompile(`\bC\$|\bCAD\b`)},
	{"AUD", regexp.MustCompile(`\bA\$|\bAUD\b|\bAU\$`)},
}

// textCurrency is the quote's currency: an explicit marker, else def.
func textCurrency(text, def string) (string, bool) {
	found := ""
	for _, m := range currencyMarkers {
		if m.rx.MatchString(text) {
			if found != "" && found != m.code {
				return "", false
			}
			found = m.code
		}
	}
	if found != "" {
		return found, true
	}
	return def, true
}

// ------------------------------------------------------------------ vendor

// vendorFYE is the balance-date month from the vendor's annual rows (0 when
// there are none, so parsePeriod falls through to June).
func vendorFYE(rows []vendorAnnual) time.Month {
	var latest time.Time
	for _, r := range rows {
		if r.PeriodEnd.After(latest) {
			latest = r.PeriodEnd
		}
	}
	if latest.IsZero() {
		return 0
	}
	return latest.AddDate(0, 0, effectiveMonthShift).Month()
}

// fiscalYearEndMonthFromVendor is the balance date fiscal_year is derived
// with: the vendor's when known, else the month the row's own period implies
// (an annual row ends in it; a half is H1 unless it ends in the vendor month).
func fiscalYearEndMonthFromVendor(rows []vendorAnnual, k filingKey) time.Month {
	if m := vendorFYE(rows); m != 0 {
		return m
	}
	if k.typ == periodAnnual {
		return k.end.Month()
	}
	return defaultFYEMonth
}

// vendorCurrency is the vendor's reporting currency (latest annual row), AUD
// without one.
func vendorCurrency(rows []vendorAnnual) string {
	var latest vendorAnnual
	for _, r := range rows {
		if r.PeriodEnd.After(latest.PeriodEnd) && r.Currency != "" {
			latest = r
		}
	}
	if latest.Currency == "" {
		return "AUD"
	}
	return latest.Currency
}

// snapToVendorAnnual moves an annual filing date onto the vendor's date for
// the same year when they are within ten days (a 52/53-week year Yahoo dates
// 2 July), so the conflict policy sees one period, not two.
func snapToVendorAnnual(end time.Time, rows []vendorAnnual) time.Time {
	for _, r := range rows {
		d := r.PeriodEnd.Sub(end)
		if d < 0 {
			d = -d
		}
		if d <= 10*24*time.Hour {
			return r.PeriodEnd
		}
	}
	return end
}

// nearestVendorRevenue is the vendor annual revenue closest to end, within
// two years and in the same currency; 0 when there is none.
func nearestVendorRevenue(end time.Time, currency string, rows []vendorAnnual) float64 {
	best, bestGap := 0.0, time.Duration(math.MaxInt64)
	for _, r := range rows {
		if r.Revenue == nil || *r.Revenue <= 0 || r.Currency != currency {
			continue
		}
		gap := r.PeriodEnd.Sub(end)
		if gap < 0 {
			gap = -gap
		}
		if gap <= 2*365*24*time.Hour && gap < bestGap {
			best, bestGap = *r.Revenue, gap
		}
	}
	return best
}

// latestVendorShares is the latest vendor share count; 0 when none.
func latestVendorShares(rows []vendorAnnual) float64 {
	var latest time.Time
	shares := 0.0
	for _, r := range rows {
		if r.Shares != nil && *r.Shares > 0 && r.PeriodEnd.After(latest) {
			latest, shares = r.PeriodEnd, *r.Shares
		}
	}
	return shares
}

// ------------------------------------------------------------------ run

// runFilings is -mode filings: read, merge, upsert. A dry run reads and logs
// and writes nothing. Exit rule: a read failure is exit 1; some codes failing
// to write is DEGRADED (10); every write failing is exit 1.
func runFilings(ctx context.Context, st store, dryRun bool, logf func(string, ...any)) (filingStats, error) {
	var stats filingStats
	if st == nil {
		return stats, errors.New("filings: no database")
	}
	exts, err := st.FilingExtractions(ctx)
	if err != nil {
		return stats, err
	}
	vendor, err := st.VendorAnnuals(ctx)
	if err != nil {
		return stats, err
	}
	rows := buildFilingRows(exts, vendor, &stats)
	codes := make([]string, 0, len(rows))
	for c := range rows {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	now := time.Now()
	for _, code := range codes {
		if err := ctx.Err(); err != nil {
			return stats, fmt.Errorf("filings: cancelled after %d/%d codes: %w", stats.Written, len(codes), err)
		}
		if dryRun {
			for _, r := range rows[code] {
				logf("picks: filings: dry run: %s %s %s %s revenue=%s net_income=%s eps_basic=%s eps_diluted=%s",
					code, r.PeriodType, r.PeriodEnd.Format("2006-01-02"), r.Currency,
					fmtOpt(r.Revenue), fmtOpt(r.NetIncome), fmtOpt(r.EPSBasic), fmtOpt(r.EPSDiluted))
			}
			continue
		}
		if err := st.UpsertFilingPeriods(ctx, code, rows[code], now); err != nil {
			stats.Failed++
			logf("picks: filings: %s FAILED: %v", code, err)
			continue
		}
		stats.Written++
	}
	logf("picks: filings done (dry_run=%t): %s", dryRun, stats)
	switch {
	case stats.Failed > 0 && stats.Written == 0:
		return stats, fmt.Errorf("picks: filings DOWN: every write failed (%s)", stats)
	case stats.Failed > 0:
		return stats, &runner.ExitCodeError{
			Code: exitCodeDegraded,
			Err:  fmt.Errorf("picks: filings DEGRADED: %d/%d codes failed to write (%s)", stats.Failed, len(codes), stats),
		}
	}
	return stats, nil
}

func fmtOpt(v *float64) string {
	if v == nil {
		return "-"
	}
	return strconv.FormatFloat(*v, 'g', 6, 64)
}
