package economy

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/xuri/excelize/v2"
)

// Workbook contract pinned from the real Mar-2026 quarterly issue (Task 3
// Step 1-2 probe, 2026-07-22):
//
//   - Escalation resolved: there is NO ABS SDMX dataflow carrying Government
//     Finance Statistics. A full ABS + all-agency dataflow-catalogue scan
//     (1,224 flows) plus direct 404 probes on GFS/GOV_FIN/GOVFIN/FISCAL/… found
//     nothing; GFS is published only as an Excel data cube (this release notes
//     it "previously used catalogue number 5519.0.55.001"). So this importer
//     follows the petroleum.go XLSX pattern, not the SDMX pattern.
//
//   - Discovery: the ABS publication page
//     https://www.abs.gov.au/statistics/economy/government/government-finance-statistics-australia/latest-release
//     IS reachable with our WAF-safe User-Agent (HTTP 200, unlike DCCEEW's
//     energy.gov.au page) and carries exactly one .xlsx link whose href embeds
//     the issue quarter (…/mar-2026/Mar%20Quarter%202026.xlsx). data.gov.au has
//     no ABS-published mirror of this cube (its CKAN hits are unrelated
//     state-treasury packages), so the ABS page is the sole discovery path and
//     the URL MUST be resolved per run, never hardcoded (it moves each quarter).
//
//   - Sheets (Mar-2026 issue): Contents, Table 1..15, Explanatory Notes.
//     Tables 5-12 are the per-state general-government Operating Statements —
//     one state per sheet (5=NSW, 6=VIC, 7=QLD, 8=SA, 9=WA, 10=TAS, 11=NT,
//     12=ACT). Tables 5-11 are "Total State and Local"; Table 12 (ACT) is just
//     "Operating Statement - General Government" (the ACT has no separate local
//     government) — structurally identical. Tables 1-4 are aggregate
//     (all-levels / Commonwealth / total-state) and 13-15 are balance sheets +
//     key aggregates; none give a per-state split we don't already get from
//     tables 5-12, so only 5-12 are ingested.
//
//   - Layout (wide-by-period, row-labelled): rows 0-3 title banner, row 5 the
//     period header (col A blank, then "Sep Qtr 2025", "Dec Qtr 2025",
//     "Mar Qtr 2026"), row 6 the unit row ("$m" under each period column),
//     rows 7+ one line item per row (label in col A, values across the period
//     columns). Section headers ("GFS Revenue", "less", "GFS Expenses", …)
//     carry no values. The three mandatory totals are the exact labels
//     "Total GFS revenue", "Total GFS expenses" and "GFS NET OPERATING BALANCE".
//     Four additive detail metrics are also captured. "Taxation revenue",
//     "Current grants and subsidies" (within GFS Revenue), and "Employee
//     expenses" use normalized, fail-soft label matching. Interest expense is
//     derived per period by summing the precisely matched GFS Expenses rows
//     "Interest on defined benefit superannuation" and "Other interest
//     expenses"; if either component is absent/suppressed, the available one
//     is used. The GFS Revenue row "Interest income" is never included. Missing
//     detail lines never make an otherwise healthy sheet fail.
//
//   - Period label "Sep Qtr 2025" is a workbook rendering, not an SDMX
//     TIME_PERIOD, so it's parsed locally by parseGovFinPeriod (mirroring
//     petroleum.go's local parsePetroleumMonth) rather than extending
//     absdata.PeriodDate, which stays SDMX-only. ABS names quarters by their
//     END month; the period date is normalised to the quarter's START month
//     (Sep Qtr 2025 => 2025-07-01) so it aligns with the start-of-quarter
//     convention every other quarterly series here uses (cpi/gdp via
//     absdata.PeriodDate).
//
//   - Scale: the unit row reads "$m" for every data column, so values are $
//     million and scaled by 1e6 to aud. Cross-check: NSW "Total GFS revenue"
//     Mar Qtr 2026 = 31398 => $31.4e9/quarter (~$125e9 annualised), squarely in
//     the expected $25-35e9/quarter band; WA = 13118 => $13.1e9; the eight
//     state sheets sum to Table 4 "Total State and Local" (109081 => $109e9),
//     confirming both the scale and that tables 5-12 partition the total. The
//     "$m" unit row is asserted per sheet (govfinUnitDollarMillion) and a drift
//     to any other unit fails the sheet loudly, so a silent rescaling by ABS
//     can't corrupt the series.
//
//   - History: each quarterly cube carries only the latest ~3 quarters, so a
//     single run yields 3 periods/state; re-runs accumulate history via the
//     (series_id, period) upsert. This is inherent to the ABS release, not a
//     parser limitation.
const (
	govfinPage    = "https://www.abs.gov.au/statistics/economy/government/government-finance-statistics-australia/latest-release"
	govfinSource  = "abs-government-finance"
	govfinLicence = absdata.Licence
	// govfinUnitDollarMillion is the unit-row label asserted on every data
	// column; a drift fails the sheet rather than silently mis-scaling.
	govfinUnitDollarMillion = "$m"
	govfinUnitScale         = 1e6
)

// govfinSheetSpec maps one per-state Operating Statement sheet to its region.
type govfinSheetSpec struct {
	SheetMatch string // exact sheet name, e.g. "Table 5"
	RegionCode string // lowercase region code, e.g. "nsw"
	RegionName string // display name, e.g. "New South Wales"
}

// govfinSheets pins the per-state general-government operating-statement sheets
// (Mar-2026 issue). One state per sheet; see the discovery block above.
var govfinSheets = []govfinSheetSpec{
	{"Table 5", "nsw", "New South Wales"},
	{"Table 6", "vic", "Victoria"},
	{"Table 7", "qld", "Queensland"},
	{"Table 8", "sa", "South Australia"},
	{"Table 9", "wa", "Western Australia"},
	{"Table 10", "tas", "Tasmania"},
	{"Table 11", "nt", "Northern Territory"},
	{"Table 12", "act", "Australian Capital Territory"},
}

// govfinMetrics maps the lowercased operating-statement total labels to the
// metric name. All three are REQUIRED on every sheet — a missing one is treated
// as layout drift and fails the sheet loudly.
var govfinMetrics = map[string]string{
	"total gfs revenue":         "revenue",
	"total gfs expenses":        "expenses",
	"gfs net operating balance": "net_operating_balance",
}

// govfinDetailLineItem is an optional operating-statement component. Section
// scoping is load-bearing for "Current grants and subsidies", whose wording can
// also occur on the expense side of an operating statement.
type govfinDetailLineItem struct {
	Metric  string
	Product string
	Section string
	Labels  []string
}

// Best-candidate label sets inferred from the pinned Mar-2026 layout notes.
// Matching is normalized and accepts trailing footnote markers, but each item
// remains optional so a live label drift cannot stale the mandatory totals.
var govfinDetailLineItems = []govfinDetailLineItem{
	{Metric: "revenue", Product: "taxation", Section: "revenue", Labels: []string{"Taxation revenue"}},
	{Metric: "revenue", Product: "grants", Section: "revenue", Labels: []string{"Current grants and subsidies"}},
	{Metric: "expenses", Product: "employees", Section: "expenses", Labels: []string{"Employee expenses"}},
}

// govfinInterestExpenseLabels are the exact live workbook components of the
// derived interest-expense metric. Matching uses normalized equality (not a
// substring/prefix), and callers additionally require the expenses section, so
// the revenue-side "Interest income" row cannot be included.
var govfinInterestExpenseLabels = []string{
	"Interest on defined benefit superannuation",
	"Other interest expenses",
}

const govfinInterestLineItem = "Interest on defined benefit superannuation + Other interest expenses"

var govfinLabelSeparatorRe = regexp.MustCompile(`[^a-z0-9]+`)

// normalizeGovFinLabel makes matching resilient to case, punctuation,
// ampersands and whitespace while preserving word order.
func normalizeGovFinLabel(label string) string {
	label = strings.ToLower(strings.ReplaceAll(label, "&", " and "))
	return strings.Join(govfinLabelSeparatorRe.Split(label, -1), " ")
}

func matchGovFinDetail(label, section string) (govfinDetailLineItem, bool) {
	normalized := strings.TrimSpace(normalizeGovFinLabel(label))
	for _, item := range govfinDetailLineItems {
		if item.Section != section {
			continue
		}
		for _, candidate := range item.Labels {
			want := strings.TrimSpace(normalizeGovFinLabel(candidate))
			if normalized == want || strings.HasPrefix(normalized, want+" ") {
				return item, true
			}
		}
	}
	return govfinDetailLineItem{}, false
}

func isGovFinInterestExpenseLabel(label string) bool {
	normalized := strings.TrimSpace(normalizeGovFinLabel(label))
	for _, candidate := range govfinInterestExpenseLabels {
		if normalized == strings.TrimSpace(normalizeGovFinLabel(candidate)) {
			return true
		}
	}
	return false
}

func ingestGovFin(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
	xlsxURL, err := discoverGovFinXLSX(ctx)
	if err != nil {
		return nil, err
	}
	f, err := fetchXLSX(ctx, xlsxURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return parseGovFinWorkbook(f, govfinSheets, xlsxURL)
}

// discoverGovFinXLSX resolves the current quarter's workbook URL from the ABS
// publication page (the sole discovery path — no data.gov.au mirror exists).
func discoverGovFinXLSX(ctx context.Context) (string, error) {
	body, err := httpGet(ctx, govfinPage, 60*time.Second, 8<<20)
	if err != nil {
		return "", fmt.Errorf("govfin publication page: %w", err)
	}
	m := xlsxLinkRe.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("no .xlsx link found on %s — layout changed", govfinPage)
	}
	link := string(m[1])
	if strings.HasPrefix(link, "/") {
		link = "https://www.abs.gov.au" + link
	}
	return link, nil
}

// parseGovFinWorkbook parses every configured state sheet, accumulating
// per-sheet failures instead of aborting on the first: one drifted state sheet
// must not stale the other seven. Healthy sheets' observations are returned
// ALONGSIDE a non-nil error when any sheet failed, so the caller persists what
// parsed while still failing the run loudly (non-zero exit) on drift.
func parseGovFinWorkbook(f *excelize.File, specs []govfinSheetSpec, sourceURL string) ([]Obs, error) {
	var all []Obs
	var errs []string
	for _, spec := range specs {
		obs, err := parseGovFinSheet(f, spec, sourceURL)
		if err != nil {
			errs = append(errs, fmt.Sprintf("sheet %q (%s): %v", spec.SheetMatch, spec.RegionCode, err))
			continue
		}
		all = append(all, obs...)
	}
	if len(errs) > 0 {
		return all, fmt.Errorf("%d/%d govfin sheets failed: %s", len(errs), len(specs), strings.Join(errs, "; "))
	}
	return all, nil
}

func parseGovFinSheet(f *excelize.File, spec govfinSheetSpec, sourceURL string) ([]Obs, error) {
	sheet := findSheet(f, spec.SheetMatch)
	if sheet == "" {
		return nil, fmt.Errorf("no sheet matching %q (have %v)", spec.SheetMatch, f.GetSheetList())
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, err
	}

	// Locate the period header row: the first row with at least one column
	// (beyond col A) whose cell parses as a GFS quarter. Record col -> period.
	headerIdx := -1
	periods := map[int]time.Time{}
	for i, row := range rows {
		cols := map[int]time.Time{}
		for col := 1; col < len(row); col++ {
			if p, ok := parseGovFinPeriod(row[col]); ok {
				cols[col] = p
			}
		}
		if len(cols) > 0 {
			headerIdx, periods = i, cols
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("no period header row found — layout drift")
	}

	// The row directly below the period header must state the unit ("$m") for
	// every period column; a drift there means the $-million scaling assumption
	// is broken, so fail loudly rather than mis-scale by orders of magnitude.
	if headerIdx+1 >= len(rows) {
		return nil, fmt.Errorf("no unit row below period header — layout drift")
	}
	unitRow := rows[headerIdx+1]
	for col := range periods {
		got := ""
		if col < len(unitRow) {
			got = strings.TrimSpace(unitRow[col])
		}
		if !strings.EqualFold(got, govfinUnitDollarMillion) {
			return nil, fmt.Errorf("unit cell for period column %d = %q, want %q — scale drift", col, got, govfinUnitDollarMillion)
		}
	}

	var obs []Obs
	seenTotals := map[string]bool{}
	interestByPeriod := map[time.Time]float64{}
	section := ""
	for _, row := range rows[headerIdx+2:] {
		if len(row) == 0 {
			continue
		}
		label := strings.TrimSpace(row[0])
		normalizedLabel := strings.TrimSpace(normalizeGovFinLabel(label))
		switch normalizedLabel {
		case "gfs revenue":
			section = "revenue"
			continue
		case "gfs expenses":
			section = "expenses"
			continue
		}

		if section == "expenses" && isGovFinInterestExpenseLabel(label) {
			for col, period := range periods {
				if col >= len(row) {
					continue
				}
				val, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(row[col]), ",", ""), 64)
				if err != nil {
					continue // one suppressed component does not suppress the other
				}
				interestByPeriod[period] += val * govfinUnitScale
			}
			continue
		}

		metric, aggregate := govfinMetrics[strings.ToLower(label)]
		product := "total"
		if aggregate {
			seenTotals[metric] = true
		} else if detail, ok := matchGovFinDetail(label, section); ok {
			metric, product = detail.Metric, detail.Product
		} else {
			continue
		}
		for col, period := range periods {
			if col >= len(row) {
				continue
			}
			val, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(row[col]), ",", ""), 64)
			if err != nil {
				continue // "n.a."/"n.p."/"-"/blank suppression markers
			}
			obs = append(obs, Obs{
				Series: SeriesDef{
					Topic: "govfin", Metric: metric, Product: product,
					RegionType: "state", RegionCode: spec.RegionCode, RegionName: spec.RegionName,
					Unit: "aud", Frequency: "quarterly", Adjustment: "original",
					SourceKey: govfinSource, Licence: govfinLicence,
					Dimensions: map[string]string{
						"abs_catalogue": "5519.0.55.001",
						"sheet":         sheet,
						"line_item":     label,
						"source_url":    sourceURL,
					},
				},
				Period: period,
				Value:  val * govfinUnitScale,
			})
		}
	}

	// Emit one observation per period after both precisely named interest rows
	// have had a chance to contribute. A single available component is valid;
	// no available components simply means this optional detail series is absent.
	for period, value := range interestByPeriod {
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "govfin", Metric: "expenses", Product: "interest",
				RegionType: "state", RegionCode: spec.RegionCode, RegionName: spec.RegionName,
				Unit: "aud", Frequency: "quarterly", Adjustment: "original",
				SourceKey: govfinSource, Licence: govfinLicence,
				Dimensions: map[string]string{
					"abs_catalogue": "5519.0.55.001",
					"sheet":         sheet,
					"line_item":     govfinInterestLineItem,
					"derivation":    "sum_available_components",
					"source_url":    sourceURL,
				},
			},
			Period: period,
			Value:  value,
		})
	}

	// Fail closed on drift: all three totals must be present on every state
	// sheet. A silently renamed/dropped total would otherwise thin the series
	// without any error.
	var missing []string
	for _, want := range []string{"revenue", "expenses", "net_operating_balance"} {
		if !seenTotals[want] {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		return obs, fmt.Errorf("missing operating-statement total(s) %v — layout drift", missing)
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("0 observations parsed — layout drift")
	}
	return obs, nil
}

// govfinPeriodRe matches the ABS quarter label "<Month> Qtr <Year>", e.g.
// "Sep Qtr 2025". ABS names a quarter by its END month.
var govfinPeriodRe = regexp.MustCompile(`(?i)^([A-Za-z]{3,})\s+Qtr\s+(\d{4})$`)

// govfinMonths maps month names (abbreviated + full) to month numbers.
var govfinMonths = map[string]int{
	"jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
	"apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
	"aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10,
	"nov": 11, "november": 11, "dec": 12, "december": 12,
}

// parseGovFinPeriod parses "Sep Qtr 2025" into the FIRST day of that quarter
// (2025-07-01), matching the start-of-quarter convention of the other
// quarterly series. ABS labels quarters by end month, so the start month is
// derived from the quarter the end month falls in.
func parseGovFinPeriod(s string) (time.Time, bool) {
	m := govfinPeriodRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return time.Time{}, false
	}
	endMonth, ok := govfinMonths[strings.ToLower(m[1])]
	if !ok {
		return time.Time{}, false
	}
	year, err := strconv.Atoi(m[2])
	if err != nil {
		return time.Time{}, false
	}
	startMonth := ((endMonth-1)/3)*3 + 1
	return time.Date(year, time.Month(startMonth), 1, 0, 0, 0, 0, time.UTC), true
}
