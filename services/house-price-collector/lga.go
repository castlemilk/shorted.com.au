package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Local Government Area dimension + suburb→LGA bridge, from the precomputed
// point-in-polygon join (web/scripts/geo/join-lga.mjs). ABS ASGS LGA_2024,
// CC-BY-4.0. This loads the committed derived JSON and upserts lga + suburb_lga.

// LGARow is one council (UPSERT target on lga).
type LGARow struct {
	Code      string
	Name      string
	StateCode string
	AreaSqkm  *float64
}

// SuburbLGARow bridges a suburb to its dominant council.
type SuburbLGARow struct {
	SALCode string
	LGACode string
}

func lgaFile(name string) string {
	if d := strings.TrimSpace(os.Getenv("LGA_DIR")); d != "" {
		return filepath.Join(d, name)
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", name)
}

// ingestLGA loads the LGA facts + suburb→LGA bridge from the committed JSON.
func ingestLGA() ([]LGARow, []SuburbLGARow, error) {
	raw := map[string]struct {
		Name     string   `json:"name"`
		State    string   `json:"state"`
		AreaSqkm *float64 `json:"areaSqkm"`
	}{}
	if err := readJSONFile(lgaFile("lga-facts.json"), &raw); err != nil {
		return nil, nil, err
	}
	lgas := make([]LGARow, 0, len(raw))
	for code, f := range raw {
		lgas = append(lgas, LGARow{Code: code, Name: f.Name, StateCode: absStateToCode[f.State], AreaSqkm: f.AreaSqkm})
	}
	bridge := map[string]string{}
	if err := readJSONFile(lgaFile("suburb-lga.json"), &bridge); err != nil {
		return nil, nil, err
	}
	subs := make([]SuburbLGARow, 0, len(bridge))
	for sal, code := range bridge {
		subs = append(subs, SuburbLGARow{SALCode: sal, LGACode: code})
	}
	return lgas, subs, nil
}
