package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

func TestPriceFeaturesProto_MapsPresentFieldsAndFlagsAbsentOnes(t *testing.T) {
	c := spReady("RDY") // base 8..9.5 over 30 sessions, breakout 2026-09-24, no SMAs
	c.SMA200 = f64(7.25)
	c.High52w = f64(10.4)

	pf := priceFeaturesProto(&c)
	require.NotNil(t, pf)
	assert.Equal(t, "2026-09-25", pf.AsOf)
	assert.Equal(t, 10.0, pf.Close)
	assert.True(t, pf.HasSma200)
	assert.Equal(t, 7.25, pf.Sma200)
	assert.False(t, pf.HasSma50, "an absent SMA 50 is flagged, never zero-filled")
	assert.Equal(t, 0.0, pf.Sma50)
	assert.False(t, pf.HasSma150)
	assert.False(t, pf.HasSma200PriorMonth)
	assert.True(t, pf.HasHigh52W)
	assert.Equal(t, 10.4, pf.High52W)
	assert.False(t, pf.HasLow52W)
	assert.True(t, pf.HasBaseHigh)
	assert.Equal(t, 9.5, pf.BaseHigh)
	assert.True(t, pf.HasBaseLow)
	assert.Equal(t, 8.0, pf.BaseLow)
	assert.True(t, pf.HasBaseDepthPct)
	assert.Equal(t, 15.8, pf.BaseDepthPct)
	assert.True(t, pf.HasBaseLengthDays)
	assert.Equal(t, int32(30), pf.BaseLengthDays)
	assert.True(t, pf.BreakoutRecent)
	assert.Equal(t, "2026-09-24", pf.BreakoutDate)
	assert.True(t, pf.HasRs3MPct)
	assert.Equal(t, 10.0, pf.Rs3MPct)
	assert.False(t, pf.HasRs6MPct)
	assert.True(t, pf.HasVolumeRatio50D)
	assert.Equal(t, 2.1, pf.VolumeRatio50D)
}

func TestPriceFeaturesProto_NilCandidateAndEmptyDatesAreSafe(t *testing.T) {
	assert.Nil(t, priceFeaturesProto(nil))

	c := strategies.Candidate{StockCode: "NEW", Close: 1.5, SessionsAvailable: 12}
	pf := priceFeaturesProto(&c)
	require.NotNil(t, pf)
	assert.Equal(t, "", pf.AsOf, "a zero AsOf is empty, not 0001-01-01")
	assert.Equal(t, "", pf.BreakoutDate)
	assert.False(t, pf.BreakoutRecent)
	assert.Equal(t, int32(12), pf.SessionsAvailable)
	assert.False(t, pf.HasBaseHigh)
}

func TestPriceFeaturesProto_ReadsEveryFieldFromItsOwnSource(t *testing.T) {
	breakout := spDate("2026-07-01")
	// Every figure is different, so two copied lines that read the wrong
	// source cannot go unnoticed (the fixture above leaves five absent).
	c := strategies.Candidate{
		StockCode:         "ALL",
		AsOf:              spDate("2026-09-25"),
		Close:             12.5,
		SessionsAvailable: 252,
		SMA50:             f64(1.5),
		SMA150:            f64(2.5),
		SMA200:            f64(3.5),
		SMA200_1mAgo:      f64(4.5),
		High52w:           f64(5.5),
		Low52w:            f64(6.5),
		BaseHigh:          f64(7.5),
		BaseLow:           f64(8.5),
		BaseDepthPct:      f64(9.5),
		BaseLengthDays:    spInt32(21),
		BreakoutRecent:    spBool(true),
		BreakoutDate:      &breakout,
		RS3mPct:           f64(10.5),
		RS6mPct:           f64(11.5),
		VolumeRatio50d:    f64(13.5),
	}

	want := &shortsv1alpha1.PriceFeatures{
		AsOf:                "2026-09-25",
		Close:               12.5,
		SessionsAvailable:   252,
		Sma50:               1.5,
		HasSma50:            true,
		Sma150:              2.5,
		HasSma150:           true,
		Sma200:              3.5,
		HasSma200:           true,
		Sma200PriorMonth:    4.5,
		HasSma200PriorMonth: true,
		High52W:             5.5,
		HasHigh52W:          true,
		Low52W:              6.5,
		HasLow52W:           true,
		BaseHigh:            7.5,
		HasBaseHigh:         true,
		BaseLow:             8.5,
		HasBaseLow:          true,
		BaseDepthPct:        9.5,
		HasBaseDepthPct:     true,
		BaseLengthDays:      21,
		HasBaseLengthDays:   true,
		BreakoutRecent:      true,
		BreakoutDate:        "2026-07-01",
		Rs3MPct:             10.5,
		HasRs3MPct:          true,
		Rs6MPct:             11.5,
		HasRs6MPct:          true,
		VolumeRatio50D:      13.5,
		HasVolumeRatio50D:   true,
	}
	got := priceFeaturesProto(&c)
	assert.True(t, proto.Equal(want, got), "want %v\n got %v", want, got)
}

func TestPriceFeaturesProto_AMeasuredZeroIsPresentAndAZeroDateIsEmpty(t *testing.T) {
	var zeroDay time.Time
	c := strategies.Candidate{
		StockCode:      "FLAT",
		Close:          2,
		BaseDepthPct:   f64(0), // a flat base is measured, not missing
		BaseLengthDays: spInt32(0),
		BreakoutRecent: spBool(false),
		BreakoutDate:   &zeroDay,
	}

	pf := priceFeaturesProto(&c)
	require.NotNil(t, pf)
	assert.True(t, pf.HasBaseDepthPct, "a measured 0 is present, never read as unknown")
	assert.Equal(t, 0.0, pf.BaseDepthPct)
	assert.True(t, pf.HasBaseLengthDays)
	assert.Equal(t, int32(0), pf.BaseLengthDays)
	assert.False(t, pf.BreakoutRecent)
	assert.Equal(t, "", pf.BreakoutDate, "a non-nil zero time is empty, not 0001-01-01")
}

func TestGetStockStrategyFit_CarriesPriceFeaturesForUniverseStocks(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "rdy"}))
	require.NoError(t, err)
	require.True(t, resp.Msg.InUniverse)
	require.NotNil(t, resp.Msg.PriceFeatures)
	assert.Equal(t, 9.5, resp.Msg.PriceFeatures.BaseHigh)
	assert.True(t, resp.Msg.PriceFeatures.HasBaseHigh)
	assert.Equal(t, "2026-09-24", resp.Msg.PriceFeatures.BreakoutDate)
}

func TestGetStockStrategyFit_OutsideTheUniverseHasNoPriceFeatures(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "ZZZZ"}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.InUniverse)
	assert.Nil(t, resp.Msg.PriceFeatures)
}
