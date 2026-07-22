package main

import "testing"

// retailFixture mirrors the real ABS,RT(1.0.0) SDMX-CSV shape probed
// 2026-07-22. The dataflow dimension order is MEASURE.INDUSTRY.TSEST.REGION.FREQ.
func retailFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "INDUSTRY: Industry", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "20: Total", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2025-06", "37906.6", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "20: Total", "20: Seasonally Adjusted", "1: New South Wales", "M: Monthly", "2025-06", "11665.8", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M2: Chain Volume Measures", "20: Total", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2025-06", "999", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "41: Food retailing", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2025-06", "999", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "20: Total", "10: Original", "AUS: Australia", "M: Monthly", "2025-06", "999", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "20: Total", "20: Seasonally Adjusted", "9: Other Territories", "M: Monthly", "2025-06", "999", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:RT(1.0.0)", "M1: Current Prices", "20: Total", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2025-Q2", "999", "AUD: Australian Dollar", "6: Millions"},
	}
}

func TestRetailPinnedSDMXQuery(t *testing.T) {
	if retailFlow != "RT" || retailKey != "M1.20.20.1+2+3+4+5+6+7+8+AUS.M" || retailStartPeriod != "2000-01" {
		t.Fatalf("unexpected retail query: flow=%q key=%q start=%q", retailFlow, retailKey, retailStartPeriod)
	}
}

func TestParseRetail(t *testing.T) {
	obs, err := parseRetail(retailFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 selected total-turnover observations, got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	aus, ok := byKey["retail.turnover.total.aus.seasadj"]
	if !ok || aus.Value != 37_906_600_000 {
		t.Fatalf("Australia retail magnitude wrong: %#v", byKey)
	}
	nsw, ok := byKey["retail.turnover.total.nsw.seasadj"]
	if !ok || nsw.Value != 11_665_800_000 {
		t.Fatalf("NSW retail magnitude wrong: %#v", byKey)
	}
	if aus.Series.Unit != "aud" || aus.Series.Frequency != "monthly" || aus.Series.Adjustment != "seasadj" {
		t.Fatalf("unexpected Australia metadata: %#v", aus.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "RT", "measure": "M1", "industry": "20", "tsest": "20",
		"region": "AUS", "freq": "M", "unit_mult": "6",
	} {
		if got := aus.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseRetailMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseRetail(withoutSDMXColumn(retailFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseRetailHeaderOnly(t *testing.T) {
	obs, err := parseRetail([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
}

func TestParseRetailRejectsInvalidRequiredRows(t *testing.T) {
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{
			name: "truncated selected row",
			row:  retailFixture()[1][:len(retailFixture()[1])-1],
		},
		{
			name: "blank multiplier",
			row: func() []string {
				row := append([]string(nil), retailFixture()[1]...)
				row[len(row)-1] = ""
				return row
			}(),
		},
		{
			name: "malformed multiplier",
			row: func() []string {
				row := append([]string(nil), retailFixture()[1]...)
				row[len(row)-1] = "six: Millions"
				return row
			}(),
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rows := [][]string{append([]string(nil), retailFixture()[0]...), tt.row}
			_, err := parseRetail(rows)
			assertSDMXRowError(t, err, "parseRetail", 2)
		})
	}
}

func TestParseRetailReorderedHeader(t *testing.T) {
	obs, err := parseRetail(reverseSDMXColumns(retailFixture()))
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("reordered header produced %d observations, want 2: %#v", len(obs), obs)
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if got := byKey["retail.turnover.total.aus.seasadj"]; got != 37_906_600_000 {
		t.Fatalf("reordered header Australia value=%v, want %v", got, float64(37_906_600_000))
	}
}
