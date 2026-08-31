package shorts

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"golang.org/x/sync/singleflight"
)

// CacheEntry represents a cached value with expiration
type CacheEntry struct {
	Value     interface{}
	ExpiresAt time.Time
}

// IsExpired checks if the cache entry has expired
func (e *CacheEntry) IsExpired() bool {
	return time.Now().After(e.ExpiresAt)
}

// MemoryCache is a simple in-memory cache implementation
type MemoryCache struct {
	mu     sync.RWMutex
	store  map[string]*CacheEntry
	maxAge time.Duration
	done   chan struct{}
	sf     singleflight.Group // Deduplicates concurrent computations for the same key
}

// NewMemoryCache creates a new memory cache with the specified max age
func NewMemoryCache(maxAge time.Duration) *MemoryCache {
	cache := &MemoryCache{
		store:  make(map[string]*CacheEntry),
		maxAge: maxAge,
		done:   make(chan struct{}),
	}

	// Start cleanup goroutine
	go cache.cleanup()

	return cache
}

// Close stops the cleanup goroutine and releases resources
func (c *MemoryCache) Close() {
	close(c.done)
}

// generateKey creates a cache key from the given parameters using SHA-256
func (c *MemoryCache) generateKey(prefix string, params ...interface{}) string {
	data, err := json.Marshal(params)
	if err != nil {
		// Fallback to a simple string representation if JSON marshal fails
		data = []byte(fmt.Sprintf("%v", params))
	}
	hash := sha256.Sum256(data)
	return fmt.Sprintf("%s:%x", prefix, hash)
}

// Get retrieves a value from the cache
func (c *MemoryCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, exists := c.store[key]
	if !exists || entry.IsExpired() {
		return nil, false
	}

	return entry.Value, true
}

// Set stores a value in the cache
func (c *MemoryCache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.store[key] = &CacheEntry{
		Value:     value,
		ExpiresAt: time.Now().Add(c.maxAge),
	}
}

// GetOrSet retrieves a value from cache or computes it using the provided function.
// Uses singleflight to deduplicate concurrent computations for the same key,
// preventing thundering herd problems under burst traffic.
func (c *MemoryCache) GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error) {
	// Try to get from cache first
	if value, found := c.Get(key); found {
		return value, nil
	}

	// Use singleflight to ensure only one goroutine computes the value
	// for a given key at a time. Other concurrent callers will wait and
	// share the result.
	value, err, _ := c.sf.Do(key, func() (interface{}, error) {
		// Double-check cache inside singleflight (another goroutine may
		// have populated it while we were waiting)
		if v, found := c.Get(key); found {
			return v, nil
		}

		v, err := computeFn()
		if err != nil {
			return nil, err
		}

		c.Set(key, v)
		return v, nil
	})
	if err != nil {
		return nil, err
	}

	return value, nil
}

// Delete removes a value from the cache
func (c *MemoryCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.store, key)
}

// Clear removes all values from the cache
func (c *MemoryCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.store = make(map[string]*CacheEntry)
}

// Size returns the number of items in the cache
func (c *MemoryCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return len(c.store)
}

// cleanup periodically removes expired entries
func (c *MemoryCache) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			for key, entry := range c.store {
				if entry.IsExpired() {
					delete(c.store, key)
				}
			}
			c.mu.Unlock()
		}
	}
}

// Cache key generators for different endpoints
func (c *MemoryCache) GetTopShortsKey(period string, limit int32, offset int32) string {
	return c.generateKey("top_shorts", period, limit, offset)
}

func (c *MemoryCache) GetStockKey(productCode string) string {
	return c.generateKey("stock", productCode)
}

// GetStockDataKey covers every option that changes the SHAPE of the series,
// not just the window. A key of code+period alone would serve a cached
// display-bucketed series to a caller who asked for full resolution, and vice
// versa — the same key standing for two different answers.
func (c *MemoryCache) GetStockDataKey(productCode, period, from, to string, fullResolution bool, maxPoints int32) string {
	return c.generateKey("stock_data", productCode, period, from, to, fullResolution, maxPoints)
}

func (c *MemoryCache) GetStockPricesKey(productCode, period, from, to string, maxPoints int32) string {
	return c.generateKey("stock_prices", productCode, period, from, to, maxPoints)
}

func (c *MemoryCache) GetStockDetailsKey(productCode string) string {
	return c.generateKey("stock_details", productCode)
}

func (c *MemoryCache) GetIndustryTreeMapKey(limit int32, period, viewMode string) string {
	return c.generateKey("industry_treemap", limit, period, viewMode)
}

func (c *MemoryCache) GetSearchStocksKey(query string, limit int32) string {
	return c.generateKey("search_stocks", query, limit)
}

// includeZero is part of the key because it changes which securities are in
// the universe, not merely how they are ordered — the same key would otherwise
// serve a zero-excluding board to a caller building a research universe.
func (c *MemoryCache) GetMarketByDateKey(date string, limit, offset int32, includeZero bool) string {
	return c.generateKey("market_by_date", date, limit, offset, includeZero)
}

func (c *MemoryCache) GetAvailableDatesKey(limit int32, before string) string {
	return c.generateKey("available_dates", limit, before)
}

func (c *MemoryCache) GetStockNewsKey(stockCode string, limit int32, source, sentiment string) string {
	return c.generateKey("stock_news", stockCode, limit, source, sentiment)
}

func (c *MemoryCache) GetMarketNewsKey(limit int32, source string, priceSensitiveOnly bool) string {
	return c.generateKey("market_news", limit, source, priceSensitiveOnly)
}

// GetRelatedNewsKey builds a cache key for GetRelatedNews responses.
func (c *MemoryCache) GetRelatedNewsKey(stockCode, articleID string, limit int32) string {
	return c.generateKey("related_news", stockCode, articleID, limit)
}

// GetStockGraphKey builds a cache key for GetStockGraph responses.
func (c *MemoryCache) GetStockGraphKey(stockCode string, limit int32) string {
	return c.generateKey("stock_graph", stockCode, limit)
}

// GetStockSignalsKey builds a cache key for GetStockSignals responses.
func (c *MemoryCache) GetStockSignalsKey(stockCode string, limit int32) string {
	return c.generateKey("stock_signals", stockCode, limit)
}

// GetHousingOverviewKey builds a cache key for GetHousingOverview responses.
func (c *MemoryCache) GetHousingOverviewKey(regionType string) string {
	return c.generateKey("housing_overview", regionType)
}

// GetHousePriceSeriesKey builds a cache key for GetHousePriceSeries responses.
func (c *MemoryCache) GetHousePriceSeriesKey(regionCode, measure, dwellingType string) string {
	return c.generateKey("house_price_series", regionCode, measure, dwellingType)
}

func (c *MemoryCache) GetStateSuburbsKey(stateCode, query string, limit int32) string {
	return c.generateKey("state_suburbs", stateCode, query, limit)
}

func (c *MemoryCache) GetSuburbProfileKey(salCode string) string {
	return c.generateKey("suburb_profile", salCode)
}

// GetHousingRegionsKey builds a cache key for ListHousingRegions responses.
func (c *MemoryCache) GetHousingRegionsKey(regionType, stateCode, query string, limit int32) string {
	return c.generateKey("housing_regions", regionType, stateCode, query, limit)
}

// GetSuburbPriceDropsKey builds a cache key for ListSuburbPriceDrops responses.
func (c *MemoryCache) GetSuburbPriceDropsKey(stateCode, sort string, limit int32) string {
	return c.generateKey("suburb_price_drops", stateCode, sort, limit)
}

// GetSuburbDropListingsKey builds a cache key for ListSuburbDropListings responses.
func (c *MemoryCache) GetSuburbDropListingsKey(salCode, regionCode string, windowDays, limit int32) string {
	return c.generateKey("suburb_drop_listings", salCode, regionCode, windowDays, limit)
}

// GetPropertyHistoryKey builds a cache key for GetPropertyHistory responses.
func (c *MemoryCache) GetPropertyHistoryKey(addressKey string) string {
	return c.generateKey("property_history", addressKey)
}

// GetAddressPriceDropsKey builds a cache key for ListAddressPriceDrops responses.
func (c *MemoryCache) GetAddressPriceDropsKey(stateCode, sort string, windowDays, limit int32) string {
	return c.generateKey("address_price_drops", stateCode, sort, windowDays, limit)
}

// GetPriceDropsOverviewKey builds a cache key for GetPriceDropsOverview responses.
func (c *MemoryCache) GetPriceDropsOverviewKey() string {
	return c.generateKey("price_drops_overview")
}

// GetAgencyPriceStatsKey builds a cache key for ListAgencyPriceStats responses.
func (c *MemoryCache) GetAgencyPriceStatsKey(stateCode, sort string, limit int32) string {
	return c.generateKey("agency_price_stats", stateCode, sort, limit)
}

// GetDropIndexSeriesKey builds a cache key for GetDropIndexSeries responses.
func (c *MemoryCache) GetDropIndexSeriesKey(grain, grainKey, from, to string) string {
	return c.generateKey("drop_index_series", grain, grainKey, from, to)
}

// ListEconomicSeriesKey builds a cache key for ListEconomicSeries responses.
// --- Register of Members'/Senators' Interests ---

func (c *MemoryCache) ParliamentOverviewKey() string {
	return c.generateKey("register_overview")
}

func (c *MemoryCache) ListPoliticiansKey(chamber, stateCode, partyAb, query string, limit, offset int32) string {
	return c.generateKey("politicians_list", chamber, stateCode, partyAb, query, limit, offset)
}

func (c *MemoryCache) GetPoliticianKey(slug string) string {
	return c.generateKey("politician_profile", slug)
}

func (c *MemoryCache) ListStockPoliticiansKey(stockCode string, currentOnly bool) string {
	return c.generateKey("politicians_by_stock", stockCode, currentOnly)
}

func (c *MemoryCache) ListPoliticianStocksKey(limit int32, currentOnly bool) string {
	return c.generateKey("politician_stocks", limit, currentOnly)
}

func (c *MemoryCache) ListSuburbPoliticiansKey(salCode string) string {
	return c.generateKey("politicians_by_suburb", salCode)
}

func (c *MemoryCache) ListStatePoliticianHoldingsKey(stateCode string, limit int32) string {
	return c.generateKey("politician_state_holdings", stateCode, limit)
}

func (c *MemoryCache) ListRegisterChangesKey(since time.Time, kind, stockCode, slug string, itemNo int32, partyAb, chamber string, limit, offset int32) string {
	// The time is formatted, not passed raw: a time.Time carries a monotonic
	// clock reading that would make every key unique and defeat the cache.
	//
	// The DAY is the whole key because the handler has already truncated `since`
	// to UTC midnight before both this call and the store call. Formatting a
	// finer timestamp down to a day HERE would let two different queries share
	// one key and be served each other's results.
	sinceKey := ""
	if !since.IsZero() {
		sinceKey = since.UTC().Format("2006-01-02")
	}
	return c.generateKey("register_changes", sinceKey, kind, stockCode, slug, itemNo, partyAb, chamber, limit, offset)
}

func (c *MemoryCache) ListShortInterestOverlapKey(minShortPercent float64, limit int32) string {
	return c.generateKey("register_short_overlap", minShortPercent, limit)
}

func (c *MemoryCache) GetPoliticianAnalyticsKey(topIndustries int32, currentOnly bool) string {
	return c.generateKey("register_analytics", topIndustries, currentOnly)
}

func (c *MemoryCache) GetRegisterExplorerKey() string {
	return c.generateKey("register_explorer")
}

func (c *MemoryCache) ListPoliticianSummariesKey(chamber, stateCode, partyAb string, itemNo int32, query, sortKey string, limit, offset int32) string {
	return c.generateKey("politician_summaries", chamber, stateCode, partyAb, itemNo, query, sortKey, limit, offset)
}

func (c *MemoryCache) GetPoliticianExplorerProfileKey(slug string, topIndustries int32) string {
	return c.generateKey("politician_explorer_profile", slug, topIndustries)
}

func (c *MemoryCache) ComparePoliticiansKey(slugA, slugB string) string {
	return c.generateKey("politician_compare", slugA, slugB)
}

// GetRegisterActivityKey keys on the CLAMPED window AND on every filter, all
// normalised by the handler first. The window part means the four supported
// widths are the only widths a key can describe; the filter part means one
// member's strip can never be served as another's — the response now carries
// filtered counts, so a filter-blind key would publish the wrong member's
// numbers under the right member's name.
func (c *MemoryCache) GetRegisterActivityKey(windowDays int32, slug, partyAb, chamber string, itemNo int32, kind string) string {
	return c.generateKey("register_activity", windowDays, slug, partyAb, chamber, itemNo, kind)
}

func (c *MemoryCache) ListDistinctiveHoldingsKey(slug string) string {
	return c.generateKey("register_distinctive_holdings", slug)
}

// --- AEC funding layer ---
//
// Every component below is normalised and CLAMPED by the handler before the key
// is built, by the same rules the store applies again on the way in. A key
// built from raw input would let ' 2024-25 ' and '2024-25' hold two entries of
// one year, and an unclamped limit would let one key describe pages of two
// different sizes.

func (c *MemoryCache) GetDonationsOverviewKey(financialYear string, limit int32) string {
	return c.generateKey("aec_donations_overview", financialYear, limit)
}

func (c *MemoryCache) ListTopDonorsKey(financialYear, partyGroup string, limit, offset int32) string {
	return c.generateKey("aec_top_donors", financialYear, partyGroup, limit, offset)
}

func (c *MemoryCache) ListPartyFundingKey(partyGroup, financialYear string, limit int32) string {
	return c.generateKey("aec_party_funding", partyGroup, financialYear, limit)
}

func (c *MemoryCache) GetPoliticianFundingKey(slug string) string {
	return c.generateKey("aec_politician_funding", slug)
}

func (c *MemoryCache) ListEconomicSeriesKey(topic, metric, regionType, regionCode, product string, limit int32) string {
	return c.generateKey("economic_series_list", topic, metric, regionType, regionCode, product, limit)
}

// GetEconomicSeriesKey builds a cache key for GetEconomicSeries responses.
func (c *MemoryCache) GetEconomicSeriesKey(seriesKeys []string, startPeriod string, maxObservations int32) string {
	return c.generateKey("economic_series_get", seriesKeys, startPeriod, maxObservations)
}

// ListSeriesCorrelationsKey builds a cache key for normalized correlation filters.
func (c *MemoryCache) ListSeriesCorrelationsKey(baseSeriesKey string, windowMonths int32, minAbsR float64, limit int32) string {
	return c.generateKey("series_correlations_list", baseSeriesKey, windowMonths, minAbsR, limit)
}

// ListStateCompaniesKey builds a cache key for ListStateCompanies responses.
func (c *MemoryCache) ListStateCompaniesKey(state string, limit int32) string {
	return c.generateKey("state_companies_list", state, limit)
}

// GetStateCompanyAggregatesKey builds a cache key for GetStateCompanyAggregates responses.
func (c *MemoryCache) GetStateCompanyAggregatesKey() string {
	return c.generateKey("state_company_aggregates")
}

// GetEventTimelineKey builds a cache key for GetEventTimeline responses.
func (c *MemoryCache) GetEventTimelineKey(stockCode string, daysBack, limit int32) string {
	return c.generateKey("event_timeline", stockCode, daysBack, limit)
}

func (c *MemoryCache) GetDirectorTradesKey(stockCode string, limit int32) string {
	return c.generateKey("director_trades", stockCode, limit)
}

func (c *MemoryCache) GetDividendHistoryKey(stockCode string, years int32) string {
	return c.generateKey("dividend_history", stockCode, years)
}

func (c *MemoryCache) GetPeerComparisonKey(stockCode string, limit int32) string {
	return c.generateKey("peer_comparison", stockCode, limit)
}

func (c *MemoryCache) GetScreenStocksKey(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) string {
	return c.generateKey("screen_stocks", filters, sortField, sortDir, limit, offset)
}

// GetBattlegroundStocksKey builds a cache key for GetBattlegroundStocks responses.
func (c *MemoryCache) GetBattlegroundStocksKey(view shortsv1alpha1.BattlegroundView, limit, offset int32) string {
	return c.generateKey("battleground_stocks", view, limit, offset)
}

// GetStockVerdictKey builds a cache key for GetStockVerdict responses.
func (c *MemoryCache) GetStockVerdictKey(productCode string) string {
	return c.generateKey("stock_verdict", productCode)
}

// GetCompanyTaxProfileKey builds a cache key for GetCompanyTaxProfile responses.
func (c *MemoryCache) GetCompanyTaxProfileKey(productCode string) string {
	return c.generateKey("company_tax_profile", productCode)
}

// GetIndustryIntelligenceKey builds a cache key for GetIndustryIntelligence responses.
func (c *MemoryCache) GetIndustryIntelligenceKey(industry string, stockCode string, recordLimit int32) string {
	return c.generateKey("industry_intelligence", industry, stockCode, recordLimit)
}

// GetShortCampaignScoreboardKey builds a cache key for GetShortCampaignScoreboard responses.
func (c *MemoryCache) GetShortCampaignScoreboardKey(industry string, limit, offset int32) string {
	return c.generateKey("short_campaign_scoreboard", industry, limit, offset)
}
