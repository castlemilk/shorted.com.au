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
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FinancialReport matches the JSONB schema in company-metadata.financial_reports.
// GcsURL is only populated by `reports sync`; it is omitempty so the linker and
// coverage tools round-trip rows they didn't sync without clobbering the field.
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
// merging. Merged from the two copies: report-coverage knew about
// "investor_crawl", report-linker did not; the relative order of every source
// either tool produces is unchanged (asx_announcements < smart_crawler/crawler
// < investor_crawl < live_crawl < links_import < everything else).
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
func mergeReports(ctx context.Context, db *pgxpool.Pool, code string, newReports []FinancialReport, verbose bool) (bool, error) {
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

	var existing []FinancialReport
	_ = json.Unmarshal([]byte(existingJSON), &existing)

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
