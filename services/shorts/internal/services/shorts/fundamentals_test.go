package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

func TestGetStockFundamentals_MapsPeriodsGrowthAndHasFlags(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)

	fetched := time.Date(2026, 9, 27, 3, 4, 5, 0, time.FixedZone("AEST", 10*3600))
	fy := int32(2026)
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "ttm", int32(12)).Return([]shortsstore.FundamentalsPeriodRow{
		{
			StockCode: "BHP", PeriodType: "ttm", PeriodEnd: spDate("2026-06-30"), FiscalYear: &fy, Currency: "USD",
			Revenue: f64(5.5e10), NetIncome: f64(0), // a genuine zero is reported as a zero WITH its flag
			EPSBasic: f64(1.9), EPSDiluted: nil, OperatingCashFlow: f64(2e10), FreeCashFlow: f64(-1e9), SharesOutstanding: nil,
			Source: "yahoo-timeseries", SourceFetchedAt: fetched,
		},
		{StockCode: "BHP", PeriodType: "ttm", PeriodEnd: spDate("2025-12-31"), Currency: "USD", Source: "yahoo-timeseries"},
	}, nil)
	latest := spDate("2026-06-30")
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(&strategies.Growth{
		BasisPeriodType: "ttm", LatestPeriodEnd: &latest,
		RevenueYoYPct: f64(12.5), RevenueYoYPriorPct: nil,
		EPSYoYPct: f64(-3), EPSYoYPriorPct: f64(8),
		NetIncomePositive: spBool(true), PeriodsAvailable: 9,
		RevenueTTM: f64(5.5e10), NetIncomeTTM: nil, EPSTTM: f64(1.9),
	}, nil)
	expectNo000132Reads(mockStore, "BHP")

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{
		StockCode: " bhp ", PeriodType: " TTM ",
	}))
	require.NoError(t, err)
	msg := resp.Msg
	assert.Equal(t, "BHP", msg.StockCode)
	require.Len(t, msg.Periods, 2)

	p := msg.Periods[0]
	assert.Equal(t, "ttm", p.PeriodType)
	assert.Equal(t, "2026-06-30", p.PeriodEnd)
	assert.Equal(t, int32(2026), p.FiscalYear)
	assert.Equal(t, "USD", p.Currency)
	assert.Equal(t, "yahoo-timeseries", p.Source)
	assert.Equal(t, "2026-09-26T17:04:05Z", p.FetchedAt, "RFC 3339 in UTC")
	assert.True(t, p.HasRevenue)
	assert.InDelta(t, 5.5e10, p.Revenue, 1)
	assert.True(t, p.HasNetIncome, "a reported zero is still reported")
	assert.Equal(t, float64(0), p.NetIncome)
	assert.True(t, p.HasEpsBasic)
	assert.False(t, p.HasEpsDiluted)
	assert.True(t, p.HasOperatingCashFlow)
	assert.True(t, p.HasFreeCashFlow)
	assert.InDelta(t, -1e9, p.FreeCashFlow, 1)
	assert.False(t, p.HasSharesOutstanding)

	empty := msg.Periods[1]
	assert.Equal(t, int32(0), empty.FiscalYear)
	assert.Equal(t, "", empty.FetchedAt)
	assert.False(t, empty.HasRevenue || empty.HasNetIncome || empty.HasEpsBasic || empty.HasEpsDiluted ||
		empty.HasOperatingCashFlow || empty.HasFreeCashFlow || empty.HasSharesOutstanding)

	require.True(t, msg.HasGrowth)
	g := msg.Growth
	assert.Equal(t, "ttm", g.BasisPeriodType)
	assert.Equal(t, "2026-06-30", g.LatestPeriodEnd)
	assert.True(t, g.HasRevenueYoy)
	assert.InDelta(t, 12.5, g.RevenueYoyPct, 1e-9)
	assert.False(t, g.HasRevenueYoyPrior)
	assert.True(t, g.HasEpsYoy)
	assert.InDelta(t, -3, g.EpsYoyPct, 1e-9)
	assert.True(t, g.HasEpsYoyPrior)
	assert.InDelta(t, 8, g.EpsYoyPriorPct, 1e-9)
	assert.True(t, g.NetIncomePositive)
	assert.Equal(t, int32(9), g.PeriodsAvailable)
	assert.True(t, g.HasRevenueTtm)
	assert.False(t, g.HasNetIncomeTtm)
	assert.True(t, g.HasEpsTtm)
	assert.InDelta(t, 1.9, g.EpsTtm, 1e-9)
	assert.Equal(t, "", g.RevenueBasisPeriodType)
	assert.Equal(t, "", g.HalfLatestPeriodEnd)
	assert.False(t, g.HasRevenueHalfYoy)
	assert.False(t, g.HasEpsHalfYoy)

	// Cached: the identical request does not reach the store again (gomock
	// fails the test on an unexpected second call).
	_, err = srv.GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{
		StockCode: "BHP", PeriodType: "ttm",
	}))
	require.NoError(t, err)
}

func TestGetStockFundamentals_Validation(t *testing.T) {
	ctrl := gomock.NewController(t)
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl)) // strict: the store must not be called

	cases := []struct {
		name  string
		req   *shortsv1alpha1.GetStockFundamentalsRequest
		field string
	}{
		{"missing code", &shortsv1alpha1.GetStockFundamentalsRequest{}, "stock_code"},
		{"bad code", &shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP;--"}, "stock_code"},
		{"too long", &shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "ABCDEFGHIJK"}, "stock_code"},
		{"unknown period type", &shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP", PeriodType: "monthly"}, "period_type"},
		{"limit over max", &shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP", Limit: 41}, "limit"},
		{"negative limit", &shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP", Limit: -1}, "limit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetStockFundamentals(context.Background(), connect.NewRequest(tc.req))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			assert.Contains(t, err.Error(), tc.field)
		})
	}
}

func TestGetStockFundamentals_AcceptsEveryPeriodTypeAndDefaults(t *testing.T) {
	for _, pt := range []string{"", "annual", "half", "quarter", "ttm"} {
		t.Run("period_type="+pt, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "CBA", pt, int32(12)).
				Return([]shortsstore.FundamentalsPeriodRow{{StockCode: "CBA", PeriodType: "annual", PeriodEnd: spDate("2026-06-30")}}, nil)
			mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "CBA").Return(nil, nil)
			expectNo000132Reads(mockStore, "CBA")
			resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{
				StockCode: "CBA", PeriodType: pt,
			}))
			require.NoError(t, err)
			assert.Len(t, resp.Msg.Periods, 1)
			assert.False(t, resp.Msg.HasGrowth)
			assert.Nil(t, resp.Msg.Growth)
		})
	}
}

func TestGetStockFundamentals_UnknownStockIsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "ZZZ", "", int32(40)).Return([]shortsstore.FundamentalsPeriodRow{}, nil).Times(2)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "ZZZ").Return(nil, nil).Times(2)
	mockStore.EXPECT().StockExists("ZZZ").Return(false, nil).Times(2)

	srv := newTestServer(t, mockStore)
	for i := 0; i < 2; i++ { // NotFound is never cached
		_, err := srv.GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "ZZZ", Limit: 40}))
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "ZZZ")
	}
}

func TestGetStockFundamentals_KnownStockWithoutDataIsAnEmptySuccess(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "WBT", "", int32(12)).Return([]shortsstore.FundamentalsPeriodRow{}, nil)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "WBT").Return(nil, nil)
	mockStore.EXPECT().StockExists("WBT").Return(true, nil)
	// No rows: no ratios or filing to read, but the coverage says why.
	mockStore.EXPECT().GetFundamentalsCoverage(gomock.Any(), "WBT").Return(&shortsstore.FundamentalsCoverageRow{
		HasSyncRow: true, LastOutcome: "empty", OutcomeKnown: true, LastAttemptAt: dayPtr("2026-09-27"),
	}, nil)

	resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "WBT"}))
	require.NoError(t, err)
	assert.Equal(t, "WBT", resp.Msg.StockCode)
	assert.Empty(t, resp.Msg.Periods)
	assert.NotNil(t, resp.Msg.Periods)
	assert.False(t, resp.Msg.HasGrowth)
	assert.False(t, resp.Msg.HasQuality)
	assert.False(t, resp.Msg.HasLatestFiling)
	require.NotNil(t, resp.Msg.Coverage)
	assert.Equal(t, "empty", resp.Msg.Coverage.Status)
	assert.Equal(t, "2026-09-27T00:00:00Z", resp.Msg.Coverage.LastAttemptAt)
}

func TestGetStockFundamentals_GrowthWithoutPeriodsSkipsTheExistenceCheck(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "PLS", "half", int32(12)).Return(nil, nil)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "PLS").Return(&strategies.Growth{BasisPeriodType: "annual"}, nil)
	// No StockExists expectation: rows exist, so the code is known.
	expectNo000132Reads(mockStore, "PLS")

	resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "PLS", PeriodType: "half"}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasGrowth)
	assert.Equal(t, "", resp.Msg.Growth.LatestPeriodEnd)
	assert.False(t, resp.Msg.Growth.HasRevenueYoy)
}

// A half-year from a company filing that is newer than the vendor series
// becomes the basis; the response names it rather than implying annual/TTM.
func TestGetStockFundamentals_MapsTheHalfBasis(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	half := spDate("2026-12-31")
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "WTC", "", int32(12)).Return(nil, nil)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "WTC").Return(&strategies.Growth{
		BasisPeriodType: "half", RevenueBasisPeriodType: "half", LatestPeriodEnd: &half, HalfLatestPeriodEnd: &half,
		RevenueYoYPct: f64(22), EPSYoYPct: f64(31),
		RevenueHalfYoYPct: f64(22), NetIncomeHalfYoYPct: f64(18), EPSHalfYoYPct: f64(31),
	}, nil)
	expectNo000132Reads(mockStore, "WTC")

	resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "WTC"}))
	require.NoError(t, err)
	g := resp.Msg.Growth
	require.NotNil(t, g)
	assert.Equal(t, "half", g.BasisPeriodType)
	assert.Equal(t, "half", g.RevenueBasisPeriodType)
	assert.Equal(t, "2026-12-31", g.HalfLatestPeriodEnd)
	assert.True(t, g.HasRevenueHalfYoy)
	assert.InDelta(t, 22, g.RevenueHalfYoyPct, 1e-9)
	assert.True(t, g.HasEpsHalfYoy)
	assert.InDelta(t, 31, g.EpsHalfYoyPct, 1e-9)
}

func TestGetStockFundamentals_StoreErrorsAreInternal(t *testing.T) {
	boom := errors.New("connection reset by peer")
	cases := []struct {
		name   string
		expect func(m *mocks.MockShortsStore)
	}{
		{"periods", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, boom)
		}},
		{"growth", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, nil)
			m.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(nil, boom)
		}},
		{"existence", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, nil)
			m.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(nil, nil)
			m.EXPECT().StockExists("BHP").Return(false, boom)
		}},
		{"extras", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, nil)
			m.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(&strategies.Growth{}, nil)
			m.EXPECT().GetFundamentalsExtras(gomock.Any(), "BHP").Return(nil, boom)
		}},
		{"latest filing", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, nil)
			m.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(&strategies.Growth{}, nil)
			m.EXPECT().GetFundamentalsExtras(gomock.Any(), "BHP").Return(nil, nil)
			m.EXPECT().GetLatestFilingInputs(gomock.Any(), "BHP").Return(nil, boom)
		}},
		{"coverage", func(m *mocks.MockShortsStore) {
			m.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(12)).Return(nil, nil)
			m.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(nil, nil)
			m.EXPECT().StockExists("BHP").Return(true, nil)
			m.EXPECT().GetFundamentalsCoverage(gomock.Any(), "BHP").Return(nil, boom)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			mockStore := mocks.NewMockShortsStore(ctrl)
			tc.expect(mockStore)
			_, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP"}))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
			assert.NotContains(t, err.Error(), "connection reset")
		})
	}
}
