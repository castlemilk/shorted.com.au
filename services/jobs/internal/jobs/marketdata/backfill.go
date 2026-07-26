package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/stocklist"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxGapsBeforeFullFetch: past this many gaps it is cheaper to refetch the
// whole range once (~4s per provider call) than to fill each gap individually.
const maxGapsBeforeFullFetch = 10

// backfillMinGapDays is the gap threshold (in days) the backfill treats as a
// real hole rather than a weekend/holiday.
const backfillMinGapDays = 4

// backfillConfig is the parsed flag set. Flags are byte-identical to the
// standalone cmd/historical-backfill binary.
type backfillConfig struct {
	years        int
	limit        int
	priorityOnly bool
	forceRefetch bool
	symbol       string
}

// backfillJob returns `shorted market-data historical-backfill`
// (was cmd/historical-backfill): a multi-year history fetch + gap repair,
// driven by the database's actual state rather than by checkpoints.
//
// DryRun is false: every path either writes stock_prices or skips; there is no
// preview mode in the original and inventing one would change what "-dry-run"
// means for this family.
func backfillJob() runner.Job {
	return runner.Func{
		JobName: "historical-backfill",
		Desc:    "backfill multi-year price history / repair gaps (was cmd/historical-backfill)",
		Fn:      runBackfill,
	}
}

func runBackfill(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("market-data historical-backfill", flag.ContinueOnError)
	cfgFlags := backfillConfig{}
	fs.IntVar(&cfgFlags.years, "years", 10, "Number of years of historical data to fetch")
	fs.IntVar(&cfgFlags.limit, "limit", 0, "Limit number of stocks to process (0 = all)")
	fs.BoolVar(&cfgFlags.priorityOnly, "priority-only", false, "Only sync priority (top shorted) stocks")
	fs.BoolVar(&cfgFlags.forceRefetch, "force", false, "Force re-fetch even if data exists (ignores database state)")
	fs.StringVar(&cfgFlags.symbol, "symbol", "", "Process only this specific stock symbol (e.g., DMP). If provided, ignores other filters.")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	if strings.Contains(cfg.DatabaseURL, "pooler.supabase.com") && strings.Contains(cfg.DatabaseURL, ":5432") {
		log.Printf("⚠️  WARNING: Using Supabase Session mode (port 5432)")
		log.Printf("⚠️  This has very limited connections and will cause errors!")
		log.Printf("⚠️  Please use Transaction mode (port 6543) instead:")
		log.Printf("⚠️  Change :5432 to :6543 in your DATABASE_URL")
	}

	poolConfig, err := buildDBPoolConfig(cfg)
	if err != nil {
		return fmt.Errorf("failed to parse database URL: %w", err)
	}
	// The standalone binary hard-coded max=3/min=1 for backfill regardless of
	// DB_MAX_CONNS. Preserved: a multi-hour sweep on the shared pooler is
	// exactly where an over-wide pool hurts.
	poolConfig.MaxConns = 3
	poolConfig.MinConns = 1

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}
	log.Printf("✅ Connected to database (pool: max=%d, min=%d)", poolConfig.MaxConns, poolConfig.MinConns)

	gcsClient, closeGCS := backfillGCSClient(ctx, cfgFlags)
	defer closeGCS()

	dataProviders := buildProviders(cfg)

	stocks, err := backfillStockList(ctx, pool, gcsClient, cfg, cfgFlags)
	if err != nil {
		return err
	}

	log.Printf("🚀 Starting historical backfill for %d stocks (%d years)", len(stocks), cfgFlags.years)
	if cfgFlags.forceRefetch {
		log.Printf("⚠️  Force mode: will re-fetch ALL data regardless of existing records")
	} else {
		log.Printf("📋 Smart mode: checking database state for each stock (skip if complete, fetch if gaps/missing)")
	}

	return backfillStocks(ctx, pool, dataProviders, stocks, cfgFlags)
}

// backfillGCSClient builds the (optional) GCS client used to read the stock
// list. Single-symbol runs and LOCAL_ASX_CSV runs skip it entirely, and a
// construction failure is non-fatal — the DB fallback covers it.
func backfillGCSClient(ctx context.Context, cfgFlags backfillConfig) (*storage.Client, func()) {
	noop := func() {}
	switch {
	case cfgFlags.symbol != "":
		log.Printf("ℹ️ Single stock mode (-symbol), skipping GCS initialization")
		return nil, noop
	case os.Getenv("LOCAL_ASX_CSV") != "":
		log.Printf("ℹ️ Using local ASX CSV file, skipping GCS initialization")
		return nil, noop
	}

	client, err := newGCSClient(ctx)
	if err != nil {
		log.Printf("⚠️ Failed to create GCS client: %v", err)
		log.Printf("💡 Will fall back to database for stock list")
		return nil, noop
	}
	log.Printf("✅ Connected to GCS")
	return client, func() {
		if err := client.Close(); err != nil {
			log.Printf("⚠️ closing GCS client: %v", err)
		}
	}
}

// backfillStockList resolves the stock codes to process: a single -symbol, or
// the prioritised GCS/local-CSV list, or (when that fails) whatever the
// database already has prices for.
func backfillStockList(ctx context.Context, pool *pgxpool.Pool, gcsClient *storage.Client, cfg *config.Config, cfgFlags backfillConfig) ([]string, error) {
	// -symbol short-circuits every other filter and needs no stock list at all.
	if cfgFlags.symbol != "" {
		code := strings.TrimSuffix(strings.ToUpper(cfgFlags.symbol), ".AX")
		log.Printf("🎯 Single stock mode: processing only %s", code)
		return []string{code}, nil
	}

	if os.Getenv("LOCAL_ASX_CSV") != "" {
		log.Printf("📋 Fetching stock list from local CSV file...")
	} else {
		log.Printf("📋 Fetching stock list from GCS...")
	}

	allStocks, err := stocklist.New(pool, gcsClient).GetPrioritizedStocks(ctx, cfg.GCSBucketName, cfg.PriorityStockCount)
	if err != nil {
		log.Printf("⚠️ Failed to get stock list from GCS/local CSV: %v", err)
		log.Printf("💡 Tip: Set LOCAL_ASX_CSV environment variable to use a local CSV file")
		log.Printf("💡 Falling back to database...")

		dbStocks, dbErr := auditStockList(ctx, pool)
		if dbErr != nil {
			return nil, fmt.Errorf("failed to get stocks from database: %w", dbErr)
		}
		if len(dbStocks) == 0 {
			return nil, errors.New("no stocks found in database: set LOCAL_ASX_CSV, ensure the GCS bucket has asx-stocks/latest.csv, or populate the database first")
		}
		log.Printf("✅ Found %d stocks in database (using as fallback)", len(dbStocks))
		return dbStocks, nil
	}

	source := "GCS"
	if os.Getenv("LOCAL_ASX_CSV") != "" {
		source = "local CSV"
	}
	log.Printf("✅ Fetched %d stocks from %s", len(allStocks), source)

	stocks := make([]string, 0, len(allStocks))
	for _, stock := range allStocks {
		if cfgFlags.priorityOnly && !stock.IsPriority {
			continue
		}
		stocks = append(stocks, stock.Code)
	}
	if cfgFlags.limit > 0 && cfgFlags.limit < len(stocks) {
		stocks = stocks[:cfgFlags.limit]
		log.Printf("📊 Limited to %d stocks", len(stocks))
	}
	return stocks, nil
}

// gapPeriod is a (last-known, next-known) date pair bracketing missing data.
type gapPeriod struct {
	Start time.Time
	End   time.Time
}

// backfillPlan is what a single stock needs fetched.
type backfillPlan struct {
	skip             bool // already complete — nothing to do
	fullFetch        bool
	gaps             []gapPeriod
	incremental      bool
	incrementalStart time.Time
	incrementalEnd   time.Time
}

func backfillStocks(ctx context.Context, pool *pgxpool.Pool, dataProviders []providers.DataProvider, stocks []string, cfgFlags backfillConfig) error {
	checkpointStore := checkpoint.NewStore(pool)

	// Always start a new run — database state, not checkpoints, drives the
	// skip decisions; the checkpoint is progress reporting only.
	runID := uuid.New().String()
	if incompleteRun, err := checkpointStore.GetIncompleteRun(ctx); err == nil && incompleteRun != nil {
		log.Printf("📋 Found old incomplete run %s - marking as superseded", incompleteRun.RunID)
		if markErr := checkpointStore.FailRun(ctx, incompleteRun.RunID, "Superseded - using database state"); markErr != nil {
			log.Printf("⚠️ Failed to mark old run: %v", markErr)
		}
	}

	log.Printf("🆕 Starting run: %s", runID)
	if err := checkpointStore.StartRun(ctx, runID, len(stocks), 0); err != nil {
		log.Printf("⚠️ Failed to create checkpoint: %v (continuing anyway)", err)
	}

	endDate := time.Now()
	startDate := endDate.AddDate(-cfgFlags.years, 0, 0)

	var successful, failed, totalRecords int

	for i, symbol := range stocks {
		if err := ctx.Err(); err != nil {
			log.Printf("⏹️ Backfill interrupted at %d/%d", i, len(stocks))
			if upErr := checkpointStore.UpdateProgress(ctx, runID, i, successful, failed, 0, 0); upErr != nil {
				log.Printf("⚠️ Failed to update checkpoint: %v", upErr)
			}
			// The standalone binary `return`ed here and exited 0, so an
			// interrupted backfill looked like a clean run to any caller. It is
			// an error now.
			return fmt.Errorf("backfill cancelled after %d/%d stocks: %w", i, len(stocks), err)
		}

		plan := planBackfill(ctx, pool, symbol, startDate, cfgFlags)
		if plan.skip {
			successful++
			if (i+1)%50 == 0 {
				if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0, 0); err != nil {
					log.Printf("⚠️ Failed to update checkpoint: %v", err)
				}
			}
			continue
		}

		records := fetchPlan(ctx, dataProviders, symbol, plan, startDate, endDate, i, len(stocks))
		if len(records) == 0 {
			if plan.fullFetch {
				log.Printf("❌ [%d/%d] Failed to fetch data for %s", i+1, len(stocks), symbol)
				failed++
			} else {
				log.Printf("⏭️ [%d/%d] %s: no new records needed", i+1, len(stocks), symbol)
				successful++
			}
			if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0, 0); err != nil {
				log.Printf("⚠️ Failed to update checkpoint: %v", err)
			}
			continue
		}

		inserted := insertPriceRecords(ctx, pool, symbol, records)
		successful++
		totalRecords += inserted
		log.Printf("✅ [%d/%d] %s: Inserted %d records (total: %d)", i+1, len(stocks), symbol, inserted, totalRecords)

		if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0, 0); err != nil {
			log.Printf("⚠️ Failed to update checkpoint: %v", err)
		}
		if err := checkpointStore.UpdatePricesCount(ctx, runID, totalRecords); err != nil {
			log.Printf("⚠️ Failed to update prices count: %v", err)
		}

		if (i+1)%10 == 0 {
			log.Printf("📊 Progress: %d/%d stocks, %d successful, %d failed, %d total records", i+1, len(stocks), successful, failed, totalRecords)
		}
	}

	if err := checkpointStore.CompleteRun(ctx, runID); err != nil {
		log.Printf("⚠️ Failed to mark run as complete: %v", err)
	}

	log.Printf("🎉 Historical backfill complete!")
	log.Printf("   Run ID: %s", runID)
	log.Printf("   Stocks processed: %d", len(stocks))
	log.Printf("   Successful: %d", successful)
	log.Printf("   Failed: %d", failed)
	log.Printf("   Total records: %d", totalRecords)
	return nil
}

// planBackfill inspects what the database already holds for symbol and decides
// what (if anything) to fetch.
func planBackfill(ctx context.Context, pool *pgxpool.Pool, symbol string, startDate time.Time, cfgFlags backfillConfig) backfillPlan {
	if cfgFlags.forceRefetch {
		return backfillPlan{fullFetch: true}
	}

	var earliestDate, latestDate time.Time
	var recordCount int
	err := pool.QueryRow(ctx, `
		SELECT MIN(date), MAX(date), COUNT(*)
		FROM stock_prices
		WHERE stock_code = $1
	`, symbol).Scan(&earliestDate, &latestDate, &recordCount)

	if err != nil || recordCount == 0 || earliestDate.IsZero() || latestDate.IsZero() {
		log.Printf("🆕 %s: no data, fetching full history...", symbol)
		return backfillPlan{fullFetch: true}
	}

	dataSpanDays := int(latestDate.Sub(earliestDate).Hours() / 24)
	requiredDays := cfgFlags.years * 365
	gaps := queryGapPeriods(ctx, pool, symbol)

	if dataSpanDays >= requiredDays && len(gaps) == 0 {
		log.Printf("✅ %s: complete (%d records, %d days, no gaps)", symbol, recordCount, dataSpanDays)
		return backfillPlan{skip: true}
	}

	plan := backfillPlan{gaps: gaps}
	switch {
	case dataSpanDays >= requiredDays:
		// Span is sufficient, ONLY fetch gaps.
		log.Printf("🔧 %s: has %d gap(s) to repair (span OK)", symbol, len(gaps))
	default:
		if earliestDate.After(startDate) {
			plan.incremental = true
			plan.incrementalStart = startDate
			plan.incrementalEnd = earliestDate.AddDate(0, 0, -1)
			log.Printf("📊 %s: need earlier data (%s to %s)", symbol,
				plan.incrementalStart.Format("2006-01-02"), plan.incrementalEnd.Format("2006-01-02"))
		}
	}
	return plan
}

// queryGapPeriods returns the (last-known, next-known) pairs bracketing every
// hole longer than backfillMinGapDays.
func queryGapPeriods(ctx context.Context, pool *pgxpool.Pool, symbol string) []gapPeriod {
	// Parameterised threshold; the standalone binary inlined the literal 4.
	rows, err := pool.Query(ctx, `
		WITH date_series AS (
			SELECT date, LAG(date) OVER (ORDER BY date) as prev_date
			FROM stock_prices WHERE stock_code = $1
		)
		SELECT prev_date, date FROM date_series
		WHERE prev_date IS NOT NULL AND (date - prev_date) > $2
		ORDER BY prev_date
	`, symbol, backfillMinGapDays)
	if err != nil {
		return nil
	}
	// Closed here, not deferred: the standalone binary deferred this inside the
	// per-stock loop, so every stock's rows stayed open (and its connection
	// pinned) until the whole multi-thousand-stock run finished.
	defer rows.Close()

	var gaps []gapPeriod
	for rows.Next() {
		var gapStart, gapEnd time.Time
		if err := rows.Scan(&gapStart, &gapEnd); err == nil {
			gaps = append(gaps, gapPeriod{Start: gapStart, End: gapEnd})
		}
	}
	return gaps
}

// fetchPlan executes a backfillPlan against the provider chain.
func fetchPlan(ctx context.Context, dataProviders []providers.DataProvider, symbol string, plan backfillPlan, startDate, endDate time.Time, i, total int) []providers.PriceRecord {
	fetch := func(from, to time.Time) []providers.PriceRecord {
		for _, p := range dataProviders {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(p.GetRateLimit()):
			}
			records, err := p.FetchHistoricalData(ctx, symbol, from, to)
			if err == nil && len(records) > 0 {
				return records
			}
		}
		return nil
	}

	var all []providers.PriceRecord

	if plan.fullFetch {
		log.Printf("📥 [%d/%d] Fetching %s full history (%s to %s)...",
			i+1, total, symbol, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))
		if records := fetch(startDate, endDate); len(records) > 0 {
			log.Printf("✅ %s: Fetched %d records", symbol, len(records))
			all = append(all, records...)
		}
		return all
	}

	// Past maxGapsBeforeFullFetch it is cheaper to refetch the whole range once
	// than to make one ~4s provider call per gap.
	if len(plan.gaps) > maxGapsBeforeFullFetch {
		log.Printf("🔄 [%d/%d] %s: %d gaps detected, fetching full range instead (more efficient)",
			i+1, total, symbol, len(plan.gaps))
		if records := fetch(startDate, endDate); len(records) > 0 {
			log.Printf("✅ %s: Fetched %d records (replacing sparse data)", symbol, len(records))
			all = append(all, records...)
		}
		// A full-range fetch already covers the incremental window.
		return all
	}

	for gi, gap := range plan.gaps {
		// 1-day buffer on each side of the known-good endpoints.
		gapStart := gap.Start.AddDate(0, 0, 1)
		gapEnd := gap.End.AddDate(0, 0, -1)
		if gapStart.After(gapEnd) {
			continue
		}
		log.Printf("🔧 [%d/%d] %s: fetching gap %d/%d (%s to %s)",
			i+1, total, symbol, gi+1, len(plan.gaps), gapStart.Format("2006-01-02"), gapEnd.Format("2006-01-02"))
		if records := fetch(gapStart, gapEnd); len(records) > 0 {
			log.Printf("   ✅ Got %d records for gap", len(records))
			all = append(all, records...)
		}
	}

	if plan.incremental {
		log.Printf("📥 [%d/%d] %s: fetching earlier history (%s to %s)...",
			i+1, total, symbol, plan.incrementalStart.Format("2006-01-02"), plan.incrementalEnd.Format("2006-01-02"))
		if records := fetch(plan.incrementalStart, plan.incrementalEnd); len(records) > 0 {
			log.Printf("✅ %s: Fetched %d earlier records", symbol, len(records))
			all = append(all, records...)
		}
	}

	return all
}

// insertPriceRecords upserts the fetched rows, returning how many landed.
func insertPriceRecords(ctx context.Context, pool *pgxpool.Pool, symbol string, records []providers.PriceRecord) int {
	inserted := 0
	for _, record := range records {
		_, err := pool.Exec(ctx, `
			INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (stock_code, date) DO UPDATE SET
				open = EXCLUDED.open,
				high = EXCLUDED.high,
				low = EXCLUDED.low,
				close = EXCLUDED.close,
				adjusted_close = EXCLUDED.adjusted_close,
				volume = EXCLUDED.volume,
				updated_at = CURRENT_TIMESTAMP
		`, record.StockCode, record.Date, record.Open, record.High, record.Low, record.Close, record.AdjustedClose, record.Volume)
		if err != nil {
			log.Printf("⚠️ Failed to insert record for %s on %s: %v", symbol, record.Date.Format("2006-01-02"), err)
			continue
		}
		inserted++
	}
	return inserted
}
