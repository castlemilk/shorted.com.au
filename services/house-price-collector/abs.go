package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ABS Data API (SDMX). Free, CC BY 4.0, no key — but a bare request 403s, so a
// User-Agent is mandatory (same WAF posture as the project's other fetches).
const (
	absBase      = "https://data.api.abs.gov.au/rest/data"
	absUA        = "shorted-housing/1.0 (+https://shorted.com.au)"
	absCSVAccept = "application/vnd.sdmx.data+csv;labels=both"
	absLicence   = "CC-BY-4.0"
)

// ABS state dimension code → abbreviation (RES_DWELL_ST + GCCSA leading digit).
var absStateAbbrev = map[string]string{
	"1": "NSW", "2": "VIC", "3": "QLD", "4": "SA", "5": "WA", "6": "TAS", "7": "NT", "8": "ACT",
}

// fetchABSCSV GETs a dataflow as labelled CSV ("code: label" cells) and returns
// header + data rows.
func fetchABSCSV(ctx context.Context, dataflow, key, startPeriod string) ([][]string, error) {
	url := fmt.Sprintf("%s/ABS,%s/%s?startPeriod=%s", absBase, dataflow, key, startPeriod)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", absUA)
	req.Header.Set("Accept", absCSVAccept)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("ABS %s/%s: HTTP %d: %s", dataflow, key, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// absColIndex maps a logical column (prefix before ':') to its index, so parsers
// survive dataflows with extra dimensions (e.g. RPPI's PROPERTY_TYPE).
func absColIndex(header []string) map[string]int {
	m := map[string]int{}
	for i, h := range header {
		name := strings.TrimSpace(h)
		if idx := strings.Index(name, ":"); idx >= 0 {
			name = strings.TrimSpace(name[:idx])
		}
		m[name] = i
	}
	return m
}

func absCode(cell string) string {
	if code, _, ok := strings.Cut(cell, ":"); ok {
		return strings.TrimSpace(code)
	}
	return strings.TrimSpace(cell)
}

func absLabel(cell string) string {
	if _, label, ok := strings.Cut(cell, ":"); ok {
		return strings.TrimSpace(label)
	}
	return strings.TrimSpace(cell)
}

// quarterEnd turns "2024-Q1" into the last day of that quarter (UTC).
func quarterEnd(period string) (time.Time, error) {
	parts := strings.SplitN(strings.TrimSpace(period), "-Q", 2)
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("bad period %q", period)
	}
	year, err := strconv.Atoi(parts[0])
	if err != nil {
		return time.Time{}, err
	}
	q, err := strconv.Atoi(parts[1])
	if err != nil || q < 1 || q > 4 {
		return time.Time{}, fmt.Errorf("bad quarter %q", period)
	}
	firstNext := time.Date(year, time.Month(q*3)+1, 1, 0, 0, 0, 0, time.UTC)
	return firstNext.AddDate(0, 0, -1), nil
}

func cell(row []string, idx int) string {
	if idx >= 0 && idx < len(row) {
		return row[idx]
	}
	return ""
}

// applyMult scales an ABS value by its UNIT_MULT (power of ten).
func applyMult(val float64, multCell string) float64 {
	if m, err := strconv.Atoi(absCode(multCell)); err == nil {
		return val * math.Pow10(m)
	}
	return val
}

func isPrelim(statusCell string) bool {
	s := strings.ToLower(absCode(statusCell))
	return s == "p" || strings.Contains(strings.ToLower(absLabel(statusCell)), "prelim")
}

// ── RES_DWELL_ST: national + state mean price (5) and total value (1) ────────
func ingestRESDWELLST(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "RES_DWELL_ST", "1+5..Q", "2011-Q3")
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, nil
	}
	c := absColIndex(rows[0])
	var obs []Observation
	for _, row := range rows[1:] {
		var measure, unit string
		switch absCode(cell(row, c["MEASURE"])) {
		case "5":
			measure, unit = "mean_price", "AUD"
		case "1":
			measure, unit = "total_value", "AUD"
		default:
			continue
		}
		regCode := absCode(cell(row, c["REGION"]))
		var rType, canonical, state string
		switch regCode {
		case "AUS":
			rType, canonical = "national", "AUS"
		default:
			ab, ok := absStateAbbrev[regCode]
			if !ok {
				continue
			}
			rType, canonical, state = "state", ab, ab
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		val = applyMult(val, cell(row, c["UNIT_MULT"]))
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		obs = append(obs, Observation{
			RegionCode: canonical, RegionType: rType, RegionName: absLabel(cell(row, c["REGION"])), StateCode: state,
			Measure: measure, DwellingType: "all", Period: period, PeriodFreq: "Q",
			Value: val, Unit: unit, IsPreliminary: isPrelim(cell(row, c["OBS_STATUS"])),
			Source: "abs_res_dwell_st", SourceLicence: absLicence,
		})
	}
	return obs, nil
}

// ── RES_DWELL: capital-city (GCCSA) median prices — established (3) + attached (4) ──
func ingestRESDWELL(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "RES_DWELL", "3+4..Q", "2015-Q1")
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, nil
	}
	c := absColIndex(rows[0])
	var obs []Observation
	for _, row := range rows[1:] {
		var dwelling string
		switch absCode(cell(row, c["MEASURE"])) {
		case "3":
			dwelling = "established_house"
		case "4":
			dwelling = "attached"
		default:
			continue
		}
		regCode := absCode(cell(row, c["REGION"])) // e.g. 1GSYD, 1RNSW
		if len(regCode) < 2 {
			continue
		}
		state := absStateAbbrev[regCode[:1]]
		rType := "gccsa"
		if regCode[1] == 'R' {
			rType = "rest_of_state"
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		val = applyMult(val, cell(row, c["UNIT_MULT"]))
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		obs = append(obs, Observation{
			RegionCode: regCode, RegionType: rType, RegionName: absLabel(cell(row, c["REGION"])), StateCode: state,
			Measure: "median_price", DwellingType: dwelling, Period: period, PeriodFreq: "Q",
			Value: val, Unit: "AUD", IsPreliminary: isPrelim(cell(row, c["OBS_STATUS"])),
			Source: "abs_res_dwell", SourceLicence: absLicence,
		})
	}
	return obs, nil
}

// ── RPPI: historical 8-capital stratified price index (frozen 2021-Q4) ───────
// MEASURE.PROPERTY_TYPE.REGION.FREQ → 1 (index) . 3 (residential) . 100 (8-cap avg) . Q
func ingestRPPI(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "RPPI", "1.3.100.Q", "2003-Q3")
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, nil
	}
	c := absColIndex(rows[0])
	var obs []Observation
	for _, row := range rows[1:] {
		if absCode(cell(row, c["MEASURE"])) != "1" {
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
		// The 8-capital weighted average maps to the national region; it's a
		// distinct measure (price_index) so it coexists with the mean_price row.
		obs = append(obs, Observation{
			RegionCode: "AUS", RegionType: "national", RegionName: "Australia", StateCode: "",
			Measure: "price_index", DwellingType: "all", Period: period, PeriodFreq: "Q",
			Value: val, Unit: "index", IsPreliminary: false,
			Source: "abs_rppi", SourceLicence: absLicence,
		})
	}
	return obs, nil
}

// ── LEND_HOUSING: new housing loan commitments (value), owner-occupier vs ─────
// investor, seasonally adjusted, national + state. Emits loan_commitments_oo,
// loan_commitments_investor, and a derived investor_loan_share (%) per region.
// Key dims (live order): MEASURE.DATA_ITEM.LOAN_TYPE.LOAN_PURPOSE.LENDER_TYPE.
// HOUSING_PURPOSE.TSEST.REGION.FREQ — parsed by column NAME, never position.
func ingestLENDHOUSING(ctx context.Context) ([]Observation, error) {
	// FIN_VAL=value, NEWCOMMITS=new commitments, DV8368=total fixed+revolving,
	// TOTDWELL=total dwellings ex-refinancing, TOT=all lenders,
	// DV5167=owner occupier, DV5168=investor, 20=seasonally adjusted.
	const key = "FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.DV5167+DV5168.20.AUS+1+2+3+4+5+6+7+8.Q"
	rows, err := fetchABSCSV(ctx, "LEND_HOUSING", key, "2011-Q3")
	if err != nil {
		return nil, err
	}
	return parseLENDHOUSING(rows), nil
}

// parseLENDHOUSING turns labelled LEND_HOUSING CSV rows into OO/investor
// commitment observations plus a derived investor_loan_share per region/period.
func parseLENDHOUSING(rows [][]string) []Observation {
	if len(rows) < 2 {
		return nil
	}
	c := absColIndex(rows[0])

	type leg struct {
		oo, inv         float64
		haveOO, haveInv bool
	}
	type rk struct {
		region string
		period time.Time
	}
	regMeta := map[string]Observation{}
	pairs := map[rk]*leg{}

	var obs []Observation
	for _, row := range rows[1:] {
		regCode := absCode(cell(row, c["REGION"]))
		var rType, canonical, state string
		switch regCode {
		case "AUS":
			rType, canonical = "national", "AUS"
		default:
			ab, ok := absStateAbbrev[regCode]
			if !ok {
				continue
			}
			rType, canonical, state = "state", ab, ab
		}
		var measure string
		switch absCode(cell(row, c["HOUSING_PURPOSE"])) {
		case "DV5167":
			measure = "loan_commitments_oo"
		case "DV5168":
			measure = "loan_commitments_investor"
		default:
			continue // ignore FHB sub-splits etc.
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		val = applyMult(val, cell(row, c["UNIT_MULT"]))
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		o := Observation{
			RegionCode: canonical, RegionType: rType, RegionName: absLabel(cell(row, c["REGION"])), StateCode: state,
			Measure: measure, DwellingType: "all", Period: period, PeriodFreq: "Q",
			Value: val, Unit: "AUD", IsPreliminary: isPrelim(cell(row, c["OBS_STATUS"])),
			Source: "abs_lend_housing", SourceLicence: absLicence,
		}
		obs = append(obs, o)
		if _, ok := regMeta[canonical]; !ok {
			regMeta[canonical] = o
		}
		k := rk{canonical, period}
		l := pairs[k]
		if l == nil {
			l = &leg{}
			pairs[k] = l
		}
		if measure == "loan_commitments_oo" {
			l.oo, l.haveOO = val, true
		} else {
			l.inv, l.haveInv = val, true
		}
	}

	// Derived investor share of new commitments (%), where both legs present.
	for k, l := range pairs {
		if !l.haveOO || !l.haveInv || (l.oo+l.inv) == 0 {
			continue
		}
		m := regMeta[k.region]
		obs = append(obs, Observation{
			RegionCode: k.region, RegionType: m.RegionType, RegionName: m.RegionName, StateCode: m.StateCode,
			Measure: "investor_loan_share", DwellingType: "all", Period: k.period, PeriodFreq: "Q",
			Value: l.inv / (l.oo + l.inv) * 100, Unit: "percent", IsPreliminary: false,
			Source: "abs_lend_housing", SourceLicence: absLicence,
		})
	}
	return obs
}

// ── Derived price index: RES_DWELL_ST mean_price rebased to 100 at each ───────
// region's earliest quarter. The hedonic RPPI is frozen at 2021-Q4 with no
// successor dataflow, so this gives /housing a current-quarter index line.
// Labelled "derived" — a mean-price rebase, NOT the RPPI hedonic methodology.
func ingestDerivedPriceIndex(ctx context.Context) ([]Observation, error) {
	rows, err := fetchABSCSV(ctx, "RES_DWELL_ST", "5..Q", "2011-Q3") // MEASURE=5 mean_price
	if err != nil {
		return nil, err
	}
	return parseDerivedPriceIndex(rows), nil
}

// parseDerivedPriceIndex rebases each region's mean_price series to 100 at its
// earliest available quarter, emitting a price_index_derived series.
func parseDerivedPriceIndex(rows [][]string) []Observation {
	if len(rows) < 2 {
		return nil
	}
	c := absColIndex(rows[0])
	type pt struct {
		period time.Time
		value  float64
	}
	series := map[string][]pt{}
	meta := map[string]Observation{}
	for _, row := range rows[1:] {
		if absCode(cell(row, c["MEASURE"])) != "5" {
			continue
		}
		regCode := absCode(cell(row, c["REGION"]))
		var rType, canonical, state string
		switch regCode {
		case "AUS":
			rType, canonical = "national", "AUS"
		default:
			ab, ok := absStateAbbrev[regCode]
			if !ok {
				continue
			}
			rType, canonical, state = "state", ab, ab
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(cell(row, c["OBS_VALUE"])), 64)
		if err != nil {
			continue
		}
		val = applyMult(val, cell(row, c["UNIT_MULT"]))
		period, err := quarterEnd(cell(row, c["TIME_PERIOD"]))
		if err != nil {
			continue
		}
		series[canonical] = append(series[canonical], pt{period, val})
		if _, ok := meta[canonical]; !ok {
			meta[canonical] = Observation{RegionType: rType, RegionName: absLabel(cell(row, c["REGION"])), StateCode: state}
		}
	}
	var obs []Observation
	for region, pts := range series {
		sort.Slice(pts, func(i, j int) bool { return pts[i].period.Before(pts[j].period) })
		if len(pts) == 0 || pts[0].value == 0 {
			continue
		}
		base := pts[0].value
		m := meta[region]
		for _, p := range pts {
			obs = append(obs, Observation{
				RegionCode: region, RegionType: m.RegionType, RegionName: m.RegionName, StateCode: m.StateCode,
				Measure: "price_index_derived", DwellingType: "all", Period: p.period, PeriodFreq: "Q",
				Value: p.value / base * 100, Unit: "index", IsPreliminary: false,
				Source: "abs_derived", SourceLicence: absLicence,
			})
		}
	}
	return obs
}
