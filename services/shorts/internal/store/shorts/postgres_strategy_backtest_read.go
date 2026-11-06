package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
)

// The read side of the backtest tables (000158) and the paper track (000159), served by
// the public and private backtest rpcs. Every read names the caller's key (strategy,
// rules hash, recipe hash) or a run id, and every run read is a canonical publish run:
// a variant's run carries a variant_id and is never selected here. A schema without the
// tables reads as absent (ErrStrategyBacktestSchema), so the API answers run_required,
// never an error.

// The Postgres store is the backtest reader.
var _ StrategyBacktestStore = (*postgresStore)(nil)

// ErrStrategyBacktestSchema is returned when a table or column a backtest read names is
// not migrated (SQLSTATE 42P01 or 42703).
var ErrStrategyBacktestSchema = errors.New("strategy backtest tables are not migrated")

// StrategyBacktestStore is the read side of the canonical backtests and the paper track.
// The Postgres store implements it; a store without it answers run_required.
type StrategyBacktestStore interface {
	// ReadPublishedBacktest is the published canonical run of a key under strict
	// fundamentals. found is false when the key has none.
	ReadPublishedBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (BacktestRunRow, bool, error)
	// ReadCanonicalBacktest is one succeeded canonical publish run by id. A variant's run
	// is not found.
	ReadCanonicalBacktest(ctx context.Context, runID int64) (BacktestRunRow, bool, error)
	// ReadNotComputableBacktest is the newest succeeded not-computable outcome of a key.
	ReadNotComputableBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (BacktestRunRow, bool, error)
	// ReadRunningBacktest reports a publish request of the key that is running, and when
	// it started.
	ReadRunningBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (time.Time, bool, error)
	// ReadBacktestSeries is a run's stored series document; nil when it has none.
	ReadBacktestSeries(ctx context.Context, runID int64) ([]byte, error)
	// ReadBacktestTrades is every trade of a run, in trade order.
	ReadBacktestTrades(ctx context.Context, runID int64) ([]BacktestTradeRow, error)
	// ReadPaperEquity is the paper track's daily equity of a key, oldest first.
	ReadPaperEquity(ctx context.Context, rulesHash, recipeHash string) ([]PaperEquityRow, error)
	// ReadPaperTrades is the paper track's trades of a key.
	ReadPaperTrades(ctx context.Context, rulesHash, recipeHash string) ([]PaperTradeRow, error)
	// ReadCashRate is the RBA cash rate series to the given session: the Sharpe ratio's
	// risk-free rate. Nil when the series is not loaded.
	ReadCashRate(ctx context.Context, to civil.Date) ([]features.RatePoint, error)
}

// BacktestRunRow is one succeeded canonical run as stored. The JSON documents are the
// job's own encoding (summary, metrics and diagnostics); the reader decodes them.
type BacktestRunRow struct {
	ID             int64
	RunKey         string
	Kind           string
	StrategyID     string
	RulesHash      string
	RecipeHash     string
	EngineVersion  string
	Published      bool
	WindowStart    string
	WindowEnd      string
	ComputableFrom string
	FiscalLabel    string
	Fundamentals   string
	InputHash      string
	OutputHash     string
	BuildRevision  string
	PricesThrough  string
	ASICThrough    string
	IndexThrough   string
	InSampleUntil  string
	FinishedAt     time.Time
	Summary        []byte
	Metrics        []byte
	Diagnostics    []byte
}

// BacktestTradeRow is one trade of a canonical run.
type BacktestTradeRow struct {
	Seq            int
	StockCode      string
	CompanyName    string
	SignalDate     string
	EntryDate      string
	EntryPrice     float64
	CapturedPivot  *float64
	EntryScore     float64
	ExitSignalDate string
	ExitDate       string
	ExitPrice      float64
	ExitReason     string
	SessionsHeld   int
	GrossReturnPct float64
	NetReturnPct   float64
	Flags          []string
	Open           bool
}

// PaperEquityRow is one recorded session of the paper track.
type PaperEquityRow struct {
	AsOf      string
	Equity    float64
	Cash      float64
	Positions int
	Benchmark *float64
}

// PaperTradeRow is one paper-track trade of a key. Status is one of the table's states.
type PaperTradeRow struct {
	StockCode  string
	SignalDate string
	EntryDate  string
	EntryPrice float64
	ExitDate   string
	ExitPrice  float64
	ExitReason string
	Status     string
}

// backtestSchemaMissing reports a read that names a table or column the migration has not
// created: the API reads that as absent.
func backtestSchemaMissing(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "42P01" || pgErr.Code == "42703")
}

// backtestRunColumns is the column list every run read selects, with the nullable columns
// coalesced so a not-computed field reads as "".
const backtestRunColumns = `r.id, COALESCE(r.run_key, ''), r.kind, r.strategy_id, r.rules_hash, r.recipe_hash,
	r.engine_version, r.published, r.window_start::text, COALESCE(r.window_end::text, ''),
	COALESCE(r.computable_from::text, ''), COALESCE(r.fiscal_label, ''), r.fundamentals,
	COALESCE(r.input_hash, ''), COALESCE(r.output_hash, ''), COALESCE(r.build_revision, ''),
	COALESCE(r.prices_through::text, ''), COALESCE(r.asic_report_through::text, ''),
	COALESCE(r.index_through::text, ''), COALESCE(r.in_sample_until::text, ''),
	COALESCE(r.finished_at, r.started_at), COALESCE(r.summary::text, '{}'),
	COALESCE(r.metrics::text, '{}'), COALESCE(r.diagnostics::text, '{}')`

// scanBacktestRun scans one row selected with backtestRunColumns.
func scanBacktestRun(row pgx.Row) (BacktestRunRow, error) {
	var (
		r                             BacktestRunRow
		summary, metrics, diagnostics string
	)
	err := row.Scan(&r.ID, &r.RunKey, &r.Kind, &r.StrategyID, &r.RulesHash, &r.RecipeHash,
		&r.EngineVersion, &r.Published, &r.WindowStart, &r.WindowEnd,
		&r.ComputableFrom, &r.FiscalLabel, &r.Fundamentals,
		&r.InputHash, &r.OutputHash, &r.BuildRevision,
		&r.PricesThrough, &r.ASICThrough, &r.IndexThrough, &r.InSampleUntil,
		&r.FinishedAt, &summary, &metrics, &diagnostics)
	if err != nil {
		return BacktestRunRow{}, err
	}
	r.Summary, r.Metrics, r.Diagnostics = []byte(summary), []byte(metrics), []byte(diagnostics)
	return r, nil
}

// queryBacktestRun reads at most one run for a WHERE clause. found is false for no row;
// a missing schema reads as found=false too.
func (s *postgresStore) queryBacktestRun(ctx context.Context, where string, args ...any) (BacktestRunRow, bool, error) {
	row := s.db.QueryRow(ctx, `SELECT `+backtestRunColumns+` FROM strategy_backtest_runs r `+where+` LIMIT 1`, args...)
	out, err := scanBacktestRun(row)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return BacktestRunRow{}, false, nil
	case backtestSchemaMissing(err):
		return BacktestRunRow{}, false, ErrStrategyBacktestSchema
	case err != nil:
		return BacktestRunRow{}, false, fmt.Errorf("read a backtest run: %w", err)
	}
	return out, true, nil
}

// ReadPublishedBacktest is the key's published run under strict fundamentals.
func (s *postgresStore) ReadPublishedBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (BacktestRunRow, bool, error) {
	return s.queryBacktestRun(ctx, `
		WHERE r.strategy_id = $1 AND r.rules_hash = $2 AND r.recipe_hash = $3
		  AND r.fundamentals = 'strict' AND r.published
		  AND r.kind = 'publish' AND r.status = 'succeeded' AND r.variant_id IS NULL
		ORDER BY r.id DESC`, strategyID, rulesHash, recipeHash)
}

// ReadCanonicalBacktest is one canonical publish run by id.
func (s *postgresStore) ReadCanonicalBacktest(ctx context.Context, runID int64) (BacktestRunRow, bool, error) {
	return s.queryBacktestRun(ctx, `
		WHERE r.id = $1 AND r.kind = 'publish' AND r.status = 'succeeded' AND r.variant_id IS NULL`, runID)
}

// ReadNotComputableBacktest is the newest not-computable outcome of the key under strict
// fundamentals.
func (s *postgresStore) ReadNotComputableBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (BacktestRunRow, bool, error) {
	return s.queryBacktestRun(ctx, `
		WHERE r.strategy_id = $1 AND r.rules_hash = $2 AND r.recipe_hash = $3
		  AND r.fundamentals = 'strict' AND r.kind = 'publish' AND r.status = 'succeeded'
		  AND r.variant_id IS NULL AND r.summary->>'state' = 'not_computable'
		ORDER BY r.id DESC`, strategyID, rulesHash, recipeHash)
}

// ReadRunningBacktest is a running publish request of the key, when one is running.
func (s *postgresStore) ReadRunningBacktest(ctx context.Context, strategyID, rulesHash, recipeHash string) (time.Time, bool, error) {
	var started time.Time
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(started_at, requested_at) FROM strategy_backtest_requests
		 WHERE kind = 'publish' AND status = 'running' AND strategy_id = $1
		   AND rules_hash = $2 AND recipe_hash = $3
		 ORDER BY id DESC LIMIT 1`, strategyID, rulesHash, recipeHash).Scan(&started)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return time.Time{}, false, nil
	case backtestSchemaMissing(err):
		return time.Time{}, false, ErrStrategyBacktestSchema
	case err != nil:
		return time.Time{}, false, fmt.Errorf("read the running backtest request: %w", err)
	}
	return started, true, nil
}

// ReadBacktestSeries is a run's series document as stored.
func (s *postgresStore) ReadBacktestSeries(ctx context.Context, runID int64) ([]byte, error) {
	var raw string
	err := s.db.QueryRow(ctx, `SELECT points::text FROM strategy_backtest_series WHERE run_id = $1`, runID).Scan(&raw)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case backtestSchemaMissing(err):
		return nil, ErrStrategyBacktestSchema
	case err != nil:
		return nil, fmt.Errorf("read a backtest series: %w", err)
	}
	return []byte(raw), nil
}

// ReadBacktestTrades is every trade of a run, with the company name where it is known.
func (s *postgresStore) ReadBacktestTrades(ctx context.Context, runID int64) ([]BacktestTradeRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT t.seq, t.stock_code, COALESCE(m.company_name, ''), t.signal_date::text,
		       COALESCE(t.entry_date::text, ''), COALESCE(t.entry_price, 0), t.captured_pivot,
		       COALESCE(t.entry_score::float8, 0), COALESCE(t.exit_signal_date::text, ''),
		       COALESCE(t.exit_date::text, ''), COALESCE(t.exit_price, 0), COALESCE(t.exit_reason, ''),
		       COALESCE(t.sessions_held, 0), COALESCE(t.gross_return_pct, 0), COALESCE(t.net_return_pct, 0),
		       t.flags, t.open
		  FROM strategy_backtest_trades t
		  LEFT JOIN "company-metadata" m ON m.stock_code = t.stock_code
		 WHERE t.run_id = $1
		 ORDER BY t.seq`, runID)
	if err != nil {
		if backtestSchemaMissing(err) {
			return nil, ErrStrategyBacktestSchema
		}
		return nil, fmt.Errorf("read backtest trades: %w", err)
	}
	defer rows.Close()
	var out []BacktestTradeRow
	for rows.Next() {
		var r BacktestTradeRow
		if err := rows.Scan(&r.Seq, &r.StockCode, &r.CompanyName, &r.SignalDate, &r.EntryDate, &r.EntryPrice,
			&r.CapturedPivot, &r.EntryScore, &r.ExitSignalDate, &r.ExitDate, &r.ExitPrice, &r.ExitReason,
			&r.SessionsHeld, &r.GrossReturnPct, &r.NetReturnPct, &r.Flags, &r.Open); err != nil {
			return nil, fmt.Errorf("scan a backtest trade: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read backtest trades: %w", err)
	}
	return out, nil
}

// ReadPaperEquity is the paper track's recorded equity of a key, oldest first.
func (s *postgresStore) ReadPaperEquity(ctx context.Context, rulesHash, recipeHash string) ([]PaperEquityRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT as_of::text, equity, cash, positions, benchmark
		  FROM strategy_paper_equity
		 WHERE rules_hash = $1 AND recipe_hash = $2
		 ORDER BY as_of`, rulesHash, recipeHash)
	if err != nil {
		if backtestSchemaMissing(err) {
			return nil, ErrStrategyBacktestSchema
		}
		return nil, fmt.Errorf("read the paper equity: %w", err)
	}
	defer rows.Close()
	var out []PaperEquityRow
	for rows.Next() {
		var (
			r   PaperEquityRow
			pos int16
		)
		if err := rows.Scan(&r.AsOf, &r.Equity, &r.Cash, &pos, &r.Benchmark); err != nil {
			return nil, fmt.Errorf("scan the paper equity: %w", err)
		}
		r.Positions = int(pos)
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReadPaperTrades is the paper track's trades of a key.
func (s *postgresStore) ReadPaperTrades(ctx context.Context, rulesHash, recipeHash string) ([]PaperTradeRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT stock_code, signal_date::text, COALESCE(entry_date::text, ''), COALESCE(entry_price, 0),
		       COALESCE(exit_date::text, ''), COALESCE(exit_price, 0), COALESCE(exit_reason, ''), status
		  FROM strategy_paper_trades
		 WHERE rules_hash = $1 AND recipe_hash = $2
		 ORDER BY signal_date, stock_code`, rulesHash, recipeHash)
	if err != nil {
		if backtestSchemaMissing(err) {
			return nil, ErrStrategyBacktestSchema
		}
		return nil, fmt.Errorf("read the paper trades: %w", err)
	}
	defer rows.Close()
	var out []PaperTradeRow
	for rows.Next() {
		var r PaperTradeRow
		if err := rows.Scan(&r.StockCode, &r.SignalDate, &r.EntryDate, &r.EntryPrice, &r.ExitDate,
			&r.ExitPrice, &r.ExitReason, &r.Status); err != nil {
			return nil, fmt.Errorf("scan a paper trade: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReadCashRate is the RBA cash rate to the session, through the strategy source's reader.
func (s *postgresStore) ReadCashRate(ctx context.Context, to civil.Date) ([]features.RatePoint, error) {
	return pgsource.CashRate(ctx, s.db, to)
}
