package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
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
	vicListingPageURL = "https://www.land.vic.gov.au/valuations/resources-and-reports/property-sales-statistics"
	vicXLSXURL        = "https://www.land.vic.gov.au/__data/assets/excel_doc/0032/756581/houses-by-suburb-2014-2024.xlsx"
	vicSource         = "vg_vic"
	vicLicence        = "CC-BY-4.0"
	xlsxAccept        = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*"
)

var (
	vicYearRe         = regexp.MustCompile(`^(?:19|20)\d{2}$`)
	vicNumRe          = regexp.MustCompile(`[0-9][0-9,]*`)
	vicWorkbookNameRe = regexp.MustCompile(`(?i)^houses-by-suburb-((?:19|20)\d{2})-((?:19|20)\d{2})\.xlsx$`)
)

type vicFetcher interface {
	FetchHTML(context.Context, string) (*goquery.Document, *url.URL, error)
	FetchBytes(context.Context, string, string) ([]byte, string, error)
}

func ingestVICSuburbMedians(ctx context.Context) ([]Observation, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	b, err := fetchVICSuburbWorkbook(ctx, client)
	if err != nil {
		return nil, err
	}
	return parseVICSuburbMedians(b)
}

// selectVICWorkbookURL finds the newest same-host annual house-median workbook
// linked from the listing page. The final page URL is used as the resolution
// base because the listing may redirect.
func selectVICWorkbookURL(doc *goquery.Document, pageURL *url.URL) (string, error) {
	if doc == nil || pageURL == nil {
		return "", fmt.Errorf("VIC workbook listing has no document or final URL")
	}

	bestURL := ""
	bestStart, bestEnd := -1, -1
	doc.Find("a[href]").Each(func(_ int, link *goquery.Selection) {
		href, ok := link.Attr("href")
		if !ok {
			return
		}
		relative, err := url.Parse(strings.TrimSpace(href))
		if err != nil {
			return
		}
		candidate := pageURL.ResolveReference(relative)
		if !strings.EqualFold(candidate.Host, pageURL.Host) {
			return
		}
		match := vicWorkbookNameRe.FindStringSubmatch(path.Base(candidate.Path))
		if match == nil {
			return
		}
		start, _ := strconv.Atoi(match[1])
		end, _ := strconv.Atoi(match[2])
		if end > bestEnd || (end == bestEnd && start > bestStart) {
			bestURL = candidate.String()
			bestStart, bestEnd = start, end
		}
	})

	if bestURL == "" {
		return "", fmt.Errorf("no same-host houses-by-suburb annual workbook link found")
	}
	return bestURL, nil
}

func fetchVICSuburbWorkbook(ctx context.Context, fetcher vicFetcher) ([]byte, error) {
	doc, finalURL, discoveryErr := fetcher.FetchHTML(ctx, vicListingPageURL)
	discoveredURL := ""
	if discoveryErr == nil {
		discoveredURL, discoveryErr = selectVICWorkbookURL(doc, finalURL)
	}

	var attemptErrors []error
	if discoveryErr != nil {
		attemptErrors = append(attemptErrors, fmt.Errorf("discover VIC workbook: %w", discoveryErr))
	} else {
		body, err := fetchVICWorkbook(ctx, fetcher, discoveredURL)
		if err == nil {
			return body, nil
		}
		attemptErrors = append(attemptErrors, fmt.Errorf("fetch discovered VIC workbook %s: %w", discoveredURL, err))
		if discoveredURL == vicXLSXURL {
			return nil, fmt.Errorf("fetch VIC suburb workbook: %w", errors.Join(attemptErrors...))
		}
	}

	body, err := fetchVICWorkbook(ctx, fetcher, vicXLSXURL)
	if err == nil {
		return body, nil
	}
	attemptErrors = append(attemptErrors, fmt.Errorf("fetch fallback VIC workbook %s: %w", vicXLSXURL, err))
	return nil, fmt.Errorf("fetch VIC suburb workbook: %w", errors.Join(attemptErrors...))
}

func fetchVICWorkbook(ctx context.Context, fetcher vicFetcher, workbookURL string) ([]byte, error) {
	body, _, err := fetcher.FetchBytes(ctx, workbookURL, xlsxAccept)
	if err != nil {
		return nil, err
	}
	if err := validateVICXLSX(body); err != nil {
		return nil, fmt.Errorf("response did not return a valid xlsx (%d bytes): %w", len(body), err)
	}
	return body, nil
}

func validateVICXLSX(body []byte) error {
	workbook, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("open xlsx: %w", err)
	}
	if err := workbook.Close(); err != nil {
		return fmt.Errorf("close xlsx: %w", err)
	}
	return nil
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
