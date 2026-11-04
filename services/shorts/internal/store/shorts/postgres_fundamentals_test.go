package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
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
func (r *fakeRows) TypeMap() *pgtype.Map                         { return pgtype.NewMap() }
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
	row.closePx = new(float64(45))
	row.c.SMA200 = new(float64(40))
	row.c.DollarVolume20d = new(5e7)
	row.c.Industry = "Materials"
	row.hasGrowth = true
	row.g.BasisPeriodType = "ttm"
	row.g.RevenueYoYPct = new(float64(12))
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
		case strings.Contains(sql, strategyShortDatesQuery):
			return [][]any{{"BHP", *tp("2026-10-28")}}, nil
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
			return [][]any{{"https://asx/bhp-4e.pdf", "Appendix 4E and Annual Report", *tp("2026-08-19"), "BHP lifted copper output.", 0.9, "[]", ""}}, nil
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

// A candidate row with a short figure, as strategyCandidatesQuery returns it.
func fakeShortCandidateRow(code string, pct float64) []any {
	var row candidateRow
	row.c.StockCode = code
	row.asOf = tp("2026-09-25")
	row.closePx = new(float64(45))
	row.c.ShortPct = new(pct)
	return rowFrom(row.targets())
}

// The newest short report date merges onto each stock by code, and only onto a
// stock with a short figure: the date is the report that figure came from. A
// schema without the shorts relation leaves every stock without one.
func TestListStrategyShortDatesMergesByCode(t *testing.T) {
	db := &fakeDB{respond: func(sql string) ([][]any, error) {
		switch {
		case strings.Contains(sql, strategyShortDatesQuery):
			// ZZZ has a date but no figure: it must not get the date.
			return [][]any{{"bhp", *tp("2026-10-28")}, {"ZZZ", *tp("2026-10-29")}}, nil
		case strings.Contains(sql, sqlCandidates):
			return [][]any{fakeShortCandidateRow("BHP", 6), fakeCandidateRow("ZZZ")}, nil
		}
		return nil, pgErr("42P01")
	}}
	cands, err := listStrategyCandidates(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if cands[0].ShortReportDate == nil || !cands[0].ShortReportDate.Equal(*tp("2026-10-28")) {
		t.Errorf("BHP short report date = %v, want 2026-10-28", cands[0].ShortReportDate)
	}
	if cands[1].ShortReportDate != nil {
		t.Errorf("ZZZ has no short figure, so no report date: %v", cands[1].ShortReportDate)
	}

	// The date query reads the view's own filtered rows, keyed on its codes,
	// with no age bound: a figure a year old keeps its date.
	for _, want := range []string{"LATERAL", "mv_screener_data", "DEFERRED", "5000000", "= sd.short_pct"} {
		if !strings.Contains(strategyShortDatesQuery, want) {
			t.Errorf("strategyShortDatesQuery lacks %q", want)
		}
	}
	if strings.Contains(strategyShortDatesQuery, "400 days") {
		t.Error("strategyShortDatesQuery must not bound the report's age")
	}

	missing := &fakeDB{respond: func(sql string) ([][]any, error) {
		if strings.Contains(sql, strategyShortDatesQuery) {
			return nil, pgErr("42P01")
		}
		return [][]any{fakeCandidateRow("BHP")}, nil
	}}
	if dates, err := listStrategyShortDates(context.Background(), missing); err != nil || dates != nil {
		t.Errorf("a missing shorts relation = %v, %v; want nil, nil", dates, err)
	}
	if _, err := listStrategyShortDates(context.Background(), &fakeDB{respond: func(string) ([][]any, error) {
		return nil, pgErr("57014")
	}}); err == nil {
		t.Error("a failing short dates read must fail the universe fill")
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
	for range 3 {
		logMissingSchemaOnce("TestMethod", errors.New("column does not exist"))
	}
}

// The latest-filing candidates carry whether the digest's metrics quoted the
// extractor's few-shot example: that digest was written from an echo.
func TestFilingCandidatesFlagAFewShotEcho(t *testing.T) {
	for _, q := range []string{latestFilingCandidatesQuery, latestFilingCandidatesLegacyQuery} {
		if !strings.Contains(q, `jsonb_path_query_array(e.metrics::jsonb, 'lax $.*[*].source_text')`) {
			t.Errorf("the candidates must read every metrics entry's source_text: %s", q)
		}
	}
	echo, _ := json.Marshal([]any{"Revenue up 12% to $1,204m", 42, nil, extractiontrust.OldFewShotTexts[0]})
	newEcho, _ := json.Marshal([]string{extractiontrust.NewFewShotTexts[0] + "."})
	clean, _ := json.Marshal([]any{"Statutory NPAT2 $5,142m", map[string]any{"source_text": extractiontrust.OldFewShotTexts[0]}})
	for name, c := range map[string]struct {
		sources string
		want    bool
	}{
		"an old example quote":            {string(echo), true},
		"a new example quote":             {string(newEcho), true},
		"a real quote of the same figure": {string(clean), false},
		"no quotes":                       {"[]", false},
		"not an array":                    {"{}", false},
		"malformed":                       {"[", false},
	} {
		if got := quotesFewShotExample(c.sources); got != c.want {
			t.Errorf("%s: quotesFewShotExample = %v, want %v", name, got, c.want)
		}
	}

	db := &fakeDB{respond: func(sql string) ([][]any, error) {
		switch {
		case strings.Contains(sql, sqlFilingContext):
			return [][]any{{*tp("2026-06-30"), *tp("2026-06-30"), "BHP GROUP LIMITED"}}, nil
		case strings.Contains(sql, sqlFilingCandidates):
			return [][]any{
				{"https://asx/echo.pdf", "Appendix 4E", *tp("2026-08-20"), "Revenue $5,142m.", 0.9, string(echo), ""},
				{"https://asx/bhp-4e.pdf", "Appendix 4E", *tp("2026-08-19"), "BHP lifted copper output.", 0.9, "[]", ""},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", sql)
	}}
	in, err := getLatestFilingInputs(context.Background(), db, "BHP")
	if err != nil || in == nil || len(in.Candidates) != 2 {
		t.Fatalf("filing inputs = %+v, %v", in, err)
	}
	if !in.Candidates[0].FewShotEcho || in.Candidates[1].FewShotEcho {
		t.Errorf("FewShotEcho = %v, %v; want true, false", in.Candidates[0].FewShotEcho, in.Candidates[1].FewShotEcho)
	}
}
