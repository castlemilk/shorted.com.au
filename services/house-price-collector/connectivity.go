package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Per-suburb NBN access technology, from the centroid→footprint join
// (web/scripts/geo/join-nbn.mjs). NBN Coverage Footprints 2024, CC-BY-4.0.
// Area-level context only (never an address-level availability promise).

// ConnectivityRow is one suburb's dominant NBN tech + quality proxy.
type ConnectivityRow struct {
	SALCode string
	Tech    string
	Score   *float64
}

func connectivityFile() string {
	if f := strings.TrimSpace(os.Getenv("CONNECTIVITY_FILE")); f != "" {
		return f
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-nbn.json")
}

// ingestConnectivity loads { salCode: { tech, score } }.
func ingestConnectivity() ([]ConnectivityRow, error) {
	raw := map[string]struct {
		Tech  string   `json:"tech"`
		Score *float64 `json:"score"`
	}{}
	if err := readJSONFile(connectivityFile(), &raw); err != nil {
		return nil, err
	}
	rows := make([]ConnectivityRow, 0, len(raw))
	for sal, v := range raw {
		rows = append(rows, ConnectivityRow{SALCode: sal, Tech: v.Tech, Score: v.Score})
	}
	return rows, nil
}
