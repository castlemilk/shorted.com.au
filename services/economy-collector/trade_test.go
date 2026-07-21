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

// tradeImportFixture mirrors the real ABS,MERCH_IMP(1.0.0) shape: STATE_DEST
// + COUNTRY_ORIGIN instead of STATE_ORIGIN + COUNTRY_DEST.
func tradeImportFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_ORIGIN: Country of Origin", "STATE_DEST: State of Destination", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_IMP(1.0.0)", "7: Machinery and transport equipment", "TOT: Total", "3: Queensland", "M: Monthly", "2026-05", "9000", "3: Thousands"},
		{"ABS:MERCH_IMP(1.0.0)", "7: Machinery and transport equipment", "CHIN: China (excludes SARs and Taiwan)", "3: Queensland", "M: Monthly", "2026-05", "3000", "3: Thousands"},
	}
}

func TestParseTrade(t *testing.T) {
	obs, err := parseTrade(tradeFixture(), "export_value", "STATE_ORIGIN", "MERCH_EXP")
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

	// Dimensions carries the raw SITC code and the source dataflow.
	for _, o := range obs {
		if o.Series.RegionCode == "wa" {
			if o.Series.Dimensions["sitc_code"] != "2" {
				t.Fatalf("expected raw sitc code 2, got %#v", o.Series.Dimensions)
			}
			if o.Series.Dimensions["abs_dataflow"] != "MERCH_EXP" {
				t.Fatalf("expected abs_dataflow MERCH_EXP, got %#v", o.Series.Dimensions)
			}
		}
	}
}

func TestParseTradeImport(t *testing.T) {
	obs, err := parseTrade(tradeImportFixture(), "import_value", "STATE_DEST", "MERCH_IMP")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs (per-country row filtered), got %d: %#v", len(obs), obs)
	}
	o := obs[0]
	if o.Series.Key() != "trade.import_value.machinery_and_transport_equipment.qld" {
		t.Fatalf("unexpected series key: %s", o.Series.Key())
	}
	if o.Value != 9e6 {
		t.Fatalf("unexpected value: %v", o.Value)
	}
	if o.Series.Dimensions["abs_dataflow"] != "MERCH_IMP" {
		t.Fatalf("expected abs_dataflow MERCH_IMP, got %#v", o.Series.Dimensions)
	}
}

func TestParseTradeMixedFrequency(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_DEST: Country of Destination", "STATE_ORIGIN: State of Origin", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "TOT: Total", "M: Monthly", "2026-05", "45000", "3: Thousands"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "TOT: Total", "A: Annual", "2026", "500000", "3: Thousands"},
	}
	obs, err := parseTrade(rows, "export_value", "STATE_ORIGIN", "MERCH_EXP")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs (annual-frequency row filtered), got %d: %#v", len(obs), obs)
	}
	if obs[0].Series.Frequency != "monthly" {
		t.Fatalf("expected monthly, got %s", obs[0].Series.Frequency)
	}
}

func TestParseTradeMissingCountryColumn(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "STATE_ORIGIN: State of Origin", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "M: Monthly", "2026-05", "45000", "3: Thousands"},
	}
	_, err := parseTrade(rows, "export_value", "STATE_ORIGIN", "MERCH_EXP")
	if err == nil {
		t.Fatal("expected error for missing country dimension, got nil")
	}
}

func TestParseTradeMissingFreqColumn(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_DEST: Country of Destination", "STATE_ORIGIN: State of Origin", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "TOT: Total", "TOT: Total", "TOT: Total", "2026-05", "45000", "3: Thousands"},
	}
	_, err := parseTrade(rows, "export_value", "STATE_ORIGIN", "MERCH_EXP")
	if err == nil {
		t.Fatal("expected error for missing FREQ dimension, got nil")
	}
}

func TestParseTradeEmpty(t *testing.T) {
	obs, err := parseTrade([][]string{{"DATAFLOW"}}, "export_value", "STATE_ORIGIN", "MERCH_EXP")
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
	obs, err := parseTrade(rows, "export_value", "STATE_ORIGIN", "MERCH_EXP")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 0 {
		t.Fatalf("expected 'no state details' rows to be filtered, got %#v", obs)
	}
}

func TestParseTradeUnknownSITCCode(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "COMMODITY_SITC: Commodity by SITC", "COUNTRY_DEST: Country of Destination", "STATE_ORIGIN: State of Origin", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:MERCH_EXP(1.0.0)", "776: Thermionic valves and tubes", "TOT: Total", "5: Western Australia", "M: Monthly", "2026-05", "500", "3: Thousands"},
	}
	obs, err := parseTrade(rows, "export_value", "STATE_ORIGIN", "MERCH_EXP")
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 0 {
		t.Fatalf("expected unmapped SITC code to be skipped (fail closed), got %#v", obs)
	}
}
