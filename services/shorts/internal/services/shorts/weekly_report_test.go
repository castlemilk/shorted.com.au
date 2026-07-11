package shorts

import (
	"context"
	"errors"
	"sort"
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

// newReportsTestServer builds a ShortsServer whose logger tolerates every
// log level (branding hydration warns on failure, which newTestServer's
// logger does not allow).
func newReportsTestServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	mockLogger := mocks.NewMockLogger(ctrl)
	mockLogger.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
	mockLogger.EXPECT().Infof(gomock.Any(), gomock.Any()).AnyTimes()
	mockLogger.EXPECT().Warnf(gomock.Any(), gomock.Any()).AnyTimes()
	mockLogger.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
	return &ShortsServer{
		store:  store,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}
}

// codeSetMatcher matches a []string argument regardless of order.
type codeSetMatcher struct {
	want []string
}

func (m codeSetMatcher) Matches(x interface{}) bool {
	got, ok := x.([]string)
	if !ok || len(got) != len(m.want) {
		return false
	}
	gotSorted := append([]string{}, got...)
	wantSorted := append([]string{}, m.want...)
	sort.Strings(gotSorted)
	sort.Strings(wantSorted)
	for i := range gotSorted {
		if gotSorted[i] != wantSorted[i] {
			return false
		}
	}
	return true
}

func (m codeSetMatcher) String() string {
	return "matches code set"
}

func weeklyReportFixture() *shortsstore.WeeklyReport {
	score := 0.9
	return &shortsstore.WeeklyReport{
		WeekSlug:     "2026-W06",
		ReportDate:   "2026-02-06",
		PreviousDate: "2026-01-30",
		Headline:     "Shorts pile in",
		Summary:      "A busy week.",
		QualityScore: &score,
		TopShorted: []byte(`[
			{"rank":1,"code":"PLS","name":"Pilbara Minerals","short_pct":21.5,"industry":"Materials","days_to_cover":6.1,"is_new_entrant":true,"history":[20.1,21.5]},
			{"rank":2,"code":"BHP","name":"BHP Group","short_pct":3.2}
		]`),
		Risers: []byte(`[
			{"code":"ZIP","name":"Zip Co","current_pct":8.4,"previous_pct":7.0,"change":1.4,"z_score":2.1,"streak_weeks":3}
		]`),
		Fallers: []byte(`[
			{"code":"SYA","name":"Sayona Mining","current_pct":5.5,"previous_pct":6.5,"change":-1.0,"industry":"Mining"}
		]`),
		IndustryBreakdown: []byte(`[
			{"industry":"Materials","avg_short_pct":6.2,"wow_change":-0.3,"stock_count":12,"top_stock_code":"PLS","top_stock_pct":21.5}
		]`),
		MarketStats: []byte(`{"total_stocks_shorted":812,"avg_short_pct":2.1,"max_short_pct":21.5,"max_short_code":"PLS","median_short_pct":1.4,"stocks_above_10pct":18,"stocks_above_5pct":75,"riser_count":301,"faller_count":288}`),
	}
}

func TestGetWeeklyReport_HydratesBrandingAndIndustryBreakdown(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetWeeklyReport("2026-W06").Return(weeklyReportFixture(), nil)
	mockStore.EXPECT().
		GetCompanyBranding(codeSetMatcher{want: []string{"PLS", "BHP", "ZIP", "SYA"}}).
		Return(map[string]shortsstore.CompanyBranding{
			"PLS": {LogoURL: "https://gcs/pls-icon.png", Industry: "Basic Materials"},
			"BHP": {LogoURL: "https://gcs/bhp-icon.png", Industry: "Mining"},
			"ZIP": {LogoURL: "https://gcs/zip-icon.png", Industry: "Financials"},
			"SYA": {LogoURL: "https://gcs/sya-icon.png", Industry: "Materials"},
		}, nil)

	srv := newReportsTestServer(t, mockStore)
	resp, err := srv.GetWeeklyReport(context.Background(), connect.NewRequest(&shortsv1alpha1.GetWeeklyReportRequest{
		WeekSlug: "2026-W06",
	}))
	require.NoError(t, err)

	// Logos are always applied.
	require.Len(t, resp.Msg.TopShorted, 2)
	assert.Equal(t, "https://gcs/pls-icon.png", resp.Msg.TopShorted[0].LogoUrl)
	assert.Equal(t, "https://gcs/bhp-icon.png", resp.Msg.TopShorted[1].LogoUrl)

	// Industry: only backfilled when the stored snapshot left it empty.
	assert.Equal(t, "Materials", resp.Msg.TopShorted[0].Industry, "stored industry must not be overwritten")
	assert.Equal(t, "Mining", resp.Msg.TopShorted[1].Industry, "empty industry must be backfilled")

	// New extended snapshot fields round-trip through the snake_case contract.
	assert.InDelta(t, 6.1, resp.Msg.TopShorted[0].DaysToCover, 0.001)
	assert.True(t, resp.Msg.TopShorted[0].IsNewEntrant)
	assert.Equal(t, []float64{20.1, 21.5}, resp.Msg.TopShorted[0].History)

	// Movers hydrate the same way.
	require.Len(t, resp.Msg.Risers, 1)
	assert.Equal(t, "https://gcs/zip-icon.png", resp.Msg.Risers[0].LogoUrl)
	assert.Equal(t, "Financials", resp.Msg.Risers[0].Industry)
	assert.InDelta(t, 2.1, resp.Msg.Risers[0].ZScore, 0.001)
	assert.Equal(t, int32(3), resp.Msg.Risers[0].StreakWeeks)

	require.Len(t, resp.Msg.Fallers, 1)
	assert.Equal(t, "https://gcs/sya-icon.png", resp.Msg.Fallers[0].LogoUrl)
	assert.Equal(t, "Mining", resp.Msg.Fallers[0].Industry, "stored mover industry must not be overwritten")

	// industry_breakdown is parsed into the response.
	require.Len(t, resp.Msg.IndustryBreakdown, 1)
	ib := resp.Msg.IndustryBreakdown[0]
	assert.Equal(t, "Materials", ib.Industry)
	assert.InDelta(t, 6.2, ib.AvgShortPct, 0.001)
	assert.InDelta(t, -0.3, ib.WowChange, 0.001)
	assert.Equal(t, int32(12), ib.StockCount)
	assert.Equal(t, "PLS", ib.TopStockCode)
	assert.InDelta(t, 21.5, ib.TopStockPct, 0.001)

	// Extended market stats fields parse.
	require.NotNil(t, resp.Msg.MarketStats)
	assert.InDelta(t, 1.4, resp.Msg.MarketStats.MedianShortPct, 0.001)
	assert.Equal(t, int32(18), resp.Msg.MarketStats.StocksAbove_10Pct)
	assert.Equal(t, int32(75), resp.Msg.MarketStats.StocksAbove_5Pct)
	assert.Equal(t, int32(301), resp.Msg.MarketStats.RiserCount)
	assert.Equal(t, int32(288), resp.Msg.MarketStats.FallerCount)
}

func TestGetWeeklyReport_BrandingFailureIsNonFatal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetWeeklyReport("2026-W06").Return(weeklyReportFixture(), nil)
	mockStore.EXPECT().
		GetCompanyBranding(gomock.Any()).
		Return(nil, errors.New("db unavailable"))

	srv := newReportsTestServer(t, mockStore)
	resp, err := srv.GetWeeklyReport(context.Background(), connect.NewRequest(&shortsv1alpha1.GetWeeklyReportRequest{
		WeekSlug: "2026-W06",
	}))

	require.NoError(t, err, "branding failure must not fail the request")
	require.Len(t, resp.Msg.TopShorted, 2)
	assert.Empty(t, resp.Msg.TopShorted[0].LogoUrl)
	assert.Empty(t, resp.Msg.TopShorted[1].LogoUrl)
	// Stored industry survives untouched.
	assert.Equal(t, "Materials", resp.Msg.TopShorted[0].Industry)
}

func TestGetWeeklyReport_NoCodesSkipsBrandingLookup(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	report := weeklyReportFixture()
	report.TopShorted = nil
	report.Risers = nil
	report.Fallers = nil

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetWeeklyReport("2026-W06").Return(report, nil)
	// No GetCompanyBranding expectation: calling it would fail the test.

	srv := newReportsTestServer(t, mockStore)
	resp, err := srv.GetWeeklyReport(context.Background(), connect.NewRequest(&shortsv1alpha1.GetWeeklyReportRequest{
		WeekSlug: "2026-W06",
	}))

	require.NoError(t, err)
	assert.Empty(t, resp.Msg.TopShorted)
	require.Len(t, resp.Msg.IndustryBreakdown, 1)
}

func TestGetWeeklyReport_InvalidSlugRejected(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newReportsTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.GetWeeklyReport(context.Background(), connect.NewRequest(&shortsv1alpha1.GetWeeklyReportRequest{
		WeekSlug: "not-a-slug",
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}
