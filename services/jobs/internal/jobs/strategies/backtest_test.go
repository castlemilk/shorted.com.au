package strategies

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// liveV1 is a registered live version under a label other than v0, built from the
// live v0 of a strategy: the shape the job waits for.
func liveV1(t *testing.T, strategyID string) spec.Registered {
	t.Helper()
	r, ok := spec.Live(strategyID)
	if !ok {
		t.Fatalf("no live version for %s", strategyID)
	}
	r.Label = "v1"
	for _, rec := range spec.R1Recipes() {
		if rec.StrategyID == strategyID {
			rec := rec
			r.Recipe = &rec
		}
	}
	if r.Recipe == nil {
		t.Fatalf("no r1 recipe for %s", strategyID)
	}
	return r
}

func TestBacktestTargetsIdleUntilAVersionBeyondV0IsLive(t *testing.T) {
	v0Only := spec.Registry()
	got, err := backtestTargets(v0Only)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("v0 is live but the job must idle until a later version is: got %d target(s)", len(got))
	}
}

func TestBacktestTargetsPairEachLiveVersionWithItsStrategysRecipes(t *testing.T) {
	v1 := liveV1(t, spec.StrategyCrowdedShortBreakout)
	// A retired, not-live version of another strategy must not be targeted.
	draft := liveV1(t, spec.StrategyMinerviniTrend)
	draft.Live = false
	got, err := backtestTargets([]spec.Registered{v1, draft})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d targets, want 1 (the live crowded-short version with its one recipe)", len(got))
	}
	if got[0].Reg.Spec.StrategyID != spec.StrategyCrowdedShortBreakout || got[0].Recipe.StrategyID != spec.StrategyCrowdedShortBreakout {
		t.Errorf("target pairs %s with recipe for %s", got[0].Reg.Spec.StrategyID, got[0].Recipe.StrategyID)
	}
	if len(got[0].RulesHash) != 64 || len(got[0].RecipeHash) != 64 {
		t.Errorf("hashes are not 64 hex characters: %q %q", got[0].RulesHash, got[0].RecipeHash)
	}
}

func TestPublishDedupeKeysNameTheKeyAndTheWeek(t *testing.T) {
	const rules, recipe, engine = "r1", "c1", "e1"
	weekly := publishDedupeKey(rules, recipe, engine, "2026-W45")
	if weekly != "publish:r1:c1:e1:2026-W45" {
		t.Errorf("weekly key = %q", weekly)
	}
	if asap := asapDedupeKey(rules, recipe, engine, "2026-11-13"); asap != "publish:r1:c1:e1:asap:2026-11-13" {
		t.Errorf("asap key = %q", asap)
	}
	if weekly == asapDedupeKey(rules, recipe, engine, "2026-11-13") {
		t.Error("the immediate request must not collide with the weekly one")
	}
}

func TestIsoWeekFollowsTheISOYearNotTheCalendarYear(t *testing.T) {
	// 31 December 2024 is in ISO week 1 of 2025.
	if got := isoWeek(time.Date(2024, 12, 31, 12, 0, 0, 0, time.UTC)); got != "2025-W01" {
		t.Errorf("isoWeek(2024-12-31) = %q, want 2025-W01", got)
	}
}

// publishable is a run's disclosures with every part the gate needs.
func publishable() backtest.Disclosures {
	var d backtest.Disclosures
	d.Coverage.Qualifying.Total.Qualifying = 10
	d.Coverage.AllReported.Total.Qualifying = 40
	for _, id := range backtest.SensitivityIDs {
		d.Sensitivity.Runs = append(d.Sensitivity.Runs, backtest.Sensitivity{ID: id, Applies: true})
	}
	d.Reference.Basis = backtest.BasisTotal
	d.Reference.Sessions = 250
	return d
}

func TestPublicationGateRefusesWithoutAVerifyPass(t *testing.T) {
	d := publishable()
	if err := publicationGate(d, false); err == nil {
		t.Fatal("published without a verify pass")
	}
	if err := publicationGate(d, true); err != nil {
		t.Fatalf("verified, covered, with sensitivity and reference must publish: %v", err)
	}
}

func TestPublicationGateRefusesWithoutTheSensitivityRuns(t *testing.T) {
	d := publishable()
	d.Sensitivity.Runs = d.Sensitivity.Runs[:4]
	if err := publicationGate(d, true); err == nil {
		t.Fatal("published with four of the five sensitivity runs")
	}
	d = publishable()
	d.Sensitivity.Runs[1].Applies = false
	d.Sensitivity.Runs[1].Reason = ""
	if err := publicationGate(d, true); err == nil {
		t.Fatal("a run that neither ran nor says why not is incomplete")
	}
	d = publishable()
	d.Sensitivity.Runs[1].Applies = false
	d.Sensitivity.Runs[1].Reason = "applies to the Crowded-Short recipe only"
	if err := publicationGate(d, true); err != nil {
		t.Fatalf("a sensitivity that does not apply, with its reason, is complete: %v", err)
	}
}

func TestPublicationGateRefusesWithoutTheReference(t *testing.T) {
	d := publishable()
	d.Reference = backtest.WindowFigures{}
	if err := publicationGate(d, true); err == nil {
		t.Fatal("published without the same-data reference")
	}
	d = publishable()
	d.Reference.Basis = backtest.BasisPrice
	if err := publicationGate(d, true); err == nil {
		t.Fatal("a price-return reference is not the total-return reference")
	}
}

func TestPublicationGateRefusesUncoveredRuns(t *testing.T) {
	d := publishable()
	d.Coverage = backtest.Coverage{}
	if err := publicationGate(d, true); err == nil {
		t.Fatal("a run with no coverage must not publish")
	}
	d = publishable()
	d.Coverage.AllReported = backtest.CoverageMeasure{}
	if err := publicationGate(d, true); err == nil {
		t.Fatal("a run without the all-reported measure must not publish")
	}
}

func TestFundamentalsNeedsReadsTheRulesOfEachFamily(t *testing.T) {
	growth := spec.Spec{
		Requires: []spec.DataReq{{Source: "fundamentals", From: "computable_from"}},
		Rules:    []spec.RuleSpec{{ID: "eps_growth", Core: true}, {ID: "revenue_growth", Core: true}},
	}
	if n, ok := fundamentalsNeeds(growth); !ok || !n.Growth || n.Quality {
		t.Errorf("growth rules: needs %+v ok %t", n, ok)
	}
	quality := spec.Spec{
		Requires: []spec.DataReq{{Source: "fundamentals", From: "computable_from"}},
		Rules:    []spec.RuleSpec{{ID: "roe", Core: true}, {ID: "leverage", Core: true}},
	}
	if n, ok := fundamentalsNeeds(quality); !ok || n.Growth || !n.Quality {
		t.Errorf("quality rules: needs %+v ok %t", n, ok)
	}
	// A non-core growth rule (Quality Compounders' revenue_not_shrinking) is not a
	// core input: it adds no growth need to a quality strategy.
	qualityWithNonCoreGrowth := spec.Spec{
		Requires: []spec.DataReq{{Source: "fundamentals", From: "computable_from"}},
		Rules:    []spec.RuleSpec{{ID: "roe", Core: true}, {ID: "revenue_not_shrinking", Core: false}},
	}
	if n, ok := fundamentalsNeeds(qualityWithNonCoreGrowth); !ok || n.Growth || !n.Quality {
		t.Errorf("a non-core growth rule read as a growth need: %+v ok %t", n, ok)
	}
	none := spec.Spec{Rules: []spec.RuleSpec{{ID: "breakout"}}}
	if _, ok := fundamentalsNeeds(none); ok {
		t.Error("a spec that reads no fundamentals must not derive computable_from")
	}
}

func TestRequestQueueRanksPublishBeforeVariant(t *testing.T) {
	batch := []backtestRequest{
		{ID: 3, Kind: "variant"},
		{ID: 5, Kind: "publish"},
		{ID: 1, Kind: "variant"},
		{ID: 4, Kind: "publish"},
	}
	ranks := []int{kindRank(batch[0].Kind), kindRank(batch[1].Kind)}
	if ranks[0] <= ranks[1] {
		t.Fatal("a variant ranks before a publish")
	}
	if kindRank("publish") != 0 || kindRank("variant") != 1 {
		t.Errorf("kindRank publish=%d variant=%d", kindRank("publish"), kindRank("variant"))
	}
}

func TestIdleExecutionWritesNothingAndReadsNothing(t *testing.T) {
	// No live version beyond v0: runBacktest returns before it touches a pool, so
	// a nil pool is not dereferenced. The idle path is the cheap exit of the hourly job.
	var logged []string
	res, err := runBacktest(context.Background(), nil, backtestOptions{
		Write: true,
		Logf: func(format string, args ...any) {
			logged = append(logged, format)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Idle {
		t.Fatal("no targets must be idle")
	}
	if len(logged) == 0 || !strings.Contains(logged[0], "idle") {
		t.Errorf("the idle exit is not logged: %v", logged)
	}
}

func TestDeterminismFailureIsTheExitCodeTenError(t *testing.T) {
	err := errors.New("wrap")
	wrapped := errors.Join(errDeterminism, err)
	if !errors.Is(wrapped, errDeterminism) {
		t.Fatal("a determinism failure must be recognisable through wrapping")
	}
}

func TestFirstSessionAndMonthEndsAreTheWindowsCalendar(t *testing.T) {
	sessions := []civil.Date{
		{Year: 2024, Month: time.January, Day: 2},
		{Year: 2024, Month: time.January, Day: 3},
	}
	if got := firstSession(sessions); got != sessions[0] {
		t.Errorf("firstSession = %v", got)
	}
	if got := firstSession(nil); !got.IsZero() {
		t.Errorf("firstSession(nil) = %v, want the zero date", got)
	}
}

func TestCoverageLabelPrintsNAWithoutQualifyingNames(t *testing.T) {
	var d backtest.Disclosures
	if got := coverageLabel(d); got != "n/a" {
		t.Errorf("coverageLabel with no names = %q, want n/a", got)
	}
	d.Coverage.Qualifying.Total = backtest.CoveragePeriod{Qualifying: 4, Priced: 3, Ratio: 0.75}
	if got := coverageLabel(d); got != "75.0%" {
		t.Errorf("coverageLabel = %q, want 75.0%%", got)
	}
}
