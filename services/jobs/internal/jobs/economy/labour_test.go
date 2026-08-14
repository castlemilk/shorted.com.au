package economy

import (
	"math"
	"testing"
)

// lfFixture mirrors the REAL ABS,LF(1.0.0) SDMX-CSV header (probed
// 2026-07-21): the region dimension is named REGION (not STATE as guessed),
// MEASURE codes are "M"-prefixed (M13=unemployment rate, M12=participation
// rate, M3=employed persons — not the bare "14"/"15"/"5" guessed), and
// UNIT_MULT IS present here (unlike CPI) so employed persons needs scaling by
// 10^3 via absdata.ApplyMult rather than a hardcoded literal.
func lfFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "SEX: Sex", "AGE: Age", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status", "OBS_COMMENT: Observation Comment", "DECIMALS: Decimals"},
		// kept: NSW unemployment rate, persons, seasonally adjusted
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "3: Persons", "1599: Total (age)", "20: Seasonally Adjusted", "1: New South Wales", "M: Monthly", "2026-05", "4.29708853", "PCT: Percent", "0: Units", "", "", "1: One"},
		// kept: AUS employed persons, scaled by UNIT_MULT 10^3 (Thousands)
		{"ABS:LF(1.0.0)", "M3: Employed persons", "3: Persons", "1599: Total (age)", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2026-05", "14738.83914046", "NUM: Number", "3: Thousands", "", "", "1: One"},
		// filtered: wrong SEX (males, not persons)
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "1: Males", "1599: Total (age)", "20: Seasonally Adjusted", "1: New South Wales", "M: Monthly", "2026-05", "4.4", "PCT: Percent", "0: Units", "", "", "1: One"},
		// filtered: wrong TSEST (trend, not seasonally adjusted)
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "3: Persons", "1599: Total (age)", "30: Trend", "1: New South Wales", "M: Monthly", "2026-05", "4.3", "PCT: Percent", "0: Units", "", "", "1: One"},
		// filtered: unmapped MEASURE (civilian population, not a tracked metric)
		{"ABS:LF(1.0.0)", "M11: Civilian population", "3: Persons", "1599: Total (age)", "20: Seasonally Adjusted", "AUS: Australia", "M: Monthly", "2026-05", "22000", "NUM: Number", "3: Thousands", "", "", "1: One"},
		// filtered: wrong FREQ (quarterly, not monthly) — LF publishes monthly
		// only, but this guards against a future dataflow change silently
		// double-counting a period under two frequencies (mirrors cpi.go)
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "3: Persons", "1599: Total (age)", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2026-Q2", "4.3", "PCT: Percent", "0: Units", "", "", "1: One"},
		// filtered: unmapped REGION (a region code not in lfStates)
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "3: Persons", "1599: Total (age)", "20: Seasonally Adjusted", "9: Other Territories", "M: Monthly", "2026-05", "5.0", "PCT: Percent", "0: Units", "", "", "1: One"},
		// filtered: wrong AGE (15-24 age bracket, not total)
		{"ABS:LF(1.0.0)", "M13: Unemployment rate", "3: Persons", "1524: 15-24 years", "20: Seasonally Adjusted", "1: New South Wales", "M: Monthly", "2026-05", "9.1", "PCT: Percent", "0: Units", "", "", "1: One"},
	}
}

func TestParseLabour(t *testing.T) {
	obs, err := parseLabour(lfFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (males/trend/unmapped-measure/wrong-freq/unmapped-region/wrong-age rows filtered), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}

	nsw, ok := byKey["labour.unemployment_rate.total.nsw.seasadj"]
	if !ok || nsw.Value != 4.29708853 {
		t.Fatalf("nsw unemployment missing/wrong: %#v", byKey)
	}
	if nsw.Series.Frequency != "monthly" {
		t.Fatalf("nsw unemployment frequency: want monthly, got %q", nsw.Series.Frequency)
	}
	// Dimensions["region"] must carry the RAW ABS region code ("1"), not the
	// normalized RegionCode ("nsw") which already lives on SeriesDef.
	if got := nsw.Series.Dimensions["region"]; got != "1" {
		t.Fatalf("nsw unemployment dimensions[region]: want raw code %q, got %q", "1", got)
	}

	// employed persons scaled by UNIT_MULT 10^3
	aus, ok := byKey["labour.employed_persons.total.aus.seasadj"]
	if !ok {
		t.Fatalf("aus employed persons missing: %#v", byKey)
	}
	if want := 14738839.14046; math.Abs(aus.Value-want) > 1e-6 {
		t.Fatalf("employed persons wrong: got %v want %v", aus.Value, want)
	}
	if got := aus.Series.Dimensions["region"]; got != "AUS" {
		t.Fatalf("aus employed persons dimensions[region]: want raw code %q, got %q", "AUS", got)
	}
}
