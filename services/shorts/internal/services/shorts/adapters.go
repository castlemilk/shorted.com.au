package shorts

import (
	"context"
	"log"
	"time"

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

func (s *StoreAdapter) GetTopShorts(period string, limit int32, offset int32, summaryOnly bool, productCodes ...string) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	return s.store.GetTopShorts(period, limit, offset, summaryOnly, productCodes...)
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

func (s *StoreAdapter) GetCrawlRunStatuses() ([]*shorts.CrawlRunStatus, error) {
	return s.store.GetCrawlRunStatuses()
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

func (s *StoreAdapter) ListReports(reportType string, limit int) ([]*shorts.ReportListRow, error) {
	return s.store.ListReports(reportType, limit)
}

func (s *StoreAdapter) GetCompanyBranding(codes []string) (map[string]shorts.CompanyBranding, error) {
	return s.store.GetCompanyBranding(codes)
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

func (s *StoreAdapter) GetIndustryIntelligence(industry string, stockCode string, recordLimit int32) (*shorts.IndustryIntelligenceResult, error) {
	return s.store.GetIndustryIntelligence(industry, stockCode, recordLimit)
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

func (s *StoreAdapter) ListSuburbPriceDrops(stateCode, sort string, limit int32) ([]*shorts.SuburbPriceDropRow, error) {
	return s.store.ListSuburbPriceDrops(stateCode, sort, limit)
}

func (s *StoreAdapter) ListSuburbDropListings(salCode, regionCode string, windowDays, limit int32) ([]*shorts.SuburbDropListingRow, error) {
	return s.store.ListSuburbDropListings(salCode, regionCode, windowDays, limit)
}

func (s *StoreAdapter) GetPropertyHistory(addressKey string) (*shorts.PropertyHistoryResult, error) {
	return s.store.GetPropertyHistory(addressKey)
}

func (s *StoreAdapter) GetPropertyValuation(addressKey string) (*shorts.PropertyValuationRow, error) {
	return s.store.GetPropertyValuation(addressKey)
}

func (s *StoreAdapter) ListAddressPriceDrops(stateCode, sort string, windowDays, limit int32) ([]*shorts.AddressPriceDropRow, error) {
	return s.store.ListAddressPriceDrops(stateCode, sort, windowDays, limit)
}

func (s *StoreAdapter) GetPriceDropsOverview() ([]*shorts.StatePriceDropSummaryRow, error) {
	return s.store.GetPriceDropsOverview()
}

func (s *StoreAdapter) ListAgencyPriceStats(stateCode, sort string, limit int32) ([]*shorts.AgencyPriceStatsRow, error) {
	return s.store.ListAgencyPriceStats(stateCode, sort, limit)
}

func (s *StoreAdapter) GetEventTimeline(stockCode string, daysBack, limit int32) ([]*shorts.TimelineEventRow, error) {
	return s.store.GetEventTimeline(stockCode, daysBack, limit)
}

// --- Register of Members'/Senators' Interests ---

func (s *StoreAdapter) GetRegisterOverview() (*shorts.RegisterOverviewRow, error) {
	return s.store.GetRegisterOverview()
}

func (s *StoreAdapter) ListPoliticians(chamber, stateCode, partyAb, query string, limit, offset int32) ([]*shorts.PoliticianRow, int32, error) {
	return s.store.ListPoliticians(chamber, stateCode, partyAb, query, limit, offset)
}

func (s *StoreAdapter) GetPolitician(slug string) (*shorts.PoliticianRow, []*shorts.DeclaredInterestRow, []string, error) {
	return s.store.GetPolitician(slug)
}

func (s *StoreAdapter) ListStockPoliticians(stockCode string, currentOnly bool) (string, []*shorts.PoliticianRow, []*shorts.DeclaredInterestRow, []*shorts.PartyCountRow, error) {
	return s.store.ListStockPoliticians(stockCode, currentOnly)
}

func (s *StoreAdapter) ListPoliticianStocks(limit int32, currentOnly bool) ([]*shorts.PoliticianStockRollupRow, error) {
	return s.store.ListPoliticianStocks(limit, currentOnly)
}

func (s *StoreAdapter) ListSuburbPoliticians(salCode string) (string, string, []*shorts.PoliticianRow, []*shorts.DeclaredInterestRow, error) {
	return s.store.ListSuburbPoliticians(salCode)
}

func (s *StoreAdapter) ListStatePoliticianHoldings(stateCode string, limit int32) ([]*shorts.PoliticianStockRollupRow, int32, error) {
	return s.store.ListStatePoliticianHoldings(stateCode, limit)
}

func (s *StoreAdapter) ListRegisterChanges(since time.Time, kind, stockCode string, limit, offset int32) ([]*shorts.RegisterChangeRow, int32, error) {
	return s.store.ListRegisterChanges(since, kind, stockCode, limit, offset)
}

func (s *StoreAdapter) ListShortInterestOverlap(minShortPercent float64, limit int32) ([]*shorts.PoliticianStockRollupRow, error) {
	return s.store.ListShortInterestOverlap(minShortPercent, limit)
}

func (s *StoreAdapter) GetRegisterAnalytics(topIndustries int32, currentOnly bool) (*shorts.RegisterAnalytics, error) {
	return s.store.GetRegisterAnalytics(topIndustries, currentOnly)
}

func (s *StoreAdapter) GetRegisterExplorer() (*shorts.RegisterExplorerRow, error) {
	return s.store.GetRegisterExplorer()
}

func (s *StoreAdapter) ListPoliticianSummaries(chamber, stateCode, partyAb string, itemNo int32, query, sortKey string, limit, offset int32) ([]*shorts.PoliticianSummaryRow, int32, error) {
	return s.store.ListPoliticianSummaries(chamber, stateCode, partyAb, itemNo, query, sortKey, limit, offset)
}

func (s *StoreAdapter) GetPoliticianExplorerProfile(slug string, topIndustries int32) (*shorts.PoliticianExplorerProfileRow, error) {
	return s.store.GetPoliticianExplorerProfile(slug, topIndustries)
}

func (s *StoreAdapter) ComparePoliticians(slugA, slugB string) (*shorts.PoliticianComparisonRow, error) {
	return s.store.ComparePoliticians(slugA, slugB)
}

// Register review console. Deliberately NOT routed through the caching adapter
// arms above: a decision must be visible to the next reviewer immediately, and a
// cached queue would hand two people the same candidate to decide twice.

func (s *StoreAdapter) ListSecurityReviewQueue(limit, offset int32, gateOnly bool) ([]*shorts.SecurityQueueRow, int32, int32, error) {
	return s.store.ListSecurityReviewQueue(limit, offset, gateOnly)
}

func (s *StoreAdapter) SearchRegisterListings(query string, limit int32) ([]*shorts.RegisterListingRow, error) {
	return s.store.SearchRegisterListings(query, limit)
}

func (s *StoreAdapter) DecideSecurityCandidate(candidateNorm, decision, stockCode, aliasKind, note, reviewer string, stopwordConfirmed bool) (int32, error) {
	return s.store.DecideSecurityCandidate(candidateNorm, decision, stockCode, aliasKind, note, reviewer, stopwordConfirmed)
}

func (s *StoreAdapter) UndoSecurityDecision(candidateNorm string) (bool, error) {
	return s.store.UndoSecurityDecision(candidateNorm)
}

func (s *StoreAdapter) GetRegisterCoverageStats() (*shorts.RegisterCoverageRow, error) {
	return s.store.GetRegisterCoverageStats()
}

// Per-politician CRM. Uncached for the same reason as the securities queue: a
// curator must see their own edit immediately, and a stale profile invites the
// same correction twice.

func (s *StoreAdapter) ListPoliticianProfiles(query string, limit, offset int32, duplicatesOnly bool) ([]*shorts.PoliticianProfileSummaryRow, int32, int32, error) {
	return s.store.ListPoliticianProfiles(query, limit, offset, duplicatesOnly)
}

func (s *StoreAdapter) GetPoliticianProfile(slug string) (*shorts.PoliticianProfileRow, error) {
	return s.store.GetPoliticianProfile(slug)
}

func (s *StoreAdapter) CuratePoliticianFact(slug, field string, ordinal int32, action, curatedText, rationale, evidenceURL, curator string) (*shorts.ProfileFactRow, error) {
	return s.store.CuratePoliticianFact(slug, field, ordinal, action, curatedText, rationale, evidenceURL, curator)
}

func (s *StoreAdapter) SetPoliticianPhoto(slug, url, licence, author, sourceURL, curator string) error {
	return s.store.SetPoliticianPhoto(slug, url, licence, author, sourceURL, curator)
}

func (s *StoreAdapter) MergePoliticians(keepSlug, mergeSlug, evidence, curator string) (int32, error) {
	return s.store.MergePoliticians(keepSlug, mergeSlug, evidence, curator)
}

func (s *StoreAdapter) ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*shorts.EconomicSeriesRow, error) {
	return s.store.ListEconomicSeries(topic, metric, regionType, regionCode, product, limit)
}

func (s *StoreAdapter) GetEconomicSeries(seriesKeys []string, startPeriod time.Time, maxObservations int32) ([]*shorts.EconomicSeriesDataRow, error) {
	return s.store.GetEconomicSeries(seriesKeys, startPeriod, maxObservations)
}

func (s *StoreAdapter) ListSeriesCorrelations(baseSeriesKey string, windowMonths int32, minAbsR float64, limit int32) ([]*shorts.SeriesCorrelationRow, error) {
	return s.store.ListSeriesCorrelations(baseSeriesKey, windowMonths, minAbsR, limit)
}

func (s *StoreAdapter) ListStateCompanies(state string, limit int32) ([]*shorts.StateCompanyRow, error) {
	return s.store.ListStateCompanies(state, limit)
}

func (s *StoreAdapter) GetStateCompanyAggregates() ([]*shorts.StateCompanyAggregateRow, error) {
	return s.store.GetStateCompanyAggregates()
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
