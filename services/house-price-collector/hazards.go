package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Per-suburb hazard exposure, computed offline by web/scripts/geo/hazards/ and
// loaded from web/public/geo/insights/suburb-hazards.json.
//
// Three sources, all CC-BY-4.0:
//   - DEA Water Observations Statistics (Landsat, 1987 onward, 30 m),
//     © Commonwealth of Australia (Geoscience Australia) — the share of a
//     suburb's validly observed land seen under water at least occasionally,
//     and the share that is permanent water. A floor on inundation, never a
//     flood-risk estimate: the satellite under-observes flood peaks.
//   - Statutory flood planning overlays — NSW EPI Flood (NSW Planning Portal),
//     VIC LSIO/FO/SBO (Vicmap Planning). Planning-control boundaries, not
//     flood extents; NSW councils have owned currency since July 2021.
//   - Bushfire prone land — NSW BFPL (NSW RFS), VIC BMO (Vicmap Planning).
//
// NULL means "no source covers this suburb"; a genuine 0 is stored as 0.
const (
	hazardsWaterSource    = "dea_wo_fq_myear_3_v2_1_0"
	hazardsLicence        = "CC-BY-4.0"
	minimumHazardCellCount = 25
)

var hazardVectorSources = map[string]struct{ flood, bushfire string }{
	"1": {flood: "nsw_epi_flood", bushfire: "nsw_bfpl"},
	"2": {flood: "vic_plan_overlay_lsio_fo_sbo", bushfire: "vic_plan_overlay_bmo"},
}

// HazardRow is one suburb's hazard exposure. Pointers preserve the distinction
// between absent (nil -> SQL NULL) and a genuine computed zero.
type HazardRow struct {
	SALCode                string
	SampledCellCount       int      `json:"sampledCellCount"`
	WaterObservedSharePct  *float64 `json:"waterObservedSharePct"`
	PermanentWaterSharePct *float64 `json:"permanentWaterSharePct"`
	FloodPlanningSharePct  *float64 `json:"floodPlanningSharePct"`
	BushfireProneSharePct  *float64 `json:"bushfireProneSharePct"`
}

// WaterSource, FloodSource and BushfireSource name the dataset each share was
// measured from, or "" when the share is absent, so the row explains itself.
func (row HazardRow) WaterSource() string {
	if row.WaterObservedSharePct == nil && row.PermanentWaterSharePct == nil {
		return ""
	}
	return hazardsWaterSource
}

func (row HazardRow) FloodSource() string {
	if row.FloodPlanningSharePct == nil {
		return ""
	}
	return hazardVectorSources[stateDigit(row.SALCode)].flood
}

func (row HazardRow) BushfireSource() string {
	if row.BushfireProneSharePct == nil {
		return ""
	}
	return hazardVectorSources[stateDigit(row.SALCode)].bushfire
}

// ABS SAL codes lead with the state digit (1 = NSW … 8 = ACT).
func stateDigit(salCode string) string {
	if salCode == "" {
		return ""
	}
	return salCode[:1]
}

func hazardsPath() string {
	if path := strings.TrimSpace(os.Getenv("HAZARDS_FILE")); path != "" {
		return path
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-hazards.json")
}

func loadHazards(path string) ([]HazardRow, error) {
	raw := map[string]HazardRow{}
	if err := readJSONFile(path, &raw); err != nil {
		return nil, err
	}
	rows := make([]HazardRow, 0, len(raw))
	for salCode, row := range raw {
		row.SALCode = strings.TrimSpace(salCode)
		if row.SALCode == "" {
			return nil, fmt.Errorf("hazards artifact contains a blank sal_code key")
		}
		if row.SampledCellCount < 0 {
			return nil, fmt.Errorf("hazards artifact SAL %s has negative sampledCellCount", row.SALCode)
		}
		if row.SampledCellCount < minimumHazardCellCount {
			// The water shares are quality-gated by the raster sample; the vector
			// shares are not derived from the raster and stand on their own.
			row.WaterObservedSharePct = nil
			row.PermanentWaterSharePct = nil
		}
		if err := row.validate(); err != nil {
			return nil, fmt.Errorf("hazards artifact SAL %s: %w", row.SALCode, err)
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].SALCode < rows[j].SALCode })
	return rows, nil
}

func (row HazardRow) validate() error {
	shares := []struct {
		name  string
		value *float64
	}{
		{"waterObservedSharePct", row.WaterObservedSharePct},
		{"permanentWaterSharePct", row.PermanentWaterSharePct},
		{"floodPlanningSharePct", row.FloodPlanningSharePct},
		{"bushfireProneSharePct", row.BushfireProneSharePct},
	}
	for _, share := range shares {
		if share.value == nil {
			continue
		}
		if math.IsNaN(*share.value) || math.IsInf(*share.value, 0) || *share.value < 0 || *share.value > 100 {
			return fmt.Errorf("%s must be between 0 and 100", share.name)
		}
	}
	if row.WaterObservedSharePct != nil && row.PermanentWaterSharePct != nil &&
		*row.WaterObservedSharePct+*row.PermanentWaterSharePct > 100.0001 {
		return fmt.Errorf("water shares are disjoint and cannot sum past 100")
	}
	if (row.FloodPlanningSharePct != nil || row.BushfireProneSharePct != nil) &&
		hazardVectorSources[stateDigit(row.SALCode)] == (struct{ flood, bushfire string }{}) {
		return fmt.Errorf("vector share present for a state with no statutory source")
	}
	return nil
}

func ingestHazards() ([]HazardRow, error) { return loadHazards(hazardsPath()) }
