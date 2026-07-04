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

func TestGetShortCampaignScoreboard_HappyPathRoundTrips(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// limit 0 must default to 25
	mockStore.EXPECT().
		GetShortCampaignScoreboard("", int32(25), int32(0)).
		Return([]*shortsstore.ShortCampaign{
			{
				StockCode:       "PLS",
				CompanyName:     "Pilbara Minerals Limited",
				Industry:        "Materials",
				LogoURL:         "https://example.com/pls.png",
				PeakDate:        "2024-11-15",
				PeakShortPct:    21.3,
				PriceAtPeak:     2.85,
				Price3mAfter:    2.31,
				Price6mAfter:    3.10,
				Return3m:        -18.95,
				Return6m:        8.77,
				Has3m:           true,
				Has6m:           true,
				ShortsWon3m:     true,
				ShortsWon6m:     false,
				CurrentShortPct: 14.2,
				LatestPrice:     3.42,
			},
			{
				StockCode:    "RECENT",
				PeakDate:     "2026-06-01",
				PeakShortPct: 9.1,
				PriceAtPeak:  1.10,
				// Peak too recent — no 3m/6m outcome yet
				Has3m: false,
				Has6m: false,
			},
		}, 42, &shortsstore.ScoreboardStats{
			CampaignsTotal:  42,
			ShortsWinRate3m: 57.5,
			ShortsWinRate6m: 48.6,
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetShortCampaignScoreboard(context.Background(), connect.NewRequest(&shortsv1alpha1.GetShortCampaignScoreboardRequest{}))

	require.NoError(t, err)
	assert.Equal(t, int32(42), resp.Msg.TotalCount)
	assert.Equal(t, int32(42), resp.Msg.CampaignsTotal)
	assert.InDelta(t, 57.5, resp.Msg.ShortsWinRate_3M, 0.001)
	assert.InDelta(t, 48.6, resp.Msg.ShortsWinRate_6M, 0.001)

	require.Len(t, resp.Msg.Campaigns, 2)
	c := resp.Msg.Campaigns[0]
	assert.Equal(t, "PLS", c.StockCode)
	assert.Equal(t, "Pilbara Minerals Limited", c.CompanyName)
	assert.Equal(t, "Materials", c.Industry)
	assert.Equal(t, "https://example.com/pls.png", c.LogoUrl)
	assert.Equal(t, "2024-11-15", c.PeakDate)
	assert.InDelta(t, 21.3, c.PeakShortPct, 0.001)
	assert.InDelta(t, 2.85, c.PriceAtPeak, 0.001)
	assert.InDelta(t, 2.31, c.Price_3MAfter, 0.001)
	assert.InDelta(t, 3.10, c.Price_6MAfter, 0.001)
	assert.InDelta(t, -18.95, c.Return_3M, 0.001)
	assert.InDelta(t, 8.77, c.Return_6M, 0.001)
	assert.True(t, c.Has_3M)
	assert.True(t, c.Has_6M)
	assert.True(t, c.ShortsWon_3M)
	assert.False(t, c.ShortsWon_6M)
	assert.InDelta(t, 14.2, c.CurrentShortPct, 0.001)
	assert.InDelta(t, 3.42, c.LatestPrice, 0.001)

	recent := resp.Msg.Campaigns[1]
	assert.Equal(t, "RECENT", recent.StockCode)
	assert.False(t, recent.Has_3M)
	assert.False(t, recent.Has_6M)
}

func TestGetShortCampaignScoreboard_IndustryFilterAndPagingPassThrough(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetShortCampaignScoreboard("Materials", int32(10), int32(20)).
		Return(nil, 0, &shortsstore.ScoreboardStats{}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetShortCampaignScoreboard(context.Background(), connect.NewRequest(&shortsv1alpha1.GetShortCampaignScoreboardRequest{
		Industry: "Materials",
		Limit:    10,
		Offset:   20,
	}))

	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Campaigns)
	assert.Equal(t, int32(0), resp.Msg.TotalCount)
	assert.Equal(t, int32(0), resp.Msg.CampaignsTotal)
	assert.InDelta(t, 0.0, resp.Msg.ShortsWinRate_3M, 0.001)
	assert.InDelta(t, 0.0, resp.Msg.ShortsWinRate_6M, 0.001)
}

func TestGetShortCampaignScoreboard_RejectsInvalidLimitAndOffset(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// The store must never be called for invalid requests
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	for _, tc := range []struct {
		name string
		req  *shortsv1alpha1.GetShortCampaignScoreboardRequest
	}{
		{"limit above max", &shortsv1alpha1.GetShortCampaignScoreboardRequest{Limit: 101}},
		{"negative limit", &shortsv1alpha1.GetShortCampaignScoreboardRequest{Limit: -1}},
		{"negative offset", &shortsv1alpha1.GetShortCampaignScoreboardRequest{Offset: -3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetShortCampaignScoreboard(context.Background(), connect.NewRequest(tc.req))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestGetShortCampaignScoreboard_StoreErrorReturnsInternalWithoutLeaking(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetShortCampaignScoreboard("", int32(25), int32(0)).
		Return(nil, 0, nil, errors.New("pq: connection refused to host db-internal-1"))

	srv := newTestServer(t, mockStore)
	_, err := srv.GetShortCampaignScoreboard(context.Background(), connect.NewRequest(&shortsv1alpha1.GetShortCampaignScoreboardRequest{}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	// The raw DB error must not leak to clients
	assert.NotContains(t, err.Error(), "db-internal-1")
	assert.Contains(t, err.Error(), "failed to get short campaign scoreboard")
}
