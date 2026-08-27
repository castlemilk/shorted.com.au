package main

import (
	"bytes"
	"log"
	"math"
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

func TestParseG17UsesHeaderNamesAndDerivesCuratedIncomeBands(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"P_3500_more_Tot", "SAL_CODE_2021", "P_300_399_Tot", "P_Tot_Tot", "P_1_149_Tot", "P_2000_2999_Tot", "P_150_299_Tot", "P_3000_3499_Tot", "P_400_499_Tot"},
		{"100", "SAL10707", "100", "1000", "100", "50", "100", "50", "100"},
	}

	got := parseG17(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	floatValue(t, got.pctLowPersonalIncome, 40)
	floatValue(t, got.pctHighPersonalIncome, 20)
}

func TestParseG17MissingHeaderLeavesOnlyAffectedMetricNullAndLogs(t *testing.T) {
	logger, logs := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot"},
		{"SAL10707", "1000", "100", "100", "100", "100", "50", "50"},
	}

	got := parseG17(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	floatValue(t, got.pctLowPersonalIncome, 40)
	if got.pctHighPersonalIncome != nil {
		t.Fatalf("missing high-income band must leave metric nil, got %v", *got.pctHighPersonalIncome)
	}
	if text := logs.String(); !strings.Contains(text, "G17") || !strings.Contains(text, "pct_high_personal_income") || !strings.Contains(text, "P_3500_more_Tot") {
		t.Fatalf("missing-header log lacks table, metric, or header: %q", text)
	}
}

func TestExpandedRatesLeaveZeroDenominatorNull(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot"},
		{"SAL10707", "0", "1", "1", "1", "1", "1", "1", "1"},
	}

	got := parseG17(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	if got.pctLowPersonalIncome != nil || got.pctHighPersonalIncome != nil {
		t.Fatalf("zero denominator must leave rates nil: %+v", got)
	}
}

func TestExpandedRatesHonourPopulationFloor(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot"},
		{"SAL10707", "99", "20", "10", "10", "10", "10", "10", "10"},
	}

	got := parseG17(rows, map[string]*int{"10707": intPtr(censusDerivedRateMinPopulation - 1)}, logger)["10707"]
	if got.pctLowPersonalIncome != nil || got.pctHighPersonalIncome != nil {
		t.Fatalf("population below %d must leave rates nil: %+v", censusDerivedRateMinPopulation, got)
	}
}

func TestExpandedRatesAreBoundedToOneHundred(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "P_Tot_Tot", "P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot", "P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot"},
		{"SAL10707", "100", "60", "60", "60", "60", "0", "0", "0"},
	}

	got := parseG17(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	floatValue(t, got.pctLowPersonalIncome, 100)
}

func TestExpandedTableParsersUseTheirOwnDenominators(t *testing.T) {
	logger, _ := expandedTestLogger()
	population := map[string]*int{"10707": intPtr(1000)}

	tests := []struct {
		name string
		got  *float64
		want float64
	}{
		{
			name: "G43 unemployment",
			got: parseG43([][]string{
				{"SAL_CODE_2021", "P_Tot_Unemp_Tot", "P_Tot_LF_Tot", "P_15yr_over_Tot"},
				{"SAL10707", "25", "500", "800"},
			}, population, logger)["10707"].unemploymentRate,
			want: 5,
		},
		{
			name: "G43 participation",
			got: parseG43([][]string{
				{"SAL_CODE_2021", "P_Tot_Unemp_Tot", "P_Tot_LF_Tot", "P_15yr_over_Tot"},
				{"SAL10707", "25", "500", "800"},
			}, population, logger)["10707"].labourForceParticipationRate,
			want: 62.5,
		},
		{
			name: "G46 bachelor or higher",
			got: parseG46([][]string{
				{"SAL_CODE_2021", "P_PGrad_Deg_Tot", "P_GradDip_and_GradCert_Tot", "P_BachDeg_Tot", "P_Tot_Tot"},
				{"SAL10707", "100", "50", "250", "800"},
			}, population, logger)["10707"].pctBachelorOrHigher,
			want: 50,
		},
		{
			name: "G32 separate house",
			got: parseDwellingStructure("G32", [][]string{
				{"SAL_CODE_2021", "OPD_Sep_house_Tot", "OPD_Flat_apart_Tot", "OPDs_Tot"},
				{"SAL10707", "600", "250", "1000"},
			}, population, logger)["10707"].pctSeparateHouse,
			want: 60,
		},
		{
			name: "G32 flat apartment",
			got: parseDwellingStructure("G32", [][]string{
				{"SAL_CODE_2021", "OPD_Sep_house_Tot", "OPD_Flat_apart_Tot", "OPDs_Tot"},
				{"SAL10707", "600", "250", "1000"},
			}, population, logger)["10707"].pctFlatApartment,
			want: 25,
		},
		{
			name: "G25 couple with children",
			got: parseG25([][]string{
				{"SAL_CODE_2021", "CF_Ch_F", "Tot_F", "Lone_pers_H", "Tot_H"},
				{"SAL10707", "300", "600", "200", "800"},
			}, population, logger)["10707"].pctCoupleWithChildren,
			want: 50,
		},
		{
			name: "G25 lone person household",
			got: parseG25([][]string{
				{"SAL_CODE_2021", "CF_Ch_F", "Tot_F", "Lone_pers_H", "Tot_H"},
				{"SAL10707", "300", "600", "200", "800"},
			}, population, logger)["10707"].pctLonePersonHousehold,
			want: 25,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) { floatValue(t, tt.got, tt.want) })
	}
}

func TestParseG33MapsTenureAndDwellingCount(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "O_OR_Tot", "O_MTG_Tot", "R_RE_Tot", "Tot_Tot"},
		{"SAL10707", "250", "400", "300", "1000"},
	}

	got := parseG33(rows, map[string]*int{"10707": intPtr(1000)}, logger)["10707"]
	floatValue(t, got.pctOwnedOutright, 25)
	floatValue(t, got.pctOwnedMortgage, 40)
	floatValue(t, got.pctRented, 30)
	if got.dwellingCount == nil || *got.dwellingCount != 1000 {
		t.Fatalf("dwelling count = %v, want 1000", got.dwellingCount)
	}
}

func intPtr(v int) *int { return &v }
