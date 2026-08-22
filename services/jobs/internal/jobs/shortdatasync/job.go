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
//	-stocks CODES    per-stock validation report (requires -shadow)
//	-validate-days N validation window: the last N PUBLISHED ASIC dates,
//	                 ignoring what is already ingested (requires -stocks)
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

// The VALIDATION window (`-stocks` runs only). See validationScan.
const (
	// defaultValidateDays is how many of the most recent PUBLISHED ASIC dates a
	// validation run re-parses when the operator does not say. A trading week
	// is enough to show a pattern and small enough to finish in seconds.
	defaultValidateDays = 7
	// maxValidateDays caps it. A validation is a diagnostic read by a human in
	// a console table; beyond a month it is a backfill audit, and the run's
	// download volume stops being trivial.
	maxValidateDays = 30
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
	// validateDays is the VALIDATION window: how many of the most recent
	// published ASIC dates a `-stocks` run re-parses. Read on that path ONLY —
	// a sync and a plain `-shadow` parity run never consult it.
	validateDays int
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
			// The DURABLE copy: gs://<bucket>/validations/<execution>.json is
			// what the admin console reads. Fail-soft — the run still succeeds
			// if the upload does not, and says so in the summary below.
			publishValidationArtifact(ctx, cfg, &summary, gcsObjectWriter{},
				validationBucket(), os.Getenv("CLOUD_RUN_EXECUTION"))
			// One compact, prefixed line, kept for the operator who is already
			// looking at the logs. Emitted AFTER the upload so it carries the
			// artifact's address (or its failure).
			return summary.writeValidationLine(os.Stdout)
		}
		// Plain shadow: the parity path. No object, no GCS client, no network
		// call beyond the ASIC fetch — see artifact.go.
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
	fs.IntVar(&cfg.validateDays, "validate-days", defaultValidateDays,
		fmt.Sprintf("VALIDATION ONLY (requires -stocks): how many of the most recent PUBLISHED ASIC dates to re-parse, ignoring what is already ingested (1-%d)", maxValidateDays))
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
	if cfg.validateDays < 1 || cfg.validateDays > maxValidateDays {
		return config{}, fmt.Errorf("invalid -validate-days %d (want 1-%d)", cfg.validateDays, maxValidateDays)
	}
	if cfg.shadow {
		cfg.dryRun = true
	}
	validateDaysSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "validate-days" {
			validateDaysSet = true
		}
	})
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
	} else if validateDaysSet {
		// Refused rather than ignored. `-validate-days` moves the VALIDATION
		// window only; on a sync or a plain `-shadow` parity run it does
		// nothing at all, and silently doing nothing is how an operator ends up
		// trusting a number that was never used.
		return config{}, fmt.Errorf("-validate-days requires -stocks: it widens the validation window only, and has no effect on a sync or on a plain -shadow parity run")
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

// validationMode reports whether this run is a `-stocks` validation, which is
// the ONLY path that departs from the sync's window. Both halves are required:
// `-stocks` cannot be set without `-shadow` (parseConfig), and a summary is
// only threaded through on a shadow run.
func validationMode(cfg config, sum *shadowSummary) bool {
	return sum != nil && len(cfg.stocks) > 0
}

// syncFileWindow is the SYNC's window decision — the one a live run, a
// `-dry-run` and a plain `-shadow` parity run all share, and the one a
// validation run deliberately does not use.
//
// It returns the inclusive lower bound files are selected from, and whether the
// table already holds today's data (in which case the run short-circuits and
// the returned bound is only the fallback window a summary records).
//
// Extracted so the parity contract is pinned by a test that needs no network
// and no database: TestSyncFileWindowIsCutoffBased.
func syncFileWindow(days int, today, lastDate time.Time, haveData bool) (cutoffDate time.Time, upToDate bool) {
	cutoffDate = today.AddDate(0, 0, -days)
	if !haveData {
		return cutoffDate, false
	}
	if !lastDate.Before(today) {
		return cutoffDate, true
	}
	return lastDate.AddDate(0, 0, 1), false
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
//
// A `-stocks` VALIDATION run is the one exception, and it forks before any of
// that: its window is the last N published ASIC dates, independent of what is
// ingested. See validationScan for why. Everything below this fork — the sync,
// the dry run and the plain `-shadow` parity run — is untouched.
func syncShorts(ctx context.Context, cfg config, store *pgStore, client *http.Client, now time.Time, sum *shadowSummary) (int, error) {
	today := truncateDay(now)

	lastDate, haveData, err := store.LastShortsDate(ctx)
	if err != nil {
		return 0, err
	}
	if validationMode(cfg, sum) {
		return validationScan(ctx, cfg, store, client, today, lastDate, haveData, sum)
	}
	cutoffDate, upToDate := syncFileWindow(cfg.days, today, lastDate, haveData)
	if haveData {
		log.Printf("   Last ingested shorts date: %s", lastDate.Format("2006-01-02"))
		if upToDate {
			log.Printf("   ✓ Already up to date!")
			if sum != nil {
				sum.LastShortsDate = lastDate.Format("2006-01-02")
				sum.AlreadyUpToDate = true
				// Still record a window: a shadow run that short-circuits must
				// not leave `cutoff` at the zero time, which would turn the
				// comparison SELECT into a full-history scan.
				sum.cutoff = cutoffDate
			}
			return 0, nil
		}
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
	return processFiles(ctx, cfg, store, client, files, cutoffDate, sum)
}

// validationScan is the `-stocks` window, and the ONE place the pipeline
// deliberately ignores what is already ingested.
//
// # Why the sync's window is the wrong window for a diagnostic
//
// A sync processes (MAX("DATE") + 1 day → today), which is correct for an
// ingest and useless for a validation: on any day when ASIC has published
// nothing new — most days, by design, since the job runs daily and catches up —
// the window is EMPTY. Asked "does the pipeline work for BHP?", the report then
// answered `rows_parsed: 0, not_found: [BHP]`, which reads as a failure and is
// really just "there was nothing to do". A diagnostic that only produces a
// report on the days new data happens to exist is backwards.
//
// So a validation run re-parses the last N PUBLISHED ASIC dates regardless of
// the ingested cutoff. There is then always something to compare, and the
// expected outcome for a healthy pipeline is `unchanged` on every row: the file
// says 1.35%, the database says 1.35%, they agree. That is the positive signal
// the operator was asking for.
//
// # Why this cannot write anything
//
// It re-parses dates the database already holds, so it is worth being explicit:
// `-stocks` requires `-shadow` (parseConfig refuses otherwise), `-shadow`
// implies `-dry-run`, and this path reaches the write only through
// processFiles, whose upsert branch is unreachable while sum != nil — which
// validationMode requires. The DB is touched by two SELECTs and nothing else.
func validationScan(
	ctx context.Context,
	cfg config,
	store *pgStore,
	client *http.Client,
	today, lastDate time.Time,
	haveData bool,
	sum *shadowSummary,
) (int, error) {
	win := &validationWindow{Days: cfg.validateDays, Files: []string{}}
	sum.Validation = win

	if haveData {
		sum.LastShortsDate = lastDate.Format("2006-01-02")
		// RECORDED, NEVER ACTED ON. A sync short-circuits here; a validation
		// must not, or it reports nothing on exactly the days it is most likely
		// to be asked.
		sum.AlreadyUpToDate = !lastDate.Before(today)
		win.IgnoredCutoff = lastDate.AddDate(0, 0, 1).Format("2006-01-02")
		log.Printf("   Last ingested shorts date: %s (a sync would start at %s — IGNORED for validation)",
			sum.LastShortsDate, win.IgnoredCutoff)
	} else {
		log.Printf("   No existing shorts data — every row in the window will report as new")
	}
	// Provisional, so an early return never leaves the comparison SELECT's
	// lower bound at the zero time (which would make it a full-history scan).
	setValidationCutoff(sum, today.AddDate(0, 0, -cfg.validateDays))

	index, err := fetchIndex(ctx, client)
	if err != nil {
		// Fatal to the REPORT, not to the run: the same fail-soft posture as the
		// sync, but named as the problem it is rather than reported as an empty
		// window.
		log.Printf("❌ Failed to fetch ASIC file list: %v", err)
		win.Problem = fmt.Sprintf("no ASIC files could be scanned: the ASIC file index could not be fetched (%v)", err)
		sum.FilesFailed = append(sum.FilesFailed, shadowFileError{File: asicIndexURL, Error: err.Error()})
		return 0, nil
	}

	files := selectRecentFiles(index, cfg.validateDays)
	sum.FilesSelected = len(files)
	for _, f := range files {
		win.Files = append(win.Files, f.fileName())
	}
	if len(files) == 0 {
		win.Problem = "no ASIC files could be scanned: the ASIC file index is empty"
		log.Printf("⚠️  %s", win.Problem)
		return 0, nil
	}

	first, last, ok := windowBounds(files)
	if !ok {
		// Every selected entry carried an unparseable date. The files are still
		// worth downloading (parseFile derives the date itself and will say so),
		// but the window's lower bound has to come from the clock.
		first = today.AddDate(0, 0, -cfg.validateDays)
		last = today
	}
	win.From = first.Format("2006-01-02")
	win.To = last.Format("2006-01-02")
	setValidationCutoff(sum, first)
	log.Printf("🔎 VALIDATION: %d file(s) over the last %d published ASIC date(s), %s → %s",
		len(files), cfg.validateDays, win.From, win.To)

	return processFiles(ctx, cfg, store, client, files, first, sum)
}

// setValidationCutoff records the window's lower bound in both the emitted
// contract and the (unexported) bound the comparison SELECTs use, so the two
// can never disagree.
func setValidationCutoff(sum *shadowSummary, from time.Time) {
	sum.cutoff = from
	sum.CutoffDate = yyyymmdd(from)
}

// processFiles downloads, parses and (on a write run) upserts the selected
// files. `cutoffDate` bounds the shadow run's existing-key read.
func processFiles(
	ctx context.Context,
	cfg config,
	store *pgStore,
	client *http.Client,
	files []asicFile,
	cutoffDate time.Time,
	sum *shadowSummary,
) (int, error) {
	var err error
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
