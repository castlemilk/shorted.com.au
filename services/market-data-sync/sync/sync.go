package sync

import (
	"context"
	"fmt"
	"log"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/algolia"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/stocklist"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SyncManager coordinates the market data sync process
type SyncManager struct {
	db          *pgxpool.Pool
	gcs         *storage.Client
	config      *config.Config
	checkpoint  *checkpoint.Store
	stocklist   *stocklist.Service
	algolia     *algolia.Syncer
	providers   []providers.DataProvider
	gapDetector *GapDetector
}

// NewSyncManager creates a new SyncManager with all dependencies
func NewSyncManager(
	db *pgxpool.Pool,
	gcs *storage.Client,
	cfg *config.Config,
	dataProviders []providers.DataProvider,
) *SyncManager {
	return &SyncManager{
		db:          db,
		gcs:         gcs,
		config:      cfg,
		checkpoint:  checkpoint.NewStore(db),
		stocklist:   stocklist.New(db, gcs),
		algolia:     algolia.New(cfg.AlgoliaAppID, cfg.AlgoliaAdminKey, cfg.AlgoliaIndex),
		providers:   dataProviders,
		gapDetector: NewGapDetector(db, dataProviders),
	}
}

// Run executes the full sync process with prioritization
func (m *SyncManager) Run(ctx context.Context) error {
	// 1. Get prioritized stock list from GCS + DB
	stocks, err := m.stocklist.GetPrioritizedStocks(ctx, m.config.GCSBucketName, m.config.PriorityStockCount)
	if err != nil {
		return fmt.Errorf("failed to get stock list: %w", err)
	}

	priorityCount := stocklist.CountPriority(stocks)
	log.Printf("🚀 Syncing %d stocks (%d priority, %d remaining)",
		len(stocks), priorityCount, len(stocks)-priorityCount)

	// 2. Start checkpoint - generate UUID for run ID
	runID := uuid.New().String()
	if err := m.checkpoint.StartRun(ctx, runID, len(stocks), priorityCount); err != nil {
		return fmt.Errorf("failed to start run: %w", err)
	}

	// 3. Process stocks
	successful, failed := 0, 0
	priorityProcessed := 0
	pricesUpdated := 0
	var algoliaRecords []algolia.StockRecord

	for i, stock := range stocks {
		select {
		case <-ctx.Done():
			log.Printf("⏹️ Sync interrupted at %d/%d", i, len(stocks))
			return ctx.Err()
		default:
		}

		recordsAdded, err := m.syncStock(ctx, stock.Code)
		if err != nil {
			log.Printf("❌ [%d/%d] Failed to sync %s: %v", i+1, len(stocks), stock.Code, err)
			failed++
		} else {
			successful++
			pricesUpdated += recordsAdded

			// Collect for Algolia sync if enabled
			if m.config.SyncAlgolia {
				algoliaRecords = append(algoliaRecords, algolia.StockRecord{
					ObjectID:  stock.Code,
					StockCode: stock.Code,
				})
			}
		}

		if stock.IsPriority {
			priorityProcessed++
		}

		// Update checkpoint every 10 stocks or at the end
		if (i+1)%10 == 0 || (i+1) == len(stocks) {
			if err := m.checkpoint.UpdateProgress(ctx, runID, i+1, successful, failed, priorityProcessed); err != nil {
				log.Printf("⚠️ Failed to update progress: %v", err)
			}
		}

		// Log priority completion milestone
		if priorityProcessed == priorityCount && stock.IsPriority {
			log.Printf("✅ Priority stocks completed: %d/%d synced successfully", priorityProcessed, priorityCount)
		}

		// Rate limiting: Wait between stocks to be respectful to APIs
		// The syncStock function already waits before API calls, but we add a small
		// additional delay between stocks to ensure we're being extra respectful
		// This prevents rapid-fire requests even if individual calls are rate-limited
		if i < len(stocks)-1 { // Don't wait after the last stock
			if len(m.providers) > 0 {
				// Use a conservative delay: the provider's rate limit ensures spacing
				// We already waited in syncStock, so this is just a small buffer
				rateLimit := m.providers[0].GetRateLimit()
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(rateLimit):
					// Log every 10 stocks to show progress without spamming
					if (i+1)%10 == 0 {
						log.Printf("⏳ Rate limiting: %d/%d stocks processed (waiting %v between stocks)", i+1, len(stocks), rateLimit)
					}
				}
			}
		}
	}

	// Update prices count
	if err := m.checkpoint.UpdatePricesCount(ctx, runID, pricesUpdated); err != nil {
		log.Printf("⚠️ Failed to update prices count: %v", err)
	}

	// 4. Sync Algolia if enabled
	if m.config.SyncAlgolia && len(algoliaRecords) > 0 {
		log.Printf("🔍 Starting Algolia sync for %d records...", len(algoliaRecords))
		count, err := m.algolia.SyncInBatches(ctx, algoliaRecords, 1000)
		if err != nil {
			log.Printf("⚠️ Algolia sync failed: %v", err)
		} else {
			log.Printf("🔍 Synced %d records to Algolia", count)
			if err := m.checkpoint.UpdateAlgoliaCount(ctx, runID, count); err != nil {
				log.Printf("⚠️ Failed to update Algolia count: %v", err)
			}
		}
	}

	// 5. Complete the run
	if err := m.checkpoint.CompleteRun(ctx, runID); err != nil {
		log.Printf("⚠️ Failed to mark run as complete: %v", err)
	}

	log.Printf("🎉 Sync complete: %d successful, %d failed, %d price records", successful, failed, pricesUpdated)
	return nil
}

// SyncStock syncs price data for a single stock, returns number of records added
// This is a public method that can be called from the API
func (m *SyncManager) SyncStock(ctx context.Context, symbol string) (int, error) {
	return m.syncStock(ctx, symbol)
}

// syncStock syncs price data for a single stock, returns number of records added
func (m *SyncManager) syncStock(ctx context.Context, symbol string) (int, error) {
	totalRecords := 0

	// Check if stock exists and its latest date
	var latestDate time.Time
	err := m.db.QueryRow(ctx, "SELECT MAX(date) FROM stock_prices WHERE stock_code = $1", symbol).Scan(&latestDate)

	startDate := time.Now().AddDate(-10, 0, 0) // Default 10 years of history
	if err == nil && !latestDate.IsZero() {
		startDate = latestDate.AddDate(0, 0, 1)
	}

	// Adjust endDate: use end of yesterday if requesting today's data
	// This handles cases where today's data isn't available yet (market not closed, weekend, etc.)
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	endDate := now
	
	// If startDate is today or later, we're trying to fetch today's data
	// But Yahoo Finance may only have data up to yesterday, so adjust endDate accordingly
	if !startDate.Before(today) {
		// If startDate is tomorrow or later, we're already up to date
		if startDate.After(today) {
			log.Printf("⏭️ %s already up to date (latest: %s)", symbol, latestDate.Format("2006-01-02"))
			// Even if up to date, check for gaps
			gapRecords, _ := m.repairGapsIfNeeded(ctx, symbol)
			return gapRecords, nil
		}
		// We're requesting today's data - use end of yesterday as the effective end date
		// This allows the provider to return yesterday's data if today isn't available
		endDate = today.AddDate(0, 0, -1).Add(23*time.Hour + 59*time.Minute + 59*time.Second)
	}

	// Try providers in order
	var records []providers.PriceRecord
	var syncErr error
	for _, p := range m.providers {
		// Always wait before making API call (rate limiting)
		// This ensures we're respectful to the API even on the first provider
		// For subsequent providers, this also ensures spacing between attempts
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(p.GetRateLimit()):
		}

		records, syncErr = p.FetchHistoricalData(ctx, symbol, startDate, endDate)
		if syncErr == nil && len(records) > 0 {
			log.Printf("✅ %s: Fetched %d records from %s", symbol, len(records), p.Name())
			// Success! The rate limit delay before this call ensures proper spacing
			// No need to wait again - the main loop will handle spacing between stocks
			break
		}
		if syncErr != nil {
			log.Printf("⚠️ %s: Provider %s failed: %v", symbol, p.Name(), syncErr)
		}
		// If this wasn't the last provider, the next iteration will wait before calling it
		// No additional wait needed here - the loop's initial wait handles it
	}

	if len(records) == 0 {
		// Even if no new records, check for and repair gaps
		gapRecords, _ := m.repairGapsIfNeeded(ctx, symbol)
		if gapRecords > 0 {
			return gapRecords, nil
		}
		return 0, fmt.Errorf("no data found for %s", symbol)
	}

	// Upsert records
	if err := m.upsertRecords(ctx, records); err != nil {
		return 0, err
	}
	totalRecords += len(records)

	// Check for and repair any gaps in the data
	gapRecords, _ := m.repairGapsIfNeeded(ctx, symbol)
	totalRecords += gapRecords

	return totalRecords, nil
}

// repairGapsIfNeeded checks for gaps and repairs them
// Returns number of records added from gap repair
func (m *SyncManager) repairGapsIfNeeded(ctx context.Context, symbol string) (int, error) {
	// Skip gap detection if detector is not initialized
	if m.gapDetector == nil {
		return 0, nil
	}

	// Detect gaps (minGapDays=4 to account for weekends)
	gaps, err := m.gapDetector.DetectGaps(ctx, symbol, 4)
	if err != nil {
		log.Printf("⚠️ %s: Failed to detect gaps: %v", symbol, err)
		return 0, err
	}

	if len(gaps) == 0 {
		return 0, nil
	}

	log.Printf("🔧 %s: Found %d gaps, attempting repair...", symbol, len(gaps))

	// Repair gaps
	totalRepaired := 0
	for _, gap := range gaps {
		repaired, err := m.gapDetector.RepairGap(ctx, gap)
		if err != nil {
			log.Printf("⚠️ %s: Failed to repair gap (%s to %s): %v",
				symbol, gap.StartDate.Format("2006-01-02"), gap.EndDate.Format("2006-01-02"), err)
			continue
		}
		totalRepaired += repaired
	}

	if totalRepaired > 0 {
		log.Printf("✅ %s: Repaired %d gap records", symbol, totalRepaired)
	}

	return totalRepaired, nil
}

// upsertRecords inserts or updates price records in the database
func (m *SyncManager) upsertRecords(ctx context.Context, records []providers.PriceRecord) error {
	for _, r := range records {
		_, err := m.db.Exec(ctx, `
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
		`, r.StockCode, r.Date, r.Open, r.High, r.Low, r.Close, r.AdjustedClose, r.Volume)
		if err != nil {
			return fmt.Errorf("failed to upsert record for %s on %s: %w", r.StockCode, r.Date, err)
		}
	}
	return nil
}
