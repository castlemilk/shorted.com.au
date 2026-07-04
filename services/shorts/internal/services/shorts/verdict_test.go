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

func TestGetStockVerdict_HappyPathComputesCompositeAndComponents(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// Lowercase + surrounding whitespace proves the handler normalizes before the store call
	mockStore.EXPECT().
		GetStockVerdictInputs("BHP").
		Return(&shortsstore.VerdictInputs{
			StockCode:           "BHP",
			ShortPct:            7.5,    // short_level = -0.5
			ShortPctChange4w:    -1.5,   // short_trend = +0.5 (shorts covering = bullish)
			NetDirectorBuyValue: 500000, // director_signal = +0.5
			AvgSentiment:        0.4,    // sentiment = +0.4
			DaysToCover:         4,      // squeeze_pressure = 0.4 * 0.5 = +0.2
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetStockVerdict(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockVerdictRequest{
		ProductCode: " bhp ",
	}))

	require.NoError(t, err)
	assert.Equal(t, "BHP", resp.Msg.ProductCode)
	// 0.30*0.5 + 0.15*(-0.5) + 0.25*0.5 + 0.20*0.4 + 0.10*0.2 = 0.30 → composite 30.0
	assert.InDelta(t, 30.0, resp.Msg.Composite, 0.001)
	assert.Equal(t, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BULLISH, resp.Msg.Label)

	require.Len(t, resp.Msg.Components, 5)
	byName := map[string]*shortsv1alpha1.VerdictComponent{}
	for _, c := range resp.Msg.Components {
		byName[c.Name] = c
	}

	shortTrend := byName["short_trend"]
	require.NotNil(t, shortTrend)
	assert.InDelta(t, 0.5, shortTrend.Score, 0.001)
	assert.InDelta(t, 0.30, shortTrend.Weight, 0.001)
	assert.InDelta(t, 15.0, shortTrend.Contribution, 0.001)

	shortLevel := byName["short_level"]
	require.NotNil(t, shortLevel)
	assert.InDelta(t, -0.5, shortLevel.Score, 0.001)
	assert.InDelta(t, 0.15, shortLevel.Weight, 0.001)
	assert.InDelta(t, -7.5, shortLevel.Contribution, 0.001)

	director := byName["director_signal"]
	require.NotNil(t, director)
	assert.InDelta(t, 0.5, director.Score, 0.001)
	assert.InDelta(t, 0.25, director.Weight, 0.001)
	assert.InDelta(t, 12.5, director.Contribution, 0.001)

	sentiment := byName["sentiment"]
	require.NotNil(t, sentiment)
	assert.InDelta(t, 0.4, sentiment.Score, 0.001)
	assert.InDelta(t, 0.20, sentiment.Weight, 0.001)
	assert.InDelta(t, 8.0, sentiment.Contribution, 0.001)

	squeeze := byName["squeeze_pressure"]
	require.NotNil(t, squeeze)
	assert.InDelta(t, 0.2, squeeze.Score, 0.001)
	assert.InDelta(t, 0.10, squeeze.Weight, 0.001)
	assert.InDelta(t, 2.0, squeeze.Contribution, 0.001)
}

func TestGetStockVerdict_ExtremeInputsAreClamped(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetStockVerdictInputs("XYZ").
		Return(&shortsstore.VerdictInputs{
			StockCode:           "XYZ",
			ShortPct:            50,        // short_level clamps to -1
			ShortPctChange4w:    9,         // short_trend clamps to -1
			NetDirectorBuyValue: -25000000, // director_signal clamps to -1
			AvgSentiment:        -2,        // sentiment clamps to -1
			DaysToCover:         100,       // squeeze_pressure caps at +0.5
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetStockVerdict(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockVerdictRequest{
		ProductCode: "XYZ",
	}))

	require.NoError(t, err)
	// -0.30 - 0.15 - 0.25 - 0.20 + 0.10*0.5 = -0.85 → -85.0
	assert.InDelta(t, -85.0, resp.Msg.Composite, 0.001)
	assert.Equal(t, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BEARISH, resp.Msg.Label)
}

func TestVerdictLabelFor_BandBoundaries(t *testing.T) {
	for _, tc := range []struct {
		composite float64
		want      shortsv1alpha1.VerdictLabel
	}{
		{-100, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BEARISH},
		{-40.1, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BEARISH},
		{-40, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BEARISH}, // boundary: -40 is strong bearish
		{-39.9, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BEARISH},
		{-10, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BEARISH}, // boundary: -10 is bearish
		{-9.9, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_NEUTRAL},
		{0, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_NEUTRAL},
		{9.9, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_NEUTRAL},
		{10, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BULLISH}, // boundary: 10 is bullish
		{39.9, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_BULLISH},
		{40, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BULLISH}, // boundary: 40 is strong bullish
		{100, shortsv1alpha1.VerdictLabel_VERDICT_LABEL_STRONG_BULLISH},
	} {
		assert.Equal(t, tc.want, verdictLabelFor(tc.composite), "composite=%v", tc.composite)
	}
}

func TestGetStockVerdict_RejectsInvalidProductCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// The store must never be called for invalid requests
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	for _, tc := range []struct {
		name string
		code string
	}{
		{"empty", ""},
		{"whitespace only", "   "},
		{"too long", "ABCDEFGHIJK"},
		{"non-alphanumeric", "BHP;DROP"},
		{"sql-ish", "BHP'--"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetStockVerdict(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockVerdictRequest{
				ProductCode: tc.code,
			}))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestGetStockVerdict_UnknownStockReturnsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetStockVerdictInputs("ZZZ").
		Return(nil, shortsstore.ErrVerdictStockNotFound)

	srv := newTestServer(t, mockStore)
	_, err := srv.GetStockVerdict(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockVerdictRequest{
		ProductCode: "ZZZ",
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestGetStockVerdict_StoreErrorReturnsInternalWithoutLeaking(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetStockVerdictInputs("BHP").
		Return(nil, errors.New("pq: connection refused to host db-internal-1"))

	srv := newTestServer(t, mockStore)
	_, err := srv.GetStockVerdict(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockVerdictRequest{
		ProductCode: "BHP",
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	// The raw DB error must not leak to clients
	assert.NotContains(t, err.Error(), "db-internal-1")
	assert.Contains(t, err.Error(), "failed to get stock verdict")
}
