package mocks

import (
	"context"
	"reflect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"go.uber.org/mock/gomock"
)

// MockEnrichmentStore is a mock of EnrichmentStore interface
type MockEnrichmentStore struct {
	ctrl     *gomock.Controller
	recorder *MockEnrichmentStoreMockRecorder
}

type MockEnrichmentStoreMockRecorder struct {
	mock *MockEnrichmentStore
}

func NewMockEnrichmentStore(ctrl *gomock.Controller) *MockEnrichmentStore {
	mock := &MockEnrichmentStore{ctrl: ctrl}
	mock.recorder = &MockEnrichmentStoreMockRecorder{mock}
	return mock
}

func (m *MockEnrichmentStore) EXPECT() *MockEnrichmentStoreMockRecorder {
	return m.recorder
}

func (m *MockEnrichmentStore) GetStockDetails(stockCode string) (*stocksv1alpha1.StockDetails, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "GetStockDetails", stockCode)
	ret0, _ := ret[0].(*stocksv1alpha1.StockDetails)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) GetStockDetails(stockCode interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "GetStockDetails", reflect.TypeOf((*MockEnrichmentStore)(nil).GetStockDetails), stockCode)
}

func (m *MockEnrichmentStore) GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "GetEnrichmentJob", jobID)
	ret0, _ := ret[0].(*shortsv1alpha1.EnrichmentJob)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) GetEnrichmentJob(jobID interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "GetEnrichmentJob", reflect.TypeOf((*MockEnrichmentStore)(nil).GetEnrichmentJob), jobID)
}

func (m *MockEnrichmentStore) UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "UpdateEnrichmentJobStatus", jobID, status, enrichmentID, errorMsg)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) UpdateEnrichmentJobStatus(jobID, status, enrichmentID, errorMsg interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "UpdateEnrichmentJobStatus", reflect.TypeOf((*MockEnrichmentStore)(nil).UpdateEnrichmentJobStatus), jobID, status, enrichmentID, errorMsg)
}

func (m *MockEnrichmentStore) ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ListEnrichmentJobs", limit, offset, status)
	ret0, _ := ret[0].([]*shortsv1alpha1.EnrichmentJob)
	ret1, _ := ret[1].(int32)
	ret2, _ := ret[2].(error)
	return ret0, ret1, ret2
}

func (mr *MockEnrichmentStoreMockRecorder) ListEnrichmentJobs(limit, offset, status interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ListEnrichmentJobs", reflect.TypeOf((*MockEnrichmentStore)(nil).ListEnrichmentJobs), limit, offset, status)
}

func (m *MockEnrichmentStore) ResetStuckJobs(stuckThresholdMinutes int) (int, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ResetStuckJobs", stuckThresholdMinutes)
	ret0, _ := ret[0].(int)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) ResetStuckJobs(stuckThresholdMinutes interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ResetStuckJobs", reflect.TypeOf((*MockEnrichmentStore)(nil).ResetStuckJobs), stuckThresholdMinutes)
}

func (m *MockEnrichmentStore) CleanupOldCompletedJobs(keepPerStock int) (int, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "CleanupOldCompletedJobs", keepPerStock)
	ret0, _ := ret[0].(int)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) CleanupOldCompletedJobs(keepPerStock interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "CleanupOldCompletedJobs", reflect.TypeOf((*MockEnrichmentStore)(nil).CleanupOldCompletedJobs), keepPerStock)
}

func (m *MockEnrichmentStore) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "SavePendingEnrichment", enrichmentID, stockCode, status, data, quality)
	ret0, _ := ret[0].(string)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) SavePendingEnrichment(enrichmentID, stockCode, status, data, quality interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "SavePendingEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).SavePendingEnrichment), enrichmentID, stockCode, status, data, quality)
}

func (m *MockEnrichmentStore) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "UpdateLogoURLs", stockCode, logoGCSURL, logoIconGCSURL)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "UpdateLogoURLs", reflect.TypeOf((*MockEnrichmentStore)(nil).UpdateLogoURLs), stockCode, logoGCSURL, logoIconGCSURL)
}

func (m *MockEnrichmentStore) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "UpdateLogoURLsWithSVG", stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "UpdateLogoURLsWithSVG", reflect.TypeOf((*MockEnrichmentStore)(nil).UpdateLogoURLsWithSVG), stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat)
}

func (m *MockEnrichmentStore) GetStocksForPeopleEnrichment(limit int) ([]enrichment.StockPeopleData, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "GetStocksForPeopleEnrichment", limit)
	ret0, _ := ret[0].([]enrichment.StockPeopleData)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) GetStocksForPeopleEnrichment(limit interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "GetStocksForPeopleEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).GetStocksForPeopleEnrichment), limit)
}

func (m *MockEnrichmentStore) UpdateKeyPeopleEnriched(stockCode string, keyPeopleJSON []byte) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "UpdateKeyPeopleEnriched", stockCode, keyPeopleJSON)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) UpdateKeyPeopleEnriched(stockCode, keyPeopleJSON interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "UpdateKeyPeopleEnriched", reflect.TypeOf((*MockEnrichmentStore)(nil).UpdateKeyPeopleEnriched), stockCode, keyPeopleJSON)
}

func (m *MockEnrichmentStore) CreateEnrichmentJob(stockCode string, force bool) (string, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "CreateEnrichmentJob", stockCode, force)
	return ret[0].(string), ret[1].(error)
}

func (mr *MockEnrichmentStoreMockRecorder) CreateEnrichmentJob(stockCode, force interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "CreateEnrichmentJob", reflect.TypeOf((*MockEnrichmentStore)(nil).CreateEnrichmentJob), stockCode, force)
}

func (m *MockEnrichmentStore) GetStocksNeedingEnrichment(limit int, includeStale bool) ([]string, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "GetStocksNeedingEnrichment", limit, includeStale)
	return ret[0].([]string), ret[1].(error)
}

func (mr *MockEnrichmentStoreMockRecorder) GetStocksNeedingEnrichment(limit, includeStale interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "GetStocksNeedingEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).GetStocksNeedingEnrichment), limit, includeStale)
}

func (m *MockEnrichmentStore) GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "GetPendingEnrichment", enrichmentID)
	ret0, _ := ret[0].(*shortsv1alpha1.PendingEnrichment)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockEnrichmentStoreMockRecorder) GetPendingEnrichment(enrichmentID interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "GetPendingEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).GetPendingEnrichment), enrichmentID)
}

func (m *MockEnrichmentStore) ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ReviewEnrichment", enrichmentID, approve, reviewedBy, reviewNotes)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) ReviewEnrichment(enrichmentID, approve, reviewedBy, reviewNotes interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ReviewEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).ReviewEnrichment), enrichmentID, approve, reviewedBy, reviewNotes)
}

func (m *MockEnrichmentStore) ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ApplyEnrichment", stockCode, data)
	ret0, _ := ret[0].(error)
	return ret0
}

func (mr *MockEnrichmentStoreMockRecorder) ApplyEnrichment(stockCode, data interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ApplyEnrichment", reflect.TypeOf((*MockEnrichmentStore)(nil).ApplyEnrichment), stockCode, data)
}

// MockGPTClient is a mock of GPTClient interface
type MockGPTClient struct {
	ctrl     *gomock.Controller
	recorder *MockGPTClientMockRecorder
}

type MockGPTClientMockRecorder struct {
	mock *MockGPTClient
}

func NewMockGPTClient(ctrl *gomock.Controller) *MockGPTClient {
	mock := &MockGPTClient{ctrl: ctrl}
	mock.recorder = &MockGPTClientMockRecorder{mock}
	return mock
}

func (m *MockGPTClient) EXPECT() *MockGPTClientMockRecorder {
	return m.recorder
}

func (m *MockGPTClient) EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport, metadata *enrichment.ScrapedMetadata) (*shortsv1alpha1.EnrichmentData, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "EnrichCompany", ctx, stockCode, companyName, industry, website, currentSummary, reports, metadata)
	ret0, _ := ret[0].(*shortsv1alpha1.EnrichmentData)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockGPTClientMockRecorder) EnrichCompany(ctx, stockCode, companyName, industry, website, currentSummary, reports, metadata interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "EnrichCompany", reflect.TypeOf((*MockGPTClient)(nil).EnrichCompany), ctx, stockCode, companyName, industry, website, currentSummary, reports, metadata)
}

func (m *MockGPTClient) EvaluateQuality(ctx context.Context, stockCode string, data *shortsv1alpha1.EnrichmentData) (*shortsv1alpha1.QualityScore, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "EvaluateQuality", ctx, stockCode, data)
	ret0, _ := ret[0].(*shortsv1alpha1.QualityScore)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockGPTClientMockRecorder) EvaluateQuality(ctx, stockCode, data interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "EvaluateQuality", reflect.TypeOf((*MockGPTClient)(nil).EvaluateQuality), ctx, stockCode, data)
}

func (m *MockGPTClient) DiscoverWebsite(ctx context.Context, stockCode, companyName, industry string) (string, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "DiscoverWebsite", ctx, stockCode, companyName, industry)
	ret0, _ := ret[0].(string)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockGPTClientMockRecorder) DiscoverWebsite(ctx, stockCode, companyName, industry interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "DiscoverWebsite", reflect.TypeOf((*MockGPTClient)(nil).DiscoverWebsite), ctx, stockCode, companyName, industry)
}

func (m *MockGPTClient) ExtractPeopleFromText(ctx context.Context, stockCode, companyName, rawText string) ([]*stocksv1alpha1.CompanyPerson, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ExtractPeopleFromText", ctx, stockCode, companyName, rawText)
	ret0, _ := ret[0].([]*stocksv1alpha1.CompanyPerson)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockGPTClientMockRecorder) ExtractPeopleFromText(ctx, stockCode, companyName, rawText interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ExtractPeopleFromText", reflect.TypeOf((*MockGPTClient)(nil).ExtractPeopleFromText), ctx, stockCode, companyName, rawText)
}

// MockFinancialReportCrawler is a mock of FinancialReportCrawler interface
type MockFinancialReportCrawler struct {
	ctrl     *gomock.Controller
	recorder *MockFinancialReportCrawlerMockRecorder
}

type MockFinancialReportCrawlerMockRecorder struct {
	mock *MockFinancialReportCrawler
}

func NewMockFinancialReportCrawler(ctrl *gomock.Controller) *MockFinancialReportCrawler {
	mock := &MockFinancialReportCrawler{ctrl: ctrl}
	mock.recorder = &MockFinancialReportCrawlerMockRecorder{mock}
	return mock
}

func (m *MockFinancialReportCrawler) EXPECT() *MockFinancialReportCrawlerMockRecorder {
	return m.recorder
}

func (m *MockFinancialReportCrawler) CrawlFinancialReports(ctx context.Context, website string) ([]*stocksv1alpha1.FinancialReport, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "CrawlFinancialReports", ctx, website)
	ret0, _ := ret[0].([]*stocksv1alpha1.FinancialReport)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockFinancialReportCrawlerMockRecorder) CrawlFinancialReports(ctx, website interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "CrawlFinancialReports", reflect.TypeOf((*MockFinancialReportCrawler)(nil).CrawlFinancialReports), ctx, website)
}

// MockCompanyMetadataScraper is a mock of CompanyMetadataScraper interface
type MockCompanyMetadataScraper struct {
	ctrl     *gomock.Controller
	recorder *MockCompanyMetadataScraperMockRecorder
}

type MockCompanyMetadataScraperMockRecorder struct {
	mock *MockCompanyMetadataScraper
}

func NewMockCompanyMetadataScraper(ctrl *gomock.Controller) *MockCompanyMetadataScraper {
	mock := &MockCompanyMetadataScraper{ctrl: ctrl}
	mock.recorder = &MockCompanyMetadataScraperMockRecorder{mock}
	return mock
}

func (m *MockCompanyMetadataScraper) EXPECT() *MockCompanyMetadataScraperMockRecorder {
	return m.recorder
}

func (m *MockCompanyMetadataScraper) ScrapeMetadata(ctx context.Context, website, companyName string, exaClient enrichment.ExaClient) (*enrichment.ScrapedMetadata, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "ScrapeMetadata", ctx, website, companyName, exaClient)
	ret0, _ := ret[0].(*enrichment.ScrapedMetadata)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockCompanyMetadataScraperMockRecorder) ScrapeMetadata(ctx, website, companyName, exaClient interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "ScrapeMetadata", reflect.TypeOf((*MockCompanyMetadataScraper)(nil).ScrapeMetadata), ctx, website, companyName, exaClient)
}

// MockLogoDiscoverer is a mock of LogoDiscoverer interface
type MockLogoDiscoverer struct {
	ctrl     *gomock.Controller
	recorder *MockLogoDiscovererMockRecorder
}

type MockLogoDiscovererMockRecorder struct {
	mock *MockLogoDiscoverer
}

func NewMockLogoDiscoverer(ctrl *gomock.Controller) *MockLogoDiscoverer {
	mock := &MockLogoDiscoverer{ctrl: ctrl}
	mock.recorder = &MockLogoDiscovererMockRecorder{mock}
	return mock
}

func (m *MockLogoDiscoverer) EXPECT() *MockLogoDiscovererMockRecorder {
	return m.recorder
}

func (m *MockLogoDiscoverer) DiscoverLogo(ctx context.Context, website, companyName, stockCode string) (*enrichment.DiscoveredLogo, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "DiscoverLogo", ctx, website, companyName, stockCode)
	ret0, _ := ret[0].(*enrichment.DiscoveredLogo)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockLogoDiscovererMockRecorder) DiscoverLogo(ctx, website, companyName, stockCode interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "DiscoverLogo", reflect.TypeOf((*MockLogoDiscoverer)(nil).DiscoverLogo), ctx, website, companyName, stockCode)
}

// MockExaClient is a mock of ExaClient interface
type MockExaClient struct {
	ctrl     *gomock.Controller
	recorder *MockExaClientMockRecorder
}

type MockExaClientMockRecorder struct {
	mock *MockExaClient
}

func NewMockExaClient(ctrl *gomock.Controller) *MockExaClient {
	mock := &MockExaClient{ctrl: ctrl}
	mock.recorder = &MockExaClientMockRecorder{mock}
	return mock
}

func (m *MockExaClient) EXPECT() *MockExaClientMockRecorder {
	return m.recorder
}

func (m *MockExaClient) SearchPeople(ctx context.Context, companyName, personName, role string) (*enrichment.ExaSearchResult, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "SearchPeople", ctx, companyName, personName, role)
	ret0, _ := ret[0].(*enrichment.ExaSearchResult)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockExaClientMockRecorder) SearchPeople(ctx, companyName, personName, role interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "SearchPeople", reflect.TypeOf((*MockExaClient)(nil).SearchPeople), ctx, companyName, personName, role)
}

func (m *MockExaClient) SearchCompanyPeople(ctx context.Context, companyName, stockCode string) (*enrichment.ExaSearchResult, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "SearchCompanyPeople", ctx, companyName, stockCode)
	ret0, _ := ret[0].(*enrichment.ExaSearchResult)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}

func (mr *MockExaClientMockRecorder) SearchCompanyPeople(ctx, companyName, stockCode interface{}) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "SearchCompanyPeople", reflect.TypeOf((*MockExaClient)(nil).SearchCompanyPeople), ctx, companyName, stockCode)
}
