package shorts

import (
	"context"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func allowAnyLogs(l *mocks.MockLogger) {
	l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Infof(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Warnf(gomock.Any(), gomock.Any()).AnyTimes()
	l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
}

// NOTE: Old synchronous enrichment tests removed - EnrichStock now uses async job-based flow
// See TestShortsServer_EnrichStock_* tests below for async flow tests

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

func TestShortsServer_EnrichStock_BlocksWhenPendingEnrichmentExists(t *testing.T) {
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

	stockCode := "DMP"
	pendingEnrichment := &shortsv1alpha1.PendingEnrichmentSummary{
		EnrichmentId: "pending-enrichment-id",
		StockCode:    stockCode,
		Status:       shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
	}

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetActiveEnrichmentJobByStockCode(stockCode).Return(nil, nil)
	mockStore.EXPECT().GetPendingEnrichmentByStockCode(stockCode).Return(pendingEnrichment, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Empty(t, resp.Msg.JobId, "Job ID should be empty when blocked by pending enrichment")
	assert.Contains(t, resp.Msg.Message, "Pending enrichment already exists", "Message should indicate pending enrichment exists")
	assert.Contains(t, resp.Msg.Message, pendingEnrichment.EnrichmentId, "Message should include enrichment ID")
}

func TestShortsServer_EnrichStock_ProceedsWhenForceTrueAndPendingEnrichmentExists(t *testing.T) {
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

	stockCode := "DMP"
	jobID := "new-job-id"

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetActiveEnrichmentJobByStockCode(stockCode).Return(nil, nil)
	// Even if pending enrichment exists, with force=true we should proceed
	mockStore.EXPECT().CreateEnrichmentJob(stockCode, true).Return(jobID, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     true,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, jobID, resp.Msg.JobId, "Job ID should be set when force=true")
	assert.Contains(t, resp.Msg.Message, "Enrichment job created", "Message should indicate job was created")
}

func TestShortsServer_EnrichStock_ProceedsWhenNoPendingEnrichment(t *testing.T) {
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

	stockCode := "NEW"
	jobID := "new-job-id"

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetActiveEnrichmentJobByStockCode(stockCode).Return(nil, nil)
	mockStore.EXPECT().GetPendingEnrichmentByStockCode(stockCode).Return(nil, nil)
	mockStore.EXPECT().CreateEnrichmentJob(stockCode, false).Return(jobID, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, jobID, resp.Msg.JobId, "Job ID should be set")
	assert.Contains(t, resp.Msg.Message, "Enrichment job created", "Message should indicate job was created")
}

func TestShortsServer_EnrichStock_HandlesPendingEnrichmentCheckError(t *testing.T) {
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

	stockCode := "ERR"
	jobID := "new-job-id"

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetActiveEnrichmentJobByStockCode(stockCode).Return(nil, nil)
	// Simulate error checking for pending enrichment - should continue anyway
	mockStore.EXPECT().GetPendingEnrichmentByStockCode(stockCode).Return(nil, fmt.Errorf("database error"))
	mockStore.EXPECT().CreateEnrichmentJob(stockCode, false).Return(jobID, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	// Should proceed despite error (as per the code's safety check behavior)
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, jobID, resp.Msg.JobId, "Job ID should be set even if pending check fails")
}

func TestShortsServer_EnrichStock_StockNotFound(t *testing.T) {
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

	stockCode := "XXX" // Valid format but doesn't exist

	mockStore.EXPECT().StockExists(stockCode).Return(false, nil)

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.Error(t, err)
	assert.Nil(t, resp)
	// Should return NotFound error
	assert.Contains(t, err.Error(), "not found", "Should return not found error")
}

func TestShortsServer_EnrichStock_InvalidStockCode(t *testing.T) {
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

	// Test invalid stock codes
	invalidCodes := []string{"AB", "ABCDE", "12", "A-B", "AB CD"}

	for _, invalidCode := range invalidCodes {
		resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
			StockCode: invalidCode,
			Force:     false,
		}))
		assert.Error(t, err, "Should error for invalid stock code: %s", invalidCode)
		assert.Nil(t, resp, "Should not return response for invalid stock code: %s", invalidCode)
		assert.Contains(t, err.Error(), "stock_code must be 3-4", "Should mention stock code format requirement")
	}
}

func TestShortsServer_EnrichStock_ActiveJobTakesPrecedenceOverPendingEnrichment(t *testing.T) {
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

	stockCode := "TEST"
	activeJobID := "active-job-id"
	activeJob := &shortsv1alpha1.EnrichmentJob{
		JobId:     activeJobID,
		StockCode: stockCode,
		Status:    shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING,
	}

	mockStore.EXPECT().StockExists(stockCode).Return(true, nil)
	mockStore.EXPECT().GetActiveEnrichmentJobByStockCode(stockCode).Return(activeJob, nil)
	// Should not check for pending enrichment if active job exists

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.NoError(t, err)
	assert.NotNil(t, resp)
	assert.Equal(t, activeJobID, resp.Msg.JobId, "Should return active job ID")
	assert.Contains(t, resp.Msg.Message, "already in progress", "Should mention job already in progress")
	// Should not mention pending enrichment since active job check happens first
	assert.NotContains(t, resp.Msg.Message, "Pending enrichment", "Should not mention pending enrichment when active job exists")
}

func TestShortsServer_EnrichStock_StockExistsError(t *testing.T) {
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

	stockCode := "TEST"

	mockStore.EXPECT().StockExists(stockCode).Return(false, fmt.Errorf("database error"))

	resp, err := server.EnrichStock(context.Background(), connect.NewRequest(&shortsv1alpha1.EnrichStockRequest{
		StockCode: stockCode,
		Force:     false,
	}))
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to check stock exists", "Should return internal error")
}


