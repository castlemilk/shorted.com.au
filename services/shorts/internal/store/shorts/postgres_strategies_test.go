package shorts

import (
	"errors"
	"math"
	"regexp"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5/pgconn"
)

// selectList returns the top-level comma-separated expressions between the
// first SELECT and the first top-level FROM of query.
func selectList(t *testing.T, query string) []string {
	t.Helper()
	upper := strings.ToUpper(query)
	start := strings.Index(upper, "SELECT")
	if start < 0 {
		t.Fatalf("no SELECT in query")
	}
	body := query[start+len("SELECT"):]
	var (
		parts []string
		depth int
		cur   strings.Builder
		inStr bool
	)
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if ch == '\'' {
			inStr = !inStr
		}
		if !inStr {
			switch ch {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth == 0 && i+6 <= len(body) && strings.EqualFold(body[i:i+6], " FROM ") ||
				depth == 0 && i+5 <= len(body) && (strings.EqualFold(body[i:i+5], "\nFROM") || strings.EqualFold(body[i:i+5], "\tFROM")) {
				parts = append(parts, strings.TrimSpace(cur.String()))
				return parts
			}
			if depth == 0 && ch == ',' {
				parts = append(parts, strings.TrimSpace(cur.String()))
				cur.Reset()
				continue
			}
		}
		cur.WriteByte(ch)
	}
	t.Fatalf("no top-level FROM in query")
	return nil
}

// A scan target list that drifts from its SELECT list fails at runtime on
// every row. Pin both counts here so it fails in CI instead.
func TestStrategyQueriesScanEveryColumn(t *testing.T) {
	var row candidateRow
	if got, want := len(selectList(t, strategyCandidatesQuery)), len(row.targets()); got != want {
		t.Errorf("strategyCandidatesQuery selects %d columns, candidateRow scans %d", got, want)
	}
	var g strategies.Growth
	if got, want := len(selectList(t, fundamentalsGrowthQuery)), len(growthScanTargets(&g)); got != want {
		t.Errorf("fundamentalsGrowthQuery selects %d columns, growthScanTargets scans %d", got, want)
	}
	if got := len(selectList(t, marketRegimeQuery)); got != 9 {
		t.Errorf("marketRegimeQuery selects %d columns, GetMarketRegime scans 9", got)
	}
	q, _ := buildFundamentalsQuery("BHP", "", 12)
	if got := len(selectList(t, q)); got != 14 {
		t.Errorf("fundamentals query selects %d columns, GetStockFundamentals scans 14", got)
	}
}

// The data stream builds these views from docs/plans/stock-picker.md §2; the
// names here are that contract. A rename on either side must be deliberate.
func TestStrategyCandidatesQueryReadsThePlannedColumns(t *testing.T) {
	priceFeatures := []string{
		"stock_code", "as_of", "close", "prev_close",
		"sma10", "sma20", "sma50", "sma150", "sma200", "sma200_1m_ago",
		"high_52w", "low_52w", "pct_off_52w_high", "pct_above_52w_low",
		"volume", "avg_volume_50d", "volume_ratio_50d", "dollar_volume_20d",
		"base_high", "base_low", "base_depth_pct", "base_length_days",
		"breakout_recent", "breakout_date",
		"ret_1m_pct", "ret_3m_pct", "ret_6m_pct", "ret_12m_pct",
		"rs_3m_pct", "rs_6m_pct", "sessions_available",
	}
	growth := []string{
		"stock_code", "basis_period_type", "latest_period_end", "latest_annual_period_end",
		"revenue_latest", "revenue_prior", "revenue_yoy_pct", "revenue_yoy_prior_pct",
		"eps_latest", "eps_prior", "eps_yoy_pct", "eps_yoy_prior_pct",
		"net_income_latest", "net_income_prior", "net_income_positive",
		"operating_cash_flow_latest",
		"revenue_ttm", "net_income_ttm", "eps_ttm",
		"revenue_half_delta", "net_income_half_delta",
		"currency", "periods_available", "fetched_at",
		"revenue_basis_period_type", "revenue_half_yoy_pct", "net_income_half_yoy_pct",
		"eps_half_yoy_pct", "half_latest_period_end",
	}
	screener := []string{"company_name", "industry", "logo_url", "short_pct", "days_to_cover", "avg_volume_20d", "market_cap"}
	metadata := []string{"company_name", "industry", "logo_icon_gcs_url", "logo_gcs_url", "key_metrics"}

	for alias, cols := range map[string][]string{"pf": priceFeatures, "g": growth, "sd": screener, "cm": metadata} {
		for _, col := range cols {
			if !regexp.MustCompile(`\b` + alias + `\.` + col + `\b`).MatchString(strategyCandidatesQuery) {
				t.Errorf("strategyCandidatesQuery does not read %s.%s", alias, col)
			}
		}
	}
	for _, clause := range []string{
		"FROM mv_price_features pf",
		"LEFT JOIN mv_fundamentals_growth g ON",
		"LEFT JOIN mv_screener_data sd ON",
		`LEFT JOIN "company-metadata" cm ON`,
	} {
		if !strings.Contains(strategyCandidatesQuery, clause) {
			t.Errorf("strategyCandidatesQuery is missing %q", clause)
		}
	}
	// Zeros that mean "unknown" in mv_screener_data must not reach the evaluator as zeros.
	for _, guard := range []string{"NULLIF(sd.market_cap::float8, 0)", "CASE WHEN sd.avg_volume_20d > 0 THEN sd.days_to_cover::float8 END"} {
		if !strings.Contains(strategyCandidatesQuery, guard) {
			t.Errorf("strategyCandidatesQuery is missing the unknown-zero guard %q", guard)
		}
	}

	for _, col := range []string{"index_code", "as_of", "close", "sma50", "sma200", "pct_off_52w_high", "ret_1m_pct", "ret_3m_pct", "regime"} {
		if !regexp.MustCompile(`\b` + col + `\b`).MatchString(marketRegimeQuery) {
			t.Errorf("marketRegimeQuery does not read %s", col)
		}
	}
	if !strings.Contains(marketRegimeQuery, "FROM mv_market_regime") {
		t.Error("marketRegimeQuery must read mv_market_regime")
	}
}

func TestBuildFundamentalsQuery(t *testing.T) {
	placeholders := regexp.MustCompile(`\$(\d+)`)
	check := func(query string, args []any) {
		t.Helper()
		seen := map[string]bool{}
		for _, m := range placeholders.FindAllStringSubmatch(query, -1) {
			seen[m[1]] = true
		}
		for i := 1; i <= len(args); i++ {
			if !seen[string(rune('0'+i))] {
				t.Errorf("placeholder $%d missing; placeholders must be contiguous $1..$%d:\n%s", i, len(args), query)
			}
		}
		if len(seen) != len(args) {
			t.Errorf("%d distinct placeholders for %d args", len(seen), len(args))
		}
	}

	q, args := buildFundamentalsQuery("BHP", "", 12)
	check(q, args)
	if len(args) != 2 || args[0] != "BHP" || args[1] != int32(12) {
		t.Errorf("args = %v", args)
	}
	if strings.Contains(q, "period_type = $") {
		t.Error("no period filter was asked for")
	}

	q, args = buildFundamentalsQuery("BHP", "ttm", 4)
	check(q, args)
	if len(args) != 3 || args[1] != "ttm" || args[2] != int32(4) {
		t.Errorf("args = %v", args)
	}
	if !strings.Contains(q, "period_type = $2") || !strings.Contains(q, "LIMIT $3") {
		t.Errorf("unexpected filter/limit placeholders:\n%s", q)
	}

	// An unvalidated value is dropped, never interpolated.
	q, args = buildFundamentalsQuery("BHP", "annual'; DROP TABLE x; --", 4)
	check(q, args)
	if strings.Contains(q, "DROP") || len(args) != 2 {
		t.Errorf("an unknown period type must be ignored: %v\n%s", args, q)
	}

	for _, col := range []string{"stock_code", "period_type", "period_end", "fiscal_year", "currency", "revenue", "net_income",
		"eps_basic", "eps_diluted", "operating_cash_flow", "free_cash_flow", "shares_outstanding", "source", "source_fetched_at"} {
		if !regexp.MustCompile(`\b` + col + `\b`).MatchString(q) {
			t.Errorf("fundamentals query does not read %s", col)
		}
	}
	if !strings.Contains(q, "FROM stock_fundamentals") || !strings.Contains(q, "ORDER BY period_end DESC") {
		t.Errorf("fundamentals query must read stock_fundamentals newest first:\n%s", q)
	}
}

func TestFundamentalsPeriodTypesMatchTheTableCheck(t *testing.T) {
	want := []string{"annual", "half", "quarter", "ttm"}
	if len(FundamentalsPeriodTypes) != len(want) {
		t.Fatalf("FundamentalsPeriodTypes = %v", FundamentalsPeriodTypes)
	}
	for _, pt := range want {
		if !FundamentalsPeriodTypes[pt] {
			t.Errorf("%q missing", pt)
		}
	}
}

func TestFiniteDropsNonFiniteValues(t *testing.T) {
	v := func(x float64) *float64 { return &x }
	if finite(nil) != nil || finite(v(math.NaN())) != nil || finite(v(math.Inf(1))) != nil || finite(v(math.Inf(-1))) != nil {
		t.Error("non-finite values must become nil")
	}
	if got := finite(v(-0.5)); got == nil || *got != -0.5 {
		t.Error("finite values pass through")
	}

	c := strategies.Candidate{Close: math.NaN(), SMA50: v(math.Inf(1)), ShortPct: v(7), MarketCap: v(math.NaN())}
	sanitiseCandidate(&c)
	if c.Close != 0 || c.SMA50 != nil || c.MarketCap != nil || c.ShortPct == nil {
		t.Errorf("sanitiseCandidate: %+v", c)
	}
	g := strategies.Growth{RevenueYoYPct: v(math.Inf(1)), EPSYoYPct: v(12)}
	sanitiseGrowth(&g)
	if g.RevenueYoYPct != nil || g.EPSYoYPct == nil {
		t.Errorf("sanitiseGrowth: %+v", g)
	}
}

func TestUndefinedTableDetectionIsTheOnlyEmptyPath(t *testing.T) {
	if !isUndefinedTable(&pgconn.PgError{Code: "42P01"}) {
		t.Fatal("42P01 must be recognised")
	}
	for _, err := range []error{&pgconn.PgError{Code: "42703"}, &pgconn.PgError{Code: "57014"}, errors.New("timeout")} {
		if isUndefinedTable(err) {
			t.Errorf("%v must be returned as an error, not served as an empty result", err)
		}
	}
	// Logging once per method must not panic when called repeatedly.
	for i := 0; i < 3; i++ {
		logMissingRelationOnce("TestMethod", errors.New("relation does not exist"))
	}
}
