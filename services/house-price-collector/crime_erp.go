package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// ERP (Estimated Resident Population) is the per-FY denominator for crime rates
// AND the population weight for the percentile rank. No annual SAL-level ERP is
// published (ABS ERP stops at SA2), so we build it as:
//
//	ERP(sal, fy) = census_SAL_pop(sal) × stateGrowthIndex(state(sal), fy)
//	stateGrowthIndex(s, fy) = stateERP(s, fy) / stateERP(s, censusYear)
//
// i.e. the accurate 2021 Census usual-resident population per suburb, indexed
// year-to-year by its STATE's ERP growth. This is exact for the census base year
// and for the map's latest-FY read, and preserves the within-state relative
// populations (which come from the Census). A future refinement can index by the
// PARENT SA2's ERP growth via the ABS mesh-block SA2↔SAL allocation (the plan's
// §3 ideal) — hook: replace stateGrowthIndex with an sa2GrowthIndex keyed by a
// meshblock-derived sal→sa2 map. State-level is the Phase-1 approximation.
const erpDataflow = "ERP_ASGS2021,1.0.0"

// erpStateKey selects Persons (SEX=3), All ages (AGE=TOT), state level
// (REGION_TYPE=STE), Annual — a ~8KB slice vs the full ~30MB cube.
const erpStateKey = "ERP.3.TOT.STE..A"

// ERPTable resolves ERP(sal_code, fy) and exposes the state growth index used to
// age the CVS population base to historical FYs.
type ERPTable struct {
	salPop   map[string]int             // sal_code → 2021 Census usual-resident pop
	salState map[string]string          // sal_code → state abbrev
	stateERP map[string]map[int]float64 // state abbrev → fy → ERP
	baseYear int                        // census base year (2021)
	minYear  map[string]int             // state → earliest ERP year (for clamping)
	maxYear  map[string]int             // state → latest ERP year
}

// buildSalFyERP loads Census SAL populations from suburb_demographics and the
// state ERP series from the ABS Data API.
func buildSalFyERP(ctx context.Context, pool *pgxpool.Pool) (*ERPTable, error) {
	t := &ERPTable{
		salPop:   map[string]int{},
		salState: map[string]string{},
		baseYear: censusYear,
	}
	rows, err := pool.Query(ctx, `SELECT sal_code, state_code, population FROM suburb_demographics WHERE population IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("load suburb_demographics: %w", err)
	}
	for rows.Next() {
		var sal, state string
		var pop int
		if err := rows.Scan(&sal, &state, &pop); err != nil {
			rows.Close()
			return nil, err
		}
		t.salPop[sal] = pop
		t.salState[sal] = state
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(t.salPop) == 0 {
		return nil, fmt.Errorf("suburb_demographics empty — run -mode census first")
	}

	stateERP, err := fetchStateERP(ctx, absdata.NewClient())
	if err != nil {
		return nil, err
	}
	t.setStateERP(stateERP)
	return t, nil
}

// fetchStateERP pulls the state-level all-ages Persons ERP series.
func fetchStateERP(ctx context.Context, client *absdata.Client) (map[string]map[int]float64, error) {
	recs, err := client.FetchSDMXCSV(ctx, erpDataflow, erpStateKey, "2001")
	if err != nil {
		return nil, fmt.Errorf("fetch state ERP: %w", err)
	}
	return parseStateERP(recs)
}

// parseStateERP turns SDMX-CSV records into state abbrev → fy → ERP.
func parseStateERP(recs [][]string) (map[string]map[int]float64, error) {
	if len(recs) < 2 {
		return nil, fmt.Errorf("state ERP: no rows")
	}
	idx := absdata.ColIndex(recs[0])
	regionCol, ok := idx["ASGS_2021"]
	if !ok {
		return nil, fmt.Errorf("state ERP: no ASGS_2021 column")
	}
	timeCol, ok := idx["TIME_PERIOD"]
	if !ok {
		return nil, fmt.Errorf("state ERP: no TIME_PERIOD column")
	}
	valCol, ok := idx["OBS_VALUE"]
	if !ok {
		return nil, fmt.Errorf("state ERP: no OBS_VALUE column")
	}
	out := map[string]map[int]float64{}
	for _, row := range recs[1:] {
		state, ok := censusStateAbbrev[absdata.Code(absdata.Cell(row, regionCol))]
		if !ok {
			continue // "9" Other Territories, Australia, etc.
		}
		year, err := strconv.Atoi(absdata.Cell(row, timeCol))
		if err != nil {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, valCol), 64)
		if err != nil {
			continue
		}
		if out[state] == nil {
			out[state] = map[int]float64{}
		}
		out[state][year] = val
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("state ERP: no state rows parsed")
	}
	return out, nil
}

func (t *ERPTable) setStateERP(stateERP map[string]map[int]float64) {
	t.stateERP = stateERP
	t.minYear = map[string]int{}
	t.maxYear = map[string]int{}
	for state, series := range stateERP {
		for y := range series {
			if lo, ok := t.minYear[state]; !ok || y < lo {
				t.minYear[state] = y
			}
			if hi, ok := t.maxYear[state]; !ok || y > hi {
				t.maxYear[state] = y
			}
		}
	}
}

// stateGrowthIndex returns stateERP(fy)/stateERP(baseYear), with fy clamped to
// the available ERP range. Returns 1.0 (no adjustment) when the series is
// missing or the base value is zero.
func (t *ERPTable) stateGrowthIndex(state string, fy int) float64 {
	series := t.stateERP[state]
	if series == nil {
		return 1.0
	}
	base := series[t.baseYear]
	if base == 0 {
		return 1.0
	}
	y := fy
	if lo, ok := t.minYear[state]; ok && y < lo {
		y = lo
	}
	if hi, ok := t.maxYear[state]; ok && y > hi {
		y = hi
	}
	v, ok := series[y]
	if !ok || v == 0 {
		return 1.0
	}
	return v / base
}

// ERP returns the estimated resident population for a suburb in a financial
// year. The bool is false when the suburb has no Census base population.
func (t *ERPTable) ERP(salCode string, fy int) (float64, bool) {
	pop, ok := t.salPop[salCode]
	if !ok || pop <= 0 {
		return 0, false
	}
	return float64(pop) * t.stateGrowthIndex(t.salState[salCode], fy), true
}
