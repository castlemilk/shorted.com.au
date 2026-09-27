package picks

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// fakeStore records every write; reads come from its fields.
type fakeStore struct {
	universe  []string
	last      map[string]time.Time
	headlines []filingHeadline
	filingErr error

	upserts   map[string][]PeriodRow
	attempts  []attempt
	upsertErr map[string]error
	recordErr error

	refreshed int
	skipped   []string
}

func (f *fakeStore) UniverseCodes(context.Context) ([]string, error) { return f.universe, nil }
func (f *fakeStore) LastAttempts(context.Context) (map[string]time.Time, error) {
	return f.last, nil
}
func (f *fakeStore) RecentFilingHeadlines(_ context.Context, days int) ([]filingHeadline, error) {
	if days != filingLookbackDays {
		return nil, fmt.Errorf("lookback %d, want %d", days, filingLookbackDays)
	}
	return f.headlines, f.filingErr
}
func (f *fakeStore) UpsertPeriods(_ context.Context, code string, rows []PeriodRow, _ time.Time) error {
	if err := f.upsertErr[code]; err != nil {
		return err
	}
	if f.upserts == nil {
		f.upserts = map[string][]PeriodRow{}
	}
	f.upserts[code] = rows
	return nil
}
func (f *fakeStore) RecordAttempt(_ context.Context, a attempt) error {
	if f.recordErr != nil {
		return f.recordErr
	}
	f.attempts = append(f.attempts, a)
	return nil
}
func (f *fakeStore) RefreshStrategyViews(context.Context) ([]string, error) {
	f.refreshed++
	return f.skipped, nil
}

func (f *fakeStore) writes() int { return len(f.upserts) + len(f.attempts) + f.refreshed }

// fakeFetcher answers from a per-code table; an absent code answers empty.
type fakeFetcher struct {
	name  string
	rows  map[string][]PeriodRow
	errs  map[string]error
	calls []string
	onGet func(code string)
}

func (f *fakeFetcher) Name() string { return f.name }
func (f *fakeFetcher) Fundamentals(_ context.Context, code string) ([]PeriodRow, error) {
	f.calls = append(f.calls, code)
	if f.onGet != nil {
		f.onGet(code)
	}
	if err := f.errs[code]; err != nil {
		return nil, err
	}
	return f.rows[code], nil
}

func fixtureRows(t *testing.T, name string) []PeriodRow {
	t.Helper()
	var (
		rows []PeriodRow
		err  error
	)
	if len(name) > 6 && name[:6] == "markit" {
		rows, err = parseMarkitKeyStatistics(readFixture(t, name))
	} else {
		rows, err = parseYahooTimeseries(readFixture(t, name))
	}
	require.NoError(t, err)
	return rows
}

func testConfig(st store, primary, fallback Fetcher) runConfig {
	cfg := runConfig{
		store:    st,
		primary:  primary,
		now:      func() time.Time { return time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC) },
		maxCodes: defaultMaxCodes,
		logf:     func(string, ...any) {},
	}
	if fallback != nil {
		cfg.fallback = fallback
	}
	return cfg
}

func TestRunFundamentalsWritesAndRecordsEveryAttempt(t *testing.T) {
	st := &fakeStore{
		universe:  []string{"BHP", "DRO", "ETF", "BAD"},
		last:      map[string]time.Time{},
		headlines: []filingHeadline{{Code: "DRO", Headline: "Half Yearly Report and Accounts"}, {Code: "BHP", Headline: "Trading Halt"}},
	}
	yahoo := &fakeFetcher{
		name: sourceYahoo,
		rows: map[string][]PeriodRow{
			"BHP": fixtureRows(t, "yahoo_timeseries_BHP.json"),
			"DRO": fixtureRows(t, "yahoo_timeseries_DRO.json"),
		},
		errs: map[string]error{"BAD": errors.New("unexpected status: 429")},
	}
	markit := &fakeFetcher{name: sourceMarkit, errs: map[string]error{"BAD": errors.New("HTTP 502")}}

	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err, "3 of 4 healthy (2 loaded, 1 answered empty) is >= 50%")

	assert.Equal(t, "DRO", yahoo.calls[0], "a recent 4D/4E filer is fetched first")
	assert.Equal(t, 2, stats.Loaded)
	assert.Equal(t, 1, stats.Empty)
	assert.Equal(t, 1, stats.Failed)
	assert.Equal(t, 1, stats.PrimaryFailed)

	require.Len(t, st.upserts["BHP"], 10)
	for _, r := range st.upserts["BHP"] {
		require.NotNil(t, r.FiscalYear, "fiscal years are derived before the write")
	}
	assert.Len(t, st.upserts["DRO"], 10)
	assert.NotContains(t, st.upserts, "ETF")

	// Every attempted code has a sync row, success or not.
	byCode := map[string]attempt{}
	for _, a := range st.attempts {
		byCode[a.Code] = a
	}
	require.Len(t, byCode, 4)
	assert.True(t, byCode["BHP"].Success)
	assert.Equal(t, 10, byCode["BHP"].PeriodsLoaded)
	assert.False(t, byCode["ETF"].Success)
	assert.Contains(t, byCode["ETF"].Err, "no fundamentals published")
	assert.False(t, byCode["BAD"].Success)
	assert.Contains(t, byCode["BAD"].Err, "429")
	assert.Contains(t, byCode["BAD"].Err, "502")

	// The fallback is asked only where Yahoo failed or published nothing:
	// BHP and DRO are current.
	assert.ElementsMatch(t, []string{"ETF", "BAD"}, markit.calls)
}

func TestRunFundamentalsDryRunWritesNothing(t *testing.T) {
	st := &fakeStore{universe: []string{"BHP", "DRO"}, last: map[string]time.Time{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{
		"BHP": fixtureRows(t, "yahoo_timeseries_BHP.json"),
		"DRO": fixtureRows(t, "yahoo_timeseries_DRO.json"),
	}}
	cfg := testConfig(st, yahoo, &fakeFetcher{name: sourceMarkit})
	cfg.dryRun = true
	var logged []string
	cfg.logf = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }

	stats, err := runFundamentals(context.Background(), cfg)
	require.NoError(t, err)
	assert.Equal(t, 2, stats.Loaded, "fetched and parsed as in a real run")
	assert.Equal(t, 0, st.writes(), "no upsert, no attempt row")
	assert.Contains(t, fmt.Sprint(logged), "would write 10 periods")

	require.NoError(t, runRefresh(context.Background(), st, true, cfg.logf))
	assert.Equal(t, 0, st.refreshed, "a dry run does not refresh the views")
}

func TestDryRunOverExplicitCodesNeedsNoDatabase(t *testing.T) {
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"BHP": fixtureRows(t, "yahoo_timeseries_BHP.json")}}
	cfg := testConfig(nil, yahoo, nil)
	cfg.dryRun = true
	cfg.codes = []string{" bhp", "BHP", "bad code"}
	stats, err := runFundamentals(context.Background(), cfg)
	require.NoError(t, err)
	assert.Equal(t, []string{"BHP"}, yahoo.calls, "codes are normalised and deduped")
	assert.Equal(t, 1, stats.Loaded)

	cfg.codes = nil
	_, err = runFundamentals(context.Background(), cfg)
	require.Error(t, err, "without -codes the selection needs the database")
}

func TestRunFundamentalsFallbackFillsYahooLag(t *testing.T) {
	// SKS-style lag: Yahoo's annual stops at FY25 while its TTM reaches Jun-26;
	// Markit already has FY26.
	yahooRows := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo, Revenue: f64(100), NetIncome: f64(10)},
		{PeriodType: periodTTM, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo, EPSDiluted: f64(0.05)},
	}
	markitRows := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(101)},
		{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(140), NetIncome: f64(20)},
	}
	st := &fakeStore{universe: []string{"SKS"}, last: map[string]time.Time{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"SKS": yahooRows}}
	markit := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{"SKS": markitRows}}

	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err)
	assert.Equal(t, 1, stats.FallbackUsed)
	rows := st.upserts["SKS"]
	require.Len(t, rows, 3)
	assert.Equal(t, sourceYahoo, find(t, rows, periodAnnual, "2025-06-30").Source)
	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Equal(t, sourceMarkit, fy26.Source)
	assert.Equal(t, int16(2026), *fy26.FiscalYear)
}

func TestRunFundamentalsNonFiniteNeverReachesTheStore(t *testing.T) {
	st := &fakeStore{universe: []string{"XYZ"}, last: map[string]time.Time{}}
	inf := []PeriodRow{{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo,
		Revenue: f64(1e300), NetIncome: f64(5)}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"XYZ": inf}}
	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	require.NoError(t, err)
	assert.Equal(t, 1, stats.RejectedValues)
	require.Len(t, st.upserts["XYZ"], 1)
	assert.Nil(t, st.upserts["XYZ"][0].Revenue)
}

func TestOutcomeExitRule(t *testing.T) {
	cases := []struct {
		name string
		st   runStats
		code int
	}{
		{"nothing due", runStats{}, 0},
		{"all loaded", runStats{Loaded: 10}, 0},
		{"exactly half healthy", runStats{Loaded: 3, Empty: 2, Failed: 5}, 0},
		{"empties are healthy", runStats{Empty: 9, Failed: 1}, 0},
		{"under half healthy", runStats{Loaded: 4, Failed: 6}, exitCodeDegraded},
		{"nothing answered", runStats{Failed: 7}, 1},
		{"yahoo down, markit covered", runStats{Loaded: 8, Failed: 2, PrimaryFailed: 6}, exitCodeDegraded},
		{"yahoo failed for exactly half", runStats{Loaded: 10, PrimaryFailed: 5}, 0},
	}
	for _, c := range cases {
		assert.Equal(t, c.code, runner.ExitCodeOf(outcome(c.st)), c.name)
	}
}

func TestRunFundamentalsStopsOnConsecutiveFailures(t *testing.T) {
	var universe []string
	errs := map[string]error{}
	for i := 0; i < maxConsecutiveFailures+10; i++ {
		c := fmt.Sprintf("C%02d", i)
		universe = append(universe, c)
		errs[c] = errors.New("unexpected status: 429")
	}
	st := &fakeStore{universe: universe, last: map[string]time.Time{}}
	yahoo := &fakeFetcher{name: sourceYahoo, errs: errs}
	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	assert.Len(t, yahoo.calls, maxConsecutiveFailures, "a refusing upstream is not asked 400 times")
	assert.Contains(t, stats.StoppedEarly, "consecutive failures")
	assert.Equal(t, 1, runner.ExitCodeOf(err), "nothing answered: DOWN")
	assert.Len(t, st.attempts, maxConsecutiveFailures, "every attempt is still recorded")
}

func TestRunFundamentalsStopsOnBudgetWithoutFailing(t *testing.T) {
	clock := time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC)
	st := &fakeStore{universe: []string{"A1", "A2", "A3"}, last: map[string]time.Time{}}
	yahoo := &fakeFetcher{name: sourceYahoo, onGet: func(string) { clock = clock.Add(30 * time.Minute) }}
	cfg := testConfig(st, yahoo, nil)
	cfg.now = func() time.Time { return clock }
	cfg.budget = 45 * time.Minute
	stats, err := runFundamentals(context.Background(), cfg)
	require.NoError(t, err, "running out of time is not a failure; the next run resumes stalest-first")
	assert.Len(t, yahoo.calls, 2)
	assert.Contains(t, stats.StoppedEarly, "time budget")
}

func TestRunFundamentalsCancellationIsAnErrorAndNotRecorded(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	st := &fakeStore{universe: []string{"A1", "A2"}, last: map[string]time.Time{}}
	yahoo := &fakeFetcher{name: sourceYahoo, onGet: func(string) { cancel() }}
	_, err := runFundamentals(ctx, testConfig(st, yahoo, nil))
	require.ErrorIs(t, err, context.Canceled)
	assert.Empty(t, st.attempts, "a fetch cut short by SIGTERM says nothing about the code")
}

func TestRunFundamentalsAttemptLogFailureStopsTheRun(t *testing.T) {
	st := &fakeStore{universe: []string{"A1", "A2"}, last: map[string]time.Time{}, recordErr: errors.New("db gone")}
	yahoo := &fakeFetcher{name: sourceYahoo}
	_, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	require.Error(t, err)
	assert.Len(t, yahoo.calls, 1)
}

func TestRunFundamentalsFilingLookupFailureIsNotFatal(t *testing.T) {
	st := &fakeStore{universe: []string{"A1"}, last: map[string]time.Time{}, filingErr: errors.New("boom")}
	_, err := runFundamentals(context.Background(), testConfig(st, &fakeFetcher{name: sourceYahoo}, nil))
	require.NoError(t, err)
}

func TestRunRefreshFailsOnSkippedViews(t *testing.T) {
	st := &fakeStore{skipped: []string{"mv_price_features"}}
	err := runRefresh(context.Background(), st, false, func(string, ...any) {})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mv_price_features")
	assert.Equal(t, 1, runner.ExitCodeOf(err))

	st = &fakeStore{}
	require.NoError(t, runRefresh(context.Background(), st, false, func(string, ...any) {}))
	assert.Equal(t, 1, st.refreshed)
}
