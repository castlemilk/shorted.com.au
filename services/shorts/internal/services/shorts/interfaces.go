package shorts

import (
	"context"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

//go:generate mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks

// ShortsStore defines the interface for shorts data operations
type ShortsStore interface {
	GetTopShorts(period string, limit int32, offset int32, summaryOnly bool, productCodes ...string) ([]*stocksv1alpha1.TimeSeriesData, int, error)
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
	GetCrawlRunStatuses() ([]*shortsstore.CrawlRunStatus, error)

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
	CreateAlertMonitor(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error)
	ListAlertMonitors(userID string, limit, offset int32) ([]*shortsstore.AlertMonitor, int32, error)

	// Weekly report methods
	GetWeeklyReport(weekSlug string) (*shortsstore.WeeklyReport, error)
	ListReports(reportType string, limit int) ([]*shortsstore.ReportListRow, error)

	// Company branding (logo + industry) lookup for report hydration
	GetCompanyBranding(codes []string) (map[string]shortsstore.CompanyBranding, error)

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

	// Battleground methods
	GetBattlegroundStocks(view shortsv1alpha1.BattlegroundView, limit, offset int32) ([]*shortsstore.BattlegroundStock, int, error)

	// Bear/bull verdict methods
	GetStockVerdictInputs(productCode string) (*shortsstore.VerdictInputs, error)

	// Corporate tax (influence layer) methods
	GetCompanyTaxProfile(productCode string) (*shortsstore.CompanyTaxProfile, error)
	GetIndustryIntelligence(industry string, stockCode string, recordLimit int32) (*shortsstore.IndustryIntelligenceResult, error)

	// Short-seller scoreboard methods
	GetShortCampaignScoreboard(industry string, limit, offset int32) ([]*shortsstore.ShortCampaign, int, *shortsstore.ScoreboardStats, error)

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
	ListSuburbPriceDrops(stateCode, sort string, limit int32) ([]*shortsstore.SuburbPriceDropRow, error)
	ListSuburbDropListings(salCode, regionCode string, windowDays, limit int32) ([]*shortsstore.SuburbDropListingRow, error)
	GetPropertyHistory(addressKey string) (*shortsstore.PropertyHistoryResult, error)
	GetPropertyValuation(addressKey string) (*shortsstore.PropertyValuationRow, error)
	ListAddressPriceDrops(stateCode, sort string, windowDays, limit int32) ([]*shortsstore.AddressPriceDropRow, error)
	GetPriceDropsOverview() ([]*shortsstore.StatePriceDropSummaryRow, error)
	ListAgencyPriceStats(stateCode, sort string, limit int32) ([]*shortsstore.AgencyPriceStatsRow, error)

	// Economy snapshot methods
	ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*shortsstore.EconomicSeriesRow, error)
	GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*shortsstore.EconomicSeriesDataRow, error)

	// Company state exposure methods
	ListStateCompanies(state string, limit int32) ([]*shortsstore.StateCompanyRow, error)
	GetStateCompanyAggregates() ([]*shortsstore.StateCompanyAggregateRow, error)

	// Event timeline methods
	GetEventTimeline(stockCode string, daysBack, limit int32) ([]*shortsstore.TimelineEventRow, error)

	// Broadcast methods
	ListBroadcasts(limit int) ([]shortsstore.Broadcast, error)
	GetBroadcast(id string) (*shortsstore.Broadcast, error)
	SetBroadcastStatus(id, status, errMsg string, recipientCount int) error
	ClaimBroadcastForSending(id string) (bool, error)
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
	GetSuburbPriceDropsKey(stateCode, sort string, limit int32) string
	GetSuburbDropListingsKey(salCode, regionCode string, windowDays, limit int32) string
	GetPropertyHistoryKey(addressKey string) string
	GetAddressPriceDropsKey(stateCode, sort string, windowDays, limit int32) string
	GetPriceDropsOverviewKey() string
	GetAgencyPriceStatsKey(stateCode, sort string, limit int32) string
	ListEconomicSeriesKey(topic, metric, regionType, regionCode, product string, limit int32) string
	GetEconomicSeriesKey(seriesKeys []string, startPeriod string) string
	ListStateCompaniesKey(state string, limit int32) string
	GetStateCompanyAggregatesKey() string
	GetEventTimelineKey(stockCode string, daysBack, limit int32) string
	GetDirectorTradesKey(stockCode string, limit int32) string
	GetDividendHistoryKey(stockCode string, years int32) string
	GetPeerComparisonKey(stockCode string, limit int32) string
	GetScreenStocksKey(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) string
	GetBattlegroundStocksKey(view shortsv1alpha1.BattlegroundView, limit, offset int32) string
	GetStockVerdictKey(productCode string) string
	GetCompanyTaxProfileKey(productCode string) string
	GetIndustryIntelligenceKey(industry string, stockCode string, recordLimit int32) string
	GetShortCampaignScoreboardKey(industry string, limit, offset int32) string
}

// Logger defines the interface for logging operations
type Logger interface {
	Debugf(format string, args ...interface{})
	Infof(format string, args ...interface{})
	Warnf(format string, args ...interface{})
	Errorf(format string, args ...interface{})
}
