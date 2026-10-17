package picks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// fakeStore records every write; reads come from its fields.
type fakeStore struct {
	universe  []string
	states    map[string]syncState
	ranks     map[string]rankInput
	headlines []filingHeadline
	filingErr error

	upserts   map[string][]PeriodRow
	attempts  []attempt
	upsertErr map[string]error
	recordErr error

	refreshed int
	skipped   []string

	leaseHolder  string // "" = free
	leaseAbsent  bool
	leaseClaims  []string
	leaseExtends int
	leaseRelease int

	extractions     []filingExtraction
	vendor          map[string][]vendorAnnual
	filingUpserts   map[string][]PeriodRow
	filingUpsertErr map[string]error
}

func (f *fakeStore) UniverseCodes(context.Context) ([]string, error) { return f.universe, nil }
func (f *fakeStore) SyncStates(context.Context) (map[string]syncState, error) {
	return f.states, nil
}
func (f *fakeStore) RankInputs(context.Context) (map[string]rankInput, error) {
	return f.ranks, nil
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
func (f *fakeStore) ClaimLease(_ context.Context, holder string) (bool, string, error) {
	f.leaseClaims = append(f.leaseClaims, holder)
	if f.leaseAbsent {
		return false, "", errLeaseAbsent
	}
	if f.leaseHolder != "" && f.leaseHolder != holder {
		return false, f.leaseHolder, nil
	}
	f.leaseHolder = holder
	return true, holder, nil
}
func (f *fakeStore) ExtendLease(context.Context, string) error { f.leaseExtends++; return nil }
func (f *fakeStore) ReleaseLease(_ context.Context, holder string) error {
	f.leaseRelease++
	if f.leaseHolder == holder {
		f.leaseHolder = ""
	}
	return nil
}

func (f *fakeStore) FilingExtractions(context.Context) ([]filingExtraction, error) {
	return f.extractions, nil
}

func (f *fakeStore) writes() int {
	return len(f.upserts) + len(f.attempts) + f.refreshed + len(f.filingUpserts)
}

// fakeFetcher answers from a per-code table; an absent code answers empty.
type fakeFetcher struct {
	name  string
	rows  map[string][]PeriodRow
	errs  map[string]error
	err   error // every code, when set
	calls []string
	onGet func(code string)
}

func (f *fakeFetcher) Name() string { return f.name }
func (f *fakeFetcher) Fundamentals(_ context.Context, code string) ([]PeriodRow, error) {
	f.calls = append(f.calls, code)
	if f.onGet != nil {
		f.onGet(code)
	}
	if f.err != nil {
		return nil, f.err
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
	if strings.HasPrefix(name, "markit") {
		rows, err = parseMarkitKeyStatistics(readFixture(t, name))
	} else {
		rows, err = parseYahooTimeseries(readFixture(t, name))
	}
	require.NoError(t, err)
	return rows
}

func testNow() time.Time { return time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC) }

func testConfig(st store, primary, fallback Fetcher) runConfig {
	cfg := runConfig{
		store:    st,
		primary:  primary,
		now:      testNow,
		maxCodes: defaultMaxCodes,
		logf:     func(string, ...any) {},
	}
	if fallback != nil {
		cfg.fallback = fallback
	}
	return cfg
}

// pipeline runs one code through fetchCode against fixture-backed fetchers.
func pipeline(t *testing.T, code string, yahoo []PeriodRow, markit []PeriodRow) codeResult {
	t.Helper()
	y := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{code: yahoo}}
	m := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{code: markit}}
	res := fetchCode(context.Background(), testConfig(nil, y, m), &runState{}, code)
	require.NoError(t, res.err)
	return res
}

func byAttempt(as []attempt) map[string]attempt {
	out := map[string]attempt{}
	for _, a := range as {
		out[a.Code] = a
	}
	return out
}

func TestRunFundamentalsWritesAndRecordsEveryAttempt(t *testing.T) {
	st := &fakeStore{
		universe: []string{"BHP", "CSL", "ETF", "BAD", "GAP"},
		states:   map[string]syncState{},
		headlines: []filingHeadline{
			{Code: "CSL", Date: date("2026-09-20"), Headline: "Appendix 4E and Annual Report"},
			{Code: "BHP", Date: date("2026-09-21"), Headline: "Trading Halt"},
		},
	}
	yahoo := &fakeFetcher{
		name: sourceYahoo,
		rows: map[string][]PeriodRow{
			"BHP": fixtureRows(t, "yahoo_full_BHP.json"),
			"CSL": fixtureRows(t, "yahoo_full_CSL.json"),
		},
		errs: map[string]error{"BAD": errors.New("unexpected status: 429")},
	}
	markit := &fakeFetcher{name: sourceMarkit, errs: map[string]error{
		"BAD": errors.New("HTTP 502"),
		"GAP": errors.New("HTTP 503"),
	}}

	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err, "3 of 5 healthy (2 loaded, 1 answered empty) is >= 50%")

	assert.Equal(t, "CSL", yahoo.calls[0], "a due filer is fetched first")
	assert.Equal(t, 2, stats.Loaded)
	assert.Equal(t, 1, stats.Empty)
	assert.Equal(t, 2, stats.Failed)
	assert.Equal(t, 1, stats.PrimaryFailed)
	assert.Positive(t, stats.Gates[gateStrayTTM], "BHP's 2020 trailing points are dropped")

	require.NotEmpty(t, st.upserts["BHP"])
	for _, r := range st.upserts["BHP"] {
		require.NotNil(t, r.FiscalYear, "fiscal years are derived before the write")
	}
	assert.Equal(t, 4, countType(st.upserts["BHP"], periodQuarter), "BHP's four quarterly balance snapshots")
	assert.NotContains(t, st.upserts, "ETF")

	byCode := byAttempt(st.attempts)
	require.Len(t, byCode, 5, "every attempted code has a sync row, success or not")
	assert.True(t, byCode["BHP"].Success)
	assert.Equal(t, outcomeLoaded, byCode["BHP"].Outcome)
	assert.Equal(t, len(st.upserts["BHP"]), byCode["BHP"].PeriodsLoaded)
	assert.True(t, byCode["BHP"].Measured)
	require.NotNil(t, byCode["BHP"].MedianK)
	assert.InDelta(t, 1.0, *byCode["BHP"].MedianK, 0.05, "BHP's NI / (EPS x shares) is 1")

	assert.Equal(t, outcomeEmpty, byCode["ETF"].Outcome, "Yahoo and Markit both answered with nothing")
	assert.Contains(t, byCode["ETF"].Err, "no fundamentals published")
	assert.False(t, byCode["ETF"].Measured)

	assert.Equal(t, outcomeFailed, byCode["BAD"].Outcome)
	assert.Contains(t, byCode["BAD"].Err, "429")
	assert.Contains(t, byCode["BAD"].Err, "502")
	assert.Equal(t, outcomeFailed, byCode["GAP"].Outcome,
		"Yahoo answered empty but the fallback errored: that is a failure, not an empty answer (§2.3)")

	// The fallback is asked only where Yahoo failed, published nothing or is
	// behind: BHP and CSL are current and complete.
	assert.ElementsMatch(t, []string{"ETF", "BAD", "GAP"}, markit.calls)
}

func TestRunFundamentalsDryRunWritesNothing(t *testing.T) {
	st := &fakeStore{universe: []string{"BHP", "DRO"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{
		"BHP": fixtureRows(t, "yahoo_full_BHP.json"),
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
	assert.Contains(t, fmt.Sprint(logged), "would write")
	assert.Contains(t, fmt.Sprint(logged), "quarter=4")

	require.NoError(t, runRefresh(context.Background(), st, true, cfg.logf))
	assert.Equal(t, 0, st.refreshed, "a dry run does not refresh the views")
}

func TestDryRunOverExplicitCodesNeedsNoDatabase(t *testing.T) {
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"BHP": fixtureRows(t, "yahoo_full_BHP.json")}}
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
	st := &fakeStore{universe: []string{"SKS"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"SKS": yahooRows}}
	markit := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{"SKS": markitRows}}

	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err)
	assert.Equal(t, 1, stats.FallbackUsed)
	rows := st.upserts["SKS"]
	require.Len(t, rows, 3)
	fy25 := find(t, rows, periodAnnual, "2025-06-30")
	assert.Equal(t, sourceYahoo, fy25.Source)
	assert.Equal(t, 100.0, val(t, fy25.Revenue), "Yahoo stays authoritative for the values it has")
	assert.Empty(t, fy25.FieldSources)
	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Equal(t, sourceMarkit, fy26.Source)
	assert.Equal(t, int16(2026), *fy26.FiscalYear)
	assert.Equal(t, 0.05, val(t, fy26.EPSDiluted), "the TTM point at the year end fills the Markit year's EPS")
	assert.Equal(t, fieldSourceDerivedTTMAtFYE, fy26.FieldSources["eps_diluted"])
}

func TestRunFundamentalsNonFiniteNeverReachesTheStore(t *testing.T) {
	st := &fakeStore{universe: []string{"XYZ"}, states: map[string]syncState{}}
	inf := []PeriodRow{{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo,
		Revenue: f64(1e300), NetIncome: f64(5)}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{"XYZ": inf}}
	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	require.NoError(t, err)
	assert.Equal(t, 1, stats.RejectedValues)
	require.Len(t, st.upserts["XYZ"], 1)
	assert.Nil(t, st.upserts["XYZ"][0].Revenue)
	assert.Contains(t, st.upserts["XYZ"][0].Rejected, "revenue", "and the stored value is nulled, not kept")
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

func manyCodes(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("C%03d", i)
	}
	return out
}

func TestRunFundamentalsStopsOnConsecutiveFailures(t *testing.T) {
	universe := manyCodes(maxConsecutiveFailures + 10)
	st := &fakeStore{universe: universe, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, err: errors.New("unexpected status: 429")}
	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	assert.Len(t, yahoo.calls, maxConsecutiveFailures, "a refusing upstream is not asked 2,300 times")
	assert.Equal(t, stopConsecutiveFailures, stats.StoppedEarly)
	assert.Equal(t, 1, runner.ExitCodeOf(err), "nothing answered: DOWN")
	assert.Len(t, st.attempts, maxConsecutiveFailures, "every attempt is still recorded")
}

func TestRunFundamentalsRateBreaker(t *testing.T) {
	// Every third Yahoo request fails: the consecutive breaker never trips,
	// but 34 of the last 100 is over the 30% line.
	universe := manyCodes(200)
	errs := map[string]error{}
	for i, c := range universe {
		if i%3 == 0 {
			errs[c] = errors.New("unexpected status: 429")
		}
	}
	st := &fakeStore{universe: universe, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, errs: errs}
	stats, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	assert.Equal(t, stopErrorRate, stats.StoppedEarly)
	assert.Len(t, yahoo.calls, rateWindow, "the window is evaluated once it is full")
	assert.Contains(t, stats.String(), "stopped_early=error_rate")
	assert.Equal(t, 0, runner.ExitCodeOf(err), "66 of 100 answered (empty): healthy by the exit rule")

	// A 30% failure rate exactly does not trip it.
	errs = map[string]error{}
	for i, c := range universe {
		if i%10 < 3 {
			errs[c] = errors.New("unexpected status: 429")
		}
	}
	st = &fakeStore{universe: universe, states: map[string]syncState{}}
	yahoo = &fakeFetcher{name: sourceYahoo, errs: errs}
	stats, _ = runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	assert.Empty(t, stats.StoppedEarly)
	assert.Len(t, yahoo.calls, 200)
}

func TestRunFundamentalsMarkitBreaker(t *testing.T) {
	universe := manyCodes(30)
	st := &fakeStore{universe: universe, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo} // answers empty: the fallback is asked every time
	markit := &fakeFetcher{name: sourceMarkit, err: errors.New("HTTP 503")}
	var logged []string
	cfg := testConfig(st, yahoo, markit)
	cfg.logf = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	stats, _ := runFundamentals(context.Background(), cfg)
	assert.Len(t, markit.calls, markitMaxConsecutiveFailures, "the fallback is not asked after 10 failures in a row")
	assert.True(t, stats.FallbackDisabled)
	assert.Contains(t, stats.String(), "fallback_disabled")
	assert.Contains(t, strings.Join(logged, "\n"), "fallback_disabled")
	a := byAttempt(st.attempts)
	assert.Equal(t, outcomeFailed, a["C000"].Outcome, "Markit asked and failed")
	assert.Equal(t, outcomeEmpty, a["C029"].Outcome, "Markit no longer asked: Yahoo's empty answer is the answer")
}

func TestRunFundamentalsStopsOnBudgetWithoutFailing(t *testing.T) {
	clock := testNow()
	st := &fakeStore{universe: []string{"A1", "A2", "A3"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, onGet: func(string) { clock = clock.Add(30 * time.Minute) }}
	cfg := testConfig(st, yahoo, nil)
	cfg.now = func() time.Time { return clock }
	cfg.budget = 45 * time.Minute
	stats, err := runFundamentals(context.Background(), cfg)
	require.NoError(t, err, "running out of time is not a failure; the next run resumes")
	assert.Len(t, yahoo.calls, 2)
	assert.Equal(t, stopBudget, stats.StoppedEarly)
}

func TestRunFundamentalsExtendsTheLeaseEvery100Codes(t *testing.T) {
	st := &fakeStore{universe: manyCodes(250), states: map[string]syncState{}}
	cfg := testConfig(st, &fakeFetcher{name: sourceYahoo}, nil)
	extends := 0
	cfg.extendLease = func(context.Context) error { extends++; return errors.New("transient") }
	_, err := runFundamentals(context.Background(), cfg)
	require.NoError(t, err, "a failed extend is logged, never fatal")
	assert.Equal(t, 2, extends, "at code 100 and code 200")
}

func TestRunFundamentalsCancellationIsAnErrorAndNotRecorded(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	st := &fakeStore{universe: []string{"A1", "A2"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, onGet: func(string) { cancel() }}
	_, err := runFundamentals(ctx, testConfig(st, yahoo, nil))
	require.ErrorIs(t, err, context.Canceled)
	assert.Empty(t, st.attempts, "a fetch cut short by SIGTERM says nothing about the code")
}

func TestRunFundamentalsAttemptLogFailureStopsTheRun(t *testing.T) {
	st := &fakeStore{universe: []string{"A1", "A2"}, states: map[string]syncState{}, recordErr: errors.New("db gone")}
	yahoo := &fakeFetcher{name: sourceYahoo}
	_, err := runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	require.Error(t, err)
	assert.Len(t, yahoo.calls, 1)
}

func TestRunFundamentalsFilingLookupFailureIsNotFatal(t *testing.T) {
	st := &fakeStore{universe: []string{"A1"}, states: map[string]syncState{}, filingErr: errors.New("boom")}
	_, err := runFundamentals(context.Background(), testConfig(st, &fakeFetcher{name: sourceYahoo}, nil))
	require.NoError(t, err)
}

func TestRunFundamentalsMedianKOnlyWhenYahooAnswered(t *testing.T) {
	st := &fakeStore{universe: []string{"RMD", "MKT"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo,
		rows: map[string][]PeriodRow{"RMD": fixtureRows(t, "yahoo_full_RMD.json")},
		errs: map[string]error{"MKT": errors.New("unexpected status: 429")}}
	markit := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{"MKT": fixtureRows(t, "markit_key_statistics_MAQ.json")}}
	_, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err, "Yahoo failed for exactly half the codes: not more than half")
	a := byAttempt(st.attempts)
	require.True(t, a["RMD"].Measured)
	require.NotNil(t, a["RMD"].MedianK)
	assert.InDelta(t, 10.1, *a["RMD"].MedianK, 0.2, "a CDI listing: ten CDIs per share, so k is ~10")
	assert.Equal(t, outcomeLoaded, a["MKT"].Outcome, "loaded from the fallback alone")
	assert.False(t, a["MKT"].Measured, "Yahoo did not answer: the stored median_k stands")
}

// Yahoo answering WITHOUT an error but with no rows (a 404, mapped to nil,
// nil, or an empty timeseries document) measured nothing either: a code
// measured FX-converted on an earlier night keeps fx_converted, native_currency
// and median_k even when Markit loads rows tonight (§2.3: the three facts move
// only on an attempt Yahoo answered with rows).
func TestRunFundamentalsEmptyYahooAnswerMeasuresNothing(t *testing.T) {
	st := &fakeStore{universe: []string{"XRO", "RMD"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{
		"XRO": nil, // answered, published nothing
		"RMD": fixtureRows(t, "yahoo_full_RMD.json"),
	}}
	markit := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{"XRO": fixtureRows(t, "markit_key_statistics_XRO.json")}}
	_, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err)
	a := byAttempt(st.attempts)
	assert.Equal(t, outcomeLoaded, a["XRO"].Outcome, "Markit's rows load")
	assert.True(t, a["XRO"].Success)
	assert.False(t, a["XRO"].Measured, "no Yahoo rows: the stored fx_converted / native_currency / median_k stand")
	assert.False(t, a["XRO"].FXConverted)
	assert.Nil(t, a["XRO"].MedianK)
	assert.True(t, a["RMD"].Measured, "Yahoo answered with rows: measured")
}

// The FX-converted verdict reaches the sync row, so valuation can withhold
// on it directly (every XRO value Yahoo publishes, EPS included, is
// AUD-converted whatever its currencyCode says).
func TestRunFundamentalsRecordsFXConverted(t *testing.T) {
	st := &fakeStore{universe: []string{"XRO", "BHP"}, states: map[string]syncState{}}
	yahoo := &fakeFetcher{name: sourceYahoo, rows: map[string][]PeriodRow{
		"XRO": fixtureRows(t, "yahoo_full_XRO.json"),
		"BHP": fixtureRows(t, "yahoo_full_BHP.json"),
	}}
	markit := &fakeFetcher{name: sourceMarkit, rows: map[string][]PeriodRow{"XRO": fixtureRows(t, "markit_key_statistics_XRO.json")}}
	_, err := runFundamentals(context.Background(), testConfig(st, yahoo, markit))
	require.NoError(t, err)
	a := byAttempt(st.attempts)
	require.True(t, a["XRO"].Measured)
	assert.True(t, a["XRO"].FXConverted)
	assert.Equal(t, "NZD", a["XRO"].NativeCurrency, "Markit names the native currency")
	assert.Nil(t, a["XRO"].MedianK, "every monetary field is rejected, so no k")
	require.True(t, a["BHP"].Measured)
	assert.False(t, a["BHP"].FXConverted)
	assert.Empty(t, a["BHP"].NativeCurrency)

	// Without Markit the flag still lands; the native currency is unknown.
	st = &fakeStore{universe: []string{"XRO"}, states: map[string]syncState{}}
	_, err = runFundamentals(context.Background(), testConfig(st, yahoo, nil))
	require.NoError(t, err)
	a = byAttempt(st.attempts)
	assert.True(t, a["XRO"].FXConverted)
	assert.Empty(t, a["XRO"].NativeCurrency)
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

// ---------------------------------------------------------------------------
// End to end over live captures (2026-09-28): one code through fetchCode.

func TestPipelineBHPFullStatements(t *testing.T) {
	res := pipeline(t, "BHP", fixtureRows(t, "yahoo_full_BHP.json"), nil)
	assert.Equal(t, 3, res.gates.counts[gateStrayTTM],
		"TTM rows older than FY26 minus 18 months: the 2020 leftovers and the 2023 EPS points")
	assert.Equal(t, 4, countType(res.rows, periodAnnual))
	assert.Equal(t, 4, countType(res.rows, periodQuarter))

	fy26 := find(t, res.rows, periodAnnual, "2026-06-30")
	assert.Equal(t, "USD", fy26.Currency)
	assert.Equal(t, 44409000000.0, val(t, fy26.GrossProfit))
	assert.Equal(t, 25501000000.0, val(t, fy26.OperatingIncome))
	assert.Equal(t, 33296000000.0, val(t, fy26.NormalizedEBITDA))
	assert.Equal(t, 2108000000.0, val(t, fy26.InterestExpense))
	assert.Equal(t, -9849000000.0, val(t, fy26.CapitalExpenditure))
	assert.Equal(t, -6756000000.0, val(t, fy26.DividendsPaid))
	assert.Equal(t, 121387000000.0, val(t, fy26.TotalAssets))
	assert.Equal(t, 49420000000.0, val(t, fy26.TotalEquity))
	assert.Equal(t, 4290000000.0, val(t, fy26.NetDebt))
	assert.Equal(t, 21778000000.0, val(t, fy26.OperatingCashFlow), "reported OCF")
	assert.Nil(t, fy26.ShareBuybacks, "BHP bought nothing back")
	assert.Empty(t, fy26.FieldSources, "every value is Yahoo's own")
	assert.Empty(t, fy26.Rejected)

	q := find(t, res.rows, periodQuarter, "2025-12-31")
	assert.Equal(t, 116012000000.0, val(t, q.TotalAssets))
	assert.Equal(t, 5078211653.0, val(t, q.SharesOutstanding))
	assert.Nil(t, q.Revenue, "a snapshot never carries a flow line")
	require.NotNil(t, res.gates.medianK)
	assert.InDelta(t, 1.0, *res.gates.medianK, 0.02)
}

func TestPipelineIAGCorruptFY25IsMasked(t *testing.T) {
	res := pipeline(t, "IAG", fixtureRows(t, "yahoo_full_IAG.json"), fixtureRows(t, "markit_key_statistics_IAG.json"))
	assert.Equal(t, 1, res.gates.counts[gateScaleBreak], "FY25 revenue 5.35m between 13.7bn and 16.1bn")
	fy25 := find(t, res.rows, periodAnnual, "2025-06-30")
	for _, col := range []string{"total_assets", "total_equity", "dividends_paid", "pretax_income", "cash_and_equivalents", "operating_cash_flow"} {
		assert.Contains(t, fy25.Rejected, col, "%s is written NULL, never kept from an earlier run", col)
		c, _ := columnNamed(col)
		assert.Nil(t, c.get(&fy25), col)
	}
	assert.Equal(t, 0.3949, val(t, fy25.EPSBasic), "EPS and shares are kept")
	assert.Equal(t, 2365000000.0, val(t, fy25.SharesOutstanding))
	// Markit is asked because a gate refused FY25's revenue, and its
	// independent figures take the refused fields' place.
	assert.True(t, res.fallbackAsked)
	assert.Equal(t, 15527000000.0, val(t, fy25.Revenue))
	assert.Equal(t, 1359000000.0, val(t, fy25.NetIncome))
	assert.Equal(t, sourceMarkit, fy25.FieldSources["revenue"])
	assert.NotContains(t, fy25.Rejected, "revenue", "supplied by Markit: no longer masked")
	q := find(t, res.rows, periodQuarter, "2025-06-30")
	assert.Contains(t, q.Rejected, "total_assets", "the FY25 snapshot carries the same slipped balance sheet")
	assert.Equal(t, 2365000000.0, val(t, q.SharesOutstanding))
	fy26 := find(t, res.rows, periodAnnual, "2026-06-30")
	assert.Equal(t, 16115000000.0, val(t, fy26.Revenue))
	assert.Empty(t, fy26.Rejected)
	require.NotNil(t, res.gates.medianK)
	assert.InDelta(t, 1.0, *res.gates.medianK, 0.05, "the median of the three sound years")
}

func TestPipelineXROFXConverted(t *testing.T) {
	res := pipeline(t, "XRO", fixtureRows(t, "yahoo_full_XRO.json"), fixtureRows(t, "markit_key_statistics_XRO.json"))
	assert.True(t, res.gates.fxConverted)
	assert.Equal(t, "NZD", res.nativeCur)
	fy26 := find(t, res.rows, periodAnnual, "2026-03-31")
	assert.Equal(t, "NZD", fy26.Currency, "relabelled to Markit's native currency")
	assert.Equal(t, 2753081000.0, val(t, fy26.Revenue), "Markit's native revenue fills the rejected field's place")
	assert.Equal(t, sourceMarkit, fy26.FieldSources["revenue"])
	for _, col := range []string{"total_assets", "ebitda", "free_cash_flow", "gross_profit"} {
		assert.Contains(t, fy26.Rejected, col)
	}
	assert.Nil(t, fy26.TotalAssets)
	assert.Equal(t, 170569000.0, val(t, fy26.SharesOutstanding), "the share count is currency-free")
	assert.Nil(t, fy26.EPSBasic, "FY26 basic and diluted EPS disagree in sign: both rejected")
	assert.Nil(t, fy26.EPSDiluted)
	assert.Nil(t, res.gates.medianK, "no monetary net income survives to measure k")

	// Yahoo converts XRO's per-share figures too, whatever currencyCode it
	// puts on the point: FY25 basic EPS 1.3541 is Yahoo's AUD net income
	// (207.03m) over ~153m shares, where Xero's NZD EPS is ~1.49 (Markit's
	// 227.8m over the same shares); FY24's 1.0549, labelled NZD, is 160.2m AUD
	// over 152.3m. So every Yahoo EPS is withheld, never relabelled to the
	// native currency beside Markit's NZD revenue and net income. The share
	// count is currency-free and stays.
	yahooEPSWithheld := func(t *testing.T, res codeResult, withMarkit bool) {
		t.Helper()
		for _, end := range []string{"2023-03-31", "2024-03-31", "2025-03-31", "2026-03-31"} {
			a := find(t, res.rows, periodAnnual, end)
			assert.Equal(t, sourceYahoo, a.Source, end)
			assert.Nil(t, a.EPSBasic, "annual %s basic EPS is AUD-converted: withheld", end)
			assert.Nil(t, a.EPSDiluted, "annual %s diluted EPS is AUD-converted: withheld", end)
			assert.Contains(t, a.Rejected, "eps_basic", "annual %s: a stored converted EPS is nulled too", end)
			assert.Contains(t, a.Rejected, "eps_diluted", end)
			assert.NotNil(t, a.SharesOutstanding, "annual %s: the share count stays", end)
			if withMarkit {
				assert.Equal(t, "NZD", a.Currency, end)
				assert.Equal(t, sourceMarkit, a.FieldSources["net_income"], "annual %s: native net income from Markit", end)
			}
		}
		ttms := 0
		for _, r := range res.rows {
			if r.PeriodType != periodTTM {
				continue
			}
			ttms++
			assert.Nil(t, r.EPSBasic, "ttm %s", r.PeriodEnd.Format("2006-01-02"))
			assert.Nil(t, r.EPSDiluted, "ttm %s", r.PeriodEnd.Format("2006-01-02"))
			assert.Contains(t, r.Rejected, "eps_basic")
			assert.Contains(t, r.Rejected, "eps_diluted")
		}
		assert.Equal(t, 3, ttms, "Mar-25, Sep-25 and Mar-26 survive the stray-TTM gate (FY26 less 18 months is 1 Oct 2024)")
		for _, r := range res.rows {
			if r.Source == sourceYahoo {
				continue
			}
			assert.Nil(t, r.EPSBasic, "%s %s: no EPS copied from a converted TTM point", r.Source, r.PeriodEnd.Format("2006-01-02"))
			assert.Nil(t, r.EPSDiluted)
		}
	}
	yahooEPSWithheld(t, res, true)
	fy25 := find(t, res.rows, periodAnnual, "2025-03-31")
	assert.Equal(t, 227817000.0, val(t, fy25.NetIncome), "Markit's NZD net income")

	noMarkit := pipeline(t, "XRO", fixtureRows(t, "yahoo_full_XRO.json"), nil)
	assert.True(t, noMarkit.gates.fxConverted)
	assert.Empty(t, noMarkit.nativeCur)
	yahooEPSWithheld(t, noMarkit, false)
}

func TestPipelineLTRStrayTTMAndFYECopy(t *testing.T) {
	res := pipeline(t, "LTR", fixtureRows(t, "yahoo_full_LTR.json"), nil)
	assert.Equal(t, 4, res.gates.counts[gateStrayTTM], "the 2022 leftovers beside FY26, and the EPS points before Dec-24")
	for _, r := range res.rows {
		assert.False(t, r.PeriodType == periodTTM && r.PeriodEnd.Equal(date("2022-06-30")), "the stray TTM row is gone")
	}
	fy26 := find(t, res.rows, periodAnnual, "2026-06-30")
	assert.Equal(t, 0.031, val(t, fy26.EPSBasic), "copied from the TTM point at the year end")
	assert.Equal(t, fieldSourceDerivedTTMAtFYE, fy26.FieldSources["eps_basic"])
	assert.Equal(t, 181912000.0, val(t, fy26.OperatingCashFlow), "the direct-method OCF")
	assert.Equal(t, 639136000.0, val(t, fy26.Revenue))
	fy25 := find(t, res.rows, periodAnnual, "2025-06-30")
	assert.Equal(t, -5000.0, val(t, fy25.ShareBuybacks), "a $5,000 buyback between two $10m years is not a scale break")
	assert.Empty(t, fy25.Rejected)
}

func TestPipelineCSLDirectOCFAndSnapshots(t *testing.T) {
	res := pipeline(t, "CSL", fixtureRows(t, "yahoo_full_CSL.json"), nil)
	fy26 := find(t, res.rows, periodAnnual, "2026-06-30")
	assert.Equal(t, 3512000000.0, val(t, fy26.OperatingCashFlow), "CSL publishes only the direct-method series")
	assert.Empty(t, fy26.FieldSources, "direct-method OCF is Yahoo's own, not a derivation")
	assert.Equal(t, 14797000000.0001, val(t, fy26.TotalEquity), "1e-4 float noise is not an FX conversion")
	assert.False(t, res.gates.fxConverted)
	// The December 2024 point is a half-year balance Yahoo labels a quarter:
	// a snapshot, never a half row.
	h := find(t, res.rows, periodQuarter, "2024-12-31")
	assert.Equal(t, 38447000000.0, val(t, h.TotalAssets))
	assert.Nil(t, h.Revenue)
	assert.Zero(t, countType(res.rows, periodHalf))
	assert.Equal(t, -5.35, val(t, fy26.EPSBasic), "FY26 was a statutory loss")
}

func TestPipelineRMDConstantK(t *testing.T) {
	res := pipeline(t, "RMD", fixtureRows(t, "yahoo_full_RMD.json"), nil)
	assert.Zero(t, res.gates.counts[gateIdentityOutlier], "k ~10 in every year is the reference, not an outlier")
	require.NotNil(t, res.gates.medianK)
	assert.InDelta(t, 10.1, *res.gates.medianK, 0.2)
	assert.Equal(t, 6, countType(res.rows, periodQuarter), "RMD reports quarterly (and one Dec-24 point)")
}

func TestPipelineAXQNegativeAssets(t *testing.T) {
	res := pipeline(t, "AXQ", fixtureRows(t, "yahoo_full_AXQ.json"), nil)
	assert.Equal(t, 2, res.gates.counts[gateNonPositiveAssets])
	fy25 := find(t, res.rows, periodAnnual, "2025-12-31")
	assert.Nil(t, fy25.TotalAssets)
	assert.Nil(t, fy25.TotalEquity)
	assert.Contains(t, fy25.Rejected, "total_equity")
	assert.Equal(t, 192520000.0, val(t, fy25.Revenue), "the flow lines stand")
	assert.Equal(t, 226379568.0, val(t, fy25.SharesOutstanding), "the share count is not a balance-sheet line")
	assert.Equal(t, -85062000.0, val(t, fy25.OperatingCashFlow))
}

func TestPipelineMAQMarkitFillsEPSOnlyYear(t *testing.T) {
	res := pipeline(t, "MAQ", fixtureRows(t, "yahoo_full_MAQ.json"), fixtureRows(t, "markit_key_statistics_MAQ.json"))
	assert.True(t, res.fallbackAsked, "the latest Yahoo annual is EPS-only")
	fy25 := find(t, res.rows, periodAnnual, "2025-06-30")
	assert.Equal(t, sourceYahoo, fy25.Source)
	assert.Equal(t, 369649000.0, val(t, fy25.Revenue), "Markit's FY25 revenue is no longer blocked by Yahoo's EPS-only year")
	assert.Equal(t, sourceMarkit, fy25.FieldSources["revenue"])
	assert.Equal(t, 1.352, val(t, fy25.EPSBasic))
	fy26 := find(t, res.rows, periodAnnual, "2026-06-30")
	assert.Equal(t, sourceMarkit, fy26.Source, "the year Yahoo lacks is added")
	assert.Equal(t, 389980000.0, val(t, fy26.Revenue))
	assert.Equal(t, 1.246, val(t, fy26.EPSBasic), "the TTM point at the year end fills the rest")
	assert.Equal(t, fieldSourceDerivedTTMAtFYE, fy26.FieldSources["eps_basic"])
	assert.Equal(t, 94583000.0, val(t, fy26.OperatingCashFlow))
	assert.Equal(t, fieldSourceDerivedTTMAtFYE, fy26.FieldSources["operating_cash_flow"])
	for _, r := range res.rows {
		assert.False(t, r.Source == sourceMarkit && r.PeriodEnd.Before(date("2022-06-30")), "no Markit row before Yahoo's history")
	}
}

func TestPipelineLOVFiftyTwoWeekDates(t *testing.T) {
	res := pipeline(t, "LOV", fixtureRows(t, "yahoo_full_LOV.json"), fixtureRows(t, "markit_key_statistics_LOV.json"))
	// Markit dates FY25 29 June; Yahoo's EPS-only FY25 row is 30 June: the
	// same year, filled in place, not a second FY25 row.
	fy25 := find(t, res.rows, periodAnnual, "2025-06-30")
	assert.Equal(t, 798133000.0, val(t, fy25.Revenue))
	for _, r := range res.rows {
		assert.False(t, r.PeriodType == periodAnnual && r.PeriodEnd.Equal(date("2025-06-29")), "no duplicate FY25")
	}
	fy26 := find(t, res.rows, periodAnnual, "2026-06-28")
	assert.Equal(t, sourceMarkit, fy26.Source)
	assert.Equal(t, 0.8632, val(t, fy26.EPSBasic), "the TTM point dated 30 June is the year to 28 June")
}

func TestPipelineFMGNetDebtAbsentIsNull(t *testing.T) {
	res := pipeline(t, "FMG", fixtureRows(t, "yahoo_full_FMG.json"), nil)
	fy24 := find(t, res.rows, periodAnnual, "2024-06-30")
	assert.Nil(t, fy24.NetDebt, "Yahoo omits NetDebt when it is <= 0; NULL, never 0")
	assert.Equal(t, 5400000000.0, val(t, fy24.TotalDebt))
	assert.Equal(t, 815000000.0, val(t, fy24.CapitalLeaseObligations))
	assert.Equal(t, 4903000000.0, val(t, fy24.CashAndEquivalents))
	assert.Equal(t, 7919000000.0, val(t, fy24.OperatingCashFlow), "direct-method OCF")
	assert.False(t, res.gates.fxConverted, "30515000000.0001 is float noise")
}
