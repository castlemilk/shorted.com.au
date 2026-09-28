package picks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// No database here: these pin the SQL's shape and the argument arrays, and
// prove the arrays render as Postgres array literals WITH NULL elements under
// the simple protocol platform.Connect forces (pgx encodes each argument via
// pgtype.Map.Encode(0, text, ...) and interpolates it). The rule table itself
// runs against a real Postgres further down (TestVendorUpsertRulesAgainstPostgres,
// env-gated).

func placeholders(sql string) map[string]bool {
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(sql, -1) {
		out[m[1]] = true
	}
	return out
}

func TestUpsertArgsLineUpWithTheStatement(t *testing.T) {
	rows := fixtureRows(t, "yahoo_full_BHP.json")
	assignFiscalYears(rows)
	rows[0].Rejected = []string{"revenue"}
	rows[0].FieldSources = map[string]string{"net_income": sourceMarkit}
	fetched := time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC)

	for _, tc := range []struct {
		name string
		sql  string
		cols []fundamentalsColumn
	}{
		{"extended", upsertSQL, fundamentalsColumns},
		{"legacy", legacyUpsertSQL, legacyColumns()},
	} {
		args := upsertArgs("BHP", rows, fetched, tc.cols)
		assert.Len(t, placeholders(tc.sql), len(args), "%s: every argument is used and every placeholder has one", tc.name)
		assert.Len(t, args, argFirstValue-1+len(tc.cols), tc.name)
		assert.Equal(t, "BHP", args[argCode-1])
		assert.Equal(t, fetched, args[argFetchedAt-1])
		n := len(rows)
		for i := argPeriodTypes - 1; i < len(args); i++ {
			switch a := args[i].(type) {
			case []string:
				assert.Len(t, a, n, "%s arg %d", tc.name, i+1)
			case []*float64:
				assert.Len(t, a, n, "%s arg %d", tc.name, i+1)
			case []*int16:
				assert.Len(t, a, n, "%s arg %d", tc.name, i+1)
			default:
				t.Fatalf("%s arg %d has unexpected type %T", tc.name, i+1, a)
			}
		}
		// The value arrays follow the column list in order.
		for j, c := range tc.cols {
			vals := args[argFirstValue-1+j].([]*float64)
			for i := range rows {
				assert.Equal(t, c.get(&rows[i]), vals[i], "%s %s row %d", tc.name, c.name, i)
			}
			assert.Contains(t, tc.sql, "$"+strconv.Itoa(argFirstValue+j)+"::float8[]")
			assert.Regexp(t, `u\.`+c.name+`\b`, tc.sql)
		}
		assert.Equal(t, `["revenue"]`, args[argRejected-1].([]string)[0])
		assert.Equal(t, `{"net_income":"markit-key-statistics"}`, args[argFieldSources-1].([]string)[0])
		assert.Equal(t, "", args[argRejected-1].([]string)[1], "no mask: the SQL reads '' as []")

		m := pgtype.NewMap()
		for i := argPeriodTypes - 1; i < len(args); i++ {
			_, err := m.Encode(0, pgtype.TextFormatCode, args[i], nil)
			require.NoError(t, err, "%s arg %d encodes under the simple protocol", tc.name, i+1)
		}
		enc, err := m.Encode(0, pgtype.TextFormatCode, args[argFirstValue-1], nil) // revenue: nil on row 0 (masked) ...
		require.NoError(t, err)
		assert.Contains(t, string(enc), "NULL", "missing values reach Postgres as NULL")
	}
}

func TestUpsertSQLShape(t *testing.T) {
	sql := strings.Join(strings.Fields(upsertSQL), " ")
	assert.Equal(t, 1, strings.Count(sql, "INSERT INTO"), "one statement per code")
	assert.Contains(t, sql, "ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET")
	assert.Contains(t, sql, "FROM unnest(")
	for _, c := range fundamentalsColumns {
		n := c.name
		// Rule 6, rule 2, rules 3/5 then 1, rule 4 — in that order.
		assert.Contains(t, sql, n+" = CASE WHEN NOT (EXCLUDED.currency = f.currency) THEN EXCLUDED."+n, "%s: a currency change replaces", n)
		assert.Regexp(t, regexp.MustCompile(`WHEN \(SELECT t\.rejected FROM t WHERE t\.period_type = EXCLUDED\.period_type AND t\.period_end = EXCLUDED\.period_end\) \? '`+n+`' THEN NULL WHEN \(f\.`+n+` IS NOT NULL AND \(f\.period_type IN \('ttm', 'quarter'\) OR \(COALESCE\(f\.field_sources->>'`+n+`', f\.source\) IN \('asx-filing-extraction', 'markit-key-statistics'\) AND COALESCE\(f\.field_sources->>'`+n+`', f\.source\) <> EXCLUDED\.source\)\)\) THEN COALESCE\(EXCLUDED\.`+n+`, f\.`+n+`\) ELSE EXCLUDED\.`+n+` END`), sql, n)
		assert.Contains(t, sql, "'"+n+"', CASE WHEN", "%s has a field_sources entry", n)
	}
	assert.Contains(t, sql, "field_sources = CASE WHEN NOT (EXCLUDED.currency = f.currency) THEN EXCLUDED.field_sources ELSE jsonb_strip_nulls(jsonb_build_object(")
	assert.Contains(t, sql, "source = EXCLUDED.source")
	assert.Contains(t, sql, "source_document_url = CASE WHEN (EXCLUDED.currency = f.currency AND (")
	// Rule 5: a filing row is taken over only on revenue or net income, and
	// a Markit row never takes over a Yahoo row.
	assert.True(t, strings.HasSuffix(sql, "WHERE (f.source <> 'asx-filing-extraction' OR EXCLUDED.revenue IS NOT NULL OR EXCLUDED.net_income IS NOT NULL) AND NOT (f.source = 'yahoo-timeseries' AND EXCLUDED.source = 'markit-key-statistics')"))
	// A mask never inserts an empty row.
	assert.Contains(t, sql, "WHERE num_nonnulls(t.revenue, t.net_income")
	assert.Contains(t, sql, "OR EXISTS (SELECT 1 FROM stock_fundamentals s WHERE s.stock_code = $1 AND s.period_type = t.period_type AND s.period_end = t.period_end)")
	// The 52/53-week duplicate prune is scoped to this code and to Markit
	// annual rows.
	assert.Contains(t, sql, "DELETE FROM stock_fundamentals d WHERE d.stock_code = $1 AND d.period_type = 'annual' AND d.source = 'markit-key-statistics'")
	// jsonb_build_object takes at most 100 arguments.
	assert.LessOrEqual(t, 2*len(fundamentalsColumns), 100)
	// The filing test in filings_ingest_test.go pins these two.
	assert.Contains(t, upsertSQL, "COALESCE(EXCLUDED.revenue, f.revenue)")
	assert.Contains(t, upsertSQL, "source              = EXCLUDED.source")
}

func TestLegacyUpsertSQLIsThe000129ColumnSet(t *testing.T) {
	sql := strings.Join(strings.Fields(legacyUpsertSQL), " ")
	for _, c := range fundamentalsColumns {
		if isColumn000129(c.name) {
			assert.Contains(t, sql, c.name+" = CASE WHEN (SELECT t.rejected FROM t WHERE t.period_type = EXCLUDED.period_type AND t.period_end = EXCLUDED.period_end) ? '"+c.name+"' THEN NULL WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED."+c.name+", f."+c.name+") ELSE EXCLUDED."+c.name+" END",
				"%s: today's policy plus the mask", c.name)
		} else {
			assert.NotRegexp(t, `\b`+c.name+`\b`, sql, "%s is a 000132 column", c.name)
		}
	}
	for _, col := range []string{"field_sources", "source_document_url", "pruned"} {
		assert.NotContains(t, sql, col+" =")
	}
	assert.NotContains(t, sql, "DELETE")
	assert.Len(t, legacyColumns(), 7)
	assert.Len(t, fundamentals000132Columns(), len(fundamentalsColumns)-7+3)
}

func TestRecordAttemptSQL(t *testing.T) {
	sql := strings.Join(strings.Fields(recordAttemptSQL), " ")
	assert.Contains(t, sql, "ON CONFLICT (stock_code) DO UPDATE SET")
	assert.Contains(t, sql, "last_success_at = CASE WHEN $3::bool THEN EXCLUDED.last_attempt_at ELSE s.last_success_at END")
	assert.Contains(t, sql, "periods_loaded = CASE WHEN $3::bool THEN EXCLUDED.periods_loaded ELSE s.periods_loaded END")
	assert.Contains(t, sql, "consecutive_empty = CASE WHEN $6::text = 'empty' THEN LEAST(s.consecutive_empty + 1, 32767) ELSE 0 END")
	assert.Contains(t, sql, "median_k = CASE WHEN $7::bool THEN $8::float8 ELSE s.median_k END")
	assert.Contains(t, sql, "fx_converted = CASE WHEN $7::bool THEN $9::bool ELSE s.fx_converted END")
	assert.Contains(t, sql, "native_currency = CASE WHEN $7::bool THEN NULLIF($10::text, '') ELSE s.native_currency END")
	assert.Len(t, placeholders(recordAttemptSQL), 10)
	assert.Len(t, placeholders(recordAttemptLegacySQL), 5)
	assert.NotContains(t, recordAttemptLegacySQL, "last_outcome")

	k := 10.02
	args := recordAttemptArgs(attempt{Code: "RMD", At: time.Unix(0, 0), Success: true, Measured: true, MedianK: &k, Err: strings.Repeat("x", 2000)})
	assert.Len(t, args, 10)
	assert.Equal(t, outcomeLoaded, args[5], "the outcome defaults from Success")
	assert.Equal(t, false, args[8])
	assert.Equal(t, "", args[9])
	assert.Equal(t, &k, args[7])
	assert.Len(t, args[3], 1000, "the error is truncated")
	inf := 1e300
	args = recordAttemptArgs(attempt{Code: "X", Measured: true, MedianK: &inf, Outcome: outcomeEmpty})
	assert.Nil(t, args[7], "a non-storable median_k is written NULL")
	assert.Equal(t, outcomeEmpty, args[5])
	args = recordAttemptArgs(attempt{Code: "X"})
	assert.Equal(t, outcomeFailed, args[5])
	assert.Equal(t, false, args[6])

	args = recordAttemptArgs(attempt{Code: "XRO", Measured: true, FXConverted: true, NativeCurrency: " nzd "})
	assert.Equal(t, true, args[8])
	assert.Equal(t, "NZD", args[9], "the native currency is normalised")
	args = recordAttemptArgs(attempt{Code: "X", Measured: true, NativeCurrency: "NZD"})
	assert.Equal(t, "", args[9], "a native currency means nothing unless the code is FX-converted")
	args = recordAttemptArgs(attempt{Code: "X", Measured: true, FXConverted: true, NativeCurrency: "NOTACURRENCY"})
	assert.Equal(t, "", args[9], "too long for VARCHAR(8): unknown rather than a failed write")
}

func TestLeaseSQL(t *testing.T) {
	sql := strings.Join(strings.Fields(claimLeaseSQL), " ")
	assert.Contains(t, sql, "VALUES ('picks', $1, now() + interval '4 hours')")
	assert.Contains(t, sql, "WHERE l.expires_at < now() OR l.holder = EXCLUDED.holder",
		"free, expired, or this execution's own (a task retry)")
	assert.Contains(t, sql, "RETURNING holder")
	assert.Contains(t, extendLeaseSQL, "holder = $1")
	assert.Contains(t, releaseLeaseSQL, "holder = $1", "a run never deletes another execution's lease")
}

func TestRefreshSQLIsOneTransactionScopedCommand(t *testing.T) {
	assert.Equal(t, "BEGIN; SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views(); COMMIT", refreshSQL)
}

func TestSkippedViewParsesOnlyTheSkipWarning(t *testing.T) {
	n := &noticeLog{}
	for _, m := range []*pgconn.Notice{
		{Severity: "NOTICE", Message: "Refreshing mv_price_features (concurrently)..."},
		{Severity: "WARNING", Message: "Failed to refresh mv_price_features concurrently: x. Trying non-concurrent..."},
		{Severity: "WARNING", Message: "Skipping mv_fundamentals_growth: canceling statement due to statement timeout"},
		{Severity: "NOTICE", Message: "Skipping mv_market_regime: not a warning"},
	} {
		n.handle(nil, m)
	}
	assert.Equal(t, []string{"mv_fundamentals_growth"}, n.skipped(),
		"a concurrent failure that fell back to a plain refresh is NOT a skip")
	n.reset()
	assert.Empty(t, n.skipped())
}

func TestUndefinedTableAndColumn(t *testing.T) {
	assert.True(t, undefinedTable(&pgconn.PgError{Code: "42P01"}))
	assert.False(t, undefinedTable(&pgconn.PgError{Code: "42703"}))
	assert.False(t, undefinedTable(nil))
	assert.True(t, undefinedColumn(&pgconn.PgError{Code: "42703"}))
	assert.False(t, undefinedColumn(&pgconn.PgError{Code: "42P01"}))
}

func TestFilingPrefilterIsWiderThanTheClassifier(t *testing.T) {
	// Every headline the classifier accepts must survive the SQL prefilter
	// (approximated here with the same regex, case-insensitive).
	pre := regexp.MustCompile(`(?i)(appendix\s*4[de]|report|result)`)
	for _, h := range []string{
		"Half Yearly Report and Accounts",
		"Appendix4E and Annual Report",
		"1H25 Results Surging Revenue and Profitability",
		"FY26 Financial Results and Dividend",
		"Media Release - Result for year ended 30 June 2026",
	} {
		require.NotEqual(t, filingKind(""), classifyResultsFiling(h), h)
		assert.True(t, pre.MatchString(h), h)
	}
	assert.Contains(t, filingPrefilterSQL, `appendix\s*4[de]|report|result`)
}

func TestJobDeclaresDryRunAndValidatesFlags(t *testing.T) {
	j := Job()
	assert.Equal(t, "picks", j.Name())
	d, ok := j.(runner.DryRunAware)
	require.True(t, ok)
	assert.True(t, d.SupportsDryRun(), "the runner must accept a global -dry-run")

	err := Run(context.Background(), []string{"-mode", "bogus"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown -mode")

	assert.ErrorIs(t, Run(context.Background(), []string{"-h"}), runner.ErrUsage)

	err = Run(context.Background(), []string{"-mode", "refresh", "stray"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unexpected arguments")
}

func TestEnvPositiveInt(t *testing.T) {
	t.Setenv("PICKS_TEST_N", "250")
	assert.Equal(t, 250, envPositiveInt("PICKS_TEST_N", 400))
	for _, bad := range []string{"0", "-5", "x", ""} {
		t.Setenv("PICKS_TEST_N", bad)
		assert.Equal(t, 400, envPositiveInt("PICKS_TEST_N", 400), "%q keeps the default", bad)
	}
	t.Setenv("PICKS_FUNDAMENTALS_MAX_CODES", "0")
	assert.Equal(t, 0, envPositiveInt("PICKS_FUNDAMENTALS_MAX_CODES", defaultMaxCodes), "0 is no cap, the default")
}

// ---------------------------------------------------------------------------
// Against a real Postgres (env-gated, PICKS_TEST_DATABASE_URL, the variable
// filings_pg_test.go uses). Each test builds its own schema from 000129 plus,
// for the extended cases, the 000132 column set of plan
// fundamentals-coverage.md §2.1/§2.3/§2.4 (the real 000132 file and its
// replay are the data stream's migration132_pg_test.go), and drops it after.
//
//	PICKS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/picks GOWORK=off go test ./internal/jobs/picks/ -run AgainstPostgres

// vendorPG opens a pool on a fresh schema: 000129, and 000132's columns when
// extended.
func vendorPG(t *testing.T, extended bool) (*pgStore, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("PICKS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PICKS_TEST_DATABASE_URL not set")
	}
	if strings.Contains(dsn, "pooler") || strings.Contains(dsn, "supabase") {
		t.Fatalf("refusing a pooler/supabase DSN: this test creates and drops schemas")
	}
	ctx := context.Background()
	admin, err := platform.Connect(ctx, dsn)
	require.NoError(t, err)
	schema := fmt.Sprintf("picks_vendor_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, "CREATE SCHEMA "+schema)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	pool, err := platform.Connect(ctx, dsn, platform.PoolOption(func(cfg *pgxpool.Config) {
		cfg.ConnConfig.RuntimeParams["search_path"] = schema
	}))
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	m129, err := os.ReadFile("../../../../migrations/000129_add_stock_fundamentals.up.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(m129))
	require.NoError(t, err, "000129")
	if extended {
		var ddl strings.Builder
		ddl.WriteString("BEGIN;\n")
		for _, c := range fundamentalsColumns {
			if !isColumn000129(c.name) {
				fmt.Fprintf(&ddl, "ALTER TABLE stock_fundamentals ADD COLUMN %s DOUBLE PRECISION;\n", c.name)
			}
		}
		ddl.WriteString(`ALTER TABLE stock_fundamentals ADD COLUMN field_sources JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE stock_fundamentals ADD COLUMN source_document_url TEXT;
ALTER TABLE stock_fundamentals ADD COLUMN source_document_date DATE;
ALTER TABLE stock_fundamentals_sync ADD COLUMN last_outcome VARCHAR(16);
ALTER TABLE stock_fundamentals_sync ADD COLUMN consecutive_empty SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE stock_fundamentals_sync ADD COLUMN median_k DOUBLE PRECISION;
CREATE TABLE picks_run_lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
COMMIT;`)
		_, err = pool.Exec(ctx, ddl.String())
		require.NoError(t, err, "000132 columns")
	}
	var logged []string
	st := &pgStore{pool: pool, notices: &noticeLog{}, logf: func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) }}
	return st, pool
}

type sfRow struct {
	vals      map[string]*float64
	currency  string
	source    string
	fs        map[string]string
	docURL    *string
	updatedAt time.Time
}

func readSF(t *testing.T, pool *pgxpool.Pool, code, typ, end string) (sfRow, bool) {
	t.Helper()
	names := make([]string, len(fundamentalsColumns))
	for i, c := range fundamentalsColumns {
		names[i] = c.name
	}
	q := `SELECT currency::text, source::text, field_sources::text, source_document_url, updated_at, ` + strings.Join(names, ", ") +
		` FROM stock_fundamentals WHERE stock_code = $1 AND period_type = $2 AND period_end = $3::date`
	vals := make([]*float64, len(names))
	var r sfRow
	var fsText string
	dest := []any{&r.currency, &r.source, &fsText, &r.docURL, &r.updatedAt}
	for i := range vals {
		dest = append(dest, &vals[i])
	}
	if err := pool.QueryRow(context.Background(), q, code, typ, end).Scan(dest...); err != nil {
		return sfRow{}, false
	}
	r.vals = map[string]*float64{}
	for i, n := range names {
		r.vals[n] = vals[i]
	}
	require.NoError(t, json.Unmarshal([]byte(fsText), &r.fs))
	return r, true
}

func (r sfRow) v(t *testing.T, col string) float64 {
	t.Helper()
	require.NotNil(t, r.vals[col], col)
	return *r.vals[col]
}

func pgExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err, sql)
}

func TestVendorUpsertRulesAgainstPostgres(t *testing.T) {
	st, pool := vendorPG(t, true)
	ctx := context.Background()
	now := time.Now()
	up := func(code string, rows ...PeriodRow) {
		t.Helper()
		for i := range rows {
			if rows[i].Source == "" {
				rows[i].Source = sourceYahoo
			}
			if rows[i].Currency == "" {
				rows[i].Currency = "AUD"
			}
		}
		require.NoError(t, st.UpsertPeriods(ctx, code, rows, now))
	}
	yr := func(end string) PeriodRow { return PeriodRow{PeriodType: periodAnnual, PeriodEnd: date(end)} }

	// Stored state, as earlier runs (and the filings ingest) left it.
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source,
		revenue, net_income, eps_basic, gross_profit, free_cash_flow, field_sources) VALUES
		('ZZV1', 'annual', '2024-06-30', 'AUD', 'yahoo-timeseries', 90, 9, 0.9, 40, 3,
		 '{"revenue":"markit-key-statistics","net_income":"asx-filing-extraction","gross_profit":"derived:ttm-at-fye"}')`)
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, revenue, eps_basic)
		VALUES ('ZZV1', 'ttm', '2024-12-31', 'AUD', 'yahoo-timeseries', 50, 0.5)`)
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, total_equity, shares_outstanding)
		VALUES ('ZZV1', 'quarter', '2024-12-31', 'AUD', 'yahoo-timeseries', 70, 7)`)

	// Rules 3 and 4: nothing supplied for those fields this run.
	fy24 := yr("2024-06-30")
	fy24.FreeCashFlow = f64(5)
	ttm := PeriodRow{PeriodType: periodTTM, PeriodEnd: date("2024-12-31"), EPSBasic: f64(0.55)}
	snap := PeriodRow{PeriodType: periodQuarter, PeriodEnd: date("2024-12-31"), SharesOutstanding: f64(7.5)}
	up("ZZV1", fy24, ttm, snap)
	r, ok := readSF(t, pool, "ZZV1", periodAnnual, "2024-06-30")
	require.True(t, ok)
	assert.Equal(t, 90.0, r.v(t, "revenue"), "rule 3: a Markit fill is kept")
	assert.Equal(t, 9.0, r.v(t, "net_income"), "rule 3: a filing fill is kept")
	assert.Nil(t, r.vals["eps_basic"], "rule 4: an annual value the vendor stopped publishing is NULL")
	assert.Nil(t, r.vals["gross_profit"], "rule 4: a derived value not derived again is NULL")
	assert.Equal(t, 5.0, r.v(t, "free_cash_flow"), "rule 1")
	assert.Equal(t, map[string]string{"revenue": sourceMarkit, "net_income": sourceFiling}, r.fs)
	r, _ = readSF(t, pool, "ZZV1", periodTTM, "2024-12-31")
	assert.Equal(t, 50.0, r.v(t, "revenue"), "rule 3: TTM history is kept")
	assert.Equal(t, 0.55, r.v(t, "eps_basic"))
	r, _ = readSF(t, pool, "ZZV1", periodQuarter, "2024-12-31")
	assert.Equal(t, 70.0, r.v(t, "total_equity"), "rule 3: a snapshot keeps what this fetch lacks")
	assert.Equal(t, 7.5, r.v(t, "shares_outstanding"))

	// Rule 1: the vendor supplies it (with this run's marker, or none).
	fy24 = yr("2024-06-30")
	fy24.Revenue, fy24.NetIncome = f64(95), f64(11)
	fy24.FieldSources = map[string]string{"net_income": sourceMarkit}
	up("ZZV1", fy24)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2024-06-30")
	assert.Equal(t, 95.0, r.v(t, "revenue"))
	assert.Equal(t, 11.0, r.v(t, "net_income"))
	assert.Equal(t, map[string]string{"net_income": sourceMarkit}, r.fs, "revenue's old marker is gone; this run's is recorded")

	// Rule 2: a Rejected field is NULL, over a kept marker and over TTM history.
	fy24 = yr("2024-06-30")
	fy24.EPSBasic, fy24.Rejected = f64(1), []string{"net_income", "free_cash_flow"}
	ttm = PeriodRow{PeriodType: periodTTM, PeriodEnd: date("2024-12-31"), EPSBasic: f64(0.55), Rejected: []string{"revenue"}}
	up("ZZV1", fy24, ttm)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2024-06-30")
	assert.Nil(t, r.vals["net_income"])
	assert.Nil(t, r.vals["free_cash_flow"])
	assert.Empty(t, r.fs)
	r, _ = readSF(t, pool, "ZZV1", periodTTM, "2024-12-31")
	assert.Nil(t, r.vals["revenue"], "a gate beats the TTM history rule")

	// Rule 5: a filing row.
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source,
		revenue, net_income, eps_basic, source_document_url, source_document_date)
		VALUES ('ZZV1', 'annual', '2023-06-30', 'AUD', 'asx-filing-extraction', 10, 1, 0.1, 'https://www.asx.com.au/x.pdf', '2023-08-20')`)
	before, _ := readSF(t, pool, "ZZV1", periodAnnual, "2023-06-30")
	fy23 := yr("2023-06-30")
	fy23.EPSBasic, fy23.TotalAssets = f64(0.11), f64(5)
	up("ZZV1", fy23)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2023-06-30")
	assert.Equal(t, sourceFiling, r.source, "no revenue or net income supplied: the filing row is untouched")
	assert.Equal(t, 0.1, r.v(t, "eps_basic"))
	assert.Nil(t, r.vals["total_assets"])
	assert.Equal(t, before.updatedAt, r.updatedAt)

	fy23 = yr("2023-06-30")
	fy23.Revenue, fy23.TotalAssets = f64(10.2), f64(5)
	up("ZZV1", fy23)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2023-06-30")
	assert.Equal(t, sourceYahoo, r.source, "revenue supplied: the vendor takes the row over")
	assert.Equal(t, 10.2, r.v(t, "revenue"))
	assert.Equal(t, 1.0, r.v(t, "net_income"), "the filing's values it lacks survive...")
	assert.Equal(t, 0.1, r.v(t, "eps_basic"))
	assert.Equal(t, map[string]string{"net_income": sourceFiling, "eps_basic": sourceFiling}, r.fs, "...marked as the filing's")
	require.NotNil(t, r.docURL)
	assert.Equal(t, "https://www.asx.com.au/x.pdf", *r.docURL, "and the document they came from")

	fy23.NetIncome, fy23.EPSBasic = f64(1.1), f64(0.12)
	up("ZZV1", fy23)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2023-06-30")
	assert.Empty(t, r.fs)
	assert.Nil(t, r.docURL, "no value points at the filing any more")

	// Rule 6: a currency change replaces the row and its markers.
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, revenue, net_income, field_sources)
		VALUES ('ZZV1', 'annual', '2022-06-30', 'AUD', 'yahoo-timeseries', 5, 1, '{"net_income":"markit-key-statistics"}')`)
	fy22 := yr("2022-06-30")
	fy22.Currency, fy22.Revenue = "USD", f64(4)
	up("ZZV1", fy22)
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2022-06-30")
	assert.Equal(t, "USD", r.currency)
	assert.Equal(t, 4.0, r.v(t, "revenue"))
	assert.Nil(t, r.vals["net_income"], "never keep an AUD figure in a USD row")
	assert.Empty(t, r.fs)

	// A Markit row never takes over a Yahoo row.
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, revenue)
		VALUES ('ZZV1', 'annual', '2021-06-30', 'AUD', 'yahoo-timeseries', 3)`)
	up("ZZV1", PeriodRow{PeriodType: periodAnnual, PeriodEnd: date("2021-06-30"), Source: sourceMarkit, Revenue: f64(999)})
	r, _ = readSF(t, pool, "ZZV1", periodAnnual, "2021-06-30")
	assert.Equal(t, sourceYahoo, r.source)
	assert.Equal(t, 3.0, r.v(t, "revenue"))

	// A mask never inserts an empty row.
	up("ZZV1", PeriodRow{PeriodType: periodAnnual, PeriodEnd: date("2020-06-30"), Rejected: []string{"revenue"}})
	_, ok = readSF(t, pool, "ZZV1", periodAnnual, "2020-06-30")
	assert.False(t, ok)

	// A Markit year Yahoo now publishes under a 52/53-week date is pruned.
	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, revenue) VALUES
		('ZZV2', 'annual', '2026-06-28', 'AUD', 'markit-key-statistics', 1),
		('ZZV2', 'annual', '2026-06-10', 'AUD', 'markit-key-statistics', 1),
		('ZZV3', 'annual', '2026-06-28', 'AUD', 'markit-key-statistics', 1)`)
	fy26 := yr("2026-06-30")
	fy26.Revenue = f64(2)
	up("ZZV2", fy26)
	_, ok = readSF(t, pool, "ZZV2", periodAnnual, "2026-06-28")
	assert.False(t, ok, "the same fiscal year is never stored twice")
	_, ok = readSF(t, pool, "ZZV2", periodAnnual, "2026-06-10")
	assert.True(t, ok, "18 days apart is another period")
	_, ok = readSF(t, pool, "ZZV3", periodAnnual, "2026-06-28")
	assert.True(t, ok, "another code's rows are never touched")

	// The whole BHP capture goes through in one statement.
	res := pipeline(t, "BHP", fixtureRows(t, "yahoo_full_BHP.json"), nil)
	require.NoError(t, st.UpsertPeriods(ctx, "BHP", res.rows, now))
	r, ok = readSF(t, pool, "BHP", periodQuarter, "2025-12-31")
	require.True(t, ok)
	assert.Equal(t, 116012000000.0, r.v(t, "total_assets"))
	assert.Nil(t, r.vals["revenue"])
}

func TestVendorSyncAndLeaseAgainstPostgres(t *testing.T) {
	st, pool := vendorPG(t, true)
	ctx := context.Background()
	t0 := time.Date(2026, 9, 1, 15, 0, 0, 0, time.UTC)
	k := 10.02
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "RMD", At: t0, Outcome: outcomeEmpty, Err: "no fundamentals published: yahoo: none"}))
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "RMD", At: t0.Add(time.Hour), Outcome: outcomeEmpty, Err: "no fundamentals published: yahoo: none"}))
	states, err := st.SyncStates(ctx)
	require.NoError(t, err)
	assert.Equal(t, outcomeEmpty, states["RMD"].LastOutcome)
	assert.Equal(t, 2, states["RMD"].ConsecutiveEmpty)

	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "RMD", At: t0.Add(2 * time.Hour), Success: true, Outcome: outcomeLoaded, PeriodsLoaded: 12, Measured: true, MedianK: &k}))
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "RMD", At: t0.Add(3 * time.Hour), Outcome: outcomeFailed, Err: "yahoo: 429"}))
	var outcome string
	var empties int16
	var median *float64
	var lastSuccess time.Time
	var periods int
	require.NoError(t, pool.QueryRow(ctx, `SELECT last_outcome, consecutive_empty, median_k, last_success_at, periods_loaded FROM stock_fundamentals_sync WHERE stock_code = 'RMD'`).
		Scan(&outcome, &empties, &median, &lastSuccess, &periods))
	assert.Equal(t, outcomeFailed, outcome)
	assert.Zero(t, empties, "reset by anything but an empty answer")
	require.NotNil(t, median)
	assert.Equal(t, k, *median, "a failed attempt keeps the stored median_k")

	// fx_converted and native_currency: NULL until measured, written by a
	// measured attempt, kept by one that measured nothing.
	var fx *bool
	var native *string
	require.NoError(t, pool.QueryRow(ctx, `SELECT fx_converted, native_currency FROM stock_fundamentals_sync WHERE stock_code = 'RMD'`).Scan(&fx, &native))
	require.NotNil(t, fx)
	assert.False(t, *fx)
	assert.Nil(t, native)
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "XRO", At: t0, Outcome: outcomeEmpty}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT fx_converted, native_currency FROM stock_fundamentals_sync WHERE stock_code = 'XRO'`).Scan(&fx, &native))
	assert.Nil(t, fx, "never measured: unknown, not false")
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "XRO", At: t0.Add(time.Hour), Success: true, Outcome: outcomeLoaded, PeriodsLoaded: 4, Measured: true, FXConverted: true, NativeCurrency: "NZD"}))
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "XRO", At: t0.Add(2 * time.Hour), Outcome: outcomeFailed, Err: "yahoo: 429"}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT fx_converted, native_currency FROM stock_fundamentals_sync WHERE stock_code = 'XRO'`).Scan(&fx, &native))
	require.NotNil(t, fx)
	assert.True(t, *fx, "a failed attempt keeps the stored flag")
	require.NotNil(t, native)
	assert.Equal(t, "NZD", *native)
	assert.True(t, lastSuccess.Equal(t0.Add(2*time.Hour)), "a failure never hides the last success")
	assert.Equal(t, 12, periods)

	// Rows written before 000132's columns existed derive their outcome.
	pgExec(t, pool, `INSERT INTO stock_fundamentals_sync (stock_code, last_attempt_at, last_success_at, last_error, periods_loaded)
		VALUES ('OLDE', now(), NULL, 'no fundamentals published: yahoo: none', 0)`)
	states, err = st.SyncStates(ctx)
	require.NoError(t, err)
	assert.Equal(t, outcomeEmpty, states["OLDE"].LastOutcome)

	// The lease.
	claimed, _, err := st.ClaimLease(ctx, "exec-a")
	require.NoError(t, err)
	assert.True(t, claimed)
	claimed, holder, err := st.ClaimLease(ctx, "exec-b")
	require.NoError(t, err)
	assert.False(t, claimed)
	assert.Contains(t, holder, "exec-a")
	claimed, _, err = st.ClaimLease(ctx, "exec-a")
	require.NoError(t, err)
	assert.True(t, claimed, "a task retry of the same execution takes it back")
	require.NoError(t, st.ExtendLease(ctx, "exec-a"))
	pgExec(t, pool, `UPDATE picks_run_lease SET expires_at = now() - interval '1 minute'`)
	claimed, _, err = st.ClaimLease(ctx, "exec-b")
	require.NoError(t, err)
	assert.True(t, claimed, "an expired lease is free")
	require.NoError(t, st.ReleaseLease(ctx, "exec-a"))
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM picks_run_lease`).Scan(&n))
	assert.Equal(t, 1, n, "a run never deletes another execution's lease")
	require.NoError(t, st.ReleaseLease(ctx, "exec-b"))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM picks_run_lease`).Scan(&n))
	assert.Zero(t, n)
}

func TestVendorWithout000132AgainstPostgres(t *testing.T) {
	st, pool := vendorPG(t, false)
	ctx := context.Background()
	fund, syncExt, err := st.schema(ctx)
	require.NoError(t, err)
	assert.False(t, fund)
	assert.False(t, syncExt)

	pgExec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, source, revenue, net_income)
		VALUES ('ZZL1', 'annual', '2025-06-30', 'AUD', 'yahoo-timeseries', 5351000, 3270000)`)
	rows := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(0.39),
			TotalAssets: f64(1), Rejected: []string{"revenue", "net_income", "total_assets"}},
		{PeriodType: periodQuarter, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo, TotalEquity: f64(7)},
	}
	require.NoError(t, st.UpsertPeriods(ctx, "ZZL1", rows, time.Now()))
	var rev, ni, eps *float64
	require.NoError(t, pool.QueryRow(ctx, `SELECT revenue, net_income, eps_basic FROM stock_fundamentals WHERE stock_code = 'ZZL1' AND period_type = 'annual'`).
		Scan(&rev, &ni, &eps))
	assert.Nil(t, rev, "the mask applies on the 000129 column set too")
	assert.Nil(t, ni)
	assert.Equal(t, 0.39, *eps)
	var quarters int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_fundamentals WHERE period_type = 'quarter'`).Scan(&quarters))
	assert.Zero(t, quarters, "a snapshot carries only 000132 columns: not written without them")

	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "ZZL1", At: time.Now(), Success: true, Outcome: outcomeLoaded, PeriodsLoaded: 1, Measured: true, MedianK: f64(1)}))
	states, err := st.SyncStates(ctx)
	require.NoError(t, err)
	assert.Equal(t, outcomeLoaded, states["ZZL1"].LastOutcome)

	_, _, err = st.ClaimLease(ctx, "exec-a")
	assert.ErrorIs(t, err, errLeaseAbsent)
	require.NoError(t, st.ExtendLease(ctx, "exec-a"))
	require.NoError(t, st.ReleaseLease(ctx, "exec-a"))

	// A stale belief that 000132 is there is corrected by the 42703.
	st.schemaMu.Lock()
	st.fundExtended, st.syncExtended = true, true
	st.schemaMu.Unlock()
	require.NoError(t, st.UpsertPeriods(ctx, "ZZL2", []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo, Revenue: f64(9)},
	}, time.Now()))
	require.NoError(t, st.RecordAttempt(ctx, attempt{Code: "ZZL2", At: time.Now(), Success: true, Outcome: outcomeLoaded}))
	fund, syncExt, _ = st.schema(ctx)
	assert.False(t, fund)
	assert.False(t, syncExt)
}
