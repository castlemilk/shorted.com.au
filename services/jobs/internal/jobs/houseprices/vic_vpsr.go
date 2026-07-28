package houseprices

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// VIC Valuer-General "Median House by Suburb" time-series workbook (CC-BY).
// land.vic.gov.au sits behind Cloudflare, so we fetch via stealthhttp's NATIVE
// engine — its browser-realistic TLS fingerprint passes the challenge with no
// browser (verified: native returns the .xlsx, curl gets the "Just a moment"
// page). The workbook is wide: a header row carries year labels in scattered
// columns, each data row is a suburb with an annual median under each year.
const (
	vicXLSXURL = "https://www.land.vic.gov.au/__data/assets/excel_doc/0032/756581/houses-by-suburb-2014-2024.xlsx"
	vicSource  = "vg_vic"
	vicLicence = "CC-BY-4.0"
	xlsxAccept = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*"
)

var (
	vicYearRe = regexp.MustCompile(`^(?:19|20)\d{2}$`)
	vicNumRe  = regexp.MustCompile(`[0-9][0-9,]*`)
)

func ingestVICSuburbMedians(ctx context.Context) ([]Observation, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	b, _, err := client.FetchBytes(ctx, vicXLSXURL, xlsxAccept)
	if err != nil {
		return nil, fmt.Errorf("fetch VIC xlsx: %w", err)
	}
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' { // ZIP magic; HTML => blocked
		return nil, fmt.Errorf("VIC fetch did not return an xlsx (%d bytes, likely a block page)", len(b))
	}
	return parseVICSuburbMedians(b)
}

// parseVICSuburbMedians decodes the wide suburb×year sheet into annual median
// observations. Footnote markers (^, *) mark low-count medians as preliminary;
// "-" / blank cells are skipped.
func parseVICSuburbMedians(xlsxBytes []byte) ([]Observation, error) {
	f, err := excelize.OpenReader(bytes.NewReader(xlsxBytes))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("VIC xlsx: no sheets")
	}
	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, err
	}

	// Locate the header row (carries "Locality"/"Suburb") and map column→year.
	headerRow, localityCol := -1, -1
	yearCol := map[int]int{}
	for i, row := range rows {
		for j, cellVal := range row {
			if t := strings.TrimSpace(cellVal); strings.EqualFold(t, "Locality") || strings.EqualFold(t, "Suburb") {
				headerRow, localityCol = i, j
			}
		}
		if headerRow == i {
			for j, cellVal := range row {
				if vicYearRe.MatchString(strings.TrimSpace(cellVal)) {
					y, _ := strconv.Atoi(strings.TrimSpace(cellVal))
					yearCol[j] = y
				}
			}
			break
		}
	}
	if headerRow < 0 || localityCol < 0 || len(yearCol) == 0 {
		return nil, fmt.Errorf("VIC xlsx: header/year columns not found")
	}

	var obs []Observation
	for _, row := range rows[headerRow+1:] {
		if localityCol >= len(row) {
			continue
		}
		suburb := strings.TrimSpace(row[localityCol])
		if suburb == "" || vicYearRe.MatchString(suburb) {
			continue
		}
		regionCode := "SUBURB:VIC-" + strings.ToUpper(suburb)
		for col, year := range yearCol {
			if col >= len(row) {
				continue
			}
			raw := strings.TrimSpace(row[col])
			num := vicNumRe.FindString(raw)
			if num == "" {
				continue
			}
			val, err := strconv.ParseFloat(strings.ReplaceAll(num, ",", ""), 64)
			if err != nil || val <= 0 {
				continue
			}
			obs = append(obs, Observation{
				RegionCode: regionCode, RegionType: "suburb", RegionName: suburb, StateCode: "VIC",
				Measure: "median_price", DwellingType: "house",
				Period: time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC), PeriodFreq: "A",
				Value: val, Unit: "AUD", IsPreliminary: strings.ContainsAny(raw, "^*"),
				Source: vicSource, SourceLicence: vicLicence,
			})
		}
	}
	return obs, nil
}
