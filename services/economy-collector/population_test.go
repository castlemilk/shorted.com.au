package main

import "testing"

// erpFixture mirrors ABS,ERP_Q(1.0.0), probed 2026-07-22. This flow has no
// UNIT_MULT column: ERP observations are already raw persons.
func erpFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "SEX: Sex", "AGE: Age", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "3: Persons", "TOT: All ages", "1: New South Wales", "Q: Quarterly", "2025-Q4", "8641085", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "3: Persons", "TOT: All ages", "AUS: Australia", "Q: Quarterly", "2025-Q4", "27801023", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "2: Population growth", "3: Persons", "TOT: All ages", "1: New South Wales", "Q: Quarterly", "2025-Q4", "999", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "1: Males", "TOT: All ages", "1: New South Wales", "Q: Quarterly", "2025-Q4", "999", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "3: Persons", "0: 0 years", "1: New South Wales", "Q: Quarterly", "2025-Q4", "999", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "3: Persons", "TOT: All ages", "9: Other Territories", "Q: Quarterly", "2025-Q4", "999", "PS: Persons"},
		{"ABS:ERP_Q(1.0.0)", "1: Estimated Resident Population", "3: Persons", "TOT: All ages", "1: New South Wales", "A: Annual", "2025", "999", "PS: Persons"},
	}
}

// populationComponentsFixture mirrors ABS,ERP_COMP_Q(1.0.0), probed
// 2026-07-22. UNIT_MULT is row-specific: natural/overseas migration are
// thousands while interstate migration is already unscaled persons.
func populationComponentsFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:ERP_COMP_Q(1.0.0)", "3: Natural Increase", "1: New South Wales", "Q: Quarterly", "2025-Q4", "6.5", "PS: Persons", "3: Thousands"},
		{"ABS:ERP_COMP_Q(1.0.0)", "6: Net Internal Migration", "1: New South Wales", "Q: Quarterly", "2025-Q4", "-5842", "PS: Persons", "0: Units"},
		{"ABS:ERP_COMP_Q(1.0.0)", "9: Net Overseas Migration", "AUS: Australia", "Q: Quarterly", "2025-Q4", "56.6", "PS: Persons", "3: Thousands"},
		{"ABS:ERP_COMP_Q(1.0.0)", "4: Births", "1: New South Wales", "Q: Quarterly", "2025-Q4", "999", "PS: Persons", "3: Thousands"},
		{"ABS:ERP_COMP_Q(1.0.0)", "3: Natural Increase", "9: Other Territories", "Q: Quarterly", "2025-Q4", "999", "PS: Persons", "3: Thousands"},
		{"ABS:ERP_COMP_Q(1.0.0)", "3: Natural Increase", "1: New South Wales", "A: Annual", "2025", "999", "PS: Persons", "3: Thousands"},
	}
}

func TestPopulationPinnedSDMXQueries(t *testing.T) {
	if erpFlow != "ERP_Q" || erpKey != "1.3.TOT.1+2+3+4+5+6+7+8+AUS.Q" || erpStartPeriod != "2000-Q1" {
		t.Fatalf("unexpected ERP query: flow=%q key=%q start=%q", erpFlow, erpKey, erpStartPeriod)
	}
	if populationComponentsFlow != "ERP_COMP_Q" || populationComponentsKey != "3+6+9.1+2+3+4+5+6+7+8+AUS.Q" || populationComponentsStartPeriod != "2000-Q1" {
		t.Fatalf("unexpected components query: flow=%q key=%q start=%q", populationComponentsFlow, populationComponentsKey, populationComponentsStartPeriod)
	}
}

func TestParseERP(t *testing.T) {
	obs, err := parseERP(erpFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 total-person ERP observations, got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	nsw, ok := byKey["population.erp.total.nsw"]
	if !ok || nsw.Value != 8_641_085 {
		t.Fatalf("NSW ERP magnitude wrong: %#v", byKey)
	}
	aus, ok := byKey["population.erp.total.aus"]
	if !ok || aus.Value != 27_801_023 {
		t.Fatalf("Australia ERP magnitude wrong: %#v", byKey)
	}
	if nsw.Series.Unit != "persons" || nsw.Series.Frequency != "quarterly" || nsw.Series.Adjustment != "original" {
		t.Fatalf("unexpected NSW metadata: %#v", nsw.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "ERP_Q", "measure": "1", "sex": "3", "age": "TOT", "region": "1", "freq": "Q",
	} {
		if got := nsw.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParsePopulationComponentsUsesRowUnitMultiplier(t *testing.T) {
	obs, err := parsePopulationComponents(populationComponentsFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 3 {
		t.Fatalf("want 3 selected component observations, got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	checks := map[string]float64{
		"population.natural_increase.total.nsw":         6500,
		"population.net_interstate_migration.total.nsw": -5842,
		"population.net_overseas_migration.total.aus":   56600,
	}
	for key, want := range checks {
		if got, ok := byKey[key]; !ok || got.Value != want {
			t.Errorf("%s = %#v, want value %v", key, got, want)
		}
	}
	natural := byKey["population.natural_increase.total.nsw"]
	for name, want := range map[string]string{
		"abs_dataflow": "ERP_COMP_Q", "measure": "3", "region": "1", "freq": "Q", "unit_mult": "3",
	} {
		if got := natural.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseERPMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "SEX", "AGE", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseERP(withoutSDMXColumn(erpFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParsePopulationComponentsMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parsePopulationComponents(withoutSDMXColumn(populationComponentsFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParsePopulationHeaderOnly(t *testing.T) {
	for name, parse := range map[string]func([][]string) ([]Obs, error){
		"erp": parseERP, "components": parsePopulationComponents,
	} {
		t.Run(name, func(t *testing.T) {
			obs, err := parse([][]string{{"DATAFLOW"}})
			if err != nil || obs != nil {
				t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
			}
		})
	}
}

func TestParseERPRejectsTruncatedRequiredRow(t *testing.T) {
	row := erpFixture()[1]
	// OBS_VALUE is required at index 7; truncate before it while leaving all
	// filter dimensions present to prove the row fails instead of disappearing.
	rows := [][]string{append([]string(nil), erpFixture()[0]...), append([]string(nil), row[:7]...)}
	_, err := parseERP(rows)
	assertSDMXRowError(t, err, "parseERP", 2)
}

func TestParsePopulationComponentsRejectsInvalidRequiredRows(t *testing.T) {
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{
			name: "truncated filtered row",
			// The untracked measure would normally be filtered. Missing multiplier
			// metadata must still fail validation before that filter executes.
			row: populationComponentsFixture()[4][:len(populationComponentsFixture()[4])-1],
		},
		{
			name: "blank multiplier",
			row: func() []string {
				row := append([]string(nil), populationComponentsFixture()[1]...)
				row[len(row)-1] = ""
				return row
			}(),
		},
		{
			name: "malformed multiplier",
			row: func() []string {
				row := append([]string(nil), populationComponentsFixture()[1]...)
				row[len(row)-1] = "thousand: Thousands"
				return row
			}(),
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rows := [][]string{append([]string(nil), populationComponentsFixture()[0]...), tt.row}
			_, err := parsePopulationComponents(rows)
			assertSDMXRowError(t, err, "parsePopulationComponents", 2)
		})
	}
}

// withoutSDMXColumn removes a named (label-agnostic) SDMX column from every
// row. It makes schema-drift tests exercise the real name-based parser.
func withoutSDMXColumn(rows [][]string, name string) [][]string {
	idx := -1
	for i, h := range rows[0] {
		if h == name || len(h) > len(name) && h[:len(name)] == name && h[len(name)] == ':' {
			idx = i
			break
		}
	}
	if idx < 0 {
		panic("fixture column not found: " + name)
	}
	out := make([][]string, len(rows))
	for i, row := range rows {
		out[i] = append(append([]string(nil), row[:idx]...), row[idx+1:]...)
	}
	return out
}

func reverseSDMXColumns(rows [][]string) [][]string {
	out := make([][]string, len(rows))
	for i, row := range rows {
		out[i] = make([]string, len(row))
		for j, cell := range row {
			out[i][len(row)-1-j] = cell
		}
	}
	return out
}
