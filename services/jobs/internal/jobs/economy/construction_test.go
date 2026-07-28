package economy

import "testing"

// constructionFixture mirrors the pinned ABS,CWD(1.0.0) SDMX-CSV shape
// from the 2026-07-23 probe, including the exact construction-type header.
// Dimension order is MEASURE.PRICE_ADJUSTMENT.SECTOR_OWN.CONSTRUCTION_TYPE.
// TSEST.REGION.FREQ.
func constructionFixture() [][]string {
	header := []string{"DATAFLOW", "MEASURE: Measure", "PRICE_ADJUSTMENT: Price Adjustment", "SECTOR_OWN: Sector of Ownership", "CONSTRUCTION_TYPE: Type of Construction", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status"}
	regions := [][5]string{
		{"AUS", "Australia", "44708564", "38652035", "83360599"},
		{"1", "New South Wales", "13631961", "9709675", "23341636"},
		{"2", "Victoria", "12651418", "5757560", "18408978"},
		{"3", "Queensland", "9557150", "7311227", "16868377"},
		{"4", "South Australia", "2708836", "2733099", "5441935"},
		{"5", "Western Australia", "4456681", "11775048", "16231729"},
		{"6", "Tasmania", "593617", "622375", "1215992"},
		{"7", "Northern Territory", "367346", "387411", "754757"},
		{"8", "Australian Capital Territory", "783363", "287930", "1071293"},
	}
	rows := [][]string{header}
	for _, region := range regions {
		for _, constructionType := range [][3]string{{"03", "Total building", region[2]}, {"04", "Engineering construction", region[3]}, {"TOT", "Total construction", region[4]}} {
			rows = append(rows, []string{"ABS:CWD(1.0.0)", "M1: Value of work done", "CVM: Chain Volume Measures", "9: Total Sectors", constructionType[0] + ": " + constructionType[1], "20: Seasonally Adjusted", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q1", constructionType[2], "AUD: Australian Dollars", "3: Thousands", ""})
		}
	}
	return append(rows,
		[]string{"ABS:CWD(1.0.0)", "M1: Value of work done", "CVM: Chain Volume Measures", "1: Private Sector", "TOT: Total construction", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "3: Thousands", ""},
		[]string{"ABS:CWD(1.0.0)", "M1: Value of work done", "CUR: Current Price", "9: Total Sectors", "TOT: Total construction", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "3: Thousands", ""},
		[]string{"ABS:CWD(1.0.0)", "M1: Value of work done", "CVM: Chain Volume Measures", "9: Total Sectors", "TOT: Total construction", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "3: Thousands", ""},
		[]string{"ABS:CWD(1.0.0)", "M1: Value of work done", "CVM: Chain Volume Measures", "9: Total Sectors", "TOT: Total construction", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2025-Q4", "", "AUD: Australian Dollars", "3: Thousands", "q: Not available"},
	)
}

func TestConstructionPinnedSDMXQuery(t *testing.T) {
	if constructionFlow != "CWD" || constructionVersion != "1.0.0" ||
		constructionKey != "M1.CVM.9.03+04+TOT.20.1+2+3+4+5+6+7+8+AUS.Q" || constructionStartPeriod != "2000-Q1" {
		t.Fatalf("unexpected construction query: flow=%q version=%q key=%q start=%q", constructionFlow, constructionVersion, constructionKey, constructionStartPeriod)
	}
}

func TestParseConstruction(t *testing.T) {
	obs, err := parseConstruction(constructionFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 27 {
		t.Fatalf("want 27 selected type/region observations, got %d: %#v", len(obs), obs)
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	building := byKey["construction.work_done.building.aus.seasadj"]
	engineering := byKey["construction.work_done.engineering.aus.seasadj"]
	total := byKey["construction.work_done.total.aus.seasadj"]
	if building.Value < 1e9 || building.Value > 60e9 || engineering.Value < 1e9 || engineering.Value > 60e9 || total.Value < 40e9 || total.Value > 120e9 {
		t.Fatalf("national construction magnitudes outside sane family bands: building=%v engineering=%v total=%v", building.Value, engineering.Value, total.Value)
	}
	if building.Value != 44_708_564_000 || engineering.Value != 38_652_035_000 || total.Value != 83_360_599_000 {
		t.Fatalf("unexpected construction values: building=%#v engineering=%#v total=%#v", building, engineering, total)
	}
	nt := byKey["construction.work_done.total.nt.seasadj"]
	if nt.Value < 100e6 || nt.Value > 40e9 {
		t.Fatalf("NT total construction magnitude %v outside state guard $0.1B..$40B", nt.Value)
	}
	if total.Series.Unit != "aud" || total.Series.Frequency != "quarterly" || total.Series.Adjustment != "seasadj" {
		t.Fatalf("unexpected construction metadata: %#v", total.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "CWD", "abs_dataflow_version": "1.0.0", "measure": "M1", "price_adjustment": "CVM",
		"sector_own": "9", "construction_type": "TOT", "tsest": "20", "region": "AUS", "freq": "Q", "unit_mult": "3",
	} {
		if got := total.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseConstructionMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "PRICE_ADJUSTMENT", "SECTOR_OWN", "CONSTRUCTION_TYPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseConstruction(withoutSDMXColumn(constructionFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseConstructionRejectsInvalidRequiredRows(t *testing.T) {
	fixture := constructionFixture()
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{name: "truncated filtered row", row: fixture[len(fixture)-4][:11]},
		{name: "blank multiplier", row: replaceSDMXCell(fixture[1], 11, "")},
		{name: "malformed multiplier", row: replaceSDMXCell(fixture[1], 11, "thousand: Thousands")},
		{name: "malformed observation", row: replaceSDMXCell(fixture[1], 9, "not-a-number")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseConstruction([][]string{append([]string(nil), fixture[0]...), tt.row})
			assertSDMXRowError(t, err, "parseConstruction", 2)
		})
	}
}

func TestParseConstructionHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseConstruction([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseConstruction(reverseSDMXColumns(constructionFixture()))
	if err != nil || len(obs) != 27 {
		t.Fatalf("reordered header input = (%d observations, %v), want (27, nil)", len(obs), err)
	}
}
