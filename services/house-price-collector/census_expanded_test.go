package main

import (
	"archive/zip"
	"bytes"
	"log"
	"math"
	"os"
	"strings"
	"testing"
)

func expandedTestLogger() (*log.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return log.New(&buf, "", 0), &buf
}

func floatValue(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Fatalf("got nil, want %.2f", want)
	}
	if math.Abs(*got-want) > 0.001 {
		t.Fatalf("got %.4f, want %.4f", *got, want)
	}
}

func assertExpandedStatsNil(t *testing.T, got expandedCensusStats) {
	t.Helper()
	if got.pctLowPersonalIncome != nil ||
		got.pctHighPersonalIncome != nil ||
		got.unemploymentRate != nil ||
		got.labourForceParticipationRate != nil ||
		got.pctBachelorOrHigher != nil ||
		got.pctSeparateHouse != nil ||
		got.pctFlatApartment != nil ||
		got.pctCoupleWithChildren != nil ||
		got.pctLonePersonHousehold != nil ||
		got.pctOwnedOutright != nil ||
		got.pctOwnedMortgage != nil ||
		got.pctRented != nil ||
		got.dwellingCount != nil {
		t.Fatalf("expected all expanded Census fields to be nil, got %+v", got)
	}
}

func assertExpandedStatsPresent(t *testing.T, got expandedCensusStats) {
	t.Helper()
	missing := make([]string, 0)
	for name, value := range map[string]any{
		"pctLowPersonalIncome":         got.pctLowPersonalIncome,
		"pctHighPersonalIncome":        got.pctHighPersonalIncome,
		"unemploymentRate":             got.unemploymentRate,
		"labourForceParticipationRate": got.labourForceParticipationRate,
		"pctBachelorOrHigher":          got.pctBachelorOrHigher,
		"pctSeparateHouse":             got.pctSeparateHouse,
		"pctFlatApartment":             got.pctFlatApartment,
		"pctCoupleWithChildren":        got.pctCoupleWithChildren,
		"pctLonePersonHousehold":       got.pctLonePersonHousehold,
		"pctOwnedOutright":             got.pctOwnedOutright,
		"pctOwnedMortgage":             got.pctOwnedMortgage,
		"pctRented":                    got.pctRented,
		"dwellingCount":                got.dwellingCount,
	} {
		switch pointer := value.(type) {
		case *float64:
			if pointer == nil {
				missing = append(missing, name)
			}
		case *int:
			if pointer == nil {
				missing = append(missing, name)
			}
		}
	}
	if len(missing) > 0 {
		t.Fatalf("expanded Census fields left nil: %s", strings.Join(missing, ", "))
	}
}

func TestParseG17BAndG17C(t *testing.T) {
	tests := []struct {
		name     string
		g17BRows [][]string
		g17CRows [][]string
		wantLow  float64
		wantHigh float64
	}{
		{
			name: "joins by SAL code and uses direct total columns",
			g17BRows: [][]string{
				{"P_400_499_Tot", "SAL_CODE_2021", "P_1_149_Tot", "P_300_399_Tot", "P_150_299_Tot"},
				{"150", "SAL10707", "100", "50", "200"},
				{"30", "SAL20000", "10", "10", "10"},
			},
			g17CRows: [][]string{
				{"P_3500_more_Tot", "P_Tot_Tot", "SAL_CODE_2021", "P_3000_3499_Tot", "P_2000_2999_Tot"},
				{"10", "100", "SAL20000", "10", "10"},
				{"100", "2000", "SAL10707", "100", "200"},
			},
			wantLow:  25,
			wantHigh: 20,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, _ := expandedTestLogger()
			got := parseG17(tt.g17BRows, tt.g17CRows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			floatValue(t, got.pctLowPersonalIncome, tt.wantLow)
			floatValue(t, got.pctHighPersonalIncome, tt.wantHigh)
		})
	}
}

func TestParseG36(t *testing.T) {
	tests := []struct {
		name         string
		rows         [][]string
		wantSeparate float64
		wantFlat     float64
	}{
		{
			name: "uses dwelling totals rather than person twins",
			rows: [][]string{
				{"OPDs_Separate_house_Persons", "SAL_CODE_2021", "OPDs_Flt_apart_Tot_Dwgs", "OPDs_Tot_OPDs_Dwellings", "OPDs_Separate_house_Dwellings", "OPDs_Flt_apart_Tot_Psns"},
				{"5", "SAL10707", "250", "1000", "600", "7"},
			},
			wantSeparate: 60,
			wantFlat:     25,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, _ := expandedTestLogger()
			got := parseG36(tt.rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			floatValue(t, got.pctSeparateHouse, tt.wantSeparate)
			floatValue(t, got.pctFlatApartment, tt.wantFlat)
		})
	}
}

func TestParseG37(t *testing.T) {
	tests := []struct {
		name         string
		rows         [][]string
		wantOutright float64
		wantMortgage float64
		wantRented   float64
		wantCount    int
	}{
		{
			name: "uses tenure dwelling totals",
			rows: [][]string{
				{"R_Tot_Total", "SAL_CODE_2021", "O_MTG_Total", "Total_Total", "O_OR_Total"},
				{"300", "SAL10707", "400", "1000", "250"},
			},
			wantOutright: 25,
			wantMortgage: 40,
			wantRented:   30,
			wantCount:    1000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, _ := expandedTestLogger()
			got := parseG37(tt.rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			floatValue(t, got.pctOwnedOutright, tt.wantOutright)
			floatValue(t, got.pctOwnedMortgage, tt.wantMortgage)
			floatValue(t, got.pctRented, tt.wantRented)
			if got.dwellingCount == nil || *got.dwellingCount != tt.wantCount {
				t.Fatalf("dwelling count = %v, want %d", got.dwellingCount, tt.wantCount)
			}
		})
	}
}

func TestParseG42(t *testing.T) {
	tests := []struct {
		name       string
		rows       [][]string
		wantCouple float64
		wantLone   float64
	}{
		{
			name: "uses direct household composition totals",
			rows: [][]string{
				{"Tot_Lone_P_H", "Tot_Tot", "SAL_CODE_2021", "Tot_FHs_CF_C"},
				{"200", "800", "SAL10707", "300"},
			},
			wantCouple: 37.5,
			wantLone:   25,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, _ := expandedTestLogger()
			got := parseG42(tt.rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			floatValue(t, got.pctCoupleWithChildren, tt.wantCouple)
			floatValue(t, got.pctLonePersonHousehold, tt.wantLone)
		})
	}
}

func TestParseG43(t *testing.T) {
	tests := []struct {
		name              string
		rows              [][]string
		wantUnemployment  float64
		wantParticipation float64
		wantBachelor      float64
	}{
		{
			name: "uses direct labour force and qualification totals",
			rows: [][]string{
				{"non_sch_qual_Bchelr_Degree_P", "SAL_CODE_2021", "lfs_Tot_LF_P", "non_sch_qual_PostGrad_Dgre_P", "P_15_yrs_over_P", "lfs_Unmplyed_lookng_for_wrk_P", "non_sch_qual_Gr_Dip_Gr_Crt_P"},
				{"250", "SAL10707", "500", "100", "800", "25", "50"},
			},
			wantUnemployment:  5,
			wantParticipation: 62.5,
			wantBachelor:      50,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, _ := expandedTestLogger()
			got := parseG43(tt.rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			floatValue(t, got.unemploymentRate, tt.wantUnemployment)
			floatValue(t, got.labourForceParticipationRate, tt.wantParticipation)
			floatValue(t, got.pctBachelorOrHigher, tt.wantBachelor)
		})
	}
}

func TestMissingMetricColumnLeavesOnlyThatMetricNull(t *testing.T) {
	logger, logs := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "lfs_Unmplyed_lookng_for_wrk_P", "lfs_Tot_LF_P", "P_15_yrs_over_P", "non_sch_qual_PostGrad_Dgre_P", "non_sch_qual_Gr_Dip_Gr_Crt_P"},
		{"SAL10707", "25", "500", "800", "100", "50"},
	}

	got := parseG43(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	floatValue(t, got.unemploymentRate, 5)
	floatValue(t, got.labourForceParticipationRate, 62.5)
	if got.pctBachelorOrHigher != nil {
		t.Fatalf("missing qualification band must leave bachelor metric nil, got %v", *got.pctBachelorOrHigher)
	}
	if text := logs.String(); !strings.Contains(text, "G43") ||
		!strings.Contains(text, "pct_bachelor_or_higher") ||
		!strings.Contains(text, "non_sch_qual_Bchelr_Degree_P") {
		t.Fatalf("missing-header log lacks table, metric, or header: %q", text)
	}
}

func TestWrongTableHeadersLeaveEveryMetricNull(t *testing.T) {
	logger, logs := expandedTestLogger()
	wrongG32Rows := [][]string{
		{"SAL_CODE_2021", "OPD_Sep_house_Tot", "OPD_Flat_apart_Tot", "OPDs_Tot"},
		{"SAL10707", "600", "250", "1000"},
	}

	got := parseG36(wrongG32Rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	assertExpandedStatsNil(t, got)
	if text := logs.String(); !strings.Contains(text, "G36") || !strings.Contains(text, "missing header") {
		t.Fatalf("wrong-table failure was not surfaced in logs: %q", text)
	}
}

func TestG17UnionRequiresBothEntries(t *testing.T) {
	g17BRows := [][]string{
		{"SAL_CODE_2021", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot"},
		{"SAL10707", "100", "100", "100", "100"},
	}
	g17CRows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot"},
		{"SAL10707", "1000", "50", "50", "100"},
	}

	for _, tt := range []struct {
		name     string
		g17BRows [][]string
		g17CRows [][]string
		missing  string
	}{
		{name: "G17B missing", g17CRows: g17CRows, missing: "G17B"},
		{name: "G17C missing", g17BRows: g17BRows, missing: "G17C"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			logger, logs := expandedTestLogger()
			got := parseG17(tt.g17BRows, tt.g17CRows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
			if got.pctLowPersonalIncome != nil || got.pctHighPersonalIncome != nil {
				t.Fatalf("missing %s must leave both income metrics nil: %+v", tt.missing, got)
			}
			if text := logs.String(); !strings.Contains(text, tt.missing) || !strings.Contains(text, "both income metrics left NULL") {
				t.Fatalf("missing-entry log lacks entry and null outcome: %q", text)
			}
		})
	}
}

func TestG17UnionRejectsCollidingNonSALHeader(t *testing.T) {
	logger, logs := expandedTestLogger()
	g17BRows := [][]string{
		{"SAL_CODE_2021", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot", "P_Tot_Tot"},
		{"SAL10707", "100", "100", "100", "100", "999"},
	}
	g17CRows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot"},
		{"SAL10707", "1000", "50", "50", "100"},
	}

	got := parseG17(g17BRows, g17CRows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	if got.pctLowPersonalIncome != nil || got.pctHighPersonalIncome != nil {
		t.Fatalf("ambiguous shared denominator must leave both income metrics nil: %+v", got)
	}
	if text := logs.String(); !strings.Contains(text, "duplicate non-SAL header P_Tot_Tot") || !strings.Contains(text, "leaving colliding header unresolved") {
		t.Fatalf("header collision was not surfaced in logs: %q", text)
	}
}

func TestPopulationFloorSuppressesRatesButNotDwellingCount(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "O_OR_Total", "O_MTG_Total", "R_Tot_Total", "Total_Total"},
		{"SAL10707", "250", "400", "300", "1000"},
	}

	got := parseG37(rows, map[string]*int{"10707": intPtr(censusDerivedRateMinPopulation - 1)}, logger)["10707"]
	if got.pctOwnedOutright != nil || got.pctOwnedMortgage != nil || got.pctRented != nil {
		t.Fatalf("population below %d must leave derived rates nil: %+v", censusDerivedRateMinPopulation, got)
	}
	if got.dwellingCount == nil || *got.dwellingCount != 1000 {
		t.Fatalf("raw dwelling count must not be population-gated, got %v", got.dwellingCount)
	}
}

func TestExpandedRatesKeepZeroDenominatorNullAndBoundPercentages(t *testing.T) {
	logger, _ := expandedTestLogger()
	population := map[string]*int{"10707": intPtr(1000), "20000": intPtr(1000)}
	rows := [][]string{
		{"SAL_CODE_2021", "OPDs_Separate_house_Dwellings", "OPDs_Flt_apart_Tot_Dwgs", "OPDs_Tot_OPDs_Dwellings"},
		{"SAL10707", "1", "1", "0"},
		{"SAL20000", "120", "20", "100"},
	}

	got := parseG36(rows, population, logger)
	if got["10707"].pctSeparateHouse != nil || got["10707"].pctFlatApartment != nil {
		t.Fatalf("zero denominator must leave rates nil: %+v", got["10707"])
	}
	floatValue(t, got["20000"].pctSeparateHouse, 100)
}

// TestExpandedCensusRealDataPack validates the parser against the actual ABS
// short-header archive. It is intentionally skipped in normal test runs. Example:
//
//	CENSUS_DATAPACK_PATH=/private/tmp/claude-501/-Users-benebsworth-projects-shorted/a97f7bde-12f5-4807-8f16-782694ab9946/scratchpad/gcp_sal.zip \
//	  GOWORK=off go test ./... -run TestExpandedCensusRealDataPack -count=1 -v
func TestExpandedCensusRealDataPack(t *testing.T) {
	path := strings.TrimSpace(os.Getenv("CENSUS_DATAPACK_PATH"))
	if path == "" {
		t.Skip("set CENSUS_DATAPACK_PATH to the real 2021 GCP SAL short-header DataPack")
	}

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open real Census DataPack: %v", err)
	}
	defer func() { _ = zr.Close() }()

	g01Rows, err := readZipCSV(zr, censusG01Entry)
	if err != nil {
		t.Fatalf("read real G01: %v", err)
	}
	g01, err := parseG01(g01Rows)
	if err != nil {
		t.Fatalf("parse real G01: %v", err)
	}

	logger, logs := expandedTestLogger()
	got := parseExpandedCensus(zr, g01, logger)
	for _, sample := range []struct {
		name string
		code string
	}{
		{name: "Bondi NSW", code: "10462"},
		{name: "Toorak VIC", code: "22547"},
		{name: "Ipswich QLD", code: "31405"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			stats, ok := got[sample.code]
			if !ok {
				t.Fatalf("SAL %s missing from expanded Census output; logs:\n%s", sample.code, logs.String())
			}
			assertExpandedStatsPresent(t, stats)
			t.Logf("%s SAL%s: low_income=%.2f%% high_income=%.2f%% unemployment=%.2f%% participation=%.2f%% bachelor_plus=%.2f%% separate_house=%.2f%% flat_apartment=%.2f%% couple_with_children=%.2f%% lone_person=%.2f%% owned_outright=%.2f%% owned_mortgage=%.2f%% rented=%.2f%% dwellings=%d",
				sample.name,
				sample.code,
				*stats.pctLowPersonalIncome,
				*stats.pctHighPersonalIncome,
				*stats.unemploymentRate,
				*stats.labourForceParticipationRate,
				*stats.pctBachelorOrHigher,
				*stats.pctSeparateHouse,
				*stats.pctFlatApartment,
				*stats.pctCoupleWithChildren,
				*stats.pctLonePersonHousehold,
				*stats.pctOwnedOutright,
				*stats.pctOwnedMortgage,
				*stats.pctRented,
				*stats.dwellingCount,
			)
		})
	}
}

func intPtr(v int) *int { return &v }
