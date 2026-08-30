package economy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/xuri/excelize/v2"
)

// Workbook contract pinned from the real May-2026 issue (Task 9 Step 1 probe,
// 2026-07-21):
//
//   - Discovery: the DCCEEW publication page
//     https://www.energy.gov.au/publications/australian-petroleum-statistics
//     is NOT reachable from a plain HTTP client — curl with our UA fails with
//     HTTP/2 INTERNAL_ERROR (err 92) and an HTTP/1.1 retry times out mid-body
//     (WAF). The data.gov.au CKAN mirror worked first try, so CKAN is the
//     PRIMARY discovery path here and the energy.gov.au HTML scrape is the
//     fallback: `package_show?id=australian-petroleum-statistics` carries one
//     resource, the full data-extract workbook ("Australian Petroleum
//     Statistics - May 2026", last_modified 2026-07-15), replaced in-place
//     each issue at a URL that embeds the issue month
//     (…/download/australian-petroleum-statistics-data-extract-may-2026.xlsx)
//     — so the URL MUST be discovered per run, never hardcoded.
//
//   - Sheets (26 total): Index, Copyright, Data sources and notes, Petroleum
//     production[, by basin], Refinery production, Sales of products, Sales
//     by state and territory, Sales of lubricants, Imports/Exports volume
//     [value][, by country], Destination of LNG exports, Stock volume/mass…,
//     fuel-price sheets. All data sheets have the header on ROW 1 (no title
//     banner rows) and monthly rows from Jul 2010 to the current issue month.
//
//   - "Refinery production" carries BOTH refinery intake ("Total input (ML)")
//     and output-by-product columns ("LPG (ML)", "Automotive gasoline (ML)",
//     "Aviation turbine fuel (ML)", "Diesel oil (ML)", "Fuel oil (ML)",
//     "Other products (ML)", "Total (ML)") plus a "(%)" indigenous-share
//     column — hence one sheet feeds two specs below, split by
//     ColumnInclude/ColumnExclude.
//
//   - "Sales by state and territory" is the one long-format sheet: column A =
//     state abbreviation (NSW/VIC/QLD/SA/WA/TAS/NT — no ACT row; DCCEEW folds
//     ACT into NSW), column B = month, products across. Handled by
//     StateColumn.
//
//   - excelize renders the date-styled Month cells as "Jul 2010" ("Jan 2006"
//     layout) and numeric cells with thousands separators ("3,695.9") — the
//     AusTender mm-dd-yy lesson generalised; parsePetroleumMonth carries every
//     layout observed or previously bitten by. Suppressed cells are "n.a." /
//     "n.p." and are skipped (ParseFloat fails), NOT zeroes.
//
//   - Product identity: column headers are the only identity the workbook
//     offers, so Product = slug(header minus its trailing "(ML)"/"(%)"/(Mm3)
//     unit suffix). slug() is deterministic (series_test.go), so series keys
//     are stable across runs; a renamed column is a NEW series by design —
//     that is the correct failure mode for silent semantic drift.
const (
	petroleumPage    = "https://www.energy.gov.au/publications/australian-petroleum-statistics"
	petroleumCKAN    = "https://data.gov.au/data/api/3/action/package_show?id=australian-petroleum-statistics"
	petroleumSource  = "dcceew-petroleum-statistics"
	petroleumLicence = "CC-BY-4.0"
)

// petroleumSheetSpec describes one sheet of the data-extract workbook: months
// down a column, one product per subsequent column. Sheet + header + column
// names are located by substring match so issue-to-issue renames don't break
// silently; anything structural failing to match errors loudly instead.
type petroleumSheetSpec struct {
	SheetMatch      string   // sheet name (exact match preferred, else substring)
	Metric          string   // refinery_output | refinery_input | sales | imports | exports
	HeaderMatch     string   // first-column header label ("Month", or "State" for the long sheet)
	StateColumn     bool     // column A = state abbreviation, column B = month
	ColumnInclude   []string // if non-empty, only headers containing one of these (case-insensitive)
	ColumnExclude   []string // headers containing any of these are skipped
	ProductOverride string   // when set, all matched columns use this product slug
}

// petroleumSheets pins the REAL sheet names + column filters observed in the
// May-2026 issue (see the discovery block above).
var petroleumSheets = []petroleumSheetSpec{
	{SheetMatch: "Refinery production", Metric: "refinery_input", HeaderMatch: "Month",
		ColumnInclude: []string{"Total input (ML)"}, ProductOverride: "total"},
	{SheetMatch: "Refinery production", Metric: "refinery_output", HeaderMatch: "Month",
		ColumnExclude: []string{"Percentage indigenous", "Total input"}},
	{SheetMatch: "Sales of products", Metric: "sales", HeaderMatch: "Month"},
	{SheetMatch: "Sales by state and territory", Metric: "sales", HeaderMatch: "State", StateColumn: true},
	{SheetMatch: "Imports volume", Metric: "imports", HeaderMatch: "Month"},
	{SheetMatch: "Exports volume", Metric: "exports", HeaderMatch: "Month"},
}

// petroleumStates maps the workbook's state abbreviations (column A of
// "Sales by state and territory") to region code/name.
var petroleumStates = map[string][2]string{
	"NSW": {"nsw", "New South Wales"},
	"VIC": {"vic", "Victoria"},
	"QLD": {"qld", "Queensland"},
	"SA":  {"sa", "South Australia"},
	"WA":  {"wa", "Western Australia"},
	"TAS": {"tas", "Tasmania"},
	"NT":  {"nt", "Northern Territory"},
	"ACT": {"act", "Australian Capital Territory"}, // not present in May-2026 (folded into NSW) but harmless
}

func ingestPetroleum(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
	xlsxURL, err := discoverPetroleumXLSX(ctx)
	if err != nil {
		return nil, err
	}
	f, err := fetchXLSX(ctx, xlsxURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parsePetroleumWorkbook(f, petroleumSheets, xlsxURL)
}

// parsePetroleumWorkbook parses every configured sheet, accumulating per-sheet
// failures instead of aborting on the first: one renamed column must not
// stale the other five sheets. Observations from healthy sheets are returned
// ALONGSIDE a non-nil error when any sheet failed, so the caller can persist
// what parsed while still failing the run loudly (non-zero exit) so the
// layout drift gets noticed.
func parsePetroleumWorkbook(f *excelize.File, specs []petroleumSheetSpec, xlsxURL string) ([]Obs, error) {
	var all []Obs
	var errs []string
	for _, spec := range specs {
		obs, err := parsePetroleumSheet(f, spec, xlsxURL)
		if err != nil {
			errs = append(errs, fmt.Sprintf("sheet %q (%s): %v", spec.SheetMatch, spec.Metric, err))
			continue
		}
		all = append(all, obs...)
	}
	if len(errs) > 0 {
		return all, fmt.Errorf("%d/%d petroleum sheets failed: %s", len(errs), len(specs), strings.Join(errs, "; "))
	}
	return all, nil
}

// discoverPetroleumXLSX resolves the current issue's workbook URL. CKAN mirror
// first (the energy.gov.au page WAF-blocks plain clients — see the discovery
// block), HTML scrape of the publication page as fallback.
func discoverPetroleumXLSX(ctx context.Context) (string, error) {
	ckanURL, ckanErr := discoverPetroleumViaCKAN(ctx)
	if ckanErr == nil {
		return ckanURL, nil
	}
	pageURL, pageErr := discoverPetroleumViaPage(ctx)
	if pageErr == nil {
		return pageURL, nil
	}
	return "", fmt.Errorf("petroleum XLSX discovery failed: CKAN: %v; publication page: %v", ckanErr, pageErr)
}

func discoverPetroleumViaCKAN(ctx context.Context) (string, error) {
	body, err := httpGet(ctx, petroleumCKAN, 60*time.Second, 4<<20)
	if err != nil {
		return "", err
	}
	var pkg struct {
		Success bool `json:"success"`
		Result  struct {
			Resources []struct {
				URL          string `json:"url"`
				Format       string `json:"format"`
				LastModified string `json:"last_modified"`
			} `json:"resources"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &pkg); err != nil {
		return "", fmt.Errorf("CKAN response not JSON: %w", err)
	}
	if !pkg.Success {
		return "", fmt.Errorf("CKAN package_show success=false")
	}
	type cand struct{ url, modified string }
	var cands []cand
	for _, r := range pkg.Result.Resources {
		if strings.Contains(strings.ToLower(r.Format), "xlsx") || strings.HasSuffix(strings.ToLower(r.URL), ".xlsx") {
			cands = append(cands, cand{r.URL, r.LastModified})
		}
	}
	if len(cands) == 0 {
		return "", fmt.Errorf("no XLSX resource in CKAN package")
	}
	// Newest issue wins if the package ever carries more than one workbook.
	sort.Slice(cands, func(i, j int) bool { return cands[i].modified > cands[j].modified })
	return cands[0].url, nil
}

var xlsxLinkRe = regexp.MustCompile(`href="([^"]+\.xlsx[^"]*)"`)

func discoverPetroleumViaPage(ctx context.Context) (string, error) {
	body, err := httpGet(ctx, petroleumPage, 60*time.Second, 4<<20)
	if err != nil {
		return "", err
	}
	m := xlsxLinkRe.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("no .xlsx link found on %s — layout changed", petroleumPage)
	}
	link := string(m[1])
	if strings.HasPrefix(link, "/") {
		link = "https://www.energy.gov.au" + link
	}
	return link, nil
}

func httpGet(ctx context.Context, url string, timeout time.Duration, limit int64) ([]byte, error) {
	resp, err := absdata.GetWithRetry(
		ctx,
		&http.Client{Timeout: timeout},
		url,
		http.Header{"User-Agent": {absdata.UserAgent}},
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func fetchXLSX(ctx context.Context, url string) (*excelize.File, error) {
	data, err := httpGet(ctx, url, 120*time.Second, 64<<20)
	if err != nil {
		return nil, err
	}
	return excelize.OpenReader(bytes.NewReader(data))
}

func parsePetroleumSheet(f *excelize.File, spec petroleumSheetSpec, sourceURL string) ([]Obs, error) {
	sheet := findSheet(f, spec.SheetMatch)
	if sheet == "" {
		return nil, fmt.Errorf("no sheet matching %q (have %v)", spec.SheetMatch, f.GetSheetList())
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}
	// Locate the header row by its first-column label.
	headerIdx := -1
	for i, row := range rows {
		if len(row) > 0 && strings.EqualFold(strings.TrimSpace(row[0]), spec.HeaderMatch) {
			headerIdx = i
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("header row %q not found — layout drift", spec.HeaderMatch)
	}
	header := rows[headerIdx]

	monthCol, firstDataCol := 0, 1
	if spec.StateColumn {
		monthCol, firstDataCol = 1, 2
	}

	// ProductOverride collapses every matched column onto ONE product slug —
	// with more than one matched column that would silently upsert colliding
	// (series, period) rows where the last column wins. Guard loudly instead.
	if spec.ProductOverride != "" {
		matched := 0
		for col := firstDataCol; col < len(header); col++ {
			if label := strings.TrimSpace(header[col]); label != "" && columnWanted(label, spec) {
				matched++
			}
		}
		if matched > 1 {
			return nil, fmt.Errorf("ProductOverride %q set but %d columns matched — refusing silent series collision", spec.ProductOverride, matched)
		}
	}

	var obs []Obs
	for _, row := range rows[headerIdx+1:] {
		if len(row) <= monthCol {
			continue
		}
		regionCode, regionName, regionType := "aus", "Australia", "national"
		if spec.StateColumn {
			st, ok := petroleumStates[strings.ToUpper(strings.TrimSpace(row[0]))]
			if !ok {
				continue // blank/footnote/unknown-state rows
			}
			regionCode, regionName, regionType = st[0], st[1], "state"
		}
		period, ok := parsePetroleumMonth(strings.TrimSpace(row[monthCol]))
		if !ok {
			continue // footnote / blank tail rows
		}
		for col := firstDataCol; col < len(row) && col < len(header); col++ {
			label := strings.TrimSpace(header[col])
			if label == "" || !columnWanted(label, spec) {
				continue
			}
			val, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(row[col]), ",", ""), 64)
			if err != nil {
				continue // "n.a." / "n.p." suppression markers, blanks
			}
			product := spec.ProductOverride
			if product == "" {
				product = slug(stripUnitSuffix(label))
			}
			if product == "" {
				continue
			}
			obs = append(obs, Obs{
				Series: SeriesDef{
					Topic: "petroleum", Metric: spec.Metric, Product: product,
					RegionType: regionType, RegionCode: regionCode, RegionName: regionName,
					Unit: "megalitres", Frequency: "monthly", Adjustment: "original",
					SourceKey: petroleumSource, Licence: petroleumLicence,
					Dimensions: map[string]string{
						"sheet":      sheet,
						"column":     label,
						"source_url": sourceURL,
					},
				},
				Period: period,
				Value:  val,
			})
		}
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("0 observations parsed — layout drift")
	}
	return obs, nil
}

func columnWanted(label string, spec petroleumSheetSpec) bool {
	for _, ex := range spec.ColumnExclude {
		if strings.Contains(strings.ToLower(label), strings.ToLower(ex)) {
			return false
		}
	}
	if len(spec.ColumnInclude) == 0 {
		return true
	}
	for _, in := range spec.ColumnInclude {
		if strings.Contains(strings.ToLower(label), strings.ToLower(in)) {
			return true
		}
	}
	return false
}

// findSheet prefers an exact (case-insensitive) name match, then falls back
// to substring — "Imports volume" must not accidentally resolve to
// "Imports volume by country" just because of list order.
func findSheet(f *excelize.File, match string) string {
	for _, s := range f.GetSheetList() {
		if strings.EqualFold(strings.TrimSpace(s), match) {
			return s
		}
	}
	for _, s := range f.GetSheetList() {
		if strings.Contains(strings.ToLower(s), strings.ToLower(match)) {
			return s
		}
	}
	return ""
}

// unitSuffixRe strips ONE trailing parenthesised unit group — "(ML)", "(%)",
// "(Mm3)", "(GL)" — so "Regular (<95 RON) (ML)" keeps its RON qualifier.
var unitSuffixRe = regexp.MustCompile(`\s*\([^()]*\)\s*$`)

func stripUnitSuffix(s string) string {
	return strings.TrimSpace(unitSuffixRe.ReplaceAllString(s, ""))
}

// parsePetroleumMonth handles the layouts excelize emits for date-styled
// cells across issues: "Jul 2010" (observed in the May-2026 workbook),
// "May-2026", "May-26", "05-26" (mm-yy), "05-01-26" (mm-dd-yy, the AusTender
// rendering), plus ISO fallbacks.
func parsePetroleumMonth(s string) (time.Time, bool) {
	for _, layout := range []string{"Jan 2006", "Jan-2006", "Jan-06", "01-06", "01-02-06", "2006-01", "2006-01-02"} {
		if d, err := time.Parse(layout, s); err == nil {
			return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.UTC), true
		}
	}
	return time.Time{}, false
}
