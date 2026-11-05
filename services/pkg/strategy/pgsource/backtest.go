package pgsource

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// BacktestHistoryFrom is the first date a backtest reads. Every stored row is
// read from here: a run's windows, its two-pass universe and its short history
// all depend on rows the window's own start would cut off.
var BacktestHistoryFrom = civil.Date{Year: 2000, Month: time.January, Day: 1}

// BacktestIndexBenchmark is the index a backtest benchmarks against (XJT).
const BacktestIndexBenchmark = "XJT"

// BacktestWindowEnd is the newest session whose features phase completed:
// the last day the snapshot's stored rows describe. ok is false when no session
// has completed yet, or the strategy tables are absent.
func BacktestWindowEnd(ctx context.Context, db DB) (civil.Date, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	var t *time.Time
	err := db.QueryRow(ctx, `
		SELECT max(as_of) FROM strategy_daily_runs
		 WHERE phase = 'features' AND status = 'completed'`).Scan(&t)
	if isUndefinedTable(err) {
		logMissingRelationOnce("BacktestWindowEnd", err)
		return civil.Date{}, false, nil
	}
	if err != nil {
		return civil.Date{}, false, fmt.Errorf("read the window end: %w", err)
	}
	if t == nil {
		return civil.Date{}, false, nil
	}
	return civil.DateOf(*t), true, nil
}

// relationExists reports whether a relation is in the catalog. The backtest
// loader checks before each optional read instead of relying on the readers'
// 42P01 tolerance: inside its one transaction a failed statement aborts every
// read after it (SQLSTATE 25P02), so an older database would fail the whole
// batch rather than see an empty object. name is as it is written in SQL, quoted
// where it needs quotes.
func relationExists(ctx context.Context, db DB, name string) (bool, error) {
	var ok bool
	if err := db.QueryRow(ctx, `SELECT to_regclass($1::text) IS NOT NULL`, name).Scan(&ok); err != nil {
		return false, fmt.Errorf("look up %s: %w", name, err)
	}
	return ok, nil
}

// allRelationsExist reports whether every named relation exists.
func allRelationsExist(ctx context.Context, db DB, names ...string) (bool, error) {
	for _, n := range names {
		ok, err := relationExists(ctx, db, n)
		if err != nil || !ok {
			return false, err
		}
	}
	return true, nil
}

// BacktestStatements reads the statement periods the strict computable_from
// derivation reads, up to and including to: annual and half flow rows
// that carry a revenue or NPAT line, and quarter balance snapshots. A missing
// table is no statements, so the derivation reports not computable.
func BacktestStatements(ctx context.Context, db DB, to civil.Date) (map[string][]backtest.Statement, error) {
	ok, err := relationExists(ctx, db, "stock_fundamentals")
	if err != nil {
		return nil, err
	}
	if !ok {
		logMissingSchemaOnce("BacktestStatements", fmt.Errorf("stock_fundamentals is absent"))
		return map[string][]backtest.Statement{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT stock_code::text, period_type::text, period_end::date,
		       (revenue IS NOT NULL OR net_income IS NOT NULL) AS has_flow
		  FROM stock_fundamentals
		 WHERE period_end <= $1::date
		   AND period_type IN ('annual', 'half', 'quarter')
		 ORDER BY stock_code, period_end`, to.String())
	if err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce("BacktestStatements", err)
			return map[string][]backtest.Statement{}, nil
		}
		return nil, fmt.Errorf("read statement periods: %w", err)
	}
	defer rows.Close()
	out := map[string][]backtest.Statement{}
	for rows.Next() {
		var code, periodType string
		var end time.Time
		var hasFlow bool
		if err := rows.Scan(&code, &periodType, &end, &hasFlow); err != nil {
			return nil, fmt.Errorf("scan statement period: %w", err)
		}
		s := backtest.Statement{PeriodEnd: civil.DateOf(end)}
		switch periodType {
		case "annual":
			s.Span, s.Flow = 12, hasFlow
		case "half":
			s.Span, s.Flow = 6, hasFlow
		case "quarter":
			s.Span, s.Balance = 3, true
		}
		if !s.Flow && !s.Balance {
			continue
		}
		out[code] = append(out[code], s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read statement periods: %w", err)
	}
	return out, nil
}

// LoadBacktestInputs reads every row a backtest over the sessions up to to reads,
// into the in-memory form the pure package runs on. It issues only SELECTs, so
// a caller holding a REPEATABLE READ, READ ONLY transaction gets one snapshot
// for the whole load: db is then that transaction. Each reader keeps its
// own 10 second budget; a timeout is an error, never a shorter history.
func LoadBacktestInputs(ctx context.Context, db DB, to civil.Date) (*backtest.MemoryInputs, error) {
	from := BacktestHistoryFrom
	codes, err := BarCodes(ctx, db, from, to)
	if err != nil {
		return nil, fmt.Errorf("list the priced codes: %w", err)
	}
	m := &backtest.MemoryInputs{
		BarsByCode: make(map[string][]features.Bar, len(codes)),
	}
	for _, code := range codes {
		bars, err := Bars(ctx, db, code, from, to)
		if err != nil {
			return nil, fmt.Errorf("read the bars of %s: %w", code, err)
		}
		m.BarsByCode[code] = bars
	}
	xjo, err := IndexBars(ctx, db, "XJO", from, to)
	if err != nil {
		return nil, fmt.Errorf("read the XJO bars: %w", err)
	}
	xjt, err := IndexBars(ctx, db, BacktestIndexBenchmark, from, to)
	if err != nil {
		return nil, fmt.Errorf("read the XJT bars: %w", err)
	}
	asic, err := ASICRows(ctx, db, from, to)
	if err != nil {
		return nil, fmt.Errorf("read the short positions: %w", err)
	}
	ingests, err := ReportIngests(ctx, db, from, to)
	if err != nil {
		return nil, fmt.Errorf("read the report ingests: %w", err)
	}
	// The optional objects are checked first (see relationExists): a missing one
	// reads as empty, as the readers' own tolerance would have it.
	etp := map[string]bool{}
	if ok, err := relationExists(ctx, db, "ownership_funds"); err != nil {
		return nil, err
	} else if ok {
		if etp, err = ETPSet(ctx, db); err != nil {
			return nil, fmt.Errorf("read the ETP set: %w", err)
		}
	}
	names := map[string]string{}
	meta := map[string]CompanyMeta{}
	hasMeta, err := relationExists(ctx, db, `"company-metadata"`)
	if err != nil {
		return nil, err
	}
	if hasMeta {
		if names, err = CompanyNames(ctx, db); err != nil {
			return nil, fmt.Errorf("read the company names: %w", err)
		}
		if meta, err = Metadata(ctx, db); err != nil {
			return nil, fmt.Errorf("read the company metadata: %w", err)
		}
	}
	divs, err := Dividends(ctx, db, from)
	if err != nil {
		return nil, fmt.Errorf("read the dividends: %w", err)
	}
	var rates []features.RatePoint
	if ok, err := allRelationsExist(ctx, db, "economic_series", "economic_observations"); err != nil {
		return nil, err
	} else if ok {
		if rates, err = CashRate(ctx, db, to); err != nil {
			return nil, fmt.Errorf("read the cash rate: %w", err)
		}
	}
	funds := map[string]features.Fundamentals{}
	if ok, err := allRelationsExist(ctx, db, "mv_fundamentals_growth", "mv_fundamentals_quality", "stock_fundamentals_sync"); err != nil {
		return nil, err
	} else if ok {
		if funds, err = Fundamentals(ctx, db); err != nil {
			return nil, fmt.Errorf("read the fundamentals: %w", err)
		}
	}
	industry := make(map[string]string, len(meta))
	for code, cm := range meta {
		industry[code] = cm.Industry
	}
	m.Divs, m.Funds = divs, funds
	m.Mkt = backtest.Market{
		XJO: xjo, XJT: xjt, ASIC: asic, Ingests: ingests,
		ETPs: etp, Names: names, Industry: industry, CashRate: rates,
	}
	return m, nil
}
