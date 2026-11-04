package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

// spPick returns the row for code in a picks response, or nil.
func spPick(picks []*shortsv1alpha1.StrategyPick, code string) *shortsv1alpha1.StrategyPick {
	for _, p := range picks {
		if p.StockCode == code {
			return p
		}
	}
	return nil
}

// The counts are of the whole ranked list: a status filter, a fundamentals
// filter and the page size change the rows returned, never the counts.
func TestStatusCounts_CoverTheWholeListBeforeFilterAndPaging(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	all, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	want := &shortsv1alpha1.StatusCounts{Triggered: 1, Setup: 1, Watch: 1}
	assert.Equal(t, want.Triggered, all.Msg.StatusCounts.Triggered)
	assert.Equal(t, want.Setup, all.Msg.StatusCounts.Setup)
	assert.Equal(t, want.Watch, all.Msg.StatusCounts.Watch)
	assert.Equal(t, all.Msg.TotalCount, all.Msg.StatusCounts.Triggered+all.Msg.StatusCounts.Setup+all.Msg.StatusCounts.Watch,
		"every pick is one of the three statuses, so the counts sum to the total")

	setup, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout, Status: "setup", Limit: 1}))
	require.NoError(t, err)
	require.Len(t, setup.Msg.Picks, 1)
	assert.Equal(t, int32(1), setup.Msg.TotalCount, "the filtered total")
	assert.Equal(t, want.Triggered, setup.Msg.StatusCounts.Triggered, "a status filter does not narrow the counts")
	assert.Equal(t, want.Setup, setup.Msg.StatusCounts.Setup)
	assert.Equal(t, want.Watch, setup.Msg.StatusCounts.Watch)

	// WAT has no fundamentals row, so requiring one drops it from the rows
	// but not from the counts.
	funded, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout, RequireFundamentals: true}))
	require.NoError(t, err)
	assert.Equal(t, int32(2), funded.Msg.TotalCount)
	assert.Equal(t, want.Watch, funded.Msg.StatusCounts.Watch, "the fundamentals filter does not narrow the counts")
}

// Only a failing trigger rule on a setup row is waiting, and only such a rule
// carries a proximity: the two are the same rule kind, never a pass or a
// verdict on a row that is not waiting for anything.
func TestProximityAndWaitingFollowTheRuleKind(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	srv := newTestServer(t, mockStore)

	zanger, ok := engine.Lookup(engine.IDZangerBreakout)
	require.True(t, ok)
	triggers := map[string]bool{}
	for _, r := range zanger.Rules {
		if r.Trigger {
			triggers[r.ID] = true
		}
	}
	require.NotEmpty(t, triggers)

	resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	var waitingRules int
	for _, p := range resp.Msg.Picks {
		for _, r := range p.Rules {
			if r.HasProximity {
				assert.Equal(t, "fail", r.Status, "%s/%s: proximity on a non-failing rule", p.StockCode, r.RuleId)
				assert.True(t, triggers[r.RuleId], "%s/%s: proximity on a rule that is not a trigger", p.StockCode, r.RuleId)
			} else {
				assert.Equal(t, float64(0), r.Proximity, "%s/%s: a proximity without its flag", p.StockCode, r.RuleId)
			}
			if r.Waiting {
				waitingRules++
				assert.Equal(t, "setup", p.Status, "%s/%s: waiting on a %s row", p.StockCode, r.RuleId, p.Status)
				assert.Equal(t, "fail", r.Status)
				assert.True(t, triggers[r.RuleId], "%s/%s: waiting on a rule that is not a trigger", p.StockCode, r.RuleId)
			}
		}
		if p.Status != "setup" {
			for _, r := range p.Rules {
				assert.False(t, r.Waiting, "%s is %s but %s is waiting", p.StockCode, p.Status, r.RuleId)
			}
		}
	}
	setup := spPick(resp.Msg.Picks, "SET")
	require.NotNil(t, setup)
	assert.Equal(t, "setup", setup.Status)
	assert.Positive(t, waitingRules, "the setup row is waiting for its breakout")
	var sawBreakoutWaiting bool
	for _, r := range setup.Rules {
		if r.RuleId == engine.RuleBreakout {
			sawBreakoutWaiting = r.Waiting && r.HasProximity
		}
	}
	assert.True(t, sawBreakoutWaiting, "the failing breakout is the waiting trigger, with a proximity")
}

// The threshold, unit, comparator, trigger and weight of every rule are the
// engine's own values, copied unchanged onto the wire.
func TestStrategyRuleDefinitionsCarryTheEngineThresholds(t *testing.T) {
	var withThreshold int
	for _, st := range engine.Registry() {
		got := strategyProto(st, nil).Rules
		require.Len(t, got, len(st.Rules), st.ID)
		for i, r := range st.Rules {
			g := got[i]
			assert.Equal(t, r.ID, g.Id, st.ID)
			assert.Equal(t, r.Trigger, g.Trigger, "%s/%s", st.ID, r.ID)
			assert.Equal(t, r.Weight, g.Weight, "%s/%s", st.ID, r.ID)
			assert.Equal(t, r.Threshold, g.Threshold, "%s/%s", st.ID, r.ID)
			assert.Equal(t, r.HasThreshold, g.HasThreshold, "%s/%s", st.ID, r.ID)
			assert.Equal(t, r.Unit, g.Unit, "%s/%s", st.ID, r.ID)
			assert.Equal(t, r.Comparator, g.Comparator, "%s/%s", st.ID, r.ID)
			if g.HasThreshold {
				withThreshold++
			} else {
				assert.Equal(t, float64(0), g.Threshold, "%s/%s: a threshold without its flag", st.ID, r.ID)
			}
		}
	}
	assert.Positive(t, withThreshold)

	// rs_leader's cut-off is the universe's quartile line, published as
	// rs_quantile_threshold, so the rule itself carries no threshold.
	for _, id := range []string{engine.IDCANSLIM, engine.IDMinerviniTrendTemplate} {
		st, ok := engine.Lookup(id)
		require.True(t, ok, id)
		var sawRSLeader bool
		for _, g := range strategyProto(st, nil).Rules {
			if g.Id != engine.RuleRSLeader {
				continue
			}
			sawRSLeader = true
			assert.False(t, g.HasThreshold, id)
			assert.Zero(t, g.Threshold, id)
			assert.Empty(t, g.Unit, id)
		}
		assert.True(t, sawRSLeader, "%s has an rs_leader rule", id)
	}
}

// A measured zero is a value, and an unmeasured one is absent: each has_*
// flag follows its pointer, and a missing short report is an empty date,
// never a zero date on the wire.
func TestPickPresenceFlagsNeverComeFromZero(t *testing.T) {
	c := spReady("ZRO")
	c.DaysToCover = new(float64(0))
	c.RS6mPct = new(float64(0))
	c.DollarVolume20d = new(float64(0))
	c.PctOff52wHigh = new(float64(0)) // at the 52-week high
	p := &engine.Pick{Candidate: c, RS6mPercentile: new(float64(0))}
	got := strategyPickProto(p)
	assert.True(t, got.HasDaysToCover)
	assert.True(t, got.HasRs_6MPct)
	assert.True(t, got.HasDollarVolume_20D)
	assert.True(t, got.HasPctOff_52WHigh, "0 is the 52-week high, a real reading")
	assert.True(t, got.HasRs_6MPercentile)
	assert.Equal(t, float64(0), got.Rs_6MPercentile)

	bare := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "BAR"}})
	assert.False(t, bare.HasDaysToCover)
	assert.False(t, bare.HasRs_6MPct)
	assert.False(t, bare.HasRs_6MPercentile)
	assert.False(t, bare.HasDollarVolume_20D)
	assert.False(t, bare.HasPctOff_52WHigh)
	assert.Empty(t, bare.ShortReportDate, "no report is an empty date, never 0001-01-01")
	assert.Empty(t, bare.ShortAvailableDate)
	assert.Empty(t, bare.ShortStatus)
	assert.Empty(t, bare.BreakoutDate)
}

// A rule result's value, proximity and reason each carry their own flag or
// are empty: an unknown result has no value and no reason it cannot give.
func TestRuleResultsNeverReportAZeroAsAValue(t *testing.T) {
	results := []engine.RuleResult{
		{RuleID: engine.RuleGrowth, Status: engine.RuleUnknown, Reason: engine.ReasonNoFundamentals},
		{RuleID: engine.RuleNearHigh, Status: engine.RuleFail, Value: 0, HasValue: true, Proximity: 0.5, HasProximity: true},
		{RuleID: engine.RuleRS, Status: engine.RulePass, Value: 0, HasValue: true},
	}
	got := ruleResultsProto(results)
	require.Len(t, got, 3)
	assert.Equal(t, engine.ReasonNoFundamentals, got[0].Reason)
	assert.False(t, got[0].HasValue)
	assert.False(t, got[0].HasProximity)
	assert.Equal(t, 0.5, got[1].Proximity)
	assert.True(t, got[1].HasProximity)
	assert.True(t, got[2].HasValue, "a measured zero (exactly in line with the index) is a value")
	assert.False(t, got[2].HasProximity, "a pass is never graded by proximity")
	assert.Empty(t, got[2].Reason)
}

// A short position's report date and the date it became public are both
// present with a short position and both absent without one.
func TestShortDatesFollowTheReport(t *testing.T) {
	report := spDate("2026-10-28")
	got := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "SHT", ShortPct: new(6.0), ShortReportDate: &report}})
	assert.Equal(t, "2026-10-28", got.ShortReportDate)
	available := asxcalendar.AvailableFrom(report)
	assert.Equal(t, available.Format("2006-01-02"), got.ShortAvailableDate)
	assert.True(t, available.After(report), "the report is public after its own date")
	assert.Equal(t, "reported", got.ShortStatus)

	// No short figure, no status, even when a date came through.
	noFigure := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "ETF", ShortReportDate: &report}})
	assert.Empty(t, noFigure.ShortStatus, "the status follows the figure, which the date is the report of")

	none := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "NON"}})
	assert.Empty(t, none.ShortReportDate)
	assert.Empty(t, none.ShortAvailableDate)
	assert.Empty(t, none.ShortStatus)
}

// A report from before the holiday table's first year keeps its date and a
// figure, but no publication date: the table would count Christmas as a
// trading day. A figure with no date is a report older than the lookup reads.
func TestShortDatesWithholdPublicationBeforeTheHolidayTable(t *testing.T) {
	old := spDate("2025-12-19")
	got := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "OLD", ShortPct: new(5.0), ShortReportDate: &old}})
	assert.Equal(t, "2025-12-19", got.ShortReportDate)
	assert.Empty(t, got.ShortAvailableDate)
	assert.Equal(t, "reported", got.ShortStatus)

	bare := strategyPickProto(&engine.Pick{Candidate: engine.Candidate{StockCode: "BAR", ShortPct: new(5.0)}})
	assert.Empty(t, bare.ShortReportDate)
	assert.Equal(t, "reported", bare.ShortStatus, "the figure is reported even when its report date is not read")
}

// The picks and the fit are stale when the index has closed a session the
// prices have not reached, read from the regime view or from the index's own
// series, and never otherwise.
func TestGetStrategyPicksAndFit_StaleOnlyWhenTheIndexIsAhead(t *testing.T) {
	ahead := spUptrend()
	later := spDate("2026-09-28")
	ahead.AsOf = &later
	// The views refreshed but the index series is a session ahead of them: a
	// refresh that did not run after the load, or one that ran before it.
	seriesAhead := spUptrend()
	seriesAhead.LatestSession = &later
	for _, tc := range []struct {
		name   string
		regime engine.Regime
		stale  bool
	}{
		{"index at the price session", spUptrend(), false},
		{"index view ahead of the prices", ahead, true},
		{"index series ahead of the views", seriesAhead, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).Times(1)
			mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(tc.regime, nil).Times(1)
			srv := newTestServer(t, mockStore)

			picks, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
			require.NoError(t, err)
			assert.Equal(t, tc.stale, picks.Msg.Stale, "picks")

			fit, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "RDY"}))
			require.NoError(t, err)
			assert.Equal(t, tc.stale, fit.Msg.Stale, "fit")
		})
	}
}

// The response's short dates are the newest report across the universe, and
// its dates follow the same publication rule.
func TestGetStrategyPicks_ResponseShortDatesAreTheUniverseNewest(t *testing.T) {
	cands := spUniverse()
	for i := range cands {
		switch cands[i].StockCode {
		case "RDY":
			d := spDate("2026-10-20")
			cands[i].ShortReportDate = &d
		case "SET":
			d := spDate("2026-10-27")
			cands[i].ShortReportDate = &d
		}
	}
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(cands, nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "2026-10-27", resp.Msg.ShortReportDate)
	assert.Equal(t, asxcalendar.AvailableFrom(spDate("2026-10-27")).Format("2006-01-02"), resp.Msg.ShortAvailableDate)
	assert.Equal(t, "2026-09-25", resp.Msg.SessionDate, "the session is the newest price date")

	assert.Equal(t, "2026-10-20", spPick(resp.Msg.Picks, "RDY").ShortReportDate)
	assert.Equal(t, "2026-10-27", spPick(resp.Msg.Picks, "SET").ShortReportDate)
	assert.Empty(t, spPick(resp.Msg.Picks, "WAT").ShortReportDate, "a stock with no report carries no date")
}

// With no report anywhere the response's short dates are absent, not zero.
func TestGetStrategyPicks_NoShortReportAnywhereLeavesTheDatesEmpty(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.ShortReportDate)
	assert.Empty(t, resp.Msg.ShortAvailableDate)
}

// The response carries the universe's rs_6m quartile only when some stock has
// an rs_6m figure, and each pick's percentile is its share of the universe.
func TestGetStrategyPicks_RSQuantileAndPercentileFromTheUniverse(t *testing.T) {
	cands := spUniverse()
	rs := map[string]float64{"RDY": 10, "SET": 20, "WAT": 30, "NIL": 40}
	for i := range cands {
		cands[i].RS6mPct = new(rs[cands[i].StockCode])
	}
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(cands, nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasRsQuantileThreshold)
	assert.InDelta(t, 32.5, resp.Msg.RsQuantileThreshold, 1e-9, "the 75th percentile of 10, 20, 30, 40")

	assert.True(t, spPick(resp.Msg.Picks, "RDY").HasRs_6MPercentile)
	assert.InDelta(t, 0, spPick(resp.Msg.Picks, "RDY").Rs_6MPercentile, 1e-9, "the lowest of four stocks")
	assert.InDelta(t, 100.0/3, spPick(resp.Msg.Picks, "SET").Rs_6MPercentile, 1e-9)
	assert.InDelta(t, 200.0/3, spPick(resp.Msg.Picks, "WAT").Rs_6MPercentile, 1e-9, "below the 32.5 cut-off, so not in the top quartile")
	assert.InDelta(t, 10, spPick(resp.Msg.Picks, "RDY").Rs_6MPct, 1e-9, "rs_6m_pct is the stock's own figure")
}

func TestGetStrategyPicks_NoRS6mMeansNoQuantileAndNoPercentile(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: engine.IDZangerBreakout}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.HasRsQuantileThreshold)
	assert.Equal(t, float64(0), resp.Msg.RsQuantileThreshold)
	for _, p := range resp.Msg.Picks {
		assert.False(t, p.HasRs_6MPercentile, p.StockCode)
		assert.False(t, p.HasRs_6MPct, p.StockCode)
	}
}

// GetStockStrategyFit says whether the stock can be read against the
// strategies at all, on which session, and the dates of its short report.
func TestGetStockStrategyFit_CarriesEligibilityAndSessionAndShortDates(t *testing.T) {
	cands := spUniverse()
	for i := range cands {
		if cands[i].StockCode == "RDY" {
			d := spDate("2026-10-27")
			cands[i].ShortReportDate = &d
		}
	}
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(cands, nil).Times(1)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).Times(1)
	srv := newTestServer(t, mockStore)

	in, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "RDY"}))
	require.NoError(t, err)
	assert.True(t, in.Msg.InUniverse)
	assert.True(t, in.Msg.Eligible)
	assert.Empty(t, in.Msg.IneligibleReason)
	assert.Equal(t, "2026-09-25", in.Msg.SessionDate)
	assert.Equal(t, "2026-10-27", in.Msg.ShortReportDate)
	assert.Equal(t, asxcalendar.AvailableFrom(spDate("2026-10-27")).Format("2006-01-02"), in.Msg.ShortAvailableDate)

	out, err := srv.GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "zzz"}))
	require.NoError(t, err)
	assert.False(t, out.Msg.InUniverse)
	assert.False(t, out.Msg.Eligible)
	assert.Equal(t, "short_history", out.Msg.IneligibleReason)
	assert.Equal(t, "2026-09-25", out.Msg.SessionDate, "the session is the universe's, even for a stock outside it")
	assert.Empty(t, out.Msg.ShortReportDate)
	assert.Empty(t, out.Msg.ShortAvailableDate)
	assert.Nil(t, out.Msg.PriceFeatures)
}

// The fit's short dates are the stock's own report, never the universe's
// newest one: SET has no report even though RDY does.
func TestGetStockStrategyFit_ShortDateIsTheStocksOwn(t *testing.T) {
	cands := spUniverse()
	for i := range cands {
		if cands[i].StockCode == "RDY" {
			d := spDate("2026-10-27")
			cands[i].ShortReportDate = &d
		}
	}
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(cands, nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)

	resp, err := newTestServer(t, mockStore).GetStockStrategyFit(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "SET"}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.InUniverse)
	assert.Empty(t, resp.Msg.ShortReportDate, "SET has no report of its own although RDY does")
}
