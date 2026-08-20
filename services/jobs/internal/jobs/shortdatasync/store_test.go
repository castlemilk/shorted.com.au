package shortdatasync

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// execCall records one Exec against the fake database.
type execCall struct {
	SQL  string
	Args []any
}

// fakeDB is a database stand-in. Only the Exec/QueryRow paths are modelled;
// the two Query paths (ExistingKeys, Health) need a full pgx.Rows and are
// exercised against a real database in the shadow run, not here.
type fakeDB struct {
	calls []execCall
	// execErr, when set, decides the error for a given call index.
	execErr func(i int, sql string) error
	// rowScan feeds QueryRow.Scan.
	rowScan func(sql string, args []any, dest []any) error
}

func (f *fakeDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if err := ctx.Err(); err != nil {
		return pgconn.CommandTag{}, err
	}
	i := len(f.calls)
	f.calls = append(f.calls, execCall{SQL: sql, Args: args})
	if f.execErr != nil {
		if err := f.execErr(i, sql); err != nil {
			return pgconn.CommandTag{}, err
		}
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("Query not implemented in fakeDB")
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return fakeRow{sql: sql, args: args, scan: f.rowScan}
}

type fakeRow struct {
	sql  string
	args []any
	scan func(sql string, args []any, dest []any) error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.scan == nil {
		return errors.New("no rows")
	}
	return r.scan(r.sql, r.args, dest)
}

func sampleRows() []shortsRow {
	d := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	return []shortsRow{
		{Date: d, Product: "A LTD", ProductCode: "AAA", ReportedShortPositions: 1, TotalProductInIssue: 10, Percent: 10},
		{Date: d, Product: "B LTD", ProductCode: "BBB", ReportedShortPositions: 2, TotalProductInIssue: 20, Percent: 10},
		{Date: d, Product: "C LTD", ProductCode: "CCC", ReportedShortPositions: 3, TotalProductInIssue: 30, Percent: 10},
	}
}

func TestUpsertRowsArgOrder(t *testing.T) {
	db := &fakeDB{}
	store := &pgStore{db: db}

	n, err := store.UpsertRows(context.Background(), sampleRows())
	if err != nil {
		t.Fatalf("UpsertRows: %v", err)
	}
	if n != 3 {
		t.Fatalf("wrote %d rows, want 3", n)
	}
	if len(db.calls) != 3 {
		t.Fatalf("%d Exec calls, want one per row", len(db.calls))
	}
	args := db.calls[0].Args
	if len(args) != 6 {
		t.Fatalf("%d args, want 6", len(args))
	}
	if args[1] != "A LTD" || args[2] != "AAA" || args[3] != float64(1) || args[4] != float64(10) || args[5] != float64(10) {
		t.Fatalf("arg order wrong: %+v", args)
	}
}

// TestUpsertRowsToleratesRowFailure locks in the Python's per-row error
// tolerance: one bad row must not cost the rest of the file.
func TestUpsertRowsToleratesRowFailure(t *testing.T) {
	db := &fakeDB{execErr: func(i int, _ string) error {
		if i == 1 {
			return errors.New("boom")
		}
		return nil
	}}
	store := &pgStore{db: db}

	n, err := store.UpsertRows(context.Background(), sampleRows())
	if err != nil {
		t.Fatalf("UpsertRows should not fail on a row error: %v", err)
	}
	if n != 2 {
		t.Fatalf("wrote %d rows, want 2", n)
	}
	if len(db.calls) != 3 {
		t.Fatalf("the run must attempt every row, got %d calls", len(db.calls))
	}
}

func TestUpsertRowsStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	db := &fakeDB{}
	store := &pgStore{db: db}

	n, err := store.UpsertRows(ctx, sampleRows())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if n != 0 || len(db.calls) != 0 {
		t.Fatalf("cancelled run wrote %d rows in %d calls", n, len(db.calls))
	}
}

// TestUpsertSQLContract pins the two properties that make the write idempotent
// and non-destructive.
func TestUpsertSQLContract(t *testing.T) {
	if !strings.Contains(upsertShortsSQL, `ON CONFLICT ("DATE", "PRODUCT_CODE")`) {
		t.Fatal("conflict target must be the (DATE, PRODUCT_CODE) unique index")
	}
	updateClause := upsertShortsSQL[strings.Index(upsertShortsSQL, "DO UPDATE SET"):]
	if strings.Contains(updateClause, `"PRODUCT" =`) {
		t.Fatal(`the Python never refreshed "PRODUCT" on conflict; do not start`)
	}
	for _, col := range []string{`"REPORTED_SHORT_POSITIONS"`, `"TOTAL_PRODUCT_IN_ISSUE"`, `"` + colPercent + `"`} {
		if !strings.Contains(updateClause, col) {
			t.Fatalf("update clause must refresh %s", col)
		}
	}
}

// TestRefreshMaterializedViewsOneStatement is the Jul-2026 incident guard: the
// timeout disarm and the refresh must travel as ONE command so they share a
// backend session through the transaction pooler.
func TestRefreshMaterializedViewsOneStatement(t *testing.T) {
	db := &fakeDB{}
	(&pgStore{db: db}).RefreshMaterializedViews(context.Background())

	if len(db.calls) != 1 {
		t.Fatalf("%d Exec calls, want exactly 1", len(db.calls))
	}
	sql := db.calls[0].SQL
	if !strings.Contains(sql, "SET statement_timeout = 0") {
		t.Fatal("the refresh must disarm statement_timeout on its own session")
	}
	if !strings.Contains(sql, "refresh_all_materialized_views()") {
		t.Fatal("missing refresh_all_materialized_views()")
	}
	if strings.Index(sql, "SET statement_timeout") > strings.Index(sql, "refresh_all_materialized_views") {
		t.Fatal("the SET must come first")
	}
}

func TestRefreshMaterializedViewsFallsBackPerView(t *testing.T) {
	db := &fakeDB{execErr: func(i int, _ string) error {
		if i == 0 {
			return errors.New("function does not exist")
		}
		return nil
	}}
	(&pgStore{db: db}).RefreshMaterializedViews(context.Background())

	if len(db.calls) != 1+len(individualMVs) {
		t.Fatalf("%d Exec calls, want aggregate + %d fallbacks", len(db.calls), len(individualMVs))
	}
	for i, mv := range individualMVs {
		sql := db.calls[i+1].SQL
		if !strings.Contains(sql, "REFRESH MATERIALIZED VIEW "+mv) {
			t.Fatalf("fallback %d = %q, want %s", i, sql, mv)
		}
		if !strings.Contains(sql, "SET statement_timeout = 0") {
			t.Fatalf("fallback %d must also disarm the timeout", i)
		}
	}
}

func TestCleanupStuckRuns(t *testing.T) {
	db := &fakeDB{}
	n, err := (&pgStore{db: db}).CleanupStuckRuns(context.Background())
	if err != nil {
		t.Fatalf("CleanupStuckRuns: %v", err)
	}
	if n != 1 {
		t.Fatalf("rows affected = %d", n)
	}
	if !strings.Contains(db.calls[0].SQL, "INTERVAL '5 hours'") {
		t.Fatal("the stuck-run window must stay at 5 hours (longer than the task timeout)")
	}
}

func TestLastShortsDate(t *testing.T) {
	ts := time.Date(2026, 8, 14, 3, 4, 5, 0, time.UTC)
	db := &fakeDB{rowScan: func(_ string, _ []any, dest []any) error {
		p := dest[0].(**time.Time)
		*p = &ts
		return nil
	}}
	got, ok, err := (&pgStore{db: db}).LastShortsDate(context.Background())
	if err != nil || !ok {
		t.Fatalf("LastShortsDate = %v, %v, %v", got, ok, err)
	}
	if !got.Equal(time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("time-of-day must be truncated, got %s", got)
	}

	empty := &fakeDB{rowScan: func(_ string, _ []any, _ []any) error { return nil }}
	if _, ok, err := (&pgStore{db: empty}).LastShortsDate(context.Background()); err != nil || ok {
		t.Fatalf("empty table should report ok=false, got %v %v", ok, err)
	}
}

func TestHealthScore(t *testing.T) {
	if got := healthScore(3, 4); got != 75 {
		t.Fatalf("healthScore(3,4) = %v", got)
	}
	if got := healthScore(1, 3); got != 33.3 {
		t.Fatalf("healthScore(1,3) = %v", got)
	}
	if got := healthScore(0, 0); got != 0 {
		t.Fatalf("healthScore(0,0) = %v (must not divide by zero)", got)
	}
}
