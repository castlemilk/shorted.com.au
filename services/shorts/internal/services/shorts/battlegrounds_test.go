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

func TestGetBattlegroundStocks_SqueezeViewDefaultsAndRoundTrips(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// UNSPECIFIED view must default to SQUEEZE and limit 0 must default to 25
	mockStore.EXPECT().
		GetBattlegroundStocks(shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_SQUEEZE, int32(25), int32(0)).
		Return([]*shortsstore.BattlegroundStock{
			{
				StockCode:        "PLS",
				CompanyName:      "Pilbara Minerals Limited",
				Industry:         "Materials",
				LogoURL:          "https://example.com/pls.png",
				ShortPct:         18.5,
				ShortPctChange4w: 1.2,
				LatestPrice:      3.42,
				PriceChange1m:    9.8,
				DaysToCover:      8.7,
				SqueezeScore:     82.4,
				DivergenceScore:  19.6,
				MarketCap:        1.03e10,
			},
		}, 137, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetBattlegroundStocks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetBattlegroundStocksRequest{}))

	require.NoError(t, err)
	assert.Equal(t, int32(137), resp.Msg.TotalCount)
	require.Len(t, resp.Msg.Stocks, 1)
	stock := resp.Msg.Stocks[0]
	assert.Equal(t, "PLS", stock.StockCode)
	assert.Equal(t, "Pilbara Minerals Limited", stock.CompanyName)
	assert.Equal(t, "Materials", stock.Industry)
	assert.Equal(t, "https://example.com/pls.png", stock.LogoUrl)
	assert.InDelta(t, 18.5, stock.ShortPct, 0.001)
	assert.InDelta(t, 1.2, stock.ShortPctChange_4W, 0.001)
	assert.InDelta(t, 3.42, stock.LatestPrice, 0.001)
	assert.InDelta(t, 9.8, stock.PriceChange_1M, 0.001)
	assert.InDelta(t, 8.7, stock.DaysToCover, 0.001)
	assert.InDelta(t, 82.4, stock.SqueezeScore, 0.001)
	assert.InDelta(t, 19.6, stock.DivergenceScore, 0.001)
	assert.InDelta(t, 1.03e10, stock.MarketCap, 1)
}

func TestGetBattlegroundStocks_DivergenceView(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetBattlegroundStocks(shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_DIVERGENCE, int32(10), int32(5)).
		Return([]*shortsstore.BattlegroundStock{
			{StockCode: "SYR", SqueezeScore: 61.0, DivergenceScore: 44.5},
			{StockCode: "LTR", SqueezeScore: 55.3, DivergenceScore: 31.2},
		}, 12, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetBattlegroundStocks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetBattlegroundStocksRequest{
		View:   shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_DIVERGENCE,
		Limit:  10,
		Offset: 5,
	}))

	require.NoError(t, err)
	assert.Equal(t, int32(12), resp.Msg.TotalCount)
	require.Len(t, resp.Msg.Stocks, 2)
	assert.Equal(t, "SYR", resp.Msg.Stocks[0].StockCode)
	assert.InDelta(t, 44.5, resp.Msg.Stocks[0].DivergenceScore, 0.001)
	assert.Equal(t, "LTR", resp.Msg.Stocks[1].StockCode)
	assert.InDelta(t, 31.2, resp.Msg.Stocks[1].DivergenceScore, 0.001)
}

func TestGetBattlegroundStocks_RejectsInvalidLimitAndOffset(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// The store must never be called for invalid requests
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	for _, tc := range []struct {
		name string
		req  *shortsv1alpha1.GetBattlegroundStocksRequest
	}{
		{"limit above max", &shortsv1alpha1.GetBattlegroundStocksRequest{Limit: 101}},
		{"negative limit", &shortsv1alpha1.GetBattlegroundStocksRequest{Limit: -1}},
		{"negative offset", &shortsv1alpha1.GetBattlegroundStocksRequest{Offset: -3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetBattlegroundStocks(context.Background(), connect.NewRequest(tc.req))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestGetBattlegroundStocks_StoreErrorReturnsInternalWithoutLeaking(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetBattlegroundStocks(shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_SQUEEZE, int32(25), int32(0)).
		Return(nil, 0, errors.New("pq: connection refused to host db-internal-1"))

	srv := newTestServer(t, mockStore)
	_, err := srv.GetBattlegroundStocks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetBattlegroundStocksRequest{}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	// The raw DB error must not leak to clients
	assert.NotContains(t, err.Error(), "db-internal-1")
	assert.Contains(t, err.Error(), "failed to get battleground stocks")
}
