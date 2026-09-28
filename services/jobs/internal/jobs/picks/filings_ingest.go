package picks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// -mode filings: financial_report_extractions.metrics -> stock_fundamentals,
// fail-closed (plan docs/plans/fundamentals-coverage.md §4).
//
// The report-extractor (services/report-extractor, the Python image in prod)
// asks Gemini for the headline numbers of each ASX results document and
// stores them as JSONB:
//
//	{"revenue":    {"source_text": "...", "value_millions": "3847", "period": "H1 FY2031", "change_pct": "+7",
//	                "alignment": "match_exact", "char_start": "120", "char_end": "210"},
//	 "net_profit": {...}, "eps": {"source_text": "...", "value_cents": "48.3", "period": "H1 FY2031"}, ...}
//
// A repeated class becomes a list of those objects. Filings are the only
// source of HALF-YEAR totals for ASX companies (Yahoo carries none), which is
// what the half-on-half growth in mv_fundamentals_growth needs.
//
// Measured on prod 2026-09-28, the previous, permissive version of this mode
// published fabricated numbers: the prompt's own few-shot example (revenue
// $5,142m, NPAT $1,823m, EPS 94.2c) as BHP's, CBA's, DRO's, EDV's and MSB's
// results; comparatives as the current period (CBA); channel and segment
// figures as revenue (EDV, GYG, DMP, FLT); another company's report (LFT
// carrying Winsome); "Profit from operations" as NPAT (BHP); December filers
// dated June (DRO). So every value now passes nine gates, in order, each
// counted in the run summary (filingStats.Gates):
//
//  1. Document: digest_confidence >= 0.3 (NULL passes); a statutory results
//     document (extractiontrust.IsResultsDocument over the headline and
//     document_meta.report_kind); document_meta.entity, when present, names
//     the code's company; report_kind is not "other".
//  2. Grounding and 3. few-shot denylist: extractiontrust.GroundedEntry (the
//     extractor aligned the quote to the document, and it is not an echo of
//     either few-shot example).
//  4. Own period: the metric's period IS the document's own period
//     (documentPeriod), and its quote does not name only another period
//     (quoteNamesOnlyOtherPeriods: a comparative labelled as current).
//  5. Statutory: the quote names no non-statutory, partial or pre-tax figure
//     (nonStatutoryRe).
//  6. Vendor context: the code has a vendor annual row and a trustworthy
//     vendor currency (vendorContext); the balance month and the currency come
//     from the vendor. No context, no filing row (skipped_no_vendor).
//  7. Currency: an explicit marker in the quote, and document_meta.currency,
//     must equal the vendor currency.
//  8. Magnitude, against same-currency vendor references (revenueBand; net
//     income <= 1.5 x revenue; EPS within [0.5, 2] of net income / vendor
//     shares, written only when that check can run).
//  9. TTM-EPS identity for first halves (ttmEPSIdentity).
//
// The mode is a pure, deterministic rebuild: every run reads every extraction
// with metrics, merges them to one row per (code, period_type, period_end) and
// rewrites the filing data in ONE transaction (filings_store.go): filing rows
// and filing-filled vendor fields this run no longer produces are removed, the
// rest upserted. Nothing is fetched, nothing is sent to an LLM.

// filingExtraction is one financial_report_extractions row with metrics.
type filingExtraction struct {
	Code       string
	URL        string
	Type       string
	Title      string
	ReportDate time.Time // zero when NULL
	Metrics    string    // the metrics JSONB as text
	// DigestConfidence is digest_confidence; nil when NULL.
	DigestConfidence *float64
	// DocumentMeta is the document_meta JSONB as text; "" when NULL or when the
	// column does not exist yet (migration 000132 absent).
	DocumentMeta string
}

// filingInputs is everything besides the extractions that the gates read.
type filingInputs struct {
	vendor   map[string][]vendorRow
	profiles map[string]companyProfile
}

// minDigestConfidence: gate 1 skips a document the digest step judged not to
// state financial results (the digest prompt sets confidence below 0.3 for a
// cover note or an administrative document).
const minDigestConfidence = 0.3

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

// Gate counters, filingStats.Gates keys: the contract's gate number, then the
// reason. Gate 1 counts DOCUMENTS; gates 2-7 count metric ENTRIES, each at the
// first gate it fails (gate 4 needs the balance month gate 6 supplies, so a
// code without vendor context is counted at gate 6); gates 8 and 9 count row
// FIELDS withheld.
const (
	gateLowConfidence      = "1_document.low_digest_confidence"
	gateReportKindOther    = "1_document.report_kind_other"
	gateNotResults         = "1_document.not_a_results_document"
	gateForeignEntity      = "1_document.foreign_entity"
	gateEntityUnverifiable = "1_document.entity_unverifiable"
	gateBadJSON            = "1_document.metrics_not_json"
	gateUnaligned          = "2_grounding.unaligned"
	gateFewShot            = "3_fewshot.echo"
	gateOwnPeriodUnknown   = "4_own_period.undetermined"
	gatePeriodUnparsed     = "4_own_period.unparsed"
	gateNotOwnPeriod       = "4_own_period.not_the_document_period"
	gateQuoteOtherPeriod   = "4_own_period.quote_names_another_period"
	gateNonStatutory       = "5_statutory"
	gateNoVendor           = "6_vendor.skipped_no_vendor"
	gateVendorCurrency     = "6_vendor.currency_unknown"
	gateCurrencyMeta       = "7_currency.document_meta"
	gateCurrencyQuote      = "7_currency.quote_marker"
	gateTwoCurrencies      = "7_currency.two_markers_in_quote"
	gateRevenueNoRef       = "8_magnitude.revenue_no_reference"
	gateRevenueRange       = "8_magnitude.revenue_out_of_range"
	gateNetIncome          = "8_magnitude.net_income_over_1.5x_revenue"
	gateEPSUncheckable     = "8_magnitude.eps_uncheckable"
	gateEPSRange           = "8_magnitude.eps_out_of_range"
	gateTTMIdentity        = "9_ttm_eps_identity"
)

// filingValue is one candidate column value with its provenance.
type filingValue struct {
	value      float64
	rank       int           // 0 statutory Appendix 4D/4E, 1 other results document
	lag        time.Duration // report date - period end (MaxInt64 when unknown)
	url        string
	reportDate time.Time // zero when unknown
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
	Extractions int // rows read
	Documents   int // documents that passed gate 1
	Metrics     int // metric entries read from those documents
	Accepted    int // (document, key, column) values that passed gates 2-7
	// Gates counts every withholding by gate (see the gate constants).
	Gates map[string]int
	// Skipped counts value-parsing failures and other reasons that are not a
	// gate (a figure not found in its quote, an ambiguous unit, ...).
	Skipped map[string]int
	// NoVendorCodes is the number of distinct codes gate 6 skipped for lack
	// of a vendor annual row.
	NoVendorCodes int

	Rows, Half, Annual, Codes int

	// The rebuild (zero on a dry run or a refusal).
	Purged       int  // filing rows deleted
	FieldsNulled int  // filing-filled vendor fields set to NULL
	DocsCleared  int  // vendor rows whose document columns were cleared
	Upserted     int  // rows inserted or changed
	Written      int  // codes with at least one row inserted or changed
	Failed       int  // 1 when the rebuild transaction failed
	Legacy       bool // migration 000132 absent: the legacy write path ran
	Refused      bool // the write was refused (§4.3)
}

func (s *filingStats) gate(name string) {
	if s.Gates == nil {
		s.Gates = map[string]int{}
	}
	s.Gates[name]++
}

func (s *filingStats) skip(reason string) {
	if s.Skipped == nil {
		s.Skipped = map[string]int{}
	}
	s.Skipped[reason]++
}

// Changed reports whether the rebuild changed stock_fundamentals at all (the
// revalidation step's "wrote rows" signal, plan §3.8).
func (s filingStats) Changed() bool {
	return s.Purged+s.FieldsNulled+s.DocsCleared+s.Upserted > 0
}

func sortedCounts(m map[string]int) string {
	parts := make([]string, 0, len(m))
	for k, n := range m {
		parts = append(parts, fmt.Sprintf("%q=%d", k, n))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

func (s filingStats) String() string {
	return fmt.Sprintf("extractions=%d documents=%d metrics=%d accepted=%d rows=%d (half=%d annual=%d) codes=%d no_vendor_codes=%d "+
		"purged=%d fields_nulled=%d docs_cleared=%d upserted=%d written_codes=%d failed=%d legacy=%t refused=%t gates={%s} skipped={%s}",
		s.Extractions, s.Documents, s.Metrics, s.Accepted, s.Rows, s.Half, s.Annual, s.Codes, s.NoVendorCodes,
		s.Purged, s.FieldsNulled, s.DocsCleared, s.Upserted, s.Written, s.Failed, s.Legacy, s.Refused,
		sortedCounts(s.Gates), sortedCounts(s.Skipped))
}

// buildFilingRows turns extractions into stock_fundamentals rows, grouped by
// code, through gates 1-9.
func buildFilingRows(exts []filingExtraction, in filingInputs, st *filingStats) map[string][]PeriodRow {
	contexts := map[string]vendorContext{}
	contextFor := func(code string) vendorContext {
		vc, ok := contexts[code]
		if !ok {
			vc = newVendorContext(in.vendor[code])
			contexts[code] = vc
		}
		return vc
	}
	noVendor := map[string]bool{}

	merged := map[filingKey]*filingCols{}
	for _, ext := range exts {
		st.Extractions++
		code := normalizeCode(ext.Code)
		if code == "" {
			st.skip("bad stock code")
			continue
		}
		meta, err := extractiontrust.ParseDocumentMeta([]byte(ext.DocumentMeta))
		if err != nil {
			st.skip("document_meta unreadable (treated as absent)")
			meta = extractiontrust.DocumentMeta{}
		}

		// Gate 1: the document.
		if ext.DigestConfidence != nil && *ext.DigestConfidence < minDigestConfidence {
			st.gate(gateLowConfidence)
			continue
		}
		if meta.ReportKind == extractiontrust.ReportKindOther {
			st.gate(gateReportKindOther)
			continue
		}
		if !extractiontrust.IsResultsDocument(ext.Title, meta.ReportKind) {
			st.gate(gateNotResults)
			continue
		}
		if meta.Entity != "" {
			name := in.profiles[code].Name
			if strings.TrimSpace(name) == "" {
				st.gate(gateEntityUnverifiable)
				continue
			}
			if !entityMatches(meta.Entity, name) {
				st.gate(gateForeignEntity)
				continue
			}
		}
		var metrics map[string]json.RawMessage
		if err := json.Unmarshal([]byte(ext.Metrics), &metrics); err != nil {
			st.gate(gateBadJSON)
			continue
		}
		st.Documents++

		vc := contextFor(code)
		rank := filingRank(ext.Title, meta.ReportKind)
		pc := periodContext{Headline: ext.Title, ReportDate: ext.ReportDate, VendorFYE: vc.fye}
		var own resolvedPeriod
		ownReason, ownOK := "", false
		if vc.hasAnnual() {
			own, ownReason, ownOK = documentPeriod(meta, ext.Title, ext.ReportDate, vc.fye)
		}

		// One document: collect candidates per (key, column), then keep a
		// column only when the document is unambiguous about it.
		type docKey struct {
			key filingKey
			col string
		}
		doc := map[docKey][]float64{}
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
				text := attrString(entry, "source_text")
				// Gates 2 and 3.
				if !extractiontrust.GroundedEntry(entry) {
					if extractiontrust.IsFewShotText(text) {
						st.gate(gateFewShot)
					} else {
						st.gate(gateUnaligned)
					}
					continue
				}
				// Gate 6 first where gate 4 needs it: the balance month.
				if !vc.hasAnnual() {
					st.gate(gateNoVendor)
					noVendor[code] = true
					continue
				}
				// Gate 4.
				if !ownOK {
					st.gate(gateOwnPeriodUnknown)
					st.skip("own period: " + ownReason)
					continue
				}
				period, reason, ok := parsePeriod(attrString(entry, "period"), pc)
				if !ok {
					st.gate(gatePeriodUnparsed)
					st.skip("period: " + reason)
					continue
				}
				if period.Type != own.Type || !period.End.Equal(own.End) {
					st.gate(gateNotOwnPeriod)
					continue
				}
				if quoteNamesOnlyOtherPeriods(text, own, vc.fye) {
					st.gate(gateQuoteOtherPeriod)
					continue
				}
				// Gate 5.
				if !statutory(text) {
					st.gate(gateNonStatutory)
					continue
				}
				// Gate 6: a trustworthy vendor currency.
				if vc.currency == "" {
					st.gate(gateVendorCurrency)
					continue
				}
				// Gate 7.
				if meta.Currency != "" && meta.Currency != vc.currency {
					st.gate(gateCurrencyMeta)
					continue
				}
				marker, ok := textCurrency(text, "")
				if !ok {
					st.gate(gateTwoCurrencies)
					continue
				}
				if marker != "" && marker != vc.currency {
					st.gate(gateCurrencyQuote)
					continue
				}

				key := filingKey{code: code, typ: period.Type, end: period.End}
				switch col {
				case "revenue", "net_income":
					v, reason, ok := filingMoney(entry, col, meta.Units)
					if !ok {
						st.skip("value: " + reason)
						continue
					}
					dk := docKey{key, col}
					doc[dk] = append(doc[dk], v)
				case "eps":
					e, reason, ok := filingEPS(entry)
					if !ok {
						st.skip("value: " + reason)
						continue
					}
					for _, c := range e.cols {
						dk := docKey{key, c}
						doc[dk] = append(doc[dk], e.dollars)
					}
				}
			}
		}
		for dk, vs := range doc {
			v, ok := agree(vs)
			if !ok {
				st.skip("value: one document gives two values for one period")
				continue
			}
			st.Accepted++
			lag := time.Duration(math.MaxInt64)
			if !ext.ReportDate.IsZero() {
				lag = ext.ReportDate.Sub(dk.key.end)
			}
			cand := filingValue{value: v, rank: rank, lag: lag, url: ext.URL, reportDate: ext.ReportDate}
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
	st.NoVendorCodes = len(noVendor)

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

	type built struct {
		key  filingKey
		row  PeriodRow
		cols filingCols
	}
	byCode := map[string][]built{}
	for _, k := range keys {
		vc := contextFor(k.code)
		row, cols, ok := assembleFilingRow(k, merged[k], vc, in.profiles[k.code], st)
		if !ok {
			continue
		}
		byCode[k.code] = append(byCode[k.code], built{k, row, cols})
	}

	out := map[string][]PeriodRow{}
	for code, rows := range byCode {
		vc := contextFor(code)
		// Gate 9 reads every half's pre-gate EPS, so it runs over the code's
		// assembled rows at once.
		halves := map[time.Time]PeriodRow{}
		for _, b := range rows {
			if b.key.typ == periodHalf {
				halves[b.key.end] = b.row
			}
		}
		var final []PeriodRow
		for _, b := range rows {
			row, cols := b.row, b.cols
			if b.key.typ == periodHalf && !ttmEPSIdentity(b.key.end, row, halves, vc) {
				st.gate(gateTTMIdentity)
				row.EPSBasic, row.EPSDiluted = nil, nil
				cols.epsBasic, cols.epsDiluted = nil, nil
			}
			if !row.hasValues() {
				continue
			}
			setFilingProvenance(&row, cols)
			final = append(final, row)
		}
		final, rejected := sanitizeRows(final)
		if rejected > 0 {
			st.skip("non-finite or implausible value")
		}
		if len(final) == 0 {
			continue
		}
		out[code] = final
		st.Codes++
		for _, r := range final {
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

// assembleFilingRow turns one merged key into a row: the vendor currency, the
// snap onto a vendor annual date, gate 8, the fiscal year. cols is returned
// with every withheld column cleared, so provenance names only a document
// whose value is in the row.
func assembleFilingRow(k filingKey, in *filingCols, vc vendorContext, profile companyProfile, st *filingStats) (PeriodRow, filingCols, bool) {
	cols := *in
	take := func(v *filingValue) *float64 {
		if v == nil {
			return nil
		}
		x := v.value
		return &x
	}
	end := k.end
	if k.typ == periodAnnual {
		end = vc.snapToVendorAnnual(end)
	}
	row := PeriodRow{
		PeriodType: k.typ,
		PeriodEnd:  end,
		Currency:   vc.currency,
		Revenue:    take(cols.revenue),
		NetIncome:  take(cols.netIncome),
		EPSBasic:   take(cols.epsBasic),
		EPSDiluted: take(cols.epsDiluted),
		Source:     sourceFiling,
	}

	// Gate 8: revenue within its band of a same-currency vendor reference.
	band, hasBand := vc.revenueBand(k.typ, k.end, vc.currency)
	if row.Revenue != nil {
		switch {
		case !hasBand:
			st.gate(gateRevenueNoRef)
			row.Revenue, cols.revenue = nil, nil
		case !band.contains(*row.Revenue):
			st.gate(gateRevenueRange)
			row.Revenue, cols.revenue = nil, nil
		}
	}
	// Gate 8: a profit no larger than 1.5x revenue, unless the company books
	// revaluations or fair-value gains through profit. The revenue is the
	// row's own, else the largest revenue its band admits; with neither the
	// check cannot run and the profit stands on gates 1-7.
	if row.NetIncome != nil && *row.NetIncome > 0 && !niCheckExemptIndustries[profile.Industry] {
		limit := 0.0
		switch {
		case row.Revenue != nil:
			limit = 1.5 * *row.Revenue
		case hasBand:
			limit = 1.5 * band.upper()
		}
		if limit > 0 && *row.NetIncome > limit {
			st.gate(gateNetIncome)
			row.NetIncome, cols.netIncome = nil, nil
		}
	}
	// Gate 8: EPS within [0.5, 2] of net income / vendor shares, written only
	// when that check can run.
	if row.EPSBasic != nil || row.EPSDiluted != nil {
		ni := row.NetIncome
		if ni == nil && k.typ == periodAnnual {
			ni = vc.annualNetIncome(k.end, vc.currency)
		}
		shares := vc.sharesNear(k.end)
		checkable := ni != nil && *ni != 0 && shares > 0
		for _, c := range []struct {
			v    **float64
			slot **filingValue
		}{{&row.EPSBasic, &cols.epsBasic}, {&row.EPSDiluted, &cols.epsDiluted}} {
			if *c.v == nil {
				continue
			}
			if !checkable {
				st.gate(gateEPSUncheckable)
				*c.v, *c.slot = nil, nil
				continue
			}
			ratio := **c.v / (*ni / shares)
			if ratio < 0.5 || ratio > 2 {
				st.gate(gateEPSRange)
				*c.v, *c.slot = nil, nil
			}
		}
	}
	if !row.hasValues() {
		return PeriodRow{}, cols, false
	}
	fy := fiscalYear(end, vc.fye)
	row.FiscalYear = &fy
	return row, cols, true
}

// ttmEPSIdentity is gate 9 for a first half ending at end (plan §4.2):
//
//	|(H1 - H1 prior) - (TTM at the half end - prior FY)|
//	    <= max(10% x |TTM - FY|, 2% x |FY EPS|, 0.01)
//
// TTM(half end) = H1 + (FY prior - H1 prior) exactly, so a half whose EPS is
// really another period's (a comparative, the prior year's full year) breaks
// it. Basic EPS on all four terms; diluted on all four only when the half has
// no basic. It runs only when all four inputs are present (the H1 prior from
// this run's own rows, the TTM point and the prior FY from the vendor, same
// currency); otherwise the half passes. A second half (ending in the balance
// month) is not a term of this identity and always passes. false means the
// half's EPS (basic and diluted) is withheld.
func ttmEPSIdentity(end time.Time, row PeriodRow, halves map[time.Time]PeriodRow, vc vendorContext) bool {
	if vc.fye == 0 || end.Month() == vc.fye {
		return true
	}
	type terms struct{ h1, h1prior, ttm, fy *float64 }
	prior, hasPrior := halves[monthEndOffset(end, -12)]
	ttmRow := at(vc.ttm, end, row.Currency)
	fyRow := at(vc.annual, monthEndOffset(end, -6), row.Currency)
	if !hasPrior || ttmRow == nil || fyRow == nil || prior.Currency != row.Currency {
		return true
	}
	var t terms
	if row.EPSBasic != nil {
		t = terms{row.EPSBasic, prior.EPSBasic, ttmRow.epsBasic(), fyRow.epsBasic()}
	} else {
		t = terms{row.EPSDiluted, prior.EPSDiluted, ttmRow.epsDiluted(), fyRow.epsDiluted()}
	}
	if t.h1 == nil || t.h1prior == nil || t.ttm == nil || t.fy == nil {
		return true
	}
	lhs := *t.h1 - *t.h1prior
	rhs := *t.ttm - *t.fy
	tol := math.Max(math.Max(0.10*math.Abs(rhs), 0.02*math.Abs(*t.fy)), 0.01)
	return math.Abs(lhs-rhs) <= tol
}

// setFilingProvenance names the filing the row's values came from: the
// document of its revenue, else of its net income, else of its EPS (a row's
// values can come from two documents for the same period; the columns carry
// one URL, so the most significant value's document is named).
func setFilingProvenance(row *PeriodRow, cols filingCols) {
	for _, v := range []*filingValue{cols.revenue, cols.netIncome, cols.epsBasic, cols.epsDiluted} {
		if v == nil {
			continue
		}
		row.SourceDocumentURL = v.url
		if !v.reportDate.IsZero() {
			d := v.reportDate
			row.SourceDocumentDate = &d
		}
		return
	}
}

// filingRank orders documents for the same period: the statutory Appendix
// 4D/4E first, then any other results document.
func filingRank(title, reportKind string) int {
	switch reportKind {
	case extractiontrust.ReportKindAppendix4D, extractiontrust.ReportKindAppendix4E:
		return 0
	}
	if classifyResultsFiling(title) == filingAppendix4DE {
		return 0
	}
	return 1
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

// ------------------------------------------------------------------ run

// runFilings is -mode filings: read, gate, merge, then the deterministic
// rebuild (plan §4.3). A dry run reads, logs the rows and the would-purge list,
// and writes nothing.
//
// Exit rule:
//   - the write is REFUSED, exit 10 (DEGRADED), nothing deleted or upserted,
//     per-gate counts and the would-purge list logged, when a read errored
//     (extractions, vendor rows or company profiles) or when zero extractions
//     were read;
//   - the rebuild transaction failing is exit 1 (it rolled back: nothing was
//     written);
//   - otherwise 0. A large purge is NOT refused: filing rows are rebuildable
//     from financial_report_extractions, so the first run after a gate change
//     is expected to remove many; it is logged in full instead.
func runFilings(ctx context.Context, st store, dryRun bool, logf func(string, ...any)) (filingStats, error) {
	var stats filingStats
	if st == nil {
		return stats, errors.New("filings: no database")
	}
	var refusals []string
	exts, err := st.FilingExtractions(ctx)
	if err != nil {
		refusals = append(refusals, "the extraction read failed: "+err.Error())
	} else if len(exts) == 0 {
		refusals = append(refusals, "zero extractions were read")
	}
	vendor, err := st.VendorRows(ctx)
	if err != nil {
		refusals = append(refusals, "the vendor read failed: "+err.Error())
	}
	profiles, err := st.CompanyProfiles(ctx)
	if err != nil {
		refusals = append(refusals, "the company profile read failed: "+err.Error())
	}

	var rows map[string][]PeriodRow
	if len(refusals) == 0 || (exts != nil && vendor != nil) {
		rows = buildFilingRows(exts, filingInputs{vendor: vendor, profiles: profiles}, &stats)
	}
	rebuild := filingRebuild{Rows: rows, FetchedAt: time.Now()}

	if len(refusals) > 0 || dryRun {
		stored, err := st.StoredFilingState(ctx)
		if err != nil {
			logf("picks: filings: would-purge list unavailable: %v", err)
		} else {
			purge, null := planPurge(stored, rows)
			logKeyList(logf, "would purge %d filing row(s)", purge)
			logFieldList(logf, "would null %d filing-filled vendor field(s)", null)
		}
	}
	if len(refusals) > 0 {
		stats.Refused = true
		logf("picks: filings REFUSED (nothing deleted or upserted): %s", stats)
		return stats, &runner.ExitCodeError{
			Code: exitCodeDegraded,
			Err:  fmt.Errorf("picks: filings REFUSED: %s; nothing deleted or upserted", strings.Join(refusals, "; ")),
		}
	}
	if dryRun {
		for _, code := range sortedCodes(rows) {
			for _, r := range rows[code] {
				logf("picks: filings: dry run: %s %s %s %s revenue=%s net_income=%s eps_basic=%s eps_diluted=%s doc=%s",
					code, r.PeriodType, r.PeriodEnd.Format("2006-01-02"), r.Currency,
					fmtOpt(r.Revenue), fmtOpt(r.NetIncome), fmtOpt(r.EPSBasic), fmtOpt(r.EPSDiluted), r.SourceDocumentURL)
			}
		}
		logf("picks: filings done (dry_run=true): %s", stats)
		return stats, nil
	}
	if err := ctx.Err(); err != nil {
		return stats, fmt.Errorf("filings: cancelled before the rebuild: %w", err)
	}
	res, err := st.RebuildFilings(ctx, rebuild)
	if err != nil {
		stats.Failed = 1
		logf("picks: filings DOWN (rolled back, nothing written): %s", stats)
		return stats, fmt.Errorf("picks: filings DOWN: the rebuild transaction failed and rolled back: %w", err)
	}
	stats.Purged, stats.FieldsNulled, stats.DocsCleared = len(res.Purged), len(res.Nulled), res.DocsCleared
	stats.Upserted, stats.Written, stats.Legacy = res.Upserted, res.Codes, res.Legacy
	logKeyList(logf, "purged %d filing row(s)", res.Purged)
	logFieldList(logf, "nulled %d filing-filled vendor field(s)", res.Nulled)
	logf("picks: filings done (dry_run=false): %s", stats)
	return stats, nil
}

func sortedCodes(rows map[string][]PeriodRow) []string {
	codes := make([]string, 0, len(rows))
	for c := range rows {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	return codes
}

// listChunk: keys per log line, so a first-run purge of hundreds of rows stays
// readable in Cloud Logging.
const listChunk = 40

func logKeyList(logf func(string, ...any), format string, keys []filingRowKey) {
	strs := make([]string, len(keys))
	for i, k := range keys {
		strs[i] = k.String()
	}
	logChunks(logf, fmt.Sprintf(format, len(keys)), strs)
}

func logFieldList(logf func(string, ...any), format string, keys []filingFieldKey) {
	strs := make([]string, len(keys))
	for i, k := range keys {
		strs[i] = k.String()
	}
	logChunks(logf, fmt.Sprintf(format, len(keys)), strs)
}

func logChunks(logf func(string, ...any), head string, items []string) {
	sort.Strings(items)
	if len(items) == 0 {
		logf("picks: filings: %s", head)
		return
	}
	for i := 0; i < len(items); i += listChunk {
		j := i + listChunk
		if j > len(items) {
			j = len(items)
		}
		logf("picks: filings: %s [%d-%d]: %s", head, i+1, j, strings.Join(items[i:j], ", "))
	}
}

func fmtOpt(v *float64) string {
	if v == nil {
		return "-"
	}
	return strconv.FormatFloat(*v, 'g', 6, 64)
}
