// Package announcements is the `shorted announcements` job, migrated from
// services/asx-announcement-crawler (docs/jobs-consolidation-plan.md Phase 2).
// Every flag and every write path — including the pre-filter + batched-INSERT
// work in dedupe.go/news_writer.go — is carried over unchanged.
//
// It crawls the public ASX announcements pages for each stock code, then fans
// the results into: company-metadata.financial_reports (JSONB merge),
// asx_announcements, news_articles, director_trades and dividend_history,
// each gated behind its own flag.
package announcements

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/skunkworq/stealth/brws/engine"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"golang.org/x/sync/errgroup"
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
	Date        string
	IsPriceSens bool
	Headline    string
	PDFURL      string
	Pages       string
	FileSize    string
}

// config is the parsed flag set. The standalone binary kept these in
// package-level flag vars; inside a shared binary those would leak across
// subcommands, so they are threaded explicitly instead (see README conventions).
type config struct {
	dryRun           bool
	codes            string
	years            string
	limit            int
	delay            time.Duration
	verbose          bool
	allAnnouncements bool
	newsTable        bool
	directorTrades   bool
	dividends        bool
	workers          int
}

// crawlStats holds the cross-worker tallies. All fields are int64 and updated
// only via sync/atomic so the worker pool can share one instance safely.
// (int64 fields are kept first so they stay 8-byte aligned for atomic ops.)
type crawlStats struct {
	processed      int64
	reports        int64
	reportsUpdated int64
	errors         int64
	announcements  int64
	annScanned     int64
	annSkipped     int64
	annStored      int64
	newsScanned    int64
	newsSkipped    int64
	newsStored     int64
	dirTrades      int64
	dividends      int64
}

// record folds a per-stock store result into the shared cross-worker tallies.
func (s *crawlStats) record(scanned, skipped, inserted *int64, c storeCounts) {
	atomic.AddInt64(scanned, int64(c.scanned))
	atomic.AddInt64(skipped, int64(c.skipped))
	atomic.AddInt64(inserted, int64(c.inserted))
}

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

// Job returns the `shorted announcements` subcommand. It honours -dry-run (the
// crawl still runs; nothing is written).
func Job() runner.Job {
	return runner.Func{
		JobName: "announcements",
		Desc:    "crawl ASX announcements into financial_reports, asx_announcements, news, director trades and dividends",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the announcement crawler. Flags are identical to the standalone
// services/asx-announcement-crawler binary; -dry-run and -verbose default to the
// global flags so `shorted -dry-run announcements` works.
//
// The original tool called log.Fatal* at every setup failure. Inside a shared
// binary that would skip deferred cleanup (pool close, stealth client close,
// OTel flush) and bypass the runner's end-of-job logging, so every failure path
// returns an error with the same message text instead.
func Run(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("announcements", flag.ContinueOnError)
	cfg := config{}
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Parse and display results without updating the database")
	fs.StringVar(&cfg.codes, "codes", "", "Comma-separated stock codes to crawl (default: all from company-metadata)")
	fs.StringVar(&cfg.years, "years", "2024,2025", "Comma-separated years to crawl")
	fs.IntVar(&cfg.limit, "limit", 0, "Limit number of stocks to process (0 = all)")
	fs.DurationVar(&cfg.delay, "delay", 1500*time.Millisecond, "Delay between requests")
	fs.BoolVar(&cfg.verbose, "verbose", globals.Verbose, "Verbose output")
	fs.BoolVar(&cfg.allAnnouncements, "all-announcements", false, "Store all announcements to asx_announcements table (not just financial reports)")
	fs.BoolVar(&cfg.newsTable, "news-table", false, "Also write announcements into news_articles table")
	fs.BoolVar(&cfg.directorTrades, "director-trades", false, "Extract director trades from Appendix 3Y announcements into director_trades table")
	fs.BoolVar(&cfg.dividends, "dividends", false, "Extract dividend announcements into dividend_history table")
	fs.IntVar(&cfg.workers, "workers", 6, "Number of concurrent crawl workers (network-bound; keep modest to respect ASX rate limits)")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "asx-announcement-crawler")
	if otelErr != nil {
		log.Printf("WARNING: Failed to initialize OpenTelemetry: %v", otelErr)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("Error shutting down OpenTelemetry: %v", err)
			}
		}()
	}

	// Size the pool to cover the worker fan-out (each worker does several short
	// INSERT/UPDATEs per stock); otherwise a 3-conn pool serializes DB writes and
	// negates the parallelism. Safe against the Supabase transaction pooler.
	numWorkers := cfg.workers
	if numWorkers < 1 {
		numWorkers = 1
	}

	db, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(int32(numWorkers+2)))
	if err != nil {
		return err
	}
	defer db.Close()

	// Get stock codes to process
	codes, err := getStockCodes(ctx, db, cfg.codes)
	if err != nil {
		return fmt.Errorf("failed to get stock codes: %w", err)
	}

	if cfg.limit > 0 && len(codes) > cfg.limit {
		codes = codes[:cfg.limit]
	}

	log.Printf("Will crawl ASX announcements for %d stocks", len(codes))

	// Track sync metrics
	syncStart := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "asx-announcement-crawler"))

	// Parse years
	var years []string
	for _, y := range strings.Split(cfg.years, ",") {
		y = strings.TrimSpace(y)
		if y != "" {
			years = append(years, y)
		}
	}

	// Create stealth HTTP client with TLS fingerprinting
	client, stealthErr := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
	if stealthErr != nil {
		return fmt.Errorf("failed to create stealth client: %w", stealthErr)
	}
	defer func() { _ = client.Close() }()

	stats := &crawlStats{}
	crawlErr := crawlAll(ctx, db, client, cfg, numWorkers, codes, years, stats)

	// NOTE: "financial_reports updated" is legitimately near-zero on steady-state
	// runs (the JSONB merge is idempotent once a stock's report URLs are known).
	// The real work is the announcements/news/dir-trades/dividends written below.
	log.Printf("Done! Processed: %d, Reports found: %d (financial_reports updated: %d), Announcements: %d (stored: %d), News: %d, Director trades: %d, Dividends: %d, Errors: %d",
		atomic.LoadInt64(&stats.processed), atomic.LoadInt64(&stats.reports), atomic.LoadInt64(&stats.reportsUpdated),
		atomic.LoadInt64(&stats.announcements), atomic.LoadInt64(&stats.annStored), atomic.LoadInt64(&stats.newsStored),
		atomic.LoadInt64(&stats.dirTrades), atomic.LoadInt64(&stats.dividends), atomic.LoadInt64(&stats.errors))

	// Write-path efficiency: the crawl re-reads the full announcement history
	// every run, so "skipped" should dominate. If inserted ~= scanned on a
	// steady-state run, the pre-filter has stopped matching the DB keys.
	log.Printf("Write path — asx_announcements: scanned %d, skipped-existing %d, inserted %d | news_articles: scanned %d, skipped-existing %d, inserted %d",
		atomic.LoadInt64(&stats.annScanned), atomic.LoadInt64(&stats.annSkipped), atomic.LoadInt64(&stats.annStored),
		atomic.LoadInt64(&stats.newsScanned), atomic.LoadInt64(&stats.newsSkipped), atomic.LoadInt64(&stats.newsStored))

	if crawlErr != nil {
		return crawlErr
	}

	// Record sync metrics
	shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
	shortedotel.SyncRecordsProcessed.Add(ctx, atomic.LoadInt64(&stats.processed), syncAttrs)
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", "asx-announcement-crawler"),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
	return nil
}

// crawlAll processes the stock codes through a bounded worker pool. The crawl is
// network-bound (one ASX page fetch per year per stock), so a small pool cuts
// wall-clock ~Nx and keeps the job well inside its timeout instead of running
// sequentially for >4h. Each worker owns its own stealth client (the engine is
// not guaranteed concurrency-safe) and keeps the per-stock jittered delay, so
// the aggregate request rate stays ~workers/delay — modest enough for ASX.
//
// Per-stock failures are tallied, not returned: one unreachable code must not
// abandon the other ~4.5k. Only cancellation ends the run early, and it ends it
// for the feeder and every worker at once.
func crawlAll(ctx context.Context, db *pgxpool.Pool, shared *stealthhttp.Client, cfg config, numWorkers int, codes, years []string, stats *crawlStats) error {
	g, gctx := errgroup.WithContext(ctx)
	codesCh := make(chan string)
	var progress int64

	g.Go(func() error {
		defer close(codesCh)
		for _, code := range codes {
			select {
			case codesCh <- code:
			case <-gctx.Done():
				return gctx.Err()
			}
		}
		return nil
	})

	for w := 0; w < numWorkers; w++ {
		g.Go(func() error {
			wClient, werr := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
			if werr != nil {
				log.Printf("worker: failed to create stealth client, using shared: %v", werr)
				wClient = shared
			} else {
				defer func() { _ = wClient.Close() }()
			}
			for code := range codesCh {
				if err := crawlOne(gctx, db, wClient, cfg, code, years, codes, stats, &progress); err != nil {
					return err
				}
			}
			return nil
		})
	}

	return g.Wait()
}

// crawlOne handles a single stock code. It returns an error ONLY for
// cancellation; every other failure is logged and counted so the run continues.
func crawlOne(ctx context.Context, db *pgxpool.Pool, client *stealthhttp.Client, cfg config, code string, years, codes []string, stats *crawlStats, progress *int64) error {
	if n := atomic.AddInt64(progress, 1); n%50 == 0 {
		log.Printf("Progress: %d/%d stocks | ann stored: %d, news: %d, dir-trades: %d, dividends: %d, reports: %d, errors: %d",
			n, len(codes),
			atomic.LoadInt64(&stats.annStored), atomic.LoadInt64(&stats.newsStored),
			atomic.LoadInt64(&stats.dirTrades), atomic.LoadInt64(&stats.dividends),
			atomic.LoadInt64(&stats.reports), atomic.LoadInt64(&stats.errors))
	}

	reports, allAnns, err := crawlStockAnnouncementsFull(ctx, client, code, years, cfg.verbose)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if cfg.verbose {
			log.Printf("  ERROR %s: %v", code, err)
		}
		atomic.AddInt64(&stats.errors, 1)
		return nil
	}

	atomic.AddInt64(&stats.processed, 1)

	// Store all announcements to asx_announcements table
	if cfg.allAnnouncements && len(allAnns) > 0 {
		atomic.AddInt64(&stats.announcements, int64(len(allAnns)))
		if !cfg.dryRun {
			counts, err := storeAnnouncements(ctx, db, code, allAnns, cfg.verbose)
			if err != nil {
				log.Printf("  ERROR storing announcements for %s: %v", code, err)
			} else {
				stats.record(&stats.annScanned, &stats.annSkipped, &stats.annStored, counts)
			}
		} else if cfg.verbose {
			log.Printf("  %s: %d total announcements", code, len(allAnns))
		}
	}

	// Write announcements as news articles
	if cfg.newsTable && len(allAnns) > 0 && !cfg.dryRun {
		counts, err := storeAsNewsArticles(ctx, db, code, allAnns, cfg.verbose)
		if err != nil {
			log.Printf("  ERROR storing news for %s: %v", code, err)
		} else {
			stats.record(&stats.newsScanned, &stats.newsSkipped, &stats.newsStored, counts)
		}
	}

	// Extract director trades from Appendix 3Y announcements
	if cfg.directorTrades && !cfg.dryRun {
		var trades []*DirectorTradeRecord
		for _, ann := range allAnns {
			if isAppendix3Y(ann.Headline) {
				trade := parseDirectorTradeFromHeadline(ann, code)
				trades = append(trades, trade)
			}
		}
		if len(trades) > 0 {
			stored, err := storeDirectorTrades(ctx, db, trades, cfg.verbose)
			if err != nil {
				log.Printf("  ERROR storing director trades for %s: %v", code, err)
			} else {
				atomic.AddInt64(&stats.dirTrades, int64(stored))
			}
		}
	}

	// Extract dividend announcements
	if cfg.dividends && !cfg.dryRun {
		var dividends []*DividendParseResult
		for _, ann := range allAnns {
			if isDividendAnnouncement(ann.Headline) {
				div := parseDividendFromHeadline(ann, code)
				if div.AmountPerShare != nil {
					dividends = append(dividends, div)
				}
			}
		}
		if len(dividends) > 0 {
			stored, err := storeDividends(ctx, db, dividends, cfg.verbose)
			if err != nil {
				log.Printf("  ERROR storing dividends for %s: %v", code, err)
			} else {
				atomic.AddInt64(&stats.dividends, int64(stored))
			}
		}
	}

	if len(reports) == 0 {
		return politeDelay(ctx, cfg.delay)
	}

	atomic.AddInt64(&stats.reports, int64(len(reports)))

	if cfg.dryRun {
		log.Printf("  %s: found %d financial reports", code, len(reports))
		for _, r := range reports {
			log.Printf("    [%s] %s — %s", r.Date, r.Title, r.URL)
		}
		return politeDelay(ctx, cfg.delay)
	}

	// Merge with existing reports and update DB
	updated, err := mergeAndUpdateReports(ctx, db, code, reports, cfg.verbose)
	if err != nil {
		log.Printf("  ERROR updating %s: %v", code, err)
		atomic.AddInt64(&stats.errors, 1)
		return nil
	}
	if updated {
		atomic.AddInt64(&stats.reportsUpdated, 1)
	}

	return politeDelay(ctx, cfg.delay)
}

// politeDelay waits delay plus up to half of it as jitter, honouring
// cancellation (the standalone binary used a bare time.Sleep, which held
// SIGTERM for up to 2.25s per in-flight worker).
func politeDelay(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	jitter := time.Duration(rand.Int63n(int64(delay / 2)))
	timer := time.NewTimer(delay + jitter)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func getStockCodes(ctx context.Context, db *pgxpool.Pool, flagCodes string) ([]string, error) {
	if flagCodes != "" {
		var codes []string
		for _, c := range strings.Split(flagCodes, ",") {
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

// crawlStockAnnouncementsFull returns both financial reports and all announcements
func crawlStockAnnouncementsFull(ctx context.Context, client *stealthhttp.Client, code string, years []string, verbose bool) ([]FinancialReport, []ASXAnnouncement, error) {
	var allReports []FinancialReport
	var allAnnouncements []ASXAnnouncement

	for _, year := range years {
		announcements, err := fetchASXAnnouncements(ctx, client, code, year, verbose)
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

func fetchASXAnnouncements(ctx context.Context, client *stealthhttp.Client, code, year string, verbose bool) ([]ASXAnnouncement, error) {
	pageURL := fmt.Sprintf(
		"https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&timeframe=Y&year=%s&asxCode=%s",
		year, code,
	)

	// Use stealth engine with custom Referer header for ASX
	resp, err := client.Do(ctx, &engine.Request{
		Method: "GET",
		URL:    pageURL,
		ExtraHeaders: map[string]string{
			"Referer": "https://www.asx.com.au/",
		},
		FollowRedirects: true,
		MaxRedirects:    10,
	})
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}

	if resp.Status != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.Status)
	}

	announcements, err := parseAnnouncementRows(bytes.NewReader(resp.Body))
	if err != nil {
		return nil, err
	}

	if verbose && len(announcements) > 0 {
		log.Printf("  %s/%s: %d total announcements", code, year, len(announcements))
	}

	return announcements, nil
}

// parseAnnouncementRows parses the ASX announcements table.
//
// Split out of fetchASXAnnouncements so it can be tested against markup
// without a network call — it could not be before, which is why the
// price-sensitive bug below went unnoticed.
func parseAnnouncementRows(r io.Reader) ([]ASXAnnouncement, error) {
	doc, err := goquery.NewDocumentFromReader(r)
	if err != nil {
		return nil, fmt.Errorf("HTML parse failed: %w", err)
	}

	var announcements []ASXAnnouncement

	doc.Find("announcement_data table tbody tr").Each(func(i int, row *goquery.Selection) {
		tds := row.Find("td")
		if tds.Length() < 3 {
			return
		}

		// First td: date. ASX renders the time on a second line; it is dropped
		// here because announcement_date is a DATE column. That loses the
		// intraday timing an event study needs — whether an announcement
		// landed pre-open, intraday or post-close is most of its meaning — and
		// recovering it needs a column and a re-crawl, not just a parser
		// change. See issue #543.
		dateText := strings.TrimSpace(tds.Eq(0).Text())
		dateText = strings.Split(dateText, "\n")[0]
		dateText = strings.TrimSpace(dateText)
		parsedDate := parseASXDate(dateText)

		// Second td: the price-sensitivity marker.
		//
		// The class IS the signal. This used to additionally require the cell
		// to contain non-empty TEXT, which meant a marker rendered as an icon
		// — an <img> with no text node, the usual way a flag like this is
		// drawn — never registered. Every one of the 49,615 announcements held
		// locally has is_price_sensitive = false, which is what that bug looks
		// like from the outside.
		//
		// This flag is the single most valuable field on the record: it is a
		// price-sensitivity judgement the exchange itself made, which is far
		// stronger than any classifier we could run over a headline. Rows
		// already stored keep their false value until a re-crawl.
		isPriceSens := tds.Eq(1).HasClass("pricesens")

		// Third td: headline + PDF link
		headlineTd := tds.Eq(2)
		headline := ""
		pdfURL := ""
		pages := ""
		fileSize := ""

		link := headlineTd.Find("a").First()
		if link.Length() > 0 {
			headline = strings.TrimSpace(link.Contents().Not("span").Text())
			if headline == "" {
				headline = strings.TrimSpace(link.Text())
			}

			href, exists := link.Attr("href")
			if exists {
				if strings.HasPrefix(href, "/") {
					pdfURL = "https://www.asx.com.au" + href
				} else {
					pdfURL = href
				}
				pdfURL = strings.ReplaceAll(pdfURL, "&amp;", "&")
			}

			link.Find("span.page").Each(func(_ int, sel *goquery.Selection) {
				pages = strings.TrimSpace(sel.Text())
			})
			link.Find("span.filesize").Each(func(_ int, sel *goquery.Selection) {
				fileSize = strings.TrimSpace(sel.Text())
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
func mergeAndUpdateReports(ctx context.Context, db *pgxpool.Pool, code string, newReports []FinancialReport, verbose bool) (bool, error) {
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

	if verbose {
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

// fetchExistingAnnouncementKeys loads the (announcement_date, headline) keys
// already stored for a stock code, so the crawl's re-fetched history can be
// filtered client-side instead of firing one no-op INSERT per announcement.
// One indexed read per stock (idx_asx_ann_stock_date) replaces ~140 INSERTs.
func fetchExistingAnnouncementKeys(ctx context.Context, db *pgxpool.Pool, code string) (map[string]struct{}, error) {
	rows, err := db.Query(ctx,
		`SELECT announcement_date, headline FROM asx_announcements WHERE stock_code = $1`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	existing := make(map[string]struct{})
	for rows.Next() {
		var date time.Time
		var headline string
		if err := rows.Scan(&date, &headline); err != nil {
			continue
		}
		existing[announcementKey(date.Format("2006-01-02"), headline)] = struct{}{}
	}
	return existing, rows.Err()
}

// storeAnnouncements inserts announcements into the asx_announcements table.
// It pre-filters against what's already stored for the code and batches the
// remainder into multi-row parameterized INSERTs.
func storeAnnouncements(ctx context.Context, db *pgxpool.Pool, code string, announcements []ASXAnnouncement, verbose bool) (storeCounts, error) {
	counts := storeCounts{scanned: len(announcements)}

	existing, err := fetchExistingAnnouncementKeys(ctx, db, code)
	if err != nil {
		return counts, fmt.Errorf("fetch existing announcements: %w", err)
	}

	fresh := filterNewAnnouncements(announcements, existing)
	counts.skipped = counts.scanned - len(fresh)
	if len(fresh) == 0 {
		return counts, nil
	}

	for _, batch := range chunkAnnouncements(fresh, maxInsertRowsPerStatement) {
		query, args := buildAnnouncementInsert(code, batch)
		tag, err := db.Exec(ctx, query, args...)
		if err != nil {
			if verbose {
				log.Printf("    WARN: failed to insert %d announcements for %s: %v", len(batch), code, err)
			}
			continue
		}
		counts.inserted += int(tag.RowsAffected())
	}
	return counts, nil
}

// escapeSQLString escapes single quotes for safe SQL string literals
func escapeSQLString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
