package shorts

import (
	"context"
	"log"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// StoreAdapter adapts the concrete store implementation to the ShortsStore interface
type StoreAdapter struct {
	store shorts.Store
}

// NewStoreAdapter creates a new store adapter
func NewStoreAdapter(store shorts.Store) *StoreAdapter {
	return &StoreAdapter{store: store}
}

func (s *StoreAdapter) GetTopShorts(period string, limit int32, offset int32, summaryOnly bool) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	return s.store.GetTopShorts(period, limit, offset, summaryOnly)
}

func (s *StoreAdapter) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	return s.store.GetStock(productCode)
}

func (s *StoreAdapter) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
	return s.store.GetStockData(productCode, period)
}

func (s *StoreAdapter) GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error) {
	return s.store.GetStockDetails(productCode)
}

func (s *StoreAdapter) GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	return s.store.GetIndustryTreeMap(limit, period, viewMode)
}

func (s *StoreAdapter) SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	return s.store.SearchStocks(query, limit)
}

func (s *StoreAdapter) GetMarketByDate(date string, limit, offset int32) ([]*stocksv1alpha1.Stock, int, error) {
	return s.store.GetMarketByDate(date, limit, offset)
}

func (s *StoreAdapter) GetAvailableDates(limit int, before string) ([]string, string, string, int, error) {
	return s.store.GetAvailableDates(limit, before)
}

func (s *StoreAdapter) GetSyncStatus(filter shorts.SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error) {
	return s.store.GetSyncStatus(filter)
}

func (s *StoreAdapter) CleanupStuckSyncRuns() (int, error) {
	return s.store.CleanupStuckSyncRuns()
}

func (s *StoreAdapter) GetJobsOverview() ([]*shorts.JobHealth, error) {
	return s.store.GetJobsOverview()
}

// GetAllStockCodes wraps the store's GetAllStockCodes
func (s *StoreAdapter) GetAllStockCodes() ([]string, error) {
	return s.store.GetAllStockCodes()
}

// StockExists wraps the store's StockExists
func (s *StoreAdapter) StockExists(stockCode string) (bool, error) {
	return s.store.StockExists(stockCode)
}

// UpdateKeyMetrics wraps the store's UpdateKeyMetrics
func (s *StoreAdapter) UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error {
	return s.store.UpdateKeyMetrics(stockCode, metrics)
}

func (s *StoreAdapter) GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error) {
	return s.store.GetTopStocksForEnrichment(limit, priority)
}

func (s *StoreAdapter) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
	return s.store.SavePendingEnrichment(enrichmentID, stockCode, status, data, quality)
}

func (s *StoreAdapter) ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error) {
	return s.store.ListPendingEnrichments(limit, offset)
}

func (s *StoreAdapter) GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error) {
	return s.store.GetPendingEnrichment(enrichmentID)
}

func (s *StoreAdapter) GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error) {
	return s.store.GetPendingEnrichmentByStockCode(stockCode)
}

func (s *StoreAdapter) ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error {
	return s.store.ReviewEnrichment(enrichmentID, approve, reviewedBy, reviewNotes)
}

func (s *StoreAdapter) ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error {
	return s.store.ApplyEnrichment(stockCode, data)
}

func (s *StoreAdapter) CreateEnrichmentJob(stockCode string, force bool) (string, error) {
	return s.store.CreateEnrichmentJob(stockCode, force)
}

func (s *StoreAdapter) GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error) {
	return s.store.GetEnrichmentJob(jobID)
}

func (s *StoreAdapter) GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error) {
	return s.store.GetActiveEnrichmentJobByStockCode(stockCode)
}

func (s *StoreAdapter) UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error {
	return s.store.UpdateEnrichmentJobStatus(jobID, status, enrichmentID, errorMsg)
}

func (s *StoreAdapter) ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error) {
	return s.store.ListEnrichmentJobs(limit, offset, status)
}

func (s *StoreAdapter) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error {
	return s.store.UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL)
}

func (s *StoreAdapter) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error {
	return s.store.UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat)
}

func (s *StoreAdapter) GetAPISubscription(userID string) (*shorts.APISubscription, error) {
	return s.store.GetAPISubscription(userID)
}

func (s *StoreAdapter) GetAPISubscriptionByCustomer(stripeCustomerID string) (*shorts.APISubscription, error) {
	return s.store.GetAPISubscriptionByCustomer(stripeCustomerID)
}

func (s *StoreAdapter) UpsertAPISubscription(sub *shorts.APISubscription) error {
	return s.store.UpsertAPISubscription(sub)
}

func (s *StoreAdapter) UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *shorts.APISubscriptionUpdate) error {
	return s.store.UpdateAPISubscriptionByCustomer(stripeCustomerID, update)
}

func (s *StoreAdapter) CreateAlertMonitor(input shorts.CreateAlertMonitorInput) (*shorts.AlertMonitor, error) {
	return s.store.CreateAlertMonitor(input)
}

func (s *StoreAdapter) ListAlertMonitors(userID string, limit, offset int32) ([]*shorts.AlertMonitor, int32, error) {
	return s.store.ListAlertMonitors(userID, limit, offset)
}

func (s *StoreAdapter) GetWeeklyReport(weekSlug string) (*shorts.WeeklyReport, error) {
	return s.store.GetWeeklyReport(weekSlug)
}

func (s *StoreAdapter) GetStockFinancialHighlights(stockCodes []string, maxPerStock int) (map[string][]shorts.FinancialReportHighlight, error) {
	return s.store.GetStockFinancialHighlights(stockCodes, maxPerStock)
}

func (s *StoreAdapter) GetStockNews(stockCode string, limit int32, source, sentiment string) ([]*shorts.NewsArticle, int, error) {
	return s.store.GetStockNews(stockCode, limit, source, sentiment)
}

func (s *StoreAdapter) GetMarketNews(limit int32, source string, priceSensitiveOnly bool) ([]*shorts.NewsArticle, int, error) {
	return s.store.GetMarketNews(limit, source, priceSensitiveOnly)
}

func (s *StoreAdapter) GetRelatedNews(stockCode, articleID string, limit int32) ([]*shorts.NewsArticle, error) {
	return s.store.GetRelatedNews(stockCode, articleID, limit)
}

func (s *StoreAdapter) GetEditorialTake(slug string) (*shorts.EditorialTake, error) {
	return s.store.GetEditorialTake(slug)
}

func (s *StoreAdapter) ListEditorialTakes(limit, offset int32, stockCode string) ([]*shorts.EditorialTake, int, error) {
	return s.store.ListEditorialTakes(limit, offset, stockCode)
}

func (s *StoreAdapter) ListEditorialTakesAdmin(limit, offset int32, statusFilter string) ([]*shorts.EditorialTake, int, error) {
	return s.store.ListEditorialTakesAdmin(limit, offset, statusFilter)
}

func (s *StoreAdapter) PublishEditorialTake(slug string) (*shorts.EditorialTake, error) {
	return s.store.PublishEditorialTake(slug)
}

func (s *StoreAdapter) UpdateEditorialTake(slug string, f shorts.EditorialTakeUpdate) (*shorts.EditorialTake, error) {
	return s.store.UpdateEditorialTake(slug, f)
}

func (s *StoreAdapter) DeleteEditorialTake(slug string) (bool, error) {
	return s.store.DeleteEditorialTake(slug)
}

func (s *StoreAdapter) MarkTakeTweetPublished(slug string) (*shorts.EditorialTake, error) {
	return s.store.MarkTakeTweetPublished(slug)
}

func (s *StoreAdapter) ListTweetPublishQueue(limit int32) ([]*shorts.EditorialTake, error) {
	return s.store.ListTweetPublishQueue(limit)
}

func (s *StoreAdapter) GetDirectorTrades(stockCode string, limit int32) ([]*shorts.DirectorTrade, int, error) {
	return s.store.GetDirectorTrades(stockCode, limit)
}

func (s *StoreAdapter) GetDividendHistory(stockCode string, years int32) ([]*shorts.DividendRecord, int, error) {
	return s.store.GetDividendHistory(stockCode, years)
}

func (s *StoreAdapter) GetPeerComparison(stockCode string, limit int32) (*shorts.PeerComparisonResult, error) {
	return s.store.GetPeerComparison(stockCode, limit)
}

func (s *StoreAdapter) ScreenStocks(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) ([]*shorts.ScreenerStock, int, error) {
	return s.store.ScreenStocks(filters, sortField, sortDir, limit, offset)
}

func (s *StoreAdapter) GetBattlegroundStocks(view shortsv1alpha1.BattlegroundView, limit, offset int32) ([]*shorts.BattlegroundStock, int, error) {
	return s.store.GetBattlegroundStocks(view, limit, offset)
}

func (s *StoreAdapter) GetStockVerdictInputs(productCode string) (*shorts.VerdictInputs, error) {
	return s.store.GetStockVerdictInputs(productCode)
}

func (s *StoreAdapter) GetCompanyTaxProfile(productCode string) (*shorts.CompanyTaxProfile, error) {
	return s.store.GetCompanyTaxProfile(productCode)
}

func (s *StoreAdapter) GetIndustryIntelligence(industry string, recordLimit int32) (*shorts.IndustryIntelligenceResult, error) {
	return s.store.GetIndustryIntelligence(industry, recordLimit)
}

func (s *StoreAdapter) GetShortCampaignScoreboard(industry string, limit, offset int32) ([]*shorts.ShortCampaign, int, *shorts.ScoreboardStats, error) {
	return s.store.GetShortCampaignScoreboard(industry, limit, offset)
}

func (s *StoreAdapter) GetStockGraph(stockCode string, limit int32) (*shorts.StockGraphResult, error) {
	return s.store.GetStockGraph(stockCode, limit)
}

func (s *StoreAdapter) GetStockSignals(stockCode string, limit int32) (*shorts.StockSignalsResult, error) {
	return s.store.GetStockSignals(stockCode, limit)
}

func (s *StoreAdapter) GetHousingOverview(regionType string) ([]*shorts.HousingMetricRow, error) {
	return s.store.GetHousingOverview(regionType)
}

func (s *StoreAdapter) GetHousePriceSeries(regionCode, measure, dwellingType string) (*shorts.HousePriceSeriesResult, error) {
	return s.store.GetHousePriceSeries(regionCode, measure, dwellingType)
}

func (s *StoreAdapter) ListStateSuburbs(stateCode, query string, limit int32) ([]*shorts.SuburbSummaryRow, error) {
	return s.store.ListStateSuburbs(stateCode, query, limit)
}

func (s *StoreAdapter) GetSuburbProfile(salCode string) (*shorts.SuburbProfileRow, error) {
	return s.store.GetSuburbProfile(salCode)
}

func (s *StoreAdapter) GetHousingRegions(regionType, stateCode, query string, limit int32) ([]*shorts.HousingRegionRow, error) {
	return s.store.GetHousingRegions(regionType, stateCode, query, limit)
}

func (s *StoreAdapter) GetEventTimeline(stockCode string, daysBack, limit int32) ([]*shorts.TimelineEventRow, error) {
	return s.store.GetEventTimeline(stockCode, daysBack, limit)
}

// QueryRowContext delegates to the underlying store's QueryRowContext.
func (s *StoreAdapter) QueryRowContext(ctx context.Context, query string, args ...interface{}) shorts.Row {
	return s.store.QueryRowContext(ctx, query, args...)
}

// ListBroadcasts delegates to the underlying store.
func (s *StoreAdapter) ListBroadcasts(limit int) ([]shorts.Broadcast, error) {
	return s.store.ListBroadcasts(limit)
}

// GetBroadcast delegates to the underlying store.
func (s *StoreAdapter) GetBroadcast(id string) (*shorts.Broadcast, error) {
	return s.store.GetBroadcast(id)
}

// SetBroadcastStatus delegates to the underlying store.
func (s *StoreAdapter) SetBroadcastStatus(id, status, errMsg string, recipientCount int) error {
	return s.store.SetBroadcastStatus(id, status, errMsg, recipientCount)
}

// ClaimBroadcastForSending delegates to the underlying store.
func (s *StoreAdapter) ClaimBroadcastForSending(id string) (bool, error) {
	return s.store.ClaimBroadcastForSending(id)
}

// ListActiveSubscribers delegates to the underlying store.
func (s *StoreAdapter) ListActiveSubscribers() ([]shorts.Subscriber, error) {
	return s.store.ListActiveSubscribers()
}

// LoggerAdapter adapts the standard logger to the Logger interface
type LoggerAdapter struct{}

// NewLoggerAdapter creates a new logger adapter
func NewLoggerAdapter() *LoggerAdapter {
	return &LoggerAdapter{}
}

func (l *LoggerAdapter) Debugf(format string, args ...interface{}) {
	log.Printf("[DEBUG] "+format, args...)
}

func (l *LoggerAdapter) Infof(format string, args ...interface{}) {
	log.Printf("[INFO] "+format, args...)
}

func (l *LoggerAdapter) Warnf(format string, args ...interface{}) {
	log.Printf("[WARN] "+format, args...)
}

func (l *LoggerAdapter) Errorf(format string, args ...interface{}) {
	log.Printf("[ERROR] "+format, args...)
}
