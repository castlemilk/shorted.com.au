package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Council (LGA) facts from the ABS Data API, all CC-BY-4.0, all keyed by ABS
// code — never by name. Four operator modes share one parse path:
//
//	erp-lga                ERP_LGA<Y> + ERP_COMP_LGA<Y> (newest Y) → lga.population/erp_year/
//	                       pop_growth_pct + lga_series (erp and its components)
//	census-lga             C21_G02_LGA, C21_G37_LGA, ABS_SEIFA2021_LGA → lga columns
//	council-regional       ABS_REGIONAL_LGA2021 ('Data by Region') → lga_series:
//	                       council-level transfer medians/counts, FY dwelling approvals
//	building-approvals-lga BA_LGA<FY> monthly → lga_series
//
// Every flow is key-filtered: BA_LGA2025 unfiltered is 319MB.
//
// CODE VINTAGES. lga_code24 is ASGS LGA_2024. The flows carry other vintages:
//   - LGA_2021/LGA_2022 (Census, SEIFA, Data by Region, BA before FY2023-24):
//     identical codes except Moreland 25250, renamed Merri-bek 24700 (same area).
//   - LGA_2025 (ERP_LGA2025, BA_LGA2025+): East Arnhem 71300 split into
//     71500 East Arnhem + 71700 Groote Archipelago. Additive measures (people,
//     approvals) are summed back to 71300 — only when BOTH parts report the
//     period, so a half-reported area never reads as a population fall. A
//     median cannot be summed, so a split code on a median is dropped.
//
// Any other code the dimension lacks is reported, never guessed.

const (
	erpSource       = "abs_erp_lga"
	erpCompSource   = "abs_erp_comp_lga"
	censusLGASource = "abs_census_lga"
	regionalSource  = "abs_regional_lga"
	baLGASource     = "abs_ba_lga"

	lgaUnitPersons = "persons"
	lgaUnitCount   = "count"
	lgaUnitAUD     = "AUD"
	// erpFlowPrefix / erpCompFlowPrefix name one flow per ERP release:
	// ERP_LGA<Y> is ERP at 30 June Y on LGA<Y> boundaries, published the
	// following March-April. The newest is discovered each run (latestERPFlow).
	erpFlowPrefix     = "ERP_LGA"
	erpCompFlowPrefix = "ERP_COMP_LGA"
	// erpCheckedVintage is the newest ERP vintage whose region codes lgaRecode
	// and lgaSplitParts were checked against. Discovery never reads an older
	// flow, and a newer one is ingested with a warning to review unknown codes.
	erpCheckedVintage = 2025
	regionalDataflow  = "ABS_REGIONAL_LGA2021"
	// baFirstFY is the first building-approvals flow a cold run pulls
	// (BA_LGA2021 = July 2021..June 2022). Earlier flows use LGA_2019/2020
	// codes for councils merged since, which would be dropped as unknown.
	baFirstFY = 2021
)

// lgaMinCouncils is the floor every council pull must clear (of 547 real
// councils): fewer means the key or the code mapping broke, not that ABS
// stopped covering councils. A var only so tests can serve small fixtures.
var lgaMinCouncils = 500

// lgaRecode maps a pure recode (same area, new code) onto lga_code24.
var lgaRecode = map[string]string{"25250": "24700"}

// lgaSplitParts maps an LGA_2025 part onto its LGA_2024 parent; lgaSplitWhole
// lists every part a parent needs before a sum is complete.
var (
	lgaSplitParts = map[string]string{"71500": "71300", "71700": "71300"}
	lgaSplitWhole = map[string]int{"71300": 2}
)

// lgaObs is one observation from an SDMX-CSV LGA flow, in the flow's own
// vintage and dimension codes.
type lgaObs struct {
	region string // region code in the flow's vintage
	dim    string // the flow's measure-dimension code ('ERP', '3', 'HOUSES_3', '100')
	period string // TIME_PERIOD as published ('2025', '2026-06')
	value  float64
}

// parseLGAObs reads LGA rows from labelled SDMX-CSV. regionCol and dimCol name
// the columns (they differ per flow); rows whose region type is not an LGA
// vintage (the BA flows mix in AUS/STE totals) and blank values are skipped —
// a blank is "not published", never zero.
func parseLGAObs(recs [][]string, regionCol, dimCol string) ([]lgaObs, error) {
	if len(recs) < 2 {
		return nil, fmt.Errorf("no rows")
	}
	idx := absdata.ColIndex(recs[0])
	need := func(name string) (int, error) {
		i, ok := idx[name]
		if !ok {
			return 0, fmt.Errorf("no %s column in %v", name, recs[0])
		}
		return i, nil
	}
	rc, err := need(regionCol)
	if err != nil {
		return nil, err
	}
	dc, err := need(dimCol)
	if err != nil {
		return nil, err
	}
	tc, err := need("TIME_PERIOD")
	if err != nil {
		return nil, err
	}
	vc, err := need("OBS_VALUE")
	if err != nil {
		return nil, err
	}
	typeCol := -1
	for _, name := range []string{"REGION_TYPE", "REGIONTYPE"} {
		if i, ok := idx[name]; ok {
			typeCol = i
		}
	}
	var out []lgaObs
	for _, row := range recs[1:] {
		if typeCol >= 0 && !strings.HasPrefix(absdata.Code(absdata.Cell(row, typeCol)), "LGA") {
			continue
		}
		raw := strings.TrimSpace(absdata.Cell(row, vc))
		if raw == "" {
			continue
		}
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		out = append(out, lgaObs{
			region: absdata.Code(absdata.Cell(row, rc)),
			dim:    absdata.Code(absdata.Cell(row, dc)),
			period: strings.TrimSpace(absdata.Cell(row, tc)),
			value:  v,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no LGA observations parsed")
	}
	return out, nil
}

// lgaMapping reports what happened to flow codes on the way to lga_code24.
type lgaMapping struct {
	unknown    map[string]bool // codes the dimension does not hold
	pseudo     int             // observations on pseudo-areas, dropped by design
	incomplete int             // split sums missing a part, dropped
	splitDrop  int             // split parts on a non-additive measure, dropped
}

func (m lgaMapping) summary() string {
	codes := make([]string, 0, len(m.unknown))
	for c := range m.unknown {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	return fmt.Sprintf("unknown codes %v, pseudo-area obs dropped %d, incomplete split sums dropped %d, split parts on a median dropped %d",
		codes, m.pseudo, m.incomplete, m.splitDrop)
}

// toLGA24 maps flow observations onto real councils in the dimension.
// additive says whether the measure may be summed across a split.
func toLGA24(obs []lgaObs, ix lgaIndex, additive bool) ([]lgaObs, lgaMapping) {
	m := lgaMapping{unknown: map[string]bool{}}
	type key struct{ region, dim, period string }
	sums := map[key]float64{}
	parts := map[key]map[string]bool{} // distinct parts seen, not rows

	var out []lgaObs
	for _, o := range obs {
		code := o.region
		if to, ok := lgaRecode[code]; ok {
			code = to
		}
		if parent, ok := lgaSplitParts[code]; ok {
			if !additive {
				m.splitDrop++
				continue
			}
			k := key{parent, o.dim, o.period}
			if parts[k] == nil {
				parts[k] = map[string]bool{}
			}
			if !parts[k][code] {
				sums[k] += o.value
				parts[k][code] = true
			}
			continue
		}
		if !ix.has(code) {
			m.unknown[code] = true
			continue
		}
		if !ix.geographic(code) {
			m.pseudo++
			continue
		}
		o.region = code
		out = append(out, o)
	}
	for k, v := range sums {
		if len(parts[k]) != lgaSplitWhole[k.region] || !ix.geographic(k.region) {
			m.incomplete++
			continue
		}
		out = append(out, lgaObs{region: k.region, dim: k.dim, period: k.period, value: v})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.region != b.region {
			return a.region < b.region
		}
		if a.dim != b.dim {
			return a.dim < b.dim
		}
		return a.period < b.period
	})
	return out, m
}

// june30 is the period convention for an annual ABS value dated at, or ending
// on, 30 June of year.
func june30(year int) time.Time { return time.Date(year, time.June, 30, 0, 0, 0, 0, time.UTC) }

// fyLabel is the financial year ending 30 June endYear, as ABS writes it ('2024-25').
func fyLabel(endYear int) string { return fmt.Sprintf("%d-%02d", endYear-1, endYear%100) }

// monthEnd turns '2026-06' into 30 June 2026.
func monthEnd(period string) (time.Time, bool) {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return time.Time{}, false
	}
	return t.AddDate(0, 1, -1), true
}

func countCouncils(rows []LGASeriesRow) int {
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.LGACode] = true
	}
	return len(seen)
}

// ---------------------------------------------------------------- erp-lga ---

// erpComponents maps ERP_COMP_LGA<Y> POP_COMP codes to lga_series measures.
// Only the net components are kept; births/deaths and arrivals/departures sum
// into them and nothing downstream needs them separately.
var erpComponents = map[string]string{
	"3": "natural_increase",
	"6": "net_internal_migration",
	"9": "net_overseas_migration",
}

// LGAPopulation is one council's current ERP scalar facts.
type LGAPopulation struct {
	LGACode      string
	Population   int
	Year         int
	PopGrowthPct *float64 // year-on-year %, nil without a prior year
}

// buildERP turns mapped ERP + component observations into lga_series rows and
// each council's latest-year scalars. ERP is at 30 June (label '2025'); a
// component is the flow over the year ended 30 June (label '2024-25').
func buildERP(erp, comp []lgaObs) ([]LGASeriesRow, []LGAPopulation) {
	var series []LGASeriesRow
	byCouncil := map[string]map[int]float64{}
	for _, o := range erp {
		if o.dim != "ERP" {
			continue
		}
		year, err := strconv.Atoi(o.period)
		if err != nil {
			continue
		}
		series = append(series, LGASeriesRow{
			LGACode: o.region, Measure: "erp", Period: june30(year), PeriodLabel: o.period,
			Value: o.value, Unit: lgaUnitPersons, Source: erpSource, Licence: absLicence,
		})
		if byCouncil[o.region] == nil {
			byCouncil[o.region] = map[int]float64{}
		}
		byCouncil[o.region][year] = o.value
	}
	for _, o := range comp {
		measure, ok := erpComponents[o.dim]
		year, err := strconv.Atoi(o.period)
		if !ok || err != nil {
			continue
		}
		series = append(series, LGASeriesRow{
			LGACode: o.region, Measure: measure, Period: june30(year), PeriodLabel: fyLabel(year),
			Value: o.value, Unit: lgaUnitPersons, Source: erpCompSource, Licence: absLicence,
		})
	}

	codes := make([]string, 0, len(byCouncil))
	for code := range byCouncil {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	pops := make([]LGAPopulation, 0, len(codes))
	for _, code := range codes {
		years := byCouncil[code]
		latest := 0
		for y := range years {
			latest = max(latest, y)
		}
		p := LGAPopulation{LGACode: code, Population: int(math.Round(years[latest])), Year: latest}
		if prev, ok := years[latest-1]; ok && prev > 0 {
			g := math.Round((years[latest]/prev-1)*10000) / 100
			p.PopGrowthPct = &g
		}
		pops = append(pops, p)
	}
	return series, pops
}

// latestERPFlow fetches the newest published flow <prefix><Y>, trying the
// current calendar year down to erpCheckedVintage. ABS answers 404 for a flow
// it has not published yet, which means "try the year before"; any other
// failure is returned. The region-type key is derived from the chosen flow
// (keyFor(Y) builds it with LGA<Y>). The flow is referenced WITHOUT a version:
// ABS versions differ per year (ERP_LGA2024 is 1.1, ERP_COMP_LGA2024 is 1.2),
// and an unversioned reference resolves to the latest.
func latestERPFlow(ctx context.Context, client *absdata.Client, prefix string, keyFor func(year int) string, now time.Time) (string, int, [][]string, error) {
	for y := now.Year(); y >= erpCheckedVintage; y-- {
		flow := fmt.Sprintf("%s%d", prefix, y)
		recs, err := client.FetchSDMXCSV(ctx, flow, keyFor(y), "2001")
		if absdata.IsNotFound(err) {
			log.Printf("[erp-lga] %s not published", flow)
			continue
		}
		if err != nil {
			return "", 0, nil, fmt.Errorf("fetch %s: %w", flow, err)
		}
		if y > erpCheckedVintage {
			log.Printf("[erp-lga] WARNING %s is newer than the LGA%d codes lgaRecode/lgaSplitParts were checked against: review the unknown codes below and extend the recode tables",
				flow, erpCheckedVintage)
		}
		return flow, y, recs, nil
	}
	return "", 0, nil, fmt.Errorf("no %s flow published between %d and %d", prefix, erpCheckedVintage, now.Year())
}

func erpKey(y int) string     { return fmt.Sprintf("ERP.LGA%d..A", y) }
func erpCompKey(y int) string { return fmt.Sprintf("3+6+9.LGA%d..A", y) }

func ingestERPLGA(ctx context.Context, client *absdata.Client, ix lgaIndex, now time.Time) ([]LGASeriesRow, []LGAPopulation, error) {
	erpFlow, _, recs, err := latestERPFlow(ctx, client, erpFlowPrefix, erpKey, now)
	if err != nil {
		return nil, nil, err
	}
	erpObs, err := parseLGAObs(recs, "REGION", "MEASURE")
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", erpFlow, err)
	}
	// Components are discovered separately: the flow can trail the ERP flow
	// of the same year, and a lagging component series is still correct.
	compFlow, _, recs, err := latestERPFlow(ctx, client, erpCompFlowPrefix, erpCompKey, now)
	if err != nil {
		return nil, nil, err
	}
	compObs, err := parseLGAObs(recs, "REGION", "POP_COMP")
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", compFlow, err)
	}
	erpObs, m := toLGA24(erpObs, ix, true)
	log.Printf("[erp-lga] %s: %s", erpFlow, m.summary())
	compObs, m = toLGA24(compObs, ix, true)
	log.Printf("[erp-lga] %s: %s", compFlow, m.summary())
	series, pops := buildERP(erpObs, compObs)
	if len(pops) < lgaMinCouncils {
		return nil, nil, fmt.Errorf("ERP covers only %d councils (< %d)", len(pops), lgaMinCouncils)
	}
	return series, pops, nil
}

// ------------------------------------------------------------- census-lga ---

// LGACensus is one council's Census 2021 + SEIFA 2021 facts. nil = ABS
// publishes nothing for it (never a measured zero).
type LGACensus struct {
	LGACode               string
	MedianAge             *float64
	MedianHhdIncome       *int // $/week
	MedianMortgageMonthly *int
	MedianWeeklyRent      *int
	AvgHouseholdSize      *float64
	PctRented             *float64
	SeifaIRSADDecile      *int
	SeifaIRSDDecile       *int
}

// buildLGACensus folds the three mapped Census/SEIFA pulls into one row per
// council. pct_rented is renting households over all households (the
// suburb-level definition in census.go: R_Tot_Total / Total_Total).
func buildLGACensus(g02, g37, seifa []lgaObs) []LGACensus {
	rows := map[string]*LGACensus{}
	get := func(code string) *LGACensus {
		if rows[code] == nil {
			rows[code] = &LGACensus{LGACode: code}
		}
		return rows[code]
	}
	fp := func(v float64) *float64 { return &v }
	ip := func(v float64) *int { n := int(math.Round(v)); return &n }
	for _, o := range g02 {
		r := get(o.region)
		switch o.dim {
		case "1":
			r.MedianAge = fp(o.value)
		case "4":
			r.MedianHhdIncome = ip(o.value)
		case "5":
			r.MedianMortgageMonthly = ip(o.value)
		case "6":
			r.MedianWeeklyRent = ip(o.value)
		case "8":
			r.AvgHouseholdSize = fp(o.value)
		}
	}
	rented, total := map[string]float64{}, map[string]float64{}
	for _, o := range g37 {
		switch o.dim {
		case "R_T":
			rented[o.region] = o.value
		case "_T":
			total[o.region] = o.value
		}
	}
	for code, t := range total {
		if r, ok := rented[code]; ok && t > 0 {
			get(code).PctRented = fp(math.Round(r/t*1000) / 10)
		}
	}
	for _, o := range seifa {
		if o.value < 1 || o.value > 10 {
			continue
		}
		switch o.dim {
		case "IRSAD":
			get(o.region).SeifaIRSADDecile = ip(o.value)
		case "IRSD":
			get(o.region).SeifaIRSDDecile = ip(o.value)
		}
	}
	out := make([]LGACensus, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LGACode < out[j].LGACode })
	return out
}

func ingestCensusLGA(ctx context.Context, client *absdata.Client, ix lgaIndex) ([]LGACensus, error) {
	type pull struct{ flow, key, regionCol, dimCol string }
	pulls := []pull{
		{"C21_G02_LGA,1.0.0", "1+4+5+6+8..LGA2021.", "REGION", "MEDAVG"},
		{"C21_G37_LGA,1.0.0", "R_T+_T._T..LGA2021.", "REGION", "TENLLD"},
		{"ABS_SEIFA2021_LGA,1.0.0", ".IRSAD+IRSD.RWAD", "LGA_2021", "SEIFAINDEXTYPE"},
	}
	got := make([][]lgaObs, len(pulls))
	for i, p := range pulls {
		recs, err := client.FetchSDMXCSV(ctx, p.flow, p.key, "2021")
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", p.flow, err)
		}
		obs, err := parseLGAObs(recs, p.regionCol, p.dimCol)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p.flow, err)
		}
		var m lgaMapping
		got[i], m = toLGA24(obs, ix, false)
		log.Printf("[census-lga] %s: %s", p.flow, m.summary())
	}
	rows := buildLGACensus(got[0], got[1], got[2])
	if len(rows) < lgaMinCouncils {
		return nil, fmt.Errorf("census LGA pulls cover only %d councils (< %d)", len(rows), lgaMinCouncils)
	}
	return rows, nil
}

// ------------------------------------------------------- council-regional ---

// regionalMeasures maps ABS_REGIONAL_LGA2021 ('Data by Region') measure codes
// to lga_series measures. All are 'year ended 30 June' (the flow's own
// HOUSES_1/BUILDING_1 headings), so TIME_PERIOD 2024 is FY 2023-24.
//
// These are COUNCIL-LEVEL ABS transfer medians. They are never a suburb's
// median and must never be spread across member suburbs (data-sources.md).
var regionalMeasures = map[string]struct {
	measure, unit string
	additive      bool
}{
	"HOUSES_2":   {"house_transfers", lgaUnitCount, true},
	"HOUSES_3":   {"house_median_price", lgaUnitAUD, false},
	"HOUSES_4":   {"attached_transfers", lgaUnitCount, true},
	"HOUSES_5":   {"attached_median_price", lgaUnitAUD, false},
	"BUILDING_4": {"dwelling_approvals_fy", lgaUnitCount, true},
}

func buildRegional(obs []lgaObs) []LGASeriesRow {
	var out []LGASeriesRow
	for _, o := range obs {
		m, ok := regionalMeasures[o.dim]
		year, err := strconv.Atoi(o.period)
		if !ok || err != nil {
			continue
		}
		out = append(out, LGASeriesRow{
			LGACode: o.region, Measure: m.measure, Period: june30(year), PeriodLabel: fyLabel(year),
			Value: o.value, Unit: m.unit, Source: regionalSource, Licence: absLicence,
		})
	}
	return out
}

func ingestCouncilRegional(ctx context.Context, client *absdata.Client, ix lgaIndex) ([]LGASeriesRow, error) {
	dims := make([]string, 0, len(regionalMeasures))
	for code := range regionalMeasures {
		dims = append(dims, code)
	}
	sort.Strings(dims)
	recs, err := client.FetchSDMXCSV(ctx, regionalDataflow+",1.6.0", strings.Join(dims, "+")+".LGA2021..A", "2011")
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", regionalDataflow, err)
	}
	obs, err := parseLGAObs(recs, "LGA_2021", "MEASURE")
	if err != nil {
		return nil, fmt.Errorf("%s: %w", regionalDataflow, err)
	}
	// LGA_2021 carries no split codes, only the Moreland recode, so medians and
	// counts map identically; additive=false keeps it that way if one appears.
	mapped, m := toLGA24(obs, ix, false)
	log.Printf("[council-regional] %s", m.summary())
	rows := buildRegional(mapped)
	if n := countCouncils(rows); n < lgaMinCouncils {
		return nil, fmt.Errorf("data by region covers only %d councils (< %d)", n, lgaMinCouncils)
	}
	return rows, nil
}

// ------------------------------------------------- building-approvals-lga ---

// baBuildingTypes maps BA BUILDING_TYPE codes to lga_series measures:
// dwelling units approved, all sectors, new + alterations.
var baBuildingTypes = map[string]string{
	"100": "dwelling_approvals_total",
	"110": "dwelling_approvals_houses",
	"850": "dwelling_approvals_other", // ABS 'Dwellings excluding houses'
}

const baKey = "1.9.TOT.100+110+850...M" // MEASURE.SECTOR.WORK_TYPE.BUILDING_TYPE.REGION_TYPE.REGION.FREQ

func buildBuildingApprovals(obs []lgaObs) []LGASeriesRow {
	var out []LGASeriesRow
	for _, o := range obs {
		measure, ok := baBuildingTypes[o.dim]
		end, okp := monthEnd(o.period)
		if !ok || !okp {
			continue
		}
		out = append(out, LGASeriesRow{
			LGACode: o.region, Measure: measure, Period: end, PeriodLabel: o.period,
			Value: o.value, Unit: lgaUnitCount, Source: baLGASource, Licence: absLicence,
		})
	}
	return out
}

// currentFYStart is the start year of the financial year containing now.
func currentFYStart(now time.Time) int {
	if now.Month() >= time.July {
		return now.Year()
	}
	return now.Year() - 1
}

// baFlowYears are the BA_LGA<FY> flows to pull. ABS publishes one flow per
// financial year, named by its start year (BA_LGA2025 = July 2025..June 2026),
// so a rolling 12 months always needs two. A cold run starts at baFirstFY; a
// warm one re-pulls from the financial year before the cursor, because ABS
// revises recent months.
func baFlowYears(now time.Time, cursor *time.Time) []int {
	from := baFirstFY
	if cursor != nil {
		from = max(baFirstFY, currentFYStart(*cursor)-1)
	}
	var years []int
	for y := from; y <= currentFYStart(now); y++ {
		years = append(years, y)
	}
	return years
}

func ingestBuildingApprovalsLGA(ctx context.Context, client *absdata.Client, ix lgaIndex, now time.Time, cursor *time.Time) ([]LGASeriesRow, error) {
	var all []lgaObs
	current := currentFYStart(now)
	for _, fy := range baFlowYears(now, cursor) {
		flow := fmt.Sprintf("BA_LGA%d,1.0.0", fy)
		recs, err := client.FetchSDMXCSV(ctx, flow, baKey, fmt.Sprintf("%d-07", fy))
		if absdata.IsNotFound(err) && fy == current {
			// The new financial year's flow appears with its first month's
			// release, about five weeks into July. Until then, last year's is
			// the latest there is.
			log.Printf("[building-approvals-lga] %s not published yet", flow)
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", flow, err)
		}
		obs, err := parseLGAObs(recs, "REGION", "BUILDING_TYPE")
		if err != nil {
			return nil, fmt.Errorf("%s: %w", flow, err)
		}
		mapped, m := toLGA24(obs, ix, true)
		log.Printf("[building-approvals-lga] %s: %d obs; %s", flow, len(mapped), m.summary())
		all = append(all, mapped...)
	}
	rows := buildBuildingApprovals(all)
	if n := countCouncils(rows); n < lgaMinCouncils {
		return nil, fmt.Errorf("building approvals cover only %d councils (< %d)", n, lgaMinCouncils)
	}
	return rows, nil
}
