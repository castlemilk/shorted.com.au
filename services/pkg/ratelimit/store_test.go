package ratelimit

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// a minimal pgx.Rows / querier double
// ---------------------------------------------------------------------------

type stubRow struct {
	identifier string
	month      time.Time
	count      int64
}

type stubRows struct {
	rows []stubRow
	idx  int
	err  error
}

func (r *stubRows) Close()                                       {}
func (r *stubRows) Err() error                                   { return r.err }
func (r *stubRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *stubRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *stubRows) Values() ([]any, error)                       { return nil, nil }
func (r *stubRows) RawValues() [][]byte                          { return nil }
func (r *stubRows) Conn() *pgx.Conn                              { return nil }

func (r *stubRows) Next() bool {
	if r.idx >= len(r.rows) {
		return false
	}
	r.idx++
	return true
}

func (r *stubRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	*(dest[0].(*string)) = row.identifier
	*(dest[1].(*time.Time)) = row.month
	*(dest[2].(*int64)) = row.count
	return nil
}

type stubQuerier struct {
	sql  string
	args []any
	rows []stubRow
	err  error
}

func (q *stubQuerier) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.sql = sql
	q.args = args
	if q.err != nil {
		return nil, q.err
	}
	return &stubRows{rows: q.rows}, nil
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

// The whole efficiency claim rests on one statement covering every pending
// identifier. If this ever becomes a loop, the design is gone.
func TestApplyDeltasIsASingleMultiRowStatement(t *testing.T) {
	q := &stubQuerier{}
	store := NewPostgresUsageStore(q, time.Second)

	aug := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	sep := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	_, err := store.ApplyDeltas(context.Background(), []UsageDelta{
		{Identifier: "user:a", Month: aug, Delta: 12},
		{Identifier: "user:b", Month: aug, Delta: 5},
		{Identifier: "user:a", Month: sep, Delta: 3},
	})
	require.NoError(t, err)

	require.Len(t, q.args, 3, "identifiers, months and counts are passed as three parallel arrays")
	assert.Equal(t, []string{"user:a", "user:b", "user:a"}, q.args[0])
	assert.Equal(t, []string{"2026-08-01", "2026-08-01", "2026-09-01"}, q.args[1])
	assert.Equal(t, []int64{12, 5, 3}, q.args[2])

	assert.Regexp(t, regexp.MustCompile(`unnest\(\$1::text\[\], \$2::date\[\], \$3::bigint\[\]\)`), q.sql)
}

// Additive, not assigned. An instance that computed and wrote a total would
// clobber every other instance's increments.
func TestApplyDeltasUpsertIsAdditive(t *testing.T) {
	assert.Contains(t, applyDeltasSQL, "ON CONFLICT (identifier, period_month) DO UPDATE")
	assert.Contains(t, applyDeltasSQL, "request_count = u.request_count + EXCLUDED.request_count")
	assert.Contains(t, applyDeltasSQL, "updated_at = now()")
	assert.Contains(t, applyDeltasSQL, "RETURNING identifier, period_month, request_count",
		"the flush must return authoritative totals, otherwise every flush needs a follow-up read")
	assert.Contains(t, applyDeltasSQL, "GROUP BY t.identifier, t.period_month",
		"Postgres aborts an ON CONFLICT DO UPDATE that touches one row twice")
}

func TestApplyDeltasReturnsTotalsKeyedByIdentifierAndMonth(t *testing.T) {
	aug := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	sep := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	q := &stubQuerier{rows: []stubRow{
		{identifier: "user:a", month: aug, count: 120},
		{identifier: "user:a", month: sep, count: 3},
	}}
	store := NewPostgresUsageStore(q, time.Second)

	totals, err := store.ApplyDeltas(context.Background(), []UsageDelta{
		{Identifier: "user:a", Month: aug, Delta: 1},
		{Identifier: "user:a", Month: sep, Delta: 1},
	})
	require.NoError(t, err)

	assert.Equal(t, int64(120), totals[UsageKey{Identifier: "user:a", Month: aug}])
	assert.Equal(t, int64(3), totals[UsageKey{Identifier: "user:a", Month: sep}],
		"the same identifier in two months must not collide")
}

func TestEmptyBatchIssuesNoStatement(t *testing.T) {
	q := &stubQuerier{}
	store := NewPostgresUsageStore(q, time.Second)

	_, err := store.ApplyDeltas(context.Background(), nil)
	require.NoError(t, err)
	assert.Empty(t, q.sql)

	_, err = store.Totals(context.Background(), time.Now(), nil)
	require.NoError(t, err)
	assert.Empty(t, q.sql)
}

func TestTotalsReadsOneMonthForManyIdentifiers(t *testing.T) {
	q := &stubQuerier{}
	store := NewPostgresUsageStore(q, time.Second)

	_, err := store.Totals(context.Background(), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		[]string{"user:a", "user:b"})
	require.NoError(t, err)

	assert.Contains(t, q.sql, "identifier = ANY($2::text[])")
	assert.Equal(t, "2026-08-01", q.args[0])
	assert.Equal(t, []string{"user:a", "user:b"}, q.args[1])
}

// A month read back from Postgres may carry a session timezone; it must still
// compare equal to the value the limiter computed.
func TestNormalizeMonth(t *testing.T) {
	syd := time.FixedZone("AEST", 10*3600)

	tests := []struct {
		name string
		in   time.Time
		want time.Time
	}{
		{"mid month utc", time.Date(2026, 8, 15, 13, 45, 0, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{"already first", time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{"last instant of the month", time.Date(2026, 8, 31, 23, 59, 59, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		// 2026-09-01 09:00 +10:00 is 2026-08-31 23:00 UTC — the quota month is UTC.
		{"non-utc zone folds to the utc month", time.Date(2026, 9, 1, 9, 0, 0, 0, syd), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.True(t, normalizeMonth(tc.in).Equal(tc.want), "got %s want %s", normalizeMonth(tc.in), tc.want)
		})
	}
}

func TestStoreErrorsAreWrapped(t *testing.T) {
	q := &stubQuerier{err: assertErr{}}
	store := NewPostgresUsageStore(q, time.Second)

	_, err := store.ApplyDeltas(context.Background(), []UsageDelta{{Identifier: "user:a", Month: time.Now(), Delta: 1}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api_usage_monthly upsert")

	_, err = store.Totals(context.Background(), time.Now(), []string{"user:a"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api_usage_monthly read")
}

type assertErr struct{}

func (assertErr) Error() string { return "boom" }
