package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	gosync "sync"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/algolia"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/stocklist"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newStockHistoryYears is how far back a stock with no stored prices starts.
const newStockHistoryYears = 10

// ErrBudgetSpent ends a sweep that has used its run budget (RunOptions.Budget).
// The run reports what it did and the next attempt resumes from the stalest
// stock; the command maps it to its own exit code.
var ErrBudgetSpent = errors.New("run budget spent")

// maxConsecutiveFailures ends a sweep that its providers are refusing. Only
// transport failures count (a 429, a 5xx, a timeout); "no data" is an answer.
// At the providers' pace, 25 in a row is minutes of a blocked upstream, and
// carrying on would only spend the rest of the run being refused.
const maxConsecutiveFailures = 25

// SyncManager coordinates the market data sync process
type SyncManager struct {
	db             *pgxpool.Pool
	gcs            *storage.Client
	config         *config.Config
	checkpoint     *checkpoint.Store
	stocklist      *stocklist.Service
	algolia        *algolia.Syncer
	providers      []providers.DataProvider
	failureTracker *FailureTracker

	// now is the clock the last closed session is read from.
	now func() time.Time
	// stockTimeout overrides the package's stockTimeout (tests).
	stockTimeout time.Duration
	// closeTolerance is how far a stored close may differ from the provider's
	// before a -from run counts it as changed; set per run from the column.
	closeTolerance float64

	paceMu   gosync.Mutex
	nextCall map[string]time.Time // provider name -> earliest start of its next request
}

// NewSyncManager creates a new SyncManager with all dependencies
func NewSyncManager(
	db *pgxpool.Pool,
	gcs *storage.Client,
	cfg *config.Config,
	dataProviders []providers.DataProvider,
) *SyncManager {
	return &SyncManager{
		db:             db,
		gcs:            gcs,
		config:         cfg,
		checkpoint:     checkpoint.NewStore(db),
		stocklist:      stocklist.New(db, gcs),
		algolia:        algolia.New(cfg.AlgoliaAppID, cfg.AlgoliaAdminKey, cfg.AlgoliaIndex),
		providers:      dataProviders,
		failureTracker: NewFailureTracker(db),
		now:            time.Now,
		nextCall:       make(map[string]time.Time),
	}
}

// RunOptions widens or narrows one sweep. The zero value is the scheduled run.
type RunOptions struct {
	// Codes limits the sweep to these codes, and ignores failure blocks for
	// them. Empty means every listed company, the top shorted, and the codes
	// beyond the listing that are still trading (beyondListing).
	Codes []string
	// From re-fetches every stock from this date, whatever is already stored,
	// overwriting stored sessions with the provider's, and reports where the two
	// differed. Zero means each stock from the day after its latest stored
	// session.
	From time.Time
	// DryRun fetches and compares, and writes nothing to the database: no
	// prices, company metadata, checkpoints, failure records or view refresh.
	DryRun bool
	// Budget is how long the sweep may keep taking stocks. Once it is spent the
	// run stops between stocks with ErrBudgetSpent, publishes its report and
	// leaves the rest to the next attempt, which resumes stalest first. It is
	// set below the Cloud Run task timeout so a slow run ends on its own terms:
	// a task the platform kills at its timeout is what the job alert reads as
	// a hang, and its retry has no say in what the first attempt did. Zero
	// means no budget.
	Budget time.Duration
}

// Run executes the scheduled sweep.
func (m *SyncManager) Run(ctx context.Context) error {
	_, err := m.RunWith(ctx, RunOptions{})
	return err
}

// RunWith sweeps the stock list once.
//
// Each stock is fetched in ONE request, from the day after its latest stored
// session to the last closed one, and a stock already holding that session is
// not requested at all. Stocks are taken stalest first, so a run that stops
// part way (a timeout, a refusing upstream) is resumed by the next run instead
// of being restarted from the top of the list. The service this replaced
// restarted from the top every day and never reached the end: it spent ~8s a
// stock re-fetching holiday closures as "gaps", and died with its 600s request.
func (m *SyncManager) RunWith(ctx context.Context, opts RunOptions) (*RunReport, error) {
	started := time.Now()
	lastClosed := lastClosedSession(m.now())
	report := &RunReport{DryRun: opts.DryRun, Codes: opts.Codes, LastSession: lastClosed.Format("2006-01-02"), Attempt: taskAttempt()}
	stats := newRunStats()
	ctx = withRunStats(ctx, stats)
	m.closeTolerance = closeTolerance(2)
	if !opts.From.IsZero() {
		m.closeTolerance = m.storedCloseTolerance(ctx)
	}
	if !opts.From.IsZero() {
		report.From = opts.From.Format("2006-01-02")
	}

	stocks, err := m.stocksFor(ctx, opts)
	if err != nil {
		return nil, err
	}
	blocked := map[string]bool{}
	if !opts.DryRun {
		// Safety net for environments without the migration.
		m.failureTracker.EnsureTable(ctx)
	}
	if len(opts.Codes) == 0 {
		blocked = m.failureTracker.GetBlockedSymbols(ctx)
	}
	latest, err := m.latestPriceDates(ctx, !opts.DryRun)
	if err != nil {
		return nil, fmt.Errorf("read latest stored sessions: %w", err)
	}
	if len(opts.Codes) == 0 {
		beyond := m.beyondListing(ctx, stocks, latest, lastClosed)
		stocks = append(stocks, beyond...)
		report.BeyondListing = len(beyond)
	}
	stocks = stalestFirst(stocks, latest)
	report.Stocks = len(stocks)

	priorityCount := stocklist.CountPriority(stocks)
	log.Printf("🚀 Price sync: %d stocks (%d priority, %d beyond the company listing, %d blocked), sessions through %s%s",
		len(stocks), priorityCount, report.BeyondListing, len(blocked), report.LastSession, opts.describe())

	runID := uuid.New().String()
	if !opts.DryRun {
		if err := m.checkpoint.StartRun(ctx, runID, len(stocks), priorityCount); err != nil {
			return nil, fmt.Errorf("failed to start run: %w", err)
		}
	}

	var (
		consecutive, priorityProcessed, processed int
		algoliaRecords                            []algolia.StockRecord
		runErr                                    error
	)
	for i, stock := range stocks {
		if err := ctx.Err(); err != nil {
			log.Printf("⏹️ Sync interrupted at %d/%d", i, len(stocks))
			runErr = err
			break
		}
		if elapsed := time.Since(started); opts.Budget > 0 && elapsed >= opts.Budget {
			log.Printf("⏹️ Run budget %s spent at %d/%d after %s", opts.Budget, i, len(stocks), elapsed.Round(time.Second))
			runErr = fmt.Errorf("stopped at %d/%d stocks after %s: %w (%s; the next attempt resumes from the stalest stock)",
				i, len(stocks), elapsed.Round(time.Second), ErrBudgetSpent, opts.Budget)
			break
		}
		processed = i + 1
		if stock.IsPriority {
			priorityProcessed++
		}
		if blocked[stock.Code] {
			report.Blocked++
			continue
		}

		began := time.Now()
		res, err := m.syncStockWithin(ctx, stock.Code, latest[stock.Code], lastClosed, opts)
		report.Fetched += res.fetched
		report.Written += res.written
		outcome := "failed"
		switch {
		case err == nil && res.upToDate:
			outcome = "up_to_date"
			report.UpToDate++
		case err == nil:
			outcome = "synced"
			consecutive = 0
			report.Synced++
			report.addDiff(res.diff)
			if !opts.DryRun {
				m.failureTracker.RecordSuccess(ctx, stock.Code)
			}
			if m.config.SyncAlgolia {
				algoliaRecords = append(algoliaRecords, algolia.StockRecord{ObjectID: stock.Code, StockCode: stock.Code})
			}
		case providers.IsNoDataError(err):
			consecutive = 0
			outcome = "no_data"
			if weekdaysIn(res.from, res.to) <= maxClosedWeekdays {
				outcome = "no_session"
				report.NoSession++
				log.Printf("⏭️ [%d/%d] %s: no session from %s to %s yet", i+1, len(stocks), stock.Code,
					res.from.Format("2006-01-02"), res.to.Format("2006-01-02"))
				break
			}
			report.NoData++
			report.NoDataCodes = appendCapped(report.NoDataCodes, stock.Code)
			log.Printf("⏭️ [%d/%d] %s: %v", i+1, len(stocks), stock.Code, err)
			if !opts.DryRun {
				m.failureTracker.RecordFailure(ctx, stock.Code, err.Error())
			}
		case ctx.Err() != nil:
			outcome = "interrupted"
			runErr = ctx.Err()
		default:
			consecutive++
			report.Failed++
			report.FailedCodes = appendCapped(report.FailedCodes, stock.Code)
			log.Printf("❌ [%d/%d] %s: %v", i+1, len(stocks), stock.Code, err)
			if consecutive >= maxConsecutiveFailures {
				runErr = fmt.Errorf("stopped after %d consecutive fetch failures, the last %s: %w (the next run resumes from the stalest stock)",
					consecutive, stock.Code, err)
			}
		}
		stats.stock(stock.Code, time.Since(began), outcome)
		if runErr != nil {
			break
		}

		if !opts.DryRun && (i+1)%25 == 0 {
			m.saveProgress(ctx, runID, i+1, report, priorityProcessed)
		}
		if (i+1)%snapshotEvery == 0 {
			m.snapshot(ctx, report, stats, started)
		}
	}

	if !opts.DryRun {
		m.saveProgress(ctx, runID, processed, report, priorityProcessed)
		if err := m.checkpoint.UpdatePricesCount(ctx, runID, report.Written); err != nil {
			log.Printf("⚠️ Failed to update prices count: %v", err)
		}
		if report.Written > 0 {
			if err := m.refreshStockPriceCoverage(ctx); err != nil {
				log.Printf("⚠️ Failed to refresh stock price coverage view: %v", err)
			}
		}
		if m.config.SyncAlgolia && len(algoliaRecords) > 0 {
			m.syncAlgolia(ctx, runID, algoliaRecords)
		}
		if runErr != nil {
			if err := m.checkpoint.FailRun(ctx, runID, runErr.Error()); err != nil {
				log.Printf("⚠️ Failed to mark run as failed: %v", err)
			}
		} else if err := m.checkpoint.CompleteRun(ctx, runID); err != nil {
			log.Printf("⚠️ Failed to mark run as complete: %v", err)
		}
	}

	report.Duration = time.Since(started).Round(time.Second).String()
	if runErr != nil {
		report.Error = runErr.Error()
	}
	report.InProgress = false
	stats.fill(report)
	report.log()
	// A cancelled context cannot carry the upload; the report is still logged.
	report.publish(context.WithoutCancel(ctx), m.gcs, m.config.GCSBucketName)
	return report, runErr
}

// syncStockWithin is syncStock under the stock's deadline, so that nothing one
// stock waits on (a provider, the database) can hold the rest of the run.
func (m *SyncManager) syncStockWithin(ctx context.Context, symbol string, latest, lastClosed time.Time, opts RunOptions) (stockResult, error) {
	limit := m.stockTimeout
	if limit <= 0 {
		limit = stockTimeout
	}
	stockCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	res, err := m.syncStock(stockCtx, symbol, latest, lastClosed, opts)
	if err != nil && ctx.Err() == nil && errors.Is(stockCtx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("no answer within %s: %w", limit, err)
	}
	return res, err
}

// snapshot publishes the report so far, marked in progress, so that a run that
// is killed, or is still going, can be read.
func (m *SyncManager) snapshot(ctx context.Context, report *RunReport, stats *runStats, started time.Time) {
	if ctx.Err() != nil {
		return
	}
	report.Duration = time.Since(started).Round(time.Second).String()
	report.InProgress = true
	stats.fill(report)
	report.publish(ctx, m.gcs, m.config.GCSBucketName)
}

// saveProgress writes the run's counters to its checkpoint row.
func (m *SyncManager) saveProgress(ctx context.Context, runID string, processed int, r *RunReport, priorityProcessed int) {
	successful := r.Synced + r.UpToDate
	skipped := r.NoSession + r.NoData + r.Blocked
	if err := m.checkpoint.UpdateProgress(ctx, runID, processed, successful, r.Failed, skipped, priorityProcessed); err != nil {
		log.Printf("⚠️ Failed to update progress: %v", err)
	}
}

// syncAlgolia pushes the synced stocks' enriched records to Algolia.
func (m *SyncManager) syncAlgolia(ctx context.Context, runID string, records []algolia.StockRecord) {
	log.Printf("🔍 Enriching %d Algolia records from company-metadata...", len(records))
	enriched, err := m.buildEnrichedAlgoliaRecords(ctx, records)
	if err != nil {
		log.Printf("⚠️ Failed to enrich Algolia records, using basic records: %v", err)
		enriched = records
	}
	count, err := m.algolia.SyncInBatches(ctx, enriched, 1000)
	if err != nil {
		log.Printf("⚠️ Algolia sync failed: %v", err)
		return
	}
	log.Printf("🔍 Synced %d records to Algolia", count)
	if err := m.checkpoint.UpdateAlgoliaCount(ctx, runID, count); err != nil {
		log.Printf("⚠️ Failed to update Algolia count: %v", err)
	}
}

// stocksFor is the run's stock list: the given codes, or every listed company
// with the top shorted first. RunWith adds the codes beyond the listing.
func (m *SyncManager) stocksFor(ctx context.Context, opts RunOptions) ([]stocklist.Stock, error) {
	if len(opts.Codes) > 0 {
		out := make([]stocklist.Stock, 0, len(opts.Codes))
		seen := make(map[string]bool, len(opts.Codes))
		for _, c := range opts.Codes {
			c = strings.ToUpper(strings.TrimSpace(c))
			if c != "" && !seen[c] {
				seen[c] = true
				out = append(out, stocklist.Stock{Code: c})
			}
		}
		return out, nil
	}
	list := m.stocklist.GetPrioritizedStocks
	if opts.DryRun {
		list = m.stocklist.GetPrioritizedStocksReadOnly
	}
	stocks, err := list(ctx, m.config.GCSBucketName, m.config.PriorityStockCount)
	if err != nil {
		return nil, fmt.Errorf("failed to get stock list: %w", err)
	}
	return stocks, nil
}

// latestPriceDates maps each stock to its latest stored session. Every window
// starts from it, so it has to be current: the coverage view is refreshed
// first (it lags whenever a run ends before its own refresh), and the table is
// read directly when the view cannot be refreshed, or must not be (a dry run).
func (m *SyncManager) latestPriceDates(ctx context.Context, refresh bool) (map[string]time.Time, error) {
	if refresh {
		err := m.refreshStockPriceCoverage(ctx)
		if err == nil {
			rows, qerr := m.db.Query(ctx, latestPriceDatesQuery)
			if qerr == nil {
				return scanLatestPriceDates(rows)
			}
			err = qerr
		}
		logCoverageFallback(err)
	}
	rows, err := m.db.Query(ctx, latestPriceDatesFallbackQuery)
	if err != nil {
		return nil, err
	}
	return scanLatestPriceDates(rows)
}

// stalestFirst orders stocks by their latest stored session, oldest first, so
// the stocks a stopped run never reached are the first the next run takes.
// Equal dates keep the list's order (top shorted first). Stocks with nothing
// stored go last: each costs a multi-year fetch.
func stalestFirst(stocks []stocklist.Stock, latest map[string]time.Time) []stocklist.Stock {
	out := append([]stocklist.Stock(nil), stocks...)
	sort.SliceStable(out, func(i, j int) bool {
		a, aStored := latest[out[i].Code]
		b, bStored := latest[out[j].Code]
		if aStored != bStored {
			return aStored
		}
		return a.Before(b)
	})
	return out
}

// SyncStock brings one stock up to the last closed session and returns the
// number of sessions written. It backs POST /api/sync/stock/{symbol}.
func (m *SyncManager) SyncStock(ctx context.Context, symbol string) (int, error) {
	var latest *time.Time
	if err := m.db.QueryRow(ctx, "SELECT MAX(date) FROM stock_prices WHERE stock_code = $1", symbol).Scan(&latest); err != nil {
		return 0, fmt.Errorf("read latest session for %s: %w", symbol, err)
	}
	var from time.Time
	if latest != nil {
		from = *latest
	}
	res, err := m.syncStock(ctx, symbol, from, lastClosedSession(m.now()), RunOptions{})
	return res.written, err
}

// stockResult is what one stock's sync did.
type stockResult struct {
	from, to time.Time // the window asked for
	upToDate bool      // the latest stored session is already the last closed one
	fetched  int       // sessions the provider returned in the window
	written  int       // sessions upserted (0 in a dry run)
	diff     priceDiff // provider against stored; with RunOptions.From only
}

// syncStock fetches one stock's window and upserts it.
//
// It does not look for gaps. The gap repair that used to run here flagged every
// holiday closure of four or more days (each Easter, each Christmas) as a gap
// and re-requested it, for every stock, on every run, forever: the provider has
// no session there to return, so the gap never closed. Gaps are the business
// of `audit-gaps`, `historical-backfill` and /api/gaps.
func (m *SyncManager) syncStock(ctx context.Context, symbol string, latest, lastClosed time.Time, opts RunOptions) (stockResult, error) {
	res := stockResult{to: lastClosed}
	switch {
	case !opts.From.IsZero():
		res.from = utcDate(opts.From)
	case latest.IsZero():
		res.from = lastClosed.AddDate(-newStockHistoryYears, 0, 0)
	default:
		res.from = utcDate(latest).AddDate(0, 0, 1)
	}
	if res.from.After(res.to) {
		res.upToDate = true
		return res, nil
	}

	records, err := m.fetch(ctx, symbol, res.from, res.to)
	if err != nil {
		return res, err
	}
	records = sessionsIn(symbol, records, res.from, res.to)
	if len(records) == 0 {
		return res, providers.NewNoDataError(symbol, fmt.Sprintf("no sessions from %s to %s",
			res.from.Format("2006-01-02"), res.to.Format("2006-01-02")))
	}
	res.fetched = len(records)

	if !opts.From.IsZero() {
		stored, err := m.storedSessions(ctx, symbol, res.from, res.to)
		if err != nil {
			return res, err
		}
		res.diff = comparePrices(symbol, records, stored, m.closeTolerance)
	}
	if opts.DryRun {
		log.Printf("🔎 %s: %d sessions %s to %s (dry run: not written)", symbol, len(records),
			records[0].Date.Format("2006-01-02"), records[len(records)-1].Date.Format("2006-01-02"))
		return res, nil
	}
	if err := m.upsertRecords(ctx, symbol, records); err != nil {
		return res, err
	}
	res.written = len(records)
	log.Printf("✅ %s: %d sessions %s to %s", symbol, len(records),
		records[0].Date.Format("2006-01-02"), records[len(records)-1].Date.Format("2006-01-02"))
	return res, nil
}

// fetch asks the providers in order and returns the first one's sessions.
//
// A provider answering "no data" ends the chain: that is an answer (a holiday, a
// halt, a delisting), and asking the next provider for a session that did not
// happen is how #583 wrote NASDAQ's AMD over ASX:AMD, because Alpha Vantage
// answers an ASX code it does not carry with the US security of the same name.
// The next provider is asked only when one FAILS to answer (a 429, a 5xx, a
// timeout), and a "no data" from it then does not make the stock a no-data
// strike, because the primary never said so.
func (m *SyncManager) fetch(ctx context.Context, symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
	var failures []error
	for _, p := range m.providers {
		if err := m.pace(ctx, p); err != nil {
			return nil, err
		}
		began := time.Now()
		records, err := p.FetchHistoricalData(ctx, symbol, from, to)
		runStatsFrom(ctx).request(p.Name(), time.Since(began), len(records), err)
		switch {
		case err == nil && len(records) > 0:
			return records, nil
		case err == nil || providers.IsNoDataError(err):
			if err == nil {
				err = providers.NewNoDataError(symbol, p.Name()+" returned no sessions")
			}
			if len(failures) > 0 {
				log.Printf("⚠️ %s: %s: %v", symbol, p.Name(), err)
				return nil, errors.Join(failures...)
			}
			return nil, err
		case ctx.Err() != nil:
			return nil, ctx.Err()
		default:
			log.Printf("⚠️ %s: %s failed: %v", symbol, p.Name(), err)
			failures = append(failures, fmt.Errorf("%s: %w", p.Name(), err))
		}
	}
	if len(failures) == 0 {
		return nil, errors.New("no price provider configured")
	}
	return nil, errors.Join(failures...)
}

// pace holds each provider to its rate limit, measured between the starts of
// consecutive requests to it. The loop used to sleep the limit before every
// request AND again between stocks, including stocks it made no request for.
func (m *SyncManager) pace(ctx context.Context, p providers.DataProvider) error {
	m.paceMu.Lock()
	if m.nextCall == nil {
		m.nextCall = make(map[string]time.Time)
	}
	wait := time.Until(m.nextCall[p.Name()])
	m.nextCall[p.Name()] = time.Now().Add(max(wait, 0) + p.GetRateLimit())
	m.paceMu.Unlock()

	if wait <= 0 {
		return nil
	}
	runStatsFrom(ctx).wait(wait)
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// sessionsIn keeps one record per session inside [from, to], sorted, and drops
// weekend-dated records: the ASX does not trade then, so one is a provider's
// date arithmetic gone wrong (the UTC conversion that filed Monday under
// Sunday), never a session.
func sessionsIn(symbol string, records []providers.PriceRecord, from, to time.Time) []providers.PriceRecord {
	byDate := make(map[time.Time]providers.PriceRecord, len(records))
	for _, r := range records {
		r.Date = utcDate(r.Date)
		switch {
		case r.Date.Before(from) || r.Date.After(to):
			continue
		case r.Date.Weekday() == time.Saturday || r.Date.Weekday() == time.Sunday:
			log.Printf("⚠️ %s: dropping a %s-dated record (%s): not an ASX session", symbol, r.Date.Weekday(), r.Date.Format("2006-01-02"))
			continue
		}
		byDate[r.Date] = r // a later duplicate wins, as the row-at-a-time upsert did
	}
	out := make([]providers.PriceRecord, 0, len(byDate))
	for _, r := range byDate {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date.Before(out[j].Date) })
	return out
}

// storedSessions reads the stored closes in [from, to].
func (m *SyncManager) storedSessions(ctx context.Context, symbol string, from, to time.Time) (map[time.Time]storedSession, error) {
	rows, err := m.db.Query(ctx,
		`SELECT date, close::float8 FROM stock_prices WHERE stock_code = $1 AND date BETWEEN $2::date AND $3::date`,
		symbol, from.Format("2006-01-02"), to.Format("2006-01-02"))
	if err != nil {
		return nil, fmt.Errorf("read stored sessions for %s: %w", symbol, err)
	}
	defer rows.Close()
	out := make(map[time.Time]storedSession)
	for rows.Next() {
		var d time.Time
		var s storedSession
		if err := rows.Scan(&d, &s.close); err != nil {
			return nil, fmt.Errorf("scan stored session for %s: %w", symbol, err)
		}
		out[utcDate(d)] = s
	}
	return out, rows.Err()
}

// buildEnrichedAlgoliaRecords queries company-metadata to populate all enriched fields
// for Algolia records, ensuring the Go syncer produces the same rich data as the TS sync script.
func (m *SyncManager) buildEnrichedAlgoliaRecords(ctx context.Context, basicRecords []algolia.StockRecord) ([]algolia.StockRecord, error) {
	// Collect stock codes
	codes := make([]string, len(basicRecords))
	for i, r := range basicRecords {
		codes[i] = r.StockCode
	}

	query := `
		WITH latest_shorts AS (
			SELECT DISTINCT ON ("PRODUCT_CODE")
				"PRODUCT_CODE" as product_code,
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted
			FROM shorts
			ORDER BY "PRODUCT_CODE", "DATE" DESC
		)
		SELECT
			m.stock_code,
			COALESCE(m.company_name, '') as company_name,
			COALESCE(m.industry, '') as industry,
			COALESCE(m.summary, '') as summary,
			COALESCE(m.details, '') as details,
			COALESCE(m.enhanced_summary, '') as enhanced_summary,
			COALESCE(m.company_history, '') as company_history,
			COALESCE(m.competitive_advantages, '') as competitive_advantages,
			COALESCE(m.risk_factors, '') as risk_factors,
			COALESCE(m.recent_developments, '') as recent_developments,
			COALESCE(m.tags, ARRAY[]::text[]) as tags,
			COALESCE(m.logo_gcs_url, '') as logo_gcs_url,
			COALESCE(m.website, '') as website,
			COALESCE(m.address, '') as address,
			COALESCE(m.market_cap, '') as market_cap,
			COALESCE(s.percentage_shorted, 0) as percentage_shorted,
			COALESCE(m.key_people, '[]'::jsonb) as key_people,
			COALESCE(m.key_metrics, '{}'::jsonb) as key_metrics
		FROM "company-metadata" m
		LEFT JOIN latest_shorts s ON m.stock_code = s.product_code
		WHERE m.stock_code = ANY($1)
	`

	rows, err := m.db.Query(ctx, query, codes)
	if err != nil {
		return nil, fmt.Errorf("failed to query enriched metadata: %w", err)
	}
	defer rows.Close()

	enriched := make(map[string]algolia.StockRecord, len(codes))
	for rows.Next() {
		var (
			stockCode, companyName, industry, summary, details     string
			enhancedSummary, companyHistory, competitiveAdvantages string
			riskFactors, recentDevelopments                        string
			logoGCSURL, website, address, marketCap                string
			percentageShorted                                      float64
			tags                                                   []string
			keyPeopleJSON, keyMetricsJSON                          []byte
		)

		if err := rows.Scan(
			&stockCode, &companyName, &industry, &summary, &details,
			&enhancedSummary, &companyHistory, &competitiveAdvantages,
			&riskFactors, &recentDevelopments, &tags, &logoGCSURL,
			&website, &address, &marketCap, &percentageShorted,
			&keyPeopleJSON, &keyMetricsJSON,
		); err != nil {
			log.Printf("⚠️ Failed to scan enriched record: %v", err)
			continue
		}

		// Parse key_people
		var keyPeople []struct {
			Name string `json:"name"`
			Role string `json:"role"`
		}
		_ = json.Unmarshal(keyPeopleJSON, &keyPeople)

		names := make([]string, 0, len(keyPeople))
		roles := make([]string, 0, len(keyPeople))
		for _, p := range keyPeople {
			if p.Name != "" {
				names = append(names, p.Name)
				role := strings.TrimSpace(p.Name + " " + p.Role)
				if role != "" {
					roles = append(roles, role)
				}
			}
		}

		// Parse key_metrics
		var keyMetrics map[string]json.RawMessage
		_ = json.Unmarshal(keyMetricsJSON, &keyMetrics)

		parseMetric := func(raw json.RawMessage) *float64 {
			if raw == nil {
				return nil
			}
			var f float64
			if err := json.Unmarshal(raw, &f); err == nil {
				return &f
			}
			// Try as string
			var s string
			if err := json.Unmarshal(raw, &s); err == nil {
				var val float64
				if _, err := fmt.Sscanf(s, "%f", &val); err == nil {
					return &val
				}
			}
			return nil
		}

		rec := algolia.StockRecord{
			ObjectID:              stockCode,
			StockCode:             stockCode,
			CompanyName:           companyName,
			Industry:              industry,
			Tags:                  tags,
			Summary:               summary,
			EnhancedSummary:       enhancedSummary,
			CompanyHistory:        companyHistory,
			CompetitiveAdvantages: competitiveAdvantages,
			RiskFactors:           riskFactors,
			RecentDevelopments:    recentDevelopments,
			Details:               details,
			KeyPeopleNames:        strings.Join(names, ", "),
			KeyPeopleRoles:        roles,
			LogoGCSURL:            logoGCSURL,
			PercentageShorted:     percentageShorted,
			Website:               website,
			Address:               address,
			MarketCap:             marketCap,
			PERatio:               parseMetric(keyMetrics["pe_ratio"]),
			EPS:                   parseMetric(keyMetrics["eps"]),
			DividendYield:         parseMetric(keyMetrics["dividend_yield"]),
		}

		enriched[stockCode] = rec
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating enriched records: %w", err)
	}

	// Build final list — use enriched if available, fall back to basic
	result := make([]algolia.StockRecord, 0, len(basicRecords))
	for _, basic := range basicRecords {
		if rec, ok := enriched[basic.StockCode]; ok {
			result = append(result, rec)
		} else {
			result = append(result, basic)
		}
	}

	return result, nil
}

// upsertPricesSQL writes one stock's sessions in one statement. Dates travel
// as text and are cast by the database, so a session is stored under exactly
// the date the provider gave it, whatever the connection's TimeZone.
const upsertPricesSQL = `
	INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
	SELECT $1, t.date, t.open, t.high, t.low, t.close, t.adjusted_close, t.volume
	FROM unnest($2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::int8[])
		AS t(date, open, high, low, close, adjusted_close, volume)
	ON CONFLICT (stock_code, date) DO UPDATE SET
		open = EXCLUDED.open,
		high = EXCLUDED.high,
		low = EXCLUDED.low,
		close = EXCLUDED.close,
		adjusted_close = EXCLUDED.adjusted_close,
		volume = EXCLUDED.volume,
		updated_at = CURRENT_TIMESTAMP`

// upsertRecords writes one stock's sessions, at most one per date (see
// sessionsIn), in a single round trip. It used to be a statement per row, which
// a five-week catch-up across the market makes ~50,000 pooler round trips.
func (m *SyncManager) upsertRecords(ctx context.Context, symbol string, records []providers.PriceRecord) error {
	n := len(records)
	dates := make([]string, n)
	opens, highs, lows := make([]float64, n), make([]float64, n), make([]float64, n)
	closes, adjusted := make([]float64, n), make([]float64, n)
	volumes := make([]int64, n)
	for i, r := range records {
		dates[i] = r.Date.Format("2006-01-02")
		opens[i], highs[i], lows[i] = r.Open, r.High, r.Low
		closes[i], adjusted[i] = r.Close, r.AdjustedClose
		volumes[i] = r.Volume
	}
	if _, err := m.db.Exec(ctx, upsertPricesSQL, symbol, dates, opens, highs, lows, closes, adjusted, volumes); err != nil {
		return fmt.Errorf("upsert %d sessions for %s: %w", n, symbol, err)
	}
	return nil
}
