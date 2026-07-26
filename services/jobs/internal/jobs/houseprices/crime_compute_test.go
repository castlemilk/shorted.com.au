package houseprices

import (
	"math"
	"testing"
)

func crimeApprox(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.4f, want %.4f (±%.4f)", name, got, want, tol)
	}
}

// newTestERP builds an ERPTable with fixed census pops + a flat (index 1.0)
// state ERP series unless overridden.
func newTestERP(salPop map[string]int, salState map[string]string, stateERP map[string]map[int]float64) *ERPTable {
	t := &ERPTable{salPop: salPop, salState: salState, baseYear: 2021}
	t.setStateERP(stateERP)
	return t
}

// Hand-worked end-to-end example (see comments for the arithmetic).
//
//	NSW break_ins FY2025: raw A=10, B=20, C=0 (Σ=30)
//	CVS rate 3.0% of 1,000,000 households → victims 30,000 → scale 1000
//	adjusted A=10,000 B=20,000 C=0
//	ERP A=5,000 B=20,000 C=4,000
//	rate/100k A=200,000 B=100,000 C=0
//	P=29,000; pct_rank C=6.897 B=48.276 A=91.379
func TestComputeCrime_VictimEstimate(t *testing.T) {
	jd := &jurisdictionData{
		jurisdiction: "NSW", source: "bocsar", licence: "CC-BY",
		rows: []crimeRaw{
			{salCode: "A", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 10},
			{salCode: "B", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 20},
			{salCode: "C", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 0},
		},
	}
	cvs := &CVSData{
		Rate: map[string]map[crimeType]map[int]cvsCell{
			"NSW": {crimeBreakIns: {2025: {rate: 3.0, reportingRate: 50.0, hasRate: true}}},
		},
		StateBase: map[string]cvsStateBase{"NSW": {households: 1_000_000, persons15: 800_000}},
		BaseFY:    2025,
	}
	erp := newTestERP(
		map[string]int{"A": 5000, "B": 20000, "C": 4000},
		map[string]string{"A": "NSW", "B": "NSW", "C": "NSW"},
		map[string]map[int]float64{"NSW": {2021: 100, 2025: 100}},
	)

	rows, stats := computeCrime([]*jurisdictionData{jd}, cvs, erp, scalerVictimEstimate)
	if stats.SingleRows != 3 || stats.PooledRows != 0 || stats.StateScales != 1 {
		t.Fatalf("stats = %+v, want 3 single / 0 pooled / 1 scale", stats)
	}

	byKey := map[string]CrimeStatRow{}
	for _, r := range rows {
		if !r.Pooled {
			byKey[r.SalCode] = r
		}
	}
	a, b, c := byKey["A"], byKey["B"], byKey["C"]

	crimeApprox(t, "A.scale", a.ScaleFactor, 1000, 1e-6)
	crimeApprox(t, "A.adjusted", a.AdjustedCount, 10000, 1e-6)
	crimeApprox(t, "A.rate", a.RatePer100k, 200000, 1e-3)
	crimeApprox(t, "B.rate", b.RatePer100k, 100000, 1e-3)
	crimeApprox(t, "C.rate", c.RatePer100k, 0, 1e-9)
	crimeApprox(t, "A.rank", a.PctRank, 91.3793, 1e-3)
	crimeApprox(t, "B.rank", b.PctRank, 48.2759, 1e-3)
	crimeApprox(t, "C.rank", c.PctRank, 6.8966, 1e-3)
	if a.Population != 5000 || a.SmallPop {
		t.Errorf("A pop/small = %d/%v, want 5000/false", a.Population, a.SmallPop)
	}
	if a.Jurisdiction != "NSW" || a.Source != "bocsar" || a.SourceLicence != "CC-BY" {
		t.Errorf("A source metadata = %q/%q/%q", a.Jurisdiction, a.Source, a.SourceLicence)
	}
}

// reporting_rate mode: scale = 100/reporting_rate = 100/50 = 2. Rate ordering
// (hence the ranks) is unchanged from victim_estimate; only magnitudes differ.
func TestComputeCrime_ReportingRate(t *testing.T) {
	jd := &jurisdictionData{
		jurisdiction: "NSW", source: "bocsar", licence: "CC-BY",
		rows: []crimeRaw{
			{salCode: "A", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 10},
			{salCode: "B", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 20},
			{salCode: "C", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 0},
		},
	}
	cvs := &CVSData{
		Rate: map[string]map[crimeType]map[int]cvsCell{
			"NSW": {crimeBreakIns: {2025: {rate: 3.0, reportingRate: 50.0, hasRate: true}}},
		},
		StateBase: map[string]cvsStateBase{"NSW": {households: 1_000_000}},
		BaseFY:    2025,
	}
	erp := newTestERP(
		map[string]int{"A": 5000, "B": 20000, "C": 4000},
		map[string]string{"A": "NSW", "B": "NSW", "C": "NSW"},
		map[string]map[int]float64{"NSW": {2021: 100, 2025: 100}},
	)

	rows, _ := computeCrime([]*jurisdictionData{jd}, cvs, erp, scalerReportingRate)
	byKey := map[string]CrimeStatRow{}
	for _, r := range rows {
		if !r.Pooled {
			byKey[r.SalCode] = r
		}
	}
	crimeApprox(t, "A.scale", byKey["A"].ScaleFactor, 2.0, 1e-9)
	crimeApprox(t, "A.adjusted", byKey["A"].AdjustedCount, 20, 1e-9)
	crimeApprox(t, "A.rate", byKey["A"].RatePer100k, 400, 1e-6) // 20/5000*1e5
	crimeApprox(t, "B.rate", byKey["B"].RatePer100k, 200, 1e-6) // 40/20000*1e5
	crimeApprox(t, "A.rank", byKey["A"].PctRank, 91.3793, 1e-3) // ordering unchanged
	crimeApprox(t, "C.rank", byKey["C"].PctRank, 6.8966, 1e-3)
}

// Pooled series: two FYs → one pooled row per suburb, averaging adjusted counts.
func TestComputeCrime_Pooled(t *testing.T) {
	jd := &jurisdictionData{
		jurisdiction: "NSW", source: "bocsar", licence: "CC-BY",
		rows: []crimeRaw{
			{salCode: "A", state: "NSW", crimeType: crimeBreakIns, fy: 2024, count: 20},
			{salCode: "A", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 10},
		},
	}
	cvs := &CVSData{
		Rate: map[string]map[crimeType]map[int]cvsCell{
			"NSW": {crimeBreakIns: {
				2024: {rate: 3.0, hasRate: true},
				2025: {rate: 3.0, hasRate: true},
			}},
		},
		StateBase: map[string]cvsStateBase{"NSW": {households: 1_000_000}},
		BaseFY:    2025,
	}
	// scale(2024) = 0.03*1e6 / 20 = 1500 ; adjusted A2024 = 30,000
	// scale(2025) = 0.03*1e6 / 10 = 3000 ; adjusted A2025 = 30,000
	// pooled adjusted = 30,000 ; rate = 30000/5000*1e5 = 600,000
	erp := newTestERP(
		map[string]int{"A": 5000},
		map[string]string{"A": "NSW"},
		map[string]map[int]float64{"NSW": {2021: 100, 2024: 100, 2025: 100}},
	)
	rows, stats := computeCrime([]*jurisdictionData{jd}, cvs, erp, scalerVictimEstimate)
	if stats.PooledRows != 1 {
		t.Fatalf("pooled rows = %d, want 1", stats.PooledRows)
	}
	var pooled *CrimeStatRow
	for i := range rows {
		if rows[i].Pooled {
			pooled = &rows[i]
		}
	}
	if pooled == nil {
		t.Fatal("no pooled row emitted")
	}
	if pooled.FYEnding != 2025 {
		t.Errorf("pooled FY = %d, want 2025", pooled.FYEnding)
	}
	crimeApprox(t, "pooled.adjusted", pooled.AdjustedCount, 30000, 1e-6)
	crimeApprox(t, "pooled.rate", pooled.RatePer100k, 600000, 1e-3)
	crimeApprox(t, "pooled.rank", pooled.PctRank, 50.0, 1e-6) // only member of its group
}

func TestPopWeightedPercentile_HandWorked(t *testing.T) {
	pts := []rankPoint{{rate: 0, pop: 4000}, {rate: 100000, pop: 20000}, {rate: 200000, pop: 5000}}
	got := popWeightedPercentile(pts)
	crimeApprox(t, "C", got[0], 6.8966, 1e-3)
	crimeApprox(t, "B", got[1], 48.2759, 1e-3)
	crimeApprox(t, "A", got[2], 91.3793, 1e-3)
}

func TestPopWeightedPercentile_Ties(t *testing.T) {
	// Two tied points at rate 5, one at rate 10. P=40.
	// tied: (0 + 0.5*10)/40*100 = 12.5 each ; top: (20 + 0.5*20)/40*100 = 75.
	pts := []rankPoint{{rate: 5, pop: 10}, {rate: 5, pop: 10}, {rate: 10, pop: 20}}
	got := popWeightedPercentile(pts)
	crimeApprox(t, "tie0", got[0], 12.5, 1e-6)
	crimeApprox(t, "tie1", got[1], 12.5, 1e-6)
	crimeApprox(t, "top", got[2], 75.0, 1e-6)
}

func TestPopWeightedPercentile_ZeroTotal(t *testing.T) {
	got := popWeightedPercentile([]rankPoint{{rate: 5, pop: 0}, {rate: 9, pop: 0}})
	for i, v := range got {
		if v != 0 {
			t.Errorf("zero-weight point %d rank = %v, want 0", i, v)
		}
	}
}

// cvsStateBaseFor ages the latest CVS base to a historical FY by state ERP growth.
func TestCVSStateBaseFor_GrowthIndexed(t *testing.T) {
	cvs := &CVSData{
		StateBase: map[string]cvsStateBase{"NSW": {households: 1000, persons15: 2000}},
		BaseFY:    2024,
	}
	erp := newTestERP(nil, nil, map[string]map[int]float64{"NSW": {2021: 100, 2024: 110, 2025: 121}})
	// break_ins → households base; base(2025) = 1000 * (121/100)/(110/100) = 1100
	crimeApprox(t, "base2025", cvsStateBaseFor(cvs, erp, "NSW", crimeBreakIns, 2025), 1100, 1e-6)
	// at the base FY it is exactly the latest base
	crimeApprox(t, "base2024", cvsStateBaseFor(cvs, erp, "NSW", crimeBreakIns, 2024), 1000, 1e-6)
	// violent → persons15 base
	crimeApprox(t, "violent2024", cvsStateBaseFor(cvs, erp, "NSW", crimeViolent, 2024), 2000, 1e-6)
}
