package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
)

// Per-suburb planning layer, computed offline by web/scripts/geo/planning/
// (planning_share.py) and loaded from services/house-price-collector/data/
// suburb-planning.json into suburb_planning (migration 000125).
//
// Sources, all open-licensed (see docs/feature/housing/data-sources.md):
//   - zoning: NSW EPI Land Zoning (CC BY, unversioned as data.nsw publishes it), Vicmap Planning plan_zone
//     (CC BY 4.0), SA Planning and Design Code zones (CC BY), Tasmanian
//     Planning Scheme zones + Kingborough interim scheme (CC BY 3.0 AU), ACT
//     Territory Plan land use zones (CC BY 4.0). QLD has no statewide scheme,
//     WA's is licence-blocked, NT has no open layer — those stay NULL.
//   - heritage: NSW EPI Heritage, VIC Heritage Overlay, SA Code heritage and
//     character overlays, TAS Local Historic Heritage Code, ACT Heritage
//     Register (filtered), QLD Heritage Register (item count only).
//   - NSW development standards: EPI Height of Buildings, Floor Space Ratio,
//     Minimum Lot Size (CC BY).
//
// NULL means "no source covers this suburb"; a measured 0 is stored as 0.

const (
	planningCursor  = "suburb_planning"
	planningLicence = "CC-BY-4.0"

	// planningMinCoveragePct: below this zoning coverage (% of the suburb) the
	// suburb is mostly planned by an instrument the scheme layers do not carry
	// (The Rocks: 2.9% in the Sydney LEP), so only the coverage itself is a
	// measurement — no family shares, dominant family or heritage.
	// planningControlMinMappedPct: a NSW development standard is reported only
	// where the LEP maps it on at least this share of the suburb's residential
	// land (Castle Hill's FSR is mapped on 4.9% of it — the centre's number).
	// Both mirror planning_share.py (MIN_MEASURED_COVERAGE_PCT,
	// CONTROL_MIN_MAPPED_PCT) and migration 000125's measured CHECK;
	// TestPlanningGatesMatchTheBuild holds the three together.
	planningMinCoveragePct      = 50.0
	planningControlMinMappedPct = 50.0
)

// The embedded copy is the default so the mode works inside the collector
// image (a repo-relative path would not exist there — the way -mode census ran
// its whole life failing in Cloud Run). PLANNING_FILE overrides it.
//
//go:embed data/suburb-planning.json
var embeddedPlanning []byte

// zoneFamilies is the harmonised set (program decision 8), in the order the
// offline build resolves overlaps. It must match
// web/scripts/geo/planning/zone_families.py FAMILIES and the migration CHECK.
var zoneFamilies = []string{
	"res_low", "res_medium_high", "centre_mixed", "industrial", "rural",
	"conservation", "open_space", "infrastructure", "water", "other",
}

// planningSources names which states have a zoning, heritage and development-
// control source, keyed by the SAL code's leading state digit. A value for a
// state not listed here is a build bug, and validate() refuses it.
var planningSources = map[string]struct {
	zoning, heritage, controls bool
}{
	"1": {zoning: true, heritage: true, controls: true}, // NSW
	"2": {zoning: true, heritage: true},                 // VIC
	"3": {heritage: true},                               // QLD: register only
	"4": {zoning: true, heritage: true},                 // SA
	"6": {zoning: true, heritage: true},                 // TAS
	"8": {zoning: true, heritage: true},                 // ACT
}

// PlanningRow is one suburb's planning layer. Pointers keep absent (nil ->
// SQL NULL) distinct from a computed zero.
type PlanningRow struct {
	SALCode                string             `json:"-"`
	ZoneSharesPct          map[string]float64 `json:"zoneSharesPct"`
	ZoningCoveragePct      *float64           `json:"zoningCoveragePct"`
	DominantZoneFamily     *string            `json:"dominantZoneFamily"`
	HeritageSharePct       *float64           `json:"heritageSharePct"`
	HeritageItemCount      *int               `json:"heritageItemCount"`
	NSWHeightMedianM       *float64           `json:"nswHeightMedianM"`
	NSWHeightMaxM          *float64           `json:"nswHeightMaxM"`
	NSWFSRMedian           *float64           `json:"nswFsrMedian"`
	NSWMinLotMedianM2      *float64           `json:"nswMinLotMedianM2"`
	NSWHeightMappedPct     *float64           `json:"nswHeightMappedPct"`
	NSWFSRMappedPct        *float64           `json:"nswFsrMappedPct"`
	NSWMinLotMappedPct     *float64           `json:"nswMinLotMappedPct"`
	NSWResidentialSharePct *float64           `json:"nswResidentialSharePct"`
	PlanningInstruments    []string           `json:"planningInstruments"`
	ZoningSource           string             `json:"zoningSource"`
	HeritageSource         string             `json:"heritageSource"`
	Licence                string             `json:"licence"`
}

// FamilyShare returns the stored value for one family column: NULL when the
// suburb's zoning was not measured (a state with no source, or coverage under
// planningMinCoveragePct — the build then writes no shares at all), else the
// measured share with an absent family meaning a genuine 0.
func (row PlanningRow) FamilyShare(family string) *float64 {
	if len(row.ZoneSharesPct) == 0 {
		return nil
	}
	v := row.ZoneSharesPct[family]
	return &v
}

func planningFile() string {
	return strings.TrimSpace(os.Getenv("PLANNING_FILE"))
}

func loadPlanning(path string) ([]PlanningRow, error) {
	var raw []byte
	var err error
	if path == "" {
		raw = embeddedPlanning
	} else if raw, err = os.ReadFile(path); err != nil {
		return nil, fmt.Errorf("planning artifact: %w", err)
	}
	return parsePlanning(raw)
}

func parsePlanning(raw []byte) ([]PlanningRow, error) {
	byCode := map[string]PlanningRow{}
	if err := json.Unmarshal(raw, &byCode); err != nil {
		return nil, fmt.Errorf("planning artifact: %w", err)
	}
	if len(byCode) == 0 {
		return nil, fmt.Errorf("planning artifact is empty")
	}
	rows := make([]PlanningRow, 0, len(byCode))
	for salCode, row := range byCode {
		row.SALCode = strings.TrimSpace(salCode)
		if row.SALCode == "" {
			return nil, fmt.Errorf("planning artifact contains a blank sal_code key")
		}
		if err := row.validate(); err != nil {
			return nil, fmt.Errorf("planning artifact SAL %s: %w", row.SALCode, err)
		}
		if row.Licence == "" {
			row.Licence = planningLicence
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].SALCode < rows[j].SALCode })
	return rows, nil
}

func validShare(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 100
}

func (row PlanningRow) validate() error {
	src, known := planningSources[stateDigit(row.SALCode)]
	if !known {
		return fmt.Errorf("state %q has no planning source; it must have no row", stateDigit(row.SALCode))
	}
	if row.Licence == "proprietary-tos-restricted" {
		return fmt.Errorf("licence %q is not publishable", row.Licence)
	}

	hasZoning := row.ZoningCoveragePct != nil || len(row.ZoneSharesPct) > 0 || row.DominantZoneFamily != nil
	if hasZoning && !src.zoning {
		return fmt.Errorf("zoning present for a state with no zoning source")
	}
	if row.ZoningCoveragePct != nil && !validShare(*row.ZoningCoveragePct) {
		return fmt.Errorf("zoningCoveragePct must be between 0 and 100")
	}
	sum := 0.0
	for family, share := range row.ZoneSharesPct {
		if !isZoneFamily(family) {
			return fmt.Errorf("unknown zone family %q", family)
		}
		if !validShare(share) {
			return fmt.Errorf("zone share %s must be between 0 and 100", family)
		}
		sum += share
	}
	measured := row.ZoningCoveragePct != nil && *row.ZoningCoveragePct >= planningMinCoveragePct
	if len(row.ZoneSharesPct) > 0 {
		if row.ZoningCoveragePct == nil {
			return fmt.Errorf("zone shares without zoningCoveragePct")
		}
		if !measured {
			return fmt.Errorf("zone shares for a suburb the scheme covers for only %.4f%% (under %.0f%%)",
				*row.ZoningCoveragePct, planningMinCoveragePct)
		}
		// Families are resolved disjointly, so they sum to the coverage; 0.01
		// points absorbs the per-family 4-dp rounding.
		if math.Abs(sum-*row.ZoningCoveragePct) > 0.01 {
			return fmt.Errorf("zone shares sum to %.4f but coverage is %.4f", sum, *row.ZoningCoveragePct)
		}
	}
	if measured && len(row.ZoneSharesPct) == 0 {
		return fmt.Errorf("zoningCoveragePct %.4f without zone shares", *row.ZoningCoveragePct)
	}
	if row.DominantZoneFamily != nil {
		if !isZoneFamily(*row.DominantZoneFamily) {
			return fmt.Errorf("unknown dominant zone family %q", *row.DominantZoneFamily)
		}
		if row.ZoneSharesPct[*row.DominantZoneFamily] <= 0 {
			return fmt.Errorf("dominant family %q has no share", *row.DominantZoneFamily)
		}
	}

	hasHeritage := row.HeritageSharePct != nil || row.HeritageItemCount != nil
	if hasHeritage && !src.heritage {
		return fmt.Errorf("heritage present for a state with no heritage source")
	}
	if row.HeritageSharePct != nil && !validShare(*row.HeritageSharePct) {
		return fmt.Errorf("heritageSharePct must be between 0 and 100")
	}
	if row.HeritageItemCount != nil && *row.HeritageItemCount < 0 {
		return fmt.Errorf("heritageItemCount must not be negative")
	}
	// In a state with a zoning source, heritage is only measured where the
	// scheme layers cover most of the suburb: over the rest, "no heritage"
	// would be a reading of land no carried instrument maps.
	if hasHeritage && src.zoning && !measured {
		return fmt.Errorf("heritage measured over a suburb the scheme covers for under %.0f%%", planningMinCoveragePct)
	}

	for _, m := range []struct {
		name  string
		value *float64
	}{
		{"nswHeightMappedPct", row.NSWHeightMappedPct},
		{"nswFsrMappedPct", row.NSWFSRMappedPct},
		{"nswMinLotMappedPct", row.NSWMinLotMappedPct},
	} {
		if m.value == nil {
			continue
		}
		if !src.controls {
			return fmt.Errorf("%s present for a state with no development-control source", m.name)
		}
		if !validShare(*m.value) {
			return fmt.Errorf("%s must be between 0 and 100", m.name)
		}
	}
	controls := []struct {
		name   string
		value  *float64
		mapped *float64
	}{
		{"nswHeightMedianM", row.NSWHeightMedianM, row.NSWHeightMappedPct},
		{"nswHeightMaxM", row.NSWHeightMaxM, row.NSWHeightMappedPct},
		{"nswFsrMedian", row.NSWFSRMedian, row.NSWFSRMappedPct},
		{"nswMinLotMedianM2", row.NSWMinLotMedianM2, row.NSWMinLotMappedPct},
	}
	for _, c := range controls {
		if c.value == nil {
			continue
		}
		if !src.controls {
			return fmt.Errorf("%s present for a state with no development-control source", c.name)
		}
		if math.IsNaN(*c.value) || math.IsInf(*c.value, 0) || *c.value <= 0 {
			return fmt.Errorf("%s must be positive", c.name)
		}
		// A standard mapped on a sliver of the residential land describes the
		// sliver (usually the centre), not the suburb.
		if c.mapped == nil || *c.mapped < planningControlMinMappedPct {
			return fmt.Errorf("%s reported but the standard is mapped on under %.0f%% of residential land",
				c.name, planningControlMinMappedPct)
		}
	}
	if row.NSWHeightMedianM != nil && row.NSWHeightMaxM != nil && *row.NSWHeightMedianM > *row.NSWHeightMaxM {
		return fmt.Errorf("nswHeightMedianM exceeds nswHeightMaxM")
	}
	return nil
}

func isZoneFamily(family string) bool {
	for _, f := range zoneFamilies {
		if f == family {
			return true
		}
	}
	return false
}

func ingestPlanning() ([]PlanningRow, error) {
	return loadPlanning(planningFile())
}
