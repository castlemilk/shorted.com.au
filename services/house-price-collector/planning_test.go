package main

import (
	"os"
	"path/filepath"
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
		          "planningInstruments": ["Blacktown Local Environmental Plan 2015"],
		          "zoningSource": "nsw_epi_land_zoning", "heritageSource": "nsw_epi_heritage", "licence": "CC-BY-4.0"},
		"10002": {"zoningCoveragePct": 0, "zoningSource": "nsw_epi_land_zoning"},
		"30001": {"heritageItemCount": 2, "heritageSource": "qld_heritage_register"}
	}`)
	if err != nil {
		t.Fatalf("loadPlanning: %v", err)
	}
	if len(rows) != 3 || rows[0].SALCode != "10001" || rows[2].SALCode != "30001" {
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
	// QLD: heritage only — no zoning, and a default licence.
	qld := rows[2]
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
		"non-positive control":       `{"10001": {"nswFsrMedian": 0}}`,
		"median above max":           `{"10001": {"nswHeightMedianM": 20, "nswHeightMaxM": 12}}`,
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
		ZoningSource:       "nsw_epi_land_zoning",
		Licence:            "CC-BY-4.0",
	}
	args := planningUpsertArgs(row)
	if len(args) != 23 {
		t.Fatalf("want 23 args for 23 placeholders, got %d", len(args))
	}
	if strings.Count(planningUpsertSQL, "$") != 23+1 { // $1 appears twice (VALUES + EXISTS)
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
	if inst, ok := args[19].([]string); !ok || inst != nil {
		t.Fatalf("no instruments must be SQL NULL, got %#v", args[19])
	}
	if args[22] != "CC-BY-4.0" {
		t.Fatalf("licence arg = %v", args[22])
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
	for _, column := range []string{"zone_res_low_share_pct", "planning_instruments", "heritage_item_count"} {
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
