package economy

import "testing"

// lendingFixture mirrors the pinned ABS,LEND_HOUSING(1.1) SDMX-CSV shape
// from the 2026-07-23 probe. Dimension order is MEASURE.DATA_ITEM.LOAN_TYPE.
// LOAN_PURPOSE.LENDER_TYPE.HOUSING_PURPOSE.TSEST.REGION.FREQ.
func lendingFixture() [][]string {
	header := []string{"DATAFLOW", "MEASURE: Measure", "DATA_ITEM: Data Item", "LOAN_TYPE: Loan Type", "LOAN_PURPOSE: Loan Purpose", "LENDER_TYPE: Lender Type", "HOUSING_PURPOSE: Housing Purpose", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status"}
	regions := [][4]string{
		{"AUS", "Australia", "61421.6", "41537.6"},
		{"1", "New South Wales", "19375.8", "14831.1"},
		{"2", "Victoria", "16808.9", "8889.6"},
		{"3", "Queensland", "13447.2", "9480.9"},
		{"4", "South Australia", "3533.7", "2606.9"},
		{"5", "Western Australia", "6852.4", "4395.6"},
		{"6", "Tasmania", "838", "495.8"},
		{"7", "Northern Territory", "266.1", "210.6"},
		{"8", "Australian Capital Territory", "1500.6", "566"},
	}
	rows := [][]string{header}
	for _, region := range regions {
		for _, purpose := range [][3]string{{"DV5167", "Owner occupier", region[2]}, {"DV5168", "Investor", region[3]}} {
			rows = append(rows, []string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTDWELL: Total dwellings excluding refinancing", "TOT: Total lender type", purpose[0] + ": " + purpose[1], "20: Seasonally Adjusted", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q1", purpose[2], "AUD: Australian Dollars", "6: Millions", ""})
		}
	}
	return append(rows,
		[]string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTHOUS: Total housing excluding refinancing", "TOT: Total lender type", "DV5168: Investor", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTDWELL: Total dwellings excluding refinancing", "TOT: Total lender type", "DV5168_FHB: Investor First Home Buyers", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTDWELL: Total dwellings excluding refinancing", "MAJ_B: Major Banks", "DV5168: Investor", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTDWELL: Total dwellings excluding refinancing", "TOT: Total lender type", "DV5168: Investor", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", ""},
		[]string{"ABS:LEND_HOUSING(1.1)", "FIN_VAL: Value", "NEWCOMMITS: New loan commitments", "DV8368: Total fixed term loans and revolving credit", "TOTDWELL: Total dwellings excluding refinancing", "TOT: Total lender type", "DV5168: Investor", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2025-Q4", "", "AUD: Australian Dollars", "6: Millions", "q: Not available"},
	)
}

func TestLendingPinnedSDMXQuery(t *testing.T) {
	if lendingFlow != "LEND_HOUSING" || lendingVersion != "1.1" ||
		lendingKey != "FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.DV5167+DV5168.20.1+2+3+4+5+6+7+8+AUS.Q" || lendingStartPeriod != "2019-Q3" {
		t.Fatalf("unexpected lending query: flow=%q version=%q key=%q start=%q", lendingFlow, lendingVersion, lendingKey, lendingStartPeriod)
	}
}

func TestParseLending(t *testing.T) {
	obs, err := parseLending(lendingFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 18 {
		t.Fatalf("want 18 selected purpose/region observations, got %d: %#v", len(obs), obs)
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	owner := byKey["lending.new_commitments.owner_occupier.aus.seasadj"]
	investor := byKey["lending.new_commitments.investor.aus.seasadj"]
	if owner.Value < 1e9 || owner.Value > 70e9 || investor.Value < 1e9 || investor.Value > 60e9 {
		t.Fatalf("national lending magnitudes outside sane bands: owner=%v investor=%v", owner.Value, investor.Value)
	}
	if owner.Value != 61_421_600_000 || investor.Value != 41_537_600_000 {
		t.Fatalf("unexpected lending values: owner=%#v investor=%#v", owner, investor)
	}
	nt := byKey["lending.new_commitments.investor.nt.seasadj"]
	if nt.Value < 100e6 || nt.Value > 30e9 {
		t.Fatalf("NT investor lending magnitude %v outside state guard $0.1B..$30B", nt.Value)
	}
	if owner.Series.Unit != "aud" || owner.Series.Frequency != "quarterly" || owner.Series.Adjustment != "seasadj" {
		t.Fatalf("unexpected lending metadata: %#v", owner.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "LEND_HOUSING", "abs_dataflow_version": "1.1", "measure": "FIN_VAL", "data_item": "NEWCOMMITS",
		"loan_type": "DV8368", "loan_purpose": "TOTDWELL", "lender_type": "TOT", "housing_purpose": "DV5167",
		"tsest": "20", "region": "AUS", "freq": "Q", "unit_mult": "6",
	} {
		if got := owner.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseLendingMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "DATA_ITEM", "LOAN_TYPE", "LOAN_PURPOSE", "LENDER_TYPE", "HOUSING_PURPOSE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseLending(withoutSDMXColumn(lendingFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseLendingRejectsInvalidRequiredRows(t *testing.T) {
	fixture := lendingFixture()
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{name: "truncated filtered row", row: fixture[len(fixture)-5][:13]},
		{name: "blank multiplier", row: replaceSDMXCell(fixture[1], 13, "")},
		{name: "malformed multiplier", row: replaceSDMXCell(fixture[1], 13, "six: Millions")},
		{name: "malformed observation", row: replaceSDMXCell(fixture[1], 11, "not-a-number")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseLending([][]string{append([]string(nil), fixture[0]...), tt.row})
			assertSDMXRowError(t, err, "parseLending", 2)
		})
	}
}

func TestParseLendingHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseLending([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseLending(reverseSDMXColumns(lendingFixture()))
	if err != nil || len(obs) != 18 {
		t.Fatalf("reordered header input = (%d observations, %v), want (18, nil)", len(obs), err)
	}
}
