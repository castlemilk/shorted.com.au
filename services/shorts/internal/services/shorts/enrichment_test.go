package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

func allowAnyLogs(l *mocks.MockLogger) {
	l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Infof(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Warnf(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
}

func TestShortsServer_EnrichStock_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	mockGPT := mocks.NewMockGPTClient(ctrl)
	mockCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config:        DefaultConfig(),
		store:         mockStore,
		cache:         NewMemoryCache(time.Minute),
		logger:        mockLogger,
		gptClient:     mockGPT,
		reportCrawler: mockCrawler,
	}

	stockCode := "CVN"
	details := &stocksv1alpha1.StockDetails{
		ProductCode:       stockCode,
		CompanyName:       "Carnarvon Energy",
		Industry:          "Energy",
		Website:           "https://example.com",
		Summary:           "Energy producer",
		EnrichmentStatus:  "pending",
	}

	reports := []*stocksv1alpha1.FinancialReport{
		{Url: "https://example.com/report.pdf", Title: "Annual Report", Type: "annual_report", Date: "2024-12-31", Source: "crawler"},
	}

	enriched := &shortsv1alpha1.EnrichmentData{
		EnhancedSummary: "Test summary",
		CompanyHistory:  "Test history",
		Tags:            []string{"tag1", "tag2", "tag3", "tag4", "tag5"},
		FinancialReports: reports,
	}

	quality := &shortsv1alpha1.QualityScore{
		OverallScore:      0.9,
		CompletenessScore: 0.9,
		AccuracyScore:     0.8,
		Strengths:         []string{"good"},
	}

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetStockDetails(stockCode).Return(details, nil)
	mockCrawler.EXPECT().CrawlFinancialReports(gomock.Any(), details.Website).Return(reports, nil)

	mockGPT.EXPECT().EnrichCompany(
		gomock.Any(),
		stockCode,
		details.CompanyName,
		details.Industry,
		details.Website,
		details.Summary,
		reports,
	).Return(enriched, nil)
	mockGPT.EXPECT().EvaluateQuality(gomock.Any(), stockCode, enriched).Return(quality, nil)
	mockStore.EXPECT().SavePendingEnrichment(gomock.Any(), stockCode, shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW, enriched, quality).Return(nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     true,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, stockCode, resp.Msg.StockCode)
	assert.Equal(t, shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW, resp.Msg.Status)
	assert.NotEmpty(t, resp.Msg.EnrichmentId)
	assert.Equal(t, enriched, resp.Msg.Data)
	assert.Equal(t, quality, resp.Msg.QualityScore)
}

func TestShortsServer_EnrichStock_SkipsWhenAlreadyEnrichedAndNotForced(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	mockGPT := mocks.NewMockGPTClient(ctrl)
	mockCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config:        DefaultConfig(),
		store:         mockStore,
		cache:         NewMemoryCache(time.Minute),
		logger:        mockLogger,
		gptClient:     mockGPT,
		reportCrawler: mockCrawler,
	}

	stockCode := "CBA"
	details := &stocksv1alpha1.StockDetails{
		ProductCode:      stockCode,
		CompanyName:      "Commonwealth Bank",
		Website:          "https://example.com",
		EnrichmentStatus: "completed",
	}

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetStockDetails(stockCode).Return(details, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_COMPLETED, resp.Msg.Status)
	assert.NotEmpty(t, resp.Msg.ErrorMessage)
}

func TestShortsServer_ReviewEnrichment_Approve(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config: DefaultConfig(),
		store:  mockStore,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}

	enrichmentID := "11111111-1111-1111-1111-111111111111"
	pending := &shortsv1alpha1.PendingEnrichment{
		EnrichmentId: enrichmentID,
		StockCode:    "CVN",
		Data:         &shortsv1alpha1.EnrichmentData{EnhancedSummary: "v2"},
	}

	mockStore.EXPECT().GetPendingEnrichment(enrichmentID).Return(pending, nil)
	mockStore.EXPECT().ApplyEnrichment(pending.StockCode, pending.Data).Return(nil)
	mockStore.EXPECT().ReviewEnrichment(enrichmentID, true, "admin@shorted.com.au", "looks good").Return(nil)

	ctx := context.WithValue(context.Background(), userKey, &Claims{Email: "admin@shorted.com.au", UserID: "admin@shorted.com.au", Roles: []string{"admin"}})

	resp, err := server.ReviewEnrichment(ctx, connect.NewRequest(&shortsv1alpha1.ReviewEnrichmentRequest{
		StockCode:     pending.StockCode,
		EnrichmentId:  enrichmentID,
		Approve:       true,
		ReviewNotes:   "looks good",
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.True(t, resp.Msg.Approved)
	assert.Equal(t, pending.StockCode, resp.Msg.StockCode)
}

func TestShortsServer_ReviewEnrichment_Reject(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config: DefaultConfig(),
		store:  mockStore,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}

	enrichmentID := "22222222-2222-2222-2222-222222222222"
	pending := &shortsv1alpha1.PendingEnrichment{
		EnrichmentId: enrichmentID,
		StockCode:    "CBA",
		Data:         &shortsv1alpha1.EnrichmentData{EnhancedSummary: "v2"},
	}

	mockStore.EXPECT().GetPendingEnrichment(enrichmentID).Return(pending, nil)
	mockStore.EXPECT().ReviewEnrichment(enrichmentID, false, "admin@shorted.com.au", "bad").Return(nil)

	ctx := context.WithValue(context.Background(), userKey, &Claims{Email: "admin@shorted.com.au", UserID: "admin@shorted.com.au", Roles: []string{"admin"}})

	resp, err := server.ReviewEnrichment(ctx, connect.NewRequest(&shortsv1alpha1.ReviewEnrichmentRequest{
		StockCode:    pending.StockCode,
		EnrichmentId: enrichmentID,
		Approve:      false,
		ReviewNotes:  "bad",
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.False(t, resp.Msg.Approved)
}

func TestShortsServer_GetTopStocksForEnrichment_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config: DefaultConfig(),
		store:  mockStore,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}

	candidates := []*shortsv1alpha1.StockEnrichmentCandidate{
		{StockCode: "CBA", CompanyName: "Commonwealth Bank", PriorityScore: 10},
		{StockCode: "BHP", CompanyName: "BHP Group", PriorityScore: 9},
	}

	mockStore.EXPECT().GetTopStocksForEnrichment(int32(100), shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_MARKET_CAP).Return(candidates, nil)

	resp, err := server.GetTopStocksForEnrichment(context.Background(), connect.NewRequest(&shortsv1alpha1.GetTopStocksForEnrichmentRequest{
		Limit:    100,
		Priority: shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_MARKET_CAP,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Len(t, resp.Msg.Stocks, 2)
	assert.Equal(t, "CBA", resp.Msg.Stocks[0].StockCode)
}

func TestShortsServer_ListPendingEnrichments_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config: DefaultConfig(),
		store:  mockStore,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}

	items := []*shortsv1alpha1.PendingEnrichmentSummary{
		{EnrichmentId: "id1", StockCode: "CVN", Status: shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW},
	}

	mockStore.EXPECT().ListPendingEnrichments(int32(100), int32(0)).Return(items, nil)

	resp, err := server.ListPendingEnrichments(context.Background(), connect.NewRequest(&shortsv1alpha1.ListPendingEnrichmentsRequest{
		Limit:  100,
		Offset: 0,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Len(t, resp.Msg.Enrichments, 1)
	assert.Equal(t, "CVN", resp.Msg.Enrichments[0].StockCode)
}

func TestShortsServer_GetPendingEnrichment_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(mockLogger)

	server := &ShortsServer{
		config: DefaultConfig(),
		store:  mockStore,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}

	enrichmentID := "33333333-3333-3333-3333-333333333333"
	pending := &shortsv1alpha1.PendingEnrichment{EnrichmentId: enrichmentID, StockCode: "CVN"}

	mockStore.EXPECT().GetPendingEnrichment(enrichmentID).Return(pending, nil)

	resp, err := server.GetPendingEnrichment(context.Background(), connect.NewRequest(&shortsv1alpha1.GetPendingEnrichmentRequest{
		EnrichmentId: enrichmentID,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, enrichmentID, resp.Msg.Pending.EnrichmentId)
}


