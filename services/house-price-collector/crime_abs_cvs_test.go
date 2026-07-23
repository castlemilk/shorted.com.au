package main

import (
	"testing"

	"github.com/xuri/excelize/v2"
)

// setRow writes values starting at column A of the given 1-based row.
func setRow(t *testing.T, f *excelize.File, sheet string, row int, vals ...interface{}) {
	t.Helper()
	cell, _ := excelize.CoordinatesToCellName(1, row)
	if err := f.SetSheetRow(sheet, cell, &vals); err != nil {
		t.Fatal(err)
	}
}

// buildCVSPooled builds a miniature pooled cube: Contents + a household rate
// sheet (30c) + its RSE sibling (30d) + a household reporting sheet (31c) + a
// personal rate sheet (27c) + a personal reporting sheet (28c). Periods columns
// are 2021–23, 2022–24, 2023–25 (fy 2023/2024/2025).
func buildCVSPooled(t *testing.T) []byte {
	t.Helper()
	f := excelize.NewFile()
	// Default sheet becomes Contents.
	_ = f.SetSheetName("Sheet1", "Contents")
	setRow(t, f, "Contents", 7, "Tab", "Description")
	setRow(t, f, "Contents", 8, "Table 27c", "Experience of selected personal crimes, Victimisation, Time series: Two-year pooled data victimisation rate")
	setRow(t, f, "Contents", 9, "Table 28c", "Experience of selected personal crimes, Persons who reported the most recent incident to police, Time series: Two-year pooled data reporting rate")
	setRow(t, f, "Contents", 10, "Table 30c", "Experience of selected household crimes, Victimisation, Time series: Two-year pooled data victimisation rate")
	setRow(t, f, "Contents", 11, "Table 30d", "Experience of selected household crimes, Victimisation, Time series: Two-year pooled data relative standard error of victimisation rate")
	setRow(t, f, "Contents", 12, "Table 31c", "Experience of selected household crimes, Households that reported the most recent incident to police, Time series: Two-year pooled data reporting rate")

	// A rate/RSE/reporting block: period header on row 5, "%" on row 6, then
	// offence blocks (label on col B, state rows below).
	writeBlockSheet := func(sheet string, blocks map[string][]float64) {
		if _, err := f.NewSheet(sheet); err != nil {
			t.Fatal(err)
		}
		setRow(t, f, sheet, 3, sheet+" title")
		// The latest period header carries the real ABS revision footnote "(d)"
		// — parseCVSSheet must strip it or the newest FY is silently dropped.
		setRow(t, f, sheet, 5, "", "2021–23", "2022–24", "2023–25(d)")
		setRow(t, f, sheet, 6, "", "%", "%", "%")
		r := 7
		for label, nsw := range blocks {
			setRow(t, f, sheet, r, "", label)
			setRow(t, f, sheet, r+1, "New South Wales", nsw[0], nsw[1], nsw[2])
			setRow(t, f, sheet, r+2, "Victoria", nsw[0], nsw[1], nsw[2])
			setRow(t, f, sheet, r+3, "Australia", nsw[0], nsw[1], nsw[2])
			r += 4
		}
	}

	// Household victimisation rate (30c): break-in / motor vehicle / malicious.
	writeBlockSheet("Table 30c", map[string][]float64{
		"Break–in":                  {1.2, 1.3, 1.5},
		"Motor vehicle theft":       {0.4, 0.5, 0.6},
		"Malicious property damage": {2.0, 2.1, 2.2},
	})
	// Household RSE of rate (30d): break-in has a high RSE (>25) for 2023–25.
	// RSE-sheet block labels carry the real "RSE of …" prefix.
	writeBlockSheet("Table 30d", map[string][]float64{
		"RSE of break–in": {10, 12, 30},
	})
	// Household reporting rate (31c).
	writeBlockSheet("Table 31c", map[string][]float64{
		"Break–in": {40, 41, 42},
	})
	// Personal victimisation rate (27c): total assault.
	writeBlockSheet("Table 27c", map[string][]float64{
		"Total physical and/or threatened assault(d)": {2.4, 2.3, 2.1},
	})
	// Personal reporting rate (28c): only "Physical assault" (violent proxy).
	writeBlockSheet("Table 28c", map[string][]float64{
		"Physical assault": {50, 52, 55},
	})

	b, err := f.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// buildCVSPop builds a miniature Populations cube: Contents + Table 37a with the
// 8 state columns and the persons-15+/households rows under a "2023–25(d)" block.
func buildCVSPop(t *testing.T) []byte {
	t.Helper()
	f := excelize.NewFile()
	_ = f.SetSheetName("Sheet1", "Contents")
	setRow(t, f, "Contents", 7, "Tab", "Description")
	setRow(t, f, "Contents", 8, "Table 37a", "Populations, By states and territories, Pooled data")

	if _, err := f.NewSheet("Table 37a"); err != nil {
		t.Fatal(err)
	}
	setRow(t, f, "Table 37a", 5, "", "New South Wales", "Victoria", "Queensland",
		"South Australia", "Western Australia", "Tasmania", "Northern Territory", "Australian Capital Territory", "Australia")
	setRow(t, f, "Table 37a", 6, "", "'000", "'000", "'000", "'000", "'000", "'000", "'000", "'000", "'000")
	setRow(t, f, "Table 37a", 7, "", "2023–25(d)")
	setRow(t, f, "Table 37a", 8, "Persons aged 15 years and over", 6845.6, 5631.6, 4420, 1523.8, 2340.4, 470.5, 174.2, 375.5, 21781.4)
	setRow(t, f, "Table 37a", 9, "Households", 3339.5, 2750.2, 2183.5, 769.7, 1134.4, 237.4, 65.4, 186.9, 10667)
	// A later period block that must be ignored (only the first is taken).
	setRow(t, f, "Table 37a", 10, "", "2022–25(e)")
	setRow(t, f, "Table 37a", 11, "Persons aged 15 years and over", 1, 1, 1, 1, 1, 1, 1, 1, 1)

	b, err := f.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestParseCVS(t *testing.T) {
	data, err := parseCVS(buildCVSPooled(t), buildCVSPop(t))
	if err != nil {
		t.Fatal(err)
	}

	nsw := data.Rate["NSW"]
	if nsw == nil {
		t.Fatal("no NSW rates parsed")
	}

	// Household rates located from Table 30c (NOT the RSE sibling 30d).
	if c := nsw[crimeBreakIns][2025]; !c.hasRate || c.rate != 1.5 {
		t.Errorf("break_ins 2025 rate = %+v, want 1.5", c)
	}
	if c := nsw[crimeBreakIns][2024]; c.rate != 1.3 {
		t.Errorf("break_ins 2024 rate = %v, want 1.3", c.rate)
	}
	if nsw[crimeMotorVehicle][2025].rate != 0.6 {
		t.Errorf("motor_vehicle 2025 = %v, want 0.6", nsw[crimeMotorVehicle][2025].rate)
	}
	if nsw[crimePropertyDamage][2025].rate != 2.2 {
		t.Errorf("property_damage 2025 = %v, want 2.2", nsw[crimePropertyDamage][2025].rate)
	}
	// Personal (violent) rate from Table 27c.
	if c := nsw[crimeViolent][2025]; !c.hasRate || c.rate != 2.1 {
		t.Errorf("violent 2025 rate = %+v, want 2.1", c)
	}

	// RSE > 25 for break_ins 2025 → unreliable flag captured on the cell.
	if nsw[crimeBreakIns][2025].rse != 30 {
		t.Errorf("break_ins 2025 rse = %v, want 30", nsw[crimeBreakIns][2025].rse)
	}
	// Reporting rate captured (household 31c + personal proxy 28c).
	if nsw[crimeBreakIns][2025].reportingRate != 42 {
		t.Errorf("break_ins 2025 reportingRate = %v, want 42", nsw[crimeBreakIns][2025].reportingRate)
	}
	if nsw[crimeViolent][2025].reportingRate != 55 {
		t.Errorf("violent 2025 reportingRate = %v, want 55", nsw[crimeViolent][2025].reportingRate)
	}

	// Population base: '000 → headcount, latest period only.
	if data.BaseFY != 2025 {
		t.Errorf("BaseFY = %d, want 2025", data.BaseFY)
	}
	crimeApprox(t, "NSW households", data.StateBase["NSW"].households, 3_339_500, 1)
	crimeApprox(t, "NSW persons15", data.StateBase["NSW"].persons15, 6_845_600, 1)
}

func TestParseCVSFloat(t *testing.T) {
	ok := map[string]float64{
		"1.5":       1.5,
		"(e)1.5":    1.5, // latest-period revision footnote marker
		"(a)2.0":    2.0,
		"3,339.5":   3339.5, // thousands separator
		" (c) 0.4 ": 0.4,
	}
	for in, want := range ok {
		got, valid := parseCVSFloat(in)
		if !valid || got != want {
			t.Errorf("parseCVSFloat(%q) = (%v,%v), want (%v,true)", in, got, valid, want)
		}
	}
	for _, in := range []string{"", "np", "–", "..", "..."} {
		if _, valid := parseCVSFloat(in); valid {
			t.Errorf("parseCVSFloat(%q) should be invalid", in)
		}
	}
}

func TestFindCVSTab_ExcludesRSE(t *testing.T) {
	contents := map[string]string{
		"Table 30c": "household crimes victimisation rate",
		"Table 30d": "household crimes relative standard error of victimisation rate",
	}
	if got := findCVSTab(contents, []string{"household crimes", "victimisation rate"}, []string{"relative standard error"}); got != "Table 30c" {
		t.Errorf("findCVSTab picked %q, want Table 30c", got)
	}
}

// The latest period header carries a revision footnote ("2023–25(d)"). The
// anchored period regex won't match it raw, so parseCVSSheet must strip the
// footnote first — otherwise the NEWEST FY (2025, the map's read) is dropped
// while the older clean columns still locate the header row (no error surfaces).
func TestParseCVSSheet_FootnotedPeriodHeader(t *testing.T) {
	f := excelize.NewFile()
	_ = f.SetSheetName("Sheet1", "S")
	setRow(t, f, "S", 3, "S title")
	setRow(t, f, "S", 5, "", "2021–23", "2022–24", "2023–25(d)")
	setRow(t, f, "S", 6, "", "%", "%", "%")
	setRow(t, f, "S", 7, "", "Break–in")
	setRow(t, f, "S", 8, "New South Wales", 1.2, 1.3, 1.5)
	setRow(t, f, "S", 9, "Australia", 1.2, 1.3, 1.5)

	vals, err := parseCVSSheet(f, "S", cvsCrimeType)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := vals["NSW"][crimeBreakIns][2025]
	if !ok {
		t.Fatalf("FY2025 (from footnoted header 2023–25(d)) was dropped: %+v", vals["NSW"][crimeBreakIns])
	}
	if got != 1.5 {
		t.Errorf("FY2025 rate = %v, want 1.5", got)
	}
}
