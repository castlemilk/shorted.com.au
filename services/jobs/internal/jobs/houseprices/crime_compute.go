package houseprices

import (
	"math"
	"os"
	"sort"
	"strings"
)

// crime_compute implements the scaling + ranking methodology (plan §4):
//
//	scale(s,c,y)    victim_estimate: CVS_victims(s,c,y) / Σ_u raw_police(u,c,y)
//	                reporting_rate:  100 / CVS_reporting_rate(s,c,y)
//	adjusted(u,c,y) = raw_police(u,c,y) × scale(s,c,y)
//	rate(u,c,y)     = adjusted(u,c,y) / ERP(u,y) × 100000
//	pct_rank(u,c,y) = ( Σ_{v: rate_v < rate_u} pop_v + 0.5·pop_u ) / Σpop × 100
//	                  weighted by FY ERP, over all has-data suburbs in the SAME
//	                  jurisdiction (offence definitions are not comparable across
//	                  state police forces — see rankByGroup).
//
// A 2-yr pooled series (adjusted averaged over {y, y-1}, re-ranked) is produced
// alongside the single-FY series for small-suburb stability; the map reads the
// latest pooled FY, the profile trend reads the single-FY series.

const (
	scalerVictimEstimate = "victim_estimate"
	scalerReportingRate  = "reporting_rate"

	crimeSmallPopFloor = 2000 // ERP below this → volatile rate (BOCSAR's threshold)
	crimeRSEUnreliable = 25.0 // CVS RSE% above this → flag the state anchor unreliable
)

// crimeScalerMode reads the CRAWL_CRIME_SCALER_MODE knob (default victim_estimate).
func crimeScalerMode() string {
	if strings.TrimSpace(strings.ToLower(os.Getenv("CRAWL_CRIME_SCALER_MODE"))) == scalerReportingRate {
		return scalerReportingRate
	}
	return scalerVictimEstimate
}

// CrimeStatRow is one ready-to-upsert row (all published fields populated — we
// only emit rows that carry a valid scale, rate and rank).
type CrimeStatRow struct {
	SalCode       string
	CrimeType     string
	FYEnding      int
	Pooled        bool
	RawCount      float64
	AdjustedCount float64
	RatePer100k   float64
	PctRank       float64
	Population    int
	ScaleFactor   float64
	SmallPop      bool
	Unreliable    bool
	Jurisdiction  string
	Source        string
	SourceLicence string
}

type stateCrimeFY struct {
	state string
	ct    crimeType
	fy    int
}

type salCrimeFY struct {
	sal string
	ct  crimeType
	fy  int
}

type scaleInfo struct {
	factor     float64
	unreliable bool
}

// adjRow is an intermediate single-FY computed record.
type adjRow struct {
	sal, state    string
	ct            crimeType
	fy            int
	raw, adjusted float64
	rate          float64
	pop           int
	small         bool
	unreliable    bool
	factor        float64
}

// crimeComputeStats is a compact summary for logging.
type crimeComputeStats struct {
	Mode        string
	SingleRows  int
	PooledRows  int
	StateScales int
	LatestFY    int
}

// computeCrime turns raw police counts + CVS + ERP into scaled, ranked rows.
func computeCrime(jds []*jurisdictionData, cvs *CVSData, erp *ERPTable, mode string) ([]CrimeStatRow, crimeComputeStats) {
	srcByState := map[string]*jurisdictionData{}
	salState := map[string]string{}
	salRaw := map[salCrimeFY]float64{}
	stateSum := map[stateCrimeFY]float64{}

	for _, jd := range jds {
		for _, r := range jd.rows {
			if _, ok := srcByState[r.state]; !ok {
				srcByState[r.state] = jd
			}
			salState[r.salCode] = r.state
			salRaw[salCrimeFY{r.salCode, r.crimeType, r.fy}] += r.count
			stateSum[stateCrimeFY{r.state, r.crimeType, r.fy}] += r.count
		}
	}

	// State scale factors.
	scales := map[stateCrimeFY]scaleInfo{}
	for k, sum := range stateSum {
		si, ok := stateScaleFactor(mode, cvs, erp, k, sum)
		if ok {
			scales[k] = si
		}
	}

	// Single-FY adjusted + rate.
	singles := make([]adjRow, 0, len(salRaw))
	singleByKey := map[salCrimeFY]*adjRow{}
	for k, raw := range salRaw {
		state := salState[k.sal]
		si, ok := scales[stateCrimeFY{state, k.ct, k.fy}]
		if !ok {
			continue // no CVS anchor for this state/type/FY
		}
		erpVal, ok := erp.ERP(k.sal, k.fy)
		if !ok || erpVal <= 0 {
			continue
		}
		adjusted := raw * si.factor
		row := adjRow{
			sal: k.sal, state: state, ct: k.ct, fy: k.fy,
			raw: raw, adjusted: adjusted,
			rate:       adjusted / erpVal * 100000,
			pop:        int(math.Round(erpVal)),
			small:      erpVal < crimeSmallPopFloor,
			unreliable: si.unreliable,
			factor:     si.factor,
		}
		singles = append(singles, row)
	}
	for i := range singles {
		singleByKey[salCrimeFY{singles[i].sal, singles[i].ct, singles[i].fy}] = &singles[i]
	}

	// Pooled (2-yr) series: average adjusted over {fy, fy-1}, re-rate on fy ERP.
	type pooledRow struct {
		sal, state    string
		ct            crimeType
		fy            int
		raw, adjusted float64
		rate          float64
		pop           int
		small         bool
		unreliable    bool
		factor        float64
	}
	pooled := make([]pooledRow, 0, len(singles))
	for i := range singles {
		cur := &singles[i]
		prev, ok := singleByKey[salCrimeFY{cur.sal, cur.ct, cur.fy - 1}]
		if !ok {
			continue
		}
		erpVal, ok := erp.ERP(cur.sal, cur.fy)
		if !ok || erpVal <= 0 {
			continue
		}
		adj := (cur.adjusted + prev.adjusted) / 2
		pooled = append(pooled, pooledRow{
			sal: cur.sal, state: cur.state, ct: cur.ct, fy: cur.fy,
			raw:        (cur.raw + prev.raw) / 2,
			adjusted:   adj,
			rate:       adj / erpVal * 100000,
			pop:        int(math.Round(erpVal)),
			small:      erpVal < crimeSmallPopFloor,
			unreliable: cur.unreliable || prev.unreliable,
			factor:     cur.factor,
		})
	}

	// Rank each (jurisdiction, crime_type, FY) group, weighted by FY ERP.
	rankSingles := rankByGroup(len(singles),
		func(i int) (string, crimeType, int) { return singles[i].state, singles[i].ct, singles[i].fy },
		func(i int) (float64, int) { return singles[i].rate, singles[i].pop })
	rankPooled := rankByGroup(len(pooled),
		func(i int) (string, crimeType, int) { return pooled[i].state, pooled[i].ct, pooled[i].fy },
		func(i int) (float64, int) { return pooled[i].rate, pooled[i].pop })

	out := make([]CrimeStatRow, 0, len(singles)+len(pooled))
	latestFY := 0
	emit := func(sal, state string, ct crimeType, fy int, poolFlag bool, raw, adjusted, rate float64, pop int, small, unreliable bool, factor, rank float64) {
		jd := srcByState[state]
		row := CrimeStatRow{
			SalCode: sal, CrimeType: string(ct), FYEnding: fy, Pooled: poolFlag,
			RawCount: raw, AdjustedCount: adjusted, RatePer100k: rate, PctRank: rank,
			Population: pop, ScaleFactor: factor, SmallPop: small, Unreliable: unreliable,
		}
		if jd != nil {
			row.Jurisdiction, row.Source, row.SourceLicence = jd.jurisdiction, jd.source, jd.licence
		}
		out = append(out, row)
		if fy > latestFY {
			latestFY = fy
		}
	}
	for i := range singles {
		s := &singles[i]
		emit(s.sal, s.state, s.ct, s.fy, false, s.raw, s.adjusted, s.rate, s.pop, s.small, s.unreliable, s.factor, rankSingles[i])
	}
	for i := range pooled {
		p := &pooled[i]
		emit(p.sal, p.state, p.ct, p.fy, true, p.raw, p.adjusted, p.rate, p.pop, p.small, p.unreliable, p.factor, rankPooled[i])
	}

	return out, crimeComputeStats{
		Mode: mode, SingleRows: len(singles), PooledRows: len(pooled),
		StateScales: len(scales), LatestFY: latestFY,
	}
}

// stateScaleFactor computes the per (state, crime_type, FY) multiplier.
func stateScaleFactor(mode string, cvs *CVSData, erp *ERPTable, k stateCrimeFY, rawSum float64) (scaleInfo, bool) {
	cell, ok := cvsCell{}, false
	if byType := cvs.Rate[k.state]; byType != nil {
		if byFY := byType[k.ct]; byFY != nil {
			cell, ok = byFY[k.fy]
		}
	}
	if !ok || !cell.hasRate {
		return scaleInfo{}, false
	}
	unreliable := cell.rse > crimeRSEUnreliable

	switch mode {
	case scalerReportingRate:
		if cell.reportingRate <= 0 {
			return scaleInfo{}, false
		}
		return scaleInfo{factor: 100.0 / cell.reportingRate, unreliable: unreliable}, true
	default: // victim_estimate
		if rawSum <= 0 {
			return scaleInfo{}, false
		}
		base := cvsStateBaseFor(cvs, erp, k.state, k.ct, k.fy)
		if base <= 0 {
			return scaleInfo{}, false
		}
		victims := cell.rate / 100.0 * base
		if victims <= 0 {
			return scaleInfo{}, false
		}
		return scaleInfo{factor: victims / rawSum, unreliable: unreliable}, true
	}
}

// cvsStateBaseFor returns the state population base (persons-15+ or households)
// for a crime type + FY, aged from the latest CVS base by the state's ERP growth.
func cvsStateBaseFor(cvs *CVSData, erp *ERPTable, state string, ct crimeType, fy int) float64 {
	sb, ok := cvs.StateBase[state]
	if !ok {
		return 0
	}
	var latest float64
	if crimeBaseKind[ct] == basePersons15 {
		latest = sb.persons15
	} else {
		latest = sb.households
	}
	if latest <= 0 {
		return 0
	}
	// Age the latest base to FY y: base(y) = base(baseFY) × ERP(y)/ERP(baseFY).
	baseFY := cvs.BaseFY
	if baseFY == 0 {
		return latest
	}
	idxY := erp.stateGrowthIndex(state, fy)
	idxBase := erp.stateGrowthIndex(state, baseFY)
	if idxBase == 0 {
		return latest
	}
	return latest * idxY / idxBase
}

// rankByGroup computes the population-weighted percentile rank for every element,
// grouped by (jurisdiction, crime_type, FY). group(i) returns the grouping key;
// val(i) returns (rate, pop). The result is aligned by index i.
//
// The pool is scoped to ONE jurisdiction on purpose. Each state police force
// counts offences under its own rules — QLD's "Unlawful Entry" is not split
// residential/commercial, its "Assault" folds in assault-police that NSW and VIC
// exclude — so a rank computed across a mixed pool would compare counts that are
// not comparable, and would do it invisibly. Ranking within jurisdiction keeps
// every published percentile a like-for-like statement.
//
// Today this is a no-op: suburb_crime_stats is 100% NSW (Phase 1 / BOCSAR), and
// a single-jurisdiction pool partitions identically either way. It is written in
// now precisely BECAUSE it is currently a no-op — the alternative is discovering
// the mixed-pool problem on the day VIC lands, after the numbers are published.
func rankByGroup(n int, group func(int) (string, crimeType, int), val func(int) (float64, int)) []float64 {
	type gk struct {
		state string
		ct    crimeType
		fy    int
	}
	members := map[gk][]int{}
	for i := 0; i < n; i++ {
		state, ct, fy := group(i)
		members[gk{state, ct, fy}] = append(members[gk{state, ct, fy}], i)
	}
	out := make([]float64, n)
	for _, idxs := range members {
		pts := make([]rankPoint, len(idxs))
		for j, i := range idxs {
			rate, pop := val(i)
			pts[j] = rankPoint{rate: rate, pop: float64(pop)}
		}
		ranks := popWeightedPercentile(pts)
		for j, i := range idxs {
			out[i] = ranks[j]
		}
	}
	return out
}

// rankPoint is a (rate, population-weight) pair for percentile ranking.
type rankPoint struct {
	rate float64
	pop  float64
}

// popWeightedPercentile implements, for each point u:
//
//	pct_rank(u) = ( Σ_{v: rate_v < rate_u} pop_v + 0.5·pop_u ) / Σpop × 100
//
// i.e. the share of the total weight in strictly-lower-rate points, plus half of
// u's own weight (midpoint convention). Result is index-aligned, ∈ [0,100].
func popWeightedPercentile(pts []rankPoint) []float64 {
	out := make([]float64, len(pts))
	var total float64
	for _, p := range pts {
		total += p.pop
	}
	if total <= 0 {
		return out
	}
	// Sort a copy by rate to accumulate the strictly-lower weight efficiently.
	order := make([]int, len(pts))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return pts[order[a]].rate < pts[order[b]].rate })

	var cum float64 // weight of all points strictly before the current rate plateau
	i := 0
	for i < len(order) {
		// Gather the plateau of equal rates.
		j := i
		var plateauPop float64
		for j < len(order) && pts[order[j]].rate == pts[order[i]].rate {
			plateauPop += pts[order[j]].pop
			j++
		}
		// Every point in the plateau shares the same "strictly-lower" cum, and
		// adds half of its OWN weight (the plan's literal 0.5·pop_u).
		for k := i; k < j; k++ {
			idx := order[k]
			out[idx] = (cum + 0.5*pts[idx].pop) / total * 100
		}
		cum += plateauPop
		i = j
	}
	return out
}
