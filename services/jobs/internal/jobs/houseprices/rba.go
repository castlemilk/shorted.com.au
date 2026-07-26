package houseprices

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RBA statistical tables are published as CSVs at a stable URL per table. All
// are CC-BY-4.0. A bare request can be WAF-blocked, so we send the same
// User-Agent as the ABS fetches.
const rbaCSVBase = "https://www.rba.gov.au/statistics/tables/csv/"

// fetchRBATable downloads one RBA statistical-table CSV (e.g. "e2-data.csv")
// and returns its raw rows. The RBA layout is a metadata block (Title,
// Description, Frequency, Units, …) followed by a "Series ID" row and then
// date-keyed data rows.
func fetchRBATable(ctx context.Context, file string) ([][]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rbaCSVBase+file, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", absUA)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RBA %s: HTTP %d", file, resp.StatusCode)
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// findRBASeries locates a series by its exact "Series ID" within a table and
// returns the column index plus the first data-row index. Matching by ID (not
// position or title) keeps parsers stable across column reordering.
func findRBASeries(rows [][]string, seriesID string) (col, dataStart int, ok bool) {
	for i, row := range rows {
		if len(row) == 0 || !strings.EqualFold(strings.TrimSpace(row[0]), "Series ID") {
			continue
		}
		for j, v := range row {
			if strings.TrimSpace(v) == seriesID {
				return j, i + 1, true
			}
		}
		return -1, -1, false
	}
	return -1, -1, false
}

// rbaSeriesSpec maps one RBA series ID to a stored measure.
type rbaSeriesSpec struct {
	seriesID string
	measure  string
	unit     string
}

// ingestRBANationalSeries pulls one RBA table and extracts the given national
// series into Observations (region AUS). scale converts the published unit to
// the stored unit (e.g. 1e9 for $billion → AUD); use 1 to keep as published.
func ingestRBANationalSeries(ctx context.Context, file, freq, source string, scale float64, specs []rbaSeriesSpec) ([]Observation, error) {
	rows, err := fetchRBATable(ctx, file)
	if err != nil {
		return nil, err
	}
	return parseRBANationalSeries(rows, file, freq, source, scale, specs)
}

// parseRBANationalSeries extracts the given series (by ID) from already-fetched
// RBA table rows into national Observations.
func parseRBANationalSeries(rows [][]string, file, freq, source string, scale float64, specs []rbaSeriesSpec) ([]Observation, error) {
	var obs []Observation
	for _, s := range specs {
		col, dataStart, ok := findRBASeries(rows, s.seriesID)
		if !ok {
			return nil, fmt.Errorf("RBA %s: series %s not found", file, s.seriesID)
		}
		for _, row := range rows[dataStart:] {
			if len(row) <= col {
				continue
			}
			period, ok := parseRBADate(row[0])
			if !ok {
				continue
			}
			val, err := strconv.ParseFloat(strings.TrimSpace(row[col]), 64)
			if err != nil {
				continue // blank/withheld cell — common for the latest period
			}
			obs = append(obs, Observation{
				RegionCode: "AUS", RegionType: "national", RegionName: "Australia",
				Measure: s.measure, DwellingType: "all", Period: period, PeriodFreq: freq,
				Value: val * scale, Unit: s.unit, IsPreliminary: false,
				Source: source, SourceLicence: "CC-BY-4.0",
			})
		}
	}
	return obs, nil
}

// ── E2: household debt-to-income (BHFDDIT), quarterly ratio ──────────────────
func ingestRBADebtToIncome(ctx context.Context) ([]Observation, error) {
	return ingestRBANationalSeries(ctx, "e2-data.csv", "Q", "rba", 1, []rbaSeriesSpec{
		{"BHFDDIT", "debt_to_income", "ratio"},
	})
}

// ── F6: outstanding housing lending rates, all institutions, monthly % ───────
// FLRHOOTA = owner-occupied (all loans, all institutions); FLRHIOTA = investor.
func ingestRBAMortgageRates(ctx context.Context) ([]Observation, error) {
	return ingestRBANationalSeries(ctx, "f6-data.csv", "M", "rba_f6", 1, []rbaSeriesSpec{
		{"FLRHOOTA", "mortgage_rate_oo", "percent"},
		{"FLRHIOTA", "mortgage_rate_investor", "percent"},
	})
}

// ── F1.1: cash rate target (FIRMMCRT), monthly % ─────────────────────────────
func ingestRBACashRate(ctx context.Context) ([]Observation, error) {
	return ingestRBANationalSeries(ctx, "f1.1-data.csv", "M", "rba_f11", 1, []rbaSeriesSpec{
		{"FIRMMCRT", "cash_rate", "percent"},
	})
}

// ── D1: housing credit growth, 12-month %, monthly ───────────────────────────
// DGFACH12 total; DGFACOH12 owner-occupier; DGFACIH12 investor.
func ingestRBAHousingCredit(ctx context.Context) ([]Observation, error) {
	return ingestRBANationalSeries(ctx, "d1-data.csv", "M", "rba_d1", 1, []rbaSeriesSpec{
		{"DGFACH12", "housing_credit_growth", "percent"},
		{"DGFACOH12", "housing_credit_growth_oo", "percent"},
		{"DGFACIH12", "housing_credit_growth_investor", "percent"},
	})
}

// ── E1: household balance sheet, quarterly, $billion → stored as raw AUD ──────
// BSPNSHNFD household dwelling assets; BSPNSHUNW net worth; BSPNSHUL liabilities.
func ingestRBAHouseholdBalanceSheet(ctx context.Context) ([]Observation, error) {
	return ingestRBANationalSeries(ctx, "e1-data.csv", "Q", "rba_e1", 1e9, []rbaSeriesSpec{
		{"BSPNSHNFD", "household_dwelling_assets", "AUD"},
		{"BSPNSHUNW", "household_net_worth", "AUD"},
		{"BSPNSHUL", "household_liabilities", "AUD"},
	})
}

// parseRBADate accepts RBA's "DD/MM/YYYY" (already period-end), "DD-Mon-YYYY",
// and the older "Mon-YYYY" forms.
func parseRBADate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse("02/01/2006", s); err == nil {
		return t, true
	}
	if t, err := time.Parse("02-Jan-2006", s); err == nil {
		return t, true
	}
	if t, err := time.Parse("Jan-2006", s); err == nil {
		firstNext := time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		return firstNext.AddDate(0, 0, -1), true
	}
	return time.Time{}, false
}
