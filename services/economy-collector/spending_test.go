package main

import "testing"

// spendingFixture mirrors the pinned ABS,HSI_M(1.6.0) SDMX-CSV shape from
// the 2026-07-23 probe. Dimension order is
// MEASURE.CATEGORY.PRICE_ADJUSTMENT.TSEST.STATE.FREQ.
func spendingFixture() [][]string {
	header := []string{"DATAFLOW", "MEASURE: Measure", "CATEGORY: Category", "PRICE_ADJUSTMENT: Price Adjustment", "TSEST: Adjustment Type", "STATE: State", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status"}
	regions := [][4]string{
		{"AUS", "Australia", "80635.5", "5.5"},
		{"1", "New South Wales", "25315.7", "4.8"},
		{"2", "Victoria", "19484.9", "4.7"},
		{"3", "Queensland", "16764.6", "5.6"},
		{"4", "South Australia", "5513.8", "6.8"},
		{"5", "Western Australia", "9484.2", "7.6"},
		{"6", "Tasmania", "1694.6", "6.9"},
		{"7", "Northern Territory", "912.6", "10.1"},
		{"8", "Australian Capital Territory", "1465", "3.7"},
	}
	rows := [][]string{header}
	for _, region := range regions {
		rows = append(rows,
			[]string{"ABS:HSI_M(1.6.0)", "7: Household spending", "TOT: Total", "CUR: Current Price", "20: Seasonally Adjusted", region[0] + ": " + region[1], "M: Monthly", "2026-05", region[2], "AUD: Australian Dollars", "6: Millions", ""},
			[]string{"ABS:HSI_M(1.6.0)", "9: Household spending - Through the year percentage change", "TOT: Total", "CUR: Current Price", "20: Seasonally Adjusted", region[0] + ": " + region[1], "M: Monthly", "2026-05", region[3], "PCT: Percent", "0: Units", ""},
		)
	}
	return append(rows,
		// Rows below must be filtered by pinned codes, not labels.
		[]string{"ABS:HSI_M(1.6.0)", "7: Household spending", "10: Food", "CUR: Current Price", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2026-05", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:HSI_M(1.6.0)", "7: Household spending", "TOT: Total", "CUR: Current Price", "10: Original", "AUS: Australia", "M: Monthly", "2026-05", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:HSI_M(1.6.0)", "8: Household spending - Percentage change from previous period", "TOT: Total", "CUR: Current Price", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2026-05", "999", "PCT: Percent", "0: Units", ""},
		[]string{"ABS:HSI_M(1.6.0)", "7: Household spending", "TOT: Total", "CUR: Current Price", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2026-04", "", "AUD: Australian Dollars", "6: Millions", "q: Not available"},
	)
}

func TestSpendingPinnedSDMXQuery(t *testing.T) {
	if spendingFlow != "HSI_M" || spendingVersion != "1.6.0" ||
		spendingKey != "7+9.TOT.CUR.20.1+2+3+4+5+6+7+8+AUS.M" || spendingStartPeriod != "2019-01" {
		t.Fatalf("unexpected spending query: flow=%q version=%q key=%q start=%q", spendingFlow, spendingVersion, spendingKey, spendingStartPeriod)
	}
}

func TestParseSpending(t *testing.T) {
	obs, err := parseSpending(spendingFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 18 {
		t.Fatalf("want 18 selected measure/region observations, got %d: %#v", len(obs), obs)
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	level := byKey["spending.household.total.aus.seasadj"]
	yoy := byKey["spending.household_yoy.total.aus.seasadj"]
	if level.Value < 40e9 || level.Value > 120e9 {
		t.Fatalf("Australia spending magnitude %v outside guard $40B..$120B", level.Value)
	}
	if level.Value != 80_635_500_000 || yoy.Value != 5.5 {
		t.Fatalf("unexpected spending values: level=%#v yoy=%#v", level, yoy)
	}
	if level.Series.Unit != "aud" || yoy.Series.Unit != "percent" || level.Series.Frequency != "monthly" || level.Series.Adjustment != "seasadj" {
		t.Fatalf("unexpected spending metadata: level=%#v yoy=%#v", level.Series, yoy.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "HSI_M", "abs_dataflow_version": "1.6.0", "measure": "7", "category": "TOT",
		"price_adjustment": "CUR", "tsest": "20", "state": "AUS", "freq": "M", "unit_mult": "6",
	} {
		if got := level.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
	if yoy.Series.Dimensions["unit_mult"] != "0" {
		t.Errorf("YoY UNIT_MULT=%q, want 0", yoy.Series.Dimensions["unit_mult"])
	}
}

func TestParseSpendingMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "CATEGORY", "PRICE_ADJUSTMENT", "TSEST", "STATE", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseSpending(withoutSDMXColumn(spendingFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseSpendingRejectsInvalidRequiredRows(t *testing.T) {
	fixture := spendingFixture()
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{name: "truncated filtered row", row: fixture[len(fixture)-4][:10]},
		{name: "blank multiplier", row: replaceSDMXCell(fixture[1], 10, "")},
		{name: "malformed multiplier", row: replaceSDMXCell(fixture[1], 10, "million: Millions")},
		{name: "malformed observation", row: replaceSDMXCell(fixture[1], 8, "not-a-number")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseSpending([][]string{append([]string(nil), fixture[0]...), tt.row})
			assertSDMXRowError(t, err, "parseSpending", 2)
		})
	}
}

func TestParseSpendingHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseSpending([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseSpending(reverseSDMXColumns(spendingFixture()))
	if err != nil || len(obs) != 18 {
		t.Fatalf("reordered header input = (%d observations, %v), want (18, nil)", len(obs), err)
	}
}

func replaceSDMXCell(row []string, column int, value string) []string {
	out := append([]string(nil), row...)
	out[column] = value
	return out
}
