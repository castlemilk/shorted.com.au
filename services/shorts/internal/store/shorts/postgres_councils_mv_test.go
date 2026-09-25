package shorts

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

const councilDropsMVMigration = "../../../../migrations/000127_council_price_drops_mv.up.sql"

// squash normalises whitespace so two spellings of the same SQL compare equal.
func squash(sql string) string {
	return strings.Join(strings.Fields(sql), " ")
}

// sqlCTE returns the body of `name AS ( ... )` up to the next `), <next> AS (`,
// or up to the closing `)` before the final SELECT when next is "".
func sqlCTE(t *testing.T, sql, name, next string) string {
	t.Helper()
	var re *regexp.Regexp
	if next == "" {
		re = regexp.MustCompile(`(?s)\b` + name + ` AS \((.*?)\)\s*SELECT `)
	} else {
		re = regexp.MustCompile(`(?s)\b` + name + ` AS \((.*?)\), ` + next + ` AS \(`)
	}
	m := re.FindStringSubmatch(squash(sql))
	if m == nil {
		t.Fatalf("CTE %s (before %q) not found", name, next)
	}
	return m[1]
}

func councilDropsMVBody(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(councilDropsMVMigration)
	if err != nil {
		t.Fatalf("read 000127: %v", err)
	}
	m := regexp.MustCompile(`(?s)CREATE MATERIALIZED VIEW IF NOT EXISTS mv_council_price_drops AS\n(.*?);\n`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("mv_council_price_drops definition not found in 000127")
	}
	return string(m[1])
}

// The view is the live query computed once per refresh. The live query stays
// as the fallback for a database without the view, so the two must not drift:
// every step that decides WHICH cuts count, and how, is textually identical,
// and only the state/council filter is lifted into a column.
func TestCouncilDropsMVMatchesLiveQuery(t *testing.T) {
	mv := councilDropsMVBody(t)
	live := councilDropsQuery

	for _, c := range []struct{ name, next string }{
		{"per_source", "cut"},
		{"cut", "tracked"},
		{"dropped", ""},
	} {
		if got, want := sqlCTE(t, mv, c.name, c.next), sqlCTE(t, live, c.name, c.next); got != want {
			t.Errorf("CTE %s drifted from councilDropsQuery:\n view: %s\n live: %s", c.name, got, want)
		}
	}

	// live: the same listing population (recency gate, address unit), carrying
	// the state column the view is filtered on instead.
	liveWhere := func(sql string) string {
		body := sqlCTE(t, sql, "live", "per_source")
		return body[strings.Index(body, "WHERE"):]
	}
	if got, want := liveWhere(mv), liveWhere(live); got != want {
		t.Errorf("live population drifted:\n view: %s\n live: %s", got, want)
	}

	// sub: the same dominant-council bridge, with no state or council filter.
	sub := sqlCTE(t, mv, "sub", "live")
	for _, want := range []string{
		"FROM suburb_lga sl",
		"JOIN lga l ON l.lga_code24 = sl.lga_code24",
		"JOIN house_price_regions r ON r.sal_code = sl.sal_code",
	} {
		if !strings.Contains(sub, want) {
			t.Errorf("view sub CTE lost %q", want)
		}
	}
	if strings.Contains(sub, "WHERE") {
		t.Errorf("view sub CTE must not filter (the read filters by state/council): %s", sub)
	}

	// The suburb median floor is the same k the Go council floor uses.
	floor := fmt.Sprintf("CASE WHEN x.n >= %d THEN x.median_pct END AS median_drop_pct", councilDropsMinCount)
	if !strings.Contains(squash(mv), floor) {
		t.Errorf("view must withhold a suburb median under councilDropsMinCount (%d) cuts: want %q", councilDropsMinCount, floor)
	}
	if !strings.Contains(squash(live), "CASE WHEN x.n >= $3 THEN x.median_pct END") {
		t.Error("live query lost its parameterised floor")
	}

	// The council total is keyed '' so the UNIQUE index covers every row.
	for _, want := range []string{
		"GROUP BY GROUPING SETS ((state_code, lga_code24, sal_code), (state_code, lga_code24))",
		"COALESCE(t.sal_code, '') AS sal_code",
		"LEFT JOIN dropped x ON x.lga_code24 = t.lga_code24 AND x.sal_code IS NOT DISTINCT FROM t.sal_code",
	} {
		if !strings.Contains(squash(mv), want) {
			t.Errorf("view lost %q", want)
		}
	}
}

func TestCouncilDropsMVQueryReadsTheRefreshStamp(t *testing.T) {
	q := squash(councilDropsMVQuery)
	for _, want := range []string{
		"FROM mv_council_price_drops m",
		// as_of is the refresh that evaluated the view's windows, and an
		// undated view publishes nothing (inner join).
		"JOIN housing_mv_refresh f ON f.mv_name = 'mv_council_price_drops'",
		"m.data_through, f.refreshed_at",
		"WHERE m.state_code = $1 AND ($2 = '' OR m.lga_code24 = $2)",
	} {
		if !strings.Contains(q, want) {
			t.Errorf("councilDropsMVQuery lost %q", want)
		}
	}
	if strings.Contains(q, "LEFT JOIN housing_mv_refresh") {
		t.Error("a view with no refresh stamp must publish nothing, not an undated share")
	}
	// Scanned by the same code as the live query: same column order.
	liveCols := topLevelFields(councilDropsQuery[strings.LastIndex(councilDropsQuery, "SELECT t.lga_code24"):strings.LastIndex(councilDropsQuery, "FROM tracked t")])
	mvCols := topLevelFields(q[:strings.Index(q, "FROM mv_council_price_drops")])
	if liveCols != mvCols {
		t.Errorf("view read selects %d columns, live query %d: scanCouncilDrops scans both", mvCols, liveCols)
	}
}

// topLevelFields counts the comma-separated items of a select list, ignoring
// commas inside parentheses (COALESCE(x, ”)).
func topLevelFields(list string) int {
	depth, n := 0, 1
	for _, r := range list {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				n++
			}
		}
	}
	return n
}
