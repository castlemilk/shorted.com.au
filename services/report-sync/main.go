package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
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
	flagDryRun  = flag.Bool("dry-run", false, "Show what would be done without downloading or updating DB")
	flagCodes   = flag.String("codes", "", "Comma-separated stock codes (default: all with unsynced reports)")
	flagLimit   = flag.Int("limit", 0, "Limit number of reports to sync (0 = all)")
	flagVerbose = flag.Bool("verbose", false, "Verbose output")
	flagDelay   = flag.Duration("delay", 2*time.Second, "Delay between PDF downloads (polite scraping)")
	flagSource  = flag.String("source", "", "Filter reports by source (e.g., asx_announcements, live_crawl)")
	flagBucket  = flag.String("bucket", "", "GCS bucket name (overrides GCS_REPORTS_BUCKET env var)")
)

// asxPDFURLRegex extracts the real PDF URL from displayAnnouncement pages
var asxPDFURLRegex = regexp.MustCompile(`name="pdfURL"\s+value="([^"]+)"`)

func main() {
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL environment variable required")
	}

	bucketName := *flagBucket
	if bucketName == "" {
		bucketName = os.Getenv("GCS_REPORTS_BUCKET")
	}
	if bucketName == "" {
		bucketName = "shorted-financial-reports"
	}

	ctx := context.Background()

	// Connect to database
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

	// Initialize GCS client (skip in dry-run)
	var gcsClient *storage.Client
	if !*flagDryRun {
		gcsClient, err = newGCSClient(ctx)
		if err != nil {
			log.Fatalf("Failed to create GCS client: %v", err)
		}
		defer func() { _ = gcsClient.Close() }()
	}

	// HTTP client for downloading PDFs
	httpClient := &http.Client{
		Timeout: 60 * time.Second,
	}

	// Fetch companies with unsynced reports
	companies, err := getCompaniesWithUnsyncedReports(ctx, db)
	if err != nil {
		log.Fatalf("Failed to query companies: %v", err)
	}

	log.Printf("Found %d companies with unsynced reports", len(companies))

	var totalReports, totalSynced, totalSkipped, totalErrors int

	for _, c := range companies {
		unsyncedReports := getUnsyncedReports(c.reports)
		if len(unsyncedReports) == 0 {
			continue
		}

		if *flagVerbose {
			log.Printf("  %s: %d unsynced reports", c.stockCode, len(unsyncedReports))
		}

		updated := false
		for i := range c.reports {
			r := &c.reports[i]
			if r.GcsURL != "" || r.URL == "" {
				continue
			}
			if *flagSource != "" && r.Source != *flagSource {
				totalSkipped++
				continue
			}

			totalReports++
			if *flagLimit > 0 && totalSynced >= *flagLimit {
				log.Printf("Reached limit of %d synced reports, stopping", *flagLimit)
				goto done
			}

			objectPath := buildObjectPath(c.stockCode, r)
			gcsURL := fmt.Sprintf("https://storage.googleapis.com/%s/%s", bucketName, objectPath)

			if *flagDryRun {
				log.Printf("    [DRY-RUN] %s → %s", r.URL, objectPath)
				totalSynced++
				continue
			}

			// Download PDF
			if totalSynced > 0 {
				jitter := time.Duration(rand.Int63n(int64(*flagDelay / 2)))
				time.Sleep(*flagDelay + jitter)
			}

			pdfData, err := downloadPDF(ctx, httpClient, r.URL)
			if err != nil {
				if *flagVerbose {
					log.Printf("    ERROR downloading %s: %v", r.URL, err)
				}
				totalErrors++
				continue
			}

			// Validate it's actually a PDF
			if len(pdfData) < 5 || string(pdfData[:5]) != "%PDF-" {
				if *flagVerbose {
					log.Printf("    SKIP %s: not a valid PDF (%d bytes)", r.URL, len(pdfData))
				}
				totalErrors++
				continue
			}

			// Upload to GCS
			if err := uploadToGCS(ctx, gcsClient, bucketName, objectPath, pdfData); err != nil {
				log.Printf("    ERROR uploading %s: %v", objectPath, err)
				totalErrors++
				continue
			}

			r.GcsURL = gcsURL
			updated = true
			totalSynced++

			if *flagVerbose {
				log.Printf("    SYNCED %s → %s (%d bytes)", r.URL, objectPath, len(pdfData))
			}
		}

		// Write back updated reports to DB
		if updated && !*flagDryRun {
			if err := updateReports(ctx, db, c.stockCode, c.reports); err != nil {
				log.Printf("  ERROR updating DB for %s: %v", c.stockCode, err)
				totalErrors++
			}
		}
	}

done:
	log.Printf("Done! Reports found: %d, Synced: %d, Skipped: %d, Errors: %d",
		totalReports, totalSynced, totalSkipped, totalErrors)
}

type companyReports struct {
	stockCode string
	reports   []FinancialReport
}

func getCompaniesWithUnsyncedReports(ctx context.Context, db *pgxpool.Pool) ([]companyReports, error) {
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

	// Prioritize top-shorted stocks first
	query := fmt.Sprintf(`
		WITH latest AS (SELECT MAX("DATE") AS max_date FROM shorts)
		SELECT cm.stock_code,
			COALESCE(cm.financial_reports::text, '[]') as financial_reports
		FROM "company-metadata" cm
		LEFT JOIN latest l ON true
		LEFT JOIN shorts s ON s."PRODUCT_CODE" = cm.stock_code AND s."DATE" = l.max_date
		WHERE cm.stock_code IS NOT NULL AND cm.stock_code != ''
			AND cm.financial_reports IS NOT NULL
			AND cm.financial_reports::text != '[]'
			AND cm.financial_reports::text != 'null'
			%s
		ORDER BY COALESCE(s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", 0) DESC
	`, whereClause)

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var companies []companyReports
	for rows.Next() {
		var c companyReports
		var reportsJSON string
		if err := rows.Scan(&c.stockCode, &reportsJSON); err != nil {
			continue
		}
		if err := json.Unmarshal([]byte(reportsJSON), &c.reports); err != nil {
			continue
		}
		// Only include companies that have at least one unsynced report
		if len(getUnsyncedReports(c.reports)) > 0 {
			companies = append(companies, c)
		}
	}
	return companies, rows.Err()
}

func getUnsyncedReports(reports []FinancialReport) []FinancialReport {
	var unsynced []FinancialReport
	for _, r := range reports {
		if r.GcsURL == "" && r.URL != "" {
			unsynced = append(unsynced, r)
		}
	}
	return unsynced
}

// buildObjectPath generates the GCS object path for a report.
// Pattern: reports/{STOCK_CODE}/{REPORT_TYPE}_{DATE}_{url_hash_8chars}.pdf
func buildObjectPath(stockCode string, r *FinancialReport) string {
	// Hash the URL for uniqueness
	h := sha256.Sum256([]byte(r.URL))
	urlHash := fmt.Sprintf("%x", h[:4]) // 8 hex chars

	reportType := r.Type
	if reportType == "" {
		reportType = "financial_report"
	}

	date := r.Date
	if date == "" {
		date = "unknown"
	}

	return fmt.Sprintf("reports/%s/%s_%s_%s.pdf", stockCode, reportType, date, urlHash)
}

// downloadPDF downloads a PDF from the given URL, resolving ASX displayAnnouncement URLs.
func downloadPDF(ctx context.Context, client *http.Client, pdfURL string) ([]byte, error) {
	// Resolve ASX displayAnnouncement URLs
	if strings.Contains(pdfURL, "displayAnnouncement.do") {
		resolved, err := resolveASXPDFURL(ctx, client, pdfURL)
		if err != nil {
			return nil, fmt.Errorf("resolve ASX URL: %w", err)
		}
		pdfURL = resolved
	}

	req, err := http.NewRequestWithContext(ctx, "GET", pdfURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/pdf,*/*")
	req.Header.Set("Referer", "https://www.asx.com.au/")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, pdfURL)
	}

	// Limit to 50MB to prevent memory issues
	data, err := io.ReadAll(io.LimitReader(resp.Body, 50*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	return data, nil
}

// resolveASXPDFURL resolves an ASX displayAnnouncement URL to the actual PDF URL.
// These URLs show a disclaimer page with a hidden form field containing the real PDF URL.
func resolveASXPDFURL(ctx context.Context, client *http.Client, displayURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", displayURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Referer", "https://www.asx.com.au/")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("HTTP request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1*1024*1024))
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}

	// Check if it's already a PDF (some URLs resolve directly)
	if len(body) >= 5 && string(body[:5]) == "%PDF-" {
		return displayURL, nil
	}

	// Extract the real PDF URL from the hidden form field
	match := asxPDFURLRegex.FindSubmatch(body)
	if match == nil {
		return "", fmt.Errorf("no pdfURL field found in displayAnnouncement page")
	}

	return string(match[1]), nil
}

func newGCSClient(ctx context.Context) (*storage.Client, error) {
	var opts []option.ClientOption

	if os.Getenv("STORAGE_EMULATOR_HOST") == "" {
		if credsPath := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); credsPath != "" {
			absPath, err := filepath.Abs(credsPath)
			if err != nil {
				return nil, fmt.Errorf("resolve credentials path: %w", err)
			}
			if _, err := os.Stat(absPath); os.IsNotExist(err) {
				return nil, fmt.Errorf("credentials file not found: %s", absPath)
			}
			opts = append(opts, option.WithCredentialsFile(absPath))
		}
	} else {
		opts = append(opts, option.WithoutAuthentication())
	}

	return storage.NewClient(ctx, opts...)
}

func uploadToGCS(ctx context.Context, client *storage.Client, bucketName, objectPath string, data []byte) error {
	bucket := client.Bucket(bucketName)
	obj := bucket.Object(objectPath)

	w := obj.NewWriter(ctx)
	w.ContentType = "application/pdf"
	w.CacheControl = "public, max-age=604800" // 7 days — PDFs are immutable

	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close writer: %w", err)
	}

	return nil
}

// updateReports uses a transaction with row-level locking to safely read-merge-write.
// It reads the current DB state, applies GCS URL updates by matching on report URL, and writes back.
func updateReports(ctx context.Context, db *pgxpool.Pool, stockCode string, reports []FinancialReport) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentJSON string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(financial_reports::text, '[]') FROM "company-metadata" WHERE stock_code = $1 FOR UPDATE`,
		stockCode,
	).Scan(&currentJSON)
	if err != nil {
		return fmt.Errorf("fetch current: %w", err)
	}

	var current []FinancialReport
	if err := json.Unmarshal([]byte(currentJSON), &current); err != nil {
		current = nil
	}

	// Build a map of URL → GCS URL from our in-memory state
	gcsURLs := make(map[string]string)
	for _, r := range reports {
		if r.GcsURL != "" {
			gcsURLs[strings.ToLower(r.URL)] = r.GcsURL
		}
	}

	// Apply GCS URLs to the current DB state
	for i := range current {
		if current[i].GcsURL == "" {
			if gcsURL, ok := gcsURLs[strings.ToLower(current[i].URL)]; ok {
				current[i].GcsURL = gcsURL
			}
		}
	}

	jsonBytes, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	_, err = tx.Exec(ctx,
		`UPDATE "company-metadata" SET financial_reports = $1::jsonb WHERE stock_code = $2`,
		string(jsonBytes), stockCode,
	)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}

	return tx.Commit(ctx)
}
