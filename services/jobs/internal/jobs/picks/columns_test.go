package picks

import (
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The seven value columns of migration 000129, and the numeric columns plan
// fundamentals-coverage.md §2.1 adds in 000132, in the plan's order.
var (
	columns000129 = []string{
		"revenue", "net_income", "eps_basic", "eps_diluted",
		"operating_cash_flow", "free_cash_flow", "shares_outstanding",
	}
	columns000132 = []string{
		"gross_profit", "operating_income", "ebitda", "normalized_ebitda", "ebit",
		"interest_expense", "pretax_income", "tax_provision", "net_interest_income",
		"capital_expenditure", "dividends_paid", "share_buybacks",
		"total_assets", "total_liabilities", "total_equity", "cash_and_equivalents",
		"total_debt", "capital_lease_obligations", "net_debt",
		"current_assets", "current_liabilities",
	}
)

func columnNames() []string {
	out := make([]string, len(fundamentalsColumns))
	for i, c := range fundamentalsColumns {
		out[i] = c.name
	}
	return out
}

func TestFundamentalsColumnsAreExactlyTheContractColumns(t *testing.T) {
	want := append(append([]string(nil), columns000129...), columns000132...)
	assert.Equal(t, want, columnNames(), "the original seven, then §2.1's columns in order, nothing else")
	assert.Len(t, columnsByName, len(fundamentalsColumns), "no column is listed twice")

	for _, name := range want {
		c, ok := columnNamed(name)
		require.True(t, ok, name)
		assert.Equal(t, name, c.name)
	}
	for _, notAValue := range []string{"currency", "source", "fiscal_year", "field_sources", "source_document_url", "source_document_date", ""} {
		_, ok := columnNamed(notAValue)
		assert.False(t, ok, "%q is not a value column", notAValue)
	}
}

// The proto contract (commit cd928f21) carries every value column as a
// `double x` / `bool has_x` pair on FundamentalsPeriod. The table and the wire
// must name the same columns, or a column is collected and never served (or
// served and never collected).
func TestFundamentalsColumnsMatchTheFundamentalsPeriodProto(t *testing.T) {
	raw, err := os.ReadFile("../../../../../proto/shortedapi/shorts/v1alpha1/stock.proto")
	require.NoError(t, err)
	src := string(raw)
	start := strings.Index(src, "message FundamentalsPeriod {")
	require.GreaterOrEqual(t, start, 0, "FundamentalsPeriod is in stock.proto")
	depth, end := 0, -1
	for i := start; i < len(src) && end < 0; i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
	}
	require.Greater(t, end, start)
	body := src[start:end]

	var hasFields []string
	for _, m := range regexp.MustCompile(`\bbool\s+has_(\w+)\s*=`).FindAllStringSubmatch(body, -1) {
		hasFields = append(hasFields, m[1])
		assert.Regexp(t, `\bdouble\s+`+m[1]+`\s*=`, body, "has_%s pairs with a double %s", m[1], m[1])
	}
	got := columnNames()
	sort.Strings(hasFields)
	sort.Strings(got)
	assert.Equal(t, hasFields, got)
}

func TestFundamentalsColumnFlags(t *testing.T) {
	balance := map[string]bool{
		"total_assets": true, "total_liabilities": true, "total_equity": true,
		"cash_and_equivalents": true, "total_debt": true, "capital_lease_obligations": true,
		"net_debt": true, "current_assets": true, "current_liabilities": true,
		// A point-in-time count: quarter snapshots carry it with the balance
		// lines (§2.1), and the TTM-at-FYE copy (§3.6) does not move it.
		"shares_outstanding": true,
	}
	perShare := map[string]bool{"eps_basic": true, "eps_diluted": true}
	count := map[string]bool{"shares_outstanding": true}
	nonPositive := map[string]bool{"capital_expenditure": true, "dividends_paid": true, "share_buybacks": true}

	for _, c := range fundamentalsColumns {
		assert.Equal(t, balance[c.name], c.isBalance(), "%s balance", c.name)
		assert.Equal(t, !balance[c.name], c.isFlow(), "%s flow", c.name)
		assert.NotEqual(t, c.isFlow(), c.isBalance(), "%s is exactly one of flow and balance", c.name)
		switch {
		case perShare[c.name]:
			assert.Equal(t, unitPerShare, c.unit, c.name)
			assert.False(t, c.isMonetary(), c.name)
		case count[c.name]:
			assert.Equal(t, unitCount, c.unit, c.name)
			assert.False(t, c.isMonetary(), c.name)
		default:
			assert.Equal(t, unitMonetary, c.unit, c.name)
			assert.True(t, c.isMonetary(), c.name)
		}
		assert.Equal(t, nonPositive[c.name], c.nonPositive, "%s sign rule", c.name)
	}

	// The §3.6 TTM-at-FYE list is exactly the flow columns.
	var flow []string
	for _, c := range fundamentalsColumns {
		if c.isFlow() {
			flow = append(flow, c.name)
		}
	}
	assert.ElementsMatch(t, []string{
		"revenue", "net_income", "eps_basic", "eps_diluted", "gross_profit", "operating_income",
		"ebitda", "normalized_ebitda", "ebit", "interest_expense", "pretax_income", "tax_provision",
		"operating_cash_flow", "free_cash_flow", "capital_expenditure", "dividends_paid", "share_buybacks",
		"net_interest_income",
	}, flow)
}

// columnsTestSnake maps a PeriodRow field name to its column name
// (NormalizedEBITDA -> normalized_ebitda, EPSBasic -> eps_basic).
func columnsTestSnake(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		if unicode.IsUpper(r) && i > 0 && (unicode.IsLower(rs[i-1]) || (i+1 < len(rs) && unicode.IsLower(rs[i+1]))) {
			b.WriteByte('_')
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// Every *float64 field of PeriodRow is in the table exactly once, and each
// column's accessor reads and writes its OWN field (a copy-paste slip in a
// field func would silently file one line under another's name).
func TestFundamentalsColumnAccessorsPointAtTheirOwnField(t *testing.T) {
	floatPtr := reflect.TypeOf((*float64)(nil))
	typ := reflect.TypeOf(PeriodRow{})
	var fields []string
	for i := 0; i < typ.NumField(); i++ {
		if typ.Field(i).Type == floatPtr {
			fields = append(fields, typ.Field(i).Name)
		}
	}
	require.Len(t, fields, len(fundamentalsColumns), "every value field is a column and every column a field")

	for i, c := range fundamentalsColumns {
		var r PeriodRow
		v := float64(i + 1)
		c.set(&r, &v)
		require.NotNil(t, c.get(&r), c.name)
		assert.Equal(t, v, *c.get(&r), c.name)

		rv := reflect.ValueOf(r)
		var set []string
		for _, f := range fields {
			if !rv.FieldByName(f).IsNil() {
				set = append(set, f)
			}
		}
		require.Len(t, set, 1, "%s sets exactly one field", c.name)
		assert.Equal(t, c.name, columnsTestSnake(set[0]), "%s writes PeriodRow.%s", c.name, set[0])
		assert.Equal(t, &v, rv.FieldByName(set[0]).Interface(), c.name)

		c.set(&r, nil)
		assert.Nil(t, c.get(&r), "%s clears", c.name)
		assert.False(t, r.hasValues(), c.name)
	}
}

// storable's range (000129's CHECK, mirrored by 000132's _v2) applies to every
// column, not only the original seven.
func TestSanitizeRowsAppliesStorableToEveryColumn(t *testing.T) {
	bad := []float64{math.NaN(), math.Inf(1), math.Inf(-1), 1e19, -1e19, 1e-13, -1e-13, 5e-324}
	good := []float64{0, -5.4e9, 58760000000, 1e-12, 1e18, -1e18}
	for _, c := range fundamentalsColumns {
		anchor, _ := columnNamed("revenue")
		if c.name == "revenue" {
			anchor, _ = columnNamed("net_income")
		}
		base := func() PeriodRow {
			r := PeriodRow{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo}
			anchor.set(&r, f64(100))
			return r
		}
		for _, v := range bad {
			r := base()
			c.set(&r, f64(v))
			out, rejected := sanitizeRows([]PeriodRow{r})
			assert.Equal(t, 1, rejected, "%s=%v is counted", c.name, v)
			require.Len(t, out, 1, "%s=%v: the row survives on its other value", c.name, v)
			assert.Nil(t, c.get(&out[0]), "%s=%v is written NULL", c.name, v)
			assert.Equal(t, 100.0, *anchor.get(&out[0]))
		}
		for _, v := range good {
			r := base()
			c.set(&r, f64(v))
			out, rejected := sanitizeRows([]PeriodRow{r})
			assert.Zero(t, rejected, "%s=%v", c.name, v)
			require.Len(t, out, 1)
			require.NotNil(t, c.get(&out[0]), "%s=%v is kept", c.name, v)
			assert.Equal(t, v, *c.get(&out[0]))
		}
	}
}

func TestSanitizeRowsNewColumnsAndProvenance(t *testing.T) {
	doc := date("2026-08-19")
	rows := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "USD", Source: sourceYahoo,
			TotalAssets: f64(108e9), TotalDebt: f64(math.Inf(1)), CapitalExpenditure: f64(-1e19), NetDebt: f64(1e-13),
			GrossProfit: f64(0), Revenue: f64(1), OperatingCashFlow: f64(2),
			FieldSources:       map[string]string{"revenue": sourceMarkit, "operating_cash_flow": fieldSourceDerivedFCFMinusCapex, "net_income": sourceMarkit},
			Rejected:           []string{"net_income"},
			SourceDocumentURL:  "https://www.asx.com.au/asxpdf/20260819/pdf/example.pdf",
			SourceDocumentDate: &doc},
		// Only a new column, and it is not storable: the row survives as a
		// mask, so the stored value is nulled rather than kept.
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "USD", Source: sourceYahoo,
			TotalEquity: f64(math.NaN())},
	}
	out, rejected := sanitizeRows(rows)
	assert.Equal(t, 4, rejected, "Inf total_debt, -1e19 capex, 1e-13 net_debt, NaN total_equity")
	require.Len(t, out, 2)
	r := out[0]
	assert.Nil(t, r.TotalDebt)
	assert.Nil(t, r.CapitalExpenditure)
	assert.Nil(t, r.NetDebt)
	assert.Equal(t, 108e9, *r.TotalAssets, "a row carrying new columns is a row")
	assert.Equal(t, 0.0, *r.GrossProfit, "zero is a value in a new column too")
	assert.Equal(t, []string{"net_income", "capital_expenditure", "total_debt", "net_debt"}, r.Rejected,
		"a vendor value that fails the range check joins the mask")

	// Provenance survives for present values only; the document passes
	// through untouched.
	assert.Equal(t, map[string]string{"revenue": sourceMarkit, "operating_cash_flow": fieldSourceDerivedFCFMinusCapex}, r.FieldSources)
	assert.Equal(t, "https://www.asx.com.au/asxpdf/20260819/pdf/example.pdf", r.SourceDocumentURL)
	require.NotNil(t, r.SourceDocumentDate)
	assert.Equal(t, doc, *r.SourceDocumentDate)

	assert.False(t, out[1].hasValues())
	assert.Equal(t, []string{"total_equity"}, out[1].Rejected)

	assert.True(t, math.IsInf(*rows[0].TotalDebt, 1), "the input slice is not mutated")
	assert.Equal(t, []string{"net_income"}, rows[0].Rejected)
	assert.Len(t, rows[0].FieldSources, 3)
}
