package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Per-suburb NBN access technology, from the centroid→footprint join
// (web/scripts/geo/join-nbn.mjs). NBN Coverage Footprints 2024, CC-BY-4.0.
// Area-level context only (never an address-level availability promise).

// ConnectivityRow is one suburb's dominant NBN tech + quality proxy. A nil
// Tech means no NBN footprint covers the suburb's sample points: the join no
// longer guesses 'Satellite' for a miss, so it is stored as NULL ("no source
// covers this"), never as an empty string or a tier.
type ConnectivityRow struct {
	SALCode string
	Tech    *string
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
		Tech  *string  `json:"tech"`
		Score *float64 `json:"score"`
	}{}
	if err := readJSONFile(connectivityFile(), &raw); err != nil {
		return nil, err
	}
	rows := make([]ConnectivityRow, 0, len(raw))
	for sal, v := range raw {
		tech, score := v.Tech, v.Score
		if tech != nil && strings.TrimSpace(*tech) == "" {
			tech = nil
		}
		if tech == nil {
			score = nil // a quality proxy for an unknown technology is meaningless
		}
		rows = append(rows, ConnectivityRow{SALCode: sal, Tech: tech, Score: score})
	}
	return rows, nil
}
