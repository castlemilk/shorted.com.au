package picks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// store is everything the job reads and writes. The pg implementation is the
// only one in production; tests use a fake so selection, dry-run and the exit
// rule are exercised without a database.
type store interface {
	// UniverseCodes: codes with a stock_prices row in the last 90 days, plus
	// every mv_screener_data code (plan §2.6). Deduped, unordered.
	UniverseCodes(ctx context.Context) ([]string, error)
	// LastAttempts: stock_fundamentals_sync.last_attempt_at by code.
	LastAttempts(ctx context.Context) (map[string]time.Time, error)
	// RecentFilingHeadlines: (code, headline) pairs from asx_announcements in
	// the last `days` days that pass the cheap SQL prefilter.
	RecentFilingHeadlines(ctx context.Context, days int) ([]filingHeadline, error)
	// UpsertPeriods writes one code's rows as ONE statement.
	UpsertPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error
	// RecordAttempt writes the code's stock_fundamentals_sync row.
	RecordAttempt(ctx context.Context, a attempt) error
	// RefreshStrategyViews runs refresh_strategy_views() and returns the views
	// it reported as skipped.
	RefreshStrategyViews(ctx context.Context) (skipped []string, err error)

	// filingStore: the -mode filings reads and writes (filings_store.go).
	filingStore
}

type filingHeadline struct {
	Code     string
	Headline string
}

// attempt is one fetch outcome, recorded for every code the run asked about.
type attempt struct {
	Code          string
	At            time.Time
	Success       bool   // rows were written
	Err           string // "" on success; the reason otherwise
	PeriodsLoaded int
}

type pgStore struct {
	pool    *pgxpool.Pool
	notices *noticeLog
}

// undefinedTable is SQLSTATE 42P01: a relation that does not exist yet
// (mv_screener_data or asx_announcements in a dev database without those
// migrations).
func undefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func (s *pgStore) UniverseCodes(ctx context.Context) ([]string, error) {
	set := map[string]bool{}
	collect := func(sql string) error {
		rows, err := s.pool.Query(ctx, sql)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var code string
			if err := rows.Scan(&code); err != nil {
				return err
			}
			set[code] = true
		}
		return rows.Err()
	}
	if err := collect(`SELECT DISTINCT stock_code::text FROM stock_prices WHERE date >= CURRENT_DATE - 90`); err != nil {
		return nil, fmt.Errorf("universe (stock_prices): %w", err)
	}
	// Two queries rather than one UNION so a database without
	// mv_screener_data still gets the price universe.
	if err := collect(`SELECT stock_code::text FROM mv_screener_data`); err != nil {
		if !undefinedTable(err) {
			return nil, fmt.Errorf("universe (mv_screener_data): %w", err)
		}
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	return out, nil
}

func (s *pgStore) LastAttempts(ctx context.Context) (map[string]time.Time, error) {
	rows, err := s.pool.Query(ctx, `SELECT stock_code, last_attempt_at FROM stock_fundamentals_sync`)
	if err != nil {
		return nil, fmt.Errorf("last attempts: %w", err)
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var code string
		var at time.Time
		if err := rows.Scan(&code, &at); err != nil {
			return nil, fmt.Errorf("last attempts: %w", err)
		}
		out[strings.ToUpper(strings.TrimSpace(code))] = at
	}
	return out, rows.Err()
}

func (s *pgStore) RecentFilingHeadlines(ctx context.Context, days int) ([]filingHeadline, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT stock_code::text, headline
		FROM asx_announcements
		WHERE announcement_date >= CURRENT_DATE - $1::int
		  AND `+filingPrefilterSQL, days)
	if err != nil {
		if undefinedTable(err) {
			return nil, nil // no announcements table: no priority, not a failure
		}
		return nil, fmt.Errorf("recent filings: %w", err)
	}
	defer rows.Close()
	var out []filingHeadline
	for rows.Next() {
		var h filingHeadline
		if err := rows.Scan(&h.Code, &h.Headline); err != nil {
			return nil, fmt.Errorf("recent filings: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// upsertSQL writes one code's periods in one statement (the unnest idiom of
// marketdata/sync's stock_prices upsert).
//
// On conflict a value the new fetch does NOT carry keeps the stored one, as
// long as the currency is unchanged. That is what makes the TTM rows a history:
// Yahoo keeps TTM revenue / profit / cash flow only for the latest point or
// two, so next half-year the same TTM date comes back with an EPS and no
// revenue, and a plain overwrite would erase the snapshot the half-year delta
// is built from. A NULL from the source means "not in this response", not
// "revised to nothing". When the currency changes, the row is replaced
// wholesale: never keep a USD figure in an AUD row.
const upsertSQL = `
INSERT INTO stock_fundamentals AS f (
    stock_code, period_type, period_end, fiscal_year, currency,
    revenue, net_income, eps_basic, eps_diluted,
    operating_cash_flow, free_cash_flow, shares_outstanding,
    source, source_fetched_at, updated_at
)
SELECT $1, t.period_type, t.period_end, t.fiscal_year, t.currency,
       t.revenue, t.net_income, t.eps_basic, t.eps_diluted,
       t.operating_cash_flow, t.free_cash_flow, t.shares_outstanding,
       t.source, $2::timestamptz, now()
FROM unnest(
    $3::text[], $4::date[], $5::int2[], $6::text[],
    $7::float8[], $8::float8[], $9::float8[], $10::float8[],
    $11::float8[], $12::float8[], $13::float8[], $14::text[]
) AS t(period_type, period_end, fiscal_year, currency,
       revenue, net_income, eps_basic, eps_diluted,
       operating_cash_flow, free_cash_flow, shares_outstanding, source)
ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET
    fiscal_year         = COALESCE(EXCLUDED.fiscal_year, f.fiscal_year),
    revenue             = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.revenue, f.revenue) ELSE EXCLUDED.revenue END,
    net_income          = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.net_income, f.net_income) ELSE EXCLUDED.net_income END,
    eps_basic           = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.eps_basic, f.eps_basic) ELSE EXCLUDED.eps_basic END,
    eps_diluted         = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.eps_diluted, f.eps_diluted) ELSE EXCLUDED.eps_diluted END,
    operating_cash_flow = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.operating_cash_flow, f.operating_cash_flow) ELSE EXCLUDED.operating_cash_flow END,
    free_cash_flow      = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.free_cash_flow, f.free_cash_flow) ELSE EXCLUDED.free_cash_flow END,
    shares_outstanding  = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED.shares_outstanding, f.shares_outstanding) ELSE EXCLUDED.shares_outstanding END,
    currency            = EXCLUDED.currency,
    source              = EXCLUDED.source,
    source_fetched_at   = EXCLUDED.source_fetched_at,
    updated_at          = now()`

// upsertArgs builds the statement's arguments; split out so tests can check
// the column arrays line up without a database.
func upsertArgs(code string, rows []PeriodRow, fetchedAt time.Time) []any {
	n := len(rows)
	periodTypes, ends, currencies, sources := make([]string, n), make([]string, n), make([]string, n), make([]string, n)
	fiscalYears := make([]*int16, n)
	revenue, netIncome, epsBasic, epsDiluted := make([]*float64, n), make([]*float64, n), make([]*float64, n), make([]*float64, n)
	ocf, fcf, shares := make([]*float64, n), make([]*float64, n), make([]*float64, n)
	for i, r := range rows {
		periodTypes[i] = r.PeriodType
		ends[i] = r.PeriodEnd.Format("2006-01-02")
		fiscalYears[i] = r.FiscalYear
		currencies[i] = r.Currency
		revenue[i], netIncome[i], epsBasic[i], epsDiluted[i] = r.Revenue, r.NetIncome, r.EPSBasic, r.EPSDiluted
		ocf[i], fcf[i], shares[i] = r.OperatingCashFlow, r.FreeCashFlow, r.SharesOutstanding
		sources[i] = r.Source
	}
	return []any{
		code, fetchedAt.UTC(),
		periodTypes, ends, fiscalYears, currencies,
		revenue, netIncome, epsBasic, epsDiluted,
		ocf, fcf, shares, sources,
	}
}

func (s *pgStore) UpsertPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error {
	if len(rows) == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, upsertSQL, upsertArgs(code, rows, fetchedAt)...); err != nil {
		return fmt.Errorf("upsert %s: %w", code, err)
	}
	return nil
}

// recordAttemptSQL: last_success_at and periods_loaded move only on a
// success, so a failed retry never hides when the code last loaded.
const recordAttemptSQL = `
INSERT INTO stock_fundamentals_sync AS s (stock_code, last_attempt_at, last_success_at, last_error, periods_loaded)
VALUES ($1, $2::timestamptz, CASE WHEN $3::bool THEN $2::timestamptz END, NULLIF($4::text, ''), $5::int)
ON CONFLICT (stock_code) DO UPDATE SET
    last_attempt_at = EXCLUDED.last_attempt_at,
    last_success_at = CASE WHEN $3::bool THEN EXCLUDED.last_attempt_at ELSE s.last_success_at END,
    last_error      = EXCLUDED.last_error,
    periods_loaded  = CASE WHEN $3::bool THEN EXCLUDED.periods_loaded ELSE s.periods_loaded END`

func (s *pgStore) RecordAttempt(ctx context.Context, a attempt) error {
	errText := a.Err
	if len(errText) > 1000 {
		errText = errText[:1000]
	}
	if _, err := s.pool.Exec(ctx, recordAttemptSQL, a.Code, a.At.UTC(), a.Success, errText, a.PeriodsLoaded); err != nil {
		return fmt.Errorf("record attempt %s: %w", a.Code, err)
	}
	return nil
}

// refreshSQL is ONE simple-protocol command on purpose (the reason
// shortdatasync's refreshAllSQL is one string): the timeout must be disarmed
// on the same backend that runs the refresh, and through a transaction pooler
// two separate Execs can land on two backends. Unlike that call it is SET LOCAL
// inside an explicit transaction, so the disarmed timeout dies with the
// transaction instead of staying on a pooled backend for the next client
// (scripts/prod-psql.sh, "WHY TRANSACTION-SCOPED"). The function's own
// `SET statement_timeout TO '0'` cannot disarm the timer the calling command
// armed (000095's measurement), hence the SET before the call.
//
// platform.Connect sets QueryExecModeSimpleProtocol, which is what makes a
// multi-statement Exec legal; do not split this into several calls.
const refreshSQL = `BEGIN; SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views(); COMMIT`

func (s *pgStore) RefreshStrategyViews(ctx context.Context) ([]string, error) {
	s.notices.reset()
	_, err := s.pool.Exec(ctx, refreshSQL)
	skipped := s.notices.skipped()
	if err != nil {
		return skipped, fmt.Errorf("refresh_strategy_views: %w", err)
	}
	return skipped, nil
}

// noticeLog captures server NOTICE/WARNING messages. refresh_strategy_views()
// reports a view it could not refresh as `WARNING: Skipping <view>: <reason>`
// and still returns normally, so without reading notices a refresh that
// refreshed nothing looks like success: the silent-staleness failure 000095
// was written about.
type noticeLog struct {
	mu   sync.Mutex
	msgs []*pgconn.Notice
	logf func(format string, args ...any)
}

func (n *noticeLog) handle(_ *pgconn.PgConn, notice *pgconn.Notice) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.msgs = append(n.msgs, notice)
	if n.logf != nil {
		n.logf("picks: postgres %s: %s", notice.Severity, notice.Message)
	}
}

func (n *noticeLog) reset() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.msgs = nil
}

// skipped returns the views named by `Skipping <view>: ...` warnings.
func (n *noticeLog) skipped() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, m := range n.msgs {
		if v, ok := skippedView(m); ok {
			out = append(out, v)
		}
	}
	return out
}

// skippedView parses the guard's skip warning. Only WARNING severity counts:
// the "Failed to refresh X concurrently ... Trying non-concurrent" warning is
// NOT a skip, because the fallback still refreshed the view.
func skippedView(m *pgconn.Notice) (string, bool) {
	if m == nil || !strings.EqualFold(m.Severity, "WARNING") || !strings.HasPrefix(m.Message, "Skipping ") {
		return "", false
	}
	rest := strings.TrimPrefix(m.Message, "Skipping ")
	if i := strings.Index(rest, ":"); i > 0 {
		return rest[:i], true
	}
	return rest, true
}
