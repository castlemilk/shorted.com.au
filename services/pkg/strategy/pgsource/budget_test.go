package pgsource

import (
	"context"
	"errors"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
)

// budgetDB records the time left on the context of each query and fails it, so
// a reader stops at its first query and the test sees the budget it was given.
type budgetDB struct {
	left []time.Duration
}

var errBudgetStop = errors.New("budget test: stop")

func (d *budgetDB) Query(ctx context.Context, _ string, _ ...any) (pgx.Rows, error) {
	if dl, ok := ctx.Deadline(); ok {
		d.left = append(d.left, time.Until(dl))
	} else {
		d.left = append(d.left, -1)
	}
	return nil, errBudgetStop
}

func (d *budgetDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	_, _ = d.Query(ctx, sql, args...)
	return failedRow{}
}

type failedRow struct{}

func (failedRow) Scan(...any) error { return errBudgetStop }

func within(got, want, slack time.Duration) bool {
	return got <= want && got > want-slack
}

func TestBacktestBulkLoaderGetsTheBulkBudget(t *testing.T) {
	db := &budgetDB{}
	to := civil.Date{Year: 2026, Month: time.November, Day: 6}
	if _, err := LoadBacktestInputs(context.Background(), db, to); err == nil {
		t.Fatal("expected the stub database to fail the load")
	}
	if len(db.left) == 0 {
		t.Fatal("the loader issued no query")
	}
	if !within(db.left[0], backtestBulkQueryTimeout, 5*time.Second) {
		t.Fatalf("the loader's first query had %v left, want about %v", db.left[0], backtestBulkQueryTimeout)
	}
}

func TestRequestReadersKeepTheRequestBudget(t *testing.T) {
	db := &budgetDB{}
	from := civil.Date{Year: 2025, Month: time.January, Day: 1}
	to := civil.Date{Year: 2026, Month: time.November, Day: 6}
	if _, err := ASICRows(context.Background(), db, from, to); err == nil {
		t.Fatal("expected the stub database to fail the read")
	}
	if len(db.left) != 1 || !within(db.left[0], strategiesQueryTimeout, 2*time.Second) {
		t.Fatalf("a request read had %v, want about %v", db.left, strategiesQueryTimeout)
	}
}

func TestQueryContextUsesTheBudgetItIsGiven(t *testing.T) {
	ctx, cancel := queryContext(context.Background())
	defer cancel()
	if dl, ok := ctx.Deadline(); !ok || !within(time.Until(dl), strategiesQueryTimeout, 2*time.Second) {
		t.Fatalf("default budget: deadline %v ok %v", dl, ok)
	}
	bulk := withQueryBudget(context.Background(), backtestBulkQueryTimeout)
	ctx2, cancel2 := queryContext(bulk)
	defer cancel2()
	if dl, ok := ctx2.Deadline(); !ok || !within(time.Until(dl), backtestBulkQueryTimeout, 2*time.Second) {
		t.Fatalf("bulk budget: deadline %v ok %v", dl, ok)
	}
}
