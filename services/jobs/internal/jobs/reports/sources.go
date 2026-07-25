// Package reports is the `shorted reports <coverage|link|sync>` job family,
// migrated from the three near-identical laptop-only tools
// services/report-coverage, services/report-linker and services/report-sync
// (docs/jobs-consolidation-plan.md Phase 1).
//
// This file is the dedupe: the URL → report-type classification, the title
// derivation, the year extraction, the source-priority ordering and the
// read-merge-write of company-metadata.financial_reports were copy-pasted
// across report-coverage/main.go and report-linker/main.go. They live here once.
package reports

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// txBeginner is the narrow slice of *pgxpool.Pool that the read-merge-write
// path needs. It is declared here, at the consumer, so the merge logic is
// testable without a live database.
type txBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// FinancialReport matches the JSONB schema in company-metadata.financial_reports.
// GcsURL is only populated by `reports sync`; it is omitempty so the linker and
// coverage tools round-trip rows they didn't sync without clobbering the field.
//
// The single unified struct also FIXES a silent data-loss bug in the old
// report-linker: its local struct had no GcsURL field, so every read-merge-write
// it performed decoded the stored gcsUrl into nothing and wrote the array back
// WITHOUT it — un-syncing every PDF `report-sync` had already mirrored to GCS
// for that company. Keep GcsURL on this struct; there is exactly one shape.
type FinancialReport struct {
	URL    string `json:"url"`
	Date   string `json:"date"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	GcsURL string `json:"gcsUrl,omitempty"`
	Source string `json:"source"`
}

// financialURLPatterns decide whether a PDF link looks like a financial report.
// (report-linker's list, verbatim.)
var financialURLPatterns = []*regexp.Regexp{
	regexp.MustCompile(`annual[_-]?report`),
	regexp.MustCompile(`half[_-]?year`),
	regexp.MustCompile(`interim[_-]?(report|financial|result)`),
	regexp.MustCompile(`preliminary[_-]?final`),
	regexp.MustCompile(`full[_-]?year[_-]?result`),
	regexp.MustCompile(`quarterly[_-]?(report|activities|cash)`),
	regexp.MustCompile(`appendix[_-]?4[cdeCDE]`),
	regexp.MustCompile(`investor[_-]?presentation`),
	regexp.MustCompile(`results?[_-]?presentation`),
	regexp.MustCompile(`financial[_-]?(report|result|statement)`),
	regexp.MustCompile(`earnings[_-]?(release|report)`),
	regexp.MustCompile(`profit[_-]?(report|announcement)`),
	regexp.MustCompile(`distribution[_-]?notice`),
	regexp.MustCompile(`agm[_-]?(address|presentation|result)`),
	regexp.MustCompile(`annual[_-]?general[_-]?meeting`),
}

// IsFinancialURL reports whether a lowercased URL matches a report pattern.
func IsFinancialURL(lower string) bool {
	for _, re := range financialURLPatterns {
		if re.MatchString(lower) {
			return true
		}
	}
	return false
}

// Classification regexps, compiled once (report-linker recompiled these per
// call inside a switch — same patterns, hoisted).
var (
	reAppendix4E   = regexp.MustCompile(`appendix[_-]?4e`)
	rePrelimFinal  = regexp.MustCompile(`preliminary[_-]?final`)
	reAnnualReport = regexp.MustCompile(`annual[_-]?report`)
	reHalfYear     = regexp.MustCompile(`half[_-]?year`)
	reInterim      = regexp.MustCompile(`interim`)
	reAppendix4D   = regexp.MustCompile(`appendix[_-]?4d`)
	reQuarterly    = regexp.MustCompile(`quarterly`)
	reAppendix4C   = regexp.MustCompile(`appendix[_-]?4c`)
	reFullYear     = regexp.MustCompile(`full[_-]?year`)
	reInvestorPres = regexp.MustCompile(`investor[_-]?presentation`)
	reResultsPres  = regexp.MustCompile(`results?[_-]?presentation`)
	reAnalyst      = regexp.MustCompile(`analyst`)
	reDistribution = regexp.MustCompile(`distribution`)
	reAGM          = regexp.MustCompile(`agm|annual[_-]?general`)

	// YearRe extracts a 2010–2029 year from a URL.
	YearRe = regexp.MustCompile(`20(2[0-9]|1[0-9])`)
)

// ClassifyURLType maps a lowercased report URL to a report type.
//
// report-coverage used strings.Contains over explicit "-"/"_" spellings and
// report-linker used these `[_-]?` regexps; the regexp form is a strict
// superset (it additionally matches the no-separator spellings such as
// "annualreport"/"appendix4e", which report-coverage special-cased for
// annual_report only). Order of the switch arms is preserved from both.
func ClassifyURLType(lower string) string {
	switch {
	case reAppendix4E.MatchString(lower) || rePrelimFinal.MatchString(lower):
		return "annual_results"
	case reAnnualReport.MatchString(lower):
		return "annual_report"
	case reHalfYear.MatchString(lower) || reInterim.MatchString(lower) || reAppendix4D.MatchString(lower):
		return "half_year_results"
	case reQuarterly.MatchString(lower) || reAppendix4C.MatchString(lower):
		return "quarterly_report"
	case reFullYear.MatchString(lower):
		return "full_year_results"
	case reInvestorPres.MatchString(lower) || reResultsPres.MatchString(lower) || reAnalyst.MatchString(lower):
		return "investor_presentation"
	case reDistribution.MatchString(lower):
		return "distribution_notice"
	case reAGM.MatchString(lower):
		return "agm_address"
	default:
		return "financial_report"
	}
}

// ExtractDateFromURL returns "<year>-12-31" for the first 2010–2029 year in a
// lowercased URL, or "" when there is none.
func ExtractDateFromURL(lower string) string {
	if year := YearRe.FindString(lower); year != "" {
		return year + "-12-31"
	}
	return ""
}

// TitleFromURL derives a human title from the PDF filename.
func TitleFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "Financial Report"
	}
	parts := strings.Split(parsed.Path, "/")
	filename := parts[len(parts)-1]
	filename = strings.TrimSuffix(filename, ".pdf")
	filename = strings.TrimSuffix(filename, ".PDF")
	filename, _ = url.PathUnescape(filename)
	filename = strings.NewReplacer("-", " ", "_", " ", "%20", " ").Replace(filename)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "Financial Report"
	}
	if len(filename) > 120 {
		filename = filename[:120]
	}
	return filename
}

// BuildReportFromURL classifies a PDF URL into a FinancialReport with the given
// provenance source.
func BuildReportFromURL(absURL, source string) FinancialReport {
	lower := strings.ToLower(absURL)
	return FinancialReport{
		URL:    absURL,
		Date:   ExtractDateFromURL(lower),
		Type:   ClassifyURLType(lower),
		Title:  TitleFromURL(absURL),
		Source: source,
	}
}

// SourcePriority orders reports by provenance quality (lower = better) when
// merging. This is the UNIFIED table, deliberately adopting report-coverage's
// (richer) ordering for both jobs:
//
//	asx_announcements < smart_crawler/crawler < investor_crawl < live_crawl
//	< links_import < everything else
//
// DIVERGENCE from the old report-linker: it had no "investor_crawl" case, so
// investor_crawl fell to the default rank (after links_import). Under the
// unified table it now sorts BEFORE live_crawl. Because every merge re-sorts the
// company's whole array, `reports link` will therefore REORDER already-persisted
// investor_crawl entries the first time it touches a row that has them. That is
// intended — provenance ranking should not depend on which tool happens to write
// — but it is a real, observable change to stored ordering, not a no-op.
// Ordering is presentational only: no dedup or retention decision keys off it.
func SourcePriority(source string) int {
	switch source {
	case "asx_announcements":
		return 0
	case "smart_crawler", "crawler":
		return 1
	case "investor_crawl":
		return 2
	case "live_crawl":
		return 3
	case "links_import":
		return 4
	default:
		return 6
	}
}

// rowFailures accumulates per-row scan/decode failures inside a query loop.
// The three query loops in this package used to `continue` silently, so a query
// whose every row failed to decode looked exactly like a query that legitimately
// matched nothing. Now the count and the first error are always logged, and a
// loop where EVERY row failed is a hard error.
type rowFailures struct {
	count int
	first error
}

func (rf *rowFailures) record(err error) {
	rf.count++
	if rf.first == nil {
		rf.first = err
	}
}

// report logs the tally and returns an error when every scanned row failed.
func (rf *rowFailures) report(what string, scanned int) error {
	if rf.count == 0 {
		return nil
	}
	if scanned > 0 && rf.count == scanned {
		return fmt.Errorf("%s: all %d rows failed to decode; first error: %w", what, scanned, rf.first)
	}
	log.Printf("  WARNING %s: skipped %d of %d rows that failed to decode; first error: %v",
		what, rf.count, scanned, rf.first)
	return nil
}

// politeSleep waits `delay` plus up to delay/2 of random jitter between remote
// fetches, and returns early (with ctx.Err()) when the job is cancelled — a bare
// time.Sleep would keep a SIGTERM'd run alive for the rest of its delay budget.
//
// A non-positive delay disables the wait entirely: rand.Int63n PANICS on a
// non-positive bound, which is exactly what `-delay 0` used to do.
func politeSleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	wait := delay
	if half := int64(delay / 2); half > 0 {
		wait += time.Duration(rand.Int63n(half))
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// TypePriority orders report types when two reports share a date.
func TypePriority(t string) int {
	switch t {
	case "annual_results":
		return 0
	case "annual_report":
		return 1
	case "half_year_results":
		return 2
	case "full_year_results":
		return 3
	case "investor_presentation":
		return 4
	case "quarterly_report":
		return 5
	default:
		return 9
	}
}

// ParseCodes turns a comma-separated -codes value into an upper-cased set.
func ParseCodes(codes string) map[string]bool {
	set := make(map[string]bool)
	for _, c := range strings.Split(codes, ",") {
		c = strings.TrimSpace(strings.ToUpper(c))
		if c != "" {
			set[c] = true
		}
	}
	return set
}

// CodeList turns a comma-separated -codes value into an upper-cased slice
// (for `= ANY($1)` predicates).
func CodeList(codes string) []string {
	var out []string
	for _, c := range strings.Split(codes, ",") {
		c = strings.TrimSpace(c)
		if c != "" {
			out = append(out, strings.ToUpper(c))
		}
	}
	return out
}

// SortReports applies the merge ordering: source priority, then date desc.
func SortReports(reports []FinancialReport) {
	sort.SliceStable(reports, func(i, j int) bool {
		si, sj := SourcePriority(reports[i].Source), SourcePriority(reports[j].Source)
		if si != sj {
			return si < sj
		}
		return reports[i].Date > reports[j].Date
	})
}

// mergeReports merges newReports into a company's financial_reports JSONB.
//
// Both report-coverage and report-linker had a byte-for-byte equivalent copy of
// this (the linker's took a caller-supplied `existing` slice and then threw it
// away — it always re-reads under the row lock). Dedup keeps the row-level
// `FOR UPDATE` lock, the case-insensitive URL dedup, the source/date ordering
// and the "no new URLs → no write" short-circuit.
func mergeReports(ctx context.Context, db txBeginner, code string, newReports []FinancialReport, verbose bool) (bool, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var existingJSON string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(financial_reports::text, '[]') FROM "company-metadata" WHERE stock_code = $1 FOR UPDATE`,
		code,
	).Scan(&existingJSON)
	if err != nil {
		return false, fmt.Errorf("fetch existing: %w", err)
	}

	// A decode failure must ABORT this company: swallowing it leaves `existing`
	// nil, and the write below would then replace the company's whole
	// financial_reports array with just the new reports — silent data loss.
	var existing []FinancialReport
	if err := json.Unmarshal([]byte(existingJSON), &existing); err != nil {
		return false, fmt.Errorf("corrupt financial_reports for %s: %w", code, err)
	}

	existingURLs := make(map[string]bool, len(existing))
	for _, r := range existing {
		existingURLs[strings.ToLower(r.URL)] = true
	}

	added := 0
	for _, r := range newReports {
		if !existingURLs[strings.ToLower(r.URL)] {
			existing = append(existing, r)
			existingURLs[strings.ToLower(r.URL)] = true
			added++
		}
	}

	if added == 0 {
		return false, nil
	}

	SortReports(existing)

	jsonBytes, err := json.Marshal(existing)
	if err != nil {
		return false, fmt.Errorf("marshal: %w", err)
	}

	_, err = tx.Exec(ctx,
		`UPDATE "company-metadata" SET financial_reports = $1::jsonb WHERE stock_code = $2`,
		string(jsonBytes), code,
	)
	if err != nil {
		return false, fmt.Errorf("update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}

	if verbose {
		log.Printf("  %s: added %d new reports (total: %d)", code, added, len(existing))
	}
	return true, nil
}
