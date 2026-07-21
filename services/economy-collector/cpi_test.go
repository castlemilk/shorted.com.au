package main

import "testing"

// cpiFixture mirrors the REAL ABS,CPI(2.0.0) SDMX-CSV header (probed
// 2026-07-21): no UNIT_MULT column (values are already correctly scaled),
// REGION=50 is labelled "Australia" (not "weighted average of eight capital
// cities" as originally guessed), and the dataflow now mixes FREQ=Q
// (quarterly index numbers, long history back to 2000) with FREQ=M (monthly
// annual % change, only available from 2025-04 onward — the ABS Monthly CPI
// Indicator has no quarterly-frequency annual-change series for INDEX=10001).
func cpiFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "INDEX: Index", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "OBS_STATUS: Observation Status", "DECIMALS: Decimals", "OBS_COMMENT: Observation Comment", "BASE_PERIOD: Reference Base Period"},
		// kept: quarterly All groups CPI index number, Australia, original series
		{"ABS:CPI(2.0.0)", "1: Index numbers", "10001: All groups CPI", "10: Original", "50: Australia", "Q: Quarterly", "2026-Q1", "101.7", "IN: Index Numbers", "", "", "", "25: Sep 2025 = 100.0"},
		// kept: monthly annual % change, All groups CPI, Australia, original series
		{"ABS:CPI(2.0.0)", "3: Percentage change from previous year", "10001: All groups CPI", "10: Original", "50: Australia", "M: Monthly", "2026-05", "4", "PCT: Percent", "", "", "", "25: Sep 2025 = 100.0"},
		// filtered: wrong INDEX (a sub-group, not All groups CPI)
		{"ABS:CPI(2.0.0)", "1: Index numbers", "20005: Transport", "10: Original", "50: Australia", "Q: Quarterly", "2026-Q1", "999", "IN: Index Numbers", "", "", "", "25: Sep 2025 = 100.0"},
		// filtered: index numbers published monthly are skipped — the index
		// series is quarterly-only to avoid double-counting the same period
		{"ABS:CPI(2.0.0)", "1: Index numbers", "10001: All groups CPI", "10: Original", "50: Australia", "M: Monthly", "2026-05", "102.09", "IN: Index Numbers", "", "", "", "25: Sep 2025 = 100.0"},
		// filtered: wrong REGION (Sydney, not the national Australia aggregate)
		{"ABS:CPI(2.0.0)", "1: Index numbers", "10001: All groups CPI", "10: Original", "1: Sydney", "Q: Quarterly", "2026-Q1", "999", "IN: Index Numbers", "", "", "", "25: Sep 2025 = 100.0"},
		// filtered: seasonally adjusted, not original series
		{"ABS:CPI(2.0.0)", "1: Index numbers", "10001: All groups CPI", "20: Seasonally Adjusted", "50: Australia", "Q: Quarterly", "2026-Q1", "999", "IN: Index Numbers", "", "", "", "25: Sep 2025 = 100.0"},
	}
}

func TestParseCPI(t *testing.T) {
	obs, err := parseCPI(cpiFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (non-matching rows filtered), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]float64{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o.Value
	}
	if byKey["cpi.index.all_groups.aus"] != 101.7 {
		t.Fatalf("index obs missing/wrong: %#v", byKey)
	}
	if byKey["cpi.annual_change.all_groups.aus"] != 4 {
		t.Fatalf("annual change obs missing/wrong: %#v", byKey)
	}
}
