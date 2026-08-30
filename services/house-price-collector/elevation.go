package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Geoscience Australia SRTM-derived 1 Second Digital Elevation Model Version
// 1.0 (DEM-S), © Commonwealth of Australia (Geoscience Australia), CC-BY-4.0.
// DEM-S elevations are orthometric metres relative to the EGM96 geoid; they
// are not AHD or ellipsoidal heights. The raster is obtained via ELVIS and
// processed offline by web/scripts/geo/ga_dem_zonal_stats.py.
const (
	elevationSource           = "ga_srtm_dem_s_1sec_v1_0"
	elevationLicence          = "CC-BY-4.0"
	elevationDatasetURL       = "https://elevation.fsdf.org.au/"
	minimumElevationCellCount = 25
)

// ElevationRow is one suburb's measured terrain statistics. Pointers preserve
// the critical distinction between absent/quality-gated data (nil -> SQL NULL)
// and a genuine computed zero. SampledCellCount is artifact provenance used by
// the quality gate and is not stored in suburb_demographics.
type ElevationRow struct {
	SALCode          string
	SampledCellCount int      `json:"sampledCellCount"`
	ElevationMinM    *float64 `json:"elevationMinM"`
	ElevationMedianM *float64 `json:"elevationMedianM"`
	ElevationMaxM    *float64 `json:"elevationMaxM"`
	LandShareBelow1M *float64 `json:"landShareBelow1m"`
	LandShareBelow2M *float64 `json:"landShareBelow2m"`
	LandShareBelow5M *float64 `json:"landShareBelow5m"`
}

func elevationPath() string {
	if path := strings.TrimSpace(os.Getenv("ELEVATION_FILE")); path != "" {
		return path
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-elevation.json")
}

func loadElevation(path string) ([]ElevationRow, error) {
	raw := map[string]ElevationRow{}
	if err := readJSONFile(path, &raw); err != nil {
		return nil, err
	}
	rows := make([]ElevationRow, 0, len(raw))
	for salCode, row := range raw {
		row.SALCode = strings.TrimSpace(salCode)
		if row.SALCode == "" {
			return nil, fmt.Errorf("elevation artifact contains a blank sal_code key")
		}
		if row.SampledCellCount < 0 {
			return nil, fmt.Errorf("elevation artifact SAL %s has negative sampledCellCount", row.SALCode)
		}
		if row.SampledCellCount < minimumElevationCellCount {
			row.clearMetrics()
		} else if err := row.validate(); err != nil {
			return nil, fmt.Errorf("elevation artifact SAL %s: %w", row.SALCode, err)
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].SALCode < rows[j].SALCode })
	return rows, nil
}

func (row *ElevationRow) clearMetrics() {
	row.ElevationMinM = nil
	row.ElevationMedianM = nil
	row.ElevationMaxM = nil
	row.LandShareBelow1M = nil
	row.LandShareBelow2M = nil
	row.LandShareBelow5M = nil
}

func (row ElevationRow) validate() error {
	shares := []struct {
		name  string
		value *float64
	}{
		{"landShareBelow1m", row.LandShareBelow1M},
		{"landShareBelow2m", row.LandShareBelow2M},
		{"landShareBelow5m", row.LandShareBelow5M},
	}
	for _, share := range shares {
		if share.value == nil {
			continue
		}
		if math.IsNaN(*share.value) || math.IsInf(*share.value, 0) || *share.value < 0 || *share.value > 100 {
			return fmt.Errorf("%s must be between 0 and 100", share.name)
		}
	}
	if row.ElevationMinM != nil && row.ElevationMedianM != nil && row.ElevationMaxM != nil &&
		(*row.ElevationMinM > *row.ElevationMedianM || *row.ElevationMedianM > *row.ElevationMaxM) {
		return fmt.Errorf("elevation values must satisfy min <= median <= max")
	}
	return nil
}

func ingestElevation() ([]ElevationRow, error) { return loadElevation(elevationPath()) }
