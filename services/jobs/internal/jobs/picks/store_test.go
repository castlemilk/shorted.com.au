package picks

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// No database here: these pin the SQL's shape and the argument arrays, and
// prove the arrays render as Postgres array literals WITH NULL elements under
// the simple protocol platform.Connect forces (pgx encodes each argument via
// pgtype.Map.Encode(0, text, ...) and interpolates it).

func TestUpsertArgsLineUpWithTheStatement(t *testing.T) {
	rows := fixtureRows(t, "yahoo_timeseries_DRO.json")
	assignFiscalYears(rows)
	fetched := time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC)
	args := upsertArgs("DRO", rows, fetched)

	placeholders := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(upsertSQL, -1) {
		placeholders[m[1]] = true
	}
	assert.Len(t, placeholders, len(args), "every argument is used and every placeholder has one")

	assert.Equal(t, "DRO", args[0])
	assert.Equal(t, fetched, args[1])
	n := len(rows)
	for i := 2; i < len(args); i++ {
		switch a := args[i].(type) {
		case []string:
			assert.Len(t, a, n, "arg %d", i+1)
		case []*float64:
			assert.Len(t, a, n, "arg %d", i+1)
		case []*int16:
			assert.Len(t, a, n, "arg %d", i+1)
		default:
			t.Fatalf("arg %d has unexpected type %T", i+1, a)
		}
	}

	// The unnest column order matches the argument order: period_type,
	// period_end, fiscal_year, currency, revenue, net_income, eps_basic,
	// eps_diluted, ocf, fcf, shares, source.
	idx := -1
	for i, r := range rows {
		if r.PeriodType == periodAnnual && r.PeriodEnd.Equal(date("2025-12-31")) {
			idx = i
		}
	}
	require.GreaterOrEqual(t, idx, 0)
	assert.Equal(t, periodAnnual, args[2].([]string)[idx])
	assert.Equal(t, "2025-12-31", args[3].([]string)[idx])
	assert.Equal(t, int16(2025), *args[4].([]*int16)[idx])
	assert.Equal(t, "AUD", args[5].([]string)[idx])
	assert.Equal(t, 216547000.0, *args[6].([]*float64)[idx])
	assert.Equal(t, 3521000.0, *args[7].([]*float64)[idx])
	assert.Nil(t, args[10].([]*float64)[idx], "DRO has no OCF: a NULL element, not 0")
	assert.Equal(t, sourceYahoo, args[13].([]string)[idx])

	m := pgtype.NewMap()
	enc, err := m.Encode(0, pgtype.TextFormatCode, args[10], nil)
	require.NoError(t, err)
	assert.Contains(t, string(enc), "NULL", "missing values reach Postgres as NULL")
	enc, err = m.Encode(0, pgtype.TextFormatCode, args[4], nil)
	require.NoError(t, err)
	assert.Contains(t, string(enc), "2025")
}

func TestUpsertSQLShape(t *testing.T) {
	sql := strings.Join(strings.Fields(upsertSQL), " ")
	assert.Contains(t, sql, "ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET")
	assert.Contains(t, sql, "FROM unnest(")
	assert.Equal(t, 1, strings.Count(sql, "INSERT INTO"), "one statement per code")
	for _, col := range []string{"revenue", "net_income", "eps_basic", "eps_diluted", "operating_cash_flow", "free_cash_flow", "shares_outstanding"} {
		assert.Contains(t, sql,
			col+" = CASE WHEN EXCLUDED.currency = f.currency THEN COALESCE(EXCLUDED."+col+", f."+col+") ELSE EXCLUDED."+col+" END",
			"%s keeps the stored value only within one currency", col)
	}
}

func TestRecordAttemptSQLKeepsLastSuccess(t *testing.T) {
	sql := strings.Join(strings.Fields(recordAttemptSQL), " ")
	assert.Contains(t, sql, "ON CONFLICT (stock_code) DO UPDATE SET")
	assert.Contains(t, sql, "last_success_at = CASE WHEN $3::bool THEN EXCLUDED.last_attempt_at ELSE s.last_success_at END")
	assert.Contains(t, sql, "periods_loaded = CASE WHEN $3::bool THEN EXCLUDED.periods_loaded ELSE s.periods_loaded END")
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

func TestUndefinedTable(t *testing.T) {
	assert.True(t, undefinedTable(&pgconn.PgError{Code: "42P01"}))
	assert.False(t, undefinedTable(&pgconn.PgError{Code: "42703"}))
	assert.False(t, undefinedTable(nil))
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
}
