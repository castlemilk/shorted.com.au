package reportextract

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"
)

// defaultReportModel is the --model default shared by both report subcommands.
const defaultReportModel = "gemini-2.5-flash"

// Gemini run-budget defaults, per script. These are the `default_max_items` /
// `default_max_workers` arguments each script passes to resolve_gemini_run_budget
// and are the LAST line of cost defence when a flag is too broad.
const (
	// extract.py: resolve_gemini_run_budget(limit, workers=1, 10, 1)
	sequentialDefaultMaxItems   = 10
	sequentialDefaultMaxWorkers = 1
	// extract_reports_concurrent.py: (limit, workers, 10, 2)
	concurrentDefaultMaxItems   = 10
	concurrentDefaultMaxWorkers = 2
	// extract_director_trades.py: (limit, workers, 20, 2)
	directorDefaultMaxItems   = 20
	directorDefaultMaxWorkers = 2
)

// progressEvery matches the Python progress-log cadences.
const (
	sequentialProgressEvery = 10
	concurrentProgressEvery = 50
)

// Group returns the `shorted report-extract` subcommand group.
//
// Two leaves, because the two Python report scripts disagree on flag DEFAULTS and
// folding them together would silently change one caller's behaviour:
//
//	concurrent  extract_reports_concurrent.py — the DEPLOYED financial-report-extractor
//	sequential  extract.py's main()           — the laptop CLI (--mode/--codes/--delay)
func Group() runner.Job {
	return runner.NewGroup("report-extract", "extract structured financials + digests from ASX report PDFs",
		runner.Func{
			JobName: "concurrent",
			Desc:    "concurrent report extraction / digest backfill (deployed: financial-report-extractor)",
			DryRun:  true,
			Fn:      RunConcurrent,
		},
		runner.Func{
			JobName: "sequential",
			Desc:    "sequential per-report extraction over a mode/codes selection (extract.py)",
			DryRun:  true,
			Fn:      RunSequential,
		},
	)
}

// DirectorTradesJob returns the `shorted director-trades` subcommand
// (extract_director_trades.py — the deployed director-trade-extractor).
func DirectorTradesJob() runner.Job {
	return runner.Func{
		JobName: "director-trades",
		Desc:    "extract director names/values from ASX Appendix 3Y PDFs into director_trades",
		DryRun:  true,
		Fn:      RunDirectorTrades,
	}
}

// --- shared pipeline wiring ------------------------------------------------

// pipeline is everything a report worker needs. Collaborators are interfaces so
// the pipeline is unit-testable with no network and no database.
type pipeline struct {
	fetch  pdfFetcher
	blobs  blobStore
	store  extractionStore
	summar summarizer
	// extractFn is langextract's entry point, injected so the pipeline can be
	// exercised without a Gemini key.
	extractFn func(ctx context.Context, text, stockCode, modelID string) []extraction
	model     string
	maxPages  int
	dryRun    bool
	verbose   bool
}

// --- `report-extract sequential` (extract.py main) --------------------------

type sequentialConfig struct {
	mode     string
	codes    string
	limit    int
	recent   int
	model    string
	delay    float64
	maxPages int
	dryRun   bool
	verbose  bool
}

// RunSequential is extract.py's main(): select reports, then process them one at
// a time with a fixed delay between PDF downloads.
func RunSequential(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("report-extract sequential", flag.ContinueOnError)
	cfg := sequentialConfig{}
	fs.StringVar(&cfg.mode, "mode", modeTop50, "Selection mode: "+modeTop50+" | "+modeCodes+" | "+modeAll)
	fs.StringVar(&cfg.codes, "codes", "", "Comma-separated stock codes (implies -mode codes)")
	fs.IntVar(&cfg.limit, "limit", 0, "Max total reports to process (0=unlimited)")
	fs.IntVar(&cfg.recent, "recent", 0, "Max reports per company (0=unlimited, e.g. 2=latest annual+half-year)")
	fs.StringVar(&cfg.model, "model", defaultReportModel, "LLM model ID")
	fs.Float64Var(&cfg.delay, "delay", 2.0, "Delay between PDF downloads (seconds)")
	fs.IntVar(&cfg.maxPages, "max-pages", 10, "Max PDF pages to extract text from")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Don't write to database or GCS")
	fs.BoolVar(&cfg.verbose, "verbose", globals.Verbose, "Log every extracted metric")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if cfg.mode != modeTop50 && cfg.mode != modeCodes && cfg.mode != modeAll {
		// argparse enforced the choices; flag does not.
		return fmt.Errorf("invalid -mode %q (want %s, %s or %s)", cfg.mode, modeTop50, modeCodes, modeAll)
	}

	originalLimit := cfg.limit
	limit, _, err := resolveGeminiRunBudget(cfg.limit, 1, sequentialDefaultMaxItems, sequentialDefaultMaxWorkers)
	if err != nil {
		return err
	}
	cfg.limit = limit
	if cfg.limit != originalLimit {
		log.Printf("Gemini run budget capped -limit from %d to %d", originalLimit, cfg.limit)
	}

	codes := splitCodes(cfg.codes)
	mode := cfg.mode
	if len(codes) > 0 {
		// extract.py: a non-empty --codes wins over --mode.
		mode = modeCodes
	}

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Schema is managed by migration 000045; extract.py's ensure_table() was
	// already commented out and is intentionally NOT ported.
	reports, err := getReportsToProcess(ctx, pool, mode, codes, cfg.limit, cfg.recent)
	if err != nil {
		return err
	}
	log.Printf("Found %d reports to process (mode=%s)", len(reports), mode)
	if len(reports) == 0 {
		log.Printf("Nothing to process")
		return nil
	}

	p, closeBlobs, err := newPipeline(ctx, pool, cfg.model, cfg.maxPages, cfg.dryRun, cfg.verbose)
	if err != nil {
		return err
	}
	defer closeBlobs()

	return runSequential(ctx, p, reports, time.Duration(cfg.delay*float64(time.Second)))
}

// runSequential is the per-report loop, extracted so the delay/progress/tally
// behaviour is testable without a database.
func runSequential(ctx context.Context, p *pipeline, reports []report, delay time.Duration) error {
	var totalProcessed, totalExtracted, totalErrors int

	for i, r := range reports {
		if i > 0 {
			// Python's time.sleep(delay); ctx-aware so SIGTERM lands promptly.
			if err := sleepCtx(ctx, delay); err != nil {
				return fmt.Errorf("report extraction interrupted: %w", err)
			}
		}
		if i > 0 && i%sequentialProgressEvery == 0 {
			log.Printf("Progress: %d/%d processed, %d extracted, %d errors", i, len(reports), totalExtracted, totalErrors)
		}
		log.Printf("[%d/%d] %s: %s (%s)", i+1, len(reports), r.StockCode, truncateRunes(r.Title, 60), r.Type)

		processed, extracted, err := p.processSequential(ctx, r)
		if err != nil {
			return err
		}
		switch {
		case !processed:
			totalErrors++
		default:
			totalProcessed++
			if extracted {
				totalExtracted++
			}
		}
	}

	log.Printf("Done! Processed: %d, Extracted: %d, Errors: %d", totalProcessed, totalExtracted, totalErrors)
	return nil
}

// processSequential runs one report through the pipeline, returning whether it
// counted as processed and whether it counted as extracted (extract.py's
// per-report accounting: a report with metrics counts as extracted, a
// digest-only report counts as extracted ONLY if a digest came back, and a
// failed PDF counts as an error).
func (p *pipeline) processSequential(ctx context.Context, r report) (processed, extracted bool, err error) {
	text := p.fetch.downloadPDFText(ctx, r.URL, p.maxPages)
	if text == "" {
		return false, false, nil
	}
	textLen := runeLen(text)
	log.Printf("  Extracted %d chars of text", textLen)

	extractions := p.extractFn(ctx, text, r.StockCode, p.model)
	if len(extractions) == 0 {
		log.Printf("  No structured metrics found")
		// §6.3(b) Decouple the digest from metric extraction: still summarise
		// from raw text (most results presentations state numbers in prose).
		var digest digestResult
		if textLen >= minDigestChars {
			log.Printf("  Generating digest from raw text (no metrics)...")
			digest = p.summar.Summarize(ctx, map[string]any{}, text, p.model)
			if digest.Digest != "" {
				log.Printf("  Digest (confidence=%.2f): %.120s", digest.Confidence, digest.Digest)
				extracted = true
			}
		}
		gcsURL := p.blobs.UploadRawText(ctx, r.StockCode, r.URL, text)
		if err := p.store.StoreExtraction(ctx, r, map[string]any{}, textLen, digest, gcsURL); err != nil {
			return false, false, err
		}
		return true, extracted, nil
	}

	metrics := extractionsToMetrics(extractions)
	log.Printf("  Found %d metric types: %s", len(metrics), strings.Join(metricKeys(metrics), ", "))
	if p.verbose {
		logMetricSources(metrics)
	}

	log.Printf("  Generating digest...")
	digest := p.summar.Summarize(ctx, metrics, text, p.model)
	if digest.Digest != "" {
		log.Printf("  Digest (confidence=%.2f): %.120s", digest.Confidence, digest.Digest)
	}

	gcsURL := p.blobs.UploadRawText(ctx, r.StockCode, r.URL, text)
	if err := p.store.StoreExtraction(ctx, r, metrics, textLen, digest, gcsURL); err != nil {
		return false, false, err
	}
	return true, true, nil
}

// --- `report-extract concurrent` (extract_reports_concurrent.py) -------------

type concurrentConfig struct {
	recent          int
	limit           int
	workers         int
	model           string
	maxPages        int
	topShortedFirst bool
	backfillDigests bool
	dryRun          bool
}

// Concurrent-run outcomes. These are the tally keys the Python job logged.
const (
	outcomeNoMetrics  = "no_metrics"
	outcomeDigestOnly = "digest_only"
	outcomeNoText     = "no_text"
	outcomeNoDigest   = "no_digest"
	outcomeOKGCS      = "ok_gcs"
	outcomeOKPDF      = "ok_pdf"
)

// RunConcurrent is extract_reports_concurrent.py's main().
func RunConcurrent(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("report-extract concurrent", flag.ContinueOnError)
	cfg := concurrentConfig{}
	fs.IntVar(&cfg.recent, "recent", 2, "Latest N reports per company")
	fs.IntVar(&cfg.limit, "limit", 0, "Cap total reports (0=all)")
	fs.IntVar(&cfg.workers, "workers", 8, "Concurrent report workers")
	fs.StringVar(&cfg.model, "model", defaultReportModel, "LLM model ID")
	fs.IntVar(&cfg.maxPages, "max-pages", 10, "Max PDF pages to extract text from")
	fs.BoolVar(&cfg.topShortedFirst, "top-shorted-first", false, "Order the selection by mv_top_shorts.current_percent")
	fs.BoolVar(&cfg.backfillDigests, "backfill-digests", false, "Re-summarise existing rows with digest IS NULL (uses stored GCS text)")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Don't write to database or GCS")
	if err := parseFlags(fs, args); err != nil {
		return err
	}

	originalLimit, originalWorkers := cfg.limit, cfg.workers
	limit, workers, err := resolveGeminiRunBudget(cfg.limit, cfg.workers, concurrentDefaultMaxItems, concurrentDefaultMaxWorkers)
	if err != nil {
		return err
	}
	cfg.limit, cfg.workers = limit, workers
	if cfg.limit != originalLimit || cfg.workers != originalWorkers {
		log.Printf("Gemini run budget capped -limit/-workers from %d/%d to %d/%d",
			originalLimit, originalWorkers, cfg.limit, cfg.workers)
	}

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	p, closeBlobs, err := newPipeline(ctx, pool, cfg.model, cfg.maxPages, cfg.dryRun, false)
	if err != nil {
		return err
	}
	defer closeBlobs()

	var (
		reports []report
		work    func(context.Context, report) string
	)
	if cfg.backfillDigests {
		reports, err = selectDigestlessReports(ctx, pool, cfg.limit, cfg.topShortedFirst)
		if err != nil {
			return err
		}
		work = p.processDigestless
		log.Printf("Digest backfill: %d rows with no digest (workers=%d)", len(reports), cfg.workers)
	} else {
		reports, err = selectReports(ctx, pool, cfg.recent, cfg.limit, cfg.topShortedFirst)
		if err != nil {
			return err
		}
		work = p.processConcurrent
		log.Printf("Report backfill: %d reports to process (recent=%d, workers=%d)", len(reports), cfg.recent, cfg.workers)
	}

	if cfg.dryRun {
		for i, r := range reports {
			if i >= 10 {
				break
			}
			log.Printf("  [dry-run] %s %s (%s) %s", r.StockCode, truncateRunes(r.Title, 50), r.Type, r.Date)
		}
	}

	return runWorkers(ctx, cfg.workers, len(reports), func(g *errgroup.Group, gctx context.Context, counts *tally) error {
		for _, r := range reports {
			if err := gctx.Err(); err != nil {
				return err
			}
			g.Go(func() error {
				if err := gctx.Err(); err != nil {
					return err
				}
				counts.record(work(gctx, r))
				return nil
			})
		}
		return nil
	})
}

// selectReports picks the latest `recent` key financial reports per company,
// deduped against what has already been extracted (select_reports).
func selectReports(ctx context.Context, pool *pgxpool.Pool, recent, limit int, topShortedFirst bool) ([]report, error) {
	// NOTE the limit=0 here: the per-company cap is applied first, the top-shorted
	// ordering second, and only THEN is the total capped — so `-limit` selects the
	// most-shorted N, not the first N alphabetically.
	reports, err := getReportsToProcess(ctx, pool, modeAll, nil, 0, recent)
	if err != nil {
		return nil, err
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

// processConcurrent is the thread-pool worker (`process`). It returns the tally
// key rather than an error: a per-report failure must not abort the batch.
func (p *pipeline) processConcurrent(ctx context.Context, r report) string {
	text := p.fetch.downloadPDFText(ctx, r.URL, p.maxPages)
	if text == "" {
		return outcomeNoPDF
	}
	textLen := runeLen(text)
	extractions := p.extractFn(ctx, text, r.StockCode, p.model)
	// GCS upload is best-effort; never fail the report on it.
	gcsURL := p.blobs.UploadRawText(ctx, r.StockCode, r.URL, text)

	if len(extractions) == 0 {
		var digest digestResult
		if textLen >= minDigestChars {
			digest = p.summar.Summarize(ctx, map[string]any{}, text, p.model)
		}
		if err := p.store.StoreExtraction(ctx, r, map[string]any{}, textLen, digest, gcsURL); err != nil {
			log.Printf("  worker error: %v", err)
			return outcomeError
		}
		if digest.Digest != "" {
			return outcomeDigestOnly
		}
		return outcomeNoMetrics
	}

	metrics := extractionsToMetrics(extractions)
	digest := p.summar.Summarize(ctx, metrics, text, p.model)
	if err := p.store.StoreExtraction(ctx, r, metrics, textLen, digest, gcsURL); err != nil {
		log.Printf("  worker error: %v", err)
		return outcomeError
	}
	return outcomeOK
}

// processDigestless re-summarises one already-extracted row that has no digest
// (`process_digestless`). It PREFERS the stored GCS text and only re-downloads
// the PDF when the text isn't there — older 2024 ASX URLs no longer resolve.
func (p *pipeline) processDigestless(ctx context.Context, r report) string {
	gcsURL := r.RawTextGCSURL
	text := ""
	if gcsURL != "" {
		text = p.blobs.DownloadText(ctx, gcsURL)
	}
	source := "gcs"
	if text == "" {
		text = p.fetch.downloadPDFText(ctx, r.URL, p.maxPages)
		source = "pdf"
		// Backfill the GCS pointer if we had to re-download.
		if text != "" && gcsURL == "" {
			gcsURL = p.blobs.UploadRawText(ctx, r.StockCode, r.URL, text)
		}
	}
	textLen := runeLen(text)
	if text == "" || textLen < minDigestChars {
		return outcomeNoText
	}

	metrics := map[string]any{}
	if r.Metrics != "" {
		if err := json.Unmarshal([]byte(r.Metrics), &metrics); err != nil {
			// Python's `except (ValueError, TypeError): metrics = {}`.
			metrics = map[string]any{}
		}
	}

	digest := p.summar.Summarize(ctx, metrics, text, p.model)
	if digest.Digest == "" {
		return outcomeNoDigest
	}
	if err := p.store.StoreExtraction(ctx, r, metrics, textLen, digest, gcsURL); err != nil {
		log.Printf("  worker error: %v", err)
		return outcomeError
	}
	if source == "gcs" {
		return outcomeOKGCS
	}
	return outcomeOKPDF
}

// --- `director-trades` (extract_director_trades.py) -------------------------

type directorConfig struct {
	limit          int
	priority       string
	workers        int
	retryAfterDays int
	dryRun         bool
}

// RunDirectorTrades is extract_director_trades.py's main().
func RunDirectorTrades(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("director-trades", flag.ContinueOnError)
	cfg := directorConfig{}
	fs.IntVar(&cfg.limit, "limit", 200, "Max announcements to process")
	fs.StringVar(&cfg.priority, "priority", priorityRecent, "Selection order: "+priorityRecent+" | "+priorityUnknown+" | "+priorityTopShorted)
	fs.IntVar(&cfg.workers, "workers", 6, "Concurrent extraction workers")
	fs.IntVar(&cfg.retryAfterDays, "retry-after-days", 30, "§6.9 skip URLs attempted within this many days (0=disable, retry everything)")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun, "Extract and log, but write nothing")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if cfg.priority != priorityRecent && cfg.priority != priorityUnknown && cfg.priority != priorityTopShorted {
		return fmt.Errorf("invalid -priority %q (want %s, %s or %s)", cfg.priority, priorityRecent, priorityUnknown, priorityTopShorted)
	}

	originalLimit, originalWorkers := cfg.limit, cfg.workers
	limit, workers, err := resolveGeminiRunBudget(cfg.limit, cfg.workers, directorDefaultMaxItems, directorDefaultMaxWorkers)
	if err != nil {
		return err
	}
	cfg.limit, cfg.workers = limit, workers
	if cfg.limit != originalLimit || cfg.workers != originalWorkers {
		log.Printf("Gemini run budget capped -limit/-workers from %d/%d to %d/%d",
			originalLimit, originalWorkers, cfg.limit, cfg.workers)
	}

	apiKey := digestAPIKey()
	if apiKey == "" {
		// Python exited here (sys.exit(1)) on the first worker's first call.
		return errors.New("GEMINI_API_KEY (or LANGEXTRACT_API_KEY) required")
	}

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	store := &directorStore{pool: pool}
	attemptsExist, err := store.AttemptsTableExists(ctx)
	if err != nil {
		return err
	}
	withSkip := cfg.retryAfterDays > 0 && attemptsExist
	recordAttempts := withSkip
	if cfg.retryAfterDays > 0 && !recordAttempts {
		log.Printf("director_extract_attempts table missing (apply migration 000069) — failure-budget disabled this run")
	}

	rows, err := store.SelectURLs(ctx, cfg.priority, cfg.limit, cfg.retryAfterDays, withSkip)
	if err != nil {
		return err
	}
	log.Printf("Director-trade extraction: %d PDFs to process (priority=%s, retry_after_days=%d)",
		len(rows), cfg.priority, cfg.retryAfterDays)

	d := &directorPipeline{
		fetch:          newFetcher(),
		extractor:      geminiDirectorExtractor{apiKey: apiKey},
		store:          store,
		dryRun:         cfg.dryRun,
		recordAttempts: recordAttempts,
	}

	return runWorkers(ctx, cfg.workers, len(rows), func(g *errgroup.Group, gctx context.Context, counts *tally) error {
		for _, row := range rows {
			if err := gctx.Err(); err != nil {
				return err
			}
			g.Go(func() error {
				if err := gctx.Err(); err != nil {
					return err
				}
				counts.record(d.processOne(gctx, row))
				return nil
			})
		}
		return nil
	})
}

// directorPipeline is the director-trade worker's collaborators.
type directorPipeline struct {
	fetch          pdfFetcher
	extractor      directorExtractor
	store          *directorStore
	dryRun         bool
	recordAttempts bool
}

// processOne extracts and writes one announcement, then records the §6.9 attempt
// marker so persistent failures are skipped next run.
func (d *directorPipeline) processOne(ctx context.Context, row directorRow) string {
	outcome := d.processOneInner(ctx, row)
	if d.recordAttempts && !d.dryRun {
		d.store.RecordAttempt(ctx, row.AnnouncementURL, outcome)
	}
	return outcome
}

func (d *directorPipeline) processOneInner(ctx context.Context, row directorRow) string {
	url := row.AnnouncementURL
	text := d.fetch.downloadPDFText(ctx, url, directorMaxPages)
	if text == "" {
		return outcomeNoPDF
	}
	parsed := d.extractor.Extract3Y(ctx, text)
	if len(parsed) == 0 {
		return outcomeNoExtr
	}
	trade := deriveTrade(parsed)
	if trade == nil {
		return outcomeLowConf
	}
	if d.dryRun {
		log.Printf("  [dry-run] %s -> %s %s shares=%d $%s conf=%.2f",
			lastRunes(url, 40), trade.DirectorName, trade.TradeType, trade.SharesTraded,
			formatFloatPtr(trade.TotalValue), trade.Confidence)
		return outcomeOK
	}
	if err := d.store.UpdateTrade(ctx, url, trade); err != nil {
		log.Printf("  worker error: %v", err)
		return outcomeError
	}
	return outcomeOK
}

// --- shared helpers ---------------------------------------------------------

// newPipeline wires the live collaborators, honouring the dry-run gate on both
// the database and GCS.
func newPipeline(ctx context.Context, pool *pgxpool.Pool, model string, maxPages int, dryRun, verbose bool) (*pipeline, func(), error) {
	gcs, err := newGCSStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	var blobs blobStore = gcs
	if dryRun {
		// The read path stays live so a dry run still exercises the backfill.
		blobs = noopBlobStore{inner: gcs}
	}
	p := &pipeline{
		fetch:     newFetcher(),
		blobs:     blobs,
		store:     &pgExtractionStore{pool: pool, dryRun: dryRun},
		summar:    geminiSummarizer{},
		extractFn: extractFinancialData,
		model:     model,
		maxPages:  maxPages,
		dryRun:    dryRun,
		verbose:   verbose,
	}
	return p, gcs.Close, nil
}

// tally accumulates the per-outcome counters across workers.
type tally struct {
	mu     sync.Mutex
	counts map[string]int
	done   int
	total  int
}

func newTally(total int) *tally {
	return &tally{counts: map[string]int{}, total: total}
}

func (t *tally) record(outcome string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.counts[outcome]++
	t.done++
	if t.done%concurrentProgressEvery == 0 {
		log.Printf("  progress %d/%d  %s", t.done, t.total, formatCounts(t.counts))
	}
}

func (t *tally) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return formatCounts(t.counts)
}

// formatCounts renders the tally the way Python's `%s` on a dict did, with keys
// sorted so the line is stable across runs (Python's insertion order was not).
func formatCounts(counts map[string]int) string {
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, counts[k]))
	}
	return "{" + strings.Join(parts, " ") + "}"
}

// runWorkers runs `queue` under an errgroup limited to `workers`, logs the final
// tally, and reports cancellation as an error.
//
// Python's ThreadPoolExecutor swallowed every worker exception into an "error"
// tally entry and always exited 0. Here a per-item failure is still just a tally
// entry (the workers return nil), but a CANCELLED run — SIGTERM, or the Cloud Run
// task timeout — returns an error so a half-finished sweep is not reported as a
// clean run. Selection is idempotent (already-extracted URLs and the §6.9
// cool-off both skip), so the next run resumes.
func runWorkers(ctx context.Context, workers, total int, queue func(*errgroup.Group, context.Context, *tally) error) error {
	counts := newTally(total)

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(workers)
	queueErr := queue(g, gctx, counts)
	err := g.Wait()
	if err == nil {
		err = queueErr
	}

	log.Printf("DONE: %s", counts)
	if err != nil {
		return fmt.Errorf("extraction run interrupted: %w", err)
	}
	return nil
}

// parseFlags applies the shared flag-parsing contract: -h yields ErrUsage, and a
// stray positional argument is rejected rather than silently ignored.
func parseFlags(fs *flag.FlagSet, args []string) error {
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return nil
}

// splitCodes is extract.py's `[c.strip().upper() for c in codes.split(",") if c.strip()]`.
func splitCodes(codes string) []string {
	if codes == "" {
		return nil
	}
	var out []string
	for _, c := range strings.Split(codes, ",") {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, strings.ToUpper(c))
		}
	}
	return out
}

// metricKeys returns the metric class names, sorted (Python logged them in
// insertion order; sorted keeps the line stable and is log-only).
func metricKeys(metrics map[string]any) []string {
	keys := make([]string, 0, len(metrics))
	for k := range metrics {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// logMetricSources is the -verbose per-metric dump.
func logMetricSources(metrics map[string]any) {
	for _, cls := range metricKeys(metrics) {
		switch v := metrics[cls].(type) {
		case []any:
			for _, item := range v {
				log.Printf("    %s: %s", cls, truncateRunes(sourceText(item), 80))
			}
		default:
			log.Printf("    %s: %s", cls, truncateRunes(sourceText(v), 80))
		}
	}
}

func sourceText(entry any) string {
	m, ok := entry.(map[string]any)
	if !ok {
		return ""
	}
	s, _ := m["source_text"].(string)
	return s
}

// lastRunes returns the trailing n code points (Python's `url[-40:]`).
func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// formatFloatPtr renders a nullable float the way Python's "%s" rendered
// None / a float.
func formatFloatPtr(f *float64) string {
	if f == nil {
		return "None"
	}
	return fmt.Sprintf("%g", *f)
}

// sleepCtx waits for d, or returns early when the context is cancelled — a batch
// job must not sit in an uninterruptible sleep after SIGTERM.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
