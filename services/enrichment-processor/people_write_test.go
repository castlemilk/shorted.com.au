package main

import (
	"context"
	"encoding/json"
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

// §6.5 buildPeopleOnlyWriteJSON: drops empty + placeholder names, keeps real people,
// and emits the snake_case JSON shape the served key_people parser expects.
func TestBuildPeopleOnlyWriteJSON(t *testing.T) {
	people := []*stocksv1alpha1.CompanyPerson{
		{Name: "Jane Roe", Role: "CEO", LinkedinUrl: "https://linkedin.com/in/janeroe", SourceType: "yahoo_finance"},
		{Name: "John Doe", Role: "CFO"},      // placeholder name → dropped
		{Name: "  ", Role: "Director"},        // empty → dropped
		nil,                                    // nil → skipped
		{Name: "Sam Lee", Role: "Chair"},
	}

	data, count := buildPeopleOnlyWriteJSON(people)
	require.Equal(t, 2, count, "should keep only the two real names")

	var out []map[string]any
	require.NoError(t, json.Unmarshal(data, &out))
	require.Len(t, out, 2)
	assert.Equal(t, "Jane Roe", out[0]["name"])
	assert.Equal(t, "CEO", out[0]["role"])
	// snake_case keys must match the served parser (image_gcs_url/linkedin_url/source_type)
	assert.Equal(t, "https://linkedin.com/in/janeroe", out[0]["linkedin_url"])
	assert.Equal(t, "yahoo_finance", out[0]["source_type"])
	assert.Equal(t, "Sam Lee", out[1]["name"])
}

func TestBuildPeopleOnlyWriteJSON_EmptyAndAllPlaceholders(t *testing.T) {
	data, count := buildPeopleOnlyWriteJSON(nil)
	assert.Nil(t, data)
	assert.Equal(t, 0, count)

	data, count = buildPeopleOnlyWriteJSON([]*stocksv1alpha1.CompanyPerson{
		{Name: "John Doe"}, {Name: "N/A"}, {Name: "unknown"},
	})
	assert.Nil(t, data)
	assert.Equal(t, 0, count, "all-placeholder input must yield nothing to write")
}

// guard: confirm the placeholder filter we rely on actually rejects "John Doe".
func TestIsPlaceholderName_Sanity(t *testing.T) {
	assert.True(t, enrichment.IsPlaceholderName("John Doe"))
	assert.False(t, enrichment.IsPlaceholderName("Jane Roe"))
}

// §6.5 processJob: when the overall quality score is below the auto-approve gate, the
// discovered key_people are still written via UpdateKeyPeopleIfEmpty (additive), while
// ApplyEnrichment/ReviewEnrichment are NOT called and enrichment_status stays pending.
func TestEnrichmentProcessor_ProcessJob_PeopleOnlyWriteBelowGate(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockEnrichmentStore(ctrl)
	mockGPTClient := mocks.NewMockGPTClient(ctrl)
	mockReportCrawler := mocks.NewMockFinancialReportCrawler(ctrl)
	mockMetadataScraper := mocks.NewMockCompanyMetadataScraper(ctrl)
	mockLogoDiscoverer := mocks.NewMockLogoDiscoverer(ctrl)
	mockExaClient := mocks.NewMockExaClient(ctrl)
	logger := log.NewLogger()

	processor := &enrichmentProcessor{
		store:                mockStore,
		gptClient:            mockGPTClient,
		reportCrawler:        mockReportCrawler,
		metadataScraper:      mockMetadataScraper,
		logoDiscoverer:       mockLogoDiscoverer,
		exaClient:            mockExaClient,
		logger:               logger,
		timeout:              10 * time.Minute,
		qualityThreshold:     0.7,
		autoApproveThreshold: 0.8,  // gate
		writePeopleBelowGate: true, // §6.5 enabled
		minPeopleWriteScore:  0.0,
		gcsBucket:            "test-bucket",
	}

	jobID := "test-job-below-gate"
	stockCode := "DMP"

	stockDetails := &stocksv1alpha1.StockDetails{
		ProductCode: stockCode, CompanyName: "Domino's Pizza", Industry: "Food & Beverages",
		Website: "https://www.dominos.com.au", Summary: "Test summary", EnrichmentStatus: "pending",
	}
	scrapedMetadata := &enrichment.ScrapedMetadata{
		AboutPages: []enrichment.AboutPage{{URL: "https://www.dominos.com.au/about", Title: "About Us"}},
	}
	reports := []*stocksv1alpha1.FinancialReport{{Type: "annual", Date: "2023"}}
	// LLM returns >=1 real person, so the Phase-3a fallback is skipped.
	enrichedData := &shortsv1alpha1.EnrichmentData{
		EnhancedSummary: "Enhanced summary",
		KeyPeople:       []*stocksv1alpha1.CompanyPerson{{Name: "Jane Roe", Role: "CEO"}},
	}
	// Below the 0.80 gate (the documented Yahoo-officer ~0.74 case).
	qualityScore := &shortsv1alpha1.QualityScore{OverallScore: 0.74, Warnings: []string{}}
	discoveredLogo := &enrichment.DiscoveredLogo{SourceURL: "https://x/logo.svg", Format: "svg", Width: 256, Height: 256, QualityScore: 0.9, SVGData: []byte("<svg/>")}

	mockStore.EXPECT().UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING, nil, nil).Return(nil)
	mockStore.EXPECT().GetStockDetails(stockCode).Return(stockDetails, nil)
	mockMetadataScraper.EXPECT().ScrapeMetadata(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, mockExaClient).Return(scrapedMetadata, nil)
	mockReportCrawler.EXPECT().CrawlFinancialReports(gomock.Any(), stockDetails.Website).Return(reports, nil)
	mockGPTClient.EXPECT().EnrichCompany(gomock.Any(), stockCode, stockDetails.CompanyName, stockDetails.Industry, stockDetails.Website, stockDetails.Summary, reports, scrapedMetadata).Return(enrichedData, nil)
	mockLogoDiscoverer.EXPECT().DiscoverLogo(gomock.Any(), stockDetails.Website, stockDetails.CompanyName, stockCode).Return(discoveredLogo, nil)
	mockGPTClient.EXPECT().EvaluateQuality(gomock.Any(), stockCode, enrichedData).Return(qualityScore, nil)
	mockStore.EXPECT().SavePendingEnrichment(gomock.Any(), stockCode, shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW, enrichedData, qualityScore).Return("enrichment-id", nil)

	// THE ASSERTION: people written additively below the gate, returning "wrote=true".
	mockStore.EXPECT().UpdateKeyPeopleIfEmpty(stockCode, gomock.Any()).Return(true, nil)

	// Job completes. ApplyEnrichment / ReviewEnrichment must NOT be called (no EXPECT → gomock fails if they are).
	mockStore.EXPECT().UpdateEnrichmentJobStatus(jobID, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED, gomock.Any(), nil).Return(nil)

	require.NoError(t, processor.processJob(context.Background(), jobID, stockCode, false))
}
