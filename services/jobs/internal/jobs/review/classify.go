package review

import (
	"cmp"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/announcements"
	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// The gates and limits the review mirrors. Each names the code it must agree
// with; the two confidence gates are pinned to that code by a test.
const (
	// apiMinDigestConfidence: the API's latest-filing summary skips a digest
	// under it (services/shorts/internal/services/shorts/latest_filing.go,
	// latestFilingMinConfidence). It is the only reader of a row with no
	// metrics, so the extractor treats a digest under it as none (extract.py
	// USABLE_DIGEST_MIN_CONFIDENCE).
	apiMinDigestConfidence = 0.6
	// picksMinDigestConfidence: the picks filings ingest skips the whole
	// document under it (internal/jobs/picks/filings_ingest.go,
	// minDigestConfidence).
	picksMinDigestConfidence = 0.3
	// minTextChars: below it a row is an unreadable marker, a PDF with no text
	// layer (services/report-extractor/extract.py MIN_PDF_TEXT_CHARS).
	minTextChars = 100
	// An empty extraction is read again at most emptyRetryLimit times,
	// emptyRetryMinDays apart, at up to emptyRetryMaxPages pages (extract.py
	// EMPTY_RETRY_LIMIT, EMPTY_RETRY_MIN_DAYS, EMPTY_RETRY_MAX_PAGES).
	emptyRetryLimit    = 2
	emptyRetryMinDays  = 7
	emptyRetryMaxPages = 24
	// unreadGraceDays: a newest results document filed longer ago than this
	// and still unread is listed. A run or two behind is not yet a problem.
	unreadGraceDays = 7
)

// keyReportTypes are the financial_reports types the extractor reads
// (extract.py KEY_REPORT_TYPES).
var keyReportTypes = map[string]bool{
	"annual_results":    true,
	"half_year_results": true,
	"full_year_results": true,
	"annual_report":     true,
	"financial_report":  true,
}

// metricsEmpty reports whether stored metrics hold no class. Metrics that do
// not decode count as not empty: they are something, just not JSON this
// review can read.
func metricsEmpty(raw []byte) bool {
	if len(raw) == 0 {
		return true
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	return len(m) == 0
}

// isUnreadable reports the extractor's marker for a PDF with no text layer
// (extract.py store_unreadable): no metrics, no digest, under minTextChars.
func isUnreadable(r extractionRow) bool {
	return r.RawTextLength != nil && *r.RawTextLength < minTextChars && metricsEmpty(r.Metrics) && !r.HasDigest
}

// usableDigest reports a digest the latest-filing summary can show: at least
// apiMinDigestConfidence. A row with no metrics feeds no other reader.
func usableDigest(r extractionRow) bool {
	return r.HasDigest && r.DigestConfidence != nil && *r.DigestConfidence >= apiMinDigestConfidence
}

// isEmpty reports an empty extraction, the case the extractor retries
// (extract.py _empty_retry_urls): no metrics and no usable digest from a
// document that has text (length unknown, or at least minTextChars).
func isEmpty(r extractionRow) bool {
	return metricsEmpty(r.Metrics) && !usableDigest(r) && (r.RawTextLength == nil || *r.RawTextLength >= minTextChars)
}

// notResultsTitle is the state of an empty extraction whose title the results
// classifier now rejects: the extractor never offers it again.
const notResultsTitle = "not read again: the title is not a results document"

// emptyState is where an empty extraction stands in the extractor's retries.
func emptyState(attempts int, lastRead, now time.Time, attemptsKnown bool) string {
	if !attemptsKnown {
		return "attempt count unknown (migration 000136 not applied)"
	}
	if attempts > emptyRetryLimit {
		return fmt.Sprintf("gave up after %d attempts", attempts)
	}
	due := lastRead.AddDate(0, 0, emptyRetryMinDays)
	if !now.Before(due) {
		return "retry due"
	}
	return "next retry from " + due.UTC().Format("2006-01-02")
}

// metricEntries counts the entries in stored metrics the way
// extractiontrust.TrustedEntries does (a class holds one object or a list;
// anything else is one entry), and how many quote the prompt's few-shot
// example.
func metricEntries(m map[string]any) (total, echo int) {
	count := func(v any) {
		total++
		e, _ := v.(map[string]any)
		if s, _ := e[extractiontrust.KeySourceText].(string); extractiontrust.IsFewShotText(s) {
			echo++
		}
	}
	for _, v := range m {
		switch x := v.(type) {
		case nil:
		case []any:
			for _, item := range x {
				count(item)
			}
		default:
			count(x)
		}
	}
	return total, echo
}

// withheldReasons lists why the API serves a row only in part or not at all;
// nil when nothing is withheld.
func withheldReasons(r extractionRow) []string {
	var reasons []string
	var m map[string]any
	if len(r.Metrics) > 0 && json.Unmarshal(r.Metrics, &m) == nil && len(m) > 0 {
		if trusted, dropped := extractiontrust.TrustedMetrics(m); dropped > 0 {
			total, echo := metricEntries(m)
			reason := fmt.Sprintf("metrics: %d of %d entries dropped by the trust funnel (%d few-shot echo)", dropped, total, echo)
			if len(trusted) == 0 {
				reason += " — none left"
			}
			reasons = append(reasons, reason)
		}
	}
	if r.HasDigest && r.DigestConfidence != nil {
		switch c := *r.DigestConfidence; {
		case c < picksMinDigestConfidence:
			reasons = append(reasons, fmt.Sprintf("digest confidence %.2f: the latest-filing summary (%.1f) and the picks filings (%.1f) skip it",
				c, apiMinDigestConfidence, picksMinDigestConfidence))
		case c < apiMinDigestConfidence:
			reasons = append(reasons, fmt.Sprintf("digest confidence %.2f is under %.1f: the latest-filing summary skips it", c, apiMinDigestConfidence))
		}
	}
	var meta extractiontrust.DocumentMeta
	if len(r.DocumentMeta) > 0 {
		parsed, err := extractiontrust.ParseDocumentMeta(r.DocumentMeta)
		switch {
		case err != nil:
			reasons = append(reasons, "document_meta does not parse: "+truncateRunes(err.Error(), 80))
		case parsed.Entity != "" && r.CompanyName != "" && !extractiontrust.EntityMatches(parsed.Entity, r.CompanyName):
			reasons = append(reasons, fmt.Sprintf("document names %q, not %s", parsed.Entity, r.CompanyName))
		}
		if err == nil {
			meta = parsed
		}
	}
	if !extractiontrust.IsResultsDocument(r.Title, meta.ReportKind) {
		reasons = append(reasons, "not a results document to the API (title / report_kind)")
	}
	return reasons
}

// doc is one entry of company-metadata.financial_reports.
type doc struct {
	URL, Title, Date, Type string
}

// newestResultsDocument is the company's newest statutory results document in
// its financial_reports JSON, filtered as the extractor filters candidates
// (extract.py _parse_financial_reports): source asx_announcements, a key
// report type, a URL, and a title the results classifier accepts. A document
// with no date sorts last.
func newestResultsDocument(financialReports string) (doc, bool) {
	var entries []map[string]any
	if json.Unmarshal([]byte(financialReports), &entries) != nil {
		return doc{}, false
	}
	var best doc
	found := false
	for _, e := range entries {
		str := func(k string) string { s, _ := e[k].(string); return s }
		d := doc{URL: str("url"), Title: str("title"), Date: str("date"), Type: str("type")}
		if str("source") != "asx_announcements" || !keyReportTypes[d.Type] || d.URL == "" ||
			!extractiontrust.IsResultsDocument(d.Title, "") {
			continue
		}
		if !found || day(d.Date) > day(best.Date) {
			best, found = d, true
		}
	}
	return best, found
}

// day is a date string's first ten characters, YYYY-MM-DD.
func day(s string) string {
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

// parseMarketCap is the first value that reads as a finite, positive number
// once spaces and thousands separators are dropped (extract.py
// parse_market_cap: key_metrics->>'market_cap', then the market_cap column,
// whose type differs between environments, so both arrive as text).
func parseMarketCap(values ...string) (float64, bool) {
	for _, v := range values {
		f, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(v), ",", ""), 64)
		if err == nil && f > 0 && !math.IsInf(f, 0) {
			return f, true
		}
	}
	return 0, false
}

// gapRow is a company whose newest results document is still unread.
type gapRow struct {
	StockCode, CompanyName string
	MarketCap              float64
	MarketCapOK            bool
	Doc                    doc
	State                  string
}

// unreadResults lists the companies whose newest results document, filed
// between unreadGraceDays and days ago, has no metrics and no digest: largest
// companies first, unknown market caps last, then by code.
func unreadResults(companies []companyRow, states map[string]extractionState, now time.Time, days int, attemptsKnown bool) []gapRow {
	oldest := now.AddDate(0, 0, -days)
	newest := now.AddDate(0, 0, -unreadGraceDays)
	var gaps []gapRow
	for _, c := range companies {
		d, ok := newestResultsDocument(c.FinancialReports)
		if !ok {
			continue
		}
		filed, err := time.Parse("2006-01-02", day(d.Date))
		if err != nil || filed.Before(oldest) || filed.After(newest) {
			continue
		}
		g := gapRow{StockCode: c.StockCode, CompanyName: c.CompanyName, Doc: d}
		g.MarketCap, g.MarketCapOK = parseMarketCap(c.MarketCapKM, c.MarketCapCol)
		switch st, seen := states[d.URL]; {
		case !seen:
			g.State = "never read"
		case st.Parsed:
			continue
		case st.RawTextLength != nil && *st.RawTextLength < minTextChars:
			g.State = "unreadable (no text layer)"
		default:
			g.State = emptyState(st.Attempts, st.ExtractedAt, now, attemptsKnown)
		}
		gaps = append(gaps, g)
	}
	slices.SortFunc(gaps, func(a, b gapRow) int {
		if a.MarketCapOK != b.MarketCapOK {
			if a.MarketCapOK {
				return -1
			}
			return 1
		}
		if c := cmp.Compare(b.MarketCap, a.MarketCap); c != 0 {
			return c
		}
		return strings.Compare(a.StockCode, b.StockCode)
	})
	return gaps
}

// A notice the parser cannot store yet says when its update will come: an
// estimate's actual amount (3A.1a(i)), a foreign amount's AUD equivalent
// (2A.9b). Parser version 3 records "ex <date>; <what> due <date>"
// (announcements waitingDetail). Measured on prod 2026-10-11: all 30
// estimated_only and 9 of the 14 awaiting_aud_equivalent notices were either
// stored from their update or not yet due, yet the review listed them as
// failures beside the ones that need a look.
var noticeDueRE = regexp.MustCompile(`\bdue (\d{4}-\d{2}-\d{2})\b`)

// noticeState is where a failed notice stands: "stored from a later notice",
// "due <date>", "overdue since <date>", "no date recorded" for a waiting
// notice recorded before parser 3, or "" for any other failure (look at it).
func noticeState(f noticeFailure, now time.Time) string {
	if f.Superseded {
		return "stored from a later notice"
	}
	if f.Outcome != "estimated_only" && f.Outcome != "awaiting_aud_equivalent" {
		return ""
	}
	m := noticeDueRE.FindStringSubmatch(f.Detail)
	if m == nil {
		return "no date recorded"
	}
	due, err := time.Parse(time.DateOnly, m[1])
	if err != nil {
		return "no date recorded"
	}
	if due.Before(now.UTC().Truncate(24 * time.Hour)) {
		return "overdue since " + m[1]
	}
	return "due " + m[1]
}

// sortFailures puts the notices that need a look first: overdue, then every
// other failure, then the ones still waiting, then the ones already stored;
// newest first within each (the query's order, kept by a stable sort).
func sortFailures(fs []noticeFailure) {
	rank := func(state string) int {
		switch {
		case strings.HasPrefix(state, "overdue"):
			return 0
		case state == "":
			return 1
		case state == "no date recorded":
			return 2
		case strings.HasPrefix(state, "due "):
			return 3
		default:
			return 4
		}
	}
	slices.SortStableFunc(fs, func(a, b noticeFailure) int { return cmp.Compare(rank(a.State), rank(b.State)) })
}

// estimateRow is a dividend stored from a confirmed estimate, and whether its
// results documents still confirm it.
type estimateRow struct {
	AttemptCode, URL string
	AttemptedAt      time.Time
	// Rows: the dividends still stored from the notice; none once a later
	// notice replaced them.
	Rows []confirmedEstimateRow
	// Documents: the ones that confirm it now, or, when none does, the ones
	// its detail named.
	Documents []string
	Quotes    []string
	State     string
}

// Where a stored estimate stands.
const (
	estimateConfirmed = "confirmed"
	estimateReplaced  = "replaced by a later notice"
)

// estimateStates reads each notice stored from a confirmed estimate
// (announcements parser 6) and checks it again against its code's documents
// with the pass's own rule (announcements.ConfirmEstimate). Without this list
// such a notice just leaves the overdue failures (GMG's of 2026-06-16), and
// nothing marks its row as an estimate. A row whose documents no longer
// confirm it, a document re-extracted or withdrawn, needs a look; one a later
// notice replaced needs nothing.
func estimateStates(rows []confirmedEstimateRow, docs []announcements.ResultsDocument) []estimateRow {
	var out []estimateRow
	index := map[string]int{}
	for _, r := range rows {
		i, seen := index[r.URL]
		if !seen {
			i = len(out)
			index[r.URL] = i
			out = append(out, estimateRow{AttemptCode: r.AttemptCode, URL: r.URL, AttemptedAt: r.AttemptedAt})
		}
		if r.StockCode != "" {
			out[i].Rows = append(out[i].Rows, r)
		}
	}
	for i := range out {
		e := &out[i]
		named, due, ok := announcements.ConfirmedEstimateDetail(firstDetail(rows, e.URL))
		e.Documents = named
		switch {
		case len(e.Rows) == 0:
			e.State = estimateReplaced
			continue
		case !ok:
			e.State = "no longer confirmed: its detail names no document and no due date"
			continue
		}
		c := announcements.ConfirmEstimate(estimateNotice(e.Rows, due), docs)
		if !c.Confirmed() {
			e.State = "no longer confirmed: " + c.Reason
			continue
		}
		e.State, e.Documents, e.Quotes = estimateConfirmed, c.Documents(), nil
		for _, m := range c.Matches {
			e.Quotes = append(e.Quotes, m.Quote)
		}
	}
	return out
}

func firstDetail(rows []confirmedEstimateRow, url string) string {
	for _, r := range rows {
		if r.URL == url {
			return r.Detail
		}
	}
	return ""
}

// estimateNotice is the notice a stored estimate was read from, as far as
// the pass's rule needs it: its rows hold the code, dates, currency, and each
// part's type, amount and franking; its detail the date the actual amount was
// due.
func estimateNotice(rows []confirmedEstimateRow, due string) announcements.DividendNotice {
	first := rows[0]
	n := announcements.DividendNotice{
		SecurityCode: first.StockCode, AnnouncedOn: first.AnnouncedOn, PeriodEnd: first.PeriodEnd, RecordDate: first.RecordDate,
		ExDate: first.ExDate, PaymentDate: first.PayDate, Currency: first.Currency, ActualDue: due,
	}
	for _, r := range rows {
		part := announcements.DividendPart{Type: r.Type, Estimated: true, FrankedPct: r.FrankedPct}
		if r.Amount != nil {
			part.Amount = *r.Amount
		}
		n.Parts = append(n.Parts, part)
		n.Total += part.Amount
	}
	return n
}
