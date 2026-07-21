package main

import (
	"testing"

	"github.com/xuri/excelize/v2"
)

// petroleumFixture builds a synthetic workbook mirroring the REAL May-2026
// data-extract layout (see the dated discovery block in petroleum.go):
// header on row 1, "Month" in column A rendered by excelize as "Jul 2010",
// values with thousands separators, "n.a."/"n.p." suppression markers, and
// a "(ML)" unit suffix on every product header.
func petroleumFixture(t *testing.T) *excelize.File {
	t.Helper()
	f := excelize.NewFile()
	sheet := "Refinery production"
	_, err := f.NewSheet(sheet)
	if err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"Month", "Percentage indigenous: Total input (%)", "Total input (ML)", "Automotive gasoline (ML)", "Diesel oil (ML)", "Jet fuel (ML)"},
		{"Apr 2026", "14.7", "1,285.6", 469.5, 900.2, 210.0},
		{"May 2026", "15.7", "1,380.5", 448.6, 910.7, "n.a."},
		{"", "", "", "", "", ""},
		{"Source: DCCEEW", "", "", "", "", ""},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func TestParsePetroleumSheet(t *testing.T) {
	f := petroleumFixture(t)
	obs, err := parsePetroleumSheet(f, petroleumSheetSpec{
		SheetMatch:    "Refinery production",
		Metric:        "refinery_output",
		HeaderMatch:   "Month",
		ColumnExclude: []string{"Percentage indigenous", "Total input"},
	}, "https://example.test/aps.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	// 2 months x 3 products, minus the "n.a." jet-fuel cell, minus the
	// excluded % + total-input columns.
	if len(obs) != 5 {
		t.Fatalf("want 5 obs (n.a. cell skipped, 2 columns excluded), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["petroleum.refinery_output.diesel_oil.aus"] != 910.7 {
		t.Fatalf("diesel latest wrong: %#v", byKey)
	}
	// Thousands separators must not leak through — the excluded Total input
	// column is the comma-bearing one; check gasoline instead.
	if byKey["petroleum.refinery_output.automotive_gasoline.aus"] != 448.6 {
		t.Fatalf("gasoline latest wrong: %#v", byKey)
	}
	for _, o := range obs {
		if o.Series.Unit != "megalitres" || o.Series.Frequency != "monthly" {
			t.Fatalf("unit/frequency wrong: %#v", o.Series)
		}
		if o.Series.Dimensions["sheet"] != "Refinery production" {
			t.Fatalf("sheet provenance missing: %#v", o.Series.Dimensions)
		}
		if o.Series.Dimensions["source_url"] != "https://example.test/aps.xlsx" {
			t.Fatalf("source_url provenance missing: %#v", o.Series.Dimensions)
		}
		if o.Period.Day() != 1 {
			t.Fatalf("period not normalised to month start: %v", o.Period)
		}
	}
}

func TestParsePetroleumSheetColumnInclude(t *testing.T) {
	f := petroleumFixture(t)
	obs, err := parsePetroleumSheet(f, petroleumSheetSpec{
		SheetMatch:      "Refinery production",
		Metric:          "refinery_input",
		HeaderMatch:     "Month",
		ColumnInclude:   []string{"Total input (ML)"},
		ProductOverride: "total",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (single included column), got %d", len(obs))
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	// Comma-separated "1,380.5" must parse.
	if byKey["petroleum.refinery_input.total.aus"] != 1380.5 {
		t.Fatalf("total input latest wrong: %#v", byKey)
	}
}

func TestParsePetroleumSheetStateColumn(t *testing.T) {
	f := excelize.NewFile()
	sheet := "Sales by state and territory"
	if _, err := f.NewSheet(sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]interface{}{
		{"State", "Month", "Diesel oil: total", "Automotive gasoline: total (ML)"},
		{"NSW", "Apr 2026", 361.9, 510.2},
		{"NSW", "May 2026", 362.8, "n.p."},
		{"WA", "May 2026", 93.8, 105.2},
		{"XX", "May 2026", 1.0, 1.0}, // unknown state rows are skipped
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow(sheet, cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	obs, err := parsePetroleumSheet(f, petroleumSheetSpec{
		SheetMatch:  "Sales by state",
		Metric:      "sales",
		HeaderMatch: "State",
		StateColumn: true,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 5 {
		t.Fatalf("want 5 obs (n.p. + unknown-state rows skipped), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	wa, ok := byKey["petroleum.sales.diesel_oil_total.wa"]
	if !ok || wa.Value != 93.8 {
		t.Fatalf("WA diesel wrong: %#v", byKey)
	}
	if wa.Series.RegionType != "state" || wa.Series.RegionName != "Western Australia" {
		t.Fatalf("WA region wrong: %#v", wa.Series)
	}
	nsw := byKey["petroleum.sales.automotive_gasoline_total.nsw"]
	if nsw.Value != 510.2 {
		t.Fatalf("NSW gasoline wrong (n.p. May row must be skipped, Apr kept): %#v", byKey)
	}
}

func TestParsePetroleumSheetUnknownLayout(t *testing.T) {
	f := excelize.NewFile()
	if _, err := parsePetroleumSheet(f, petroleumSheetSpec{SheetMatch: "Refinery production", HeaderMatch: "Month"}, ""); err == nil {
		t.Fatal("want loud failure on missing sheet")
	}
	// Sheet present but header row drifted → loud failure too.
	fx := petroleumFixture(t)
	if _, err := parsePetroleumSheet(fx, petroleumSheetSpec{SheetMatch: "Refinery production", HeaderMatch: "Reporting period"}, ""); err == nil {
		t.Fatal("want loud failure on header drift")
	}
}

func TestParsePetroleumMonth(t *testing.T) {
	cases := map[string]string{
		"Jul 2010":   "2010-07-01", // observed: excelize rendering of the real workbook's date cells (2026-07-21)
		"May 2026":   "2026-05-01",
		"May-2026":   "2026-05-01",
		"May-26":     "2026-05-01",
		"05-26":      "2026-05-01",
		"05-01-26":   "2026-05-01",
		"2026-05":    "2026-05-01",
		"2026-05-01": "2026-05-01",
	}
	for in, want := range cases {
		got, ok := parsePetroleumMonth(in)
		if !ok || got.Format("2006-01-02") != want {
			t.Fatalf("parsePetroleumMonth(%q) = %v, %v; want %s", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "Source: DCCEEW", "Total"} {
		if _, ok := parsePetroleumMonth(bad); ok {
			t.Fatalf("parsePetroleumMonth(%q) should fail", bad)
		}
	}
}

func TestStripUnitSuffix(t *testing.T) {
	cases := map[string]string{
		"Diesel oil (ML)":          "Diesel oil",
		"Regular (<95 RON) (ML)":   "Regular (<95 RON)",
		"Diesel oil: total":        "Diesel oil: total",
		"Natural gas (Mm3)":        "Natural gas",
		"Percentage indigenous: Total input (%)": "Percentage indigenous: Total input",
	}
	for in, want := range cases {
		if got := stripUnitSuffix(in); got != want {
			t.Fatalf("stripUnitSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}
