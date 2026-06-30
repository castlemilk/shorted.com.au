package shorts

import (
	"context"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

//go:generate mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks

// ShortsStore defines the interface for shorts data operations
type ShortsStore interface {
	GetTopShorts(period string, limit int32, offset int32, summaryOnly bool) ([]*stocksv1alpha1.TimeSeriesData, int, error)
	GetStock(productCode string) (*stocksv1alpha1.Stock, error)
	GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error)
	GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error)
	GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error)
	SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error)
	GetMarketByDate(date string, limit, offset int32) ([]*stocksv1alpha1.Stock, int, error)
	GetAvailableDates(limit int, before string) ([]string, string, string, int, error)
	GetSyncStatus(filter shortsstore.SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error)
	CleanupStuckSyncRuns() (int, error)
	GetJobsOverview() ([]*shortsstore.JobHealth, error)

	// Key metrics sync methods
	GetAllStockCodes() ([]string, error)
	StockExists(stockCode string) (bool, error)
	UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error

	// Enrichment (v2) review workflow methods
	GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error)
	SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error)
	ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error)
	GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error)
	GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error)
	ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error
	ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error

	// Enrichment job methods (async processing)
	CreateEnrichmentJob(stockCode string, force bool) (string, error)
	GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error)
	GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error)
	UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error
	ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error)

	// Logo methods
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error

	// API Subscription methods
	GetAPISubscription(userID string) (*shortsstore.APISubscription, error)
	GetAPISubscriptionByCustomer(stripeCustomerID string) (*shortsstore.APISubscription, error)
	UpsertAPISubscription(sub *shortsstore.APISubscription) error
	UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *shortsstore.APISubscriptionUpdate) error

	// Weekly report methods
	GetWeeklyReport(weekSlug string) (*shortsstore.WeeklyReport, error)

	// Financial highlights
	GetStockFinancialHighlights(stockCodes []string, maxPerStock int) (map[string][]shortsstore.FinancialReportHighlight, error)

	// News methods
	GetStockNews(stockCode string, limit int32, source, sentiment string) ([]*shortsstore.NewsArticle, int, error)
	GetMarketNews(limit int32, source string, priceSensitiveOnly bool) ([]*shortsstore.NewsArticle, int, error)
	GetRelatedNews(stockCode, articleID string, limit int32) ([]*shortsstore.NewsArticle, error)

	// Editorial Take methods
	GetEditorialTake(slug string) (*shortsstore.EditorialTake, error)
	ListEditorialTakes(limit, offset int32, stockCode string) ([]*shortsstore.EditorialTake, int, error)
	ListEditorialTakesAdmin(limit, offset int32, statusFilter string) ([]*shortsstore.EditorialTake, int, error)
	PublishEditorialTake(slug string) (*shortsstore.EditorialTake, error)
	UpdateEditorialTake(slug string, fields shortsstore.EditorialTakeUpdate) (*shortsstore.EditorialTake, error)
	DeleteEditorialTake(slug string) (bool, error)
	MarkTakeTweetPublished(slug string) (*shortsstore.EditorialTake, error)
	ListTweetPublishQueue(limit int32) ([]*shortsstore.EditorialTake, error)

	// Director trade methods
	GetDirectorTrades(stockCode string, limit int32) ([]*shortsstore.DirectorTrade, int, error)

	// Dividend methods
	GetDividendHistory(stockCode string, years int32) ([]*shortsstore.DividendRecord, int, error)

	// Peer comparison methods
	GetPeerComparison(stockCode string, limit int32) (*shortsstore.PeerComparisonResult, error)

	// Screener methods
	ScreenStocks(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) ([]*shortsstore.ScreenerStock, int, error)

	// Stock graph methods
	GetStockGraph(stockCode string, limit int32) (*shortsstore.StockGraphResult, error)

	// Stock signals (risk/reputation) methods
	GetStockSignals(stockCode string, limit int32) (*shortsstore.StockSignalsResult, error)

	// House-price tracker methods
	GetHousingOverview(regionType string) ([]*shortsstore.HousingMetricRow, error)
	GetHousePriceSeries(regionCode, measure, dwellingType string) (*shortsstore.HousePriceSeriesResult, error)
	ListStateSuburbs(stateCode, query string, limit int32) ([]*shortsstore.SuburbSummaryRow, error)
	GetSuburbProfile(salCode string) (*shortsstore.SuburbProfileRow, error)
	GetHousingRegions(regionType, stateCode, query string, limit int32) ([]*shortsstore.HousingRegionRow, error)

	// Event timeline methods
	GetEventTimeline(stockCode string, daysBack, limit int32) ([]*shortsstore.TimelineEventRow, error)

	// Broadcast methods
	ListBroadcasts(limit int) ([]shortsstore.Broadcast, error)
	GetBroadcast(id string) (*shortsstore.Broadcast, error)
	SetBroadcastStatus(id, status, errMsg string, recipientCount int) error
	ListActiveSubscribers() ([]shortsstore.Subscriber, error)

	// Raw query access (used for Algolia sync)
	QueryRowContext(ctx context.Context, query string, args ...interface{}) shortsstore.Row
}

// Cache defines the interface for caching operations
type Cache interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{})
	GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error)
	Delete(key string)
	Clear()
	Size() int

	// Cache key generators
	GetTopShortsKey(period string, limit int32, offset int32) string
	GetStockKey(productCode string) string
	GetStockDataKey(productCode, period string) string
	GetStockDetailsKey(productCode string) string
	GetIndustryTreeMapKey(limit int32, period, viewMode string) string
	GetSearchStocksKey(query string, limit int32) string
	GetMarketByDateKey(date string, limit, offset int32) string
	GetAvailableDatesKey(limit int32, before string) string
	GetStockNewsKey(stockCode string, limit int32, source, sentiment string) string
	GetMarketNewsKey(limit int32, source string, priceSensitiveOnly bool) string
	GetRelatedNewsKey(stockCode, articleID string, limit int32) string
	GetStockGraphKey(stockCode string, limit int32) string
	GetStockSignalsKey(stockCode string, limit int32) string
	GetHousingOverviewKey(regionType string) string
	GetHousePriceSeriesKey(regionCode, measure, dwellingType string) string
	GetStateSuburbsKey(stateCode, query string, limit int32) string
	GetSuburbProfileKey(salCode string) string
	GetHousingRegionsKey(regionType, stateCode, query string, limit int32) string
	GetEventTimelineKey(stockCode string, daysBack, limit int32) string
	GetDirectorTradesKey(stockCode string, limit int32) string
	GetDividendHistoryKey(stockCode string, years int32) string
	GetPeerComparisonKey(stockCode string, limit int32) string
	GetScreenStocksKey(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) string
}

// Logger defines the interface for logging operations
type Logger interface {
	Debugf(format string, args ...interface{})
	Infof(format string, args ...interface{})
	Warnf(format string, args ...interface{})
	Errorf(format string, args ...interface{})
}
