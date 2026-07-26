package houseprices

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// ABS Crime Victimisation Survey (CVS) — the cross-jurisdiction SCALING anchor.
// The pooled state/territory data cube carries victimisation RATES (% of
// persons/households victimised in the last 12 months) by state, and the
// Populations cube carries the persons-15+/household bases those rates apply to.
//
// Landmines baked in (verified against the 2024-25 release):
//   - Locate sheets by their DESCRIPTION in the Contents tab, never by a
//     hardcoded "Table 30c" number — the numbering drifts release-to-release.
//   - Offence block labels use EN-DASHES and footnote markers ("Break–in",
//     "Total physical and/or threatened assault(d)") — normalised via
//     normCVSLabel before crosswalking.
//   - CVS is PREVALENCE not incidence; see crime_crosswalk.go note 3.
//   - The Populations pooled table only carries the LATEST 1-2 pooled periods,
//     so historical FY bases are ERP-growth-indexed off this latest base in
//     crime_erp.go / crime_compute.go.
const (
	cvsPooledURL = "https://www.abs.gov.au/statistics/people/crime-and-justice/crime-victimisation/2024-25/State%20and%20territory%20time%20series%2C%20pooled%20data%20%28Tables%2027a%20to%2031d%29.xlsx"
	cvsPopURL    = "https://www.abs.gov.au/statistics/people/crime-and-justice/crime-victimisation/2024-25/Populations%20%28Tables%2036a%20to%2037b%29.xlsx"
	cvsUA        = "shorted-housing/1.0 (+https://shorted.com.au)"
	cvsLicence   = "CC-BY-4.0"
)

// cvsCell is one (state, crime_type, FY) CVS observation.
type cvsCell struct {
	rate          float64 // victimisation rate, %
	rse           float64 // relative standard error of the rate, %
	reportingRate float64 // % of victims who reported the most recent incident (0 = unknown)
	hasRate       bool
}

// cvsStateBase is a state's population base for the latest pooled period.
type cvsStateBase struct {
	persons15  float64 // persons aged 15+ (headcount)
	households float64 // occupied private dwellings / households (headcount)
}

// CVSData is the parsed CVS cube: rates keyed by state → crime_type → fy_ending,
// plus the latest-period population bases.
type CVSData struct {
	Rate      map[string]map[crimeType]map[int]cvsCell
	StateBase map[string]cvsStateBase
	BaseFY    int // fy_ending of the population-base period (e.g. 2025 for "2023–25")
}

// cvsStateAbbrev maps a CVS full state name (normalised) to the abbreviation.
var cvsStateAbbrev = map[string]string{
	"new south wales":              "NSW",
	"victoria":                     "VIC",
	"queensland":                   "QLD",
	"south australia":              "SA",
	"western australia":            "WA",
	"tasmania":                     "TAS",
	"northern territory":           "NT",
	"australian capital territory": "ACT",
}

var cvsPeriodRe = regexp.MustCompile(`^\d{4}\s*[–—‒-]\s*\d{2,4}$`)

// normSpace lowercases and collapses internal whitespace (incl. embedded
// newlines the ABS uses in header cells like "South\n Australia").
func normSpace(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// cvsFYFromPeriod turns a pooled label ("2023–25", "2008–10") into the fy_ending
// of its LATEST financial year (2025, 2010). The trailing token is 2 or 4 digits.
func cvsFYFromPeriod(label string) (int, bool) {
	label = strings.TrimSpace(label)
	parts := regexp.MustCompile(`[–—‒-]`).Split(label, -1)
	if len(parts) != 2 {
		return 0, false
	}
	end := strings.TrimSpace(parts[1])
	v, err := strconv.Atoi(end)
	if err != nil {
		return 0, false
	}
	if len(end) == 2 {
		return 2000 + v, true
	}
	return v, true
}

// fetchCVSWorkbooks downloads the pooled + populations XLSX (env overrides:
// CVS_XLSX_PATH, CVS_POP_XLSX_PATH for local fixtures).
func fetchCVSWorkbooks(ctx context.Context) (pooled, pop []byte, err error) {
	pooled, err = fetchCVSBytes(ctx, "CVS_XLSX_PATH", cvsPooledURL)
	if err != nil {
		return nil, nil, fmt.Errorf("cvs pooled: %w", err)
	}
	pop, err = fetchCVSBytes(ctx, "CVS_POP_XLSX_PATH", cvsPopURL)
	if err != nil {
		return nil, nil, fmt.Errorf("cvs populations: %w", err)
	}
	return pooled, pop, nil
}

func fetchCVSBytes(ctx context.Context, envKey, url string) ([]byte, error) {
	if path := strings.TrimSpace(os.Getenv(envKey)); path != "" {
		return os.ReadFile(path)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", cvsUA)
	resp, err := (&http.Client{Timeout: 2 * time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' {
		return nil, fmt.Errorf("not an xlsx (%d bytes, likely a block/challenge page)", len(b))
	}
	return b, nil
}

// parseCVS parses the pooled rate cube + populations base into CVSData.
func parseCVS(pooled, pop []byte) (*CVSData, error) {
	f, err := excelize.OpenReader(bytes.NewReader(pooled))
	if err != nil {
		return nil, fmt.Errorf("open cvs pooled: %w", err)
	}
	defer func() { _ = f.Close() }()

	contents := cvsContentsIndex(f)
	// The RATE sheet and its RSE sibling BOTH say "victimisation rate" (the RSE
	// one is "relative standard error OF victimisation rate"), so the rate finder
	// must exclude "relative standard error". Same for the reporting-rate pair.
	noRSE := []string{"relative standard error"}
	personalRate := findCVSTab(contents, []string{"personal crimes", "victimisation rate"}, noRSE)
	householdRate := findCVSTab(contents, []string{"household crimes", "victimisation rate"}, noRSE)
	if personalRate == "" || householdRate == "" {
		return nil, fmt.Errorf("cvs: could not locate victimisation-rate sheets (personal=%q household=%q)", personalRate, householdRate)
	}
	personalRSE := findCVSTab(contents, []string{"personal crimes", "relative standard error of victimisation rate"}, nil)
	householdRSE := findCVSTab(contents, []string{"household crimes", "relative standard error of victimisation rate"}, nil)
	personalReport := findCVSTab(contents, []string{"personal crimes", "reporting rate"}, noRSE)
	householdReport := findCVSTab(contents, []string{"household crimes", "reporting rate"}, noRSE)

	data := &CVSData{
		Rate:      map[string]map[crimeType]map[int]cvsCell{},
		StateBase: map[string]cvsStateBase{},
	}

	// Victimisation rates (the core anchor).
	for _, sheet := range []string{householdRate, personalRate} {
		vals, err := parseCVSSheet(f, sheet, cvsCrimeType)
		if err != nil {
			return nil, fmt.Errorf("cvs rate %s: %w", sheet, err)
		}
		mergeCVS(data, vals, func(c *cvsCell, v float64) { c.rate = v; c.hasRate = true })
	}
	// RSE of the rate (flag unreliable state anchors). RSE-sheet block labels are
	// prefixed "RSE of …", so they use cvsRSECrimeType.
	for _, sheet := range []string{householdRSE, personalRSE} {
		if sheet == "" {
			continue
		}
		vals, err := parseCVSSheet(f, sheet, cvsRSECrimeType)
		if err != nil {
			return nil, fmt.Errorf("cvs rse %s: %w", sheet, err)
		}
		mergeCVS(data, vals, func(c *cvsCell, v float64) { c.rse = v })
	}
	// Reporting rate (the alternative "reporting_rate" scaler mode). "violent"
	// has no CVS "Total" reporting-rate line, so it proxies to "Physical assault".
	for _, sheet := range []string{householdReport, personalReport} {
		if sheet == "" {
			continue
		}
		vals, err := parseCVSSheet(f, sheet, cvsReportingCrimeType)
		if err != nil {
			return nil, fmt.Errorf("cvs reporting %s: %w", sheet, err)
		}
		mergeCVS(data, vals, func(c *cvsCell, v float64) { c.reportingRate = v })
	}

	if err := parseCVSPopulations(pop, data); err != nil {
		return nil, err
	}
	return data, nil
}

// cvsReportingCrimeType is the crosswalk for the reporting-rate sheets, where
// the personal sheet has no "Total ... assault" block — "Physical assault" is
// the documented proxy for `violent`.
func cvsReportingCrimeType(label string) (crimeType, bool) {
	if ct, ok := cvsCrimeType(label); ok {
		return ct, ok
	}
	if normCVSLabel(label) == "physical assault" {
		return crimeViolent, true
	}
	return "", false
}

// cvsContentsIndex parses the Contents tab into tab → description.
func cvsContentsIndex(f *excelize.File) map[string]string {
	out := map[string]string{}
	rows, err := f.GetRows("Contents")
	if err != nil {
		return out
	}
	tabRe := regexp.MustCompile(`^Table \d+[a-d]$`)
	for _, row := range rows {
		tab := strings.TrimSpace(xlsxCell(row, 0))
		if tabRe.MatchString(tab) {
			out[tab] = xlsxCell(row, 1)
		}
	}
	return out
}

// findCVSTab returns the tab whose Contents description contains ALL `include`
// needles and NONE of the `exclude` needles (case-insensitive). To keep the
// result deterministic across map-iteration order, the lowest tab number wins.
func findCVSTab(contents map[string]string, include, exclude []string) string {
	best := ""
	for tab, desc := range contents {
		d := strings.ToLower(desc)
		ok := true
		for _, n := range include {
			if !strings.Contains(d, strings.ToLower(n)) {
				ok = false
				break
			}
		}
		for _, n := range exclude {
			if strings.Contains(d, strings.ToLower(n)) {
				ok = false
				break
			}
		}
		if ok && (best == "" || tab < best) {
			best = tab
		}
	}
	return best
}

// parseCVSSheet reads one rate/RSE/reporting sheet into
// state → crime_type → fy_ending → value. labelFn crosswalks each offence block
// header to a common crime type (unmapped blocks are skipped).
func parseCVSSheet(f *excelize.File, sheet string, labelFn func(string) (crimeType, bool)) (map[string]map[crimeType]map[int]float64, error) {
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}
	// Find the period header row + column → fy_ending mapping. ABS appends a
	// revision footnote to the LATEST period header (e.g. "2023–25(d)"), which
	// cvsPeriodRe (anchored) would not match — dropping the newest FY entirely
	// while the older clean columns still locate the row, so no error surfaces.
	// Strip footnotes first (mirrors the populations parser below).
	periodRow, colFY := -1, map[int]int{}
	for i, row := range rows {
		hits := map[int]int{}
		for j := 1; j < len(row); j++ {
			tok := stripCVSFootnotes(row[j])
			if cvsPeriodRe.MatchString(tok) {
				if fy, ok := cvsFYFromPeriod(tok); ok {
					hits[j] = fy
				}
			}
		}
		if len(hits) >= 3 {
			periodRow, colFY = i, hits
			break
		}
	}
	if periodRow < 0 {
		return nil, fmt.Errorf("no pooled-period header row found")
	}

	out := map[string]map[crimeType]map[int]float64{}
	var cur crimeType
	curValid := false
	for i := periodRow + 1; i < len(rows); i++ {
		row := rows[i]
		a := strings.TrimSpace(xlsxCell(row, 0))
		b := strings.TrimSpace(xlsxCell(row, 1))
		if a == "" {
			// Potential block header (offence label) — ignore unit/period rows.
			if b == "" || b == "%" || cvsPeriodRe.MatchString(b) || strings.Contains(strings.ToLower(b), "victimisation rate") || strings.Contains(strings.ToLower(b), "reporting rate") {
				continue
			}
			cur, curValid = labelFn(b)
			continue
		}
		if !curValid {
			continue
		}
		state, ok := cvsStateAbbrev[normSpace(a)]
		if !ok {
			continue // "Australia" row and any footnotes
		}
		for col, fy := range colFY {
			v, ok := parseCVSFloat(xlsxCell(row, col))
			if !ok {
				continue
			}
			if out[state] == nil {
				out[state] = map[crimeType]map[int]float64{}
			}
			if out[state][cur] == nil {
				out[state][cur] = map[int]float64{}
			}
			out[state][cur][fy] = v
		}
	}
	return out, nil
}

// mergeCVS folds a per-state/type/fy value map into CVSData via set.
func mergeCVS(data *CVSData, vals map[string]map[crimeType]map[int]float64, set func(*cvsCell, float64)) {
	for state, byType := range vals {
		if data.Rate[state] == nil {
			data.Rate[state] = map[crimeType]map[int]cvsCell{}
		}
		for ct, byFY := range byType {
			if data.Rate[state][ct] == nil {
				data.Rate[state][ct] = map[int]cvsCell{}
			}
			for fy, v := range byFY {
				cell := data.Rate[state][ct][fy]
				set(&cell, v)
				data.Rate[state][ct][fy] = cell
			}
		}
	}
}

// parseCVSPopulations reads the pooled Populations sheet (Table 37a) — the
// latest-period persons-15+ and household bases per state (values in '000).
func parseCVSPopulations(pop []byte, data *CVSData) error {
	f, err := excelize.OpenReader(bytes.NewReader(pop))
	if err != nil {
		return fmt.Errorf("open cvs populations: %w", err)
	}
	defer func() { _ = f.Close() }()

	contents := cvsContentsIndex(f)
	sheet := findCVSTab(contents, []string{"populations", "pooled data"}, []string{"relative standard error"})
	if sheet == "" {
		// Fall back to the single-period Populations table.
		sheet = findCVSTab(contents, []string{"populations", "states and territories"}, []string{"relative standard error"})
	}
	if sheet == "" {
		return fmt.Errorf("cvs populations: no populations sheet found")
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return err
	}

	// Locate the state-column header row (contains "New South Wales").
	stateCol := map[int]string{}
	headerRow := -1
	for i, row := range rows {
		for j, c := range row {
			if abbrev, ok := cvsStateAbbrev[normSpace(c)]; ok {
				stateCol[j] = abbrev
				headerRow = i
			}
		}
		if headerRow == i && len(stateCol) >= 6 {
			break
		}
		if headerRow != i {
			stateCol = map[int]string{}
		}
	}
	if headerRow < 0 || len(stateCol) < 6 {
		return fmt.Errorf("cvs populations: state header row not found")
	}

	base := map[string]cvsStateBase{}
	baseFY := 0
	gotPersons, gotHouseholds := false, false
	for i := headerRow + 1; i < len(rows); i++ {
		row := rows[i]
		label := normSpace(xlsxCell(row, 0))
		// Detect the base period sub-header (e.g. "2023–25(d)") for baseFY.
		if baseFY == 0 {
			for j := 1; j < len(row); j++ {
				token := stripCVSFootnotes(row[j])
				if cvsPeriodRe.MatchString(token) {
					if fy, ok := cvsFYFromPeriod(token); ok {
						baseFY = fy
					}
				}
			}
		}
		isPersons := strings.HasPrefix(label, "persons aged 15")
		isHouseholds := label == "households"
		if !isPersons && !isHouseholds {
			continue
		}
		if isPersons && gotPersons { // only the first (latest-period) block
			continue
		}
		if isHouseholds && gotHouseholds {
			continue
		}
		for col, state := range stateCol {
			v, ok := parseCVSFloat(xlsxCell(row, col))
			if !ok {
				continue
			}
			sb := base[state]
			if isPersons {
				sb.persons15 = v * 1000 // '000 → headcount
			} else {
				sb.households = v * 1000
			}
			base[state] = sb
		}
		if isPersons {
			gotPersons = true
		} else {
			gotHouseholds = true
		}
		if gotPersons && gotHouseholds {
			break
		}
	}
	if len(base) == 0 {
		return fmt.Errorf("cvs populations: no persons/household base parsed")
	}
	data.StateBase = base
	data.BaseFY = baseFY
	return nil
}

var cvsInlineFootnoteRe = regexp.MustCompile(`\([a-z]\)`)

// stripCVSFootnotes removes ALL inline footnote markers (e.g. "2023–25(d)",
// "assault(a)(d)") and trims — used wherever an ABS header/label may carry a
// revision or reference footnote.
func stripCVSFootnotes(s string) string {
	return strings.TrimSpace(cvsInlineFootnoteRe.ReplaceAllString(s, ""))
}

// parseCVSFloat parses a numeric cell; blank / suppressed markers → (0,false).
// ABS annotates individual data cells with inline footnote markers (e.g. the
// latest-period revision flag "(e)1.5"), which are stripped before parsing —
// missing this drops exactly the newest FY the map reads.
func parseCVSFloat(s string) (float64, bool) {
	s = cvsInlineFootnoteRe.ReplaceAllString(strings.TrimSpace(s), "")
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if s == "" || s == "np" || s == "–" || s == "-" || s == "..." || s == ".." {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// xlsxCell is bounds-safe access into an excelize row (which trims trailing
// empties, so short rows are normal).
func xlsxCell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}
