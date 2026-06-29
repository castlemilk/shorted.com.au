package main

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ABS 2021 Census General Community Profile (GCP) DataPack for Suburbs and
// Localities (SAL). Census 2021 is NOT served by the ABS SDMX Data API, so the
// demographics here come from the bulk DataPack ZIP instead.
const (
	censusDataPackURL = "https://www.abs.gov.au/census/find-census-data/datapacks/download/2021_GCP_SAL_for_AUS_short-header.zip"
	censusUA          = "shorted-housing/1.0 (+https://shorted.com.au)"
	censusLicence     = "CC-BY-4.0"
	censusSource      = "abs_census_2021"
	censusYear        = 2021

	censusG01Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G01_AUST_SAL.csv"
	censusG02Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G02_AUST_SAL.csv"
)

// STE_CODE21 (TopoJSON) → state abbreviation.
var censusStateAbbrev = map[string]string{
	"1": "NSW", "2": "VIC", "3": "QLD", "4": "SA", "5": "WA", "6": "TAS", "7": "NT", "8": "ACT",
}

// CensusRow is one suburb's demographics, anchored on a boundary (TopoJSON)
// suburb with G01/G02 Census values attached where the SAL code matches.
type CensusRow struct {
	SALCode   string
	SALName   string
	StateCode string

	Population            *int
	MedianAge             *float64
	MedianWeeklyHhdIncome *float64
	MedianWeeklyPerIncome *float64
	MedianWeeklyRent      *float64
	MedianMonthlyMortgage *float64
}

// suburbIdentity is the name + state for a SAL code, sourced from boundaries.
type suburbIdentity struct {
	salName   string
	stateCode string
}

// topojsonDoc is a minimal view of a boundary TopoJSON: each object's
// geometries carry the bare SAL code (id) plus name/state properties.
type topojsonDoc struct {
	Objects map[string]struct {
		Geometries []struct {
			ID         string `json:"id"`
			Properties struct {
				SALName string `json:"SAL_NAME21"`
				STECode string `json:"STE_CODE21"`
			} `json:"properties"`
		} `json:"geometries"`
	} `json:"objects"`
}

// g02Medians holds the five G02 fields we keep (nil = ABS-suppressed/blank).
type g02Medians struct {
	age             *float64
	monthlyMortgage *float64
	weeklyPerInc    *float64
	weeklyRent      *float64
	weeklyHhdInc    *float64
}

func censusGeoDir() string {
	if d := strings.TrimSpace(os.Getenv("CENSUS_GEO_DIR")); d != "" {
		return d
	}
	return filepath.Join("..", "web", "public", "geo", "suburbs")
}

// readSuburbRegistry reads the 8 boundary TopoJSON files and returns the
// authoritative sal_code → {name, state} registry (one entry per suburb).
func readSuburbRegistry(geoDir string) (map[string]suburbIdentity, error) {
	states := []string{"NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"}
	registry := map[string]suburbIdentity{}
	for _, st := range states {
		path := filepath.Join(geoDir, st+".topojson")
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		var doc topojsonDoc
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		for _, obj := range doc.Objects {
			for _, g := range obj.Geometries {
				code := strings.TrimSpace(g.ID)
				if code == "" {
					continue
				}
				registry[code] = suburbIdentity{
					salName:   strings.TrimSpace(g.Properties.SALName),
					stateCode: censusStateAbbrev[strings.TrimSpace(g.Properties.STECode)],
				}
			}
		}
	}
	if len(registry) == 0 {
		return nil, fmt.Errorf("empty suburb registry from %s", geoDir)
	}
	return registry, nil
}

// openDataPack returns a ZIP reader over the GCP SAL DataPack, preferring a
// local file (CENSUS_DATAPACK_PATH) and falling back to a fresh download.
func openDataPack(ctx context.Context) (*zip.ReadCloser, func(), error) {
	if path := strings.TrimSpace(os.Getenv("CENSUS_DATAPACK_PATH")); path != "" {
		zr, err := zip.OpenReader(path)
		if err != nil {
			return nil, nil, fmt.Errorf("open datapack %s: %w", path, err)
		}
		return zr, func() { _ = zr.Close() }, nil
	}

	tmp, err := os.CreateTemp("", "gcp_sal_*.zip")
	if err != nil {
		return nil, nil, err
	}
	cleanupTmp := func() { _ = os.Remove(tmp.Name()) }

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, censusDataPackURL, nil)
	if err != nil {
		_ = tmp.Close()
		cleanupTmp()
		return nil, nil, err
	}
	req.Header.Set("User-Agent", censusUA)
	resp, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
	if err != nil {
		_ = tmp.Close()
		cleanupTmp()
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_ = tmp.Close()
		cleanupTmp()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, nil, fmt.Errorf("download datapack: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		cleanupTmp()
		return nil, nil, err
	}
	if err := tmp.Close(); err != nil {
		cleanupTmp()
		return nil, nil, err
	}
	zr, err := zip.OpenReader(tmp.Name())
	if err != nil {
		cleanupTmp()
		return nil, nil, fmt.Errorf("open downloaded datapack: %w", err)
	}
	return zr, func() { _ = zr.Close(); cleanupTmp() }, nil
}

// readZipCSV reads a named ZIP entry as CSV (header + rows).
func readZipCSV(zr *zip.ReadCloser, name string) ([][]string, error) {
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		r := csv.NewReader(rc)
		r.FieldsPerRecord = -1
		return r.ReadAll()
	}
	return nil, fmt.Errorf("entry %q not found in datapack", name)
}

// csvColIndex maps trimmed header names to their column index.
func csvColIndex(header []string) map[string]int {
	m := map[string]int{}
	for i, h := range header {
		m[strings.TrimSpace(h)] = i
	}
	return m
}

// stripSALPrefix turns "SAL10001" into "10001".
func stripSALPrefix(code string) string {
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(code), "SAL"))
}

// parseCount parses an integer count (population). Blank/unparseable → nil; 0 ok.
func parseCount(s string) *int {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &v
}

// censusMoney parses a median/income/rent/mortgage value. 0, blank or
// unparseable → nil (0 is ABS suppression, not a real $0).
func censusMoney(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v == 0 {
		return nil
	}
	return &v
}

// parseG01 → map[bareSALCode]population.
func parseG01(rows [][]string) (map[string]*int, error) {
	if len(rows) < 2 {
		return nil, fmt.Errorf("G01: no data rows")
	}
	c := csvColIndex(rows[0])
	codeIdx, ok := c["SAL_CODE_2021"]
	if !ok {
		return nil, fmt.Errorf("G01: missing SAL_CODE_2021 column")
	}
	popIdx, ok := c["Tot_P_P"]
	if !ok {
		return nil, fmt.Errorf("G01: missing Tot_P_P column")
	}
	out := map[string]*int{}
	for _, row := range rows[1:] {
		code := stripSALPrefix(cell(row, codeIdx))
		if code == "" {
			continue
		}
		out[code] = parseCount(cell(row, popIdx))
	}
	return out, nil
}

// parseG02 → map[bareSALCode]g02Medians.
func parseG02(rows [][]string) (map[string]g02Medians, error) {
	if len(rows) < 2 {
		return nil, fmt.Errorf("G02: no data rows")
	}
	c := csvColIndex(rows[0])
	need := []string{
		"SAL_CODE_2021", "Median_age_persons", "Median_mortgage_repay_monthly",
		"Median_tot_prsnl_inc_weekly", "Median_rent_weekly", "Median_tot_hhd_inc_weekly",
	}
	for _, n := range need {
		if _, ok := c[n]; !ok {
			return nil, fmt.Errorf("G02: missing %s column", n)
		}
	}
	out := map[string]g02Medians{}
	for _, row := range rows[1:] {
		code := stripSALPrefix(cell(row, c["SAL_CODE_2021"]))
		if code == "" {
			continue
		}
		out[code] = g02Medians{
			age:             censusMoney(cell(row, c["Median_age_persons"])),
			monthlyMortgage: censusMoney(cell(row, c["Median_mortgage_repay_monthly"])),
			weeklyPerInc:    censusMoney(cell(row, c["Median_tot_prsnl_inc_weekly"])),
			weeklyRent:      censusMoney(cell(row, c["Median_rent_weekly"])),
			weeklyHhdInc:    censusMoney(cell(row, c["Median_tot_hhd_inc_weekly"])),
		}
	}
	return out, nil
}

// ingestCensus builds one CensusRow per boundary suburb, attaching G01/G02
// demographics where the bare SAL code matches.
func ingestCensus(ctx context.Context) ([]CensusRow, error) {
	registry, err := readSuburbRegistry(censusGeoDir())
	if err != nil {
		return nil, err
	}

	zr, cleanup, err := openDataPack(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	g01Rows, err := readZipCSV(zr, censusG01Entry)
	if err != nil {
		return nil, err
	}
	pop, err := parseG01(g01Rows)
	if err != nil {
		return nil, err
	}

	g02Rows, err := readZipCSV(zr, censusG02Entry)
	if err != nil {
		return nil, err
	}
	medians, err := parseG02(g02Rows)
	if err != nil {
		return nil, err
	}

	rows := make([]CensusRow, 0, len(registry))
	for code, id := range registry {
		row := CensusRow{
			SALCode:   code,
			SALName:   id.salName,
			StateCode: id.stateCode,
		}
		if p, ok := pop[code]; ok {
			row.Population = p
		}
		if m, ok := medians[code]; ok {
			row.MedianAge = m.age
			row.MedianMonthlyMortgage = m.monthlyMortgage
			row.MedianWeeklyPerIncome = m.weeklyPerInc
			row.MedianWeeklyRent = m.weeklyRent
			row.MedianWeeklyHhdIncome = m.weeklyHhdInc
		}
		rows = append(rows, row)
	}
	return rows, nil
}
