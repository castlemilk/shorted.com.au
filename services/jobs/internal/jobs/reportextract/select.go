package reportextract

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Selection modes — extract.py's --mode choices. extract_reports_concurrent.py
// always uses "all".
const (
	modeTop50 = "top50"
	modeCodes = "codes"
	modeAll   = "all"
)

// reportTypes is the set extract.py keeps; quarterlies are deliberately excluded
// ("less financial data").
var reportTypes = map[string]bool{
	"annual_results":    true,
	"half_year_results": true,
	"full_year_results": true,
	"annual_report":     true,
	"financial_report":  true,
}

// --- §6.3 Report selection: title-based noise filter ---------------------------
//
// The ASX-announcement crawler types an announcement as a "results"/"report" via
// substring matching on the headline, which over-classifies: a "Half Year Results
// Media Release" is typed half_year_results even though it carries no financial
// statements. Hard non-statement noise is dropped here, on the *title*,
// regardless of `type`. (extract.py KEPT presentations because they summarise
// well via the digest; the Go port now excludes them in isExtractionTarget
// below, see "Statutory-filing targeting".)
//
// Ported verbatim from extract.py's NOISE_TITLE_PATTERNS.
var noiseTitlePatterns = []string{
	`media release`,
	`media announcement`,
	`letter to (?:share|security)\s?holders`,
	`chair(?:man|woman|person)?'?s? letter`,
	`ceo'?s? letter`,
	`letter from the chair`,
	`chair(?:man|woman|person)?'?s? address`,
	`ceo'?s? address`,
	`address to (?:share|security)\s?holders`,
	`agm address`,
	`notice of (?:annual general )?meeting`,
	`notice of agm`,
	`proxy form`,
	`cleansing (?:notice|statement)`,
	`trading halt`,
	`suspension (?:from|of) (?:quotation|trading)`,
	`appendix 3[xyz]`,
	`change (?:of|in) director'?s? interest`,
	`director'?s? interest notice`,
	`(?:becoming|ceasing).{0,30}substantial (?:holder|holding)`,
	`change (?:in|to) substantial holding`,
	`substantial (?:holder|holding) notice`,
	`on-?market buy-?back`,
	`buy-?back (?:notice|booklet)`,
}

// keepOverridePatterns ALWAYS win over the noise patterns. ASX filers sometimes
// pack the statutory form name and an accompanying-press-release mention into one
// headline ("Appendix 4E Full Year Results — Media Release"). Only HARD statutory
// document identifiers belong here — deliberately NOT bare "results", so the
// override cannot readmit noise.
var keepOverridePatterns = []string{
	`appendix 4[de]`,
	`preliminary final report`,
	`annual report`,
	`(?:annual|half[\s-]?year|full[\s-]?year|interim) financial (?:report|statements)`,
	`financial (?:report|statements)`,
	`results announcement`,
}

var (
	noiseTitleRE   = regexp.MustCompile(`(?i)` + strings.Join(noiseTitlePatterns, "|"))
	keepOverrideRE = regexp.MustCompile(`(?i)` + strings.Join(keepOverridePatterns, "|"))
)

// isFinancialReportTitle reports whether a headline plausibly belongs to a
// financial statement/results document (extract.py's is_financial_report_title).
//
// An empty/whitespace title is ACCEPTED — we cannot judge it, and the digest step
// still produces something useful.
func isFinancialReportTitle(title string) bool {
	if strings.TrimSpace(title) == "" {
		return true
	}
	if keepOverrideRE.MatchString(title) {
		return true
	}
	return !noiseTitleRE.MatchString(title)
}

// --- Statutory-filing targeting (a deliberate divergence from extract.py) ------
//
// The weekly financial-report-extractor is the ONLY path to half-year totals for
// the stock picker (`shorted picks -mode filings` reads its metrics; Yahoo
// carries no ASX half-years). Measured on a backfill, ~98% of what the Python
// selection sent to Gemini produced no metrics: presentations and media
// releases dominated, and the per-run cap was spent in reverse-alphabetical
// order. So, on top of the Python noise filter above:
//
//  1. Headlines that are never a statutory results document are EXCLUDED:
//     presentations, webinars, briefings, "to present", results-date notices,
//     any "Notice of ...", AGM "Results of Meeting", dividend notices, and every
//     quarterly / Appendix 4C / activities report. A STRONG statutory marker
//     overrides the exclusion ("FY26 Financial Results Release and Webinar" is a
//     real filing), except for a quarterly, which only a literal Appendix 4D/4E
//     overrides.
//  2. What survives is ordered statutory filings FIRST (filingPriority 0:
//     Appendix 4D/4E, "results release|announcement|summary", "half-year
//     report", "preliminary final", "financial report for", an annual report
//     that says "financial"), then other results documents (1), then the rest
//     (2); newest first within a tier (or most-shorted first with
//     -top-shorted-first, newest breaking ties).
//
// The patterns are ported from scripts/take-writer/src/results-watch.ts
// (NOT_A_FILING / STRONG_FILING) and picks/filings.go; keep the three in step.
// isFinancialReportTitle is untouched (Python parity, pinned by its tests);
// this is an additional filter. The deployed job is still the Python image
// (services/report-extractor), so none of this reaches prod until the Go port
// is cut over (services/jobs/README.md, "Phase 3 port notes").

var statutoryFilingRE = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`\bappendix\s*4[de]\b`,
	`\bresults?\s+(?:release|announcement|summary)\b`,
	`\bhalf[\s-]?year(?:ly)?\s+(?:financial\s+)?report\b`,
	`\bpreliminary\s+final\b`,
	`\bfinancial\s+report\s+for\b`,
	`\bannual\s+financial\s+(?:report|statements?)\b`,
}, "|"))

var (
	annualReportRE = regexp.MustCompile(`(?i)\bannual\s+report\b`)
	financialRE    = regexp.MustCompile(`(?i)\bfinancial\b`)
	appendix4DERE  = regexp.MustCompile(`(?i)\bappendix\s*4[de]\b`)
	quarterlyRE    = regexp.MustCompile(`(?i)\bquarterly\b|\bquarter\b|\bappendix\s*4c\b|\b4c\b|\b[1-4]q\s?(?:fy)?\s?\d{2,4}\b|\bq[1-4]\b|\bactivit(?:y|ies)\s+(?:report|statement|update)\b`)
	// Period-results language: the tier below statutory.
	periodResultsRE = regexp.MustCompile(`(?i)\b(?:fy\s?\d{2,4}|hy\s?\d{2,4}|\d\s?h\s?\d{2,4}|full[\s-]?year|half[\s-]?year(?:ly)?|interim)\b[^.]{0,40}\b(?:results?|report|financial\s+statements?|accounts)\b|\bannual\s+report\b|\bfinancial\s+(?:report|statements?)\b`)
)

var extractionExcludeRE = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`\bpresentation\b`,
	`\bwebinar\b`,
	`\bto\s+present\b`,
	`\bresults?\s+date\b`,
	`\bconference\s+call\b`,
	`\bbriefing\b`,
	`\binvestor\s+day\b`,
	`\bregistration\s+details\b`,
	`\bdial[-\s]?in\b`,
	`\btranscript\b`,
	`^\s*notice\s+of\b`,
	`\bnotice\s+of\s+(?:annual\s+general\s+|general\s+|extraordinary\s+)?(?:agm|meeting)\b`,
	`\bresults?\s+of\s+(?:the\s+)?(?:\d{4}\s+)?(?:annual\s+general\s+|general\s+|extraordinary\s+)?meeting\b`,
	`^\s*(?:update\s*-\s*)?dividend/distribution\b`,
	`^\s*confirmation\s+of\s+.*dividend`,
}, "|"))

// A dividend notice is excluded only when the headline carries no results
// language: "FY26 Results and Final Dividend" is a real results release.
var (
	dividendNoticeRE = regexp.MustCompile(`(?i)\bdividend\b|\bdistribution\b|\bdrp\b`)
	resultsWordRE    = regexp.MustCompile(`(?i)\bresults?\b|\breport\b|\bfinancial\b|\baccounts\b`)
)

// isStatutoryFiling: the markers strong enough to rank first and to override
// an exclusion.
func isStatutoryFiling(title string) bool {
	if statutoryFilingRE.MatchString(title) {
		return true
	}
	return annualReportRE.MatchString(title) && financialRE.MatchString(title)
}

// isExtractionTarget reports whether a headline (already past the Python noise
// filter) is worth a paid Gemini extraction. An empty title is accepted, as in
// isFinancialReportTitle.
func isExtractionTarget(title string) bool {
	if strings.TrimSpace(title) == "" {
		return true
	}
	if quarterlyRE.MatchString(title) && !appendix4DERE.MatchString(title) {
		return false
	}
	if isStatutoryFiling(title) {
		return true
	}
	if dividendNoticeRE.MatchString(title) && !resultsWordRE.MatchString(title) {
		return false
	}
	return !extractionExcludeRE.MatchString(title)
}

// filingPriority: 0 statutory filing, 1 other results document, 2 anything else.
func filingPriority(title string) int {
	switch {
	case isStatutoryFiling(title):
		return 0
	case periodResultsRE.MatchString(title):
		return 1
	}
	return 2
}

// prioritiseForExtraction orders the candidates the run cap is applied to:
// newest first, then most-shorted first when rank is non-nil, then statutory
// filings first. Each pass is a STABLE sort, so the last key is the primary one
// and the earlier keys break its ties.
func prioritiseForExtraction(reports []report, rank map[string]float64) {
	sort.SliceStable(reports, func(i, j int) bool { return reports[i].Date > reports[j].Date })
	if rank != nil {
		applyTopShortedOrder(reports, rank)
	}
	sort.SliceStable(reports, func(i, j int) bool {
		return filingPriority(reports[i].Title) < filingPriority(reports[j].Title)
	})
}

// report is one selection row: the financial_reports JSON entry plus, for the
// digest-backfill path, the already-stored metrics and GCS text pointer.
type report struct {
	StockCode string
	URL       string
	Title     string
	Date      string
	Type      string

	// Only populated by selectDigestlessReports.
	Metrics       string
	RawTextGCSURL string
}

// finReport is one element of the company-metadata.financial_reports JSON array.
type finReport struct {
	Source string `json:"source"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Date   string `json:"date"`
}

// SQL text is carried over verbatim from extract.py (psycopg2 %s placeholders
// rewritten as pgx $n; nothing else changed).
const (
	selectByCodesSQL = `
            SELECT stock_code, financial_reports::text
            FROM "company-metadata"
            WHERE stock_code = ANY($1)
              AND financial_reports IS NOT NULL
              AND financial_reports::text != '[]'
              AND financial_reports::text != 'null'
            `

	selectTop50SQL = `
            SELECT cm.stock_code, cm.financial_reports::text
            FROM "company-metadata" cm
            INNER JOIN (
                SELECT product_code
                FROM mv_top_shorts
                ORDER BY current_percent DESC
                LIMIT 50
            ) top ON cm.stock_code = top.product_code
            WHERE cm.financial_reports IS NOT NULL
              AND cm.financial_reports::text != '[]'
              AND cm.financial_reports::text != 'null'
            `

	selectAllSQL = `
            SELECT stock_code, financial_reports::text
            FROM "company-metadata"
            WHERE financial_reports IS NOT NULL
              AND financial_reports::text LIKE '%asx_announcements%'
            ORDER BY stock_code
            `

	selectExistingExtractionsSQL = `SELECT report_url FROM financial_report_extractions WHERE report_url = ANY($1)`

	selectDigestlessSQL = `
        SELECT stock_code, report_url, report_type, report_title,
               report_date::text AS report_date, metrics::text AS metrics,
               raw_text_length, raw_text_gcs_url
        FROM financial_report_extractions
        WHERE digest IS NULL
        `

	selectTopShortsRankSQL = `SELECT product_code, current_percent FROM mv_top_shorts`
)

// selectionQuery returns the (sql, args) for a selection mode. `codes` is only
// consulted for modeCodes.
//
// psycopg2 built the codes query with an inlined `IN (%s,%s,…)` placeholder list;
// pgx takes the whole slice through `= ANY($1)`, which is the same predicate with
// one bind parameter instead of N.
func selectionQuery(mode string, codes []string) (string, []any) {
	switch {
	case mode == modeCodes && len(codes) > 0:
		return selectByCodesSQL, []any{codes}
	case mode == modeTop50:
		return selectTop50SQL, nil
	default:
		return selectAllSQL, nil
	}
}

// getReportsToProcess fetches financial-report URLs that have not been extracted
// yet (extract.py's get_reports_to_process).
func getReportsToProcess(ctx context.Context, pool *pgxpool.Pool, mode string, codes []string, limit, recent int) ([]report, error) {
	sql, args := selectionQuery(mode, codes)
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("select company reports: %w", err)
	}
	var raws []reportRow
	for rows.Next() {
		var (
			code        string
			reportsJSON *string
		)
		if err := rows.Scan(&code, &reportsJSON); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan company reports: %w", err)
		}
		raws = append(raws, reportRow{StockCode: code, FinancialReports: derefString(reportsJSON)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate company reports: %w", err)
	}

	reports := parseReportRows(raws)

	// Sort by (stock_code, date) DESCENDING, then cap per company. Python's
	// list.sort(reverse=True) is stable, so ties keep their original order —
	// sort.SliceStable with a ">" comparator reproduces that exactly.
	sortReportsDesc(reports)
	if recent > 0 {
		reports = capPerCompany(reports, recent)
	}

	// Drop anything already extracted.
	if len(reports) > 0 {
		urls := make([]string, len(reports))
		for i, r := range reports {
			urls[i] = r.URL
		}
		existing, err := selectExistingExtractions(ctx, pool, urls)
		if err != nil {
			return nil, err
		}
		filtered := reports[:0]
		for _, r := range reports {
			if !existing[r.URL] {
				filtered = append(filtered, r)
			}
		}
		reports = filtered
	}

	// Statutory filings first, newest first, before the cap takes its slice.
	prioritiseForExtraction(reports, nil)
	if limit > 0 && len(reports) > limit {
		reports = reports[:limit]
	}
	return reports, nil
}

// reportRow is one `company-metadata` row as selected: the code plus the raw
// financial_reports JSON text.
type reportRow struct {
	StockCode        string
	FinancialReports string
}

// parseReportRows turns raw company rows into candidate reports, applying the
// source/type/title filters. Unparseable JSON skips the company (Python caught
// JSONDecodeError/TypeError and continued).
func parseReportRows(rows []reportRow) []report {
	var reports []report
	for _, row := range rows {
		var finReports []finReport
		if err := json.Unmarshal([]byte(row.FinancialReports), &finReports); err != nil {
			continue
		}
		for _, r := range finReports {
			if r.Source != "asx_announcements" {
				continue
			}
			if !reportTypes[r.Type] {
				continue
			}
			// §6.3(a) Drop non-statement noise the crawler mistyped as a report.
			if !isFinancialReportTitle(r.Title) {
				continue
			}
			// Statutory-filing targeting: presentations, notices, dividend
			// admin and quarterlies never reach Gemini.
			if !isExtractionTarget(r.Title) {
				continue
			}
			reports = append(reports, report{
				StockCode: row.StockCode,
				URL:       r.URL,
				Title:     r.Title,
				Date:      r.Date,
				Type:      r.Type,
			})
		}
	}
	return reports
}

// sortReportsDesc orders by (stock_code, date) descending, stably. On the same
// code and date a statutory filing goes first, so the per-company `-recent` cap
// keeps the Appendix 4D over the same day's covering letter.
func sortReportsDesc(reports []report) {
	sort.SliceStable(reports, func(i, j int) bool {
		a, b := reports[i], reports[j]
		if a.StockCode != b.StockCode {
			return a.StockCode > b.StockCode
		}
		if a.Date != b.Date {
			return a.Date > b.Date
		}
		return filingPriority(a.Title) < filingPriority(b.Title)
	})
}

// capPerCompany keeps at most `recent` reports per stock code, in the order the
// (already sorted) slice presents them.
func capPerCompany(reports []report, recent int) []report {
	seen := map[string]int{}
	out := make([]report, 0, len(reports))
	for _, r := range reports {
		if seen[r.StockCode] < recent {
			out = append(out, r)
			seen[r.StockCode]++
		}
	}
	return out
}

// selectExistingExtractions returns the subset of urls already in
// financial_report_extractions.
func selectExistingExtractions(ctx context.Context, pool *pgxpool.Pool, urls []string) (map[string]bool, error) {
	rows, err := pool.Query(ctx, selectExistingExtractionsSQL, urls)
	if err != nil {
		return nil, fmt.Errorf("select existing extractions: %w", err)
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, fmt.Errorf("scan existing extraction: %w", err)
		}
		existing[url] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate existing extractions: %w", err)
	}
	return existing, nil
}

// selectDigestlessReports returns rows already in financial_report_extractions
// that have no digest yet — the §6.3(b) historical no-metrics corpus. It carries
// the stored metrics + GCS text pointer so the digest can be regenerated without
// re-downloading the PDF (older 2024 ASX URLs no longer resolve).
func selectDigestlessReports(ctx context.Context, pool *pgxpool.Pool, limit int, topShortedFirst bool) ([]report, error) {
	rows, err := pool.Query(ctx, selectDigestlessSQL)
	if err != nil {
		return nil, fmt.Errorf("select digestless reports: %w", err)
	}
	var reports []report
	for rows.Next() {
		var (
			r             report
			reportType    *string
			reportTitle   *string
			reportDate    *string
			metrics       *string
			rawTextLength *int32
			gcsURL        *string
		)
		if err := rows.Scan(&r.StockCode, &r.URL, &reportType, &reportTitle, &reportDate, &metrics, &rawTextLength, &gcsURL); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan digestless report: %w", err)
		}
		r.Type = derefString(reportType)
		r.Title = derefString(reportTitle)
		r.Date = derefString(reportDate)
		r.Metrics = derefString(metrics)
		r.RawTextGCSURL = derefString(gcsURL)
		reports = append(reports, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate digestless reports: %w", err)
	}

	if topShortedFirst {
		rank, err := topShortedRank(ctx, pool)
		if err != nil {
			return nil, err
		}
		applyTopShortedOrder(reports, rank)
	}
	if limit > 0 && len(reports) > limit {
		reports = reports[:limit]
	}
	return reports, nil
}

// topShortedRank loads mv_top_shorts as code → current_percent.
func topShortedRank(ctx context.Context, pool *pgxpool.Pool) (map[string]float64, error) {
	rows, err := pool.Query(ctx, selectTopShortsRankSQL)
	if err != nil {
		return nil, fmt.Errorf("select top-shorts rank: %w", err)
	}
	defer rows.Close()
	rank := map[string]float64{}
	for rows.Next() {
		var (
			code string
			pct  *float64
		)
		if err := rows.Scan(&code, &pct); err != nil {
			return nil, fmt.Errorf("scan top-shorts rank: %w", err)
		}
		if pct != nil {
			rank[code] = *pct
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate top-shorts rank: %w", err)
	}
	return rank, nil
}

// applyTopShortedOrder sorts most-shorted first, with unranked codes last
// (_apply_top_shorted_order's `rank.get(code, -1)` + `reverse=True`, which is a
// STABLE reverse-comparison sort — equal ranks keep their incoming order).
func applyTopShortedOrder(reports []report, rank map[string]float64) {
	pct := func(r report) float64 {
		if v, ok := rank[r.StockCode]; ok {
			return v
		}
		return -1
	}
	sort.SliceStable(reports, func(i, j int) bool {
		return pct(reports[i]) > pct(reports[j])
	})
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
