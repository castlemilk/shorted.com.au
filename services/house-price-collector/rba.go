package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ingestRBADebtToIncome pulls RBA statistical table E2 and extracts the national
// household debt-to-income series (series id BHFDDIT) as a quarterly ratio.
func ingestRBADebtToIncome(ctx context.Context) ([]Observation, error) {
	const url = "https://www.rba.gov.au/statistics/tables/csv/e2-data.csv"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", absUA)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RBA E2: HTTP %d", resp.StatusCode)
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}

	// Locate the "Series ID" header row, then the BHFDDIT column within it.
	col, dataStart := -1, -1
	for i, row := range rows {
		if len(row) > 0 && strings.EqualFold(strings.TrimSpace(row[0]), "Series ID") {
			for j, v := range row {
				if strings.TrimSpace(v) == "BHFDDIT" {
					col = j
					break
				}
			}
			dataStart = i + 1
			break
		}
	}
	if col < 0 || dataStart < 0 {
		return nil, fmt.Errorf("RBA E2: BHFDDIT series/header not found")
	}

	var obs []Observation
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
			continue
		}
		obs = append(obs, Observation{
			RegionCode: "AUS", RegionType: "national", RegionName: "Australia",
			Measure: "debt_to_income", DwellingType: "all", Period: period, PeriodFreq: "Q",
			Value: val, Unit: "ratio", IsPreliminary: false,
			Source: "rba", SourceLicence: "CC-BY-4.0",
		})
	}
	return obs, nil
}

// parseRBADate accepts RBA's "DD/MM/YYYY" (already quarter-end) and the older
// "Mon-YYYY" forms.
func parseRBADate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse("02/01/2006", s); err == nil {
		return t, true
	}
	if t, err := time.Parse("Jan-2006", s); err == nil {
		firstNext := time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		return firstNext.AddDate(0, 0, -1), true
	}
	return time.Time{}, false
}
