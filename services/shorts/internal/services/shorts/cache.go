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

func (c *MemoryCache) GetStockDataKey(productCode, period string) string {
	return c.generateKey("stock_data", productCode, period)
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

func (c *MemoryCache) GetMarketByDateKey(date string, limit, offset int32) string {
	return c.generateKey("market_by_date", date, limit, offset)
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

// ListEconomicSeriesKey builds a cache key for ListEconomicSeries responses.
func (c *MemoryCache) ListEconomicSeriesKey(topic, metric, regionType, regionCode, product string, limit int32) string {
	return c.generateKey("economic_series_list", topic, metric, regionType, regionCode, product, limit)
}

// GetEconomicSeriesKey builds a cache key for GetEconomicSeries responses.
func (c *MemoryCache) GetEconomicSeriesKey(seriesKeys []string, startPeriod string) string {
	return c.generateKey("economic_series_get", seriesKeys, startPeriod)
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
