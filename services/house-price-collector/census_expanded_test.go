package main

import (
	"archive/zip"
	"bytes"
	"log"
	"math"
	"os"
	"strconv"
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
	// SAL20000's flat count is blank, so separate-house stands alone and is
	// bounded rather than withheld as part of an overfull group.
	rows := [][]string{
		{"SAL_CODE_2021", "OPDs_Separate_house_Dwellings", "OPDs_Flt_apart_Tot_Dwgs", "OPDs_Tot_OPDs_Dwellings"},
		{"SAL10707", "1", "1", "0"},
		{"SAL20000", "120", "", "100"},
	}

	got := parseG36(rows, population, logger)
	if got["10707"].pctSeparateHouse != nil || got["10707"].pctFlatApartment != nil {
		t.Fatalf("zero denominator must leave rates nil: %+v", got["10707"])
	}
	floatValue(t, got["20000"].pctSeparateHouse, 100)
	if got["20000"].pctFlatApartment != nil {
		t.Fatalf("blank numerator must leave its rate nil, got %v", *got["20000"].pctFlatApartment)
	}
}

// The population floor does not protect a DWELLING-denominated share: a
// 110-person locality can have 28 dwellings (Sandy Gully WA: tenure summed to
// 132%). Tenure, structure and household composition need their own
// denominator floor; the raw dwelling count is still published.
func TestDwellingSharesNeedTheirOwnDenominatorFloor(t *testing.T) {
	logger, _ := expandedTestLogger()
	population := map[string]*int{"51327": intPtr(110), "10707": intPtr(1000)}
	below := censusDwellingShareMinDenominator - 1

	g37 := parseG37([][]string{
		{"SAL_CODE_2021", "O_OR_Total", "O_MTG_Total", "R_Tot_Total", "Total_Total"},
		{"SAL51327", "10", "5", "2", strconv.Itoa(below)},
		{"SAL10707", "25", "15", "10", strconv.Itoa(censusDwellingShareMinDenominator)},
	}, population, logger)
	if s := g37["51327"]; s.pctOwnedOutright != nil || s.pctOwnedMortgage != nil || s.pctRented != nil {
		t.Fatalf("tenure below %d dwellings must be nil: %+v", censusDwellingShareMinDenominator, s)
	}
	if c := g37["51327"].dwellingCount; c == nil || *c != below {
		t.Fatalf("the raw dwelling count is not a share and must survive the floor, got %v", c)
	}
	floatValue(t, g37["10707"].pctOwnedOutright, 50)

	g36 := parseG36([][]string{
		{"SAL_CODE_2021", "OPDs_Separate_house_Dwellings", "OPDs_Flt_apart_Tot_Dwgs", "OPDs_Tot_OPDs_Dwellings"},
		{"SAL51327", "20", "0", strconv.Itoa(below)},
	}, population, logger)
	if s := g36["51327"]; s.pctSeparateHouse != nil || s.pctFlatApartment != nil {
		t.Fatalf("dwelling structure below the floor must be nil: %+v", s)
	}

	g42 := parseG42([][]string{
		{"SAL_CODE_2021", "Tot_FHs_CF_C", "Tot_Lone_P_H", "Tot_Tot"},
		{"SAL51327", "8", "6", strconv.Itoa(below)},
	}, population, logger)
	if s := g42["51327"]; s.pctCoupleWithChildren != nil || s.pctLonePersonHousehold != nil {
		t.Fatalf("household composition below the floor must be nil: %+v", s)
	}
}

// Mutually exclusive shares of one denominator that sum past 101% are
// internally inconsistent, so the whole group is withheld; a group within
// perturbation tolerance is published as is.
func TestOverfullShareGroupsAreWithheld(t *testing.T) {
	logger, _ := expandedTestLogger()
	population := map[string]*int{"10001": intPtr(1000), "10002": intPtr(1000)}

	g37 := parseG37([][]string{
		{"SAL_CODE_2021", "O_OR_Total", "O_MTG_Total", "R_Tot_Total", "Total_Total"},
		{"SAL10001", "40", "40", "22", "100"}, // 102%
		{"SAL10002", "40", "40", "21", "100"}, // 101% - tolerated
	}, population, logger)
	if s := g37["10001"]; s.pctOwnedOutright != nil || s.pctOwnedMortgage != nil || s.pctRented != nil {
		t.Fatalf("a tenure group summing to 102%% must be withheld whole: %+v", s)
	}
	if c := g37["10001"].dwellingCount; c == nil || *c != 100 {
		t.Fatalf("withholding the shares must not drop the dwelling count, got %v", c)
	}
	floatValue(t, g37["10002"].pctRented, 21)

	g42 := parseG42([][]string{
		{"SAL_CODE_2021", "Tot_FHs_CF_C", "Tot_Lone_P_H", "Tot_Tot"},
		{"SAL10001", "70", "40", "100"},
	}, population, logger)
	if s := g42["10001"]; s.pctCoupleWithChildren != nil || s.pctLonePersonHousehold != nil {
		t.Fatalf("an overfull household group must be withheld: %+v", s)
	}

	g36 := parseG36([][]string{
		{"SAL_CODE_2021", "OPDs_Separate_house_Dwellings", "OPDs_Flt_apart_Tot_Dwgs", "OPDs_Tot_OPDs_Dwellings"},
		{"SAL10001", "90", "15", "100"},
	}, population, logger)
	if s := g36["10001"]; s.pctSeparateHouse != nil || s.pctFlatApartment != nil {
		t.Fatalf("an overfull dwelling-structure group must be withheld: %+v", s)
	}
}

// Unemployment is a share of the labour force, which in a remote locality can
// be a dozen people: 14 of them gave a published 57% rate. Participation and
// bachelor+ use the (floored) 15+ population and are unaffected.
func TestUnemploymentNeedsALabourForceFloor(t *testing.T) {
	logger, _ := expandedTestLogger()
	rows := [][]string{
		{"SAL_CODE_2021", "lfs_Unmplyed_lookng_for_wrk_P", "lfs_Tot_LF_P", "P_15_yrs_over_P",
			"non_sch_qual_PostGrad_Dgre_P", "non_sch_qual_Gr_Dip_Gr_Crt_P", "non_sch_qual_Bchelr_Degree_P"},
		{"SAL70001", "8", strconv.Itoa(censusLabourForceMinDenominator - 36), "120", "1", "1", "4"},
		{"SAL70002", "26", strconv.Itoa(censusLabourForceMinDenominator), "140", "1", "1", "4"},
	}
	got := parseG43(rows, map[string]*int{"70001": intPtr(147), "70002": intPtr(188)}, logger)
	if got["70001"].unemploymentRate != nil {
		t.Fatalf("unemployment on a labour force below %d must be nil, got %v", censusLabourForceMinDenominator, *got["70001"].unemploymentRate)
	}
	floatValue(t, got["70001"].labourForceParticipationRate, 100.0*14/120)
	floatValue(t, got["70002"].unemploymentRate, 52)
}

func TestWithholdOverfullGroupIgnoresMissingMembers(t *testing.T) {
	a, b := 80.0, 30.0
	pa, pb := &a, &b
	var missing *float64
	withholdOverfullGroup(&pa, &missing)
	if pa == nil {
		t.Fatal("a lone present share cannot be overfull")
	}
	withholdOverfullGroup(&pa, &pb, &missing)
	if pa != nil || pb != nil {
		t.Fatal("80% + 30% must withhold both")
	}
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

// The culture block had no population floor: 97 localities of 3-17 residents
// published a top-religion share above 100%. Below the derived-rate floor every
// culture share AND both labels are withheld; at or above it nothing changes.
func TestSubFloorCultureIsWithheld(t *testing.T) {
	str := func(s string) *string { return &s }
	f := func(v float64) *float64 { return &v }
	culture := func(pop *int) CensusRow {
		return CensusRow{
			Population:      pop,
			PctBornOverseas: f(20), PctEnglishOnly: f(70),
			TopReligion: str("Catholic"), PctTopReligion: f(125), PctNoReligion: f(40),
			TopLanguage: str("Australian Indigenous languages"), PctTopLanguage: f(60),
		}
	}

	for name, pop := range map[string]*int{
		"below the floor":   intPtr(censusDerivedRateMinPopulation - 1),
		"a 17-person SAL":   intPtr(17),
		"no G01 population": nil,
	} {
		row := culture(pop)
		withholdSubFloorCulture(&row)
		if row.PctBornOverseas != nil || row.PctEnglishOnly != nil || row.TopReligion != nil ||
			row.PctTopReligion != nil || row.PctNoReligion != nil || row.TopLanguage != nil || row.PctTopLanguage != nil {
			t.Fatalf("%s: culture block must be withheld, got %+v", name, row)
		}
	}

	row := culture(intPtr(censusDerivedRateMinPopulation))
	withholdSubFloorCulture(&row)
	if row.TopReligion == nil || *row.TopReligion != "Catholic" || row.PctTopLanguage == nil || *row.PctTopLanguage != 60 {
		t.Fatalf("at the floor the culture block must pass through, got %+v", row)
	}
}

// The culture floor has to hold on the path the ingest runs, not only in the
// helper: a 12-person locality whose perturbed G14 cells gave a 125% top
// religion reaches the table with no culture block at all, while its
// population, medians and dwelling count are still published.
func TestAssembleCensusRowFloorsCultureOnTheIngestPath(t *testing.T) {
	pct := func(v float64) *float64 { return &v }
	id := suburbIdentity{salName: "Tiny Locality", stateCode: "NT"}
	g01 := map[string]g01Row{
		"70001": {pop: intPtr(12), bpAus: 10, bpElse: 2, langEngOnly: 4, langOther: 8},
		"70002": {pop: intPtr(4200), bpAus: 3000, bpElse: 1200, langEngOnly: 3000, langOther: 1200},
	}
	medians := map[string]g02Medians{"70001": {age: pct(41)}}
	religion := map[string]religionStats{
		"70001": {top: "Catholic", pctTop: pct(125), pctNoRel: pct(40)},
		"70002": {top: "Catholic", pctTop: pct(31), pctNoRel: pct(40)},
	}
	language := map[string]languageStats{"70001": {top: "Greek", count: 7}, "70002": {top: "Greek", count: 600}}
	expanded := map[string]expandedCensusStats{"70001": {dwellingCount: intPtr(5)}}

	tiny := assembleCensusRow("70001", id, g01, medians, religion, language, expanded)
	if tiny.TopReligion != nil || tiny.PctTopReligion != nil || tiny.PctNoReligion != nil ||
		tiny.TopLanguage != nil || tiny.PctTopLanguage != nil || tiny.PctBornOverseas != nil || tiny.PctEnglishOnly != nil {
		t.Fatalf("a 12-person locality must publish no culture block: %+v", tiny)
	}
	if tiny.Population == nil || *tiny.Population != 12 || tiny.MedianAge == nil || tiny.DwellingCount == nil || *tiny.DwellingCount != 5 {
		t.Fatalf("the floor withholds culture shares only, got %+v", tiny)
	}

	big := assembleCensusRow("70002", id, g01, medians, religion, language, expanded)
	if big.TopReligion == nil || *big.TopReligion != "Catholic" || big.TopLanguage == nil || *big.TopLanguage != "Greek" {
		t.Fatalf("a populous suburb keeps its culture block: %+v", big)
	}
	floatValue(t, big.PctTopLanguage, 100.0*600/4200)
}
