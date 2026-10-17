package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func parsePlanningFixture(t *testing.T, body string) ([]PlanningRow, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "suburb-planning.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return loadPlanning(path)
}

func TestLoadPlanningKeepsNullDistinctFromZero(t *testing.T) {
	rows, err := parsePlanningFixture(t, `{
		"10001": {"zoningCoveragePct": 99.5, "zoneSharesPct": {"res_low": 60, "open_space": 39.5},
		          "dominantZoneFamily": "res_low", "heritageSharePct": 0, "heritageItemCount": 0,
		          "nswHeightMedianM": 8.5, "nswHeightMaxM": 12, "nswFsrMedian": 0.5, "nswMinLotMedianM2": 450,
		          "nswHeightMappedPct": 98, "nswFsrMappedPct": 50, "nswMinLotMappedPct": 100,
		          "planningInstruments": ["Blacktown Local Environmental Plan 2015"],
		          "zoningSource": "nsw_epi_land_zoning", "heritageSource": "nsw_epi_heritage", "licence": "CC-BY-4.0"},
		"10002": {"zoningCoveragePct": 0, "zoningSource": "nsw_epi_land_zoning"},
		"10003": {"zoningCoveragePct": 2.9, "zoningSource": "nsw_epi_land_zoning", "planningInstruments": ["Sydney Local Environmental Plan 2012"]},
		"10004": {"zoningCoveragePct": 99, "zoneSharesPct": {"res_low": 99}, "dominantZoneFamily": "res_low",
		          "nswFsrMappedPct": 4.9, "nswHeightMappedPct": 0},
		"30001": {"heritageItemCount": 2, "heritageSource": "qld_heritage_register"}
	}`)
	if err != nil {
		t.Fatalf("loadPlanning: %v", err)
	}
	if len(rows) != 5 || rows[0].SALCode != "10001" || rows[4].SALCode != "30001" {
		t.Fatalf("rows not sorted by SAL: %+v", rows)
	}
	nsw := rows[0]
	if got := nsw.FamilyShare("res_low"); got == nil || *got != 60 {
		t.Fatalf("res_low = %v", got)
	}
	// A family absent from a covered suburb is a measured 0, not NULL.
	if got := nsw.FamilyShare("industrial"); got == nil || *got != 0 {
		t.Fatalf("absent family in a zoned suburb must be 0, got %v", got)
	}
	if nsw.HeritageSharePct == nil || *nsw.HeritageSharePct != 0 {
		t.Fatalf("explicit heritage 0 must survive, got %v", nsw.HeritageSharePct)
	}
	// Zero coverage: the scheme does not reach the suburb, so every family is NULL.
	uncovered := rows[1]
	if got := uncovered.FamilyShare("res_low"); got != nil {
		t.Fatalf("uncovered suburb family share must be NULL, got %v", *got)
	}
	if uncovered.ZoningCoveragePct == nil || *uncovered.ZoningCoveragePct != 0 {
		t.Fatalf("coverage 0 must stay a measured 0")
	}
	// Coverage under half: the coverage is a measurement, nothing else is.
	sliver := rows[2]
	if sliver.ZoningCoveragePct == nil || *sliver.ZoningCoveragePct != 2.9 || sliver.FamilyShare("res_low") != nil ||
		sliver.DominantZoneFamily != nil || sliver.HeritageSharePct != nil {
		t.Fatalf("a sliver-covered suburb must carry coverage only: %+v", sliver)
	}
	// A standard mapped on a sliver of residential land: the mapped share is
	// stored (a measured 4.9%, and a measured 0), the standard itself is not.
	patchy := rows[3]
	if patchy.NSWFSRMappedPct == nil || *patchy.NSWFSRMappedPct != 4.9 || patchy.NSWFSRMedian != nil {
		t.Fatalf("patchy FSR: %+v", patchy)
	}
	if patchy.NSWHeightMappedPct == nil || *patchy.NSWHeightMappedPct != 0 {
		t.Fatalf("a measured 0%% mapped must survive, got %v", patchy.NSWHeightMappedPct)
	}
	// QLD: heritage only — no zoning, and a default licence.
	qld := rows[4]
	if qld.ZoningCoveragePct != nil || qld.FamilyShare("res_low") != nil || qld.DominantZoneFamily != nil {
		t.Fatalf("QLD has no zoning source: %+v", qld)
	}
	if qld.Licence != planningLicence {
		t.Fatalf("licence default = %q", qld.Licence)
	}
}

func TestLoadPlanningRejectsInvalidRows(t *testing.T) {
	cases := map[string]string{
		"share over 100":             `{"10001": {"zoningCoveragePct": 100, "zoneSharesPct": {"res_low": 101}}}`,
		"negative share":             `{"10001": {"zoningCoveragePct": 0, "zoneSharesPct": {"res_low": -1}}}`,
		"coverage over 100":          `{"10001": {"zoningCoveragePct": 100.5}}`,
		"heritage over 100":          `{"20001": {"heritageSharePct": 120}}`,
		"shares do not sum":          `{"10001": {"zoningCoveragePct": 90, "zoneSharesPct": {"res_low": 50}}}`,
		"unknown family":             `{"10001": {"zoningCoveragePct": 50, "zoneSharesPct": {"residential": 50}}}`,
		"unknown dominant":           `{"10001": {"zoningCoveragePct": 50, "zoneSharesPct": {"res_low": 50}, "dominantZoneFamily": "housing"}}`,
		"dominant without share":     `{"10001": {"zoningCoveragePct": 50, "zoneSharesPct": {"res_low": 50}, "dominantZoneFamily": "rural"}}`,
		"zoning in QLD":              `{"30001": {"zoningCoveragePct": 50, "zoneSharesPct": {"res_low": 50}}}`,
		"row for WA":                 `{"50001": {"heritageItemCount": 1}}`,
		"row for NT":                 `{"70001": {"heritageItemCount": 1}}`,
		"NSW control in VIC":         `{"20001": {"nswHeightMedianM": 9}}`,
		"non-positive control":       `{"10001": {"nswFsrMedian": 0, "nswFsrMappedPct": 90}}`,
		"median above max":           `{"10001": {"nswHeightMedianM": 20, "nswHeightMaxM": 12, "nswHeightMappedPct": 90}}`,
		"control mapped on a sliver": `{"10001": {"nswFsrMedian": 1.6, "nswFsrMappedPct": 4.9}}`,
		"control with no mapped pct": `{"10001": {"nswFsrMedian": 1.6}}`,
		"height max on a sliver":     `{"10001": {"nswHeightMaxM": 25, "nswHeightMappedPct": 4.5}}`,
		"mapped pct over 100":        `{"10001": {"nswFsrMappedPct": 101}}`,
		"mapped pct in VIC":          `{"20001": {"nswFsrMappedPct": 80}}`,
		"shares on a sliver":         `{"10001": {"zoningCoveragePct": 2.9, "zoneSharesPct": {"centre_mixed": 2.9}, "dominantZoneFamily": "centre_mixed"}}`,
		"heritage on a sliver":       `{"10001": {"zoningCoveragePct": 2.9, "heritageSharePct": 0, "heritageItemCount": 0}}`,
		"heritage with no coverage":  `{"20001": {"heritageSharePct": 5}}`,
		"measured without shares":    `{"10001": {"zoningCoveragePct": 80}}`,
		"negative item count":        `{"30001": {"heritageItemCount": -1}}`,
		"proprietary licence":        `{"10001": {"licence": "proprietary-tos-restricted"}}`,
		"blank sal code":             `{"": {}}`,
		"shares without coverage":    `{"10001": {"zoneSharesPct": {"res_low": 50}}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parsePlanningFixture(t, body)
			if err == nil {
				t.Fatalf("expected an error")
			}
			if !strings.Contains(err.Error(), "planning artifact") {
				t.Fatalf("error should name the artifact: %v", err)
			}
		})
	}
}

func TestPlanningUpsertArgsFollowColumnOrder(t *testing.T) {
	cov, h := 80.0, 9.0
	fam := "centre_mixed"
	row := PlanningRow{
		SALCode:            "10001",
		ZoningCoveragePct:  &cov,
		ZoneSharesPct:      map[string]float64{"centre_mixed": 70, "water": 10},
		DominantZoneFamily: &fam,
		NSWHeightMedianM:   &h,
		NSWHeightMappedPct: &cov,
		ZoningSource:       "nsw_epi_land_zoning",
		Licence:            "CC-BY-4.0",
	}
	args := planningUpsertArgs(row)
	if len(args) != 26 {
		t.Fatalf("want 26 args for 26 placeholders, got %d", len(args))
	}
	if strings.Count(planningUpsertSQL, "$") != 26+1 { // $1 appears twice (VALUES + EXISTS)
		t.Fatalf("placeholder count drifted from the argument list")
	}
	// Families occupy $2..$11 in zoneFamilies order.
	if v := args[1+2].(*float64); v == nil || *v != 70 { // centre_mixed is the 3rd family
		t.Fatalf("centre_mixed arg = %v", args[3])
	}
	if v := args[1+0].(*float64); v == nil || *v != 0 {
		t.Fatalf("res_low absent in a zoned suburb must be written as 0")
	}
	if v := args[1+8].(*float64); v == nil || *v != 10 {
		t.Fatalf("water arg = %v", args[9])
	}
	if args[11] != row.ZoningCoveragePct || args[12] != row.DominantZoneFamily || args[14] != row.HeritageItemCount {
		t.Fatalf("scalar args out of order: %v", args[11:15])
	}
	if args[19] != row.NSWHeightMappedPct || args[20] != row.NSWFSRMappedPct || args[21] != row.NSWMinLotMappedPct {
		t.Fatalf("mapped-share args out of order: %v", args[19:22])
	}
	if inst, ok := args[22].([]string); !ok || inst != nil {
		t.Fatalf("no instruments must be SQL NULL, got %#v", args[22])
	}
	if args[25] != "CC-BY-4.0" {
		t.Fatalf("licence arg = %v", args[25])
	}
}

func TestZoneFamiliesMatchTheMigration(t *testing.T) {
	sql, err := os.ReadFile(filepath.Join("..", "migrations", "000125_add_suburb_planning.up.sql"))
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	for _, family := range zoneFamilies {
		if !strings.Contains(string(sql), "zone_"+family+"_share_pct") {
			t.Fatalf("migration lacks a column for family %q", family)
		}
		if !strings.Contains(string(sql), "'"+family+"'") {
			t.Fatalf("migration family CHECK lacks %q", family)
		}
	}
	for _, column := range []string{"zone_res_low_share_pct", "planning_instruments", "heritage_item_count",
		"nsw_height_mapped_pct", "nsw_fsr_mapped_pct", "nsw_min_lot_mapped_pct"} {
		if !strings.Contains(planningUpsertSQL, column) {
			t.Fatalf("upsert does not write %s", column)
		}
	}
}

func TestEmbeddedPlanningArtifactLoads(t *testing.T) {
	rows, err := loadPlanning("")
	if err != nil {
		t.Fatalf("embedded artifact: %v", err)
	}
	states := map[string]int{}
	for _, row := range rows {
		states[stateDigit(row.SALCode)]++
	}
	for _, digit := range []string{"5", "7", "9"} {
		if states[digit] != 0 {
			t.Fatalf("state %s has no planning source but %d rows", digit, states[digit])
		}
	}
	if states["8"] == 0 || states["3"] == 0 {
		t.Fatalf("expected ACT and QLD rows, got %v", states)
	}
}

// TestPlanningGatesMatchTheBuild holds the two coverage gates together across
// the offline build (which applies them), this loader (which re-checks the
// artifact) and the migration (which makes a violating row unstorable).
func TestPlanningGatesMatchTheBuild(t *testing.T) {
	py, err := os.ReadFile(filepath.Join("..", "..", "web", "scripts", "geo", "planning", "planning_share.py"))
	if err != nil {
		t.Fatalf("read planning_share.py: %v", err)
	}
	sql, err := os.ReadFile(filepath.Join("..", "migrations", "000125_add_suburb_planning.up.sql"))
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	for name, want := range map[string]float64{
		"MIN_MEASURED_COVERAGE_PCT": planningMinCoveragePct,
		"CONTROL_MIN_MAPPED_PCT":    planningControlMinMappedPct,
	} {
		m := regexp.MustCompile(`(?m)^` + name + `\s*=\s*([0-9.]+)`).FindSubmatch(py)
		if m == nil {
			t.Fatalf("planning_share.py does not define %s", name)
		}
		got, err := strconv.ParseFloat(string(m[1]), 64)
		if err != nil || got != want {
			t.Fatalf("%s = %s in the build, %v here", name, m[1], want)
		}
	}
	for _, clause := range []string{
		fmt.Sprintf("zoning_coverage_pct >= %g", planningMinCoveragePct),
		fmt.Sprintf("nsw_fsr_mapped_pct >= %g", planningControlMinMappedPct),
		fmt.Sprintf("nsw_height_mapped_pct >= %g", planningControlMinMappedPct),
		fmt.Sprintf("nsw_min_lot_mapped_pct >= %g", planningControlMinMappedPct),
	} {
		if !strings.Contains(string(sql), clause) {
			t.Fatalf("migration 000125 lacks %q", clause)
		}
	}
}
