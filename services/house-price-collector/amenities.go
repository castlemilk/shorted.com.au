package main

import (
	"os"
	"path/filepath"
	"strings"
)

// AmenityRow is one suburb's amenity metrics (UPSERT target on suburb_amenities).
// All metric fields are pointers so an absent JSON key binds to SQL NULL while an
// explicit 0 (a real computed count) is preserved. The join/derivation lives in
// the precompute script web/scripts/geo/join-amenities.mjs (added in W1); this
// just loads its committed output.
type AmenityRow struct {
	SALCode              string
	SchoolsTotal         *int     `json:"schoolsTotal"`
	SchoolsPrimary       *int     `json:"schoolsPrimary"`
	SchoolsSecondary     *int     `json:"schoolsSecondary"`
	SchoolsGov           *int     `json:"schoolsGov"`
	SchoolsCatholic      *int     `json:"schoolsCatholic"`
	SchoolsIndependent   *int     `json:"schoolsIndependent"`
	NearestSecondaryKm   *float64 `json:"nearestSecondaryKm"`
	SupermarketsTotal    *int     `json:"supermarketsTotal"`
	ColesCount           *int     `json:"colesCount"`
	WoolworthsCount      *int     `json:"woolworthsCount"`
	AldiCount            *int     `json:"aldiCount"`
	IgaCount             *int     `json:"igaCount"`
	NearestSupermarketKm *float64 `json:"nearestSupermarketKm"`
	PubsBars             *int     `json:"pubsBars"`
	Clubs                *int     `json:"clubs"`
	ParksCount           *int     `json:"parksCount"`
	GreenSpaceRatio      *float64 `json:"greenSpaceRatio"`
	LibrariesCount       *int     `json:"librariesCount"`
	NearestTrainKm       *float64 `json:"nearestTrainKm"`
	HospitalsCount       *int     `json:"hospitalsCount"`
	GpCount              *int     `json:"gpCount"`
	PharmacyCount        *int     `json:"pharmacyCount"`
	NearestHospitalKm    *float64 `json:"nearestHospitalKm"`
	DistToCoastKm        *float64 `json:"distToCoastKm"`
	GroceryAccessScore   *float64 `json:"groceryAccessScore"`
	AmenityDensityScore  *float64 `json:"amenityDensityScore"`
	WalkabilityScore     *float64 `json:"walkabilityScore"`
	FamilyFriendlyScore  *float64 `json:"familyFriendlyScore"`
}

// amenitiesPath resolves the committed join output (sibling of the suburb
// boundary dir), overridable via AMENITIES_FILE.
func amenitiesPath() string {
	if f := strings.TrimSpace(os.Getenv("AMENITIES_FILE")); f != "" {
		return f
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-amenities.json")
}

// loadAmenities reads a { salCode: {metrics} } map into rows.
func loadAmenities(path string) ([]AmenityRow, error) {
	raw := map[string]AmenityRow{}
	if err := readJSONFile(path, &raw); err != nil {
		return nil, err
	}
	rows := make([]AmenityRow, 0, len(raw))
	for sal, r := range raw {
		r.SALCode = sal
		rows = append(rows, r)
	}
	return rows, nil
}

// ingestAmenities loads the default committed amenities file.
func ingestAmenities() ([]AmenityRow, error) { return loadAmenities(amenitiesPath()) }
