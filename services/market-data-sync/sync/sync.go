package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
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
	db             *pgxpool.Pool
	gcs            *storage.Client
	config         *config.Config
	checkpoint     *checkpoint.Store
	stocklist      *stocklist.Service
	algolia        *algolia.Syncer
	providers      []providers.DataProvider
	gapDetector    *GapDetector
	failureTracker *FailureTracker
}

// NewSyncManager creates a new SyncManager with all dependencies
func NewSyncManager(
	db *pgxpool.Pool,
	gcs *storage.Client,
	cfg *config.Config,
	dataProviders []providers.DataProvider,
) *SyncManager {
	ft := NewFailureTracker(db)
	return &SyncManager{
		db:             db,
		gcs:            gcs,
		config:         cfg,
		checkpoint:     checkpoint.NewStore(db),
		stocklist:      stocklist.New(db, gcs),
		algolia:        algolia.New(cfg.AlgoliaAppID, cfg.AlgoliaAdminKey, cfg.AlgoliaIndex),
		providers:      dataProviders,
		gapDetector:    NewGapDetector(db, dataProviders),
		failureTracker: ft,
	}
}

// Run executes the full sync process with prioritization
func (m *SyncManager) Run(ctx context.Context) error {
	// 1. Get prioritized stock list from GCS + DB
	stocks, err := m.stocklist.GetPrioritizedStocks(ctx, m.config.GCSBucketName, m.config.PriorityStockCount)
	if err != nil {
		return fmt.Errorf("failed to get stock list: %w", err)
	}

	// Ensure failure tracking table exists (safety net for environments without migration)
	m.failureTracker.EnsureTable(ctx)

	// Load blocked symbols upfront for efficient filtering
	blockedSymbols := m.failureTracker.GetBlockedSymbols(ctx)
	if len(blockedSymbols) > 0 {
		log.Printf("🚫 %d symbols blocked due to repeated failures (will retry after block period)", len(blockedSymbols))
	}

	// Prefetch the latest stored date per stock in ONE query, replacing a
	// per-stock SELECT MAX(date) inside the loop below (the N+1 — this was
	// ~992k calls over the DB's lifetime). Falls back to per-stock lookups.
	latestDates, err := m.getLatestPriceDates(ctx)
	if err != nil {
		log.Printf("⚠️ Failed to prefetch latest price dates (%v); falling back to per-stock lookup", err)
		latestDates = nil
	}

	priorityCount := stocklist.CountPriority(stocks)
	log.Printf("🚀 Syncing %d stocks (%d priority, %d remaining, %d blocked)",
		len(stocks), priorityCount, len(stocks)-priorityCount, len(blockedSymbols))

	// 2. Start checkpoint - generate UUID for run ID
	runID := uuid.New().String()
	if err := m.checkpoint.StartRun(ctx, runID, len(stocks), priorityCount); err != nil {
		return fmt.Errorf("failed to start run: %w", err)
	}

	// 3. Process stocks
	successful, failed, skipped := 0, 0, 0
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

		// Skip blocked symbols (known-bad Yahoo Finance symbols)
		if blockedSymbols[stock.Code] {
			skipped++
			continue
		}

		recordsAdded, err := m.syncStock(ctx, stock.Code, latestDates)
		if err != nil {
			if providers.IsNoDataError(err) {
				log.Printf("⏭️ [%d/%d] Skipped %s (no data): %v", i+1, len(stocks), stock.Code, err)
				skipped++
				// Record the failure — after enough consecutive failures, the symbol will be auto-blocked
				m.failureTracker.RecordFailure(ctx, stock.Code, err.Error())
			} else {
				log.Printf("❌ [%d/%d] Failed to sync %s: %v", i+1, len(stocks), stock.Code, err)
				failed++
			}
		} else {
			successful++
			pricesUpdated += recordsAdded

			// Reset failure counter on success
			m.failureTracker.RecordSuccess(ctx, stock.Code)

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
			if err := m.checkpoint.UpdateProgress(ctx, runID, i+1, successful, failed, skipped, priorityProcessed); err != nil {
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

	if pricesUpdated > 0 {
		if err := m.refreshStockPriceCoverage(ctx); err != nil {
			log.Printf("⚠️ Failed to refresh stock price coverage view: %v", err)
		}
	}

	// 4. Sync Algolia if enabled — fetch enriched metadata from DB
	if m.config.SyncAlgolia && len(algoliaRecords) > 0 {
		log.Printf("🔍 Enriching %d Algolia records from company-metadata...", len(algoliaRecords))
		enrichedRecords, err := m.buildEnrichedAlgoliaRecords(ctx, algoliaRecords)
		if err != nil {
			log.Printf("⚠️ Failed to enrich Algolia records, using basic records: %v", err)
			enrichedRecords = algoliaRecords
		} else {
			log.Printf("🔍 Enriched %d records with metadata", len(enrichedRecords))
		}

		log.Printf("🔍 Starting Algolia sync for %d records...", len(enrichedRecords))
		count, err := m.algolia.SyncInBatches(ctx, enrichedRecords, 1000)
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

	log.Printf("🎉 Sync complete: %d successful, %d failed, %d skipped (no data), %d price records", successful, failed, skipped, pricesUpdated)
	return nil
}

// getLatestPriceDates returns the most recent stored date per stock_code in a
// single GROUP BY query, replacing the per-stock SELECT MAX(date) N+1.
func (m *SyncManager) getLatestPriceDates(ctx context.Context) (map[string]time.Time, error) {
	rows, err := m.db.Query(ctx, latestPriceDatesQuery)
	if err != nil {
		logCoverageFallback(err)
		rows, err = m.db.Query(ctx, latestPriceDatesFallbackQuery)
		if err != nil {
			return nil, err
		}
	}

	return scanLatestPriceDates(rows)
}

// SyncStock syncs price data for a single stock, returns number of records added
// This is a public method that can be called from the API
func (m *SyncManager) SyncStock(ctx context.Context, symbol string) (int, error) {
	return m.syncStock(ctx, symbol, nil)
}

// syncStock syncs price data for a single stock, returns number of records added.
// latestDates is an optional prefetched stock_code -> latest stored date map
// (built once per Run) to avoid a per-stock SELECT MAX(date) N+1; pass nil for
// the single-stock API path to look it up directly.
func (m *SyncManager) syncStock(ctx context.Context, symbol string, latestDates map[string]time.Time) (int, error) {
	totalRecords := 0

	// STEP 1: Check for gaps FIRST - this determines if we need to sync even if "up to date"
	gaps := m.detectGapsQuietly(ctx, symbol)
	hasGaps := len(gaps) > 0

	// STEP 2: Determine the stock's latest stored date.
	var latestDate time.Time
	if latestDates != nil {
		latestDate = latestDates[symbol] // zero value when absent → treated as a new stock
	} else {
		_ = m.db.QueryRow(ctx, "SELECT MAX(date) FROM stock_prices WHERE stock_code = $1", symbol).Scan(&latestDate)
	}

	startDate := time.Now().AddDate(-10, 0, 0) // Default 10 years of history
	isNewStock := true
	if !latestDate.IsZero() {
		startDate = latestDate.AddDate(0, 0, 1)
		isNewStock = false
	}

	// Adjust endDate: use end of yesterday if requesting today's data
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	endDate := now

	// Determine sync status
	needsNewData := startDate.Before(today) || startDate.Equal(today)
	isUpToDate := !needsNewData && !isNewStock

	// Log sync decision with context
	if hasGaps {
		log.Printf("🔍 %s: Found %d gap(s) to repair", symbol, len(gaps))
	}

	if isUpToDate && !hasGaps {
		log.Printf("⏭️ %s: Up to date (latest: %s), no gaps", symbol, latestDate.Format("2006-01-02"))
		return 0, nil
	}

	if isUpToDate && hasGaps {
		log.Printf("🔧 %s: Up to date but has %d gap(s) - repairing", symbol, len(gaps))
		gapRecords := m.repairGaps(ctx, symbol, gaps)
		return gapRecords, nil
	}

	// If startDate is today, adjust endDate to yesterday
	if !startDate.Before(today) {
		endDate = today.AddDate(0, 0, -1).Add(23*time.Hour + 59*time.Minute + 59*time.Second)
	}

	// STEP 3: Fetch new incremental data
	if needsNewData || isNewStock {
		log.Printf("📥 %s: Fetching data from %s to %s", symbol, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))

		var records []providers.PriceRecord
		var syncErr error
		for _, p := range m.providers {
			// Rate limiting
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-time.After(p.GetRateLimit()):
			}

			records, syncErr = p.FetchHistoricalData(ctx, symbol, startDate, endDate)
			if syncErr == nil && len(records) > 0 {
				log.Printf("✅ %s: Fetched %d new records from %s", symbol, len(records), p.Name())
				break
			}
			if syncErr != nil {
				log.Printf("⚠️ %s: Provider %s failed: %v", symbol, p.Name(), syncErr)
			}
		}

		if len(records) > 0 {
			if err := m.upsertRecords(ctx, records); err != nil {
				return 0, err
			}
			totalRecords += len(records)
		} else if !hasGaps {
			// No new records and no gaps to repair — likely a delisted stock
			return 0, providers.NewNoDataError(symbol, "all providers returned no data")
		}
	}

	// STEP 4: Repair gaps (if any were detected earlier)
	if hasGaps {
		gapRecords := m.repairGaps(ctx, symbol, gaps)
		totalRecords += gapRecords
	}

	return totalRecords, nil
}

// detectGapsQuietly checks for gaps without logging (used for initial assessment)
func (m *SyncManager) detectGapsQuietly(ctx context.Context, symbol string) []Gap {
	if m.gapDetector == nil {
		return nil
	}

	gaps, err := m.gapDetector.DetectGaps(ctx, symbol, 4)
	if err != nil {
		return nil
	}
	return gaps
}

// repairGaps repairs the given gaps and returns the number of records added
func (m *SyncManager) repairGaps(ctx context.Context, symbol string, gaps []Gap) int {
	if len(gaps) == 0 {
		return 0
	}

	totalRepaired := 0
	for _, gap := range gaps {
		log.Printf("   🔧 Repairing gap: %s to %s (%d days)",
			gap.StartDate.Format("2006-01-02"),
			gap.EndDate.Format("2006-01-02"),
			gap.Days)

		repaired, err := m.gapDetector.RepairGap(ctx, gap)
		if err != nil {
			log.Printf("   ⚠️ Failed to repair gap: %v", err)
			continue
		}
		totalRepaired += repaired
		log.Printf("   ✅ Repaired %d records", repaired)
	}

	return totalRepaired
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
