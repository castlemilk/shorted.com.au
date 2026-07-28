package houseprices

import (
	"context"
	"os"
	"testing"
)

// TestCrimeRealData_CVS verifies the CVS parser against the real ABS workbooks.
// Gated on CVS_XLSX_PATH + CVS_POP_XLSX_PATH so it no-ops in CI. Run:
//
//	CVS_XLSX_PATH=/path/cvs_pooled.xlsx CVS_POP_XLSX_PATH=/path/cvs_pop.xlsx \
//	  go test -run TestCrimeRealData_CVS -v ./house-price-collector/
func TestCrimeRealData_CVS(t *testing.T) {
	pooledPath := os.Getenv("CVS_XLSX_PATH")
	popPath := os.Getenv("CVS_POP_XLSX_PATH")
	if pooledPath == "" || popPath == "" {
		t.Skip("set CVS_XLSX_PATH + CVS_POP_XLSX_PATH to run against real ABS files")
	}
	pooled, err := os.ReadFile(pooledPath)
	if err != nil {
		t.Fatal(err)
	}
	pop, err := os.ReadFile(popPath)
	if err != nil {
		t.Fatal(err)
	}
	data, err := parseCVS(pooled, pop)
	if err != nil {
		t.Fatalf("parseCVS(real): %v", err)
	}
	t.Logf("CVS: %d states, BaseFY=%d", len(data.Rate), data.BaseFY)
	for _, st := range []string{"NSW", "VIC", "QLD"} {
		for _, ct := range coreCrimeTypes {
			var latest int
			for fy := range data.Rate[st][ct] {
				if fy > latest {
					latest = fy
				}
			}
			c := data.Rate[st][ct][latest]
			t.Logf("  %s/%s latestFY=%d rate=%.2f rse=%.1f reporting=%.1f", st, ct, latest, c.rate, c.rse, c.reportingRate)
		}
		t.Logf("  %s base: persons15=%.0f households=%.0f", st, data.StateBase[st].persons15, data.StateBase[st].households)
	}
	// Sanity: NSW must carry all 4 core types at the latest FY.
	for _, ct := range coreCrimeTypes {
		found := false
		for _, c := range data.Rate["NSW"][ct] {
			if c.hasRate {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("NSW %s carries no rate", ct)
		}
	}
}

// TestCrimeRealData_NSW verifies the BOCSAR melt against the real ZIP + the
// committed SAL registry. Gated on NSW_CRIME_ZIP + CENSUS_GEO_DIR.
func TestCrimeRealData_NSW(t *testing.T) {
	if os.Getenv("NSW_CRIME_ZIP") == "" {
		t.Skip("set NSW_CRIME_ZIP (+ optional CENSUS_GEO_DIR) to run against the real BOCSAR file")
	}
	// Build a name→SAL registry from the committed boundary TopoJSON.
	reg, err := readSuburbRegistry(censusGeoDir())
	if err != nil {
		t.Fatalf("read registry: %v", err)
	}
	nameToSal := map[string]string{}
	for code, id := range reg {
		if id.stateCode == "NSW" {
			nameToSal[normCrimeSuburb(id.salName)] = code
		}
	}
	t.Logf("NSW registry: %d suburbs", len(nameToSal))

	jd, err := fetchNSW(context.Background(), nameToSal)
	if err != nil {
		t.Fatalf("fetchNSW(real): %v", err)
	}
	t.Logf("NSW melt: matched=%d unmatched=%d matchRate=%.2f%% rows=%d",
		jd.matched, jd.unmatched, jd.matchRate()*100, len(jd.rows))
	if len(jd.unmatchedSample) > 0 {
		t.Logf("  unmatched sample: %v", jd.unmatchedSample)
	}
	if jd.matchRate() < 0.98 {
		t.Errorf("NSW match rate %.2f%% below 98%% plan target", jd.matchRate()*100)
	}
	// Latest complete FY should carry non-trivial break-in volume statewide.
	var latest int
	for _, r := range jd.rows {
		if r.fy > latest {
			latest = r.fy
		}
	}
	var total float64
	for _, r := range jd.rows {
		if r.fy == latest && r.crimeType == crimeBreakIns {
			total += r.count
		}
	}
	t.Logf("  latest complete FY=%d statewide break_ins=%.0f", latest, total)
	if total <= 0 {
		t.Errorf("no break_ins volume in latest FY")
	}
}
