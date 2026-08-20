package shorts

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestListReports_InvalidTypeRejected(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// No store expectations: an invalid type must be rejected before any query.
	srv := newReportsTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
		ReportType: "quarterly",
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestListReports_ValidTypesAccepted(t *testing.T) {
	for _, reportType := range []string{"", "all", "weekly", "monthly", "yearly"} {
		t.Run("type_"+reportType, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockStore := mocks.NewMockShortsStore(ctrl)
			mockStore.EXPECT().ListReports(reportType, 24).Return(nil, nil)

			srv := newReportsTestServer(t, mockStore)
			resp, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
				ReportType: reportType,
			}))
			require.NoError(t, err)
			assert.Empty(t, resp.Msg.Reports, "empty result must be an empty list, not an error")
		})
	}
}

func TestListReports_LimitDefaultsAndCaps(t *testing.T) {
	cases := []struct {
		name      string
		requested int32
		expected  int
	}{
		{"zero defaults to 24", 0, 24},
		{"negative defaults to 24", -5, 24},
		{"in-range passes through", 50, 50},
		{"capped at 500", 1000, 500},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockStore := mocks.NewMockShortsStore(ctrl)
			mockStore.EXPECT().ListReports("weekly", tc.expected).Return(nil, nil)

			srv := newReportsTestServer(t, mockStore)
			_, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
				ReportType: "weekly",
				Limit:      tc.requested,
			}))
			require.NoError(t, err)
		})
	}
}

func listReportsFixture() []*shortsstore.ReportListRow {
	weeklyScore := 0.87
	return []*shortsstore.ReportListRow{
		{
			Slug:         "2026-W06",
			Headline:     "Lithium shorts surge",
			Summary:      "Week six summary.",
			ReportDate:   "2026-02-06",
			QualityScore: &weeklyScore,
			MarketStats:  []byte(`{"total_stocks_shorted":812,"avg_short_pct":2.1,"max_short_pct":21.5,"max_short_code":"PLS","median_short_pct":1.4}`),
			TopShorted: []byte(`[
				{"rank":1,"code":"PLS","short_pct":21.5},
				{"rank":2,"code":"SYA","short_pct":13.0},
				{"rank":3,"code":"LTR","short_pct":11.2},
				{"rank":4,"code":"IEL","short_pct":10.8},
				{"rank":5,"code":"BOE","short_pct":10.1},
				{"rank":6,"code":"CXO","short_pct":9.7}
			]`),
		},
		{
			Slug:       "2026-01",
			Headline:   "January in shorts",
			Summary:    "Monthly summary.",
			ReportDate: "2026-01-31",
		},
		{
			Slug:       "2025",
			Headline:   "The year in shorts",
			Summary:    "Yearly summary.",
			ReportDate: "2025-12-31",
			// Deliberately malformed JSONB: extraction must be non-fatal.
			MarketStats: []byte(`{not json`),
			TopShorted:  []byte(`{also not an array`),
		},
	}
}

func TestListReports_ExtractsStatsCodesAndLogos(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListReports("", 24).Return(listReportsFixture(), nil)
	mockStore.EXPECT().
		GetCompanyBranding(codeSetMatcher{want: []string{"PLS", "SYA", "LTR", "IEL", "BOE"}}).
		Return(map[string]shortsstore.CompanyBranding{
			"PLS": {LogoURL: "https://gcs/pls.png", Industry: "Materials"},
			"SYA": {LogoURL: "https://gcs/sya.png", Industry: "Materials"},
			// LTR unknown: must yield "" in the parallel array.
			"IEL": {LogoURL: "https://gcs/iel.png", Industry: "Education"},
			"BOE": {LogoURL: "https://gcs/boe.png", Industry: "Energy"},
		}, nil)

	srv := newReportsTestServer(t, mockStore)
	resp, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Reports, 3)

	weekly := resp.Msg.Reports[0]
	assert.Equal(t, "2026-W06", weekly.Slug)
	assert.Equal(t, "weekly", weekly.ReportType)
	assert.Equal(t, "Lithium shorts surge", weekly.Headline)
	assert.Equal(t, "2026-02-06", weekly.ReportDate)
	assert.InDelta(t, 0.87, weekly.QualityScore, 0.001)
	// Extracted from market_stats JSONB.
	assert.InDelta(t, 21.5, weekly.MaxShortPct, 0.001)
	assert.Equal(t, "PLS", weekly.MaxShortCode)
	assert.Equal(t, int32(812), weekly.TotalStocksShorted)
	// First 5 codes only (fixture has 6).
	assert.Equal(t, []string{"PLS", "SYA", "LTR", "IEL", "BOE"}, weekly.TopCodes)
	// Parallel logo array, "" for unknown LTR.
	assert.Equal(t, []string{
		"https://gcs/pls.png",
		"https://gcs/sya.png",
		"",
		"https://gcs/iel.png",
		"https://gcs/boe.png",
	}, weekly.TopLogoUrls)

	monthly := resp.Msg.Reports[1]
	assert.Equal(t, "monthly", monthly.ReportType)
	assert.Empty(t, monthly.TopCodes)
	assert.Empty(t, monthly.TopLogoUrls)
	assert.Zero(t, monthly.MaxShortPct)

	yearly := resp.Msg.Reports[2]
	assert.Equal(t, "yearly", yearly.ReportType)
	// Malformed JSONB extraction is non-fatal.
	assert.Empty(t, yearly.TopCodes)
	assert.Zero(t, yearly.MaxShortPct)
	assert.Empty(t, yearly.MaxShortCode)
}

func TestListReports_BrandingFailureIsNonFatal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListReports("weekly", 24).Return(listReportsFixture()[:1], nil)
	mockStore.EXPECT().GetCompanyBranding(gomock.Any()).Return(nil, errors.New("db down"))

	srv := newReportsTestServer(t, mockStore)
	resp, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
		ReportType: "weekly",
	}))
	require.NoError(t, err, "branding failure must not fail the request")
	require.Len(t, resp.Msg.Reports, 1)
	assert.Equal(t, []string{"PLS", "SYA", "LTR", "IEL", "BOE"}, resp.Msg.Reports[0].TopCodes)
	assert.Equal(t, []string{"", "", "", "", ""}, resp.Msg.Reports[0].TopLogoUrls)
}

func TestListReports_StoreErrorIsInternal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListReports("weekly", 24).Return(nil, errors.New("boom"))

	srv := newReportsTestServer(t, mockStore)
	_, err := srv.ListReports(context.Background(), connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
		ReportType: "weekly",
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}
