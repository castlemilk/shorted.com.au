package shorts

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func industryDate(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", value)
	require.NoError(t, err)
	return parsed
}

func industryFloat(v float64) *float64 { return &v }

func TestGetIndustryIntelligence_HappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	periodStart := industryDate(t, "2023-07-01")
	periodEnd := industryDate(t, "2024-06-30")
	asOf := industryDate(t, "2024-06-30")

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetIndustryIntelligence("Materials", int32(25)).
		Return(&shortsstore.IndustryIntelligenceResult{
			Sources: []shortsstore.IndustryIntelligenceSourceRow{
				{
					SourceKey:   "ato-corporate-tax-transparency",
					DisplayName: "ATO Corporate Tax Transparency",
					SignalKind:  "tax_environment",
					Publisher:   "Australian Taxation Office",
					SourceURL:   "https://data.gov.au/data/dataset/corporate-transparency",
					Licence:     "CC-BY-3.0-AU",
					Cadence:     "Annual",
				},
			},
			Records: []shortsstore.IndustryIntelligenceRecordRow{
				{
					SourceKey:      "ato-corporate-tax-transparency",
					SourceRecordID: "ato-tax:49004028077:2024",
					SignalKind:     "tax_environment",
					Industry:       "Materials",
					StockCode:      "BHP",
					EntityABN:      "49004028077",
					MetricKey:      "total_income",
					MetricLabel:    "Total income",
					MetricValue:    industryFloat(79_000_000_000),
					Unit:           "AUD",
					PeriodStart:    &periodStart,
					PeriodEnd:      &periodEnd,
					AsOf:           asOf,
					Title:          "ATO tax transparency: BHP GROUP LIMITED 2024",
					Summary:        "ATO reported total income for BHP GROUP LIMITED in the 2023-24 income year.",
					SourceURL:      "https://data.gov.au/data/dataset/corporate-transparency",
					Confidence:     1,
				},
			},
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetIndustryIntelligence(context.Background(), connect.NewRequest(&shortsv1alpha1.GetIndustryIntelligenceRequest{
		Industry:    " Materials ",
		RecordLimit: 25,
	}))

	require.NoError(t, err)
	assert.Equal(t, "Materials", resp.Msg.Industry)
	assert.Equal(t, "ATO Corporate Tax Transparency", resp.Msg.SourceAttribution)
	require.NotNil(t, resp.Msg.GeneratedAt)
	require.Len(t, resp.Msg.Sources, 1)
	assert.Equal(t, "Australian Taxation Office", resp.Msg.Sources[0].Publisher)
	require.Len(t, resp.Msg.Records, 1)
	record := resp.Msg.Records[0]
	assert.Equal(t, "BHP", record.StockCode)
	assert.True(t, record.HasMetricValue)
	assert.InDelta(t, 79_000_000_000.0, record.MetricValue, 1)
	assert.Equal(t, "2023-07-01", record.PeriodStart)
	assert.Equal(t, "2024-06-30", record.PeriodEnd)
	assert.Equal(t, "2024-06-30", record.AsOf)
}

func TestGetIndustryIntelligence_RejectsOverlongIndustry(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.GetIndustryIntelligence(context.Background(), connect.NewRequest(&shortsv1alpha1.GetIndustryIntelligenceRequest{
		Industry: strings.Repeat("x", industryIntelligenceMaxIndustryLength+1),
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestNormalizeIndustryIntelligenceLimit(t *testing.T) {
	assert.Equal(t, int32(50), normalizeIndustryIntelligenceLimit(0))
	assert.Equal(t, int32(50), normalizeIndustryIntelligenceLimit(-1))
	assert.Equal(t, int32(25), normalizeIndustryIntelligenceLimit(25))
	assert.Equal(t, int32(200), normalizeIndustryIntelligenceLimit(999))
}

func TestGetIndustryIntelligence_StoreErrorReturnsInternalWithoutLeaking(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetIndustryIntelligence("Materials", int32(50)).
		Return(nil, errors.New("pq: password authentication failed for user internal"))

	srv := newTestServer(t, mockStore)
	_, err := srv.GetIndustryIntelligence(context.Background(), connect.NewRequest(&shortsv1alpha1.GetIndustryIntelligenceRequest{
		Industry: "Materials",
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	assert.Contains(t, err.Error(), "failed to get industry intelligence")
	assert.NotContains(t, err.Error(), "password authentication")
}
