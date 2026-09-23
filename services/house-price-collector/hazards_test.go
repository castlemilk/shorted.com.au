package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeHazardsFixture(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "suburb-hazards.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func TestLoadHazardsPreservesNullVersusZeroAndNamesSources(t *testing.T) {
	path := writeHazardsFixture(t, `{
		"10001": {
			"sampledCellCount": 250,
			"waterObservedSharePct": 0,
			"permanentWaterSharePct": 1.5,
			"floodPlanningSharePct": null,
			"bushfireProneSharePct": 40.25
		},
		"30001": {
			"sampledCellCount": 250,
			"waterObservedSharePct": 3,
			"permanentWaterSharePct": 0,
			"floodPlanningSharePct": null,
			"bushfireProneSharePct": null
		}
	}`)
	rows, err := loadHazards(path)
	if err != nil {
		t.Fatalf("loadHazards: %v", err)
	}
	if len(rows) != 2 || rows[0].SALCode != "10001" {
		t.Fatalf("rows = %+v", rows)
	}
	nsw := rows[0]
	if nsw.WaterObservedSharePct == nil || *nsw.WaterObservedSharePct != 0 {
		t.Fatalf("explicit zero must remain present, got %v", nsw.WaterObservedSharePct)
	}
	if nsw.FloodPlanningSharePct != nil {
		t.Fatalf("JSON null must remain absent")
	}
	if nsw.FloodSource() != "" || nsw.BushfireSource() != "nsw_bfpl" || nsw.WaterSource() != hazardsWaterSource {
		t.Fatalf("sources = %q %q %q", nsw.FloodSource(), nsw.BushfireSource(), nsw.WaterSource())
	}
	qld := rows[1]
	if qld.BushfireSource() != "" || qld.FloodSource() != "" {
		t.Fatalf("absent QLD shares must name no source, got %q %q", qld.FloodSource(), qld.BushfireSource())
	}
}

func TestEveryStateNamesItsStatutorySourcesPerHazard(t *testing.T) {
	path := writeHazardsFixture(t, `{
		"20001": {"sampledCellCount": 250, "floodPlanningSharePct": 0, "bushfireProneSharePct": 3},
		"30001": {"sampledCellCount": 250, "floodPlanningSharePct": null, "bushfireProneSharePct": 0},
		"40001": {"sampledCellCount": 250, "floodPlanningSharePct": 7, "bushfireProneSharePct": 50},
		"50001": {"sampledCellCount": 250, "floodPlanningSharePct": null, "bushfireProneSharePct": 100},
		"60001": {"sampledCellCount": 250, "floodPlanningSharePct": null, "bushfireProneSharePct": 2},
		"70001": {"sampledCellCount": 250, "floodPlanningSharePct": null, "bushfireProneSharePct": null},
		"80001": {"sampledCellCount": 250, "floodPlanningSharePct": 4, "bushfireProneSharePct": 60}
	}`)
	rows, err := loadHazards(path)
	if err != nil {
		t.Fatalf("loadHazards: %v", err)
	}
	type want struct{ flood, bushfire, licence string }
	wants := map[string]want{
		// VIC bushfire is the Building Regulations designation now, like-for-like
		// with NSW Bush Fire Prone Land — never the narrower BMO planning overlay.
		"20001": {"vic_plan_overlay_lsio_fo_sbo", "vic_bpa", "CC-BY-4.0"},
		"30001": {"", "qld_qfd_bpa", "CC-BY-4.0"},
		"40001": {"sa_pdcode_hazards_flooding", "sa_pdcode_hazards_bushfire", "CC-BY-4.0; CC-BY-3.0-AU"},
		"50001": {"", "wa_obrm_026_bpa", "CC-BY-4.0"},
		// A TAS suburb outside every flood-mapping LPS is null for flood; its
		// row still carries the bushfire layer's licence.
		"60001": {"", "tas_tps_bushfire_prone", "CC-BY-4.0; CC-BY-3.0-AU"},
		"70001": {"", "", "CC-BY-4.0"},
		"80001": {"act_flood_extent_1pct_aep", "act_bpa_2026", "CC-BY-4.0"},
	}
	for _, row := range rows {
		got := want{row.FloodSource(), row.BushfireSource(), row.Licence()}
		if got != wants[row.SALCode] {
			t.Errorf("SAL %s: got %+v, want %+v", row.SALCode, got, wants[row.SALCode])
		}
	}
}

func TestLoadHazardsGatesWaterSharesOnTheCellFloorButNotVectorShares(t *testing.T) {
	path := writeHazardsFixture(t, `{
		"20001": {"sampledCellCount": 10, "waterObservedSharePct": 50, "permanentWaterSharePct": 0,
		          "floodPlanningSharePct": 12.5, "bushfireProneSharePct": null}
	}`)
	rows, err := loadHazards(path)
	if err != nil {
		t.Fatalf("loadHazards: %v", err)
	}
	if rows[0].WaterObservedSharePct != nil || rows[0].PermanentWaterSharePct != nil {
		t.Fatalf("water shares below the %d-cell floor must be null", minimumHazardCellCount)
	}
	if rows[0].FloodPlanningSharePct == nil || *rows[0].FloodPlanningSharePct != 12.5 {
		t.Fatalf("vector share must survive the raster floor")
	}
}

func TestLoadHazardsRejectsOutOfRangeAndUnsourcedRows(t *testing.T) {
	cases := map[string]string{
		"share over 100":     `{"10001": {"sampledCellCount": 100, "waterObservedSharePct": 101}}`,
		"negative share":     `{"10001": {"sampledCellCount": 100, "bushfireProneSharePct": -1}}`,
		"water sum past 100": `{"10001": {"sampledCellCount": 100, "waterObservedSharePct": 60, "permanentWaterSharePct": 50}}`,
		"statutory share NT": `{"70001": {"sampledCellCount": 100, "bushfireProneSharePct": 5}}`,
		// QLD and WA have a bushfire layer but no open flood layer: the check is
		// per hazard, or these would load with a blank flood_source.
		"flood share QLD": `{"30001": {"sampledCellCount": 100, "floodPlanningSharePct": 5}}`,
		"flood share WA":  `{"50001": {"sampledCellCount": 100, "floodPlanningSharePct": 5}}`,
		"blank sal code":  `{"": {"sampledCellCount": 100}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := loadHazards(writeHazardsFixture(t, body)); err == nil {
				t.Fatalf("expected an error")
			} else if !strings.Contains(err.Error(), "hazards artifact") {
				t.Fatalf("error should name the artifact: %v", err)
			}
		})
	}
}
