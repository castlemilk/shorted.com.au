package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/xuri/excelize/v2"
)

const (
	crimePage = "https://www.abs.gov.au/statistics/people/crime-and-justice/recorded-crime-victims/latest-release"

	crimeSource     = "abs-recorded-crime-victims"
	crimeLicence    = absdata.Licence
	crimeSheet      = "Table 9"
	crimeTableTitle = "Table 9 Victims, Selected offences by states and territories, 1993 to 2024"
)

type crimeStateSpec struct {
	Header     string
	RegionCode string
	RegionName string
}

// Table 9 contains all eight state/territory sections. Tables 10-16 are
// analytical breakdowns, not one-sheet-per-state cubes, and must not be read.
var crimeStates = []crimeStateSpec{
	{"New South Wales", "nsw", "New South Wales"},
	{"Victoria", "vic", "Victoria"},
	{"Queensland", "qld", "Queensland"},
	{"South Australia", "sa", "South Australia"},
	{"Western Australia", "wa", "Western Australia"},
	{"Tasmania", "tas", "Tasmania"},
	{"Northern Territory", "nt", "Northern Territory"},
	{"Australian Capital Territory", "act", "Australian Capital Territory"},
}

var crimeOffences = map[string]string{
	"Homicide and related offences": "homicide",
	"Assault":                       "assault",
	"Sexual assault":                "sexual-assault",
	"Robbery":                       "robbery",
	"Unlawful entry with intent":    "unlawful-entry",
	"Motor vehicle theft":           "motor-vehicle-theft",
	"Other theft":                   "other-theft",
}

var crimeOffenceOrder = []string{
	"Homicide and related offences",
	"Assault",
	"Sexual assault",
	"Robbery",
	"Unlawful entry with intent",
	"Motor vehicle theft",
	"Other theft",
}

var (
	crimeFootnoteSuffixRe = regexp.MustCompile(`(?i)(?:\([a-z]+\))+$`)
	crimeYearRe           = regexp.MustCompile(`^(\d{4})(?:\([A-Za-z]+\))*$`)
)

type crimeYearColumn struct {
	Column int
	Period time.Time
}

func ingestCrime(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
	xlsxURL, err := discoverCrimeXLSX(ctx)
	if err != nil {
		return nil, err
	}
	f, err := fetchXLSX(ctx, xlsxURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parseCrimeWorkbook(f, xlsxURL)
}

func discoverCrimeXLSX(ctx context.Context) (string, error) {
	body, err := httpGet(ctx, crimePage, 60*time.Second, 8<<20)
	if err != nil {
		return "", fmt.Errorf("crime publication page: %w", err)
	}
	return selectCrimeXLSXLink(crimePage, body)
}

// selectCrimeXLSXLink selects by either rendered anchor text or the URL after
// percent-decoding. The release path is year-versioned, so only the page URL is
// stable enough to pin.
func selectCrimeXLSXLink(pageURL string, body []byte) (string, error) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("parse crime publication page: %w", err)
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return "", fmt.Errorf("parse crime publication URL: %w", err)
	}

	const target = "states and territories"
	var selected string
	doc.Find("a[href]").EachWithBreak(func(_ int, anchor *goquery.Selection) bool {
		href, ok := anchor.Attr("href")
		if !ok {
			return true
		}
		decodedHref, decodeErr := url.PathUnescape(href)
		if decodeErr != nil {
			decodedHref = href
		}
		candidate, parseErr := url.Parse(href)
		if parseErr != nil {
			return true
		}
		decodedPath, pathErr := url.PathUnescape(candidate.Path)
		if pathErr != nil {
			decodedPath = candidate.Path
		}
		if !strings.HasSuffix(strings.ToLower(decodedPath), ".xlsx") {
			return true
		}
		displayText := strings.ToLower(strings.Join(strings.Fields(anchor.Text()), " "))
		if !strings.Contains(strings.ToLower(decodedHref), target) &&
			!strings.Contains(displayText, target) {
			return true
		}
		selected = base.ResolveReference(candidate).String()
		return false
	})
	if selected == "" {
		return "", fmt.Errorf("no .xlsx link containing %q found on %s — layout changed", target, pageURL)
	}
	return selected, nil
}

// parseCrimeWorkbook returns healthy state sections alongside a joined error
// when any one section drifts. runJob persists those healthy observations while
// still failing the collector run, matching the govfin/petroleum resilience
// contract.
func parseCrimeWorkbook(f *excelize.File, sourceURL string) ([]Obs, error) {
	sheet := ""
	for _, name := range f.GetSheetList() {
		if strings.EqualFold(strings.TrimSpace(name), crimeSheet) {
			sheet = name
			break
		}
	}
	if sheet == "" {
		return nil, fmt.Errorf("crime workbook has no exact %q sheet (have %v)", crimeSheet, f.GetSheetList())
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}
	titleFound := false
	for _, row := range rows {
		if len(row) > 0 && strings.TrimSpace(row[0]) == crimeTableTitle {
			titleFound = true
			break
		}
	}
	if !titleFound {
		return nil, fmt.Errorf("%s title %q not found — layout drift", crimeSheet, crimeTableTitle)
	}

	years, err := crimeYearColumns(rows)
	if err != nil {
		return nil, err
	}

	var all []Obs
	var errs []string
	for _, state := range crimeStates {
		stateObs, skipped, stateErr := parseCrimeStateSection(rows, years, state, sheet, sourceURL)
		if stateErr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", state.RegionCode, stateErr))
			continue
		}
		if skipped > 0 {
			log.Printf("crime %s: skipped %d unmapped offence rows", state.RegionCode, skipped)
		}
		all = append(all, stateObs...)
	}
	if len(errs) > 0 {
		return all, fmt.Errorf("%d/%d crime state sections failed: %s", len(errs), len(crimeStates), strings.Join(errs, "; "))
	}
	return all, nil
}

func crimeYearColumns(rows [][]string) ([]crimeYearColumn, error) {
	for _, row := range rows {
		if len(row) == 0 || !strings.EqualFold(strings.TrimSpace(row[0]), "Offence") {
			continue
		}
		const firstYear, lastYear = 1993, 2024
		years := make([]crimeYearColumn, 0, lastYear-firstYear+1)
		seen := map[int]bool{}
		expected := firstYear
		for col := 1; col < len(row); col++ {
			label := strings.TrimSpace(row[col])
			match := crimeYearRe.FindStringSubmatch(label)
			if match == nil {
				return nil, fmt.Errorf("%s malformed year column %d label %q — layout drift", crimeSheet, col+1, label)
			}
			year, err := strconv.Atoi(match[1])
			if err != nil {
				return nil, fmt.Errorf("%s malformed year column %d label %q — layout drift", crimeSheet, col+1, label)
			}
			if year < firstYear || year > lastYear {
				return nil, fmt.Errorf("%s unexpected year %d in column %d — want %d..%d", crimeSheet, year, col+1, firstYear, lastYear)
			}
			if seen[year] {
				return nil, fmt.Errorf("%s duplicate year %d in column %d — layout drift", crimeSheet, year, col+1)
			}
			if year != expected {
				if year > expected {
					return nil, fmt.Errorf("%s missing %d before column %d — year sequence is gapped", crimeSheet, expected, col+1)
				}
				return nil, fmt.Errorf("%s unexpected out-of-order year %d in column %d — want %d", crimeSheet, year, col+1, expected)
			}
			seen[year] = true
			years = append(years, crimeYearColumn{
				Column: col,
				Period: time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC),
			})
			expected++
		}
		if expected <= lastYear {
			return nil, fmt.Errorf("%s missing %d — year header must contain every year %d..%d", crimeSheet, expected, firstYear, lastYear)
		}
		return years, nil
	}
	return nil, fmt.Errorf("%s offence/year header not found — layout drift", crimeSheet)
}

func parseCrimeStateSection(
	rows [][]string,
	years []crimeYearColumn,
	state crimeStateSpec,
	sheet, sourceURL string,
) ([]Obs, int, error) {
	start := -1
	for i, row := range rows {
		if len(row) > 1 && strings.EqualFold(stripCrimeFootnotes(row[1]), state.Header) {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil, 0, fmt.Errorf("state header %q not found — layout drift", state.Header)
	}

	end := len(rows)
	for i := start; i < len(rows); i++ {
		if len(rows[i]) > 1 && strings.TrimSpace(rows[i][0]) == "" && strings.TrimSpace(rows[i][1]) != "" {
			end = i
			break
		}
	}

	type parsedValue struct {
		offence string
		label   string
		period  time.Time
		value   float64
	}
	var values []parsedValue
	seenOffences := map[string]bool{}
	skipped := 0
	for _, row := range rows[start:end] {
		if len(row) == 0 {
			continue
		}
		label := strings.TrimSpace(row[0])
		if label == "" {
			continue
		}
		offence, mapped := crimeOffences[stripCrimeFootnotes(label)]
		if !mapped {
			skipped++
			continue
		}
		if seenOffences[offence] {
			return nil, skipped, fmt.Errorf("duplicate top-level offence row for %q — layout drift", offence)
		}
		seenOffences[offence] = true
		for _, year := range years {
			col, period := year.Column, year.Period
			if col >= len(row) {
				continue
			}
			cell := strings.TrimSpace(row[col])
			if cell == "" || strings.EqualFold(cell, "np") {
				continue
			}
			value, err := strconv.ParseFloat(strings.ReplaceAll(cell, ",", ""), 64)
			if err != nil {
				return nil, skipped, fmt.Errorf("%s %s cell %q for %d is not numeric or np",
					state.RegionCode, offence, cell, period.Year())
			}
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
				return nil, skipped, fmt.Errorf("%s %s invalid victim value %q for %d — want a finite non-negative count",
					state.RegionCode, offence, cell, period.Year())
			}
			values = append(values, parsedValue{offence: offence, label: label, period: period, value: value})
		}
	}

	var missing []string
	for _, label := range crimeOffenceOrder {
		offence := crimeOffences[label]
		if !seenOffences[offence] {
			missing = append(missing, label)
		}
	}
	if len(missing) > 0 {
		return nil, skipped, fmt.Errorf("missing top-level offence row(s) %v — layout drift", missing)
	}
	if len(values) == 0 {
		return nil, skipped, fmt.Errorf("0 published observations parsed — layout drift")
	}

	obs := make([]Obs, 0, len(values))
	for _, parsed := range values {
		dimensions := map[string]string{
			"sheet":                 sheet,
			"line_item":             parsed.label,
			"source_url":            sourceURL,
			"unmapped_rows_skipped": strconv.Itoa(skipped),
		}
		if parsed.offence == "assault" || parsed.offence == "sexual-assault" {
			dimensions["comparability"] = "within-state-only"
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "crime", Metric: "victims", Product: parsed.offence,
				RegionType: "state", RegionCode: state.RegionCode, RegionName: state.RegionName,
				Unit: "persons", Frequency: "annual", Adjustment: "original",
				SourceKey: crimeSource, Licence: crimeLicence, Dimensions: dimensions,
			},
			Period: parsed.period,
			Value:  parsed.value,
		})
	}
	return obs, skipped, nil
}

func stripCrimeFootnotes(value string) string {
	value = strings.TrimSpace(value)
	return strings.TrimSpace(crimeFootnoteSuffixRe.ReplaceAllString(value, ""))
}
