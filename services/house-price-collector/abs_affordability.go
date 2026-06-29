package main

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Affordability tier: ABS Wage Price Index + CPI Rents, and a derived
// price-to-income index built from the dwelling mean price and the wage index.
// All ABS, CC-BY-4.0, quarterly, national. Keys verified against the live API;
// columns read by name (absColIndex) so they survive SDMX reordering.

// ── WPI: seasonally-adjusted, all-industries total hourly wage index ─────────
func ingestWPI(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "WPI", "1.THRPEB.7.TOT.20.AUS.Q", "2011-Q3")
	if err != nil {
		return nil, err
	}
	return parseABSNationalIndex(rows, "wage_index", "abs_wpi"), nil
}

// ── CPI Rents: national rents price index (MV derives YoY = rents inflation) ─
func ingestCPIRents(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "CPI", "1.115522.10.50.Q", "2011-Q3")
	if err != nil {
		return nil, err
	}
	return parseABSNationalIndex(rows, "rents_index", "abs_cpi"), nil
}

// parseABSNationalIndex parses a single national quarterly index series,
// canonicalising the national REGION code (WPI uses "AUS", CPI uses "50").
func parseABSNationalIndex(rows [][]string, measure, source string) []Observation {
	pts := nationalIndexPoints(rows)
	obs := make([]Observation, 0, len(pts))
	for _, p := range pts {
		obs = append(obs, Observation{
			RegionCode: "AUS", RegionType: "national", RegionName: "Australia",
			Measure: measure, DwellingType: "all", Period: p.period, PeriodFreq: "Q",
			Value: p.value, Unit: "index", IsPreliminary: false,
			Source: source, SourceLicence: absLicence,
		})
	}
	return obs
}

type idxPoint struct {
	period time.Time
	value  float64
}

// nationalIndexPoints extracts (period,value) for the single national series in
// an ABS index CSV (REGION "AUS" or "50"), parsed by column name.
func nationalIndexPoints(rows [][]string) []idxPoint {
	if len(rows) < 2 {
		return nil
	}
	c := absColIndex(rows[0])
	var out []idxPoint
	for _, row := range rows[1:] {
		reg := absCode(cell(row, c["REGION"]))
		if reg != "AUS" && reg != "50" {
			continue
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		out = append(out, idxPoint{period, val})
	}
	return out
}

// ── Derived price-to-income index ────────────────────────────────────────────
// (mean dwelling price ÷ wage index), rebased to 100 at the 2015 base, so it is
// directly comparable to the feature's baked OECD price-to-income (2015=100).
func ingestPriceToIncome(ctx context.Context) ([]Observation, error) {
	priceRows, err := fetchABSCSV(ctx, "RES_DWELL_ST", "5..Q", "2011-Q3") // MEASURE=5 mean_price
	if err != nil {
		return nil, err
	}
	wageRows, err := fetchABSCSV(ctx, "WPI", "1.THRPEB.7.TOT.20.AUS.Q", "2011-Q3")
	if err != nil {
		return nil, err
	}
	return parsePriceToIncome(priceRows, wageRows), nil
}

func parsePriceToIncome(priceRows, wageRows [][]string) []Observation {
	price := nationalMeanPriceByPeriod(priceRows)
	wage := map[time.Time]float64{}
	for _, p := range nationalIndexPoints(wageRows) {
		wage[p.period] = p.value
	}

	// Periods present in both, sorted.
	var periods []time.Time
	for t := range price {
		if _, ok := wage[t]; ok {
			periods = append(periods, t)
		}
	}
	if len(periods) < 2 {
		return nil
	}
	sort.Slice(periods, func(i, j int) bool { return periods[i].Before(periods[j]) })

	// Base = first period in 2015 present in both, else the earliest common.
	base := periods[0]
	for _, t := range periods {
		if t.Year() == 2015 {
			base = t
			break
		}
	}
	pBase, wBase := price[base], wage[base]
	if pBase == 0 || wBase == 0 {
		return nil
	}

	obs := make([]Observation, 0, len(periods))
	for _, t := range periods {
		if wage[t] == 0 {
			continue
		}
		ratio := (price[t] / pBase) / (wage[t] / wBase) * 100
		obs = append(obs, Observation{
			RegionCode: "AUS", RegionType: "national", RegionName: "Australia",
			Measure: "price_to_income", DwellingType: "all", Period: t, PeriodFreq: "Q",
			Value: ratio, Unit: "index", IsPreliminary: false,
			Source: "abs_derived", SourceLicence: absLicence,
		})
	}
	return obs
}

// nationalMeanPriceByPeriod extracts AUS mean_price (MEASURE=5, multiplier
// applied) keyed by period from a RES_DWELL_ST CSV.
func nationalMeanPriceByPeriod(rows [][]string) map[time.Time]float64 {
	out := map[time.Time]float64{}
	if len(rows) < 2 {
		return out
	}
	c := absColIndex(rows[0])
	for _, row := range rows[1:] {
		if absCode(cell(row, c["MEASURE"])) != "5" || absCode(cell(row, c["REGION"])) != "AUS" {
			continue
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		out[period] = applyMult(val, cell(row, c["UNIT_MULT"]))
	}
	return out
}
