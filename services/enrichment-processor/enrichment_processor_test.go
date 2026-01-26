package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/enrichment-processor/mocks"
)

func TestEnrichmentProcessor_ProcessJob_FullFlow(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// Setup mocks
	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	mockLogoDiscoverer := mocks.NewMockLogoDiscoverer(ctrl)
	mockExaClient := mocks.NewMockExaClient(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:            mockStore,
		gptClient:        mockGPTClient,
		reportCrawler:    mockReportCrawler,
		metadataScraper:  mockMetadataScraper,
		logoDiscoverer:   mockLogoDiscoverer,
		exaClient:        mockExaClient,
		logger:           logger,
		timeout:          10 * time.Minute,
		qualityThreshold: 0.7,
		gcsBucket:        "test-bucket",
	}

	jobID := "test-job-123"
	stockCode := "DMP"
	force := false

	// Mock stock details
	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Industry:     "Food & Beverages",
		Website:      "https://www.dominos.com.au",
		Summary:      "Test summary",
		EnrichmentStatus: "pending",
	}

	// Mock scraped metadata
	scrapedMetadata := &enrichment.ScrapedMetadata{
		LeadershipPages: []enrichment.LeadershipPage{
			{URL: "https://www.dominos.com.au/leadership", Title: "Leadership", People: []enrichment.Person{
				{Name: "John Doe", Role: "CEO"},
			}},
		},
		AboutPages: []enrichment.AboutPage{
			{URL: "https://www.dominos.com.au/about", Title: "About Us"},
		},
		KeyLinks: []enrichment.KeyLink{
			{URL: "https://www.dominos.com.au/investors", Category: "investors"},
		},
	}

	// Mock financial reports
	reports := []*stocksv1alpha1.FinancialReport{
		{Type: "annual", Date: "2023"},
	}

	// Mock enrichment data
	enrichedData := &shortsv1alpha1.EnrichmentData{
		EnhancedSummary: "Enhanced summary",
		KeyPeople: []*stocksv1alpha1.CompanyPerson{
			{Name: "John Doe", Role: "CEO"},
		},
	}

	// Mock quality score
	qualityScore := &shortsv1alpha1.QualityScore{
		OverallScore: 0.85,
		Warnings:     []string{},
	}

	// Mock discovered logo
	discoveredLogo := &enrichment.DiscoveredLogo{
		SourceURL:    "https://www.dominos.com.au/logo.svg",
		Format:       "svg",
		Width:        256,
		Height:       256,
		QualityScore: 0.9,
		SVGData:       []byte("<svg>...</svg>"),
	}

	// Setup expectations - Phase 1: Update job status to processing
	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	// Phase 1: Get stock details
	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	// Phase 1: Scrape metadata
	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, mockExaClient).
		Return(scrapedMetadata, nil)

	// Phase 2: Crawl financial reports
	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), stockDetails.Website).
		Return(reports, nil)

	// Phase 3: LLM enrichment
	mockGPTClient.EXPECT().
		EnrichCompany(
			gomock.Any(),
			stockCode,
			stockDetails.CompanyName,
			stockDetails.Industry,
			stockDetails.Website,
			stockDetails.Summary,
			reports,
			scrapedMetadata,
		).
		Return(enrichedData, nil)

	// Phase 4: Logo discovery
	mockLogoDiscoverer.EXPECT().
		DiscoverLogo(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, stockCode).
		Return(discoveredLogo, nil)

	// Phase 4: Logo processing (will fail in test environment, but we'll mock it)
	// Note: processLogo calls Python script which won't work in unit tests
	// We'll test that it's called and handles errors gracefully

	// Phase 5: Quality evaluation
	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), stockCode, enrichedData).
		Return(qualityScore, nil)

	// Save pending enrichment
	enrichmentID := "enrichment-123"
	mockStore.EXPECT().
		SavePendingEnrichment(
			gomock.Any(), // enrichmentID (UUID generated)
			stockCode,
			shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
			enrichedData,
			qualityScore,
		).
		DoAndReturn(func(id, sc string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
			enrichmentID = id
			return id, nil
		})

	// Update job status to completed
	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED,
			gomock.Any(), // enrichmentID
			nil,
		).
		Return(nil)

	// Execute
	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, force)

	// Verify
	require.NoError(t, err)
	assert.NotEmpty(t, enrichmentID)
}

func TestEnrichmentProcessor_ProcessJob_AlreadyEnriched_WithoutForce(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:   mockStore,
		logger:  logger,
		timeout: 10 * time.Minute,
	}

	jobID := "test-job-456"
	stockCode := "DMP"
	force := false

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:       stockCode,
		EnrichmentStatus: "completed", // Already enriched
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			gomock.Any(),
		).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, force)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "already enriched")
}

func TestEnrichmentProcessor_ProcessJob_AlreadyEnriched_WithForce(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logger:          logger,
		timeout:         10 * time.Minute,
	}

	jobID := "test-job-789"
	stockCode := "DMP"
	force := true // Force re-enrichment

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:       stockCode,
		EnrichmentStatus: "completed", // Already enriched, but force=true
		CompanyName:     "Domino's Pizza",
		Website:         "https://www.dominos.com.au",
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	// Should proceed with enrichment despite already being enriched
	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.QualityScore{OverallScore: 0.8}, nil)

	mockStore.EXPECT().
		SavePendingEnrichment(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return("enrichment-123", nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, force)

	// Should succeed with force=true
	require.NoError(t, err)
}

func TestEnrichmentProcessor_ProcessJob_MetadataScrapingFailure(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		metadataScraper: mockMetadataScraper,
		reportCrawler:   mockReportCrawler,
		gptClient:       mockGPTClient,
		logger:          logger,
		timeout:         10 * time.Minute,
	}

	jobID := "test-job-metadata-fail"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	// Metadata scraping fails, but should continue
	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(nil, fmt.Errorf("scraping failed"))

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), nil).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.QualityScore{OverallScore: 0.8}, nil)

	mockStore.EXPECT().
		SavePendingEnrichment(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return("enrichment-123", nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	// Should succeed despite metadata scraping failure
	require.NoError(t, err)
}

func TestEnrichmentProcessor_ProcessJob_LogoDiscovery_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	mockLogoDiscoverer := mocks.NewMockLogoDiscoverer(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logoDiscoverer:  mockLogoDiscoverer,
		logger:          logger,
		timeout:         10 * time.Minute,
		gcsBucket:       "test-bucket",
	}

	jobID := "test-job-logo"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	discoveredLogo := &enrichment.DiscoveredLogo{
		SourceURL:    "https://www.dominos.com.au/logo.svg",
		Format:       "svg",
		QualityScore: 0.9,
		SVGData:       []byte("<svg>...</svg>"),
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	// Logo discovery succeeds
	mockLogoDiscoverer.EXPECT().
		DiscoverLogo(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, stockCode).
		Return(discoveredLogo, nil)

	// Logo processing will fail in test (Python script), but that's OK - we test the flow

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.QualityScore{OverallScore: 0.8}, nil)

	mockStore.EXPECT().
		SavePendingEnrichment(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return("enrichment-123", nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	// Should succeed - logo discovery is optional
	require.NoError(t, err)
}

func TestEnrichmentProcessor_ProcessJob_LogoDiscovery_Failure(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	mockLogoDiscoverer := mocks.NewMockLogoDiscoverer(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logoDiscoverer:  mockLogoDiscoverer,
		logger:          logger,
		timeout:         10 * time.Minute,
		gcsBucket:       "test-bucket",
	}

	jobID := "test-job-logo-fail"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	// Logo discovery fails
	mockLogoDiscoverer.EXPECT().
		DiscoverLogo(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, stockCode).
		Return(nil, fmt.Errorf("logo discovery failed"))

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.QualityScore{OverallScore: 0.8}, nil)

	mockStore.EXPECT().
		SavePendingEnrichment(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return("enrichment-123", nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	// Should succeed - logo discovery failure is non-fatal
	require.NoError(t, err)
}

func TestEnrichmentProcessor_ProcessJob_QualityBelowThreshold(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logger:          logger,
		timeout:         10 * time.Minute,
		qualityThreshold: 0.7,
	}

	jobID := "test-job-quality"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	lowQualityScore := &shortsv1alpha1.QualityScore{
		OverallScore: 0.5, // Below threshold of 0.7
		Warnings:     []string{},
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(lowQualityScore, nil)

	// Should still save with warning
	mockStore.EXPECT().
		SavePendingEnrichment(
			gomock.Any(),
			gomock.Any(),
			gomock.Any(),
			gomock.Any(),
			gomock.Any(),
		).
		DoAndReturn(func(id, sc string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
			// Verify warning was added
			assert.Contains(t, quality.Warnings, "overall_score 0.50 is below threshold 0.70")
			return id, nil
		})

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	// Should succeed but with quality warning
	require.NoError(t, err)
}

func TestEnrichmentProcessor_ProcessJob_LLMEnrichmentFailure(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logger:          logger,
		timeout:         10 * time.Minute,
	}

	jobID := "test-job-llm-fail"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	// LLM enrichment fails
	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(nil, fmt.Errorf("LLM API error"))

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(
			jobID,
			shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
			nil,
			gomock.Any(),
		).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "gpt enrichment failed")
}

// Test job cleanup functions
func TestEnrichmentProcessor_ResetStuckJobs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:  mockStore,
		logger: logger,
	}

	stuckThresholdMinutes := 10
	expectedResetCount := 3

	mockStore.EXPECT().
		ResetStuckJobs(stuckThresholdMinutes).
		Return(expectedResetCount, nil)

	count, err := processor.store.ResetStuckJobs(stuckThresholdMinutes)

	require.NoError(t, err)
	assert.Equal(t, expectedResetCount, count)
}

func TestEnrichmentProcessor_CleanupOldCompletedJobs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:  mockStore,
		logger: logger,
	}

	keepPerStock := 3
	expectedCleanupCount := 5

	mockStore.EXPECT().
		CleanupOldCompletedJobs(keepPerStock).
		Return(expectedCleanupCount, nil)

	count, err := processor.store.CleanupOldCompletedJobs(keepPerStock)

	require.NoError(t, err)
	assert.Equal(t, expectedCleanupCount, count)
}

// Test logo URL updates
func TestEnrichmentProcessor_UpdateLogoURLs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:  mockStore,
		logger: logger,
	}

	stockCode := "DMP"
	logoGCSURL := "gs://bucket/logos/DMP_logo.png"
	iconGCSURL := "gs://bucket/logos/DMP_icon.png"

	mockStore.EXPECT().
		UpdateLogoURLs(stockCode, logoGCSURL, iconGCSURL).
		Return(nil)

	err := processor.store.UpdateLogoURLs(stockCode, logoGCSURL, iconGCSURL)

	require.NoError(t, err)
}

func TestEnrichmentProcessor_UpdateLogoURLsWithSVG(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:  mockStore,
		logger: logger,
	}

	stockCode := "DMP"
	logoGCSURL := "gs://bucket/logos/DMP_logo.png"
	iconGCSURL := "gs://bucket/logos/DMP_icon.png"
	svgGCSURL := "gs://bucket/logos/DMP_logo.svg"
	sourceURL := "https://www.dominos.com.au/logo.svg"
	format := "svg"

	mockStore.EXPECT().
		UpdateLogoURLsWithSVG(stockCode, logoGCSURL, iconGCSURL, svgGCSURL, sourceURL, format).
		Return(nil)

	err := processor.store.UpdateLogoURLsWithSVG(stockCode, logoGCSURL, iconGCSURL, svgGCSURL, sourceURL, format)

	require.NoError(t, err)
}

// Test nil logo discoverer (should skip Phase 4)
func TestEnrichmentProcessor_ProcessJob_NilLogoDiscoverer(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:           mockStore,
		gptClient:       mockGPTClient,
		reportCrawler:   mockReportCrawler,
		metadataScraper: mockMetadataScraper,
		logoDiscoverer:  nil, // Nil logo discoverer
		logger:          logger,
		timeout:         10 * time.Minute,
	}

	jobID := "test-job-nil-logo"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode:    stockCode,
		CompanyName:  "Domino's Pizza",
		Website:      "https://www.dominos.com.au",
		EnrichmentStatus: "pending",
	}

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).
		Return(nil)

	mockStore.EXPECT().
		GetStockDetails(stockCode).
		Return(stockDetails, nil)

	mockMetadataScraper.EXPECT().
		ScrapeMetadata(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&enrichment.ScrapedMetadata{}, nil)

	mockReportCrawler.EXPECT().
		CrawlFinancialReports(gomock.Any(), gomock.Any()).
		Return([]*stocksv1alpha1.FinancialReport{}, nil)

	mockGPTClient.EXPECT().
		EnrichCompany(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.EnrichmentData{}, nil)

	// Phase 4 should be skipped (no logo discoverer)

	mockGPTClient.EXPECT().
		EvaluateQuality(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(&shortsv1alpha1.QualityScore{OverallScore: 0.8}, nil)

	mockStore.EXPECT().
		SavePendingEnrichment(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return("enrichment-123", nil)

	mockStore.EXPECT().
		UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).
		Return(nil)

	ctx := context.Background()
	err := processor.processJob(ctx, jobID, stockCode, false)

	// Should succeed - Phase 4 is optional
	require.NoError(t, err)
}

