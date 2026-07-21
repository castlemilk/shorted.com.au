package main

import "testing"

// tradeFixture mirrors the real ABS,MERCH_EXP(1.0.0) SDMX-CSV shape (probed
// 2026-07-21): COMMODITY_SITC, COUNTRY_DEST, STATE_ORIGIN, FREQ, TIME_PERIOD,
// OBS_VALUE, UNIT_MULT. The national aggregate is STATE_ORIGIN="TOT" (not
// "AUS" as the plan guessed) — trade.go normalizes "TOT" to lfStates["AUS"].
func tradeFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_DEST: Country of Destination", "STATE_ORIGIN: State of Origin", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "2: Crude materials, inedible, except fuels", "TOT: Total", "5: Western Australia", "M: Monthly", "2026-05", "18000", "3: Thousands"},
		{"ABS:MERCH_EXP(1.0.0)", "2: Crude materials, inedible, except fuels", "036: Japan", "5: Western Australia", "M: Monthly", "2026-05", "4000", "3: Thousands"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "TOT: Total", "M: Monthly", "2026-05", "45000", "3: Thousands"},
		{"ABS:MERCH_EXP(1.0.0)", "2: Crude materials, inedible, except fuels", "TOT: Total", "9: No state details", "M: Monthly", "2026-05", "500", "3: Thousands"},
	}
}

func TestParseTrade(t *testing.T) {
	obs, err := parseTrade(tradeFixture(), "export_value", "STATE_ORIGIN")
	if err != nil {
		t.Fatal(err)
	}
	// 2 rows kept: WA crude-materials Total-country row + national total row.
	// The per-country (Japan) row and the "no state details" row are filtered.
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (per-country + no-state-details rows filtered), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if v, ok := byKey["trade.export_value.crude_materials_inedible_except_fuels.wa"]; !ok || v != 1.8e7 {
		t.Fatalf("WA crude materials wrong: %#v", byKey)
	}
	if v, ok := byKey["trade.export_value.total.aus"]; !ok || v != 4.5e7 {
		t.Fatalf("national total wrong: %#v", byKey)
	}

	// Dimensions carries the raw SITC code.
	for _, o := range obs {
		if o.Series.RegionCode == "wa" && o.Series.Dimensions["sitc_code"] != "2" {
			t.Fatalf("expected raw sitc code 2, got %#v", o.Series.Dimensions)
		}
	}
}

func TestParseTradeEmpty(t *testing.T) {
	obs, err := parseTrade([][]string{{"DATAFLOW"}}, "export_value", "STATE_ORIGIN")
	if err != nil {
		t.Fatal(err)
	}
	if obs != nil {
		t.Fatalf("expected nil obs for header-only input, got %#v", obs)
	}
}

func TestParseTradeUnknownState(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_DEST: Country of Destination", "STATE_ORIGIN: State of Origin", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "9: No state details", "M: Monthly", "2026-05", "500", "3: Thousands"},
	}
	obs, err := parseTrade(rows, "export_value", "STATE_ORIGIN")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 0 {
		t.Fatalf("expected 'no state details' rows to be filtered, got %#v", obs)
	}
}
