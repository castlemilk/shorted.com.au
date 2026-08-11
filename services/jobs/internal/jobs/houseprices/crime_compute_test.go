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


// Two jurisdictions whose offence rates are genuinely incomparable: after CVS
// scaling, BOTH VIC suburbs sit above BOTH NSW suburbs (VIC's victimisation
// anchor is 10x NSW's, so its scaled rates are an order of magnitude higher).
//
//	NSW break_ins FY2025: raw 1 / 4, Σ=5, CVS 3% x 1,000,000 households
//	                      → 30,000 victims → scale 6,000
//	                      → adjusted 6,000 / 24,000 → rate/100k 60,000 / 240,000
//	VIC break_ins FY2025: raw 100 / 400, Σ=500, CVS 30% x 1,000,000 households
//	                      → 300,000 victims → scale 600
//	                      → adjusted 60,000 / 240,000 → rate/100k 600,000 / 2,400,000
//
// Pooled nationally (equal 10,000 ERP each, Σpop 40,000) the four suburbs form
// ONE ladder — 12.5 / 37.5 / 62.5 / 87.5 — and NSW's WORST suburb (37.5) lands
// below VIC's BEST (62.5). A reader of the NSW suburb page would be told its
// break-in rate is unremarkable when it is the worst in its state, purely
// because another state's police count offences differently.
//
// Scoped per jurisdiction, each state gets its own ladder: 25 / 75 in both.
//
// This is the regression guard for that scoping. It fails under national pooling.
func TestComputeCrime_RanksAreScopedPerJurisdiction(t *testing.T) {
	nsw := &jurisdictionData{
		jurisdiction: "NSW", source: "bocsar", licence: "CC-BY",
		rows: []crimeRaw{
			{salCode: "N_LOW", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 1},
			{salCode: "N_HIGH", state: "NSW", crimeType: crimeBreakIns, fy: 2025, count: 4},
		},
	}
	vic := &jurisdictionData{
		jurisdiction: "VIC", source: "csa", licence: "CC-BY-4.0",
		rows: []crimeRaw{
			{salCode: "V_LOW", state: "VIC", crimeType: crimeBreakIns, fy: 2025, count: 100},
			{salCode: "V_HIGH", state: "VIC", crimeType: crimeBreakIns, fy: 2025, count: 400},
		},
	}
	cvs := &CVSData{
		Rate: map[string]map[crimeType]map[int]cvsCell{
			"NSW": {crimeBreakIns: {2025: {rate: 3.0, reportingRate: 50.0, hasRate: true}}},
			"VIC": {crimeBreakIns: {2025: {rate: 30.0, reportingRate: 50.0, hasRate: true}}},
		},
		StateBase: map[string]cvsStateBase{
			"NSW": {households: 1_000_000, persons15: 800_000},
			"VIC": {households: 1_000_000, persons15: 800_000},
		},
		BaseFY: 2025,
	}
	// Equal populations everywhere, so population weighting cannot explain any
	// rank difference — only the pooling scope can.
	erp := newTestERP(
		map[string]int{"N_LOW": 10000, "N_HIGH": 10000, "V_LOW": 10000, "V_HIGH": 10000},
		map[string]string{"N_LOW": "NSW", "N_HIGH": "NSW", "V_LOW": "VIC", "V_HIGH": "VIC"},
		map[string]map[int]float64{"NSW": {2021: 100, 2025: 100}, "VIC": {2021: 100, 2025: 100}},
	)

	rows, _ := computeCrime([]*jurisdictionData{nsw, vic}, cvs, erp, scalerVictimEstimate)
	rank, rate := map[string]float64{}, map[string]float64{}
	for _, r := range rows {
		if !r.Pooled {
			rank[r.SalCode] = r.PctRank
			rate[r.SalCode] = r.RatePer100k
		}
	}
	if len(rank) != 4 {
		t.Fatalf("want 4 single-FY rows, got %d: %v", len(rank), rank)
	}

	// Precondition: the fixture really is incomparable — VIC's BEST suburb has a
	// higher scaled rate than NSW's WORST. Without this the test proves nothing.
	if rate["V_LOW"] <= rate["N_HIGH"] {
		t.Fatalf("fixture broken: V_LOW rate %.0f must exceed N_HIGH rate %.0f",
			rate["V_LOW"], rate["N_HIGH"])
	}

	// Each state gets its own 0..100 ladder, so the low/high suburb of EACH
	// state lands on the same pair of ranks.
	crimeApprox(t, "N_LOW.rank", rank["N_LOW"], 25, 1e-6)
	crimeApprox(t, "N_HIGH.rank", rank["N_HIGH"], 75, 1e-6)
	crimeApprox(t, "V_LOW.rank", rank["V_LOW"], 25, 1e-6)
	crimeApprox(t, "V_HIGH.rank", rank["V_HIGH"], 75, 1e-6)

	// The load-bearing assertion: NSW's worst suburb must not be pushed below
	// VIC's best merely because VIC's police count more offences per head.
	// Under national pooling this is 37.5 vs 62.5 and fails.
	if rank["N_HIGH"] <= rank["V_LOW"] {
		t.Errorf("NSW's worst suburb (%.2f) ranked at or below VIC's best (%.2f) — "+
			"ranks are being pooled across jurisdictions", rank["N_HIGH"], rank["V_LOW"])
	}
}
