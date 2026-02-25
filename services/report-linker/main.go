package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// FinancialReport matches the JSONB schema in company-metadata.financial_reports
type FinancialReport struct {
	URL    string `json:"url"`
	Date   string `json:"date"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	Source string `json:"source"`
}

var (
	flagDryRun  = flag.Bool("dry-run", false, "Show what would be done without writing to DB")
	flagCodes   = flag.String("codes", "", "Comma-separated stock codes (default: all)")
	flagLimit   = flag.Int("limit", 0, "Limit number of stocks to process (0 = all)")
	flagVerbose = flag.Bool("verbose", false, "Verbose output")
	flagCrawl   = flag.Bool("crawl", false, "Live-crawl investor pages for companies with websites but 0 reports")
	flagDelay   = flag.Duration("delay", 2*time.Second, "Delay between live crawls (polite scraping)")
)

// Financial report URL patterns — match against lowercased URL
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

// Year extraction regex (2010-2029)
var yearRe = regexp.MustCompile(`20(2[0-9]|1[0-9])`)

func main() {
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL environment variable required")
	}

	ctx := context.Background()
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("Failed to parse DATABASE_URL: %v", err)
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.MaxConns = 3

	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Phase 1: Extract from existing links data
	log.Println("=== Phase 1: Extracting from existing links data ===")
	runLinksExtraction(ctx, db)

	// Phase 2: Live crawl investor pages (if --crawl flag)
	if *flagCrawl {
		log.Println("")
		log.Println("=== Phase 2: Live-crawling investor pages ===")
		runLiveCrawl(ctx, db)
	}
}

func runLinksExtraction(ctx context.Context, db *pgxpool.Pool) {
	companies, err := getCompaniesWithLinks(ctx, db)
	if err != nil {
		log.Fatalf("Failed to query companies: %v", err)
	}

	if *flagLimit > 0 && len(companies) > *flagLimit {
		companies = companies[:*flagLimit]
	}

	log.Printf("Found %d companies with links data to process", len(companies))

	var totalProcessed, totalUpdated, totalReportsFound int

	for _, c := range companies {
		reports := extractFinancialReports(c.website, c.links)
		if len(reports) == 0 {
			continue
		}

		totalProcessed++
		totalReportsFound += len(reports)

		if *flagVerbose {
			log.Printf("  %s: found %d financial reports from links", c.stockCode, len(reports))
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if *flagDryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports, c.existingReports)
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
}

func runLiveCrawl(ctx context.Context, db *pgxpool.Pool) {
	companies, err := getCompaniesNeedingCrawl(ctx, db)
	if err != nil {
		log.Fatalf("Failed to query companies for crawl: %v", err)
	}

	if *flagLimit > 0 && len(companies) > *flagLimit {
		companies = companies[:*flagLimit]
	}

	log.Printf("Found %d companies with websites but no reports — will live-crawl", len(companies))

	crawler := enrichment.NewReportCrawler()
	var totalCrawled, totalUpdated, totalReportsFound, totalErrors int

	for i, c := range companies {
		if i > 0 {
			// Polite delay with jitter
			jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
			time.Sleep(*flagDelay + jitter)
		}

		if i > 0 && i%20 == 0 {
			log.Printf("  Crawl progress: %d/%d, reports found: %d, errors: %d",
				i, len(companies), totalReportsFound, totalErrors)
		}

		crawlCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		crawledReports, err := crawler.CrawlFinancialReports(crawlCtx, c.website)
		cancel()

		if err != nil {
			if *flagVerbose {
				log.Printf("  %s: crawl error: %v", c.stockCode, err)
			}
			totalErrors++
			continue
		}

		if len(crawledReports) == 0 {
			if *flagVerbose {
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

		if *flagVerbose {
			log.Printf("  %s: crawled %d reports from %s", c.stockCode, len(reports), c.website)
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if *flagDryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports, c.existingReports)
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
}

type companyRow struct {
	stockCode       string
	website         string
	links           string
	existingReports []FinancialReport
}

func getCompaniesWithLinks(ctx context.Context, db *pgxpool.Pool) ([]companyRow, error) {
	var args []interface{}
	whereClause := ""
	if *flagCodes != "" {
		var codes []string
		for _, c := range strings.Split(*flagCodes, ",") {
			c = strings.TrimSpace(c)
			if c != "" {
				codes = append(codes, strings.ToUpper(c))
			}
		}
		args = append(args, codes)
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

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var companies []companyRow
	for rows.Next() {
		var c companyRow
		var existingJSON string
		if err := rows.Scan(&c.stockCode, &c.website, &c.links, &existingJSON); err != nil {
			continue
		}
		_ = json.Unmarshal([]byte(existingJSON), &c.existingReports)
		companies = append(companies, c)
	}
	return companies, rows.Err()
}

// getCompaniesNeedingCrawl returns companies with websites but 0 financial reports.
func getCompaniesNeedingCrawl(ctx context.Context, db *pgxpool.Pool) ([]companyRow, error) {
	var args []interface{}
	whereClause := ""
	if *flagCodes != "" {
		var codes []string
		for _, c := range strings.Split(*flagCodes, ",") {
			c = strings.TrimSpace(c)
			if c != "" {
				codes = append(codes, strings.ToUpper(c))
			}
		}
		args = append(args, codes)
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

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var companies []companyRow
	for rows.Next() {
		var c companyRow
		var existingJSON string
		if err := rows.Scan(&c.stockCode, &c.website, &c.links, &existingJSON); err != nil {
			continue
		}
		_ = json.Unmarshal([]byte(existingJSON), &c.existingReports)
		companies = append(companies, c)
	}
	return companies, rows.Err()
}

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
		if !isFinancialURL(lower) {
			continue
		}

		// Resolve relative URLs using the company website
		absURL := resolveURL(website, link)
		if absURL == "" {
			continue
		}

		report := buildReportFromURL(absURL)
		reports = append(reports, report)
	}

	// Sort by date desc, then by type priority
	sort.SliceStable(reports, func(i, j int) bool {
		if reports[i].Date != reports[j].Date {
			return reports[i].Date > reports[j].Date
		}
		return typePriority(reports[i].Type) < typePriority(reports[j].Type)
	})

	// Cap at 20 per company
	if len(reports) > 20 {
		reports = reports[:20]
	}

	return reports
}

func isFinancialURL(lower string) bool {
	for _, re := range financialURLPatterns {
		if re.MatchString(lower) {
			return true
		}
	}
	return false
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

func buildReportFromURL(absURL string) FinancialReport {
	lower := strings.ToLower(absURL)

	// Extract year
	year := yearRe.FindString(lower)
	date := ""
	if year != "" {
		date = year + "-12-31"
	}

	// Classify type
	reportType := classifyURLType(lower)

	// Build title from filename
	title := titleFromURL(absURL)

	return FinancialReport{
		URL:    absURL,
		Date:   date,
		Type:   reportType,
		Title:  title,
		Source: "links_import",
	}
}

func classifyURLType(lower string) string {
	switch {
	case regexp.MustCompile(`appendix[_-]?4e`).MatchString(lower) ||
		regexp.MustCompile(`preliminary[_-]?final`).MatchString(lower):
		return "annual_results"
	case regexp.MustCompile(`annual[_-]?report`).MatchString(lower):
		return "annual_report"
	case regexp.MustCompile(`half[_-]?year`).MatchString(lower) ||
		regexp.MustCompile(`interim`).MatchString(lower) ||
		regexp.MustCompile(`appendix[_-]?4d`).MatchString(lower):
		return "half_year_results"
	case regexp.MustCompile(`quarterly`).MatchString(lower) ||
		regexp.MustCompile(`appendix[_-]?4c`).MatchString(lower):
		return "quarterly_report"
	case regexp.MustCompile(`full[_-]?year`).MatchString(lower):
		return "full_year_results"
	case regexp.MustCompile(`investor[_-]?presentation`).MatchString(lower) ||
		regexp.MustCompile(`results?[_-]?presentation`).MatchString(lower) ||
		regexp.MustCompile(`analyst`).MatchString(lower):
		return "investor_presentation"
	case regexp.MustCompile(`distribution`).MatchString(lower):
		return "distribution_notice"
	case regexp.MustCompile(`agm|annual[_-]?general`).MatchString(lower):
		return "agm_address"
	default:
		return "financial_report"
	}
}

func titleFromURL(absURL string) string {
	parsed, err := url.Parse(absURL)
	if err != nil {
		return "Financial Report"
	}

	// Get filename from path
	path := parsed.Path
	parts := strings.Split(path, "/")
	filename := parts[len(parts)-1]

	// Remove .pdf extension
	filename = strings.TrimSuffix(filename, ".pdf")
	filename = strings.TrimSuffix(filename, ".PDF")

	// Replace URL encoding and separators with spaces
	filename, _ = url.PathUnescape(filename)
	filename = strings.NewReplacer("-", " ", "_", " ", "%20", " ").Replace(filename)

	// Clean up whitespace
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "Financial Report"
	}

	// Cap length
	if len(filename) > 120 {
		filename = filename[:120]
	}

	return filename
}

func typePriority(t string) int {
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

func mergeReports(ctx context.Context, db *pgxpool.Pool, code string, newReports []FinancialReport, existing []FinancialReport) (bool, error) {
	// Use a transaction with row-level locking to prevent concurrent modification
	tx, err := db.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Re-read under lock to get the latest state
	var currentJSON string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(financial_reports::text, '[]') FROM "company-metadata" WHERE stock_code = $1 FOR UPDATE`,
		code,
	).Scan(&currentJSON)
	if err != nil {
		return false, fmt.Errorf("fetch existing: %w", err)
	}

	// Use the freshly-read data instead of the stale caller-provided existing
	existing = nil
	_ = json.Unmarshal([]byte(currentJSON), &existing)

	// Build set of existing URLs to avoid duplicates
	existingURLs := make(map[string]bool, len(existing))
	for _, r := range existing {
		existingURLs[strings.ToLower(r.URL)] = true
	}

	// Add new reports that don't already exist
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

	// Sort: ASX announcements first, then crawler, then links_import, then by date desc
	sort.SliceStable(existing, func(i, j int) bool {
		si := sourcePriority(existing[i].Source)
		sj := sourcePriority(existing[j].Source)
		if si != sj {
			return si < sj
		}
		return existing[i].Date > existing[j].Date
	})

	// Marshal and update
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

	if *flagVerbose {
		log.Printf("  %s: added %d new reports (total: %d)", code, added, len(existing))
	}

	return true, nil
}

func sourcePriority(source string) int {
	switch source {
	case "asx_announcements":
		return 0
	case "smart_crawler", "crawler":
		return 1
	case "live_crawl":
		return 2
	case "links_import":
		return 3
	default:
		return 4
	}
}

