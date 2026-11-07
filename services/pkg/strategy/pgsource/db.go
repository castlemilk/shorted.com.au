// Package pgsource reads the strategy engine's inputs from PostgreSQL. It is
// shared by the API and the jobs, so every reader takes the narrow DB
// interface below (a *pgxpool.Pool satisfies it) and a test can stand in a
// database that answers SQLSTATE 42P01 or 42703.
//
// Missing objects: a database that predates a migration answers 42P01
// (undefined table) or 42703 (undefined column). The fundamentals reads (the
// growth view and the 000132 extras) treat both as absent. The other picker
// reads (ListGrowth, GetGrowth, ReportIngests, ETPSet, CompanyNames, Metadata,
// CashRate) treat 42P01 as absent. Bars, IndexBars, ASICRows and Dividends
// treat neither as absent: their tables predate the picker. An absent object
// is an empty result, logged once per method, never an error. Any other error
// is returned, so a timeout on a sick view cannot pass for "no data".
package pgsource

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the part of *pgxpool.Pool the readers use.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// strategiesQueryTimeout matches the screener's per-query budget.
const strategiesQueryTimeout = 10 * time.Second

// backtestBulkQueryTimeout is the per-query budget of the backtest's bulk
// loader. It reads whole tables (every stored ASIC row since 2000, every bar),
// which take far longer than a request's read: a 10 second budget fails on a
// laptop and will fail in the cluster as the table grows. Only LoadBacktestInputs
// sets it; the API's readers keep strategiesQueryTimeout.
const backtestBulkQueryTimeout = 2 * time.Minute

// queryBudgetKey carries a per-query budget on a context. It is unexported: the
// only setter is this package's bulk loader.
type queryBudgetKey struct{}

// withQueryBudget returns ctx carrying d as the per-query budget of every reader
// that runs under it.
func withQueryBudget(ctx context.Context, d time.Duration) context.Context {
	return context.WithValue(ctx, queryBudgetKey{}, d)
}

// queryContext bounds one query by the budget ctx carries, or by
// strategiesQueryTimeout when it carries none. Every reader wraps its query in
// it, so a bulk load and a request differ only in the budget they were given.
func queryContext(ctx context.Context) (context.Context, context.CancelFunc) {
	d := strategiesQueryTimeout
	if v, ok := ctx.Value(queryBudgetKey{}).(time.Duration); ok && v > 0 {
		d = v
	}
	return context.WithTimeout(ctx, d)
}

// isUndefinedTable reports a Postgres undefined_table (42P01) error.
func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// isUndefinedColumn reports a Postgres undefined_column (42703) error.
func isUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

// isMissingSchema reports 42P01 or 42703: an object a newer migration adds is
// not there yet.
func isMissingSchema(err error) bool {
	return isUndefinedTable(err) || isUndefinedColumn(err)
}

// missingRelationLog logs a missing strategy relation once per method, so a
// dev database without the migrations does not spam a line per request.
var missingRelationLog sync.Map // method name -> *sync.Once

func logMissingRelationOnce(method string, err error) {
	once, _ := missingRelationLog.LoadOrStore(method, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: a relation this read needs is missing (a migration not applied, or a source table absent); serving an empty result: %v", method, err)
	})
}

// missingSchemaLog logs an absent 000132 object once per method.
var missingSchemaLog sync.Map // method name -> *sync.Once

func logMissingSchemaOnce(method string, err error) {
	once, _ := missingSchemaLog.LoadOrStore(method, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: a fundamentals-coverage object is missing (migration 000132 not applied?); degrading to the older read: %v", method, err)
	})
}
