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
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

// StrategyService is mounted from serve.go; this makes a missing handler a
// compile error next to the handlers rather than at the mount.
var _ shortsv1alpha1connect.StrategyServiceHandler = (*ShortsServer)(nil)

func spBool(v bool) *bool    { return &v }
func spInt32(v int32) *int32 { return &v }
func spDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func spUptrend() strategies.Regime {
	asOf := spDate("2026-09-25")
	return strategies.Regime{IndexCode: "XJO", AsOf: &asOf, Close: f64(8800), SMA50: f64(8600), SMA200: f64(8200), PctOff52wHigh: f64(-1.5), Label: strategies.RegimeUptrend}
}

// spReady passes every Zanger rule.
func spReady(code string) strategies.Candidate {
	breakout := spDate("2026-09-24")
	return strategies.Candidate{
		StockCode:       code,
		AsOf:            spDate("2026-09-25"),
		Close:           10,
		PctOff52wHigh:   f64(-0.5),
		VolumeRatio50d:  f64(2.1),
		BaseHigh:        f64(9.5),
		BaseLow:         f64(8),
		BaseDepthPct:    f64(15.8),
		BaseLengthDays:  spInt32(30),
		BreakoutRecent:  spBool(true),
		BreakoutDate:    &breakout,
		DollarVolume20d: f64(5_000_000),
		RS3mPct:         f64(10),
		Growth:          &strategies.Growth{RevenueYoYPct: f64(40), EPSYoYPct: f64(50), BasisPeriodType: "ttm"},
		CompanyName:     code + " Ltd",
		Industry:        "Materials",
		LogoURL:         "https://example.test/" + code + ".png",
		ShortPct:        f64(6.5),
		MarketCap:       f64(1.2e9),
	}
}

func spUniverse() []strategies.Candidate {
	setup := spReady("SET")
	setup.BreakoutRecent = spBool(false)
	setup.AsOf = spDate("2026-09-24")

	watch := spReady("WAT")
	watch.Growth = nil // growth unknown: cannot trigger or set up
	watch.ShortPct = nil
	watch.MarketCap = nil

	nothing := strategies.Candidate{StockCode: "NIL", AsOf: spDate("2026-09-25"), Close: 1}
	return []strategies.Candidate{nothing, watch, setup, spReady("RDY")}
}

func TestListStrategies_ReturnsTheRegistryAndANeutralRegime(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)

	srv := newTestServer(t, mockStore)
	for i := 0; i < 2; i++ { // the second call is served from cache
		resp, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
		require.NoError(t, err)

		require.Len(t, resp.Msg.Strategies, 4)
		for j, st := range strategies.Registry() {
			got := resp.Msg.Strategies[j]
			assert.Equal(t, st.ID, got.Id)
			assert.Equal(t, st.Name, got.Name)
			assert.Equal(t, st.Author, got.Author)
			assert.Equal(t, st.Description, got.DescriptionParagraphs)
			assert.Equal(t, st.Sources, got.Sources)
			require.Len(t, got.Rules, len(st.Rules))
			assert.Equal(t, int32(len(st.Rules)), got.Metadata.RuleCount)
			for k, r := range st.Rules {
				assert.Equal(t, r.ID, got.Rules[k].Id)
				assert.Equal(t, r.Core, got.Rules[k].Core)
				assert.Equal(t, r.Evaluation, got.Rules[k].Evaluation)
				assert.Equal(t, r.DataSource, got.Rules[k].DataSource)
			}
			if st.UsesFundamentals() {
				assert.Equal(t, strategies.CoverageCaveat(0, -1), got.Caveats[0], "unmeasured coverage caveat first")
			}
		}

		reg := resp.Msg.Regime
		assert.Equal(t, "XJO", reg.IndexCode)
		assert.Equal(t, "uptrend", reg.Regime)
		assert.Equal(t, "2026-09-25", reg.AsOf)
		assert.InDelta(t, 8800, reg.Close, 1e-9)
		assert.InDelta(t, 8600, reg.Sma50, 1e-9)
		assert.InDelta(t, 8200, reg.Sma200, 1e-9)
		assert.InDelta(t, -1.5, reg.PctOff_52WHigh, 1e-9)
		assert.True(t, strings.HasPrefix(reg.Verdict, "Uptrend: XJO"), reg.Verdict)
	}
}

func TestListStrategies_RegimeFailureDegradesToUnknown(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(strategies.Regime{}, errors.New("timeout"))

	resp, err := newTestServer(t, mockStore).ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err, "the definitions are static; a regime failure must not fail the call")
	assert.Len(t, resp.Msg.Strategies, 4)
	assert.Equal(t, "XJO", resp.Msg.Regime.IndexCode)
	assert.Equal(t, "", resp.Msg.Regime.Regime)
	assert.True(t, strings.HasPrefix(resp.Msg.Regime.Verdict, "Market regime unavailable"), resp.Msg.Regime.Verdict)
}

func TestGetStrategyPicks_RejectsBadRequestsWithoutTouchingTheStore(t *testing.T) {
	ctrl := gomock.NewController(t)
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl)) // strict: any store call fails

	cases := []struct {
		name  string
		req   *shortsv1alpha1.GetStrategyPicksRequest
		code  connect.Code
		field string
	}{
		{"missing id", &shortsv1alpha1.GetStrategyPicksRequest{}, connect.CodeInvalidArgument, "strategy_id"},
		{"blank id", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "   "}, connect.CodeInvalidArgument, "strategy_id"},
		{"unknown id", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "buffett-moat"}, connect.CodeNotFound, "strategy_id"},
		{"bad status", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim", Status: "hot"}, connect.CodeInvalidArgument, "status"},
		{"limit over max", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim", Limit: 101}, connect.CodeInvalidArgument, "limit"},
		{"negative limit", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim", Limit: -1}, connect.CodeInvalidArgument, "limit"},
		{"negative offset", &shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim", Offset: -1}, connect.CodeInvalidArgument, "offset"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(tc.req))
			require.Error(t, err)
			assert.Equal(t, tc.code, connect.CodeOf(err))
			assert.Contains(t, err.Error(), tc.field)
		})
	}
	// The NotFound message lists the valid ids, so a caller can recover.
	_, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "nope"}))
	for _, st := range strategies.Registry() {
		assert.Contains(t, err.Error(), st.ID)
	}
}

func TestGetStrategyPicks_RanksEvaluatesAndMapsEveryField(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
		StrategyId: " Zanger-Breakout ", // normalised
	}))
	require.NoError(t, err)
	msg := resp.Msg

	assert.Equal(t, "zanger-breakout", msg.Strategy.Id)
	assert.Equal(t, int32(4), msg.UniverseCount)
	assert.Equal(t, int32(2), msg.FundamentalsCoverageCount, "RDY and SET carry growth data; WAT and NIL do not")
	assert.Equal(t, "2026-09-25", msg.AsOf)
	assert.Equal(t, int32(3), msg.TotalCount, "the stock passing no stock-specific rule is not a pick")
	assert.Equal(t, strategies.CoverageCaveat(2, 4), msg.Strategy.Caveats[0])
	assert.True(t, strings.HasPrefix(msg.Regime.Verdict, "Green light: XJO"), msg.Regime.Verdict)

	require.Len(t, msg.Picks, 3)
	wantOrder := []struct{ code, status string }{{"RDY", "triggered"}, {"SET", "setup"}, {"WAT", "watch"}}
	for i, w := range wantOrder {
		assert.Equal(t, w.code, msg.Picks[i].StockCode)
		assert.Equal(t, w.status, msg.Picks[i].Status)
		assert.Equal(t, int32(i+1), msg.Picks[i].Rank)
	}

	rdy := msg.Picks[0]
	assert.Equal(t, "RDY Ltd", rdy.CompanyName)
	assert.Equal(t, "Materials", rdy.Industry)
	assert.Equal(t, "https://example.test/RDY.png", rdy.LogoUrl)
	assert.Equal(t, "2026-09-25", rdy.AsOf)
	assert.InDelta(t, 10, rdy.Close, 1e-9)
	assert.InDelta(t, -0.5, rdy.PctOff_52WHigh, 1e-9)
	assert.InDelta(t, 2.1, rdy.VolumeRatio_50D, 1e-9)
	assert.InDelta(t, 15.8, rdy.BaseDepthPct, 1e-9)
	assert.Equal(t, int32(30), rdy.BaseLengthDays)
	assert.InDelta(t, 9.5, rdy.Pivot, 1e-9)
	assert.True(t, rdy.HasRevenueYoy)
	assert.InDelta(t, 40, rdy.RevenueYoyPct, 1e-9)
	assert.True(t, rdy.HasEpsYoy)
	assert.InDelta(t, 50, rdy.EpsYoyPct, 1e-9)
	assert.InDelta(t, 10, rdy.Rs_3MPct, 1e-9)
	assert.InDelta(t, 6.5, rdy.ShortPct, 1e-9)
	assert.InDelta(t, 1.2e9, rdy.MarketCap, 1)
	assert.Greater(t, rdy.Score, 60.0)
	assert.LessOrEqual(t, rdy.Score, 100.0)

	zanger, _ := strategies.Lookup(strategies.IDZangerBreakout)
	require.Len(t, rdy.Rules, len(zanger.Rules))
	for i, r := range rdy.Rules {
		assert.Equal(t, zanger.Rules[i].ID, r.RuleId)
		assert.Equal(t, "pass", r.Status)
		assert.NotEmpty(t, r.Detail)
	}

	wat := msg.Picks[2]
	assert.False(t, wat.HasRevenueYoy, "no growth row: has_revenue_yoy must be false, not a zero growth")
	assert.False(t, wat.HasEpsYoy)
	assert.Equal(t, float64(0), wat.ShortPct)
	assert.Equal(t, float64(0), wat.MarketCap)
	for _, r := range wat.Rules {
		if r.RuleId == strategies.RuleGrowth {
			assert.Equal(t, "unknown", r.Status)
			assert.False(t, r.HasValue)
		}
	}
}

func TestGetStrategyPicks_FiltersByStatusAndPagesInMemory(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	// One universe read and one regime read, however many pages are asked for.
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	get := func(req *shortsv1alpha1.GetStrategyPicksRequest) *shortsv1alpha1.GetStrategyPicksResponse {
		t.Helper()
		req.StrategyId = "zanger-breakout"
		resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(req))
		require.NoError(t, err)
		return resp.Msg
	}

	page := get(&shortsv1alpha1.GetStrategyPicksRequest{Limit: 1, Offset: 1})
	require.Len(t, page.Picks, 1)
	assert.Equal(t, "SET", page.Picks[0].StockCode)
	assert.Equal(t, int32(2), page.Picks[0].Rank, "rank is across the full list")
	assert.Equal(t, int32(3), page.TotalCount)

	setups := get(&shortsv1alpha1.GetStrategyPicksRequest{Status: "SETUP"})
	require.Len(t, setups.Picks, 1)
	assert.Equal(t, "SET", setups.Picks[0].StockCode)
	assert.Equal(t, int32(1), setups.TotalCount, "total_count counts the filtered list")
	assert.Equal(t, int32(4), setups.UniverseCount)

	beyond := get(&shortsv1alpha1.GetStrategyPicksRequest{Offset: 50})
	assert.Empty(t, beyond.Picks)
	assert.NotNil(t, beyond.Picks)
	assert.Equal(t, int32(3), beyond.TotalCount)

	all := get(&shortsv1alpha1.GetStrategyPicksRequest{})
	assert.Len(t, all.Picks, 3, "limit 0 means the default of 20")
}

func TestGetStrategyPicks_DefaultLimitIsTwenty(t *testing.T) {
	var cands []strategies.Candidate
	for _, code := range []string{"A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10",
		"A11", "A12", "A13", "A14", "A15", "A16", "A17", "A18", "A19", "A20", "A21", "A22", "A23", "A24", "A25"} {
		cands = append(cands, spReady(code))
	}
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(cands, nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.NoError(t, err)
	assert.Len(t, resp.Msg.Picks, 20)
	assert.Equal(t, int32(25), resp.Msg.TotalCount)

	resp, err = srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout", Limit: 100}))
	require.NoError(t, err)
	assert.Len(t, resp.Msg.Picks, 25)
}

func TestGetStrategyPicks_StrategiesShareOneUniverseRead(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	for _, st := range strategies.Registry() {
		resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: st.ID}))
		require.NoError(t, err, st.ID)
		assert.Equal(t, st.ID, resp.Msg.Strategy.Id)
		assert.Equal(t, int32(4), resp.Msg.UniverseCount)
	}
	// And ListStrategies reuses the cached regime.
	_, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
}

// Dev databases lack the MVs: the store answers empty, and the API must serve
// an empty universe, never a 500.
func TestGetStrategyPicks_MissingViewsServeAnEmptyUniverse(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return([]strategies.Candidate{}, nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(strategies.Regime{IndexCode: "XJO"}, nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim"}))
	require.NoError(t, err)
	msg := resp.Msg
	assert.Equal(t, int32(0), msg.UniverseCount)
	assert.Equal(t, int32(0), msg.TotalCount)
	assert.Equal(t, int32(0), msg.FundamentalsCoverageCount)
	assert.Empty(t, msg.Picks)
	assert.Equal(t, "", msg.AsOf)
	assert.Equal(t, "", msg.Regime.Regime)
	assert.Equal(t, "XJO", msg.Regime.IndexCode)
	assert.True(t, strings.HasPrefix(msg.Regime.Verdict, "Market regime unavailable"), msg.Regime.Verdict)
	assert.Equal(t, strategies.CoverageCaveat(0, 0), msg.Strategy.Caveats[0])
	assert.NotContains(t, msg.Strategy.Caveats[0], "0 of the 0")
}

func TestGetStrategyPicks_DowntrendVerdictAndNoTriggers(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(strategies.Regime{IndexCode: "XJO", Label: strategies.RegimeDowntrend}, nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(resp.Msg.Regime.Verdict, "Stand aside: XJO"), resp.Msg.Regime.Verdict)
	assert.Equal(t, "downtrend", resp.Msg.Regime.Regime)
	require.NotEmpty(t, resp.Msg.Picks, "a downtrend demotes, it does not hide")
	for _, p := range resp.Msg.Picks {
		assert.Equal(t, "watch", p.Status, p.StockCode)
	}
}

func TestGetStrategyPicks_StoreErrorsAreInternalAndNotCached(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	gomock.InOrder(
		mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(nil, errors.New("connection reset")),
		mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil),
	)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	_, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	assert.NotContains(t, err.Error(), "connection reset", "database detail must not leak to callers")

	resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim"}))
	require.NoError(t, err, "a failed fill must not be cached")
	assert.Equal(t, int32(4), resp.Msg.UniverseCount)
}

func TestGetStrategyPicks_RegimeErrorFailsTheFill(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(strategies.Regime{}, errors.New("timeout"))

	_, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}

// A fill triggered by a request that is then cancelled must still complete
// for the callers sharing it.
func TestGetStrategyPicks_FillIgnoresTheTriggeringRequestsCancellation(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).DoAndReturn(func(ctx context.Context) ([]strategies.Candidate, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return spUniverse(), nil
	})
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").DoAndReturn(func(ctx context.Context, _ string) (strategies.Regime, error) {
		if ctx.Err() != nil {
			return strategies.Regime{}, ctx.Err()
		}
		return spUptrend(), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	resp, err := newTestServer(t, mockStore).GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.NoError(t, err)
	assert.Equal(t, int32(4), resp.Msg.UniverseCount)
}

func TestMemoryCacheGetOrSetWithTTL(t *testing.T) {
	c := NewMemoryCache(time.Millisecond)
	defer c.Close()

	calls := 0
	fill := func() (interface{}, error) { calls++; return calls, nil }

	v, err := c.GetOrSetWithTTL("long", time.Hour, fill)
	require.NoError(t, err)
	assert.Equal(t, 1, v)
	time.Sleep(5 * time.Millisecond)
	v, _ = c.GetOrSetWithTTL("long", time.Hour, fill)
	assert.Equal(t, 1, v, "a per-entry TTL outlives the cache-wide max age")

	_, _ = c.GetOrSetWithTTL("short", time.Millisecond, fill)
	time.Sleep(5 * time.Millisecond)
	v, _ = c.GetOrSetWithTTL("short", time.Millisecond, fill)
	assert.Equal(t, 3, v, "an expired per-entry TTL refills")

	_, err = c.GetOrSetWithTTL("err", time.Hour, func() (interface{}, error) { return nil, errors.New("boom") })
	require.Error(t, err)
	_, found := c.Get("err")
	assert.False(t, found, "errors are never cached")

	v, _ = c.GetOrSetWithTTL("zero", 0, fill) // non-positive falls back to max age
	assert.Equal(t, 4, v)
}

func TestStrategyServiceIsMounted(t *testing.T) {
	src := readRepoFile(t, "serve.go")
	assert.Contains(t, src, "mount(shortsv1alpha1connect.NewStrategyServiceHandler(s, interceptors))",
		"StrategyService must be mounted through mount() so it carries the shared interceptors and CORS")
}
