package main

import "testing"

// approvalsFixture mirrors the real ABS,BA_SA2(2.0.0) SDMX-CSV shape probed
// 2026-07-22. The dataflow dimension order is
// MEASURE.SECTOR.WORK_TYPE.BUILDING_TYPE.REGION_TYPE.REGION.FREQ.
func approvalsFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "SECTOR: Sector", "WORK_TYPE: Type of Work", "BUILDING_TYPE: Type of Building", "REGION_TYPE: Region Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		// kept: the pinned total-dwellings/state/monthly selection.
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "1: New South Wales", "M: Monthly", "2026-05", "4518", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "2: Victoria", "M: Monthly", "2026-05", "4710", "NUM: Number", "0: Units"},
		// filtered: every selection dimension is pinned, rather than inferred from labels.
		{"ABS:BA_SA2(2.0.0)", "2: Value of building work", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "1: New South Wales", "M: Monthly", "2026-05", "999", "AUD: Australian Dollar", "6: Millions"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "1: Private sector", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "1: New South Wales", "M: Monthly", "2026-05", "999", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "NEW: New work", "TOT: Total", "STE: States/Territories", "1: New South Wales", "M: Monthly", "2026-05", "999", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "1: Houses", "STE: States/Territories", "1: New South Wales", "M: Monthly", "2026-05", "999", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "AUS: Australia", "1: New South Wales", "M: Monthly", "2026-05", "999", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "1: New South Wales", "Q: Quarterly", "2026-Q2", "999", "NUM: Number", "0: Units"},
		{"ABS:BA_SA2(2.0.0)", "1: Number of dwelling units", "9: Total Sectors", "TOT: Total Work", "TOT: Total", "STE: States/Territories", "AUS: Australia", "M: Monthly", "2026-05", "999", "NUM: Number", "0: Units"},
	}
}

func TestApprovalsPinnedSDMXQuery(t *testing.T) {
	if approvalsFlow != "BA_SA2" || approvalsKey != "1.9.TOT.TOT.STE.1+2+3+4+5+6+7+8.M" || approvalsStartPeriod != "2021-07" {
		t.Fatalf("unexpected approvals query: flow=%q key=%q start=%q", approvalsFlow, approvalsKey, approvalsStartPeriod)
	}
}

func TestParseApprovals(t *testing.T) {
	obs, err := parseApprovals(approvalsFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 selected state observations, got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	nsw, ok := byKey["approvals.dwelling_units.total.nsw"]
	if !ok || nsw.Value != 4518 {
		t.Fatalf("unexpected NSW approvals: %#v", byKey)
	}
	if nsw.Series.Unit != "units" || nsw.Series.Frequency != "monthly" || nsw.Series.Adjustment != "original" {
		t.Fatalf("unexpected NSW metadata: %#v", nsw.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "BA_SA2", "measure": "1", "sector": "9", "work_type": "TOT",
		"building_type": "TOT", "region_type": "STE", "region": "1", "freq": "M", "unit_mult": "0",
	} {
		if got := nsw.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseApprovalsMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "SECTOR", "WORK_TYPE", "BUILDING_TYPE", "REGION_TYPE", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseApprovals(withoutSDMXColumn(approvalsFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseApprovalsHeaderOnly(t *testing.T) {
	obs, err := parseApprovals([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
}

func TestParseApprovalsRejectsInvalidRequiredRows(t *testing.T) {
	tests := []struct {
		name string
		row  []string
	}{
		{
			name: "truncated filtered row",
			// Wrong-measure rows would normally be filtered immediately. Even so,
			// a missing trailing UNIT_MULT must fail before filter evaluation.
			row: approvalsFixture()[3][:len(approvalsFixture()[3])-1],
		},
		{
			name: "blank multiplier",
			row: func() []string {
				row := append([]string(nil), approvalsFixture()[1]...)
				row[len(row)-1] = ""
				return row
			}(),
		},
		{
			name: "malformed multiplier",
			row: func() []string {
				row := append([]string(nil), approvalsFixture()[1]...)
				row[len(row)-1] = "many: Units"
				return row
			}(),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows := [][]string{append([]string(nil), approvalsFixture()[0]...), tt.row}
			_, err := parseApprovals(rows)
			assertSDMXRowError(t, err, "parseApprovals", 2)
		})
	}
}
