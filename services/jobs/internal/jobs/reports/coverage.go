package reports

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"math/rand"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/jackc/pgx/v5/pgxpool"
)

// coverageFlags mirrors services/report-coverage's package-level flag vars.
type coverageFlags struct {
	dryRun  bool
	codes   string
	limit   int
	verbose bool
	delay   time.Duration
	mode    string
}

// CoverageJob returns the `shorted reports coverage` subcommand
// (was services/report-coverage).
func CoverageJob() runner.Job {
	return runner.Func{
		JobName: "coverage",
		Desc:    "close financial-report gaps: import direct PDF links + crawl investor pages",
		Fn:      RunCoverage,
	}
}

// RunCoverage is the migrated services/report-coverage main(). Flags unchanged.
func RunCoverage(ctx context.Context, args []string) error {
	g := runner.FromContext(ctx)
	fs := flag.NewFlagSet("reports coverage", flag.ContinueOnError)
	f := coverageFlags{}
	fs.BoolVar(&f.dryRun, "dry-run", g.DryRun, "Show what would be done without writing to DB")
	fs.StringVar(&f.codes, "codes", "", "Comma-separated stock codes (default: all gaps)")
	fs.IntVar(&f.limit, "limit", 0, "Limit number of companies to crawl (0 = all)")
	fs.BoolVar(&f.verbose, "verbose", g.Verbose, "Verbose output")
	fs.DurationVar(&f.delay, "delay", 2*time.Second, "Delay between crawls (polite scraping)")
	fs.StringVar(&f.mode, "mode", "all", "Mode: all, crawl-only, direct-only, update-websites")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}

	mainDB, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(3))
	if err != nil {
		return err
	}
	defer mainDB.Close()

	// Load company state from main DB (includes corporate_links)
	log.Println("=== Loading company state from main DB ===")
	mainState, err := loadMainDBState(ctx, mainDB)
	if err != nil {
		return err
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
	if f.codes != "" {
		codeSet := ParseCodes(f.codes)
		missingReports = filterByCodes(missingReports, codeSet)
		// missingWebsite removed (was CMS-only)
		directPDFs = filterByCodes(directPDFs, codeSet)
	}

	log.Printf("Gap analysis:")
	log.Printf("  Companies missing reports (crawlable URLs): %d", len(missingReports))
	log.Printf("  Companies with direct PDF links: %d", len(directPDFs))

	// Phase A: Import direct PDF links
	if f.mode == "all" || f.mode == "direct-only" {
		log.Println("")
		log.Println("=== Phase A: Importing direct PDF links ===")
		importDirectPDFs(ctx, mainDB, directPDFs, f)
	}

	// Phase B: Crawl investor pages
	if f.mode == "all" || f.mode == "crawl-only" {
		log.Println("")
		log.Println("=== Phase B: Crawling investor pages for reports ===")
		crawlForReports(ctx, mainDB, missingReports, f)
	}
	return nil
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

func importDirectPDFs(ctx context.Context, db *pgxpool.Pool, companies []gapCompany, f coverageFlags) {
	var totalImported, totalCompanies int

	for _, c := range companies {
		var reports []FinancialReport
		for _, pdfURL := range c.urls {
			reports = append(reports, BuildReportFromURL(pdfURL, "links_import"))
		}

		if len(reports) == 0 {
			continue
		}

		if f.verbose {
			log.Printf("  %s: %d direct PDF(s)", c.stockCode, len(reports))
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if f.dryRun {
			totalImported += len(reports)
			totalCompanies++
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, reports, f.verbose)
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

func crawlForReports(ctx context.Context, db *pgxpool.Pool, companies []gapCompany, f coverageFlags) {
	if f.limit > 0 && len(companies) > f.limit {
		companies = companies[:f.limit]
	}

	log.Printf("Will crawl %d companies", len(companies))

	crawler := enrichment.NewReportCrawler()
	var totalCrawled, totalUpdated, totalReports, totalErrors int

	for i, c := range companies {
		if i > 0 {
			jitter := time.Duration(rand.Int63n(int64(f.delay / 2)))
			time.Sleep(f.delay + jitter)
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
				if f.verbose {
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
			if f.verbose {
				log.Printf("  %s: no reports found", c.stockCode)
			}
			continue
		}

		totalReports += len(allReports)

		if f.verbose {
			log.Printf("  %s: found %d reports (short: %.2f%%)", c.stockCode, len(allReports), c.shortPct)
			for _, r := range allReports {
				log.Printf("    [%s] %s — %s", r.Type, r.Title, r.URL)
			}
		}

		if f.dryRun {
			continue
		}

		updated, err := mergeReports(ctx, db, c.stockCode, allReports, f.verbose)
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

func sortByShortPct(companies []gapCompany) {
	sort.Slice(companies, func(i, j int) bool {
		return companies[i].shortPct > companies[j].shortPct
	})
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
