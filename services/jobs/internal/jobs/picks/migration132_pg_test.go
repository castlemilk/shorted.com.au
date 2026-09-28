package picks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Migration 000132 (docs/plans/fundamentals-coverage.md §2) against a real
// Postgres. Skipped unless PICKS_TEST_DATABASE_URL names a LOCAL database:
//
//	PICKS_TEST_DATABASE_URL=postgres://postgres@localhost:5499/picks \
//	  GOWORK=off go test ./internal/jobs/picks/ -run Migration132 -v
//
// Every test builds its own schema (m132_<nanos>) from the migration files the
// picker views need (000002, 000045, 000117, 000129, 000130, 000131), applies
// 000132 there and drops the schema afterwards, so it never touches public.
// The main test may also create two NOLOGIN roles (to prove the rebuilt growth
// view keeps its owner and grants); without CREATEROLE that part is skipped.

var m132Base = []string{
	"000002_stock_prices.up.sql",
	"000045_formalize_financial_report_extractions.up.sql",
	"000117_add_index_prices.up.sql",
	"000129_add_stock_fundamentals.up.sql",
	"000130_add_price_features.up.sql",
	"000131_widen_stock_price_precision.up.sql",
}

// The files the deploy allowlist replays before 000132, then 000132.
var m132Replay = []string{
	"000129_add_stock_fundamentals.up.sql",
	"000130_add_price_features.up.sql",
	"000131_widen_stock_price_precision.up.sql",
	m132Up,
}

const (
	m132Up   = "000132_extend_fundamentals.up.sql"
	m132Down = "000132_extend_fundamentals.down.sql"
	m132Fil  = "asx-filing-extraction"
)

// The growth view's appended columns, in order (plan §2.6), and the quality
// view's full column list (plan §2.7).
var (
	m132GrowthAppended = []m132Col{
		{"revenue_basis_source", "character varying(8)"},
		{"eps_basis_source", "character varying(8)"},
		{"revenue_latest_period_end", "date"},
		{"revenue_prior_period_end", "date"},
	}
	m132QualityColumns = []string{
		"stock_code", "basis_period_type", "basis_period_end", "currency", "source", "fetched_at",
		"revenue", "gross_profit", "operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income",
		"operating_cash_flow", "operating_cash_flow_derived", "free_cash_flow", "capital_expenditure",
		"dividends_paid", "interest_expense", "shares_outstanding", "balance_period_end", "balance_period_type",
		"balance_currency", "balance_lag_months", "total_assets", "total_assets_prior", "total_liabilities",
		"total_equity", "total_equity_prior", "cash_and_equivalents", "total_debt", "capital_lease_obligations",
		"net_debt", "current_assets", "current_liabilities", "gross_margin_pct", "operating_margin_pct",
		"net_margin_pct", "fcf_margin_pct", "fcf_conversion", "roe_pct", "roa_pct", "net_debt_to_ebitda",
		"net_debt_to_equity", "current_ratio", "interest_cover", "payout_ratio_pct", "statement_is_financial",
	}
)

type m132Col struct{ name, typ string }

// m132DB is one throwaway schema and a pool pinned to it.
type m132DB struct {
	t      *testing.T
	schema string
	pool   *pgxpool.Pool

	mu      sync.Mutex
	notices []string
}

func m132DSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PICKS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PICKS_TEST_DATABASE_URL not set (a local database, never prod)")
	}
	low := strings.ToLower(dsn)
	if strings.Contains(low, "supabase") || strings.Contains(low, "pooler") || strings.Contains(low, ":6543") {
		t.Fatalf("PICKS_TEST_DATABASE_URL points at a hosted database or a pooler; this test creates and drops schemas")
	}
	return dsn
}

// m132MigrationsDir is services/migrations.
func m132MigrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "migrations")
}

func m132NewDB(t *testing.T, files ...string) *m132DB {
	t.Helper()
	dsn := m132DSN(t)
	ctx := context.Background()

	admin, err := pgx.Connect(ctx, dsn)
	require.NoError(t, err)
	schema := fmt.Sprintf("m132_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, `CREATE SCHEMA `+schema)
	require.NoError(t, err)
	require.NoError(t, admin.Close(ctx))

	d := &m132DB{t: t, schema: schema}
	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	// As the job and the deploy's psql: the simple protocol, so a whole
	// migration file (two BEGIN ... COMMIT blocks) is one Exec.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 6
	cfg.ConnConfig.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.notices = append(d.notices, n.Severity+": "+n.Message)
	}
	d.pool, err = pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(func() {
		d.pool.Close()
		c, err := pgx.Connect(context.Background(), dsn)
		if err != nil {
			t.Logf("cleanup: %v", err)
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		if _, err := c.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Logf("cleanup: drop schema %s: %v", schema, err)
		}
	})
	for _, f := range files {
		d.mustApply(f)
	}
	return d
}

func (d *m132DB) apply(file string) error {
	body, err := os.ReadFile(filepath.Join(m132MigrationsDir(), file))
	if err != nil {
		return err
	}
	_, err = d.pool.Exec(context.Background(), string(body))
	return err
}

func (d *m132DB) mustApply(file string) {
	d.t.Helper()
	require.NoError(d.t, d.apply(file), "apply %s", file)
}

func (d *m132DB) exec(sql string, args ...any) {
	d.t.Helper()
	_, err := d.pool.Exec(context.Background(), sql, args...)
	require.NoError(d.t, err, sql)
}

func (d *m132DB) scalar(dst any, sql string, args ...any) {
	d.t.Helper()
	require.NoError(d.t, d.pool.QueryRow(context.Background(), sql, args...).Scan(dst), sql)
}

func (d *m132DB) oid(rel string) uint32 {
	d.t.Helper()
	var oid uint32
	d.scalar(&oid, `SELECT $1::regclass::oid`, rel)
	return oid
}

// columns lists a relation's columns and their types, in order.
func (d *m132DB) columns(rel string) []m132Col {
	d.t.Helper()
	rows, err := d.pool.Query(context.Background(), `
		SELECT attname, format_type(atttypid, atttypmod) FROM pg_attribute
		WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, rel)
	require.NoError(d.t, err)
	var out []m132Col
	for rows.Next() {
		var c m132Col
		require.NoError(d.t, rows.Scan(&c.name, &c.typ))
		out = append(out, c)
	}
	require.NoError(d.t, rows.Err())
	return out
}

func (d *m132DB) takeNotices() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.notices
	d.notices = nil
	return out
}

// refresh runs the job's refresh and fails on any 'Skipping' warning (the job
// treats one as a failed run).
func (d *m132DB) refresh() {
	d.t.Helper()
	d.takeNotices()
	d.exec(`SELECT refresh_strategy_views()`)
	for _, n := range d.takeNotices() {
		assert.NotContains(d.t, n, "Skipping", "refresh_strategy_views skipped a view")
		assert.NotContains(d.t, n, "Failed to refresh", "a concurrent refresh fell back")
	}
}

// seed writes one stock_fundamentals row. vals maps column -> value; the
// special key "field_sources" takes a JSON object literal.
func (d *m132DB) seed(code, periodType, end, currency, source string, vals map[string]any) {
	d.t.Helper()
	cols := []string{"stock_code", "period_type", "period_end", "currency", "source"}
	exprs := []string{"$1", "$2", "$3::date", "$4", "$5"}
	args := []any{code, periodType, end, currency, source}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, vals[k])
		cols = append(cols, k)
		expr := fmt.Sprintf("$%d", len(args))
		if k == "field_sources" {
			expr += "::jsonb"
		}
		exprs = append(exprs, expr)
	}
	d.exec(fmt.Sprintf(`INSERT INTO stock_fundamentals (%s) VALUES (%s)`,
		strings.Join(cols, ", "), strings.Join(exprs, ", ")), args...)
}

// row returns a view's row for code as JSON-decoded values (dates as
// "YYYY-MM-DD", numbers as float64, NULL as nil); nil when there is no row.
func (d *m132DB) row(view, code string) map[string]any {
	d.t.Helper()
	var raw []byte
	err := d.pool.QueryRow(context.Background(),
		fmt.Sprintf(`SELECT row_to_json(v)::text FROM %s v WHERE v.stock_code = $1`, view), code).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	require.NoError(d.t, err)
	var out map[string]any
	require.NoError(d.t, json.Unmarshal(raw, &out))
	return out
}

func m132Num(t *testing.T, row map[string]any, key string) float64 {
	t.Helper()
	require.NotNil(t, row, "no row")
	v, ok := row[key].(float64)
	require.True(t, ok, "%s = %v, want a number", key, row[key])
	return v
}

func m132SQLState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func TestMigration132AgainstPostgres(t *testing.T) {
	db := m132NewDB(t, m132Base...)
	ctx := context.Background()

	growth129 := db.columns("mv_fundamentals_growth")
	require.NotEmpty(t, growth129)
	oid129 := db.oid("mv_fundamentals_growth")

	// A row written before 000132 must survive it and pass the v2 CHECK.
	db.seed("OLD", "annual", "2025-06-30", "AUD", "yahoo-timeseries", map[string]any{"revenue": 10e6, "net_income": 1e6})
	// LEG: a miner exactly as the old image stored it (000129's seven lines,
	// every prod row at deploy). Its flow row has no operating income or
	// EBITDA only because those columns did not exist when it was written.
	for _, r := range []struct {
		typ, end string
		rev, ni  float64
	}{
		{"annual", "2025-06-30", 55658e6, 9019e6},
		{"annual", "2024-06-30", 55658e6, 7897e6},
		{"ttm", "2025-12-31", 53000e6, 9500e6},
	} {
		db.seed("LEG", r.typ, r.end, "USD", "yahoo-timeseries", map[string]any{
			"revenue": r.rev, "net_income": r.ni, "eps_basic": 1.78, "eps_diluted": 1.77,
			"operating_cash_flow": 18665e6, "free_cash_flow": 9000e6, "shares_outstanding": 5070e6,
		})
	}

	// Owner, storage options and grants of the dropped growth view are carried
	// to the rebuilt one; a default-privilege grant the old view never had is
	// revoked from it. Needs CREATEROLE; skipped (logged) without it.
	suffix := strings.TrimPrefix(db.schema, "m132_")
	owner, defaults := "m132_owner_"+suffix, "m132_default_"+suffix
	rolesOK := true
	for _, role := range []string{owner, defaults} {
		if _, err := db.pool.Exec(ctx, `CREATE ROLE `+role+` NOLOGIN`); err != nil {
			t.Logf("cannot create roles (%v); skipping the owner / grant carry checks", err)
			rolesOK = false
			break
		}
		role := role
		t.Cleanup(func() {
			c, err := pgx.Connect(context.Background(), m132DSN(t))
			if err != nil {
				return
			}
			defer func() { _ = c.Close(context.Background()) }()
			_, _ = c.Exec(context.Background(), `DROP OWNED BY `+role)
			_, _ = c.Exec(context.Background(), `DROP ROLE IF EXISTS `+role)
		})
	}
	if rolesOK {
		db.exec(`GRANT USAGE ON SCHEMA ` + db.schema + ` TO ` + owner)
		db.exec(`GRANT SELECT ON stock_fundamentals TO ` + owner) // REFRESH runs the query as the owner
		db.exec(`ALTER MATERIALIZED VIEW mv_fundamentals_growth SET (fillfactor = 90)`)
		db.exec(`ALTER MATERIALIZED VIEW mv_fundamentals_growth OWNER TO ` + owner)
		db.exec(`GRANT SELECT ON mv_fundamentals_growth TO PUBLIC`)
		db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ` + db.schema + ` GRANT SELECT ON TABLES TO ` + defaults)
	}

	db.mustApply(m132Up)

	t.Run("schema", func(t *testing.T) {
		growth := db.columns("mv_fundamentals_growth")
		require.Len(t, growth, len(growth129)+len(m132GrowthAppended))
		assert.Equal(t, growth129, growth[:len(growth129)], "every 000129 column keeps its name, type and position")
		assert.Equal(t, m132GrowthAppended, growth[len(growth129):], "the four appended columns, in order")
		assert.Equal(t, "revenue_prior_period_end", growth[len(growth)-1].name, "the rebuild guard key is the last column")
		assert.NotEqual(t, oid129, db.oid("mv_fundamentals_growth"), "the growth view was rebuilt")

		var names []string
		for _, c := range db.columns("mv_fundamentals_quality") {
			names = append(names, c.name)
		}
		assert.Equal(t, m132QualityColumns, names)

		for _, idx := range []string{"idx_mv_fundamentals_growth_stock_code", "idx_mv_fundamentals_quality_stock_code"} {
			var unique bool
			db.scalar(&unique, `SELECT i.indisunique FROM pg_index i WHERE i.indexrelid = $1::regclass`, idx)
			assert.True(t, unique, "%s must be unique (REFRESH ... CONCURRENTLY needs it)", idx)
		}

		var validated bool
		db.scalar(&validated, `SELECT convalidated FROM pg_constraint
			WHERE conrelid = 'stock_fundamentals'::regclass AND conname = 'stock_fundamentals_finite_check_v2'`)
		assert.True(t, validated)
		_, err := db.pool.Exec(ctx, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, source, total_debt)
			VALUES ('BAD', 'annual', '2025-06-30', 'yahoo-timeseries', 'NaN')`)
		assert.Equal(t, "23514", m132SQLState(err), "the v2 CHECK refuses NaN in a new column")
		_, err = db.pool.Exec(ctx, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, source, capital_expenditure)
			VALUES ('BAD', 'annual', '2025-06-30', 'yahoo-timeseries', 1e-300)`)
		assert.Equal(t, "23514", m132SQLState(err), "the v2 CHECK refuses denormal-scale values")

		var fieldSources string
		db.scalar(&fieldSources, `SELECT field_sources::text FROM stock_fundamentals WHERE stock_code = 'OLD'`)
		assert.Equal(t, "{}", fieldSources, "existing rows read an empty provenance map")

		for _, c := range []struct{ tbl, col, typ string }{
			{"stock_fundamentals_sync", "last_outcome", "character varying(16)"},
			{"stock_fundamentals_sync", "consecutive_empty", "smallint"},
			{"stock_fundamentals_sync", "median_k", "double precision"},
			{"stock_fundamentals_sync", "fx_converted", "boolean"},
			{"stock_fundamentals_sync", "native_currency", "character varying(8)"},
			{"financial_report_extractions", "document_meta", "jsonb"},
			{"stock_fundamentals", "source_document_url", "text"},
			{"stock_fundamentals", "source_document_date", "date"},
			{"stock_fundamentals", "field_sources", "jsonb"},
		} {
			var typ string
			db.scalar(&typ, `SELECT format_type(atttypid, atttypmod) FROM pg_attribute
				WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`, c.tbl, c.col)
			assert.Equal(t, c.typ, typ, "%s.%s", c.tbl, c.col)
		}
		db.exec(`INSERT INTO stock_fundamentals_sync (stock_code) VALUES ('SYN')`)
		var empties int
		db.scalar(&empties, `SELECT consecutive_empty FROM stock_fundamentals_sync WHERE stock_code = 'SYN'`)
		assert.Zero(t, empties)
		db.exec(`INSERT INTO picks_run_lease (name, holder, expires_at) VALUES ('picks', 'exec-1', now() + interval '4 hours')`)

		var body string
		var config []string
		db.scalar(&body, `SELECT prosrc FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
		db.scalar(&config, `SELECT proconfig FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
		order := []string{"mv_market_regime", "mv_fundamentals_growth", "mv_fundamentals_quality", "mv_price_features"}
		last := -1
		for _, mv := range order {
			at := strings.Index(body, "REFRESH MATERIALIZED VIEW CONCURRENTLY "+mv+";")
			require.Greater(t, at, last, "%s is refreshed after the view before it", mv)
			last = at
		}
		assert.Contains(t, config, "statement_timeout=0")

		if rolesOK {
			var gotOwner string
			var opts []string
			db.scalar(&gotOwner, `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'mv_fundamentals_growth'::regclass`)
			db.scalar(&opts, `SELECT reloptions FROM pg_class WHERE oid = 'mv_fundamentals_growth'::regclass`)
			assert.Equal(t, owner, gotOwner, "the owner is carried")
			assert.Equal(t, []string{"fillfactor=90"}, opts, "storage options are carried")
			// Read the ACL itself: PUBLIC's SELECT would make has_table_privilege
			// true for every role.
			granted := `SELECT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
				WHERE c.oid = $1::regclass AND a.grantee = $2 AND a.privilege_type = 'SELECT')`
			var defaultsOID uint32
			db.scalar(&defaultsOID, `SELECT $1::regrole::oid`, defaults)
			var publicSelect, defaultOnGrowth, defaultOnQuality bool
			db.scalar(&publicSelect, granted, "mv_fundamentals_growth", uint32(0))
			db.scalar(&defaultOnGrowth, granted, "mv_fundamentals_growth", defaultsOID)
			db.scalar(&defaultOnQuality, granted, "mv_fundamentals_quality", defaultsOID)
			assert.True(t, publicSelect, "the old view's grants are granted again")
			assert.False(t, defaultOnGrowth, "a default-privilege grant the old view did not have is revoked")
			assert.True(t, defaultOnQuality, "a NEW view gets default privileges like any other")
		}
	})

	t.Run("replays are no-ops", func(t *testing.T) {
		growthOID, qualityOID := db.oid("mv_fundamentals_growth"), db.oid("mv_fundamentals_quality")
		var note string
		db.scalar(&note, `SELECT obj_description('mv_fundamentals_growth'::regclass, 'pg_class')`)
		for i := 0; i < 2; i++ {
			for _, f := range m132Replay {
				db.mustApply(f)
			}
			assert.Equal(t, growthOID, db.oid("mv_fundamentals_growth"), "replay %d rebuilt the growth view", i+1)
			assert.Equal(t, qualityOID, db.oid("mv_fundamentals_quality"), "replay %d rebuilt the quality view", i+1)
			var body, got string
			db.scalar(&body, `SELECT prosrc FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
			assert.Contains(t, body, "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_fundamentals_quality;",
				"000132 re-issues the four-view function after 000130's replay")
			db.scalar(&got, `SELECT obj_description('mv_fundamentals_growth'::regclass, 'pg_class')`)
			assert.Equal(t, note, got, "000132 writes back the COMMENT 000129's replay rewrites")
		}
	})

	// --------------------------------------------------------------------
	// Seeds (whole currency units), then one refresh.
	y := "yahoo-timeseries"

	// FMG FY24: TotalDebt 5,400, leases 815, cash 4,903, NetDebt absent.
	db.seed("FMG", "annual", "2024-06-30", "USD", y, map[string]any{
		"revenue": 18220e6, "net_income": 5683e6, "pretax_income": 8100e6,
		"operating_income": 8000e6, "ebitda": 9520e6, "normalized_ebitda": 9500e6,
		"total_debt": 5400e6, "capital_lease_obligations": 815e6, "cash_and_equivalents": 4903e6,
		"total_equity": 19460e6, "total_assets": 30546e6,
	})
	db.seed("FMG", "annual", "2023-06-30", "USD", y, map[string]any{
		"revenue": 16870e6, "net_income": 4800e6, "total_equity": 17990e6, "total_assets": 29000e6,
	})

	// LOV: TTM flow, the only balance rows two years older.
	db.seed("LOV", "ttm", "2025-12-31", "AUD", y, map[string]any{"revenue": 800e6, "net_income": 80e6})
	db.seed("LOV", "annual", "2023-06-30", "AUD", y, map[string]any{
		"revenue": 700e6, "net_income": 70e6, "total_equity": 300e6, "total_assets": 600e6,
	})
	db.seed("LOV", "annual", "2022-06-30", "AUD", y, map[string]any{
		"revenue": 650e6, "net_income": 60e6, "total_equity": 280e6, "total_assets": 550e6,
	})

	// HBR: filing halves fresher than the vendor annuals (the half basis).
	db.seed("HBR", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 200e6, "net_income": 20e6, "eps_diluted": 0.10})
	db.seed("HBR", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 180e6, "net_income": 18e6, "eps_diluted": 0.09})
	db.seed("HBR", "half", "2025-12-31", "AUD", m132Fil, map[string]any{"revenue": 110e6, "eps_basic": 0.06})
	db.seed("HBR", "half", "2024-12-31", "AUD", m132Fil, map[string]any{"revenue": 100e6, "eps_basic": 0.05})

	// TTF: a TTM revenue point newer than the annual, with a TTM comparator.
	db.seed("TTF", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 100e6, "net_income": 9e6})
	db.seed("TTF", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 90e6, "net_income": 8e6})
	db.seed("TTF", "ttm", "2025-12-31", "AUD", y, map[string]any{"revenue": 120e6, "net_income": 12e6})
	db.seed("TTF", "ttm", "2024-12-31", "AUD", y, map[string]any{"revenue": 100e6})
	db.seed("TTF", "ttm", "2023-12-31", "AUD", y, map[string]any{"revenue": 80e6})
	db.seed("TTF", "quarter", "2025-12-31", "AUD", y, map[string]any{"total_equity": 60e6, "total_assets": 120e6, "shares_outstanding": 1e8})
	db.seed("TTF", "quarter", "2024-12-31", "AUD", y, map[string]any{"total_equity": 50e6, "total_assets": 110e6})

	// TTA: the annual row lags a year; the TTM at FYE uses the annual comparator.
	db.seed("TTA", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 50e6})
	db.seed("TTA", "annual", "2023-06-30", "AUD", y, map[string]any{"revenue": 40e6})
	db.seed("TTA", "ttm", "2025-06-30", "AUD", y, map[string]any{"revenue": 60e6})

	// TTN: a newer TTM point with no comparator keeps the annual basis.
	db.seed("TTN", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 200e6})
	db.seed("TTN", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 180e6})
	db.seed("TTN", "ttm", "2025-12-31", "AUD", y, map[string]any{"revenue": 220e6})

	// FIL1: the current annual row is a filing's, the prior the vendor's.
	db.seed("FIL1", "annual", "2025-06-30", "AUD", m132Fil, map[string]any{"revenue": 110e6, "eps_diluted": 0.11})
	db.seed("FIL1", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 100e6, "eps_diluted": 0.10})
	// FIL2: vendor rows whose used fields were filled from filings.
	db.seed("FIL2", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 110e6, "field_sources": `{"revenue": "asx-filing-extraction"}`})
	db.seed("FIL2", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 100e6})
	db.seed("FIL2", "ttm", "2025-12-31", "AUD", y, map[string]any{"eps_diluted": 0.5, "field_sources": `{"eps_diluted": "asx-filing-extraction"}`})
	db.seed("FIL2", "ttm", "2024-12-31", "AUD", y, map[string]any{"eps_diluted": 0.4})
	// FIL3: a filing-filled field the basis does not use stays 'vendor'.
	db.seed("FIL3", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 110e6, "net_income": 10e6, "field_sources": `{"net_income": "asx-filing-extraction"}`})
	db.seed("FIL3", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 100e6, "eps_diluted": 0.1})

	// NEG: negative equity at both points.
	db.seed("NEG", "annual", "2025-06-30", "AUD", y, map[string]any{
		"revenue": 500e6, "net_income": 20e6, "total_equity": -50e6, "total_assets": 400e6,
		"total_debt": 300e6, "capital_lease_obligations": 20e6, "cash_and_equivalents": 30e6,
	})
	db.seed("NEG", "annual", "2024-06-30", "AUD", y, map[string]any{
		"revenue": 480e6, "net_income": 15e6, "total_equity": -40e6, "total_assets": 380e6,
	})

	// CUR: USD statements with an AUD balance snapshot and an AUD prior year.
	db.seed("CUR", "annual", "2025-06-30", "USD", y, map[string]any{"revenue": 1000e6, "net_income": 100e6})
	db.seed("CUR", "quarter", "2025-06-30", "AUD", y, map[string]any{"total_equity": 800e6, "total_assets": 1500e6})
	db.seed("CUR", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 900e6, "net_income": 90e6})

	// QUAL: every line, to pin each definition. A thinner TTM row on the same
	// date loses the flow basis to the annual row.
	db.seed("QUAL", "annual", "2025-06-30", "USD", y, map[string]any{
		"revenue": 50000e6, "gross_profit": 20000e6, "operating_income": 15000e6, "ebitda": 25000e6,
		"normalized_ebitda": 24000e6, "ebit": 16000e6, "pretax_income": 13000e6, "net_income": 9000e6, "operating_cash_flow": 18000e6,
		"free_cash_flow": 9000e6, "capital_expenditure": -9000e6, "dividends_paid": -4500e6,
		"interest_expense": 1000e6, "shares_outstanding": 5000e6,
		"total_assets": 100000e6, "total_liabilities": 50000e6, "total_equity": 50000e6,
		"cash_and_equivalents": 10000e6, "total_debt": 20000e6, "capital_lease_obligations": 2000e6,
		"net_debt": 7500e6, "current_assets": 30000e6, "current_liabilities": 20000e6,
		"field_sources": `{"operating_cash_flow": "derived:fcf-minus-capex"}`,
	})
	db.seed("QUAL", "ttm", "2025-06-30", "USD", y, map[string]any{"revenue": 50000e6, "net_income": 9000e6})
	db.seed("QUAL", "annual", "2024-06-30", "USD", y, map[string]any{
		"revenue": 45000e6, "net_income": 8000e6, "total_assets": 90000e6, "total_equity": 46000e6,
	})

	// LAG6: TTM flow at the half, balance from the annual six months earlier.
	db.seed("LAG6", "ttm", "2025-12-31", "AUD", y, map[string]any{"revenue": 300e6, "net_income": 30e6, "dividends_paid": 5e6})
	db.seed("LAG6", "annual", "2025-06-30", "AUD", y, map[string]any{"revenue": 280e6, "net_income": 25e6, "total_equity": 200e6, "total_assets": 400e6})
	db.seed("LAG6", "annual", "2024-06-30", "AUD", y, map[string]any{"revenue": 260e6, "net_income": -5e6, "total_equity": 180e6, "total_assets": 380e6})

	// BANK: a full Yahoo statement (pretax income) with no operating income or
	// EBITDA, equity 6% of assets.
	db.seed("BANK", "annual", "2025-06-30", "AUD", y, map[string]any{
		"revenue": 27000e6, "net_income": 10000e6, "pretax_income": 14300e6, "net_interest_income": 23000e6,
		"total_assets": 1300000e6, "total_equity": 78000e6, "total_debt": 900000e6,
	})
	db.seed("BANK", "annual", "2024-06-30", "AUD", y, map[string]any{
		"revenue": 26000e6, "net_income": 9500e6, "total_assets": 1250000e6, "total_equity": 75000e6,
	})

	// BAL: only balance snapshots: no flow row, so no row in either view.
	db.seed("BAL", "quarter", "2025-12-31", "AUD", y, map[string]any{"total_equity": 10e6, "total_assets": 20e6})

	// Statement shape (plan §2.7): only a full Yahoo income statement decides
	// statement_is_financial. A miner's full statement, reused below.
	mk := "markit-key-statistics"
	miner := func(rev, ni float64) map[string]any {
		return map[string]any{
			"revenue": rev, "net_income": ni, "pretax_income": ni * 1.4, "operating_income": ni * 1.5,
			"ebitda": ni * 2, "ebit": ni * 1.5, "eps_diluted": ni / 3e9,
		}
	}
	// MKT: a Markit-only code (revenue and net income, nothing else).
	db.seed("MKT", "annual", "2025-06-30", "AUD", mk, map[string]any{"revenue": 400e6, "net_income": 40e6})
	db.seed("MKT", "annual", "2024-06-30", "AUD", mk, map[string]any{"revenue": 380e6, "net_income": 35e6})
	// FILM: results week. The filing's FY26 annual (revenue, net income, EPS)
	// is newer than the vendor's rows; Yahoo's FY25 statement is complete.
	db.seed("FILM", "annual", "2026-06-30", "AUD", m132Fil, map[string]any{
		"revenue": 16000e6, "net_income": 5600e6, "eps_basic": 1.82, "source_document_url": "https://www.asx.com.au/a.pdf",
	})
	db.seed("FILM", "annual", "2025-06-30", "AUD", y, miner(15000e6, 5000e6))
	db.seed("FILM", "ttm", "2025-06-30", "AUD", y, miner(15000e6, 5000e6))
	// FILP: as FILM, but the filing also quotes profit before tax. A filing
	// row is never a statement shape, whatever lines it carries.
	db.seed("FILP", "annual", "2026-06-30", "AUD", m132Fil, map[string]any{
		"revenue": 16000e6, "net_income": 5600e6, "pretax_income": 7800e6,
	})
	db.seed("FILP", "annual", "2025-06-30", "AUD", y, miner(15000e6, 5000e6))
	// SPR1 / SPR2: Yahoo's newest year is sparse (pretax income and EPS only);
	// Markit filled its revenue (SPR1), a filing its net income (SPR2). Such a
	// row is not Yahoo's own statement; the older full year decides.
	for _, s := range []struct{ code, marks string }{
		{"SPR1", `{"revenue": "markit-key-statistics", "net_income": "markit-key-statistics"}`},
		{"SPR2", `{"net_income": "asx-filing-extraction"}`},
	} {
		db.seed(s.code, "annual", "2026-06-30", "AUD", y, map[string]any{
			"revenue": 900e6, "net_income": 90e6, "pretax_income": 126e6, "eps_diluted": 0.3, "field_sources": s.marks,
		})
		db.seed(s.code, "annual", "2025-06-30", "AUD", y, miner(800e6, 80e6))
	}
	// IAG (yahoo_full_IAG.json): an insurer's full statement carries
	// PretaxIncome and EBIT but no OperatingIncome and no EBITDA, annual and
	// trailing alike. FY25 is the scale-break year: its Yahoo revenue and net
	// income were refused and Markit filled them.
	for _, pt := range []string{"annual", "ttm"} {
		db.seed("IAG", pt, "2026-06-30", "AUD", y, map[string]any{
			"revenue": 16115e6, "net_income": 1022e6, "pretax_income": 1739e6, "ebit": 1929e6,
			"net_interest_income": -190e6, "total_equity": 7232e6, "total_assets": 27599e6,
		})
	}
	db.seed("IAG", "annual", "2025-06-30", "AUD", y, map[string]any{
		"revenue": 15500e6, "net_income": 1400e6, "ebit": 2405e6,
		"field_sources": `{"revenue": "markit-key-statistics", "net_income": "markit-key-statistics"}`,
	})
	db.seed("IAG", "annual", "2024-06-30", "AUD", y, map[string]any{
		"revenue": 13673e6, "net_income": 898e6, "pretax_income": 1491e6, "ebit": 1676e6,
		"total_equity": 6660e6, "total_assets": 25617e6,
	})
	// FXC (XRO-shaped, stock_fundamentals_sync.fx_converted): every Yahoo
	// monetary field was refused as FX-converted; the rows keep the share
	// count, relabelled NZD, with Markit's native revenue and net income.
	for _, r := range []struct {
		end     string
		rev, ni float64
	}{{"2026-03-31", 2400e6, 280e6}, {"2025-03-31", 2102.652e6, 227.817e6}} {
		db.seed("FXC", "annual", r.end, "NZD", y, map[string]any{
			"revenue": r.rev, "net_income": r.ni, "shares_outstanding": 153e6,
			"field_sources": `{"revenue": "markit-key-statistics", "net_income": "markit-key-statistics"}`,
		})
	}

	db.refresh()

	t.Run("net debt excludes leases (FMG FY24 net cash)", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "FMG")
		assert.InDelta(t, -318e6, m132Num(t, q, "net_debt"), 1, "5,400 - 815 - 4,903")
		assert.InDelta(t, -318.0/9500, m132Num(t, q, "net_debt_to_ebitda"), 1e-9, "on NORMALIZED EBITDA")
		assert.Equal(t, "2024-06-30", q["balance_period_end"])
		assert.EqualValues(t, 0, m132Num(t, q, "balance_lag_months"))
		assert.InDelta(t, 5683/((19460+17990)/2.0)*100, m132Num(t, q, "roe_pct"), 1e-9)
		assert.Equal(t, "USD", q["currency"])
		assert.Equal(t, false, q["statement_is_financial"])
	})

	t.Run("a balance row two years before the flow row qualifies nothing (LOV)", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "LOV")
		assert.Equal(t, "ttm", q["basis_period_type"])
		assert.Equal(t, "2025-12-31", q["basis_period_end"])
		for _, k := range []string{"roe_pct", "roa_pct", "net_debt", "net_debt_to_equity", "balance_period_end",
			"balance_lag_months", "total_equity", "total_assets_prior"} {
			assert.Nil(t, q[k], k)
		}
		assert.InDelta(t, 10, m132Num(t, q, "net_margin_pct"), 1e-9, "flow-only ratios still read")
	})

	t.Run("a newer balance-only row leaves the half growth unchanged (HBR)", func(t *testing.T) {
		before := db.row("mv_fundamentals_growth", "HBR")
		assert.Equal(t, "half", before["revenue_basis_period_type"])
		assert.InDelta(t, 10, m132Num(t, before, "revenue_yoy_pct"), 1e-9)
		assert.Equal(t, "2025-12-31", before["revenue_latest_period_end"])
		assert.Equal(t, "2024-12-31", before["revenue_prior_period_end"])
		assert.Equal(t, "filing", before["revenue_basis_source"])
		assert.EqualValues(t, 4, m132Num(t, before, "periods_available"))

		db.seed("HBR", "quarter", "2026-03-31", "AUD", y, map[string]any{"total_equity": 90e6, "total_assets": 150e6, "shares_outstanding": 2e8})
		db.seed("HBR", "annual", "2026-06-30", "AUD", y, map[string]any{"total_equity": 95e6, "total_assets": 160e6})
		db.refresh()
		assert.Equal(t, before, db.row("mv_fundamentals_growth", "HBR"), "no growth column moves")

		q := db.row("mv_fundamentals_quality", "HBR")
		assert.Equal(t, "2025-06-30", q["basis_period_end"])
		assert.Nil(t, q["balance_period_end"], "a balance row AFTER the flow row is never used")
	})

	t.Run("a fresher TTM revenue point is the revenue basis (TTF)", func(t *testing.T) {
		g := db.row("mv_fundamentals_growth", "TTF")
		assert.Equal(t, "ttm", g["revenue_basis_period_type"])
		assert.InDelta(t, 120e6, m132Num(t, g, "revenue_latest"), 1e-3)
		assert.InDelta(t, 100e6, m132Num(t, g, "revenue_prior"), 1e-3)
		assert.InDelta(t, 20, m132Num(t, g, "revenue_yoy_pct"), 1e-9)
		assert.InDelta(t, 25, m132Num(t, g, "revenue_yoy_prior_pct"), 1e-9, "the comparator vs the TTM point a year before it")
		assert.Equal(t, "2025-12-31", g["revenue_latest_period_end"])
		assert.Equal(t, "2024-12-31", g["revenue_prior_period_end"])
		assert.Equal(t, "2025-06-30", g["latest_annual_period_end"])
		assert.Equal(t, "vendor", g["revenue_basis_source"])

		q := db.row("mv_fundamentals_quality", "TTF")
		assert.Equal(t, "ttm", q["basis_period_type"])
		assert.Equal(t, "quarter", q["balance_period_type"], "a quarter snapshot on the flow date is the balance row")
		assert.EqualValues(t, 0, m132Num(t, q, "balance_lag_months"))
		assert.InDelta(t, 12/((60+50)/2.0)*100, m132Num(t, q, "roe_pct"), 1e-9)
	})

	t.Run("the TTM basis falls back to the annual comparator (TTA)", func(t *testing.T) {
		g := db.row("mv_fundamentals_growth", "TTA")
		assert.Equal(t, "ttm", g["revenue_basis_period_type"])
		assert.InDelta(t, 20, m132Num(t, g, "revenue_yoy_pct"), 1e-9)
		assert.InDelta(t, 25, m132Num(t, g, "revenue_yoy_prior_pct"), 1e-9)
		assert.Equal(t, "2025-06-30", g["revenue_latest_period_end"])
		assert.Equal(t, "2024-06-30", g["revenue_prior_period_end"])
	})

	t.Run("a TTM point without a comparator keeps the annual basis (TTN)", func(t *testing.T) {
		g := db.row("mv_fundamentals_growth", "TTN")
		assert.Equal(t, "annual", g["revenue_basis_period_type"])
		assert.InDelta(t, (200.0-180)/180*100, m132Num(t, g, "revenue_yoy_pct"), 1e-9)
		assert.Equal(t, "2025-06-30", g["revenue_latest_period_end"])
		assert.Equal(t, "2024-06-30", g["revenue_prior_period_end"])
		assert.InDelta(t, 220e6, m132Num(t, g, "revenue_ttm"), 1e-3)
	})

	t.Run("basis source is 'filing' when either row or the used field came from a filing", func(t *testing.T) {
		g1 := db.row("mv_fundamentals_growth", "FIL1")
		assert.Equal(t, "filing", g1["revenue_basis_source"], "filing-current / vendor-prior pair")
		assert.Equal(t, "filing", g1["eps_basis_source"], "the EPS pair shares the filing row")
		g2 := db.row("mv_fundamentals_growth", "FIL2")
		assert.Equal(t, "filing", g2["revenue_basis_source"], "revenue filled from a filing on a vendor row")
		assert.Equal(t, "ttm", g2["basis_period_type"])
		assert.Equal(t, "filing", g2["eps_basis_source"], "diluted EPS filled from a filing on a TTM row")
		g3 := db.row("mv_fundamentals_growth", "FIL3")
		assert.Equal(t, "vendor", g3["revenue_basis_source"], "a marker on a field the basis did not use")
		assert.Equal(t, "vendor", g3["eps_basis_source"])
		assert.Nil(t, db.row("mv_fundamentals_growth", "TTN")["eps_basis_source"], "no EPS figure, no source")
	})

	t.Run("negative equity: no ROE, no net debt / equity", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "NEG")
		assert.InDelta(t, -50e6, m132Num(t, q, "total_equity"), 1e-3)
		assert.Nil(t, q["roe_pct"])
		assert.Nil(t, q["net_debt_to_equity"])
		assert.InDelta(t, 250e6, m132Num(t, q, "net_debt"), 1e-3, "300 - 20 - 30")
		assert.InDelta(t, 20/((400+380)/2.0)*100, m132Num(t, q, "roa_pct"), 1e-9)
	})

	t.Run("currency mismatch: no growth, no balance row", func(t *testing.T) {
		g := db.row("mv_fundamentals_growth", "CUR")
		assert.Nil(t, g["revenue_yoy_pct"], "USD vs AUD is not a growth rate")
		assert.Nil(t, g["revenue_latest_period_end"])
		assert.Nil(t, g["revenue_prior_period_end"])
		assert.Equal(t, "USD", g["currency"])
		q := db.row("mv_fundamentals_quality", "CUR")
		assert.Equal(t, "USD", q["currency"])
		for _, k := range []string{"balance_period_end", "balance_currency", "total_equity", "roe_pct", "roa_pct"} {
			assert.Nil(t, q[k], k)
		}
	})

	t.Run("every quality definition (QUAL)", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "QUAL")
		assert.Equal(t, "annual", q["basis_period_type"], "at equal period_end the fuller row wins")
		for k, want := range map[string]float64{
			"gross_margin_pct":     40,
			"operating_margin_pct": 30,
			"net_margin_pct":       18,
			"fcf_margin_pct":       18,
			"fcf_conversion":       1,
			"roe_pct":              9000 / ((50000 + 46000) / 2.0) * 100,
			"roa_pct":              9000 / ((100000 + 90000) / 2.0) * 100,
			"net_debt":             7500e6, // the stored (Yahoo) value wins over debt - leases - cash
			"net_debt_to_ebitda":   7500.0 / 24000,
			"net_debt_to_equity":   0.15,
			"current_ratio":        1.5,
			"interest_cover":       15,
			"payout_ratio_pct":     50,
			"total_equity_prior":   46000e6,
			"total_assets_prior":   90000e6,
		} {
			assert.InDelta(t, want, m132Num(t, q, k), 1e-6*m132MaxAbs(want, 1), k)
		}
		assert.Equal(t, true, q["operating_cash_flow_derived"])
		assert.Equal(t, false, q["statement_is_financial"])
		assert.Equal(t, "USD", q["balance_currency"])
	})

	t.Run("payout sign rule and the six-month balance lag (LAG6)", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "LAG6")
		assert.Nil(t, q["payout_ratio_pct"], "dividends_paid > 0 violates the sign convention")
		assert.Equal(t, "2025-06-30", q["balance_period_end"])
		assert.EqualValues(t, 6, m132Num(t, q, "balance_lag_months"))
		assert.InDelta(t, 30/((200+180)/2.0)*100, m132Num(t, q, "roe_pct"), 1e-9)
		assert.Nil(t, q["statement_is_financial"], "no pretax income: not a full statement, so the shape is unknown")
	})

	t.Run("a bank: statement_is_financial, and ROE not meaningful below 10% equity", func(t *testing.T) {
		q := db.row("mv_fundamentals_quality", "BANK")
		assert.Equal(t, true, q["statement_is_financial"])
		assert.Nil(t, q["roe_pct"])
		assert.InDelta(t, 10000/((1300000+1250000)/2.0)*100, m132Num(t, q, "roa_pct"), 1e-9)
		assert.Nil(t, q["interest_cover"])
		assert.Nil(t, q["operating_margin_pct"])
	})

	t.Run("statement shape: only a full Yahoo income statement decides statement_is_financial", func(t *testing.T) {
		for _, c := range []struct {
			code string
			want any // true / false; nil = unknown (the API's industry test decides)
			why  string
		}{
			{"LEG", nil, "a 000129-shaped row (written before the new columns) is not a statement"},
			{"OLD", nil, "revenue and net income alone are not a statement"},
			{"LAG6", nil, "no pretax income on any row"},
			{"MKT", nil, "a Markit-only code never carries a statement"},
			{"FXC", nil, "every Yahoo monetary field refused (FX-converted): no statement held"},
			{"FILM", false, "a newer filing row does not decide; Yahoo's full FY25 statement does"},
			{"FILP", false, "a filing row is never the shape, even one quoting pretax income"},
			{"SPR1", false, "a Yahoo row whose revenue Markit filled is not Yahoo's own statement"},
			{"SPR2", false, "a Yahoo row whose net income a filing filled is not Yahoo's own statement"},
			{"IAG", true, "an insurer: pretax income and EBIT, no operating income, no EBITDA"},
			{"BANK", true, "a bank: pretax income, no operating income, no EBITDA"},
			{"FMG", false, "a miner's full statement"},
			{"QUAL", false, "a full statement"},
		} {
			q := db.row("mv_fundamentals_quality", c.code)
			require.NotNil(t, q, c.code)
			assert.Equal(t, c.want, q["statement_is_financial"], "%s: %s", c.code, c.why)
		}

		// The flow basis itself is untouched: it is still the freshest row with
		// revenue and profit, whichever row decides the shape.
		for code, want := range map[string][2]string{
			"LEG":  {"ttm", "2025-12-31"},
			"MKT":  {"annual", "2025-06-30"},
			"FILM": {"annual", "2026-06-30"},
			"SPR1": {"annual", "2026-06-30"},
			"FXC":  {"annual", "2026-03-31"},
			"IAG":  {"annual", "2026-06-30"},
		} {
			q := db.row("mv_fundamentals_quality", code)
			assert.Equal(t, want[0], q["basis_period_type"], code)
			assert.Equal(t, want[1], q["basis_period_end"], code)
		}
		assert.Equal(t, m132Fil, db.row("mv_fundamentals_quality", "FILM")["source"])
		assert.Equal(t, mk, db.row("mv_fundamentals_quality", "MKT")["source"])

		// Once the job re-fetches LEG with the full statements, its shape is
		// known (and is a miner's): a refresh is all it takes.
		db.seed("LEG", "annual", "2026-06-30", "USD", y, miner(52000e6, 9000e6))
		db.refresh()
		assert.Equal(t, false, db.row("mv_fundamentals_quality", "LEG")["statement_is_financial"])
	})

	t.Run("balance snapshots alone are not a fundamentals row", func(t *testing.T) {
		assert.Nil(t, db.row("mv_fundamentals_growth", "BAL"))
		assert.Nil(t, db.row("mv_fundamentals_quality", "BAL"))
	})

	t.Run("down restores 000129's view and 000130's function; up again", func(t *testing.T) {
		db.mustApply(m132Down)
		assert.Equal(t, growth129, db.columns("mv_fundamentals_growth"))
		var quality *string
		db.scalar(&quality, `SELECT to_regclass('mv_fundamentals_quality')::text`)
		assert.Nil(t, quality)
		var n int
		db.scalar(&n, `SELECT count(*) FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'stock_fundamentals'`)
		assert.Equal(t, 16, n, "000129's sixteen columns")
		db.scalar(&n, `SELECT count(*) FROM pg_constraint WHERE conname = 'stock_fundamentals_finite_check_v2'
			AND conrelid = 'stock_fundamentals'::regclass`)
		assert.Zero(t, n)
		var lease *string
		db.scalar(&lease, `SELECT to_regclass('picks_run_lease')::text`)
		assert.Nil(t, lease)
		var body string
		db.scalar(&body, `SELECT prosrc FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
		assert.NotContains(t, body, "mv_fundamentals_quality")
		db.refresh() // 000129's growth view and 000130's function work together again
		assert.NotNil(t, db.row("mv_fundamentals_growth", "HBR"))
		db.mustApply(m132Down) // a second down is a no-op

		db.mustApply(m132Up)
		db.refresh()
		assert.Equal(t, "half", db.row("mv_fundamentals_growth", "HBR")["revenue_basis_period_type"])
	})
}

func m132MaxAbs(a, b float64) float64 {
	if a < 0 {
		a = -a
	}
	if a > b {
		return a
	}
	return b
}

// TestMigration132WaitsForARunningRefresh applies 000132 while another
// connection holds a refresh open (pg_sleep between two refreshes, in
// refresh_strategy_views() order), and asserts neither side deadlocks
// (SQLSTATE 40P01) or times out: 000132 waits for the refresh, or finishes
// before the refresh reaches the views it rebuilt.
func TestMigration132WaitsForARunningRefresh(t *testing.T) {
	for _, tc := range []struct {
		name string
		// first: refreshes before the sleep; then: after it.
		first, then []string
		replay      bool // 000132 already applied: this is the deploy's replay
		mustWait    bool // 000132 cannot finish until the refresh commits
	}{
		{
			name:     "first apply, refresh holding the growth view",
			first:    []string{"mv_market_regime", "mv_fundamentals_growth"},
			then:     []string{"mv_price_features"},
			mustWait: true,
		},
		{
			name:  "first apply, refresh between the regime and growth views",
			first: []string{"mv_market_regime"},
			then:  []string{"mv_fundamentals_growth", "mv_fundamentals_quality", "mv_price_features"},
		},
		{
			name:   "replay, refresh holding every picker view",
			first:  []string{"mv_market_regime", "mv_fundamentals_growth", "mv_fundamentals_quality"},
			then:   []string{"mv_price_features"},
			replay: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := m132NewDB(t, m132Base...)
			if tc.replay {
				db.mustApply(m132Up)
			}
			db.seed("AAA", "annual", "2025-06-30", "AUD", "yahoo-timeseries", map[string]any{"revenue": 10e6, "net_income": 1e6})
			db.seed("AAA", "annual", "2024-06-30", "AUD", "yahoo-timeseries", map[string]any{"revenue": 9e6, "net_income": 1e6})
			db.exec(`REFRESH MATERIALIZED VIEW mv_fundamentals_growth`)

			ctx := context.Background()
			conn, err := db.pool.Acquire(ctx)
			require.NoError(t, err)
			defer conn.Release()
			tx, err := conn.Begin(ctx)
			require.NoError(t, err)
			for _, mv := range tc.first {
				_, err := tx.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY `+mv)
				require.NoError(t, err, mv)
			}
			held := make(chan error, 1)
			go func() {
				_, err := tx.Exec(ctx, `SELECT pg_sleep(2)`)
				for _, mv := range tc.then {
					if err != nil {
						break
					}
					_, err = tx.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY `+mv)
				}
				if err != nil {
					_ = tx.Rollback(ctx)
					held <- err
					return
				}
				held <- tx.Commit(ctx)
			}()

			time.Sleep(300 * time.Millisecond) // the holder is inside pg_sleep
			start := time.Now()
			applyErr := db.apply(m132Up)
			elapsed := time.Since(start)
			refreshErr := <-held

			assert.NotEqual(t, "40P01", m132SQLState(applyErr), "000132 deadlocked with the refresh")
			assert.NotEqual(t, "40P01", m132SQLState(refreshErr), "the refresh deadlocked with 000132")
			require.NoError(t, applyErr, "000132 (%s)", m132SQLState(applyErr))
			require.NoError(t, refreshErr, "the refresh (%s)", m132SQLState(refreshErr))
			if tc.mustWait {
				assert.Greater(t, elapsed, time.Second, "000132 should have waited for the refresh to commit")
			}
			if tc.replay {
				assert.Less(t, elapsed, time.Second, "a replay takes no lock on a picker view, so it never waits for a refresh")
			}

			// Both committed: the rebuilt views refresh cleanly afterwards.
			db.refresh()
			g := db.row("mv_fundamentals_growth", "AAA")
			require.NotNil(t, g)
			assert.InDelta(t, (10.0-9)/9*100, m132Num(t, g, "revenue_yoy_pct"), 1e-9)
			assert.Equal(t, "2025-06-30", g["revenue_latest_period_end"])
			assert.NotNil(t, db.row("mv_fundamentals_quality", "AAA"))
		})
	}
}

// TestMigration132DropsTheGrowthViewBeforeAlteringItsTable pins the lock order
// that makes the rebuild deadlock-free, deterministically. A third connection
// holds stock_fundamentals_sync, so 000132 stops mid-transaction at its sync
// column adds, holding every lock it took before them. A refresh then reaches
// mv_fundamentals_growth. In the plan's order (the growth view dropped BEFORE
// stock_fundamentals is altered) 000132 already holds the view, so the refresh
// waits for it and nothing cycles. In the other order 000132 would hold only
// the table, the refresh would take the view and wait for the table, and
// 000132 would then wait for the view: SQLSTATE 40P01.
func TestMigration132DropsTheGrowthViewBeforeAlteringItsTable(t *testing.T) {
	db := m132NewDB(t, m132Base...)
	db.seed("AAA", "annual", "2025-06-30", "AUD", "yahoo-timeseries", map[string]any{"revenue": 10e6, "net_income": 1e6})
	db.seed("AAA", "annual", "2024-06-30", "AUD", "yahoo-timeseries", map[string]any{"revenue": 8e6, "net_income": 1e6})
	db.exec(`REFRESH MATERIALIZED VIEW mv_fundamentals_growth`)
	ctx := context.Background()

	blocker, err := db.pool.Acquire(ctx)
	require.NoError(t, err)
	defer blocker.Release()
	blockTx, err := blocker.Begin(ctx)
	require.NoError(t, err)
	_, err = blockTx.Exec(ctx, `LOCK TABLE stock_fundamentals_sync IN ACCESS SHARE MODE`)
	require.NoError(t, err)

	applied := make(chan error, 1)
	go func() { applied <- db.apply(m132Up) }()

	// Wait until 000132 is queued behind the blocker.
	m132WaitForLockWaiters(t, db, 1)

	refresher, err := db.pool.Acquire(ctx)
	require.NoError(t, err)
	defer refresher.Release()
	refreshTx, err := refresher.Begin(ctx)
	require.NoError(t, err)
	_, err = refreshTx.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_market_regime`)
	require.NoError(t, err)
	refreshed := make(chan error, 1)
	go func() {
		_, err := refreshTx.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_fundamentals_growth`)
		if err != nil {
			_ = refreshTx.Rollback(ctx)
			refreshed <- err
			return
		}
		refreshed <- refreshTx.Commit(ctx)
	}()
	m132WaitForLockWaiters(t, db, 2) // the refresh is queued too

	require.NoError(t, blockTx.Commit(ctx))
	applyErr, refreshErr := <-applied, <-refreshed
	assert.NotEqual(t, "40P01", m132SQLState(applyErr), "000132 deadlocked with the refresh")
	assert.NotEqual(t, "40P01", m132SQLState(refreshErr), "the refresh deadlocked with 000132")
	require.NoError(t, applyErr)
	require.NoError(t, refreshErr, "the refresh waits, then refreshes the rebuilt view")

	g := db.row("mv_fundamentals_growth", "AAA")
	require.NotNil(t, g)
	assert.InDelta(t, 25, m132Num(t, g, "revenue_yoy_pct"), 1e-9)
}

// m132WaitForLockWaiters waits (up to 10s) until at least n backends of this
// database are waiting on a heavyweight lock.
func m132WaitForLockWaiters(t *testing.T, db *m132DB, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		db.scalar(&waiting, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`)
		if waiting >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d backends waiting on a lock, have %d", n, waiting)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
