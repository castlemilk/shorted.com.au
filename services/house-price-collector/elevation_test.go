package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeElevationFixture(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "suburb-elevation.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func TestLoadElevationUsesSALCodeKeysAndPreservesNullVersusZero(t *testing.T) {
	path := writeElevationFixture(t, `{
		"10001": {
			"sampledCellCount": 250,
			"elevationMinM": 0,
			"elevationMedianM": 2.5,
			"elevationMaxM": 18.75,
			"landShareBelow1m": 0,
			"landShareBelow2m": null,
			"landShareBelow5m": 12.4
		}
	}`)

	rows, err := loadElevation(path)
	if err != nil {
		t.Fatalf("loadElevation: %v", err)
	}
	if len(rows) != 1 || rows[0].SALCode != "10001" {
		t.Fatalf("rows = %+v, want one row keyed by SAL 10001", rows)
	}
	row := rows[0]
	if row.ElevationMinM == nil || *row.ElevationMinM != 0 {
		t.Fatalf("explicit zero elevation must remain present, got %v", row.ElevationMinM)
	}
	if row.LandShareBelow1M == nil || *row.LandShareBelow1M != 0 {
		t.Fatalf("explicit zero share must remain present, got %v", row.LandShareBelow1M)
	}
	if row.LandShareBelow2M != nil {
		t.Fatalf("JSON null must remain absent, got %v", *row.LandShareBelow2M)
	}
}

func TestLoadElevationNullsMetricsBelowCellCountFloor(t *testing.T) {
	path := writeElevationFixture(t, `{
		"10002": {
			"sampledCellCount": 24,
			"elevationMinM": 0,
			"elevationMedianM": 1,
			"elevationMaxM": 2,
			"landShareBelow1m": 50,
			"landShareBelow2m": 100,
			"landShareBelow5m": 100
		}
	}`)

	rows, err := loadElevation(path)
	if err != nil {
		t.Fatalf("loadElevation: %v", err)
	}
	row := rows[0]
	if row.SampledCellCount != 24 {
		t.Fatalf("sampled cell count = %d, want 24", row.SampledCellCount)
	}
	if row.ElevationMinM != nil || row.ElevationMedianM != nil || row.ElevationMaxM != nil ||
		row.LandShareBelow1M != nil || row.LandShareBelow2M != nil || row.LandShareBelow5M != nil {
		t.Fatalf("metrics below the %d-cell floor must all be NULL: %+v", minimumElevationCellCount, row)
	}
}

func TestLoadElevationRejectsOutOfBoundsShares(t *testing.T) {
	path := writeElevationFixture(t, `{
		"10003": {"sampledCellCount": 25, "landShareBelow2m": 100.01}
	}`)

	_, err := loadElevation(path)
	if err == nil || !strings.Contains(err.Error(), "landShareBelow2m") {
		t.Fatalf("want share-bound error naming landShareBelow2m, got %v", err)
	}
}

func TestLoadElevationRejectsInconsistentElevationOrdering(t *testing.T) {
	path := writeElevationFixture(t, `{
		"10004": {
			"sampledCellCount": 25,
			"elevationMinM": 5,
			"elevationMedianM": 4,
			"elevationMaxM": 10
		}
	}`)

	_, err := loadElevation(path)
	if err == nil || !strings.Contains(err.Error(), "min <= median <= max") {
		t.Fatalf("want elevation-order error, got %v", err)
	}
}
