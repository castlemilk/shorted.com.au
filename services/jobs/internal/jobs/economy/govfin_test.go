package economy

import (
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// govfinFixtureSheet writes a synthetic per-state Operating Statement sheet
// mirroring the REAL Mar-2026 layout (see the dated discovery block in
// govfin.go): title banner rows, a period header ("Sep Qtr 2025" …) with a
// "$m" unit row beneath, section headers with no values, the three mandatory
// aggregate lines and the four optional detail lines we ingest.
func govfinFixtureSheet(t *testing.T, f *excelize.File, sheet string) {
	t.Helper()
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"            Australian Bureau of Statistics"},
		{"Government Finance Statistics, Australia - Mar 2026"},
		{"Released at 11.30am (Canberra time) 2 June 2026"},
		{"Table 5. New South Wales Total State and Local, Operating Statement - General Government"},
		{""},
		{"", "Sep Qtr 2025", "Dec Qtr 2025", "Mar Qtr 2026"},
		{"", "$m", "$m", "$m"},
		{"GFS Revenue"},
		{"Taxation revenue", "14049", "15220", "14139"},
		{"Current grants and subsidies", "10452", "12100", "10804"},
		{"Interest income", "880", "900", "920"}, // revenue-side interest must never feed expenses
		{"Total GFS revenue", "31347", "35220", "31398"},
		{""},
		{"less"},
		{"GFS Expenses"},
		{"Employee expenses", "15402", "14926", "14513"},
		{"Interest on defined benefit superannuation", "402", "389", "455"},
		{"Other interest expenses", "800", "800", "800"},
		{"Total GFS expenses", "32921", "34911", "30836"},
		{""},
		{"equals"},
		{"GFS NET OPERATING BALANCE", "-1574", "309", "562"},
		{"© Commonwealth of Australia 2026"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
}

func TestParseGovFinSheet(t *testing.T) {
	f := excelize.NewFile()
	govfinFixtureSheet(t, f, "Table 5")

	obs, err := parseGovFinSheet(f, govfinSheetSpec{"Table 5", "nsw", "New South Wales"}, "https://example.test/gfs.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	// 7 metrics x 3 periods = 21 obs (section headers remain ignored).
	if len(obs) != 21 {
		t.Fatalf("want 21 obs (3 totals + 4 details x 3 quarters), got %d: %#v", len(obs), obs)
	}

	byKeyPeriod := map[string]float64{}
	for _, o := range obs {
		byKeyPeriod[o.Series.Key()+"@"+o.Period.Format("2006-01-02")] = o.Value
	}
	// $m -> aud scaling: 31398 * 1e6. "Sep Qtr 2025" -> quarter START 2025-07-01.
	if v := byKeyPeriod["govfin.revenue.total.nsw@2025-07-01"]; v != 31347e6 {
		t.Fatalf("NSW revenue Sep-Qtr wrong: got %v want %v (%#v)", v, 31347e6, byKeyPeriod)
	}
	// "Mar Qtr 2026" -> 2026-01-01.
	if v := byKeyPeriod["govfin.revenue.total.nsw@2026-01-01"]; v != 31398e6 {
		t.Fatalf("NSW revenue Mar-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	// Negative net operating balance must carry through with sign + scale.
	if v := byKeyPeriod["govfin.net_operating_balance.total.nsw@2025-07-01"]; v != -1574e6 {
		t.Fatalf("NSW NOB Sep-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if v := byKeyPeriod["govfin.expenses.total.nsw@2025-10-01"]; v != 34911e6 {
		t.Fatalf("NSW expenses Dec-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if v := byKeyPeriod["govfin.revenue.taxation.nsw@2026-01-01"]; v != 14139e6 {
		t.Fatalf("NSW taxation revenue Mar-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if v := byKeyPeriod["govfin.revenue.grants.nsw@2025-10-01"]; v != 12100e6 {
		t.Fatalf("NSW grants revenue Dec-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if v := byKeyPeriod["govfin.expenses.employees.nsw@2025-07-01"]; v != 15402e6 {
		t.Fatalf("NSW employee expenses Sep-Qtr wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if v := byKeyPeriod["govfin.expenses.interest.nsw@2026-01-01"]; v != 1255e6 {
		t.Fatalf("NSW summed interest expenses Mar-Qtr wrong: got %v want %v (%#v)", v, 1255e6, byKeyPeriod)
	}

	for _, o := range obs {
		if o.Series.Unit != "aud" || o.Series.Frequency != "quarterly" || o.Series.Adjustment != "original" {
			t.Fatalf("series metadata wrong: %#v", o.Series)
		}
		if o.Series.RegionType != "state" || o.Series.RegionName != "New South Wales" {
			t.Fatalf("region wrong: %#v", o.Series)
		}
		if o.Series.Dimensions["sheet"] != "Table 5" || o.Series.Dimensions["abs_catalogue"] != "5519.0.55.001" {
			t.Fatalf("provenance missing: %#v", o.Series.Dimensions)
		}
		if o.Series.Dimensions["source_url"] != "https://example.test/gfs.xlsx" {
			t.Fatalf("source_url provenance missing: %#v", o.Series.Dimensions)
		}
		if o.Period.Day() != 1 {
			t.Fatalf("period not normalised to quarter start: %v", o.Period)
		}
	}
}

// Detail line items are additive and fail-soft: a sheet carrying only the
// three established aggregates must still parse successfully.
func TestParseGovFinSheetMissingOptionalDetails(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Table 6"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"", "Mar Qtr 2026"},
		{"", "$m"},
		{"GFS Revenue"},
		{"Total GFS revenue", "25000"},
		{"GFS Expenses"},
		{"Total GFS expenses", "24000"},
		{"GFS NET OPERATING BALANCE", "1000"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}

	obs, err := parseGovFinSheet(f, govfinSheetSpec{"Table 6", "vic", "Victoria"}, "")
	if err != nil {
		t.Fatalf("missing optional details must not fail the sheet: %v", err)
	}
	if len(obs) != 3 {
		t.Fatalf("want only the 3 mandatory aggregate observations, got %d: %#v", len(obs), obs)
	}
}

// Detail matching tolerates workbook footnote suffixes and ampersands, while
// the grants row remains scoped to GFS Revenue (the same wording can appear in
// the expenses section without representing grants revenue).
func TestParseGovFinSheetFuzzyDetailsAndRevenueScope(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Table 8"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"", "Mar Qtr 2026"},
		{"", "$m"},
		{"GFS Revenue"},
		{"Taxation revenue (a)", "7000"},
		{"Current grants & subsidies", "4000"},
		{"Total GFS revenue", "15000"},
		{"GFS Expenses"},
		{"Employee expenses (b)", "8000"},
		{"Current grants and subsidies", "900"}, // expense-side row: do not ingest as revenue
		{"Total GFS expenses", "14500"},
		{"GFS NET OPERATING BALANCE", "500"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}

	obs, err := parseGovFinSheet(f, govfinSheetSpec{"Table 8", "sa", "South Australia"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 6 {
		t.Fatalf("want 6 observations with expense-side grants ignored, got %d: %#v", len(obs), obs)
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if got := byKey["govfin.revenue.grants.sa"]; got != 4000e6 {
		t.Fatalf("revenue grants must come from the revenue section: got %v (%#v)", got, byKey)
	}
}

// Either live interest-expense component is sufficient on its own, while the
// revenue-side "Interest income" row must never be included in the expense sum.
func TestParseGovFinSheetInterestSingleComponentAndIgnoresIncome(t *testing.T) {
	cases := []struct {
		name  string
		label string
		value float64
	}{
		{"defined benefit only", "Interest on defined benefit superannuation", 450},
		{"other interest only", "Other interest expenses", 600},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := excelize.NewFile()
			sheet := "Table 7"
			if _, err := f.NewSheet(sheet); err != nil {
				t.Fatal(err)
			}
			rows := [][]interface{}{
				{"", "Mar Qtr 2026"},
				{"", "$m"},
				{"GFS Revenue"},
				{"Interest income", "900"},
				{"Total GFS revenue", "20000"},
				{"GFS Expenses"},
				{tc.label, tc.value},
				{"Total GFS expenses", "19500"},
				{"GFS NET OPERATING BALANCE", "500"},
			}
			for i, r := range rows {
				cell, _ := excelize.CoordinatesToCellName(1, i+1)
				if err := f.SetSheetRow(sheet, cell, &r); err != nil {
					t.Fatal(err)
				}
			}

			obs, err := parseGovFinSheet(f, govfinSheetSpec{"Table 7", "qld", "Queensland"}, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(obs) != 4 {
				t.Fatalf("want 3 totals + 1 interest observation, got %d: %#v", len(obs), obs)
			}
			byKey := map[string]float64{}
			for _, o := range obs {
				byKey[o.Series.Key()] = o.Value
			}
			if got := byKey["govfin.expenses.interest.qld"]; got != tc.value*govfinUnitScale {
				t.Fatalf("single interest component wrong: got %v want %v (%#v)", got, tc.value*govfinUnitScale, byKey)
			}
			if _, present := byKey["govfin.revenue.interest.qld"]; present {
				t.Fatalf("Interest income must not create a revenue-interest series: %#v", byKey)
			}
		})
	}
}

// TestParseGovFinSheetSuppression: an "n.a." cell for one metric/period must be
// skipped, not zeroed — the other values survive.
func TestParseGovFinSheetSuppression(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Table 9"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"Table 9. Western Australia Total State and Local, Operating Statement - General Government"},
		{""},
		{"", "Dec Qtr 2025", "Mar Qtr 2026"},
		{"", "$m", "$m"},
		{"Total GFS revenue", "14,649", "13118"}, // thousands separator must parse
		{"Total GFS expenses", "n.a.", "12820"},  // suppressed Dec cell skipped
		{"GFS NET OPERATING BALANCE", "1110", "299"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	obs, err := parseGovFinSheet(f, govfinSheetSpec{"Table 9", "wa", "Western Australia"}, "")
	if err != nil {
		t.Fatal(err)
	}
	// 3 metrics x 2 periods = 6, minus the one suppressed expenses cell = 5.
	if len(obs) != 5 {
		t.Fatalf("want 5 obs (one n.a. skipped), got %d: %#v", len(obs), obs)
	}
	byKeyPeriod := map[string]float64{}
	for _, o := range obs {
		byKeyPeriod[o.Series.Key()+"@"+o.Period.Format("2006-01-02")] = o.Value
	}
	if v := byKeyPeriod["govfin.revenue.total.wa@2025-10-01"]; v != 14649e6 {
		t.Fatalf("WA revenue with thousands-separator wrong: got %v (%#v)", v, byKeyPeriod)
	}
	if _, present := byKeyPeriod["govfin.expenses.total.wa@2025-10-01"]; present {
		t.Fatalf("suppressed WA expenses Dec cell should be absent: %#v", byKeyPeriod)
	}
}

// TestParseGovFinSheetMetricDrift: a renamed total (missing revenue) fails the
// sheet loudly even though the other totals parse.
func TestParseGovFinSheetMetricDrift(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Table 5"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"", "Mar Qtr 2026"},
		{"", "$m"},
		{"Total GFS operating revenue", "31398"}, // renamed — no longer matches
		{"Total GFS expenses", "30836"},
		{"GFS NET OPERATING BALANCE", "562"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	_, err := parseGovFinSheet(f, govfinSheetSpec{"Table 5", "nsw", "New South Wales"}, "")
	if err == nil || !strings.Contains(err.Error(), "revenue") {
		t.Fatalf("want loud failure naming missing revenue total, got %v", err)
	}
}

// TestParseGovFinSheetUnitDrift: a unit row that isn't "$m" fails the sheet so
// a silent ABS rescaling can't corrupt values by orders of magnitude.
func TestParseGovFinSheetUnitDrift(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Table 5"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"", "Mar Qtr 2026"},
		{"", "$b"}, // billions, not millions — must fail loudly
		{"Total GFS revenue", "31.4"},
		{"Total GFS expenses", "30.8"},
		{"GFS NET OPERATING BALANCE", "0.6"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	_, err := parseGovFinSheet(f, govfinSheetSpec{"Table 5", "nsw", "New South Wales"}, "")
	if err == nil || !strings.Contains(err.Error(), "scale drift") {
		t.Fatalf("want loud scale-drift failure, got %v", err)
	}
}

func TestParseGovFinSheetMissing(t *testing.T) {
	f := excelize.NewFile()
	if _, err := parseGovFinSheet(f, govfinSheetSpec{"Table 5", "nsw", "New South Wales"}, ""); err == nil {
		t.Fatal("want loud failure on missing sheet")
	}
}

// TestParseGovFinWorkbookPartialFailure: healthy sheets' obs are returned
// alongside a non-nil error when a configured sheet is missing.
func TestParseGovFinWorkbookPartialFailure(t *testing.T) {
	f := excelize.NewFile()
	govfinFixtureSheet(t, f, "Table 5") // present
	specs := []govfinSheetSpec{
		{"Table 5", "nsw", "New South Wales"},
		{"Table 6", "vic", "Victoria"}, // missing sheet
	}
	obs, err := parseGovFinWorkbook(f, specs, "")
	if err == nil {
		t.Fatal("want non-nil error when a sheet fails")
	}
	if !strings.Contains(err.Error(), "1/2 govfin sheets failed") {
		t.Fatalf("error should report failed/total counts: %v", err)
	}
	if len(obs) != 21 {
		t.Fatalf("healthy sheet obs must still be returned: want 21, got %d", len(obs))
	}
}

func TestParseGovFinPeriod(t *testing.T) {
	cases := map[string]string{
		"Mar Qtr 2026":       "2026-01-01",
		"Jun Qtr 2025":       "2025-04-01",
		"Sep Qtr 2025":       "2025-07-01",
		"Dec Qtr 2025":       "2025-10-01",
		"September Qtr 2024": "2024-07-01", // full month name tolerated
		"  Mar Qtr 2026  ":   "2026-01-01", // surrounding whitespace tolerated
	}
	for in, want := range cases {
		got, ok := parseGovFinPeriod(in)
		if !ok || got.Format("2006-01-02") != want {
			t.Fatalf("parseGovFinPeriod(%q) = %v, %v; want %s", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "$m", "Total GFS revenue", "2026-Q1", "Mar 2026", "Qtr 2026"} {
		if _, ok := parseGovFinPeriod(bad); ok {
			t.Fatalf("parseGovFinPeriod(%q) should fail", bad)
		}
	}
}
