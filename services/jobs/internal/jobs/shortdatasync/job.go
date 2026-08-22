// Package shortdatasync is the `shorted short-data-sync` job — the ASIC
// short-position pipeline that the `shorts-data-sync` Cloud Run Job runs
// (docs/jobs-consolidation-plan.md Phase 3, item 9). It began as the Python→Go
// port of services/daily-sync/deprecated/comprehensive_daily_sync.py; that tree
// (and its never-deployed sibling services/short-data-sync) was deleted in the
// cleanup slice, so parity notes below are provenance, not a live comparison.
//
// It owns the ASIC pipeline end to end:
//
//	ASIC index JSON → per-day CSV download → parse → upsert into "shorts"
//	→ data-health report → refresh_all_materialized_views()
//	→ frontend revalidation ping → optional Algolia trigger
//	→ one sync_status row for the admin jobs dashboard.
//
//	-days N          how far back to look when the shorts table is empty (SYNC_DAYS_SHORTS)
//	-batch-size N    recorded into sync_status.checkpoint_batch_size (SYNC_BATCH_SIZE)
//	-sync-algolia    trigger the Algolia index sync after a successful run (SYNC_ALGOLIA)
//	-dry-run         run the whole pipeline, write NOTHING
//	-shadow          -dry-run plus a machine-readable JSON summary on stdout
//
// Every flag defaults from the env var in parentheses, so the deployed
// env-only contract keeps working untouched and a flag wins when both are set
// (the `shorted news` RUN_MODE → -run-mode convention).
//
// # Reuse decision: prices and key metrics are NOT here
//
// The Python script did three unrelated things in one process: the ASIC shorts
// ingest, a yfinance/Alpha-Vantage stock_prices sweep (checkpointed in batches
// of 500, which is why the job had an 8h timeout, 5 retries and an exit-code-2
// "partial" protocol), and a yfinance key-metrics refresh of
// "company-metadata".key_metrics.
//
// The price sweep is ALREADY ported: `shorted market-data serve|sync` (Phase 2c)
// owns stock_prices, with the same Yahoo-then-Alpha provider chain, its own
// gap detector, failure tracker and checkpoint store. Porting it a second time
// here would put two schedules on one table with two different resume
// protocols. So this job is deliberately shorts-only, which also retires the
// batch/retry machinery: with no per-stock loop there is no partial state, so
// the run either completes (exit 0) or fails (exit 1) — the exit-2 retry
// protocol is gone.
//
// The key-metrics refresh is NOT ported here either (it is a yfinance scrape
// of company metadata, not the ASIC pipeline) — and it does not need to be:
// the shorts API's SyncKeyMetrics RPC already refreshes it on its own daily
// key-metrics-scheduler (enabled in prod). The Python job was a duplicate
// second writer; the cutover PR only confirms that scheduler is healthy.
//
// # Preserved landmines
//
//   - The MV refresh sends `SET statement_timeout = 0` and
//     refresh_all_materialized_views() as ONE simple-protocol command, so the
//     disarm provably applies to the refresh even through the transaction
//     pooler (see store.go).
//   - sync_status resume keys on CLOUD_RUN_EXECUTION, never the calendar date
//     (PR #231; see recorder.go).
//   - The revalidation ping fires only when rows actually changed, and never
//     fails the run.
package shortdatasync

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// maxConns keeps the pool tiny: this job is a single writer against the
// Supabase pooler.
const maxConns = 2

// defaults mirror the deployed image's ENV defaults.
const (
	defaultSyncDays  = 7
	defaultBatchSize = 500
)

// config is the parsed flag set, threaded explicitly (package-level flag vars
// would leak across subcommands).
type config struct {
	days        int
	batchSize   int
	syncAlgolia bool
	dryRun      bool
	shadow      bool
	// stocks is the validated, normalised `-stocks` code list (nil when unset).
	// Only ever populated alongside shadow — see parseConfig.
	stocks []string
}

// Job returns the `shorted short-data-sync` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "short-data-sync",
		Desc:    "ingest ASIC daily short positions into shorts, refresh MVs, bust the frontend cache",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes the ASIC shorts sync.
func Run(ctx context.Context, args []string) error {
	cfg, err := parseConfig(ctx, args)
	if err != nil {
		return err
	}
	warnUnsupportedEnv()

	client := &http.Client{}
	now := time.Now().UTC()

	log.Printf("🚀 SHORT DATA SYNC — starting (days=%d dry-run=%v shadow=%v algolia=%v stocks=%v)",
		cfg.days, cfg.dryRun, cfg.shadow, cfg.syncAlgolia, cfg.stocks)

	pool, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(maxConns))
	if err != nil {
		return err
	}
	defer pool.Close()
	store := &pgStore{db: pool}

	if cfg.shadow {
		summary, err := runShadow(ctx, cfg, store, client, now)
		if err != nil {
			return err
		}
		if len(cfg.stocks) > 0 {
			// One compact, prefixed line — the only form that survives Cloud
			// Logging's per-line entry split, which is how the admin console
			// retrieves this report.
			return summary.writeValidationLine(os.Stdout)
		}
		return summary.writeJSON(os.Stdout)
	}
	return runSync(ctx, cfg, store, client, now)
}

// parseConfig parses flags, defaulting each from its env var.
func parseConfig(ctx context.Context, args []string) (config, error) {
	globals := runner.FromContext(ctx)

	fs := flag.NewFlagSet("short-data-sync", flag.ContinueOnError)
	cfg := config{}
	fs.IntVar(&cfg.days, "days", platform.GetEnvInt("SYNC_DAYS_SHORTS", defaultSyncDays),
		"Days of ASIC files to look back when the shorts table is empty (env SYNC_DAYS_SHORTS)")
	fs.IntVar(&cfg.batchSize, "batch-size", platform.GetEnvInt("SYNC_BATCH_SIZE", defaultBatchSize),
		"Recorded into sync_status.checkpoint_batch_size for dashboard continuity (env SYNC_BATCH_SIZE)")
	fs.BoolVar(&cfg.syncAlgolia, "sync-algolia", platform.GetEnvBool("SYNC_ALGOLIA", false),
		"Trigger the Algolia index sync after a successful run (env SYNC_ALGOLIA)")
	fs.BoolVar(&cfg.dryRun, "dry-run", globals.DryRun,
		"Download and parse everything, write nothing (no DB, no Algolia, no revalidation)")
	fs.BoolVar(&cfg.shadow, "shadow", false,
		"Implies -dry-run and prints a JSON parity summary on stdout")
	stocks := fs.String("stocks", "",
		"Comma-separated ASX product codes (max 20) to produce a per-stock validation report for; requires -shadow")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return config{}, runner.ErrUsage
		}
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if cfg.days < 1 {
		return config{}, fmt.Errorf("invalid -days %d (want >= 1)", cfg.days)
	}
	if cfg.shadow {
		cfg.dryRun = true
	}
	if raw := strings.TrimSpace(*stocks); raw != "" {
		// A SCOPED LIVE RUN IS REFUSED, on purpose. `-stocks` narrows what the
		// report talks about; it does NOT narrow what the pipeline writes. A
		// live run with -stocks would still upsert every row in every file while
		// printing a report about three of them — the most misleading possible
		// combination. So the flag is only legal in shadow mode, where nothing
		// is written at all.
		if !cfg.shadow {
			return config{}, fmt.Errorf("-stocks requires -shadow: a per-stock report is a read-only validation, and -stocks does NOT scope the writes a live run performs")
		}
		codes, err := parseStockCodes(raw)
		if err != nil {
			return config{}, err
		}
		cfg.stocks = codes
	}
	return cfg, nil
}

// unsupportedEnv are the deployed job's price/metric knobs. This job does not
// read them; warning loudly beats silently ignoring a variable an operator set
// expecting an effect.
var unsupportedEnv = []string{
	"SYNC_DAYS_STOCK_PRICES",
	"SYNC_KEY_METRICS",
	"ALPHA_VANTAGE_API_KEY",
	"MAX_STOCK_FAILURE_RETRIES",
}

func warnUnsupportedEnv() {
	for _, key := range unsupportedEnv {
		if os.Getenv(key) != "" {
			log.Printf("⚠️  %s is set but ignored: `shorted short-data-sync` does not sync prices or key metrics (see the package doc)", key)
		}
	}
}

// runSync is the write path.
func runSync(ctx context.Context, cfg config, store *pgStore, client *http.Client, now time.Time) error {
	if !cfg.dryRun {
		if n, err := store.CleanupStuckRuns(ctx); err != nil {
			// Never fatal: an unclean dashboard must not stop an ingest.
			log.Printf("⚠️  could not clean up stuck runs: %v", err)
		} else if n > 0 {
			log.Printf("🧹 Cleaned up %d stuck job(s) from previous runs", n)
		}
	}

	var rec *recorder
	if !cfg.dryRun {
		existing, err := store.findResumableRun(ctx, os.Getenv("CLOUD_RUN_EXECUTION"))
		if err != nil {
			return err
		}
		rec = newRecorder(store, existing)
		if err := rec.Start(ctx, 0, cfg.batchSize, existing != ""); err != nil {
			return err
		}
	}

	recordCount, err := syncShorts(ctx, cfg, store, client, now, nil)
	if err != nil {
		if rec != nil {
			rec.Fail(ctx, truncateBytes([]byte(err.Error()), 1000))
		}
		return err
	}
	log.Printf("✅ Shorts update complete: %d total records updated", recordCount)

	logHealth(ctx, store)

	if cfg.dryRun {
		log.Printf("[dry-run] skipping MV refresh, revalidation and Algolia; nothing was written")
		return nil
	}

	log.Printf("🔄 REFRESHING MATERIALIZED VIEWS")
	store.RefreshMaterializedViews(ctx)

	// Event-driven ISR bust, only when data actually changed. Best-effort by
	// construction (platform.PingRevalidate never returns an error).
	if recordCount > 0 {
		platform.PingRevalidate(revalidateRequest())
	} else {
		log.Printf("No new shorts records; skipping cache revalidation.")
	}

	if cfg.syncAlgolia {
		triggerAlgoliaSync(ctx, client)
	} else {
		log.Printf("🔍 Algolia sync not enabled, skipping")
	}

	rec.shortsRecordsUpdated = recordCount
	if err := rec.Complete(ctx, true); err != nil {
		// The data is committed; a status-write failure must not fail the run
		// (the Python logged and exited cleanly here too).
		log.Printf("⚠️  %v", err)
	}
	return nil
}

// runShadow runs the full read path and returns the parity summary. It opens no
// write path at all: no sync_status row, no upsert, no MV refresh, no ping.
func runShadow(ctx context.Context, cfg config, store *pgStore, client *http.Client, now time.Time) (shadowSummary, error) {
	sum := newShadowSummary(now, cfg.days)
	if len(cfg.stocks) > 0 {
		sum.stockFilter = codeSet(cfg.stocks)
	}
	if _, err := syncShorts(ctx, cfg, store, client, now, &sum); err != nil {
		return sum, err
	}
	if len(cfg.stocks) > 0 {
		// The one extra read a validation run performs: the CURRENT rows for the
		// requested codes over the same window the files covered. Read-only, and
		// bounded by (<=20 codes x window), so it cannot become a table scan.
		current, err := store.RowsForCodes(ctx, cfg.stocks, sum.cutoff)
		if err != nil {
			return sum, err
		}
		report := buildStocksReport(cfg.stocks, sum.stockFiles, current)
		sum.Stocks = &report
	}
	// Recorded here (not inside the file loop) so an early return — "already up
	// to date", an index failure, no files — still reports the suppressed side
	// effects rather than leaving them at their zero values.
	sum.WouldRefreshMVs = true
	sum.WouldRecordStatus = true
	sum.WouldSyncAlgolia = cfg.syncAlgolia
	sum.WouldRevalidate = sum.RowsParsed > 0
	sum.Checksum = checksumRows(sum.rows)
	return sum, nil
}

// syncShorts is the single implementation behind the live, dry and shadow
// paths — the write is the only branch, so a shadow run exercises exactly the
// code a real run does.
//
// Semantics carried over from update_shorts_data():
//   - MAX("DATE") decides the window; a table already holding today's date
//     short-circuits with 0 records;
//   - otherwise files from (last date + 1 day) onwards, or the last `days` days
//     on an empty table;
//   - files are processed in ASIC index order (newest first);
//   - a file that 404s or fails to parse is warned about and skipped, and the
//     rest of the run continues.
func syncShorts(ctx context.Context, cfg config, store *pgStore, client *http.Client, now time.Time, sum *shadowSummary) (int, error) {
	today := truncateDay(now)

	lastDate, haveData, err := store.LastShortsDate(ctx)
	if err != nil {
		return 0, err
	}
	cutoffDate := today.AddDate(0, 0, -cfg.days)
	if haveData {
		log.Printf("   Last ingested shorts date: %s", lastDate.Format("2006-01-02"))
		if !lastDate.Before(today) {
			log.Printf("   ✓ Already up to date!")
			if sum != nil {
				sum.LastShortsDate = lastDate.Format("2006-01-02")
				sum.AlreadyUpToDate = true
				// Still record a window: a validation run that short-circuits
				// must not leave `cutoff` at the zero time, which would turn the
				// comparison SELECT into a full-history scan.
				sum.cutoff = cutoffDate
			}
			return 0, nil
		}
		cutoffDate = lastDate.AddDate(0, 0, 1)
	} else {
		log.Printf("   No existing shorts data - initial load")
	}
	cutoff := yyyymmdd(cutoffDate)

	if sum != nil {
		if haveData {
			sum.LastShortsDate = lastDate.Format("2006-01-02")
		}
		sum.CutoffDate = cutoff
		sum.cutoff = cutoffDate
	}

	index, err := fetchIndex(ctx, client)
	if err != nil {
		// The Python logged and carried on with an empty list; a run with no
		// index simply reports 0 records rather than failing the job.
		log.Printf("❌ Failed to fetch ASIC file list: %v", err)
		return 0, nil
	}
	files := selectFiles(index, cutoff)
	log.Printf("📊 Found %d shorts data files to process", len(files))
	if sum != nil {
		sum.FilesSelected = len(files)
	}
	if len(files) == 0 {
		log.Printf("⚠️  No shorts data files to process")
		return 0, nil
	}

	var existing map[string]struct{}
	seen := map[string]struct{}{}
	if sum != nil {
		existing, err = store.ExistingKeys(ctx, cutoffDate)
		if err != nil {
			return 0, err
		}
	}

	total := 0
	for i, f := range files {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		name := f.fileName()
		log.Printf("[%d/%d] Processing %s", i+1, len(files), name)

		body, err := downloadFile(ctx, client, f.downloadURL())
		if err != nil {
			log.Printf("⚠️  Failed to download %s: %v", name, err)
			if sum != nil {
				sum.FilesFailed = append(sum.FilesFailed, shadowFileError{File: name, Error: err.Error()})
			}
			continue
		}
		rows, err := parseFile(name, body)
		if err != nil {
			log.Printf("⚠️  Failed to parse %s: %v", name, err)
			if sum != nil {
				sum.FilesFailed = append(sum.FilesFailed, shadowFileError{File: name, Error: err.Error()})
			}
			continue
		}

		if sum != nil {
			ins, upd, dup := classify(rows, existing, seen)
			date := ""
			if len(rows) > 0 {
				date = rows[0].Date.Format("2006-01-02")
			}
			sum.Dates = append(sum.Dates, shadowDate{
				Date:        date,
				File:        name,
				RowsParsed:  len(rows),
				WouldInsert: ins,
				WouldUpdate: upd,
				Checksum:    checksumRows(rows),
			})
			sum.FilesParsed++
			sum.RowsParsed += len(rows)
			sum.WouldInsert += ins
			sum.WouldUpdate += upd
			sum.DuplicateKey += dup
			sum.rows = append(sum.rows, rows...)
			if sum.stockFilter != nil {
				// Capture only the requested codes. The full row set already
				// lives in sum.rows for the checksum; this is the (tiny) slice
				// the per-stock diff is built from.
				// The file name is the authoritative observation date (parseFile
				// derives every row's date from it), and it is still correct for
				// a file that parsed to zero rows.
				obsDate, dateErr := dateFromFileName(name)
				if dateErr != nil && len(rows) > 0 {
					obsDate = truncateDay(rows[0].Date)
				}
				sum.stockFiles = append(sum.stockFiles, stockFileRows{
					Date: obsDate,
					File: name,
					Rows: filterRows(rows, sum.stockFilter),
				})
			}
			continue
		}

		if cfg.dryRun {
			log.Printf("  [dry-run] parsed %d records", len(rows))
			total += len(rows)
			continue
		}

		written, err := store.UpsertRows(ctx, rows)
		total += written
		if err != nil {
			return total, err
		}
		log.Printf("  ✅ Inserted/Updated %d records", written)
	}

	if sum != nil {
		sortShadowDates(sum.Dates)
		return sum.RowsParsed, nil
	}
	return total, nil
}

// sortShadowDates orders the per-date breakdown oldest first so two summaries
// are directly comparable regardless of the index's ordering.
func sortShadowDates(dates []shadowDate) {
	for i := 1; i < len(dates); i++ {
		for j := i; j > 0 && dates[j].Date < dates[j-1].Date; j-- {
			dates[j], dates[j-1] = dates[j-1], dates[j]
		}
	}
}

// revalidateRequest is the cache-bust contract, byte-identical to the Python's
// trigger_frontend_revalidation(): the same tag list, the same path list and
// flush=shorts, sent with the X-Revalidate-Secret header (never a query
// parameter). Changing any of these silently strands an ISR surface on stale
// data for up to 24h.
func revalidateRequest() platform.RevalidateRequest {
	return platform.RevalidateRequest{
		Reason: "short-data-sync",
		Tag:    "shorts-data,scan-results",
		Paths: []string{
			"/", "/top", "/news", "/screener", "/industry",
			"/shorts/[stockCode]", "/statistics", "/scans",
		},
		Flush: "shorts",
	}
}

// logHealth prints check_data_health()'s block. Failures are logged and
// swallowed — it is a report, not a gate.
func logHealth(ctx context.Context, store *pgStore) {
	h, err := store.Health(ctx)
	if err != nil {
		log.Printf("⚠️ Could not run health check: %v", err)
		return
	}
	log.Printf("📋 DATA HEALTH CHECK")
	log.Printf("   Total stocks: %d", h.TotalStocks)
	log.Printf("   Complete (≥2000 records): %d", h.Complete)
	log.Printf("   Partial (500-2000): %d", h.Partial)
	log.Printf("   Incomplete (<500): %d", h.Incomplete)
	log.Printf("   Health score: %.1f%%", h.HealthScore)
	if len(h.StaleStocks) == 0 {
		log.Printf("   ✅ No stale data detected")
		return
	}
	log.Printf("   ⚠️ %d stocks with stale data:", len(h.StaleStocks))
	for i, st := range h.StaleStocks {
		if i >= 5 {
			break
		}
		log.Printf("      - %s: last data %s", st.StockCode, st.LastDate.Format("2006-01-02"))
	}
}
