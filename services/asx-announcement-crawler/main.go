package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// FinancialReport matches the existing JSONB schema in company-metadata.financial_reports
type FinancialReport struct {
	URL    string `json:"url"`
	Date   string `json:"date"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	GcsURL string `json:"gcsUrl"`
	Source string `json:"source"`
}

// ASXAnnouncement represents a parsed announcement from the ASX HTML page
type ASXAnnouncement struct {
	Date           string
	IsPriceSens    bool
	Headline       string
	PDFURL         string
	Pages          string
	FileSize       string
}

var (
	flagDryRun     = flag.Bool("dry-run", false, "Parse and display results without updating the database")
	flagCodes      = flag.String("codes", "", "Comma-separated stock codes to crawl (default: all from company-metadata)")
	flagYears      = flag.String("years", "2024,2025", "Comma-separated years to crawl")
	flagLimit      = flag.Int("limit", 0, "Limit number of stocks to process (0 = all)")
	flagDelay = flag.Duration("delay", 1500*time.Millisecond, "Delay between requests")
	flagVerbose    = flag.Bool("verbose", false, "Verbose output")
	flagAllAnnouncements = flag.Bool("all-announcements", false, "Store all announcements to asx_announcements table (not just financial reports)")
)

// Financial report headline keywords/patterns
var financialKeywords = []string{
	"annual report",
	"half year",
	"half-year",
	"halfyear",
	"interim report",
	"interim financial",
	"preliminary final report",
	"appendix 4d",
	"appendix 4e",
	"appendix 4c",
	"quarterly activities report",
	"quarterly report",
	"quarterly cash flow",
	"full year results",
	"full year statutory",
	"half year results",
	"annual financial report",
	"annual results",
	"financial results",
	"profit report",
	"profit announcement",
	"earnings release",
	"financial statements",
}

func main() {
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL environment variable required")
	}

	ctx := context.Background()

	// Use simple protocol for Supabase compatibility
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

	// Get stock codes to process
	codes, err := getStockCodes(ctx, db)
	if err != nil {
		log.Fatalf("Failed to get stock codes: %v", err)
	}

	if *flagLimit > 0 && len(codes) > *flagLimit {
		codes = codes[:*flagLimit]
	}

	log.Printf("Will crawl ASX announcements for %d stocks", len(codes))

	// Parse years
	var years []string
	for _, y := range strings.Split(*flagYears, ",") {
		y = strings.TrimSpace(y)
		if y != "" {
			years = append(years, y)
		}
	}

	// Create HTTP client with sensible timeouts
	client := &http.Client{
		Timeout: 30 * time.Second,
	}

	// Process stocks
	var (
		totalProcessed      int
		totalReports        int
		totalUpdated        int
		totalErrors         int
		totalAnnouncements  int
		totalAnnStored      int
	)

	for i, code := range codes {
		if i > 0 && i%50 == 0 {
			log.Printf("Progress: %d/%d stocks processed, %d reports found, %d updated, %d errors",
				i, len(codes), totalReports, totalUpdated, totalErrors)
		}

		reports, allAnns, err := crawlStockAnnouncementsFull(client, code, years)
		if err != nil {
			if *flagVerbose {
				log.Printf("  ERROR %s: %v", code, err)
			}
			totalErrors++
			continue
		}

		totalProcessed++

		// Store all announcements to asx_announcements table
		if *flagAllAnnouncements && len(allAnns) > 0 {
			totalAnnouncements += len(allAnns)
			if !*flagDryRun {
				stored, err := storeAnnouncements(ctx, db, code, allAnns)
				if err != nil {
					log.Printf("  ERROR storing announcements for %s: %v", code, err)
				} else {
					totalAnnStored += stored
				}
			} else if *flagVerbose {
				log.Printf("  %s: %d total announcements", code, len(allAnns))
			}
		}

		if len(reports) == 0 {
			// Jittered delay to be polite
			jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
			time.Sleep(*flagDelay + jitter)
			continue
		}

		totalReports += len(reports)

		if *flagDryRun {
			log.Printf("  %s: found %d financial reports", code, len(reports))
			for _, r := range reports {
				log.Printf("    [%s] %s — %s", r.Date, r.Title, r.URL)
			}
			jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
			time.Sleep(*flagDelay + jitter)
			continue
		}

		// Merge with existing reports and update DB
		updated, err := mergeAndUpdateReports(ctx, db, code, reports)
		if err != nil {
			log.Printf("  ERROR updating %s: %v", code, err)
			totalErrors++
			continue
		}
		if updated {
			totalUpdated++
		}

		// Jittered delay to be polite
		jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
		time.Sleep(*flagDelay + jitter)
	}

	log.Printf("Done! Processed: %d, Reports found: %d, DB updated: %d, Announcements: %d (stored: %d), Errors: %d",
		totalProcessed, totalReports, totalUpdated, totalAnnouncements, totalAnnStored, totalErrors)
}

func getStockCodes(ctx context.Context, db *pgxpool.Pool) ([]string, error) {
	if *flagCodes != "" {
		var codes []string
		for _, c := range strings.Split(*flagCodes, ",") {
			c = strings.TrimSpace(c)
			if c != "" {
				codes = append(codes, strings.ToUpper(c))
			}
		}
		return codes, nil
	}

	// Get all stock codes from company-metadata that have appeared in shorts data
	rows, err := db.Query(ctx, `
		SELECT DISTINCT cm.stock_code
		FROM "company-metadata" cm
		WHERE cm.stock_code IS NOT NULL AND cm.stock_code != ''
		ORDER BY cm.stock_code
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var codes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			continue
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}

func crawlStockAnnouncements(client *http.Client, code string, years []string) ([]FinancialReport, error) {
	reports, _, err := crawlStockAnnouncementsFull(client, code, years)
	return reports, err
}

// crawlStockAnnouncementsFull returns both financial reports and all announcements
func crawlStockAnnouncementsFull(client *http.Client, code string, years []string) ([]FinancialReport, []ASXAnnouncement, error) {
	var allReports []FinancialReport
	var allAnnouncements []ASXAnnouncement

	for _, year := range years {
		announcements, err := fetchASXAnnouncements(client, code, year)
		if err != nil {
			return nil, nil, fmt.Errorf("year %s: %w", year, err)
		}

		allAnnouncements = append(allAnnouncements, announcements...)

		for _, ann := range announcements {
			if isFinancialReport(ann.Headline) {
				allReports = append(allReports, FinancialReport{
					URL:    ann.PDFURL,
					Date:   ann.Date,
					Type:   classifyReportType(ann.Headline),
					Title:  ann.Headline,
					GcsURL: "",
					Source: "asx_announcements",
				})
			}
		}
	}

	// Sort by date descending (most recent first)
	sort.Slice(allReports, func(i, j int) bool {
		return allReports[i].Date > allReports[j].Date
	})

	return allReports, allAnnouncements, nil
}

func fetchASXAnnouncements(client *http.Client, code, year string) ([]ASXAnnouncement, error) {
	url := fmt.Sprintf(
		"https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&timeframe=Y&year=%s&asxCode=%s",
		year, code,
	)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	// Set headers to look like a regular browser
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-AU,en;q=0.9")
	req.Header.Set("Referer", "https://www.asx.com.au/")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("HTML parse failed: %w", err)
	}

	var announcements []ASXAnnouncement

	// Parse announcement table rows
	doc.Find("announcement_data table tbody tr").Each(func(i int, row *goquery.Selection) {
		tds := row.Find("td")
		if tds.Length() < 3 {
			return
		}

		// First td: date
		dateText := strings.TrimSpace(tds.Eq(0).Text())
		dateText = strings.Split(dateText, "\n")[0] // Remove time part
		dateText = strings.TrimSpace(dateText)
		parsedDate := parseASXDate(dateText)

		// Second td: price sensitivity indicator
		isPriceSens := tds.Eq(1).HasClass("pricesens") && strings.TrimSpace(tds.Eq(1).Text()) != ""

		// Third td: headline + PDF link
		headlineTd := tds.Eq(2)
		headline := ""
		pdfURL := ""
		pages := ""
		fileSize := ""

		link := headlineTd.Find("a")
		if link.Length() > 0 {
			// Extract headline text (before any img/span elements)
			headline = strings.TrimSpace(link.Contents().First().Text())
			// Clean up: sometimes headline includes br content
			headline = strings.Split(headline, "\n")[0]
			headline = strings.TrimSpace(headline)

			href, exists := link.Attr("href")
			if exists {
				if strings.HasPrefix(href, "/") {
					pdfURL = "https://www.asx.com.au" + href
				} else {
					pdfURL = href
				}
				// Unescape HTML entities in URL
				pdfURL = strings.ReplaceAll(pdfURL, "&amp;", "&")
			}

			// Extract pages and file size
			link.Find("span.page").Each(func(_ int, s *goquery.Selection) {
				pages = strings.TrimSpace(s.Text())
			})
			link.Find("span.filesize").Each(func(_ int, s *goquery.Selection) {
				fileSize = strings.TrimSpace(s.Text())
			})
		}

		if headline != "" && pdfURL != "" {
			announcements = append(announcements, ASXAnnouncement{
				Date:        parsedDate,
				IsPriceSens: isPriceSens,
				Headline:    headline,
				PDFURL:      pdfURL,
				Pages:       pages,
				FileSize:    fileSize,
			})
		}
	})

	if *flagVerbose && len(announcements) > 0 {
		log.Printf("  %s/%s: %d total announcements", code, year, len(announcements))
	}

	return announcements, nil
}

// parseASXDate converts "24/12/2025" to "2025-12-24"
func parseASXDate(dateStr string) string {
	parts := strings.Split(dateStr, "/")
	if len(parts) != 3 {
		return dateStr
	}
	return fmt.Sprintf("%s-%s-%s", parts[2], parts[1], parts[0])
}

// isFinancialReport checks if an announcement headline indicates a financial report
func isFinancialReport(headline string) bool {
	lower := strings.ToLower(headline)
	for _, kw := range financialKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// classifyReportType determines the specific type of financial report
func classifyReportType(headline string) string {
	lower := strings.ToLower(headline)
	switch {
	case strings.Contains(lower, "appendix 4e") || strings.Contains(lower, "preliminary final"):
		return "annual_results"
	case strings.Contains(lower, "annual report") || strings.Contains(lower, "annual financial"):
		return "annual_report"
	case strings.Contains(lower, "appendix 4d") || strings.Contains(lower, "half year") || strings.Contains(lower, "half-year") || strings.Contains(lower, "interim"):
		return "half_year_results"
	case strings.Contains(lower, "appendix 4c") || strings.Contains(lower, "quarterly"):
		return "quarterly_report"
	case strings.Contains(lower, "full year"):
		return "full_year_results"
	default:
		return "financial_report"
	}
}

// mergeAndUpdateReports merges new ASX reports with existing ones and updates the DB
func mergeAndUpdateReports(ctx context.Context, db *pgxpool.Pool, code string, newReports []FinancialReport) (bool, error) {
	// Fetch existing reports — use fmt.Sprintf for SimpleProtocol compatibility
	var existingJSON string
	err := db.QueryRow(ctx,
		fmt.Sprintf(`SELECT COALESCE(financial_reports::text, '[]') FROM "company-metadata" WHERE stock_code = '%s'`, escapeSQLString(code)),
	).Scan(&existingJSON)
	if err != nil {
		return false, fmt.Errorf("fetch existing: %w", err)
	}

	var existing []FinancialReport
	if err := json.Unmarshal([]byte(existingJSON), &existing); err != nil {
		existing = nil // Reset if invalid
	}

	// Build set of existing URLs to avoid duplicates
	existingURLs := make(map[string]bool)
	for _, r := range existing {
		existingURLs[r.URL] = true
	}

	// Add new reports that don't already exist
	added := 0
	for _, r := range newReports {
		if !existingURLs[r.URL] {
			existing = append(existing, r)
			existingURLs[r.URL] = true
			added++
		}
	}

	if added == 0 {
		return false, nil
	}

	// Sort: ASX announcement reports first, then by date descending
	sort.Slice(existing, func(i, j int) bool {
		if existing[i].Source == "asx_announcements" && existing[j].Source != "asx_announcements" {
			return true
		}
		if existing[i].Source != "asx_announcements" && existing[j].Source == "asx_announcements" {
			return false
		}
		return existing[i].Date > existing[j].Date
	})

	// Marshal and update
	jsonBytes, err := json.Marshal(existing)
	if err != nil {
		return false, fmt.Errorf("marshal: %w", err)
	}

	// Escape JSON for SQL string literal
	escapedJSON := escapeSQLString(string(jsonBytes))
	_, err = db.Exec(ctx,
		fmt.Sprintf(`UPDATE "company-metadata" SET financial_reports = '%s'::jsonb WHERE stock_code = '%s'`, escapedJSON, escapeSQLString(code)),
	)
	if err != nil {
		return false, fmt.Errorf("update: %w", err)
	}

	if *flagVerbose {
		log.Printf("  %s: added %d new financial reports (total: %d)", code, added, len(existing))
	}

	return true, nil
}

// classifyAnnouncementType determines the type of ASX announcement from its headline
func classifyAnnouncementType(headline string) string {
	lower := strings.ToLower(headline)
	switch {
	case strings.Contains(lower, "trading halt") || strings.Contains(lower, "voluntary suspension"):
		return "trading_halt"
	case strings.Contains(lower, "placement") || strings.Contains(lower, "share purchase plan") ||
		strings.Contains(lower, "rights issue") || strings.Contains(lower, "entitlement offer"):
		return "capital_raise"
	case strings.Contains(lower, "appendix 3y") || strings.Contains(lower, "change of director") ||
		strings.Contains(lower, "director interest"):
		return "director_dealing"
	case strings.Contains(lower, "profit") || strings.Contains(lower, "earnings") ||
		strings.Contains(lower, "revenue") || strings.Contains(lower, "dividend"):
		return "earnings"
	case strings.Contains(lower, "guidance") || strings.Contains(lower, "forecast") ||
		strings.Contains(lower, "outlook update"):
		return "guidance"
	case strings.Contains(lower, "takeover") || strings.Contains(lower, "scheme of arrangement") ||
		strings.Contains(lower, "merger") || strings.Contains(lower, "acquisition"):
		return "takeover"
	default:
		return "other"
	}
}

// storeAnnouncements inserts announcements into the asx_announcements table, returning count of new rows
func storeAnnouncements(ctx context.Context, db *pgxpool.Pool, code string, announcements []ASXAnnouncement) (int, error) {
	stored := 0
	for _, ann := range announcements {
		annType := classifyAnnouncementType(ann.Headline)
		query := fmt.Sprintf(
			`INSERT INTO asx_announcements (stock_code, announcement_date, headline, is_price_sensitive, announcement_type, pdf_url, source)
			 VALUES ('%s', '%s', '%s', %t, '%s', '%s', 'asx_announcements')
			 ON CONFLICT (stock_code, announcement_date, headline) DO NOTHING`,
			escapeSQLString(code),
			escapeSQLString(ann.Date),
			escapeSQLString(ann.Headline),
			ann.IsPriceSens,
			escapeSQLString(annType),
			escapeSQLString(ann.PDFURL),
		)

		tag, err := db.Exec(ctx, query)
		if err != nil {
			if *flagVerbose {
				log.Printf("    WARN: failed to insert announcement for %s: %v", code, err)
			}
			continue
		}
		if tag.RowsAffected() > 0 {
			stored++
		}
	}
	return stored, nil
}

// escapeSQLString escapes single quotes for safe SQL string literals
func escapeSQLString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
