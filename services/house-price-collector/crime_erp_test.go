package main

import "testing"

func erpRecords() [][]string {
	header := []string{
		"DATAFLOW", "MEASURE: Measure", "SEX: Sex", "AGE: Age",
		"REGION_TYPE: Geography Level", "ASGS_2021: Region", "FREQ: Frequency",
		"TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure",
		"OBS_STATUS: Observation Status", "OBS_COMMENT: Observation Comment",
	}
	row := func(region, year, val string) []string {
		return []string{"ABS:ERP_ASGS2021(1.0.0)", "ERP: Estimated Resident Population",
			"3: Persons", "TOT: All ages", "STE: States and Territories", region,
			"A: Annual", year, val, "PSNS: Persons", "", ""}
	}
	return [][]string{
		header,
		row("1: New South Wales", "2021", "8000000"),
		row("1: New South Wales", "2024", "8300000"),
		row("2: Victoria", "2021", "6500000"),
		row("2: Victoria", "2024", "6800000"),
		row("9: Other Territories", "2024", "5000"), // ignored (not a state)
	}
}

func TestParseStateERP(t *testing.T) {
	got, err := parseStateERP(erpRecords())
	if err != nil {
		t.Fatal(err)
	}
	if got["NSW"][2021] != 8000000 || got["NSW"][2024] != 8300000 {
		t.Errorf("NSW series wrong: %+v", got["NSW"])
	}
	if got["VIC"][2021] != 6500000 {
		t.Errorf("VIC 2021 wrong: %v", got["VIC"][2021])
	}
	if _, ok := got["Other Territories"]; ok {
		t.Error("Other Territories should have been skipped")
	}
}

func TestStateGrowthIndexAndERP(t *testing.T) {
	erp := &ERPTable{
		salPop:   map[string]int{"SAL1": 1000},
		salState: map[string]string{"SAL1": "NSW"},
		baseYear: 2021,
	}
	series, _ := parseStateERP(erpRecords())
	erp.setStateERP(series)

	// index(2024) = 8.3e6 / 8.0e6 = 1.0375
	crimeApprox(t, "idx2024", erp.stateGrowthIndex("NSW", 2024), 1.0375, 1e-9)
	// clamps beyond the series range to the nearest available year
	crimeApprox(t, "idx2030clamp", erp.stateGrowthIndex("NSW", 2030), 1.0375, 1e-9)
	crimeApprox(t, "idx2000clamp", erp.stateGrowthIndex("NSW", 2000), 1.0, 1e-9) // clamps to 2021 = base
	// unknown state → no adjustment
	crimeApprox(t, "idxUnknown", erp.stateGrowthIndex("ZZZ", 2024), 1.0, 1e-9)

	got, ok := erp.ERP("SAL1", 2024)
	if !ok {
		t.Fatal("ERP(SAL1,2024) not found")
	}
	crimeApprox(t, "ERP", got, 1037.5, 1e-6) // 1000 * 1.0375

	if _, ok := erp.ERP("UNKNOWN", 2024); ok {
		t.Error("ERP for an unknown suburb should be false")
	}
}

func TestCVSFYFromPeriod(t *testing.T) {
	cases := map[string]int{"2023–25": 2025, "2008–10": 2010, "2022–24": 2024}
	for in, want := range cases {
		got, ok := cvsFYFromPeriod(in)
		if !ok || got != want {
			t.Errorf("cvsFYFromPeriod(%q) = (%d,%v), want %d", in, got, ok, want)
		}
	}
}
