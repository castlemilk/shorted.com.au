package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

// Fundamentals coverage on the picker (docs/plans/fundamentals-coverage.md
// §5.2-§5.4): quality compounders, PickFundamentals, sort_by,
// require_fundamentals, fundamentals_rows_count and GetStockStrategyFit.

// spQuality passes every quality compounders rule, with the 000132 extras the
// store merges: a quality row, growth provenance and valuation inputs.
func spQuality(code string, revenueYoY float64) strategies.Candidate {
	c := spReady(code)
	c.Close = 50
	c.SMA200 = f64(45)
	c.MarketCap = f64(3e9) // the screener's figure
	c.Growth = &strategies.Growth{
		RevenueYoYPct: f64(revenueYoY), EPSYoYPct: f64(12), BasisPeriodType: "ttm", RevenueBasisPeriodType: "ttm",
		LatestPeriodEnd: dayPtr("2026-06-30"), LatestAnnualPeriodEnd: dayPtr("2026-06-30"),
		RevenueLatestPeriodEnd: dayPtr("2026-06-30"), RevenueBasisSource: "vendor", EPSBasisSource: "filing",
		NetIncomePositive: spBool(true), Currency: "AUD", FetchedAt: dayPtr("2026-09-01"),
	}
	c.Quality = &strategies.Quality{
		BasisPeriodType: "annual", BasisPeriodEnd: dayPtr("2026-06-30"), Currency: "AUD", BalanceCurrency: "AUD",
		FetchedAt: dayPtr("2026-09-02"),
		Revenue:   f64(1e9), NetIncome: f64(2e8), FreeCashFlow: f64(1.9e8), EBITDA: f64(3.5e8),
		TotalEquity: f64(1e9), TotalAssets: f64(2e9), TotalDebt: f64(4e8), NetDebt: f64(3e8),
		NetMarginPct: f64(20), ROEPct: f64(21), FCFMarginPct: f64(19), FCFConversion: f64(0.95), NetDebtToEBITDA: f64(0.857),
	}
	c.ValuationInputs = &strategies.ValuationInputs{
		Shares: f64(1e8), SharesPeriodEnd: dayPtr("2026-06-30"), MedianK: f64(1),
		EPSDiluted: f64(2), EPSPeriodEnd: dayPtr("2026-06-30"), EPSCurrency: "AUD",
	}
	return c
}

func dayPtr(s string) *time.Time {
	t := spDate(s)
	return &t
}

// qualityUniverse is spUniverse (RDY, SET, WAT, NIL) plus two quality
// compounders and a bank with the same numbers.
func qualityUniverse() []strategies.Candidate {
	bank := spQuality("CBA", 5)
	bank.Industry = "Banks"
	return append(spUniverse(), spQuality("QAA", 4), spQuality("QBB", 30), bank)
}

func pickCodes(msg *shortsv1alpha1.GetStrategyPicksResponse) []string {
	var out []string
	for _, p := range msg.Picks {
		out = append(out, p.StockCode)
	}
	return out
}

func TestGetStrategyPicks_RejectsAnUnknownSortWithoutTouchingTheStore(t *testing.T) {
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	for _, sortBy := range []string{"rank", "pe_ratio", "revenue"} {
		_, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "canslim", SortBy: sortBy}))
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		assert.Contains(t, err.Error(), "sort_by")
		assert.Contains(t, err.Error(), "market_cap", "the error lists the valid orders")
	}
}

func TestGetStrategyPicks_QualityCompoundersMapsPickFundamentals(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(qualityUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
		StrategyId: strategies.IDQualityCompounders, Limit: 100,
	}))
	require.NoError(t, err)
	msg := resp.Msg
	assert.Equal(t, int32(7), msg.UniverseCount)
	assert.Equal(t, int32(5), msg.FundamentalsRowsCount, "RDY, SET, QAA, QBB and CBA hold a fundamentals row; WAT and NIL do not")
	assert.Equal(t, int32(5), msg.FundamentalsCoverageCount)
	assert.Equal(t, strategies.QualityCoverageCaveat(3, 7), msg.Strategy.Caveats[0], "the quality strategy quotes statement coverage")

	byCode := map[string]*shortsv1alpha1.StrategyPick{}
	for _, p := range msg.Picks {
		byCode[p.StockCode] = p
	}
	qbb := byCode["QBB"]
	require.NotNil(t, qbb)
	assert.Equal(t, "triggered", qbb.Status)
	f := qbb.Fundamentals
	require.NotNil(t, f)
	assert.Equal(t, "ttm", f.RevenueBasisPeriodType)
	assert.Equal(t, "2026-06-30", f.RevenuePeriodEnd)
	assert.Equal(t, "ttm", f.EpsBasisPeriodType)
	assert.Equal(t, "2026-06-30", f.EpsPeriodEnd)
	assert.Equal(t, "vendor", f.RevenueBasisSource)
	assert.Equal(t, "filing", f.EpsBasisSource)
	assert.Equal(t, "AUD", f.Currency)
	assert.Equal(t, "2026-09-02T00:00:00Z", f.FetchedAt, "the newest fetch of the inputs")
	assert.True(t, f.HasRoePct)
	assert.InDelta(t, 21, f.RoePct, 1e-9)
	assert.True(t, f.HasNetMarginPct)
	assert.True(t, f.HasFcfMarginPct)
	assert.True(t, f.HasNetDebtToEbitda)
	assert.True(t, f.HasPeRatio)
	assert.InDelta(t, 25, f.PeRatio, 1e-9, "close 50 / EPS 2")
	assert.True(t, f.NetIncomePositive)
	assert.False(t, f.IsFinancial)
	assert.Empty(t, f.NotMeaningful)
	assert.True(t, qbb.HasMarketCap)
	assert.InDelta(t, 5e9, qbb.MarketCap, 1, "the resolved market cap: close 50 x 100m shares, not the screener's 3bn")

	cba := byCode["CBA"]
	require.NotNil(t, cba)
	assert.Equal(t, "watch", cba.Status, "a financial ranks watch at most")
	require.NotNil(t, cba.Fundamentals)
	assert.True(t, cba.Fundamentals.IsFinancial)
	assert.Equal(t, strategies.NotMeaningfulForFinancials(), cba.Fundamentals.NotMeaningful)
	assert.False(t, cba.Fundamentals.HasFcfMarginPct, "not meaningful for a bank: withheld")
	assert.False(t, cba.Fundamentals.HasNetDebtToEbitda)
	assert.True(t, cba.Fundamentals.HasRoePct, "a bank's ROE is meaningful")

	if wat := byCode["WAT"]; wat != nil {
		assert.Nil(t, wat.Fundamentals, "no fundamentals row: absent, not empty")
	}
}

func TestGetStrategyPicks_SortsACopyKeepsRankAndRequiresFundamentals(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(qualityUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)
	get := func(req *shortsv1alpha1.GetStrategyPicksRequest) *shortsv1alpha1.GetStrategyPicksResponse {
		t.Helper()
		req.StrategyId = strategies.IDZangerBreakout
		req.Limit = 100
		resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(req))
		require.NoError(t, err)
		return resp.Msg
	}

	byRank := get(&shortsv1alpha1.GetStrategyPicksRequest{})
	rankOf := map[string]int32{}
	for i, p := range byRank.Picks {
		assert.Equal(t, int32(i+1), p.Rank, "the default order is rank order")
		rankOf[p.StockCode] = p.Rank
	}

	byRevenue := get(&shortsv1alpha1.GetStrategyPicksRequest{SortBy: " Revenue_YoY "})
	require.Len(t, byRevenue.Picks, len(byRank.Picks))
	assert.Equal(t, []string{"RDY", "SET", "QBB", "CBA", "QAA", "WAT"}, pickCodes(byRevenue),
		"revenue 40, 40, 30, 5, 4, then the stock with no growth row")
	for _, p := range byRevenue.Picks {
		assert.Equal(t, rankOf[p.StockCode], p.Rank, "sorting never changes rank")
	}

	byPE := get(&shortsv1alpha1.GetStrategyPicksRequest{SortBy: "pe"})
	peCodes := pickCodes(byPE)
	require.GreaterOrEqual(t, len(peCodes), 3)
	assert.ElementsMatch(t, []string{"QAA", "QBB", "CBA"}, peCodes[:3], "the three with a P/E first, unknowns after")

	again := get(&shortsv1alpha1.GetStrategyPicksRequest{})
	assert.Equal(t, pickCodes(byRank), pickCodes(again), "a sorted call must not reorder the cached list")

	withRows := get(&shortsv1alpha1.GetStrategyPicksRequest{RequireFundamentals: true})
	assert.NotContains(t, pickCodes(withRows), "WAT")
	assert.Equal(t, int32(len(withRows.Picks)), withRows.TotalCount, "total_count counts the filtered list")
	assert.Less(t, withRows.TotalCount, byRank.TotalCount)

	watchWithRows := get(&shortsv1alpha1.GetStrategyPicksRequest{RequireFundamentals: true, Status: "watch", SortBy: "roe"})
	for _, p := range watchWithRows.Picks {
		assert.Equal(t, "watch", p.Status)
		assert.NotNil(t, p.Fundamentals)
	}
}

// Plan §5.2: sorting copies the status-filtered slice and never mutates the
// cache. Run under -race: concurrent sorted and default calls share one
// cached pick list.
func TestGetStrategyPicks_ConcurrentSortedAndDefaultCallsShareTheCacheSafely(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(qualityUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	first, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout", Limit: 100}))
	require.NoError(t, err)
	want := strings.Join(pickCodes(first.Msg), ",")

	sorts := []string{"", "revenue_yoy", "eps_yoy", "roe", "net_margin", "fcf_margin", "pe", "market_cap", "score"}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sortBy := sorts[i%len(sorts)]
			status := []string{"", "watch"}[i%2]
			resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
				StrategyId: "zanger-breakout", Limit: 100, SortBy: sortBy, Status: status,
			}))
			if err != nil {
				errs <- err
				return
			}
			if (sortBy == "" || sortBy == "score") && status == "" {
				if got := strings.Join(pickCodes(resp.Msg), ","); got != want {
					errs <- fmt.Errorf("default order changed under concurrent sorts: %s", got)
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// ---------------------------------------------------------------- GetStockStrategyFit

func TestGetStockStrategyFit_MatchesEveryStrategysRankedList(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(qualityUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: " qbb "}))
	require.NoError(t, err)
	msg := resp.Msg
	assert.Equal(t, "QBB", msg.StockCode)
	assert.True(t, msg.InUniverse)
	assert.Equal(t, "2026-09-25", msg.AsOf)
	assert.Equal(t, "uptrend", msg.Regime.Regime)
	assert.True(t, strings.HasPrefix(msg.Regime.Verdict, "Uptrend: XJO"), "the fit covers every strategy, so the verdict is neutral: %q", msg.Regime.Verdict)
	require.Len(t, msg.Fits, len(strategies.Registry()))

	for i, st := range strategies.Registry() {
		fit := msg.Fits[i]
		assert.Equal(t, st.ID, fit.StrategyId)
		assert.Equal(t, st.Name, fit.StrategyName)
		require.Len(t, fit.Rules, len(st.Rules), st.ID)

		// The fit must equal the stock's row in that strategy's own list.
		picks, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: st.ID, Limit: 100}))
		require.NoError(t, err)
		assert.Equal(t, picks.Msg.TotalCount, fit.TotalCount, st.ID)
		var row *shortsv1alpha1.StrategyPick
		for _, p := range picks.Msg.Picks {
			if p.StockCode == "QBB" {
				row = p
			}
		}
		if row == nil {
			assert.Equal(t, "none", fit.Status, st.ID)
			assert.Equal(t, int32(0), fit.Rank)
			assert.Equal(t, float64(0), fit.Score)
			continue
		}
		assert.Equal(t, row.Status, fit.Status, st.ID)
		assert.Equal(t, row.Rank, fit.Rank, st.ID)
		assert.Equal(t, row.Score, fit.Score, st.ID)
		for j := range row.Rules {
			assert.Equal(t, row.Rules[j].Status, fit.Rules[j].Status, st.ID)
			assert.Equal(t, row.Rules[j].Detail, fit.Rules[j].Detail, st.ID)
		}
	}
	quality := msg.Fits[len(msg.Fits)-1]
	assert.Equal(t, strategies.IDQualityCompounders, quality.StrategyId)
	assert.Equal(t, "triggered", quality.Status)
	assert.Greater(t, quality.Rank, int32(0))
}

func TestGetStockStrategyFit_NonPicksAreEvaluatedWithStatusNone(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(qualityUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	// NIL passes no stock-specific rule anywhere: never a pick.
	resp, err := newTestServer(t, mockStore).GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "NIL"}))
	require.NoError(t, err)
	require.True(t, resp.Msg.InUniverse)
	require.Len(t, resp.Msg.Fits, len(strategies.Registry()))
	for _, fit := range resp.Msg.Fits {
		assert.Equal(t, "none", fit.Status, fit.StrategyId)
		assert.Equal(t, int32(0), fit.Rank)
		assert.Equal(t, float64(0), fit.Score)
		assert.NotEmpty(t, fit.Rules, "a non-candidate still gets its rule results")
		for _, r := range fit.Rules {
			if r.RuleId != strategies.RuleRegime {
				assert.NotEqual(t, "pass", r.Status, "%s/%s", fit.StrategyId, r.RuleId)
			}
		}
	}
}

func TestGetStockStrategyFit_OutsideTheUniverseIsAnEmptySuccess(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "ZZZ"}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.InUniverse)
	assert.Empty(t, resp.Msg.Fits)
	assert.NotNil(t, resp.Msg.Fits)
	assert.Equal(t, "ZZZ", resp.Msg.StockCode)
	assert.Equal(t, "2026-09-25", resp.Msg.AsOf)
}

func TestGetStockStrategyFit_ValidatesAndHidesStoreErrors(t *testing.T) {
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	for _, code := range []string{"", "BHP;--", "ABCDEFGHIJK"} {
		_, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: code}))
		require.Error(t, err, code)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}

	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(nil, errors.New("connection reset"))
	_, err := newTestServer(t, mockStore).GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "BHP"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	assert.NotContains(t, err.Error(), "connection reset")
}

func TestPickFundamentalsProto(t *testing.T) {
	assert.Nil(t, pickFundamentalsProto(&strategies.Candidate{StockCode: "NIL"}), "no row: absent")

	// A growth row from before 000132: basis and period from the growth row,
	// no provenance, no ratios.
	old := &strategies.Candidate{Growth: &strategies.Growth{
		RevenueYoYPct: f64(10), LatestAnnualPeriodEnd: dayPtr("2026-06-30"),
		EPSYoYPct: f64(5), BasisPeriodType: "half", LatestPeriodEnd: dayPtr("2026-12-31"), HalfLatestPeriodEnd: dayPtr("2026-12-31"),
		Currency: "USD",
	}}
	f := pickFundamentalsProto(old)
	require.NotNil(t, f)
	assert.Equal(t, "annual", f.RevenueBasisPeriodType, "an untyped revenue basis was always annual")
	assert.Equal(t, "2026-06-30", f.RevenuePeriodEnd)
	assert.Equal(t, "half", f.EpsBasisPeriodType)
	assert.Equal(t, "2026-12-31", f.EpsPeriodEnd)
	assert.Equal(t, "", f.RevenueBasisSource)
	assert.Equal(t, "USD", f.Currency)
	assert.False(t, f.HasRoePct || f.HasNetMarginPct || f.HasFcfMarginPct || f.HasNetDebtToEbitda || f.HasPeRatio)

	half := &strategies.Candidate{Growth: &strategies.Growth{RevenueYoYPct: f64(10), RevenueBasisPeriodType: "half", HalfLatestPeriodEnd: dayPtr("2026-12-31")}}
	assert.Equal(t, "2026-12-31", pickFundamentalsProto(half).RevenuePeriodEnd)

	noGrowthFigures := &strategies.Candidate{Growth: &strategies.Growth{}}
	f = pickFundamentalsProto(noGrowthFigures)
	assert.Equal(t, "", f.RevenueBasisPeriodType, "empty when no revenue growth")
	assert.Equal(t, "", f.EpsBasisPeriodType, "empty when no EPS growth")

	insurer := &strategies.Candidate{Industry: "Insurance", Quality: &strategies.Quality{Currency: "AUD"}}
	f = pickFundamentalsProto(insurer)
	assert.True(t, f.IsFinancial)
	assert.Equal(t, "AUD", f.Currency, "a quality row alone supplies the currency")
}
