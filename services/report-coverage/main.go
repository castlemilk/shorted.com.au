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
	GcsURL string `json:"gcsUrl,omitempty"`
	Source string `json:"source"`
}

var (
	flagDryRun  = flag.Bool("dry-run", false, "Show what would be done without writing to DB")
	flagCodes   = flag.String("codes", "", "Comma-separated stock codes (default: all gaps)")
	flagLimit   = flag.Int("limit", 0, "Limit number of companies to crawl (0 = all)")
	flagVerbose = flag.Bool("verbose", false, "Verbose output")
	flagDelay   = flag.Duration("delay", 2*time.Second, "Delay between crawls (polite scraping)")
	flagMode    = flag.String("mode", "all", "Mode: all, crawl-only, direct-only, update-websites")
)

func main() {
	flag.Parse()

	mainDBURL := os.Getenv("DATABASE_URL")
	if mainDBURL == "" {
		log.Fatal("DATABASE_URL environment variable required")
	}

	ctx := context.Background()

	mainDB, err := connectDB(ctx, mainDBURL)
	if err != nil {
		log.Fatalf("Failed to connect to main DB: %v", err)
	}
	defer mainDB.Close()

	// Load company state from main DB (includes corporate_links)
	log.Println("=== Loading company state from main DB ===")
	mainState, err := loadMainDBState(ctx, mainDB)
	if err != nil {
		log.Fatalf("Failed to load main DB state: %v", err)
	}
	log.Printf("Main DB: %d companies total", len(mainState))

	// Compute gaps — find companies with corporate links but no reports
	var (
		missingReports []gapCompany // companies with investor URLs but no reports
		directPDFs     []gapCompany // companies with direct PDF links
	)

	for code, state := range mainState {
		if state.hasReports {
			continue // already has reports
		}

		// Use investor_relations links from corporate_links JSONB
		var crawlURLs, pdfURLs []string
		for _, link := range state.investorLinks {
			lower := strings.ToLower(link)
			if strings.HasSuffix(lower, ".pdf") {
				pdfURLs = append(pdfURLs, link)
			} else if link != "" {
				crawlURLs = append(crawlURLs, link)
			}
		}

		if len(pdfURLs) > 0 {
			directPDFs = append(directPDFs, gapCompany{
				stockCode: code,
				urls:      pdfURLs,
				shortPct:  state.shortPct,
			})
		}
		if len(crawlURLs) > 0 {
			missingReports = append(missingReports, gapCompany{
				stockCode: code,
				urls:      crawlURLs,
				shortPct:  state.shortPct,
			})
		} else if state.website != "" {
			// No corporate links — fall back to company website
			missingReports = append(missingReports, gapCompany{
				stockCode: code,
				urls:      []string{state.website},
				shortPct:  state.shortPct,
			})
		}
	}

	// Sort by short percentage descending (most shorted first)
	sortByShortPct(missingReports)
	sortByShortPct(directPDFs)

	// Apply --codes filter
	if *flagCodes != "" {
		codeSet := parseCodesFlag(*flagCodes)
		missingReports = filterByCodes(missingReports, codeSet)
		// missingWebsite removed (was CMS-only)
		directPDFs = filterByCodes(directPDFs, codeSet)
	}

	log.Printf("Gap analysis:")
	log.Printf("  Companies missing reports (crawlable URLs): %d", len(missingReports))
	log.Printf("  Companies with direct PDF links: %d", len(directPDFs))

	mode := *flagMode

	// Phase A: Import direct PDF links
	if mode == "all" || mode == "direct-only" {
		log.Println("")
		log.Println("=== Phase A: Importing direct PDF links ===")
		importDirectPDFs(ctx, mainDB, directPDFs)
	}

	// Phase B: Crawl investor pages
	if mode == "all" || mode == "crawl-only" {
		log.Println("")
		log.Println("=== Phase B: Crawling investor pages for reports ===")
		crawlForReports(ctx, mainDB, missingReports)
	}
}

type gapCompany struct {
	stockCode string
	urls      []string
	shortPct  float64
}

type mainDBCompany struct {
	website       string
	hasReports    bool
	shortPct      float64
	reports       []FinancialReport
	investorLinks []string
}

func connectDB(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.MaxConns = 3
	return pgxpool.NewWithConfig(ctx, config)
}

func loadMainDBState(ctx context.Context, db *pgxpool.Pool) (map[string]mainDBCompany, error) {
	rows, err := db.Query(ctx, `
		WITH latest AS (SELECT MAX("DATE") AS max_date FROM shorts)
		SELECT cm.stock_code,
			COALESCE(cm.website, '') as website,
			COALESCE(cm.financial_reports::text, '[]') as financial_reports,
			COALESCE(cm.corporate_links::text, '{}') as corporate_links,
			COALESCE(s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", 0) as short_pct
		FROM "company-metadata" cm
		LEFT JOIN latest l ON true
		LEFT JOIN shorts s ON s."PRODUCT_CODE" = cm.stock_code AND s."DATE" = l.max_date
		WHERE cm.stock_code IS NOT NULL AND cm.stock_code != ''
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]mainDBCompany)
	for rows.Next() {
		var code, website, reportsJSON, corporateLinksJSON string
		var shortPct float64
		if err := rows.Scan(&code, &website, &reportsJSON, &corporateLinksJSON, &shortPct); err != nil {
			continue
		}

		var reports []FinancialReport
		_ = json.Unmarshal([]byte(reportsJSON), &reports)

		hasReports := len(reports) > 0 && reportsJSON != "[]" && reportsJSON != "null"

		// Extract investor_relations links from corporate_links JSONB
		var corporateLinks map[string][]string
		_ = json.Unmarshal([]byte(corporateLinksJSON), &corporateLinks)
		investorLinks := corporateLinks["investor_relations"]

		result[code] = mainDBCompany{
			website:       website,
			hasReports:    hasReports,
			shortPct:      shortPct,
			reports:       reports,
			investorLinks: investorLinks,
		}
	}
	return result, rows.Err()
}

func importDirectPDFs(ctx context.Context, db *pgxpool.Pool, companies []gapCompany) {
	var totalImported, totalCompanies int

	for _, c := range companies {
		var reports []FinancialReport
		for _, pdfURL := range c.urls {
			report := buildReportFromPDFURL(pdfURL)
			reports = append(reports, report)
		}

		if len(reports) == 0 {
			continue
		}

		if *flagVerbose {
			log.Printf("  %s: %d direct PDF(s)", c.stockCode, len(reports))
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if *flagDryRun {
			totalImported += len(reports)
			totalCompanies++
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports)
		if err != nil {
			log.Printf("  ERROR updating %s: %v", c.stockCode, err)
			continue
		}
		if updated {
			totalImported += len(reports)
			totalCompanies++
		}
	}

	log.Printf("Imported %d direct PDFs for %d companies", totalImported, totalCompanies)
}

func crawlForReports(ctx context.Context, db *pgxpool.Pool, companies []gapCompany) {
	if *flagLimit > 0 && len(companies) > *flagLimit {
		companies = companies[:*flagLimit]
	}

	log.Printf("Will crawl %d companies", len(companies))

	crawler := enrichment.NewReportCrawler()
	var totalCrawled, totalUpdated, totalReports, totalErrors int

	for i, c := range companies {
		if i > 0 {
			jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
			time.Sleep(*flagDelay + jitter)
		}

		if i > 0 && i%50 == 0 {
			log.Printf("  Progress: %d/%d crawled, %d reports found, %d updated, %d errors",
				i, len(companies), totalReports, totalUpdated, totalErrors)
		}

		// Try each URL for this company until we find reports
		var allReports []FinancialReport
		for _, crawlURL := range c.urls {
			crawlCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
			crawled, err := crawler.CrawlFinancialReports(crawlCtx, crawlURL)
			cancel()

			if err != nil {
				if *flagVerbose {
					log.Printf("  %s: crawl error for %s: %v", c.stockCode, crawlURL, err)
				}
				continue
			}

			for _, r := range crawled {
				allReports = append(allReports, FinancialReport{
					URL:    r.Url,
					Date:   r.Date,
					Type:   r.Type,
					Title:  r.Title,
					Source: "investor_crawl",
				})
			}

			if len(crawled) > 0 {
				break // found reports, no need to try other URLs
			}
		}

		totalCrawled++

		if len(allReports) == 0 {
			if *flagVerbose {
				log.Printf("  %s: no reports found", c.stockCode)
			}
			continue
		}

		totalReports += len(allReports)

		if *flagVerbose {
			log.Printf("  %s: found %d reports (short: %.2f%%)", c.stockCode, len(allReports), c.shortPct)
			for _, r := range allReports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if *flagDryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, allReports)
		if err != nil {
			log.Printf("  ERROR updating %s: %v", c.stockCode, err)
			totalErrors++
			continue
		}
		if updated {
			totalUpdated++
		}
	}

	log.Printf("Crawl done! Crawled: %d, Reports found: %d, Updated: %d, Errors: %d",
		totalCrawled, totalReports, totalUpdated, totalErrors)
}

// mergeReports merges new reports into existing ones and updates the DB.
func mergeReports(ctx context.Context, db *pgxpool.Pool, code string, newReports []FinancialReport) (bool, error) {
	// Use a transaction with row-level locking to prevent concurrent modification
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

	// Dedup by URL
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

	// Sort by source priority then date desc
	sort.SliceStable(existing, func(i, j int) bool {
		si := sourcePriority(existing[i].Source)
		sj := sourcePriority(existing[j].Source)
		if si != sj {
			return si < sj
		}
		return existing[i].Date > existing[j].Date
	})

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

func buildReportFromPDFURL(pdfURL string) FinancialReport {
	lower := strings.ToLower(pdfURL)
	reportType := classifyURLType(lower)
	title := titleFromURL(pdfURL)
	date := extractDateFromURL(lower)

	return FinancialReport{
		URL:    pdfURL,
		Date:   date,
		Type:   reportType,
		Title:  title,
		Source: "links_import",
	}
}

func classifyURLType(lower string) string {
	switch {
	case strings.Contains(lower, "appendix-4e") || strings.Contains(lower, "appendix_4e") ||
		strings.Contains(lower, "preliminary-final") || strings.Contains(lower, "preliminary_final"):
		return "annual_results"
	case strings.Contains(lower, "annual-report") || strings.Contains(lower, "annual_report") ||
		strings.Contains(lower, "annualreport"):
		return "annual_report"
	case strings.Contains(lower, "half-year") || strings.Contains(lower, "half_year") ||
		strings.Contains(lower, "halfyear") || strings.Contains(lower, "interim") ||
		strings.Contains(lower, "appendix-4d") || strings.Contains(lower, "appendix_4d"):
		return "half_year_results"
	case strings.Contains(lower, "quarterly") || strings.Contains(lower, "appendix-4c") ||
		strings.Contains(lower, "appendix_4c"):
		return "quarterly_report"
	case strings.Contains(lower, "full-year") || strings.Contains(lower, "full_year"):
		return "full_year_results"
	case strings.Contains(lower, "investor-presentation") || strings.Contains(lower, "investor_presentation") ||
		strings.Contains(lower, "results-presentation") || strings.Contains(lower, "analyst"):
		return "investor_presentation"
	case strings.Contains(lower, "distribution"):
		return "distribution_notice"
	case strings.Contains(lower, "agm") || strings.Contains(lower, "annual-general"):
		return "agm_address"
	default:
		return "financial_report"
	}
}

var yearRe = regexp.MustCompile(`20(2[0-9]|1[0-9])`)

func extractDateFromURL(lower string) string {
	year := yearRe.FindString(lower)
	if year != "" {
		return year + "-12-31"
	}
	return ""
}

func titleFromURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "Financial Report"
	}
	parts := strings.Split(parsed.Path, "/")
	filename := parts[len(parts)-1]
	filename = strings.TrimSuffix(filename, ".pdf")
	filename = strings.TrimSuffix(filename, ".PDF")
	filename, _ = url.PathUnescape(filename)
	filename = strings.NewReplacer("-", " ", "_", " ").Replace(filename)
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "Financial Report"
	}
	if len(filename) > 120 {
		filename = filename[:120]
	}
	return filename
}

func sourcePriority(source string) int {
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

func sortByShortPct(companies []gapCompany) {
	sort.Slice(companies, func(i, j int) bool {
		return companies[i].shortPct > companies[j].shortPct
	})
}

func parseCodesFlag(codes string) map[string]bool {
	set := make(map[string]bool)
	for _, c := range strings.Split(codes, ",") {
		c = strings.TrimSpace(strings.ToUpper(c))
		if c != "" {
			set[c] = true
		}
	}
	return set
}

func filterByCodes(companies []gapCompany, codes map[string]bool) []gapCompany {
	var filtered []gapCompany
	for _, c := range companies {
		if codes[c.stockCode] {
			filtered = append(filtered, c)
		}
	}
	return filtered
}

