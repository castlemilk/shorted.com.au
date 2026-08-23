package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

// installMetrics points the global MeterProvider at a manual reader and
// re-initialises the package-level instruments against it. The instruments are
// process globals, so these tests must not run in parallel with each other.
func installMetrics(t *testing.T) *sdkmetric.ManualReader {
	t.Helper()

	prev := otel.GetMeterProvider()
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetMeterProvider(mp)
	shortedotel.InitCustomMetrics()

	t.Cleanup(func() {
		_ = mp.Shutdown(context.Background())
		otel.SetMeterProvider(prev)
		shortedotel.InitCustomMetrics()
	})

	return reader
}

func collect(t *testing.T, reader *sdkmetric.ManualReader) metricdata.ResourceMetrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(context.Background(), &rm))
	return rm
}

func findMetric(t *testing.T, rm metricdata.ResourceMetrics, name string) metricdata.Metrics {
	t.Helper()
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				return m
			}
		}
	}
	t.Fatalf("metric %q was not recorded; recorded: %v", name, metricNames(rm))
	return metricdata.Metrics{}
}

func hasMetric(rm metricdata.ResourceMetrics, name string) bool {
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				return true
			}
		}
	}
	return false
}

func metricNames(rm metricdata.ResourceMetrics) []string {
	var out []string
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			out = append(out, m.Name)
		}
	}
	return out
}

// counterFor sums an Int64 counter's datapoints whose attributes are a superset
// of want (expressed as key=value strings).
func counterFor(t *testing.T, rm metricdata.ResourceMetrics, name string, want ...string) int64 {
	t.Helper()
	m := findMetric(t, rm, name)
	sum, ok := m.Data.(metricdata.Sum[int64])
	require.Truef(t, ok, "%s is not an int64 sum", name)

	var total int64
	for _, dp := range sum.DataPoints {
		if attrsMatch(dp.Attributes.ToSlice(), want) {
			total += dp.Value
		}
	}
	return total
}

func gaugeFor(t *testing.T, rm metricdata.ResourceMetrics, name string, want ...string) int64 {
	t.Helper()
	m := findMetric(t, rm, name)
	g, ok := m.Data.(metricdata.Gauge[int64])
	require.Truef(t, ok, "%s is not an int64 gauge", name)

	for _, dp := range g.DataPoints {
		if attrsMatch(dp.Attributes.ToSlice(), want) {
			return dp.Value
		}
	}
	t.Fatalf("no datapoint on %s matching %v", name, want)
	return 0
}

// histogramCount returns the number of observations on a float histogram whose
// attributes match, plus the sum of the observed values.
func histogramCount(t *testing.T, rm metricdata.ResourceMetrics, name string, want ...string) (uint64, float64) {
	t.Helper()
	m := findMetric(t, rm, name)
	h, ok := m.Data.(metricdata.Histogram[float64])
	require.Truef(t, ok, "%s is not a float64 histogram", name)

	var (
		count uint64
		sum   float64
	)
	for _, dp := range h.DataPoints {
		if attrsMatch(dp.Attributes.ToSlice(), want) {
			count += dp.Count
			sum += dp.Sum
		}
	}
	return count, sum
}

func intHistogramCount(t *testing.T, rm metricdata.ResourceMetrics, name string) (uint64, int64) {
	t.Helper()
	m := findMetric(t, rm, name)
	h, ok := m.Data.(metricdata.Histogram[int64])
	require.Truef(t, ok, "%s is not an int64 histogram", name)

	var (
		count uint64
		sum   int64
	)
	for _, dp := range h.DataPoints {
		count += dp.Count
		sum += dp.Sum
	}
	return count, sum
}

func attrsMatch(got []attribute.KeyValue, want []string) bool {
	for _, w := range want {
		k, v, _ := strings.Cut(w, "=")
		found := false
		for _, a := range got {
			if string(a.Key) == k && a.Value.Emit() == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// allAttributeValues flattens every attribute value on every datapoint, which
// is what the cardinality guard test inspects.
func allAttributeValues(rm metricdata.ResourceMetrics) []string {
	var out []string
	appendAttrs := func(set []attribute.KeyValue) {
		for _, a := range set {
			out = append(out, a.Value.Emit())
		}
	}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			switch d := m.Data.(type) {
			case metricdata.Sum[int64]:
				for _, dp := range d.DataPoints {
					appendAttrs(dp.Attributes.ToSlice())
				}
			case metricdata.Gauge[int64]:
				for _, dp := range d.DataPoints {
					appendAttrs(dp.Attributes.ToSlice())
				}
			case metricdata.Histogram[float64]:
				for _, dp := range d.DataPoints {
					appendAttrs(dp.Attributes.ToSlice())
				}
			case metricdata.Histogram[int64]:
				for _, dp := range d.DataPoints {
					appendAttrs(dp.Attributes.ToSlice())
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 1. quota consumption as a leading indicator
// ---------------------------------------------------------------------------

func TestAllowedRequestsAreCountedNotJustBlockedOnes(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, testConfig(), newFakeStore(), clock)

	for _, r := range checkN(t, l, 5, "user:alice", "free", false) {
		recordCheck(context.Background(), r)
	}

	rm := collect(t, reader)
	require.Equal(t, int64(5), counterFor(t, rm, "shorted.rate_limit.checks_total",
		"tier=free", "access=api", "decision=allowed", "kind=none"))
}

func TestQuotaConsumptionIsRecordedBeforeAnyoneIsBlocked(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	store := newFakeStore()
	l := newTestLimiter(t, testConfig(), store, clock)

	// "free" is 100/month in testConfig. Warm the cached total so `used` is
	// meaningful, then take 10 requests => ~10% consumed, nobody blocked.
	store.setPersisted("user:bob", normalizeMonth(clock()), 0)
	checkN(t, l, 1, "user:bob", "free", false)
	l.refresh(context.Background())

	for _, r := range checkN(t, l, 10, "user:bob", "free", false) {
		recordCheck(context.Background(), r)
	}

	rm := collect(t, reader)
	count, sum := histogramCount(t, rm, "shorted.rate_limit.quota_consumed_ratio", "tier=free", "access=api")
	require.Equal(t, uint64(10), count, "one observation per metered request")
	require.Greater(t, sum, 0.0, "percent-of-quota must be a real value, not zero")
	require.Less(t, sum/float64(count), 100.0, "nobody is blocked yet")

	// And nothing was blocked.
	require.False(t, hasMetric(rm, "shorted.rate_limit.blocked"))
}

func TestUnlimitedTiersRecordNoQuotaRatio(t *testing.T) {
	reader := installMetrics(t)

	// MonthlyLimit 0 means unlimited. A ratio against zero is meaningless and
	// must not be emitted (it would read as 0% forever for paid browser users).
	recordCheck(context.Background(), &Result{
		Allowed: true, Tier: "premium", IsBrowser: true, MonthlyLimit: 0, MonthlyUsed: 900,
	})

	rm := collect(t, reader)
	require.True(t, hasMetric(rm, "shorted.rate_limit.checks_total"))
	require.False(t, hasMetric(rm, "shorted.rate_limit.quota_consumed_ratio"))
}

func TestBlockedChecksCarryTheLimitKind(t *testing.T) {
	reader := installMetrics(t)

	recordCheck(context.Background(), &Result{
		Allowed: false, ExceededKind: LimitKindMonthly, Tier: "free",
		MonthlyLimit: 1000, MonthlyUsed: 1001,
	})
	recordCheck(context.Background(), &Result{
		Allowed: false, ExceededKind: LimitKindPerMinute, Tier: "anonymous",
	})

	rm := collect(t, reader)
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.checks_total",
		"decision=blocked", "kind=monthly", "tier=free"))
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.checks_total",
		"decision=blocked", "kind=per_minute", "tier=anonymous"))
}

// ---------------------------------------------------------------------------
// 2. circuit breaker transitions
// ---------------------------------------------------------------------------

func TestBreakerTransitionsAreCounted(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	b := newCircuitBreaker(3, time.Minute)

	// Three failures open it, and only the transition is counted (not each
	// failure) so the metric means "state changed", not "a statement failed".
	require.False(t, b.recordFailure(base))
	require.False(t, b.recordFailure(base))
	require.True(t, b.recordFailure(base))
	require.True(t, b.isOpen())

	// While open and inside the cooldown, no probe and no transition.
	require.False(t, b.allow(base.Add(10*time.Second)))

	// Cooldown elapsed -> half-open probe.
	require.True(t, b.allow(base.Add(2*time.Minute)))

	// Probe succeeds -> closed.
	b.recordSuccess()
	require.False(t, b.isOpen())

	rm := collect(t, reader)
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.breaker_transitions_total", "state=open"))
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.breaker_transitions_total", "state=half_open"))
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.breaker_transitions_total", "state=closed"))
}

func TestBreakerSuccessWhileClosedRecordsNoTransition(t *testing.T) {
	reader := installMetrics(t)

	b := newCircuitBreaker(3, time.Minute)
	b.recordSuccess()
	b.recordSuccess()

	rm := collect(t, reader)
	require.False(t, hasMetric(rm, "shorted.rate_limit.breaker_transitions_total"),
		"a healthy breaker must be silent, or the signal is worthless")
}

// ---------------------------------------------------------------------------
// 3. flush health
// ---------------------------------------------------------------------------

func TestFlushSuccessRecordsResultAndRowCount(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, testConfig(), newFakeStore(), clock)

	checkN(t, l, 3, "user:a", "free", false)
	checkN(t, l, 3, "user:b", "free", false)
	l.Flush(context.Background())

	rm := collect(t, reader)
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.flush_total", "result=success"))

	count, sum := intHistogramCount(t, rm, "shorted.rate_limit.flush_rows")
	require.Equal(t, uint64(1), count, "one observation per flush, not per identifier")
	require.Equal(t, int64(2), sum, "two identifiers in the batch")
}

func TestFlushFailureAndBreakerSkipAreDistinguishable(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	clock, _ := fixedClock(base)
	store := newFakeStore()
	cfg := testConfig()
	cfg.BreakerFailureThreshold = 2
	l := newTestLimiter(t, cfg, store, clock)

	store.applyErr = errors.New("connection refused")
	checkN(t, l, 1, "user:a", "free", false)

	l.Flush(context.Background()) // failure 1
	l.Flush(context.Background()) // failure 2 -> opens breaker
	l.Flush(context.Background()) // skipped: breaker open

	rm := collect(t, reader)
	require.Equal(t, int64(2), counterFor(t, rm, "shorted.rate_limit.flush_total", "result=failure"))
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.flush_total", "result=skipped_breaker_open"),
		"'not even trying' must be distinguishable from 'trying and failing'")
	require.False(t, hasMetric(rm, "shorted.rate_limit.flush_rows"),
		"a failed flush wrote no rows and must not inflate the width histogram")
}

func TestRetainedBacklogIsVisibleWhileTheStoreIsDown(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	store := newFakeStore()
	store.applyErr = errors.New("boom")
	l := newTestLimiter(t, testConfig(), store, clock)

	checkN(t, l, 7, "user:a", "free", false)
	l.Flush(context.Background())
	l.publishGauges()

	rm := collect(t, reader)
	require.Equal(t, int64(7), gaugeFor(t, rm, "shorted.rate_limit.retained_deltas", "buffer=pending"),
		"deltas are retained on failure; the backlog is the durable-loss signal")
	require.Equal(t, int64(0), gaugeFor(t, rm, "shorted.rate_limit.retained_deltas", "buffer=orphan"))
	require.Equal(t, int64(1), gaugeFor(t, rm, "shorted.rate_limit.monthly_identifiers"))
}

func TestDroppedOrphanDeltasAreCounted(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	cfg := testConfig()
	cfg.MonthlyMaxIdentifiers = 2
	l := newTestLimiter(t, cfg, newFakeStore(), clock)

	month := normalizeMonth(clock())
	l.mu.Lock()
	l.strandLocked(UsageDelta{Identifier: "user:a", Month: month, Delta: 11})
	l.strandLocked(UsageDelta{Identifier: "user:b", Month: month, Delta: 22})
	l.strandLocked(UsageDelta{Identifier: "user:c", Month: month, Delta: 33}) // evicts user:a
	l.mu.Unlock()

	rm := collect(t, reader)
	require.Equal(t, int64(11),
		counterFor(t, rm, "shorted.rate_limit.deltas_dropped_total", "reason=orphan_buffer_full"),
		"the metric must carry the number of INCREMENTS lost, not the number of events")
}

func TestOverCapMonthlyIdentifiersAreCountedAsDropped(t *testing.T) {
	reader := installMetrics(t)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	cfg := testConfig()
	cfg.MonthlyMaxIdentifiers = 1
	cfg.MonthlyIdleEviction = time.Hour
	l := newTestLimiter(t, cfg, newFakeStore(), clock)

	checkN(t, l, 1, "user:a", "free", false)
	checkN(t, l, 1, "user:b", "free", false) // refused: map at capacity

	rm := collect(t, reader)
	require.GreaterOrEqual(t,
		counterFor(t, rm, "shorted.rate_limit.deltas_dropped_total", "reason=monthly_identifier_cap"),
		int64(1))
}

// ---------------------------------------------------------------------------
// 4. store latency + classed errors
// ---------------------------------------------------------------------------

func TestStoreRecordsLatencyForBothStatements(t *testing.T) {
	reader := installMetrics(t)

	q := &stubQuerier{}
	store := NewPostgresUsageStore(q, time.Second)
	month := normalizeMonth(time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC))

	_, err := store.ApplyDeltas(context.Background(), []UsageDelta{{Identifier: "user:a", Month: month, Delta: 1}})
	require.NoError(t, err)
	_, err = store.Totals(context.Background(), month, []string{"user:a"})
	require.NoError(t, err)

	rm := collect(t, reader)
	applyCount, _ := histogramCount(t, rm, "shorted.rate_limit.store_duration", "operation=apply_deltas", "result=ok")
	totalsCount, _ := histogramCount(t, rm, "shorted.rate_limit.store_duration", "operation=totals", "result=ok")
	require.Equal(t, uint64(1), applyCount)
	require.Equal(t, uint64(1), totalsCount)
	require.False(t, hasMetric(rm, "shorted.rate_limit.store_errors_total"))
}

func TestStoreErrorsAreCountedByBoundedClass(t *testing.T) {
	reader := installMetrics(t)

	q := &stubQuerier{err: errors.New("failed to connect to host db.example: connection refused")}
	store := NewPostgresUsageStore(q, time.Second)
	month := normalizeMonth(time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC))

	_, err := store.ApplyDeltas(context.Background(), []UsageDelta{{Identifier: "user:a", Month: month, Delta: 1}})
	require.Error(t, err)

	rm := collect(t, reader)
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.store_errors_total",
		"operation=apply_deltas", "class=connection"))
	errCount, _ := histogramCount(t, rm, "shorted.rate_limit.store_duration", "operation=apply_deltas", "result=error")
	require.Equal(t, uint64(1), errCount, "a failed statement still took time; that time is the signal")
}

func TestStoreErrorClassIsAClosedSet(t *testing.T) {
	allowed := map[string]bool{
		"ok": true, "timeout": true, "canceled": true, "connection": true,
		"pool_exhausted": true, "decode": true, "schema": true, "query": true,
	}

	cases := []struct {
		err  error
		want string
	}{
		{nil, "ok"},
		{context.DeadlineExceeded, "timeout"},
		{context.Canceled, "canceled"},
		{fmt.Errorf("wrapped: %w", context.DeadlineExceeded), "timeout"},
		{errors.New("dial tcp: connection refused"), "connection"},
		{errors.New("unexpected EOF"), "connection"},
		{errors.New("sorry, too many clients already"), "pool_exhausted"},
		{errors.New(`scan api_usage_monthly row: bad type`), "decode"},
		{errors.New(`relation "api_usage_monthly" does not exist`), "schema"},
		{errors.New("syntax error at or near"), "query"},
	}

	for _, tc := range cases {
		got := storeErrorClass(tc.err)
		require.Equal(t, tc.want, got, "err=%v", tc.err)
		require.Truef(t, allowed[got], "class %q is outside the documented closed set", got)
	}
}

// ---------------------------------------------------------------------------
// 5. minute-limiter pressure
// ---------------------------------------------------------------------------

// The cap-reached path leaves a caller UNMETERED — per-tier limiting silently
// stops applying to them. Every occurrence is counted, even though the log that
// accompanies it is throttled to once a minute.
func TestMinuteCapReachedIsCountedEveryTimeEvenWhenTheLogIsThrottled(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	l := newMinuteLimiter(time.Minute, 2, func() time.Time { return base })

	l.mu.Lock()
	for i := 0; i < 5; i++ {
		l.capReachedLocked(base) // same instant: the log throttles, the metric must not
	}
	l.mu.Unlock()

	rm := collect(t, reader)
	require.Equal(t, int64(5), counterFor(t, rm, "shorted.rate_limit.minute_cap_reached_total"))
}

// Documents why the branch above is defence in depth: under normal operation a
// full map evicts rather than going unmetered, so cap_reached firing at all is
// itself the alert.
func TestFullMinuteMapEvictsRatherThanGoingUnmetered(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	l := newMinuteLimiter(time.Minute, 2, func() time.Time { return base })

	l.check("ip:1", 10)
	l.check("ip:2", 10)
	res := l.check("ip:3", 10)
	require.True(t, res.allowed)
	require.Equal(t, 10, res.limit, "the caller is METERED, not waved through")

	rm := collect(t, reader)
	require.False(t, hasMetric(rm, "shorted.rate_limit.minute_cap_reached_total"))
}

func TestMinuteSweepPublishesMapSizeAndEvictions(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	now := base
	l := newMinuteLimiter(time.Minute, 100, func() time.Time { return now })

	l.check("ip:1", 10)
	l.check("ip:2", 10)

	now = base.Add(5 * time.Minute) // both windows now expired
	l.sweep()

	rm := collect(t, reader)
	require.Equal(t, int64(2), counterFor(t, rm, "shorted.rate_limit.minute_evictions_total", "reason=expired"))
	require.Equal(t, int64(0), gaugeFor(t, rm, "shorted.rate_limit.minute_identifiers"))
}

func TestMinuteLeastRecentEvictionIsCounted(t *testing.T) {
	reader := installMetrics(t)

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	now := base
	l := newMinuteLimiter(time.Minute, 10, func() time.Time { return now })

	for i := 0; i < 10; i++ {
		l.check(fmt.Sprintf("ip:%d", i), 100)
		now = now.Add(time.Millisecond)
	}
	// Map full and nothing is expired, so eviction must fall back to LRU.
	l.check("ip:new", 100)

	rm := collect(t, reader)
	require.GreaterOrEqual(t,
		counterFor(t, rm, "shorted.rate_limit.minute_evictions_total", "reason=least_recently_seen"),
		int64(1))
}

// ---------------------------------------------------------------------------
// 6. the invariants: no identifiers in metrics, no I/O on the request path
// ---------------------------------------------------------------------------

// The comment in interceptor.go about never using the identifier as a metric
// attribute is load-bearing: one series per client is an unbounded key space,
// which is the same failure the whole rate-limit redesign was about. This test
// drives every instrumented path with distinctive identifiers and asserts none
// of them reaches an attribute value.
func TestNoMetricAttributeEverCarriesAnIdentifier(t *testing.T) {
	reader := installMetrics(t)

	const (
		secretUser = "zzuniqueuserzz"
		secretIP   = "203.0.113.77"
	)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	store := newFakeStore()
	l := newTestLimiter(t, testConfig(), store, clock)

	for _, r := range checkN(t, l, 3, "user:"+secretUser, "free", false) {
		recordCheck(context.Background(), r)
	}
	for _, r := range checkN(t, l, 3, "ip:"+secretIP, "anonymous", false) {
		recordCheck(context.Background(), r)
	}
	l.Flush(context.Background())
	l.publishGauges()
	l.minute.sweep()

	q := &stubQuerier{err: errors.New("connection refused")}
	_, _ = NewPostgresUsageStore(q, time.Second).ApplyDeltas(context.Background(),
		[]UsageDelta{{Identifier: "user:" + secretUser, Month: normalizeMonth(clock()), Delta: 1}})

	rm := collect(t, reader)
	values := allAttributeValues(rm)
	require.NotEmpty(t, values)
	for _, v := range values {
		require.NotContains(t, v, secretUser, "identifier leaked into a metric attribute")
		require.NotContains(t, v, secretIP, "client IP leaked into a metric attribute")
	}
}

// PROOF OF THE CORE INVARIANT: instrumenting the limiter must not have put any
// I/O on the request path. The store here fails the test if it is touched at
// all, and thousands of Checks run through every instrumented branch.
func TestInstrumentationAddsNoRequestPathIO(t *testing.T) {
	installMetrics(t)

	var storeCalls int64
	tripwire := &tripwireStore{calls: &storeCalls}

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	cfg := testConfig()
	cfg.SkipAnonymousMonthly = false
	l := newTestLimiter(t, cfg, tripwire, clock)

	for i := 0; i < 2000; i++ {
		r, err := l.Check(context.Background(), fmt.Sprintf("user:u%d", i%50), "free", false)
		require.NoError(t, err)
		recordCheck(context.Background(), r)
	}
	for i := 0; i < 500; i++ {
		r, err := l.Check(context.Background(), fmt.Sprintf("ip:10.0.0.%d", i%64), "anonymous", false)
		require.NoError(t, err)
		recordCheck(context.Background(), r)
	}

	require.Equal(t, int64(0), atomic.LoadInt64(&storeCalls),
		"Check must never reach the quota store — instrumentation included")
}

type tripwireStore struct{ calls *int64 }

func (s *tripwireStore) ApplyDeltas(context.Context, []UsageDelta) (map[UsageKey]int64, error) {
	atomic.AddInt64(s.calls, 1)
	return map[UsageKey]int64{}, nil
}

func (s *tripwireStore) Totals(context.Context, time.Time, []string) (map[UsageKey]int64, error) {
	atomic.AddInt64(s.calls, 1)
	return map[UsageKey]int64{}, nil
}

// BenchmarkCheckWithInstrumentation exists so a future change that puts real
// work on the request path shows up as a number rather than an opinion.
func BenchmarkCheckWithInstrumentation(b *testing.B) {
	prev := otel.GetMeterProvider()
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetMeterProvider(mp)
	shortedotel.InitCustomMetrics()
	defer func() {
		_ = mp.Shutdown(context.Background())
		otel.SetMeterProvider(prev)
		shortedotel.InitCustomMetrics()
	}()

	cfg := withDefaults(testConfig())
	l := newAppLimiter(cfg, newFakeStore())
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r, _ := l.Check(ctx, "user:bench", "free", false)
		recordCheck(ctx, r)
	}
}

// A tier arrives from a caller's claims, so it is NOT a closed set by
// construction. An unrecognised value must be collapsed, or a malformed token
// becomes a cardinality hole.
func TestUnknownTierLabelsAreCollapsed(t *testing.T) {
	reader := installMetrics(t)

	recordCheck(context.Background(), &Result{Allowed: true, Tier: "free"})
	recordCheck(context.Background(), &Result{Allowed: true, Tier: "some-experimental-plan-x1"})
	recordCheck(context.Background(), &Result{Allowed: true, Tier: "another-weird-one"})
	recordCheck(context.Background(), &Result{Allowed: true, Tier: ""})

	rm := collect(t, reader)
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.checks_total", "tier=free"))
	require.Equal(t, int64(2), counterFor(t, rm, "shorted.rate_limit.checks_total", "tier=other"))
	require.Equal(t, int64(1), counterFor(t, rm, "shorted.rate_limit.checks_total", "tier=unknown"))

	for _, v := range allAttributeValues(rm) {
		require.NotContains(t, v, "experimental")
	}
}

// ---------------------------------------------------------------------------
// 7. logging rules
// ---------------------------------------------------------------------------

func TestRedactIdentifierKeepsSchemeAndHidesValue(t *testing.T) {
	cases := []struct{ in, prefix, raw string }{
		{"user:abc123", "user:", "abc123"},
		{"ip:203.0.113.5", "ip:", "203.0.113.5"},
		{"bare-value", "id:", "bare-value"},
	}

	for _, tc := range cases {
		got := redactIdentifier(tc.in)
		require.True(t, strings.HasPrefix(got, tc.prefix),
			"the scheme must survive so anon-vs-signed-in is still readable: %q", got)
		require.NotContains(t, got, tc.raw, "raw identifier must not survive redaction")
		require.Equal(t, got, redactIdentifier(tc.in), "redaction must be stable for correlation")
	}

	require.NotEqual(t, redactIdentifier("user:a"), redactIdentifier("user:b"))
	require.Equal(t, "user:unknown", redactIdentifier("user:"))
}

// ---------------------------------------------------------------------------
// 8. nil safety
// ---------------------------------------------------------------------------

// Instruments are package globals initialised by otel.InitProvider. Binaries
// and tests that never initialise OTel must not panic, and the limiter must not
// change behaviour based on whether metrics exist.
func TestEmittersAreNilSafe(t *testing.T) {
	shortedotel.RateLimitChecks = nil
	shortedotel.RateLimitQuotaConsumed = nil
	shortedotel.RateLimitBreakerTransitions = nil
	shortedotel.RateLimitFlushTotal = nil
	shortedotel.RateLimitFlushRows = nil
	shortedotel.RateLimitRetained = nil
	shortedotel.RateLimitDeltasDropped = nil
	shortedotel.RateLimitStoreDuration = nil
	shortedotel.RateLimitStoreErrors = nil
	shortedotel.RateLimitMinuteIdentifiers = nil
	shortedotel.RateLimitMonthlyIdentifiers = nil
	shortedotel.RateLimitMinuteEvictions = nil
	shortedotel.RateLimitMinuteCapReached = nil
	t.Cleanup(shortedotel.InitCustomMetrics)

	require.NotPanics(t, func() {
		clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
		l := newTestLimiter(t, testConfig(), newFakeStore(), clock)
		for _, r := range checkN(t, l, 3, "user:a", "free", false) {
			recordCheck(context.Background(), r)
		}
		l.Flush(context.Background())
		l.publishGauges()
		l.minute.sweep()
		recordBreakerTransition(breakerOpen)
		recordFlush(context.Background(), flushSuccess, 1)
		recordStoreCall(context.Background(), opTotals, time.Now(), errors.New("x"))
		recordCheck(context.Background(), nil)
	})
}
