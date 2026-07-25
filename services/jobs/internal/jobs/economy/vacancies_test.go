package economy

import "testing"

// vacanciesFixture mirrors the pinned ABS,JV(1.0) SDMX-CSV shape from the
// 2026-07-22 probe. The dataflow dimension order is
// MEASURE.SECTOR.INDUSTRY.TSEST.REGION.FREQ.
func vacanciesFixture() [][]string {
	rows := [][]string{
		{"DATAFLOW", "MEASURE: Measure", "SECTOR: Sector", "INDUSTRY: Industry", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "324.0", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "1: New South Wales", "Q: Quarterly", "2026-Q2", "96.1", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "2: Victoria", "Q: Quarterly", "2026-Q2", "82.4", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "3: Queensland", "Q: Quarterly", "2026-Q2", "68.3", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "4: South Australia", "Q: Quarterly", "2026-Q2", "22.7", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "5: Western Australia", "Q: Quarterly", "2026-Q2", "38.6", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "6: Tasmania", "Q: Quarterly", "2026-Q2", "5.2", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "7: Northern Territory", "Q: Quarterly", "2026-Q2", "4.5", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "8: Australian Capital Territory", "Q: Quarterly", "2026-Q2", "6.2", "PS: Persons", "3: Thousands"},
		// Filtered rows prove selection is based on pinned codes, not labels.
		{"ABS:JV(1.0)", "M2: Vacancy rate", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "PCT: Percent", "0: Units"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "1: Private sector", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "A: Agriculture", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "9: Other Territories", "Q: Quarterly", "2026-Q2", "999", "PS: Persons", "3: Thousands"},
		{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "M: Monthly", "2026-06", "999", "PS: Persons", "3: Thousands"},
	}
	rows[0] = append(rows[0], "OBS_STATUS: Observation Status")
	for i := 1; i < len(rows); i++ {
		rows[i] = append(rows[i], "")
	}
	return append(rows,
		[]string{"ABS:JV(1.0)", "M1: Job vacancies", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2009-Q2", "", "PS: Persons", "3: Thousands", "q: Not available"},
	)
}

func TestVacanciesPinnedSDMXQuery(t *testing.T) {
	if vacanciesFlow != "JV" || vacanciesVersion != "1.0" ||
		vacanciesKey != "M1.7.TOT.10.1+2+3+4+5+6+7+8+AUS.Q" || vacanciesStartPeriod != "2009-Q3" {
		t.Fatalf("unexpected vacancies query: flow=%q version=%q key=%q start=%q", vacanciesFlow, vacanciesVersion, vacanciesKey, vacanciesStartPeriod)
	}
}

func TestParseVacancies(t *testing.T) {
	obs, err := parseVacancies(vacanciesFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 9 {
		t.Fatalf("want 9 selected regional observations, got %d: %#v", len(obs), obs)
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	aus, ok := byKey["labour.job_vacancies.aus"]
	if !ok {
		t.Fatalf("Australia vacancies missing: %#v", byKey)
	}
	if aus.Value < 50_000 || aus.Value > 1_500_000 {
		t.Fatalf("Australia vacancies magnitude %v outside guard 50k..1.5m", aus.Value)
	}
	if aus.Value != 324_000 {
		t.Fatalf("Australia vacancies=%v, want 324000", aus.Value)
	}
	if aus.Series.Topic != "labour" || aus.Series.Metric != "job_vacancies" || aus.Series.Product != "" ||
		aus.Series.RegionType != "national" || aus.Series.Unit != "persons" || aus.Series.Frequency != "quarterly" ||
		aus.Series.Adjustment != "original" || aus.Series.SourceKey != "abs-job-vacancies" || aus.Series.Licence != "CC-BY-4.0" {
		t.Fatalf("unexpected Australia metadata: %#v", aus.Series)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "JV", "abs_dataflow_version": "1.0", "measure": "M1", "sector": "7",
		"industry": "TOT", "tsest": "10", "region": "AUS", "freq": "Q", "unit_mult": "3",
	} {
		if got := aus.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
	if got := byKey["labour.job_vacancies.nsw"].Value; got != 96_100 {
		t.Errorf("NSW vacancies=%v, want 96100", got)
	}
}

func TestParseVacanciesMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "SECTOR", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseVacancies(withoutSDMXColumn(vacanciesFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseVacanciesRejectsInvalidRequiredRows(t *testing.T) {
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{name: "truncated filtered row", row: vacanciesFixture()[10][:10]},
		{name: "blank multiplier", row: replaceVacanciesMultiplier(vacanciesFixture()[1], "")},
		{name: "malformed multiplier", row: replaceVacanciesMultiplier(vacanciesFixture()[1], "thousand: Thousands")},
		{name: "malformed nonblank observation", row: replaceVacanciesObservation(vacanciesFixture()[1], "not-a-number")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseVacancies([][]string{append([]string(nil), vacanciesFixture()[0]...), tt.row})
			assertSDMXRowError(t, err, "parseVacancies", 2)
		})
	}
}

func TestParseVacanciesHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseVacancies([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseVacancies(reverseSDMXColumns(vacanciesFixture()))
	if err != nil || len(obs) != 9 {
		t.Fatalf("reordered header input = (%d observations, %v), want (9, nil)", len(obs), err)
	}
}

func replaceVacanciesMultiplier(row []string, value string) []string {
	out := append([]string(nil), row...)
	out[10] = value
	return out
}

func replaceVacanciesObservation(row []string, value string) []string {
	out := append([]string(nil), row...)
	out[8] = value
	return out
}
