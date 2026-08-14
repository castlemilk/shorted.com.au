package houseprices

import (
	"math"
	"testing"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func findObs(obs []Observation, region, measure string) (Observation, bool) {
	for _, o := range obs {
		if o.RegionCode == region && o.Measure == measure {
			return o, true
		}
	}
	return Observation{}, false
}

func TestParseRBADate(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want string // YYYY-MM-DD
	}{
		{"31/12/2025", true, "2025-12-31"},
		{"30/06/1969", true, "1969-06-30"},
		{"01-Jun-2026", true, "2026-06-01"},
		{"Dec-2025", true, "2025-12-31"}, // month-end derivation
		{"", false, ""},
		{"not a date", false, ""},
	}
	for _, c := range cases {
		got, ok := parseRBADate(c.in)
		if ok != c.ok {
			t.Errorf("parseRBADate(%q) ok=%v want %v", c.in, ok, c.ok)
			continue
		}
		if ok && got.Format("2006-01-02") != c.want {
			t.Errorf("parseRBADate(%q)=%s want %s", c.in, got.Format("2006-01-02"), c.want)
		}
	}
}

func TestFindRBASeries(t *testing.T) {
	rows := [][]string{
		{"Title", "Cash Rate Target", "Other"},
		{"Series ID", "FIRMMCRT", "FOO"},
		{"30/06/2025", "3.85", "1.0"},
	}
	col, dataStart, ok := findRBASeries(rows, "FIRMMCRT")
	if !ok || col != 1 || dataStart != 2 {
		t.Fatalf("findRBASeries=col%d start%d ok%v, want col1 start2 true", col, dataStart, ok)
	}
	if _, _, ok := findRBASeries(rows, "NOPE"); ok {
		t.Errorf("findRBASeries(NOPE) should be false")
	}
}

func TestParseRBANationalSeries(t *testing.T) {
	rows := [][]string{
		{"Title", "Household dwellings"},
		{"Series ID", "BSPNSHNFD"},
		{"31/12/2025", "11821"},
		{"31/03/2026", ""}, // blank latest period skipped
		{"30/06/2026", "12000"},
	}
	obs, err := parseRBANationalSeries(rows, "e1-data.csv", "Q", "rba_e1", 1e9, []rbaSeriesSpec{
		{"BSPNSHNFD", "household_dwelling_assets", "AUD"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("got %d obs want 2 (blank skipped)", len(obs))
	}
	if !approx(obs[0].Value, 11821e9) {
		t.Errorf("scale: got %g want %g", obs[0].Value, 11821e9)
	}
	if obs[0].RegionCode != "AUS" || obs[0].Unit != "AUD" || obs[0].PeriodFreq != "Q" {
		t.Errorf("metadata wrong: %+v", obs[0])
	}
	if _, err := parseRBANationalSeries(rows, "x", "Q", "s", 1, []rbaSeriesSpec{{"MISSING", "m", "u"}}); err == nil {
		t.Errorf("missing series should error")
	}
}

func lendHeader() []string {
	return []string{"MEASURE: Measure", "HOUSING_PURPOSE: Housing Purpose", "REGION: Region",
		"TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status"}
}

func TestParseLENDHOUSING(t *testing.T) {
	rows := [][]string{
		lendHeader(),
		{"FIN_VAL: Value", "DV5167: Owner occupier", "AUS: Australia", "2025-Q4", "60000", "6: Millions", ""},
		{"FIN_VAL: Value", "DV5168: Investor", "AUS: Australia", "2025-Q4", "40000", "6: Millions", ""},
		{"FIN_VAL: Value", "DV5167: Owner occupier", "1: New South Wales", "2025-Q4", "19000", "6: Millions", ""},
		{"FIN_VAL: Value", "DV5168: Investor", "1: New South Wales", "2025-Q4", "14000", "6: Millions", ""},
		{"FIN_VAL: Value", "DV5168_FHB: Investor First Home Buyers", "AUS: Australia", "2025-Q4", "999", "6: Millions", ""}, // must be ignored
	}
	obs := parseLENDHOUSING(rows)

	oo, ok := findObs(obs, "AUS", "loan_commitments_oo")
	if !ok || !approx(oo.Value, 60000e6) {
		t.Errorf("AUS OO: got %+v ok=%v want 6e10", oo, ok)
	}
	inv, ok := findObs(obs, "AUS", "loan_commitments_investor")
	if !ok || !approx(inv.Value, 40000e6) {
		t.Errorf("AUS investor: got %+v ok=%v want 4e10", inv, ok)
	}
	share, ok := findObs(obs, "AUS", "investor_loan_share")
	if !ok || !approx(share.Value, 40.0) || share.Unit != "percent" {
		t.Errorf("AUS share: got %+v want 40.0 percent", share)
	}
	nswShare, ok := findObs(obs, "NSW", "investor_loan_share")
	if !ok || !approx(nswShare.Value, 14000.0/33000.0*100) {
		t.Errorf("NSW share: got %+v want %g", nswShare, 14000.0/33000.0*100)
	}
	// FHB sub-split must not have produced any observation
	for _, o := range obs {
		if o.Measure == "loan_commitments_oo" || o.Measure == "loan_commitments_investor" {
			if o.Value == 999e6 {
				t.Errorf("FHB row leaked into output: %+v", o)
			}
		}
	}
}

func TestParseDerivedPriceIndex(t *testing.T) {
	header := []string{"MEASURE: Measure", "REGION: Region", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MULT: Unit of Multiplier"}
	rows := [][]string{
		header,
		{"5: Mean price", "AUS: Australia", "2012-Q3", "550000", "0: Units"},
		{"5: Mean price", "AUS: Australia", "2011-Q3", "500000", "0: Units"}, // earliest = base
		{"5: Mean price", "AUS: Australia", "2013-Q3", "600000", "0: Units"},
		{"1: Total value", "AUS: Australia", "2011-Q3", "9999", "0: Units"}, // wrong measure, ignored
	}
	obs := parseDerivedPriceIndex(rows)
	if len(obs) != 3 {
		t.Fatalf("got %d obs want 3", len(obs))
	}
	byPeriod := map[string]float64{}
	for _, o := range obs {
		if o.Measure != "price_index_derived" || o.Unit != "index" {
			t.Errorf("bad obs %+v", o)
		}
		byPeriod[o.Period.Format("2006")] = o.Value
	}
	if !approx(byPeriod["2011"], 100) || !approx(byPeriod["2012"], 110) || !approx(byPeriod["2013"], 120) {
		t.Errorf("rebasing wrong: %+v", byPeriod)
	}
}
