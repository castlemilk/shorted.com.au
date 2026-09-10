package economy

import (
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// buildPinkWorkbook makes a workbook shaped like the real one: names on row 5,
// units on row 6, data from row 7, periods in column A as "2026M08".
func buildPinkWorkbook(t *testing.T, names []string, rows [][]string) *excelize.File {
	t.Helper()
	f := excelize.NewFile()
	if _, err := f.NewSheet(pinkSheetSheetName); err != nil {
		t.Fatal(err)
	}
	set := func(row int, values []string) {
		for i, v := range values {
			cell, err := excelize.CoordinatesToCellName(i+1, row)
			if err != nil {
				t.Fatal(err)
			}
			if err := f.SetCellStr(pinkSheetSheetName, cell, v); err != nil {
				t.Fatal(err)
			}
		}
	}
	set(pinkSheetNameRow, names)
	for i, r := range rows {
		set(pinkSheetFirstData+i, r)
	}
	return f
}

// The workbook attaches footnote markers to some headers ("Beef **"). They mark
// a definitional note and move between issues, so matching the raw text turns
// an editorial change into "column not found" and drops the series.
func TestNormalisePinkLabelStripsFootnoteMarkers(t *testing.T) {
	cases := map[string]string{
		"Beef **":                "Beef",
		"Coal, South African **": "Coal, South African",
		"Potassium chloride  **": "Potassium chloride",
		"Gold":                   "Gold",
		"  Gold  ":               "Gold",
	}
	for in, want := range cases {
		if got := normalisePinkLabel(in); got != want {
			t.Errorf("normalisePinkLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

// Stripping markers cannot be allowed to make two columns interchangeable —
// binding a series to whichever came first would publish one commodity's price
// under another's name, and the chart would look entirely normal.
func TestParsePinkSheetRefusesAmbiguousHeaders(t *testing.T) {
	f := buildPinkWorkbook(t,
		[]string{"", "Gold", "Gold **"},
		[][]string{{"2026M08", "4411", "4411"}},
	)
	_, err := parsePinkSheet(f, "https://example.test/CMO.xlsx")
	if err == nil || !strings.Contains(err.Error(), "ambiguous header") {
		t.Fatalf("want an ambiguous-header error, got %v", err)
	}
}

// A footnote-marked column must still resolve. This is the case the raw-text
// match used to drop.
func TestParsePinkSheetResolvesFootnotedColumns(t *testing.T) {
	f := buildPinkWorkbook(t,
		[]string{"", "Beef **"},
		[][]string{{"2026M07", "7.10"}, {"2026M08", "7.28"}},
	)
	obs, err := parsePinkSheetFor(f, "https://example.test/CMO.xlsx",
		[]pinkSeries{{"Beef", "spot_price", "beef", "usd_per_kg", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 observations, got %d", len(obs))
	}
	if obs[0].Series.Key() != "commodities.spot_price.beef.world" {
		t.Errorf("key = %q", obs[0].Series.Key())
	}
	if obs[1].Value != 7.28 {
		t.Errorf("value = %v, want 7.28", obs[1].Value)
	}
}

// A wanted column that is genuinely gone is format drift, not a partial
// success: importing 22 of 23 series leaves a gap that only ever shows up as a
// chart with no line on it.
func TestParsePinkSheetFailsOnAMissingColumn(t *testing.T) {
	f := buildPinkWorkbook(t,
		[]string{"", "Gold"},
		[][]string{{"2026M08", "4411"}},
	)
	_, err := parsePinkSheetFor(f, "https://example.test/CMO.xlsx",
		[]pinkSeries{{"Unobtainium", "spot_price", "unobtainium", "usd_per_kg", ""}})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want a column-not-found error, got %v", err)
	}
}

// "…" is the workbook's missing marker. Parsed as a float it is 0.0, which for
// gold reads as a free ounce — excluded, never defaulted.
func TestParsePinkValueRejectsMissingMarkers(t *testing.T) {
	for _, s := range []string{"…", "...", "..", "", "  "} {
		if _, ok := parsePinkValue(s); ok {
			t.Errorf("parsePinkValue(%q) accepted a missing marker", s)
		}
	}
	v, ok := parsePinkValue(" 1,234.5 ")
	if !ok || v != 1234.5 {
		t.Errorf("parsePinkValue(\" 1,234.5 \") = %v,%v", v, ok)
	}
}

func TestParsePinkPeriod(t *testing.T) {
	p, ok := parsePinkPeriod("2026M08")
	if !ok || p.Year() != 2026 || p.Month() != 8 || p.Day() != 1 {
		t.Fatalf("parsePinkPeriod(2026M08) = %v,%v", p, ok)
	}
	for _, bad := range []string{"2026", "2026M13", "2026M00", "2026Q3", ""} {
		if _, ok := parsePinkPeriod(bad); ok {
			t.Errorf("parsePinkPeriod(%q) accepted", bad)
		}
	}
}

// Two defs producing one key would silently interleave two commodities'
// observations into a single series.
func TestPinkSeriesKeysAreUnique(t *testing.T) {
	seen := map[string]string{}
	for _, def := range pinkSeriesDefs {
		key := SeriesDef{Topic: "commodities", Metric: def.Metric, Product: def.Product, RegionCode: "world"}.Key()
		if prev, dup := seen[key]; dup {
			t.Errorf("%q and %q both produce %q", prev, def.Label, key)
		}
		seen[key] = def.Label
		if normalisePinkLabel(def.Label) != def.Label {
			t.Errorf("def label %q carries a footnote marker — store the clean label, matching strips markers from the SHEET", def.Label)
		}
	}
}
