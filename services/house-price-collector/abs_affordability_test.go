package main

import (
	"math"
	"testing"
)

func TestParsePriceToIncome(t *testing.T) {
	priceRows := [][]string{
		{"MEASURE: Measure", "REGION: Region", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"},
		{"5: Mean price", "AUS: Australia", "2015-Q1", "600000", "0: Units"},
		{"5: Mean price", "AUS: Australia", "2016-Q1", "660000", "0: Units"},
		{"5: Mean price", "AUS: Australia", "2017-Q1", "720000", "0: Units"},
		{"1: Total value", "AUS: Australia", "2016-Q1", "999", "0: Units"},    // wrong measure, ignored
		{"5: Mean price", "1: New South Wales", "2016-Q1", "888", "0: Units"}, // state, ignored
	}
	wageRows := [][]string{
		{"MEASURE: Measure", "INDEX: Index", "REGION: Region", "TIME_PERIOD: Time Period", "OBS_VALUE"},
		{"1: Index", "THRPEB", "AUS: Australia", "2015-Q1", "100"},
		{"1: Index", "THRPEB", "AUS: Australia", "2016-Q1", "102"},
		{"1: Index", "THRPEB", "AUS: Australia", "2017-Q1", "104"},
	}
	obs := parsePriceToIncome(priceRows, wageRows)
	if len(obs) != 3 {
		t.Fatalf("got %d obs want 3", len(obs))
	}
	byYear := map[int]float64{}
	for _, o := range obs {
		if o.Measure != "price_to_income" || o.Unit != "index" || o.RegionCode != "AUS" || o.Source != "abs_derived" {
			t.Errorf("bad obs %+v", o)
		}
		byYear[o.Period.Year()] = o.Value
	}
	// base 2015 = 100; 2016 = (660/600)/(102/100)*100; 2017 = (720/600)/(104/100)*100
	want := map[int]float64{
		2015: 100,
		2016: (660000.0 / 600000.0) / (102.0 / 100.0) * 100,
		2017: (720000.0 / 600000.0) / (104.0 / 100.0) * 100,
	}
	for y, w := range want {
		if math.Abs(byYear[y]-w) > 1e-6 {
			t.Errorf("p2i %d: got %g want %g", y, byYear[y], w)
		}
	}
}

func TestParseABSNationalIndex(t *testing.T) {
	rows := [][]string{
		{"MEASURE: Measure", "INDEX: Index", "REGION: Region", "TIME_PERIOD: Time Period", "OBS_VALUE"},
		{"1: Index", "115522: Rents", "50: Australia", "2025-Q4", "101.46"},      // CPI national code 50
		{"1: Index", "115522: Rents", "1: New South Wales", "2025-Q4", "101.92"}, // state, ignored
	}
	obs := parseABSNationalIndex(rows, "rents_index", "abs_cpi")
	if len(obs) != 1 {
		t.Fatalf("got %d obs want 1 (national only)", len(obs))
	}
	if obs[0].RegionCode != "AUS" || obs[0].Measure != "rents_index" || obs[0].Value != 101.46 {
		t.Errorf("bad obs %+v", obs[0])
	}
}
