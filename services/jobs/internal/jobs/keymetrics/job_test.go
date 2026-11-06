package keymetrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/yahoo"
)

// fakeQuoter answers per symbol and records the calls. An unknown symbol is a
// 404-style no-quote answer.
type fakeQuoter struct {
	answers map[string]func() (json.RawMessage, error)
	calls   []string
	// fallback answers symbols not in answers; nil means no-quote.
	fallback func(symbol string) (json.RawMessage, error)
}

func (q *fakeQuoter) QuoteSummary(_ context.Context, symbol string, _ []string) (json.RawMessage, error) {
	q.calls = append(q.calls, symbol)
	if f, ok := q.answers[symbol]; ok {
		return f()
	}
	if q.fallback != nil {
		return q.fallback(symbol)
	}
	return nil, &yahoo.APIError{Status: 404, Code: "Not Found", Description: "Quote not found"}
}

// fakeStore is an in-memory Store. writeErr makes a code's write fail.
type fakeStore struct {
	universe []Stock
	writes   map[string]map[string]any
	writeErr map[string]error
}

func (s *fakeStore) Universe(context.Context) ([]Stock, error) { return s.universe, nil }

func (s *fakeStore) WriteKeyMetrics(_ context.Context, code string, m map[string]any) error {
	if err := s.writeErr[code]; err != nil {
		return err
	}
	if s.writes == nil {
		s.writes = map[string]map[string]any{}
	}
	s.writes[code] = m
	return nil
}

// clock is a fake time: sleep advances it, nothing else does.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }
func (c *clock) sleep(_ context.Context, d time.Duration) error {
	c.t = c.t.Add(d)
	return nil
}

var t0 = time.Date(2026, 11, 6, 3, 0, 0, 0, time.UTC)

func testDeps(q Quoter, st Store, c *clock) deps {
	return deps{
		quoter: q,
		store:  st,
		now:    c.now,
		sleep:  c.sleep,
		jitter: func(time.Duration) time.Duration { return 0 },
		logf:   func(string, ...any) {},
	}
}

func goodResult(t *testing.T) json.RawMessage {
	t.Helper()
	return loadFixture(t, "quote_bhp.json")
}

func okQuoter(t *testing.T, codes ...string) *fakeQuoter {
	q := &fakeQuoter{answers: map[string]func() (json.RawMessage, error){}}
	for _, c := range codes {
		q.answers[c+".AX"] = func() (json.RawMessage, error) { return goodResult(t), nil }
	}
	return q
}

func baseCfg() config {
	return config{budget: 40 * time.Minute}
}

func stock(code string, updated *time.Time) Stock { return Stock{Code: code, UpdatedAt: updated} }

func ptr(t time.Time) *time.Time { return &t }

func TestOrderIsNeverWrittenFirstThenOldestThenCode(t *testing.T) {
	old := t0.Add(-72 * time.Hour)
	older := t0.Add(-200 * time.Hour)
	in := []Stock{
		stock("ZZZ", ptr(old)),
		stock("BBB", nil),
		stock("AAA", ptr(older)),
		stock("CCC", nil),
		stock("DDD", ptr(old)),
	}
	got := order(in, nil)
	var codes []string
	for _, s := range got {
		codes = append(codes, s.Code)
	}
	if strings.Join(codes, ",") != "BBB,CCC,AAA,DDD,ZZZ" {
		t.Fatalf("order = %v, want BBB,CCC,AAA,DDD,ZZZ", codes)
	}
}

func TestOrderRestrictsToTheCodesFlag(t *testing.T) {
	got := order([]Stock{stock("bhp", nil), stock("CBA", nil), stock("EML", nil)}, map[string]bool{"BHP": true, "EML": true})
	if len(got) != 2 || got[0].Code != "BHP" || got[1].Code != "EML" {
		t.Fatalf("order = %+v, want BHP and EML upper-cased", got)
	}
}

func TestFreshStocksAreSkippedUnlessForced(t *testing.T) {
	st := &fakeStore{universe: []Stock{
		stock("BHP", ptr(t0.Add(-2*time.Hour))),  // fresh
		stock("CBA", ptr(t0.Add(-25*time.Hour))), // stale
	}}
	q := okQuoter(t, "BHP", "CBA")
	c := &clock{t: t0}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(q, st, c))
	if err != nil {
		t.Fatal(err)
	}
	if sum.SkippedFresh != 1 || sum.Attempted != 1 || strings.Join(q.calls, ",") != "CBA.AX" {
		t.Fatalf("summary %+v calls %v, want BHP skipped and only CBA fetched", sum, q.calls)
	}

	q = okQuoter(t, "BHP", "CBA")
	cfg := baseCfg()
	cfg.force = true
	sum, err = runKeyMetrics(context.Background(), cfg, testDeps(q, st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.SkippedFresh != 0 || sum.Attempted != 2 {
		t.Fatalf("forced summary %+v, want both attempted", sum)
	}
}

func TestGoodRecordIsWrittenWithTheSanitisedMap(t *testing.T) {
	st := &fakeStore{universe: []Stock{stock("BHP", nil)}}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(okQuoter(t, "BHP"), st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Written != 1 || sum.Failed != 0 {
		t.Fatalf("summary %+v, want one written", sum)
	}
	m := st.writes["BHP"]
	if m == nil || m["stock_code"] != "BHP" || m["market_cap"] == nil {
		t.Fatalf("written map = %v", m)
	}
}

func TestNoDataAndErrorsLeaveTheRowAlone(t *testing.T) {
	st := &fakeStore{universe: []Stock{
		stock("NODATA", nil),   // Yahoo answers 200 with no result
		stock("NOTFOUND", nil), // Yahoo answers 404
		stock("BROKEN", nil),   // transport failure
		stock("GOOD", nil),
	}}
	q := &fakeQuoter{answers: map[string]func() (json.RawMessage, error){
		"NODATA.AX": func() (json.RawMessage, error) { return nil, nil },
		"BROKEN.AX": func() (json.RawMessage, error) { return nil, errors.New("connection reset") },
		"GOOD.AX":   func() (json.RawMessage, error) { return goodResult(t), nil },
	}}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(q, st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.NoData != 2 || sum.Failed != 1 || sum.Written != 1 {
		t.Fatalf("summary %+v, want 2 no-data, 1 failed, 1 written", sum)
	}
	for _, c := range []string{"NODATA", "NOTFOUND", "BROKEN"} {
		if _, ok := st.writes[c]; ok {
			t.Errorf("%s was written; a no-data or failed fetch must keep its row", c)
		}
	}
}

func TestAWriteErrorIsCountedAndTheRunGoesOn(t *testing.T) {
	st := &fakeStore{
		universe: []Stock{stock("BAD", nil), stock("GOOD", nil)},
		writeErr: map[string]error{"BAD": errors.New("stock not found: BAD")},
	}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(okQuoter(t, "BAD", "GOOD"), st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Failed != 1 || sum.Written != 1 {
		t.Fatalf("summary %+v, want 1 failed write and 1 written", sum)
	}
}

func TestDryRunWritesNothing(t *testing.T) {
	st := &fakeStore{universe: []Stock{stock("BHP", nil), stock("CBA", nil)}}
	cfg := baseCfg()
	cfg.dryRun = true
	sum, err := runKeyMetrics(context.Background(), cfg, testDeps(okQuoter(t, "BHP", "CBA"), st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.writes) != 0 {
		t.Fatalf("dry run wrote %v", st.writes)
	}
	if sum.Written != 2 || sum.Attempted != 2 {
		t.Fatalf("summary %+v, want the two stocks counted as would-write", sum)
	}
}

func TestPacingSpacesRequestsAboutASecondApart(t *testing.T) {
	st := &fakeStore{universe: []Stock{stock("AAA", nil), stock("BBB", nil), stock("CCC", nil)}}
	c := &clock{t: t0}
	var waits []time.Duration
	d := testDeps(okQuoter(t, "AAA", "BBB", "CCC"), st, c)
	d.sleep = func(ctx context.Context, w time.Duration) error {
		waits = append(waits, w)
		return c.sleep(ctx, w)
	}
	d.jitter = func(span time.Duration) time.Duration { return span } // the top of the range
	if _, err := runKeyMetrics(context.Background(), baseCfg(), d); err != nil {
		t.Fatal(err)
	}
	if len(waits) != 2 {
		t.Fatalf("waits = %v, want one between each pair of requests", waits)
	}
	for _, w := range waits {
		if w < 750*time.Millisecond || w > 1250*time.Millisecond {
			t.Errorf("wait %s outside 1s plus or minus 250ms", w)
		}
	}
}

func TestBudgetStopsNewStocks(t *testing.T) {
	var universe []Stock
	var codes []string
	for i := 0; i < 20; i++ {
		c := fmt.Sprintf("S%02d", i)
		universe = append(universe, stock(c, nil))
		codes = append(codes, c)
	}
	st := &fakeStore{universe: universe}
	cfg := config{budget: 2 * time.Second}
	sum, err := runKeyMetrics(context.Background(), cfg, testDeps(okQuoter(t, codes...), st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	// Requests at 0s, 0.75s and 1.5s start inside the budget; 2.25s does not.
	if sum.Attempted != 3 || sum.Stopped != stopBudget {
		t.Fatalf("summary %+v, want 3 attempts stopped by the budget", sum)
	}
	if sum.BudgetLeft != 0 {
		t.Errorf("budget left = %s, want 0 once spent", sum.BudgetLeft)
	}
}

func TestConsecutiveBreakerStopsAfterTwentyFive(t *testing.T) {
	var universe []Stock
	q := &fakeQuoter{answers: map[string]func() (json.RawMessage, error){}}
	for i := 0; i < 40; i++ {
		c := fmt.Sprintf("F%02d", i)
		universe = append(universe, stock(c, nil))
		q.answers[c+".AX"] = func() (json.RawMessage, error) { return nil, errors.New("429 Too Many Requests") }
	}
	st := &fakeStore{universe: universe}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(q, st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Stopped != stopBreaker || sum.Attempted != maxConsecutiveFailures || sum.Failed != maxConsecutiveFailures {
		t.Fatalf("summary %+v, want the breaker after %d failures", sum, maxConsecutiveFailures)
	}
	if len(q.calls) != maxConsecutiveFailures {
		t.Errorf("calls = %d, want %d: no request after the trip", len(q.calls), maxConsecutiveFailures)
	}
}

func TestRateBreakerTripsOnAFullWindowAboveThirtyPercent(t *testing.T) {
	// Two failures then a success, repeated: two thirds fail, never more than two in
	// a row. The window fills at 100 requests and trips there.
	var universe []Stock
	q := &fakeQuoter{answers: map[string]func() (json.RawMessage, error){}}
	n := 0
	for i := 0; i < 300; i++ {
		c := fmt.Sprintf("R%03d", i)
		universe = append(universe, stock(c, nil))
		pos := n
		n++
		q.answers[c+".AX"] = func() (json.RawMessage, error) {
			if pos%3 == 2 {
				return goodResult(t), nil
			}
			return nil, errors.New("503")
		}
	}
	st := &fakeStore{universe: universe}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(q, st, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Stopped != stopBreaker || sum.Attempted != rateWindow {
		t.Fatalf("summary %+v, want the rate breaker at a full window of %d", sum, rateWindow)
	}
}

func TestRateBreakerIgnoresThirtyPercent(t *testing.T) {
	// One failure in four: exactly 25 of every 100, not more than 30: no trip.
	var universe []Stock
	q := &fakeQuoter{answers: map[string]func() (json.RawMessage, error){}}
	for i := 0; i < 120; i++ {
		c := fmt.Sprintf("Q%03d", i)
		universe = append(universe, stock(c, nil))
		pos := i
		q.answers[c+".AX"] = func() (json.RawMessage, error) {
			if pos%4 == 0 {
				return nil, errors.New("503")
			}
			return goodResult(t), nil
		}
	}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(q, &fakeStore{universe: universe}, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Stopped == stopBreaker || sum.Attempted != 120 {
		t.Fatalf("summary %+v, want all 120 attempted with no breaker", sum)
	}
}

func TestNotFoundIsNoDataAndNeverCountsAsAFailure(t *testing.T) {
	// 40 unknown codes in a row must not trip the consecutive breaker: a 404 is an
	// answer.
	var universe []Stock
	for i := 0; i < 40; i++ {
		universe = append(universe, stock(fmt.Sprintf("N%02d", i), nil))
	}
	sum, err := runKeyMetrics(context.Background(), baseCfg(), testDeps(&fakeQuoter{}, &fakeStore{universe: universe}, &clock{t: t0}))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Stopped == stopBreaker || sum.NoData != 40 || sum.Failed != 0 {
		t.Fatalf("summary %+v, want 40 no-data and no breaker", sum)
	}
}

func TestVerdictExitCodes(t *testing.T) {
	ok := Summary{Attempted: 5, Written: 5}
	cases := []struct {
		name     string
		sum      Summary
		err      error
		wantCode int
	}{
		{name: "everything written", sum: ok, wantCode: 0},
		{name: "every stock fresh", sum: Summary{SkippedFresh: 4500}, wantCode: 0},
		{name: "budget spent with writes", sum: Summary{Attempted: 2400, Written: 2390, Failed: 10, Stopped: stopBudget}, wantCode: 0},
		{name: "breaker tripped", sum: Summary{Attempted: 25, Failed: 25, Stopped: stopBreaker, Written: 3}, wantCode: 1},
		{name: "attempted, none written", sum: Summary{Attempted: 7, Failed: 7}, wantCode: 1},
		{name: "attempted, all no data", sum: Summary{Attempted: 7, NoData: 7}, wantCode: 1},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := verdict(tt.sum, tt.err)
			got := runner.ExitCodeOf(err)
			if tt.wantCode == 0 && err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if tt.wantCode != 0 && got != tt.wantCode {
				t.Fatalf("exit = %d (err %v), want %d", got, err, tt.wantCode)
			}
		})
	}
}

func TestCancelledRunReturnsTheContextError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	st := &fakeStore{universe: []Stock{stock("BHP", nil)}}
	_, err := runKeyMetrics(ctx, baseCfg(), testDeps(okQuoter(t, "BHP"), st, &clock{t: t0}))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(st.writes) != 0 {
		t.Fatal("a cancelled run wrote")
	}
}

func TestBreakerTripOnlyCountsYahooFailures(t *testing.T) {
	var b breaker
	for i := 0; i < 30; i++ {
		b.record(false)
	}
	if _, tripped := b.tripped(); tripped {
		t.Fatal("answers alone tripped the breaker")
	}
	for i := 0; i < maxConsecutiveFailures; i++ {
		b.record(true)
	}
	if reason, tripped := b.tripped(); !tripped || !strings.Contains(reason, "consecutive") {
		t.Fatalf("tripped = %v reason %q, want a consecutive trip", tripped, reason)
	}
	b.record(false)
	if _, tripped := b.tripped(); tripped {
		t.Fatal("one answer should reset the consecutive count")
	}
}
