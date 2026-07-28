package houseprices

import "testing"

func TestIngestAmenitiesFromFile(t *testing.T) {
	rows, err := loadAmenities("testdata/suburb-amenities.sample.json")
	if err != nil {
		t.Fatalf("loadAmenities: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	by := map[string]AmenityRow{}
	for _, r := range rows {
		by[r.SALCode] = r
	}
	a := by["10001"]
	if a.SchoolsTotal == nil || *a.SchoolsTotal != 3 {
		t.Errorf("10001 schoolsTotal want 3, got %v", a.SchoolsTotal)
	}
	if a.NearestTrainKm == nil || *a.NearestTrainKm != 0.8 {
		t.Errorf("10001 nearestTrainKm want 0.8, got %v", a.NearestTrainKm)
	}
	// A suburb present with an explicit 0 keeps 0 (not nil) — count was computed.
	b := by["10002"]
	if b.SchoolsTotal == nil || *b.SchoolsTotal != 0 {
		t.Errorf("10002 schoolsTotal want 0, got %v", b.SchoolsTotal)
	}
	// Unspecified fields stay nil → NULL (not present in the source object).
	if b.ColesCount != nil {
		t.Errorf("10002 colesCount want nil, got %v", *b.ColesCount)
	}
}
