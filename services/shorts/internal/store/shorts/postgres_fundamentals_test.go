package shorts

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ---------------------------------------------------------------- a fake database

// fakeDB answers each query from respond, keyed on the SQL text. It stands in
// for Postgres the way a schema without migration 000132 answers: 42P01 for a
// missing relation, 42703 for a missing column.
type fakeDB struct {
	respond func(sql string) ([][]any, error)
	queries []string
}

func (f *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	f.queries = append(f.queries, sql)
	rows, err := f.respond(sql)
	if err != nil {
		return nil, err
	}
	return &fakeRows{rows: rows}, nil
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	f.queries = append(f.queries, sql)
	rows, err := f.respond(sql)
	switch {
	case err != nil:
		return fakeRow{err: err}
	case len(rows) == 0:
		return fakeRow{err: pgx.ErrNoRows}
	}
	return fakeRow{values: rows[0]}
}

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	return assignRow(r.values, dest)
}

type fakeRows struct {
	rows [][]any
	i    int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return r.rows[r.i-1], nil }
func (r *fakeRows) Scan(dest ...any) error                       { return assignRow(r.rows[r.i-1], dest) }
func (r *fakeRows) Next() bool {
	if r.i < len(r.rows) {
		r.i++
		return true
	}
	return false
}

// assignRow scans values into dest the strict way: a value must be exactly
// the scan target's type (or its pointee's), so a fixture that drifts from
// the select list fails loudly.
func assignRow(values, dest []any) error {
	if len(values) != len(dest) {
		return fmt.Errorf("row has %d values, scan has %d targets", len(values), len(dest))
	}
	for i := range dest {
		target := reflect.ValueOf(dest[i]).Elem()
		if values[i] == nil {
			target.Set(reflect.Zero(target.Type()))
			continue
		}
		v := reflect.ValueOf(values[i])
		if target.Kind() == reflect.Pointer && v.Type() == target.Type().Elem() {
			p := reflect.New(v.Type())
			p.Elem().Set(v)
			target.Set(p)
			continue
		}
		if v.Type() != target.Type() {
			return fmt.Errorf("column %d: cannot scan %T into %s", i, values[i], target.Type())
		}
		target.Set(v)
	}
	return nil
}

// rowFrom reads the values a set of scan targets currently hold: the inverse
// of a scan, so fixtures are built from the structs the store scans into.
func rowFrom(targets []any) []any {
	out := make([]any, len(targets))
	for i, t := range targets {
		v := reflect.ValueOf(t).Elem()
		switch {
		case v.Kind() == reflect.Pointer && v.IsNil():
			out[i] = nil
		case v.Kind() == reflect.Pointer:
			out[i] = v.Elem().Interface()
		default:
			out[i] = v.Interface()
		}
	}
	return out
}

func pgErr(code string) error { return &pgconn.PgError{Code: code, Message: "fake " + code} }

func tp(s string) *time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return &t
}

// A candidate row as strategyCandidatesQuery returns it.
func fakeCandidateRow(code string) []any {
	var row candidateRow
	row.c.StockCode = code
	row.asOf = tp("2026-09-25")
	row.closePx = fp(45)
	row.c.SMA200 = fp(40)
	row.c.DollarVolume20d = fp(5e7)
	row.c.Industry = "Materials"
	row.hasGrowth = true
	row.g.BasisPeriodType = "ttm"
	row.g.RevenueYoYPct = fp(12)
	row.g.Currency = "USD"
	return rowFrom(row.targets())
}

// A stock_fundamentals row in the 000129 column list.
func fakeBasePeriodRow() []any {
	fy := int32(2026)
	return []any{"BHP", "annual", *tp("2026-06-30"), fy, "USD",
		5.5e10, 1.1e10, 2.2, 2.19, nil, 9e9, 5.07e9, "yahoo-timeseries", *tp("2026-09-01")}
}

const (
	sqlCandidates       = "FROM mv_price_features pf"
	sqlExtras           = "mv_fundamentals_quality"
	sqlExtendedPeriods  = "gross_profit::float8"
	sqlPeriods          = "FROM stock_fundamentals\n\tWHERE"
	sqlCoverage         = "stock_fundamentals_sync s ON"
	sqlCoverageOutcome  = "s.last_outcome"
	sqlFilingContext    = `FROM "company-metadata" cm WHERE cm.stock_code = $1`
	sqlFilingCandidates = "FROM financial_report_extractions e"
	sqlDocumentMeta     = "e.document_meta"
)

// without000132 answers like a database that has 000129-000131 but not 000132:
// the 000132 relation is missing (42P01) and the 000132 columns are too
// (42703). Every read must still succeed, with nil extras.
func without000132(missingView string) func(sql string) ([][]any, error) {
	return func(sql string) ([][]any, error) {
		switch {
		case strings.Contains(sql, sqlExtras):
			return nil, pgErr(missingView)
		case strings.Contains(sql, sqlCandidates):
			return [][]any{fakeCandidateRow("BHP"), fakeCandidateRow("CBA")}, nil
		case strings.Contains(sql, sqlExtendedPeriods):
			return nil, pgErr("42703")
		case strings.Contains(sql, sqlPeriods):
			return [][]any{fakeBasePeriodRow()}, nil
		case strings.Contains(sql, sqlCoverage) && strings.Contains(sql, sqlCoverageOutcome):
			return nil, pgErr("42703")
		case strings.Contains(sql, sqlCoverage):
			return [][]any{{[]string{"yahoo-timeseries"}, true, *tp("2026-09-27"), *tp("2026-09-27"), ""}}, nil
		case strings.Contains(sql, sqlFilingContext):
			return [][]any{{*tp("2026-06-30"), *tp("2026-06-30"), "BHP GROUP LIMITED"}}, nil
		case strings.Contains(sql, sqlFilingCandidates) && strings.Contains(sql, sqlDocumentMeta):
			return nil, pgErr("42703")
		case strings.Contains(sql, sqlFilingCandidates):
			return [][]any{{"https://asx/bhp-4e.pdf", "Appendix 4E and Annual Report", *tp("2026-08-19"), "BHP lifted copper output.", 0.9, ""}}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", sql)
	}
}

// Plan fundamentals-coverage.md §5.3: against a schema without 000132 the
// universe and fundamentals return with nil extras.
func TestFundamentalsReadsDegradeWithout000132(t *testing.T) {
	for _, missing := range []string{"42P01", "42703"} {
		t.Run("extras answer "+missing, func(t *testing.T) {
			db := &fakeDB{respond: without000132(missing)}
			ctx := context.Background()

			cands, err := listStrategyCandidates(ctx, db)
			if err != nil {
				t.Fatalf("universe: %v", err)
			}
			if len(cands) != 2 || cands[0].StockCode != "BHP" || cands[0].Close != 45 || cands[0].Growth == nil {
				t.Fatalf("the universe must be served whole: %+v", cands)
			}
			for _, c := range cands {
				if c.Quality != nil || c.ValuationInputs != nil || c.Growth.RevenueBasisSource != "" || c.Growth.RevenueLatestPeriodEnd != nil {
					t.Errorf("%s: extras must be nil without 000132: %+v", c.StockCode, c)
				}
			}

			periods, err := getStockFundamentals(ctx, db, "BHP", "", 40)
			if err != nil {
				t.Fatalf("periods: %v", err)
			}
			if len(periods) != 1 || periods[0].Revenue == nil || *periods[0].Revenue != 5.5e10 || periods[0].SourceFetchedAt.IsZero() {
				t.Fatalf("the 000129 columns must be served: %+v", periods)
			}
			if p := periods[0]; p.GrossProfit != nil || p.TotalEquity != nil || p.FieldSources != nil || p.SourceDocumentURL != "" || p.SourceDocumentDate != nil {
				t.Errorf("000132 fields must be absent: %+v", p)
			}

			extras, err := getFundamentalsExtras(ctx, db, "BHP")
			if err != nil || extras != nil {
				t.Errorf("extras = %+v, %v; want nil, nil", extras, err)
			}

			cov, err := getFundamentalsCoverage(ctx, db, "BHP")
			if err != nil || cov == nil {
				t.Fatalf("coverage = %+v, %v", cov, err)
			}
			if cov.OutcomeKnown || !cov.HasSyncRow || len(cov.Sources) != 1 || cov.LastAttemptAt == nil {
				t.Errorf("coverage without last_outcome: %+v", cov)
			}

			filing, err := getLatestFilingInputs(ctx, db, "BHP")
			if err != nil || filing == nil {
				t.Fatalf("filing inputs = %+v, %v", filing, err)
			}
			if len(filing.Candidates) != 1 || !filing.Candidates[0].DocumentMeta.IsZero() || filing.CompanyName != "BHP GROUP LIMITED" {
				t.Errorf("filing candidates without document_meta: %+v", filing)
			}
		})
	}
}

// Before 000129/000130 the whole picker is absent: an empty universe, no
// periods, no coverage, never an error.
func TestFundamentalsReadsDegradeWithoutThePickerTables(t *testing.T) {
	db := &fakeDB{respond: func(string) ([][]any, error) { return nil, pgErr("42P01") }}
	ctx := context.Background()
	if cands, err := listStrategyCandidates(ctx, db); err != nil || len(cands) != 0 || cands == nil {
		t.Errorf("universe = %v, %v", cands, err)
	}
	for _, q := range db.queries {
		if strings.Contains(q, sqlExtras) {
			t.Error("an empty universe must not read the extras")
		}
	}
	if periods, err := getStockFundamentals(ctx, db, "BHP", "", 12); err != nil || len(periods) != 0 {
		t.Errorf("periods = %v, %v", periods, err)
	}
	if cov, err := getFundamentalsCoverage(ctx, db, "BHP"); err != nil || cov != nil {
		t.Errorf("coverage = %v, %v", cov, err)
	}
	if in, err := getLatestFilingInputs(ctx, db, "BHP"); err != nil || in != nil {
		t.Errorf("filing inputs = %v, %v", in, err)
	}
}

// Any other error is an error: a timeout on a sick view must not masquerade
// as "no data".
func TestFundamentalsReadsReturnOtherErrors(t *testing.T) {
	boom := pgErr("57014") // query_canceled
	ctx := context.Background()
	extrasFail := &fakeDB{respond: func(sql string) ([][]any, error) {
		if strings.Contains(sql, sqlExtras) {
			return nil, boom
		}
		return [][]any{fakeCandidateRow("BHP")}, nil
	}}
	if _, err := listStrategyCandidates(ctx, extrasFail); err == nil || !errors.Is(err, boom) {
		t.Errorf("a failing extras read must fail the universe fill (not cached), got %v", err)
	}
	all := &fakeDB{respond: func(string) ([][]any, error) { return nil, boom }}
	if _, err := getStockFundamentals(ctx, all, "BHP", "", 12); err == nil {
		t.Error("periods")
	}
	if _, err := getFundamentalsExtras(ctx, all, "BHP"); err == nil {
		t.Error("extras")
	}
	if _, err := getFundamentalsCoverage(ctx, all, "BHP"); err == nil {
		t.Error("coverage")
	}
	if _, err := getLatestFilingInputs(ctx, all, "BHP"); err == nil {
		t.Error("filing inputs")
	}
}

// With 000132 the extras merge onto the universe by code.
func TestListStrategyCandidatesMergesExtras(t *testing.T) {
	var er extrasRow
	er.e.StockCode = "bhp" // matched case-insensitively
	er.e.HasGrowthRow = true
	er.e.RevenueBasisSource = "filing"
	er.e.EPSBasisSource = "vendor"
	er.e.RevenueLatestPeriodEnd = tp("2026-06-30")
	er.e.RevenuePriorPeriodEnd = tp("2025-06-30")
	er.hasQuality = true
	er.q.BasisPeriodType = "annual"
	er.q.Currency = "USD"
	er.q.ROEPct = fp(22.5)
	er.q.NetMarginPct = fp(20)
	er.q.StatementIsFinancial = false
	lag := int32(0)
	er.q.BalanceLagMonths = &lag
	er.e.Valuation.Shares = fp(5.07e9)
	er.e.Valuation.SharesPeriodEnd = tp("2026-06-30")
	er.e.Valuation.MedianK = fp(1.0)
	er.e.Valuation.KPeriods = 4
	er.e.Valuation.KConsistent = true
	er.e.Valuation.EPSCurrency = "USD"
	extrasFixture := rowFrom(er.targets())

	db := &fakeDB{respond: func(sql string) ([][]any, error) {
		switch {
		case strings.Contains(sql, sqlExtras):
			return [][]any{extrasFixture}, nil
		case strings.Contains(sql, sqlCandidates):
			return [][]any{fakeCandidateRow("BHP"), fakeCandidateRow("ZZZ")}, nil
		}
		return nil, fmt.Errorf("unexpected query")
	}}
	cands, err := listStrategyCandidates(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	bhp, zzz := cands[0], cands[1]
	if bhp.Quality == nil || *bhp.Quality.ROEPct != 22.5 || bhp.Quality.BalanceLagMonths == nil {
		t.Errorf("BHP quality: %+v", bhp.Quality)
	}
	if bhp.Growth.RevenueBasisSource != "filing" || bhp.Growth.EPSBasisSource != "vendor" ||
		!bhp.Growth.RevenueLatestPeriodEnd.Equal(*tp("2026-06-30")) || !bhp.Growth.RevenuePriorPeriodEnd.Equal(*tp("2025-06-30")) {
		t.Errorf("BHP growth provenance: %+v", bhp.Growth)
	}
	if bhp.ValuationInputs == nil || *bhp.ValuationInputs.Shares != 5.07e9 || bhp.ValuationInputs.KPeriods != 4 {
		t.Errorf("BHP valuation inputs: %+v", bhp.ValuationInputs)
	}
	if zzz.Quality != nil || zzz.ValuationInputs != nil {
		t.Error("a stock without extras gets none")
	}
	// The candidates query keeps EXACTLY its 000129/000130 column list.
	for _, q := range db.queries {
		if strings.Contains(q, sqlCandidates) && strings.Contains(q, "mv_fundamentals_quality") {
			t.Error("strategyCandidatesQuery must not read 000132 objects")
		}
	}
}

func TestFundamentalsExtrasQueryShape(t *testing.T) {
	var r extrasRow
	if got, want := len(r.targets()), len(fundamentalsExtrasColumns); got != want {
		t.Fatalf("targets %d != columns %d", got, want)
	}
	for _, q := range []string{fundamentalsExtrasUniverseQuery, fundamentalsExtrasSingleQuery} {
		if got := len(selectList(t, q)); got != len(fundamentalsExtrasColumns) {
			t.Errorf("extras query selects %d columns, scans %d", got, len(fundamentalsExtrasColumns))
		}
		for _, frag := range []string{
			"LEFT JOIN mv_fundamentals_growth g", "LEFT JOIN mv_fundamentals_quality q", "LEFT JOIN stock_fundamentals_sync sy",
			"sy.median_k", "f.source <> 'asx-filing-extraction'", "BETWEEN 0.8 AND 1.25",
		} {
			if !strings.Contains(q, frag) {
				t.Errorf("extras query is missing %q", frag)
			}
		}
	}
	if strings.Contains(fundamentalsExtrasUniverseQuery, "$1") || !strings.Contains(fundamentalsExtrasSingleQuery, "$1::text") {
		t.Error("only the single-stock read takes a code")
	}
	if !strings.Contains(fundamentalsExtrasSingleQuery, "FROM mv_price_features p") || !strings.Contains(fundamentalsExtrasSingleQuery, "FROM stock_prices s2") {
		t.Error("the single-stock read must take the close from mv_price_features, else stock_prices")
	}
	// Every contract column of mv_fundamentals_quality (plan §2.7) is read.
	for _, col := range []string{
		"basis_period_type", "basis_period_end", "currency", "source", "fetched_at", "revenue", "gross_profit",
		"operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income", "operating_cash_flow",
		"operating_cash_flow_derived", "free_cash_flow", "capital_expenditure", "dividends_paid", "interest_expense",
		"shares_outstanding", "balance_period_end", "balance_period_type", "balance_currency", "balance_lag_months",
		"total_assets", "total_assets_prior", "total_liabilities", "total_equity", "total_equity_prior",
		"cash_and_equivalents", "total_debt", "capital_lease_obligations", "net_debt", "current_assets",
		"current_liabilities", "gross_margin_pct", "operating_margin_pct", "net_margin_pct", "fcf_margin_pct",
		"fcf_conversion", "roe_pct", "roa_pct", "net_debt_to_ebitda", "net_debt_to_equity", "current_ratio",
		"interest_cover", "payout_ratio_pct", "statement_is_financial",
	} {
		if !strings.Contains(fundamentalsExtrasUniverseQuery, "q."+col) {
			t.Errorf("extras query does not read mv_fundamentals_quality.%s", col)
		}
	}
	// The four appended growth columns (plan §2.6).
	for _, col := range []string{"revenue_basis_source", "eps_basis_source", "revenue_latest_period_end", "revenue_prior_period_end"} {
		if !strings.Contains(fundamentalsExtrasUniverseQuery, "g."+col) {
			t.Errorf("extras query does not read mv_fundamentals_growth.%s", col)
		}
	}
}

func TestBuildFundamentalsQueryExtended(t *testing.T) {
	q, args := buildFundamentalsQueryExtended("BHP", "quarter", 40)
	if got, want := len(selectList(t, q)), 14+len(fundamentalsExtendedColumns)+3; got != want {
		t.Errorf("extended query selects %d columns, readFundamentalsPeriods scans %d", got, want)
	}
	if len(fundamentalsExtendedColumns) != 21 {
		t.Errorf("plan §2.1 adds 21 value columns, the list has %d", len(fundamentalsExtendedColumns))
	}
	if len(args) != 3 || !strings.Contains(q, "period_type = $2") || !strings.Contains(q, "LIMIT $3") {
		t.Errorf("args %v\n%s", args, q)
	}
	for _, col := range []string{"field_sources", "source_document_url", "source_document_date", "capital_lease_obligations", "net_debt"} {
		if !strings.Contains(q, col) {
			t.Errorf("extended query does not read %s", col)
		}
	}
}

func TestParseFieldSources(t *testing.T) {
	got := parseFieldSources(`{"operating_cash_flow": "derived:fcf-minus-capex", "revenue": "markit-key-statistics",
		"not_a_column": "x", "net_income": 7, "ebitda": "", "total_debt": "` + strings.Repeat("x", 65) + `"}`)
	want := map[string]string{"operating_cash_flow": "derived:fcf-minus-capex", "revenue": "markit-key-statistics"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseFieldSources = %v, want %v", got, want)
	}
	for _, empty := range []string{"", "{}", "null", "[]", "not json", `{"x": "y"}`} {
		if got := parseFieldSources(empty); got != nil {
			t.Errorf("%q = %v, want nil", empty, got)
		}
	}
}

func TestMissingSchemaDetection(t *testing.T) {
	if !isMissingSchema(pgErr("42P01")) || !isMissingSchema(pgErr("42703")) {
		t.Fatal("42P01 and 42703 are both absent schema")
	}
	if !isUndefinedColumn(fmt.Errorf("wrapped: %w", pgErr("42703"))) {
		t.Fatal("a wrapped 42703 is still recognised")
	}
	for _, err := range []error{pgErr("57014"), pgErr("42601"), errors.New("timeout"), nil} {
		if isMissingSchema(err) {
			t.Errorf("%v must not read as absent schema", err)
		}
	}
	for i := 0; i < 3; i++ {
		logMissingSchemaOnce("TestMethod", errors.New("column does not exist"))
	}
}

// FundamentalsExtras.ApplyToGrowth only copies from a real growth row.
func TestApplyToGrowth(t *testing.T) {
	g := &strategies.Growth{}
	(&FundamentalsExtras{RevenueBasisSource: "filing"}).ApplyToGrowth(g)
	if g.RevenueBasisSource != "" {
		t.Error("no growth row: nothing to copy")
	}
	(&FundamentalsExtras{HasGrowthRow: true, RevenueBasisSource: "filing"}).ApplyToGrowth(g)
	if g.RevenueBasisSource != "filing" {
		t.Error("copy")
	}
	(*FundamentalsExtras)(nil).ApplyToGrowth(g)
	(&FundamentalsExtras{HasGrowthRow: true}).ApplyToGrowth(nil)
}
