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
// Three kinds of source, each openly licensed (CC BY 4.0 unless noted):
//   - DEA Water Observations Statistics (Landsat, 1987 onward, 30 m),
//     © Commonwealth of Australia (Geoscience Australia) — the share of a
//     suburb's validly observed land seen under water at least occasionally,
//     and the share that is permanent water. A floor on inundation, never a
//     flood-risk estimate: the satellite under-observes flood peaks.
//   - Statutory flood planning overlays — NSW EPI Flood (NSW Planning Portal),
//     VIC LSIO/FO/SBO (Vicmap Planning), SA Planning and Design Code Hazards
//     (Flooding) + (Flooding – General) (CC BY 3.0 AU), TAS Planning Scheme
//     Flood-prone Areas code overlay (CC BY 3.0 AU). Planning-control
//     boundaries, not flood extents. ACT's is the exception: its only open
//     layer is the modelled 1% AEP flood extent, which is not a planning
//     overlay, and every surface that shows it says so.
//   - Bushfire prone designations — NSW BFPL (NSW RFS), VIC Designated
//     Bushfire Prone Area (Building Regulations, like-for-like with NSW BFPL;
//     it replaced the narrower BMO planning overlay), QLD Bushfire Prone Area
//     (QFD), WA Bush Fire Prone Areas OBRM-026, SA Code Hazards (Bushfire –
//     High/Medium/General/Urban Interface) (CC BY 3.0 AU), TAS Bushfire-prone
//     Areas code overlay (CC BY 3.0 AU), ACT Bushfire Prone Area 2026.
//
// NULL means "no source covers this suburb"; a genuine 0 is stored as 0. Inside
// a state the share builder applies the same rule per suburb: NSW flood is
// null outside the twelve instruments that lodged a flood map, TAS outside the
// councils whose Local Provisions Schedule maps the overlay, SA wherever the
// Code itself says the hazard is unassessed.
const (
	hazardsWaterSource     = "dea_wo_fq_myear_3_v2_1_0"
	hazardsLicence         = "CC-BY-4.0"
	minimumHazardCellCount = 25
)

// hazardVectorSource names the statutory datasets for one state, keyed by the
// ABS state digit (1 = NSW … 8 = ACT). An empty id means the state has no open
// layer for that hazard, and validate() refuses a share for it.
type hazardVectorSource struct {
	flood, bushfire string
	// licence of the statutory layers when it is not CC BY 4.0. The water
	// share on the same row is always CC BY 4.0, so a row that carries one of
	// these layers records both.
	licence string
}

var hazardVectorSources = map[string]hazardVectorSource{
	"1": {flood: "nsw_epi_flood", bushfire: "nsw_bfpl"},
	"2": {flood: "vic_plan_overlay_lsio_fo_sbo", bushfire: "vic_bpa"},
	"3": {bushfire: "qld_qfd_bpa"},
	"4": {flood: "sa_pdcode_hazards_flooding", bushfire: "sa_pdcode_hazards_bushfire", licence: "CC-BY-3.0-AU"},
	"5": {bushfire: "wa_obrm_026_bpa"},
	"6": {flood: "tas_tps_flood_prone", bushfire: "tas_tps_bushfire_prone", licence: "CC-BY-3.0-AU"},
	"8": {flood: "act_flood_extent_1pct_aep", bushfire: "act_bpa_2026"},
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

// Licence is what the row's source_licence column records: CC BY 4.0, joined
// by the statutory layer's own licence when a share from one is present.
func (row HazardRow) Licence() string {
	source := hazardVectorSources[stateDigit(row.SALCode)]
	if source.licence == "" || (row.FloodSource() == "" && row.BushfireSource() == "") {
		return hazardsLicence
	}
	return hazardsLicence + "; " + source.licence
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
	// Checked per hazard, not per state: QLD and WA have a bushfire layer but
	// no open flood layer, and a flood share there would be stored with a
	// blank source.
	source := hazardVectorSources[stateDigit(row.SALCode)]
	if row.FloodPlanningSharePct != nil && source.flood == "" {
		return fmt.Errorf("flood share present for a state with no statutory flood source")
	}
	if row.BushfireProneSharePct != nil && source.bushfire == "" {
		return fmt.Errorf("bushfire share present for a state with no statutory bushfire source")
	}
	return nil
}

func ingestHazards() ([]HazardRow, error) { return loadHazards(hazardsPath()) }

// hazardCoverageSummary is "NSW 4542 709/4542, VIC …": rows, then how many
// carry a flood and a bushfire share, per state in ABS digit order.
func hazardCoverageSummary(rows []HazardRow) string {
	type counts struct{ rows, flood, fire int }
	byState := map[string]*counts{}
	for _, row := range rows {
		c := byState[stateDigit(row.SALCode)]
		if c == nil {
			c = &counts{}
			byState[stateDigit(row.SALCode)] = c
		}
		c.rows++
		if row.FloodPlanningSharePct != nil {
			c.flood++
		}
		if row.BushfireProneSharePct != nil {
			c.fire++
		}
	}
	names := []string{"", "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT", "OT"}
	parts := make([]string, 0, len(byState))
	for digit := 1; digit < len(names); digit++ {
		if c := byState[fmt.Sprint(digit)]; c != nil {
			parts = append(parts, fmt.Sprintf("%s %d %d/%d", names[digit], c.rows, c.flood, c.fire))
		}
	}
	return strings.Join(parts, ", ")
}
