package main

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/xuri/excelize/v2"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// fagParenRe strips parenthetical aliases/qualifiers the FAG workbook appends to
// council names — 'Melbourne City Council (City of Melbourne)', 'Merri-bek City
// Council (formerly Moreland City Council)', 'Central Coast Council (NSW)'. The
// same strip runs over the ABS LGA names (which carry '(NSW)'/'(SA)' disambiguation
// suffixes), so both sides normalise consistently. Verified: lifts the FAG↔LGA
// match from 510 to 525 of 549 with no new same-state collisions, while doubled
// names ('Wagga Wagga', 'Baw Baw') are preserved (only bracketed spans are cut).
var fagParenRe = regexp.MustCompile(`\([^)]*\)`)

// Federal Financial Assistance Grants (FAGs) to local government — the untied
// Commonwealth grants every Australian council receives. National, all states,
// one row per (LGA, year). CC-BY-4.0 (Dept of Infrastructure). We take the
// latest year's total per council and attach it to the LGA dimension.
const (
	fagXLSXURL = "https://www.infrastructure.gov.au/sites/default/files/documents/fa-grants-historical-2017-18-to-2025-26.xlsx"
	fagSource  = "fed_fags"
)

// FagRow is one council's latest-year total Financial Assistance Grant.
type FagRow struct {
	StateCode string
	LGAName   string
	Year      string
	TotalAud  float64
}

// normCouncil strips council-type tokens + punctuation so FAG council names
// ('Albury City Council', 'City of Albany', 'Alpine Shire') match ABS LGA names
// ('Albury', 'Albany', 'Alpine').
func normCouncil(s string) string {
	s = strings.ToLower(s)
	s = fagParenRe.ReplaceAllString(s, " ") // drop '(City of Melbourne)'-style aliases
	for _, tok := range []string{
		"aboriginal shire council", "rural city council", "regional council", "municipal council",
		"district council", "shire council", "city council", "town council", "borough council",
		"the corporation of the city of", "corporation of the city of", "corporation of",
		"city of", "shire of", "town of", "district of", "municipality of", "region of",
		"rural city", "regional", "council", "shire", "borough", "municipality",
		"(c)", "(rc)", "(s)", "(dc)", "(m)", "(b)", "(t)", "(a)", "(rgc)", "(ac)",
	} {
		s = strings.ReplaceAll(s, tok, " ")
	}
	s = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' {
			return r
		}
		return ' '
	}, s)
	// drop stopwords left over from "Council of the City of X" forms
	fields := strings.Fields(s)
	kept := fields[:0]
	for _, w := range fields {
		if w != "of" && w != "the" {
			kept = append(kept, w)
		}
	}
	return strings.Join(kept, " ")
}

// ingestFAGs fetches + parses the FAG workbook, returning the latest year's
// total grant per council.
func ingestFAGs(ctx context.Context) ([]FagRow, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	b, _, err := client.FetchBytes(ctx, fagXLSXURL, xlsxAccept)
	if err != nil {
		return nil, fmt.Errorf("fetch FAG xlsx: %w", err)
	}
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' {
		return nil, fmt.Errorf("FAG fetch did not return an xlsx (%d bytes, likely a block page)", len(b))
	}
	return parseFAGs(b)
}

func parseFAGs(xlsxBytes []byte) ([]FagRow, error) {
	f, err := excelize.OpenReader(bytes.NewReader(xlsxBytes))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	sheet := "All data"
	if !slices.Contains(f.GetSheetList(), sheet) {
		// fall back to the last sheet
		sheet = f.GetSheetList()[len(f.GetSheetList())-1]
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}

	// Find the header row (has Jurisdiction + LGA + Year) and the total column.
	hdr, jurCol, lgaCol, yrCol, totCol := -1, -1, -1, -1, -1
	for i, row := range rows {
		fj, fl, fy := -1, -1, -1
		for j, c := range row {
			switch strings.ToLower(strings.TrimSpace(c)) {
			case "jurisdiction":
				fj = j
			case "lga":
				fl = j
			case "year":
				fy = j
			}
		}
		if fj >= 0 && fl >= 0 && fy >= 0 {
			hdr, jurCol, lgaCol, yrCol = i, fj, fl, fy
			for j, c := range row {
				if strings.Contains(strings.ToLower(c), "total financial assistance") {
					totCol = j
					break
				}
			}
			break
		}
	}
	if hdr < 0 || totCol < 0 {
		return nil, fmt.Errorf("FAG xlsx: header/total column not found")
	}

	// Keep the latest year's total per (state, council).
	type key struct{ state, lga string }
	latest := map[key]FagRow{}
	for _, row := range rows[hdr+1:] {
		if lgaCol >= len(row) || totCol >= len(row) {
			continue
		}
		state := absStateToCode[strings.TrimSpace(cell(row, jurCol))]
		name := strings.TrimSpace(cell(row, lgaCol))
		year := strings.TrimSpace(cell(row, yrCol))
		if state == "" || name == "" || year == "" {
			continue
		}
		total := parseAUD(cell(row, totCol))
		if total <= 0 {
			continue
		}
		k := key{state, name}
		if cur, ok := latest[k]; !ok || year > cur.Year {
			latest[k] = FagRow{StateCode: state, LGAName: name, Year: year, TotalAud: total}
		}
	}
	out := make([]FagRow, 0, len(latest))
	for _, r := range latest {
		out = append(out, r)
	}
	return out, nil
}

func parseAUD(s string) float64 {
	s = strings.TrimSpace(strings.NewReplacer("$", "", ",", "", " ", "").Replace(s))
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

