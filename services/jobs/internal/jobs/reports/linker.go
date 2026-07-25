package reports

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/jackc/pgx/v5/pgxpool"
)

// linkerFlags mirrors services/report-linker's package-level flag vars.
type linkerFlags struct {
	dryRun  bool
	codes   string
	limit   int
	verbose bool
	crawl   bool
	delay   time.Duration
}

// LinkJob returns the `shorted reports link` subcommand
// (was services/report-linker).
func LinkJob() runner.Job {
	return runner.Func{
		JobName: "link",
		Desc:    "extract financial reports from stored company links (optionally live-crawl investor pages)",
		DryRun:  true,
		Fn:      RunLink,
	}
}

// RunLink is the migrated services/report-linker main(). Flags unchanged.
func RunLink(ctx context.Context, args []string) error {
	g := runner.FromContext(ctx)
	fs := flag.NewFlagSet("reports link", flag.ContinueOnError)
	f := linkerFlags{}
	fs.BoolVar(&f.dryRun, "dry-run", g.DryRun, "Show what would be done without writing to DB")
	fs.StringVar(&f.codes, "codes", "", "Comma-separated stock codes (default: all)")
	fs.IntVar(&f.limit, "limit", 0, "Limit number of stocks to process (0 = all)")
	fs.BoolVar(&f.verbose, "verbose", g.Verbose, "Verbose output")
	fs.BoolVar(&f.crawl, "crawl", false, "Live-crawl investor pages for companies with websites but 0 reports")
	fs.DurationVar(&f.delay, "delay", 2*time.Second, "Delay between live crawls (polite scraping)")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}

	db, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(3))
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer db.Close()

	// Phase 1: Extract from existing links data
	log.Println("=== Phase 1: Extracting from existing links data ===")
	if err := runLinksExtraction(ctx, db, f); err != nil {
		return err
	}

	// Phase 2: Live crawl investor pages (if --crawl flag)
	if f.crawl {
		log.Println("")
		log.Println("=== Phase 2: Live-crawling investor pages ===")
		if err := runLiveCrawl(ctx, db, f); err != nil {
			return err
		}
	}
	return nil
}

func runLinksExtraction(ctx context.Context, db *pgxpool.Pool, f linkerFlags) error {
	companies, err := getCompaniesWithLinks(ctx, db, f.codes)
	if err != nil {
		return fmt.Errorf("query companies: %w", err)
	}

	if f.limit > 0 && len(companies) > f.limit {
		companies = companies[:f.limit]
	}

	log.Printf("Found %d companies with links data to process", len(companies))

	var totalProcessed, totalUpdated, totalReportsFound int

	for _, c := range companies {
		if err := ctx.Err(); err != nil {
			return err
		}
		reports := extractFinancialReports(c.website, c.links)
		if len(reports) == 0 {
			continue
		}

		totalProcessed++
		totalReportsFound += len(reports)

		if f.verbose {
			log.Printf("  %s: found %d financial reports from links", c.stockCode, len(reports))
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if f.dryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports, f.verbose)
		if err != nil {
			log.Printf("  ERROR updating %s: %v", c.stockCode, err)
			continue
		}
		if updated {
			totalUpdated++
		}
	}

	log.Printf("Links extraction done! Processed: %d, Reports found: %d, DB updated: %d",
		totalProcessed, totalReportsFound, totalUpdated)
	return nil
}

func runLiveCrawl(ctx context.Context, db *pgxpool.Pool, f linkerFlags) error {
	companies, err := getCompaniesNeedingCrawl(ctx, db, f.codes)
	if err != nil {
		return fmt.Errorf("query companies for crawl: %w", err)
	}

	if f.limit > 0 && len(companies) > f.limit {
		companies = companies[:f.limit]
	}

	log.Printf("Found %d companies with websites but no reports — will live-crawl", len(companies))

	crawler := enrichment.NewReportCrawler()
	var totalCrawled, totalUpdated, totalReportsFound, totalErrors int

	for i, c := range companies {
		if err := ctx.Err(); err != nil {
			return err
		}
		if i > 0 {
			// Polite delay with jitter, abandoned on cancellation.
			if err := politeSleep(ctx, f.delay); err != nil {
				return err
			}
		}

		if i > 0 && i%20 == 0 {
			log.Printf("  Crawl progress: %d/%d, reports found: %d, errors: %d",
				i, len(companies), totalReportsFound, totalErrors)
		}

		crawlCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		crawledReports, err := crawler.CrawlFinancialReports(crawlCtx, c.website)
		cancel()

		if err != nil {
			if f.verbose {
				log.Printf("  %s: crawl error: %v", c.stockCode, err)
			}
			totalErrors++
			continue
		}

		if len(crawledReports) == 0 {
			if f.verbose {
				log.Printf("  %s: no reports found at %s", c.stockCode, c.website)
			}
			totalCrawled++
			continue
		}

		// Convert proto reports to our FinancialReport type
		var reports []FinancialReport
		for _, r := range crawledReports {
			reports = append(reports, FinancialReport{
				URL:    r.Url,
				Date:   r.Date,
				Type:   r.Type,
				Title:  r.Title,
				Source: "live_crawl",
			})
		}

		totalCrawled++
		totalReportsFound += len(reports)

		if f.verbose {
			log.Printf("  %s: crawled %d reports from %s", c.stockCode, len(reports), c.website)
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if f.dryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports, f.verbose)
		if err != nil {
			log.Printf("  ERROR updating %s: %v", c.stockCode, err)
			continue
		}
		if updated {
			totalUpdated++
		}
	}

	log.Printf("Live crawl done! Crawled: %d, Reports found: %d, DB updated: %d, Errors: %d",
		totalCrawled, totalReportsFound, totalUpdated, totalErrors)
	return nil
}

type companyRow struct {
	stockCode       string
	website         string
	links           string
	existingReports []FinancialReport
}

func getCompaniesWithLinks(ctx context.Context, db *pgxpool.Pool, codesFlag string) ([]companyRow, error) {
	var args []interface{}
	whereClause := ""
	if codesFlag != "" {
		args = append(args, CodeList(codesFlag))
		whereClause = " AND cm.stock_code = ANY($1)"
	}

	query := fmt.Sprintf(`
		SELECT cm.stock_code,
			COALESCE(cm.website, '') as website,
			COALESCE(cm.links::text, '[]') as links,
			COALESCE(cm.financial_reports::text, '[]') as financial_reports
		FROM "company-metadata" cm
		WHERE cm.stock_code IS NOT NULL AND cm.stock_code != ''
			AND cm.links IS NOT NULL AND cm.links::text != '[]' AND cm.links::text != 'null'
			%s
		ORDER BY cm.stock_code
	`, whereClause)

	return queryCompanyRows(ctx, db, query, args)
}

// getCompaniesNeedingCrawl returns companies with websites but 0 financial reports.
func getCompaniesNeedingCrawl(ctx context.Context, db *pgxpool.Pool, codesFlag string) ([]companyRow, error) {
	var args []interface{}
	whereClause := ""
	if codesFlag != "" {
		args = append(args, CodeList(codesFlag))
		whereClause = " AND cm.stock_code = ANY($1)"
	}

	// Prioritize by short position (most-shorted first) so we crawl the most valuable companies first
	query := fmt.Sprintf(`
		WITH latest AS (SELECT MAX("DATE") AS max_date FROM shorts)
		SELECT cm.stock_code,
			COALESCE(cm.website, '') as website,
			'[]' as links,
			COALESCE(cm.financial_reports::text, '[]') as financial_reports
		FROM "company-metadata" cm
		LEFT JOIN latest l ON true
		LEFT JOIN shorts s ON s."PRODUCT_CODE" = cm.stock_code AND s."DATE" = l.max_date
		WHERE cm.stock_code IS NOT NULL AND cm.stock_code != ''
			AND cm.website IS NOT NULL AND cm.website != ''
			AND (cm.financial_reports IS NULL OR cm.financial_reports::text = '[]' OR cm.financial_reports::text = 'null')
			%s
		ORDER BY COALESCE(s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", 0) DESC
	`, whereClause)

	return queryCompanyRows(ctx, db, query, args)
}

func queryCompanyRows(ctx context.Context, db *pgxpool.Pool, query string, args []interface{}) ([]companyRow, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var companies []companyRow
	var scanned int
	var badRows rowFailures
	for rows.Next() {
		scanned++
		var c companyRow
		var existingJSON string
		if err := rows.Scan(&c.stockCode, &c.website, &c.links, &existingJSON); err != nil {
			badRows.record(err)
			continue
		}
		if err := json.Unmarshal([]byte(existingJSON), &c.existingReports); err != nil {
			badRows.record(fmt.Errorf("%s financial_reports: %w", c.stockCode, err))
			continue
		}
		companies = append(companies, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := badRows.report("queryCompanyRows", scanned); err != nil {
		return nil, err
	}
	return companies, nil
}

// extractFinancialReports pulls report PDFs out of a company's stored links blob.
func extractFinancialReports(website, linksRaw string) []FinancialReport {
	// Parse links — the column stores a Python-style text array: ['url1', 'url2', ...]
	// or a JSON array: ["url1", "url2", ...]
	var links []string

	// Try JSON first
	if err := json.Unmarshal([]byte(linksRaw), &links); err != nil {
		// Fall back to parsing Python-style text array: ['url1', 'url2']
		// Split on "', '" to handle URLs that may contain commas
		trimmed := strings.Trim(linksRaw, "[] ")
		trimmed = strings.TrimPrefix(trimmed, "'")
		trimmed = strings.TrimSuffix(trimmed, "'")
		for _, l := range strings.Split(trimmed, "', '") {
			l = strings.TrimSpace(l)
			l = strings.Trim(l, "'\"")
			l = strings.TrimSpace(l)
			if l != "" {
				links = append(links, l)
			}
		}
	}

	// Deduplicate
	seen := make(map[string]struct{}, len(links))
	var unique []string
	for _, l := range links {
		lower := strings.ToLower(l)
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		unique = append(unique, l)
	}

	var reports []FinancialReport
	for _, link := range unique {
		lower := strings.ToLower(link)

		// Must be a PDF link
		if !strings.Contains(lower, ".pdf") {
			continue
		}

		// Check if it matches financial report patterns
		if !IsFinancialURL(lower) {
			continue
		}

		// Resolve relative URLs using the company website
		absURL := resolveURL(website, link)
		if absURL == "" {
			continue
		}

		reports = append(reports, BuildReportFromURL(absURL, "links_import"))
	}

	// Sort by date desc, then by type priority
	sort.SliceStable(reports, func(i, j int) bool {
		if reports[i].Date != reports[j].Date {
			return reports[i].Date > reports[j].Date
		}
		return TypePriority(reports[i].Type) < TypePriority(reports[j].Type)
	})

	// Cap at 20 per company
	if len(reports) > 20 {
		reports = reports[:20]
	}

	return reports
}

func resolveURL(website, link string) string {
	link = strings.TrimSpace(link)
	if link == "" {
		return ""
	}

	// Already absolute
	if strings.HasPrefix(link, "http://") || strings.HasPrefix(link, "https://") {
		return link
	}

	// Relative URL — need a base
	if website == "" {
		return ""
	}

	base := website
	if !strings.HasPrefix(base, "http") {
		base = "https://" + base
	}

	baseURL, err := url.Parse(base)
	if err != nil {
		return ""
	}

	ref, err := url.Parse(link)
	if err != nil {
		return ""
	}

	return baseURL.ResolveReference(ref).String()
}
