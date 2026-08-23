package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// UsageDelta is one identifier's unflushed increment for one quota month.
type UsageDelta struct {
	Identifier string
	Month      time.Time // first day of the month, UTC
	Delta      int64
}

// UsageKey is the composite key of the usage table. A batch can legitimately
// span two months (a flush that straddles a month boundary), so totals are
// keyed by both parts and never by identifier alone.
type UsageKey struct {
	Identifier string
	Month      time.Time
}

// UsageStore is the persistence seam for monthly quota accounting.
//
// It is deliberately tiny — two statements — so tests can fake it and so the
// limiter cannot grow a chatty dependency by accident. Neither method is ever
// called on the request path.
type UsageStore interface {
	// ApplyDeltas additively upserts every delta in ONE statement and returns
	// the authoritative post-increment totals. Returning the totals is what
	// keeps a multi-instance deployment converging without a separate read.
	ApplyDeltas(ctx context.Context, deltas []UsageDelta) (map[UsageKey]int64, error)

	// Totals reads current counts for identifiers the instance has never
	// flushed (cold start). Called asynchronously, never on the request path.
	Totals(ctx context.Context, month time.Time, identifiers []string) (map[UsageKey]int64, error)
}

// pgxQuerier is the subset of *pgxpool.Pool the store needs. Accepting the
// interface (rather than the concrete pool) keeps this package free of a
// pgxpool import in tests and lets callers pass a pool, a conn, or a tx.
type pgxQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// PostgresUsageStore stores monthly quota counters in api_usage_monthly
// (migration 000112).
type PostgresUsageStore struct {
	db      pgxQuerier
	timeout time.Duration
}

// NewPostgresUsageStore wraps an existing pgx pool. It does NOT open its own
// connections: quota accounting piggybacks on the API's pool precisely so it
// cannot become an independent capacity problem.
func NewPostgresUsageStore(db pgxQuerier, timeout time.Duration) *PostgresUsageStore {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &PostgresUsageStore{db: db, timeout: timeout}
}

// applyDeltasSQL is the entire write path.
//
// Two properties are load-bearing:
//
//   - `request_count = u.request_count + EXCLUDED.request_count` is ADDITIVE.
//     The instance never computes and assigns a total, so concurrent instances
//     converge instead of clobbering each other's increments.
//   - `GROUP BY` collapses duplicate (identifier, month) pairs. Postgres
//     aborts an ON CONFLICT DO UPDATE that would touch the same row twice in
//     one statement; the limiter never produces duplicates, but a single
//     malformed batch must not fail the whole flush.
//
// Months are passed as 'YYYY-MM-DD' strings rather than time.Time because the
// API's pool runs in simple-protocol mode (Supabase/pgbouncer), where param
// encoding is client-side text — an explicit ::date[] cast is unambiguous
// across both protocol modes.
const applyDeltasSQL = `
INSERT INTO api_usage_monthly AS u (identifier, period_month, request_count)
SELECT t.identifier, t.period_month, SUM(t.delta)
FROM unnest($1::text[], $2::date[], $3::bigint[]) AS t(identifier, period_month, delta)
GROUP BY t.identifier, t.period_month
ON CONFLICT (identifier, period_month) DO UPDATE
SET request_count = u.request_count + EXCLUDED.request_count,
    updated_at = now()
RETURNING identifier, period_month, request_count`

// ApplyDeltas implements UsageStore.
func (s *PostgresUsageStore) ApplyDeltas(ctx context.Context, deltas []UsageDelta) (map[UsageKey]int64, error) {
	if len(deltas) == 0 {
		return map[UsageKey]int64{}, nil
	}

	identifiers := make([]string, 0, len(deltas))
	months := make([]string, 0, len(deltas))
	counts := make([]int64, 0, len(deltas))
	for _, d := range deltas {
		identifiers = append(identifiers, d.Identifier)
		months = append(months, d.Month.Format("2006-01-02"))
		counts = append(counts, d.Delta)
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	// Latency and error class are recorded for every statement. Both methods
	// are called only from AppLimiter's background goroutines, so timing them
	// adds nothing to any request. Errors are recorded as a bounded CLASS
	// (timeout/connection/pool_exhausted/...), never as the raw driver string,
	// which carries query text and would be unbounded.
	started := time.Now()
	totals, err := s.applyDeltas(ctx, identifiers, months, counts)
	recordStoreCall(ctx, opApplyDeltas, started, err)

	return totals, err
}

func (s *PostgresUsageStore) applyDeltas(
	ctx context.Context,
	identifiers []string,
	months []string,
	counts []int64,
) (map[UsageKey]int64, error) {
	rows, err := s.db.Query(ctx, applyDeltasSQL, identifiers, months, counts)
	if err != nil {
		return nil, fmt.Errorf("api_usage_monthly upsert: %w", err)
	}
	defer rows.Close()

	return scanTotals(rows)
}

const totalsSQL = `
SELECT identifier, period_month, request_count
FROM api_usage_monthly
WHERE period_month = $1::date AND identifier = ANY($2::text[])`

// Totals implements UsageStore.
func (s *PostgresUsageStore) Totals(ctx context.Context, month time.Time, identifiers []string) (map[UsageKey]int64, error) {
	if len(identifiers) == 0 {
		return map[UsageKey]int64{}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	started := time.Now()
	totals, err := s.totals(ctx, month, identifiers)
	recordStoreCall(ctx, opTotals, started, err)

	return totals, err
}

func (s *PostgresUsageStore) totals(
	ctx context.Context,
	month time.Time,
	identifiers []string,
) (map[UsageKey]int64, error) {
	rows, err := s.db.Query(ctx, totalsSQL, month.Format("2006-01-02"), identifiers)
	if err != nil {
		return nil, fmt.Errorf("api_usage_monthly read: %w", err)
	}
	defer rows.Close()

	return scanTotals(rows)
}

func scanTotals(rows pgx.Rows) (map[UsageKey]int64, error) {
	out := make(map[UsageKey]int64)
	for rows.Next() {
		var (
			identifier string
			month      time.Time
			count      int64
		)
		if err := rows.Scan(&identifier, &month, &count); err != nil {
			return nil, fmt.Errorf("scan api_usage_monthly row: %w", err)
		}
		out[UsageKey{Identifier: identifier, Month: normalizeMonth(month)}] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate api_usage_monthly rows: %w", err)
	}
	return out, nil
}

// normalizeMonth truncates any instant to the first day of its month in UTC.
// Every month value in this package passes through here so a value read back
// from Postgres (which may carry a session timezone) compares equal to the one
// the limiter computed.
func normalizeMonth(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
}
