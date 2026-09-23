package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"regexp"
	"slices"
	"sort"
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
// one row per (council, financial year) from 2017-18. CC-BY-4.0 (Dept of
// Infrastructure). Every year goes to lga_series (measure fag_total_aud); the
// latest year per council is also mirrored onto lga.fed_fag_aud/fed_fag_year.
const (
	fagXLSXURL  = "https://www.infrastructure.gov.au/sites/default/files/documents/fa-grants-historical-2017-18-to-2025-26.xlsx"
	fagSource   = "fed_fags"
	fagMeasure  = "fag_total_aud"
	fagLicence  = "CC-BY-4.0"
	fagUnitAUD  = "AUD"
	fagMinMatch = 500 // of ~547 councils: fewer means the name match broke, not the data
)

// FagRow is one council's total Financial Assistance Grant for one year.
type FagRow struct {
	StateCode string
	LGAName   string // raw workbook name, e.g. 'Corporation of the City of Tea Tree Gully'
	Year      string // financial year, '2025-26'
	TotalAud  float64
}

// fagAggregates routes a workbook entity whose name matches no ABS council
// onto the LGA_2024 area it governs, keyed by (state, normCouncil(name)).
// Several entities landing on one area are summed.
//   - Groote Archipelago split from East Arnhem in the 2025 council
//     boundaries; lga_code24 still has one East Arnhem (71300), so both grants
//     are that area's grant — the same aggregation erp-lga applies to ERP.
//   - The ACT Government is the local government for all of 'Unincorporated
//     ACT' (89399), and the Outback Communities Authority is the statutory
//     body for all of 'Unincorporated SA' (49399).
//
// Deliberately NOT routed: NSW village committees and the Lord Howe Island
// Board (each governs only part of Unincorporated NSW), SA Aboriginal
// corporations, and the NT local government association (not a council).
var fagAggregates = map[[2]string]string{
	{"NT", "groote archipelago"}:            "71300",
	{"ACT", "australian capital territory"}: "89399",
	{"SA", "outback communities authority"}: "49399",
}

// normCouncil strips council-type words + punctuation so FAG council names
// ('Albury City Council', 'City of Albany', 'Alpine Shire') match ABS LGA names
// ('Albury', 'Albany', 'Alpine'). Type words are removed as WHOLE words only —
// a substring strip turned 'Campbelltown' into 'campbell' and 'Townsville' into
// 'sville' (harmless only while both sides mangled alike). Order matters:
// longer phrases run first, so 'Rural City of Murray Bridge' loses 'rural city
// of' whole rather than 'city of' leaving a stray 'rural'.
func normCouncil(s string) string {
	s = strings.ToLower(s)
	s = fagParenRe.ReplaceAllString(s, " ") // drop '(City of Melbourne)'-style aliases
	// 'Hunter's Hill' is ABS 'Hunters Hill': drop apostrophes rather than
	// splitting on them. '&' and 'and' are the same council ('Clare & Gilbert
	// Valleys' vs ABS 'Clare and Gilbert Valleys').
	s = strings.NewReplacer("'", "", "’", "", "‘", "", "&", " and ").Replace(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return ' '
	}, s)
	s = " " + strings.Join(strings.Fields(s), " ") + " "
	for _, tok := range councilTypePhrases {
		for strings.Contains(s, " "+tok+" ") {
			s = strings.ReplaceAll(s, " "+tok+" ", " ")
		}
	}
	// Drop stopwords left over from "Council of the City of X" forms, and the
	// incorporation suffix ('Anangu Pitjantjatjara Inc').
	fields := strings.Fields(s)
	kept := fields[:0]
	for _, w := range fields {
		if w != "of" && w != "the" && w != "inc" && w != "incorporated" {
			kept = append(kept, w)
		}
	}
	out := strings.Join(kept, " ")
	if alias, ok := councilNameAliases[out]; ok {
		return alias
	}
	return out
}

// councilTypePhrases are the council-type words normCouncil removes, longest
// first. The bare type words at the end cover LGPRF's '<Name> City' / '<Name>
// Shire' form (no 'Council' suffix).
var councilTypePhrases = []string{
	"the corporation of the city of", "corporation of the city of",
	"aboriginal community council", "aboriginal shire council", "aboriginal council",
	"community government council",
	"rural city council", "regional council", "municipal council",
	"district council", "shire council", "city council", "town council", "borough council",
	"corporation of", "rural city of", "city of", "shire of", "town of", "district of",
	"municipality of", "region of",
	"rural city", "regional", "council", "shire", "borough", "municipality",
	"city", "town", "district",
}

// councilNameAliases maps a normalised name to the form its other spelling
// normalises to, where no token rule can: the FAG workbook shortens ABS's
// 'Anangu Pitjantjatjara Yankunytjatjara' to 'Anangu Pitjantjatjara Inc'.
var councilNameAliases = map[string]string{
	"anangu pitjantjatjara yankunytjatjara": "anangu pitjantjatjara",
}

// fagYearEnd turns a financial-year label ('2025-26') into its end date (30
// June 2026), the lga_series period convention.
func fagYearEnd(label string) (time.Time, bool) {
	m := fagYearRe.FindStringSubmatch(strings.TrimSpace(label))
	if m == nil {
		return time.Time{}, false
	}
	start, _ := strconv.Atoi(m[1])
	if end, _ := strconv.Atoi(m[2]); end != (start+1)%100 {
		return time.Time{}, false
	}
	return time.Date(start+1, time.June, 30, 0, 0, 0, 0, time.UTC), true
}

var fagYearRe = regexp.MustCompile(`^(\d{4})-(\d{2})$`)

// fagCouncilKey is how a workbook row finds its council: state + normalised name.
type fagCouncilKey struct{ state, norm string }

// fagResolution is the FAG workbook matched onto the council dimension.
type fagResolution struct {
	Series    []LGASeriesRow          // every (council, year), sorted
	Latest    map[string]LGASeriesRow // lga_code24 → newest year
	Unmatched []string                // 'STATE raw name', sorted, one per council
}

// resolveFAGs matches workbook rows onto lga codes by (state, normalised
// name) — never by raw name, so a council renamed mid-series ('Corporation of
// the City of Tea Tree Gully' → 'City of Tea Tree Gully') is ONE council whose
// history spans both names, and its latest year is the newest across them.
// Rows in fagAggregates are summed into their LGA_2024 council. Any other two
// rows landing on the same council and year (a rename listed twice in one
// year) resolve deterministically to the lexically last raw name, and are
// reported rather than summed.
func resolveFAGs(rows []FagRow, idx map[fagCouncilKey]string) (fagResolution, []string) {
	type cy struct{ code, year string }
	type pick struct {
		name  string
		total float64
		agg   bool
	}
	known := make(map[string]bool, len(idx))
	for _, code := range idx {
		known[code] = true
	}
	cells := map[cy]pick{}
	unmatched := map[string]bool{}
	var conflicts []string
	for _, r := range rows {
		norm := normCouncil(r.LGAName)
		code, agg := fagAggregates[[2]string{r.StateCode, norm}]
		if agg && !known[code] {
			agg = false // the target area is not in this dimension: match by name or report
		}
		if !agg {
			var ok bool
			if code, ok = idx[fagCouncilKey{r.StateCode, norm}]; !ok {
				unmatched[r.StateCode+" "+strings.TrimSpace(r.LGAName)] = true
				continue
			}
		}
		k := cy{code, r.Year}
		cur, seen := cells[k]
		switch {
		case !seen:
			cells[k] = pick{r.LGAName, r.TotalAud, agg}
		case agg || cur.agg:
			cells[k] = pick{cur.name, cur.total + r.TotalAud, true}
		default:
			conflicts = append(conflicts, fmt.Sprintf("%s %s: %q and %q", code, r.Year, cur.name, r.LGAName))
			if r.LGAName > cur.name {
				cells[k] = pick{r.LGAName, r.TotalAud, false}
			}
		}
	}

	res := fagResolution{Latest: map[string]LGASeriesRow{}}
	for k, p := range cells {
		end, ok := fagYearEnd(k.year)
		if !ok {
			continue
		}
		row := LGASeriesRow{
			LGACode: k.code, Measure: fagMeasure, Period: end, PeriodLabel: k.year,
			Value: p.total, Unit: fagUnitAUD, Source: fagSource, Licence: fagLicence,
		}
		res.Series = append(res.Series, row)
		if cur, ok := res.Latest[k.code]; !ok || row.Period.After(cur.Period) {
			res.Latest[k.code] = row
		}
	}
	sort.Slice(res.Series, func(i, j int) bool {
		a, b := res.Series[i], res.Series[j]
		if a.LGACode != b.LGACode {
			return a.LGACode < b.LGACode
		}
		return a.Period.Before(b.Period)
	})
	for name := range unmatched {
		res.Unmatched = append(res.Unmatched, name)
	}
	sort.Strings(res.Unmatched)
	sort.Strings(conflicts)
	return res, conflicts
}

// matchFAGs resolves the workbook onto the dimension, logs what did not
// match, and refuses a resolution covering fewer than fagMinMatch councils:
// that means the name normaliser broke, and writing it would leave most
// councils on a stale grant beside a fresh history for a few.
func matchFAGs(rows []FagRow, idx map[fagCouncilKey]string) (fagResolution, error) {
	res, conflicts := resolveFAGs(rows, idx)
	for _, c := range conflicts {
		log.Printf("[funding] two workbook names for one council-year, kept the later name: %s", c)
	}
	log.Printf("[funding] %d councils matched, %d workbook entities unmatched: %s",
		len(res.Latest), len(res.Unmatched), strings.Join(res.Unmatched, "; "))
	if len(res.Latest) < fagMinMatch {
		return res, fmt.Errorf("only %d councils matched the FAG workbook (< %d)", len(res.Latest), fagMinMatch)
	}
	return res, nil
}

// ingestFAGs fetches + parses the FAG workbook: every council-year row.
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

	// Every (state, council, year) row with a positive total. A zero or blank
	// total is "not paid / not listed", never a measured zero grant.
	var out []FagRow
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
		out = append(out, FagRow{StateCode: state, LGAName: name, Year: year, TotalAud: total})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("FAG xlsx: no grant rows under the header")
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
