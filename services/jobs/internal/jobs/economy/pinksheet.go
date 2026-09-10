package economy

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/xuri/excelize/v2"
)

// World Bank "Pink Sheet" — monthly commodity spot prices (CC-BY 4.0).
//
// Why this source. The ASX is resources-weighted and the catalog had no spot
// commodity price at all: RBA's I2 gives INDICES (bulk, base metals, rural),
// which is a different instrument from a tonne of iron ore, and FRED carries
// crude but not the metals — its LBMA gold series was dropped when LBMA
// restricted redistribution. The Pink Sheet is the one free, redistributable
// source covering the actual Australian export basket.
//
// PROBED 2026-09-09. Sheet "Monthly Prices": row 5 = series names, row 6 =
// units, row 7+ = data with column A as "1960M01"-style periods. Magnitude
// cross-checks at 2026M08, the last non-empty month:
//
//	Iron ore, cfr spot    96.30 $/dmtu
//	Gold               4,411.00 $/troy oz
//	Coal, Australian     135.20 $/mt
//
// THE URL MUST BE DISCOVERED, NEVER PINNED — the lesson petroleum.go already
// carries, re-learned here the hard way. The workbook lives under a path
// containing the issue year (…-0050012025/… vs …-0050012026/…), so a stale link
// does not 404: it returns a valid, parseable workbook that simply stopped
// being current. The 2025 path was still serving data through 2025M12 with an
// "Updated on January 06, 2025" header on 2026-09-09 — an importer pinned to it
// would have imported plausible prices, passed every check, and been eight
// months stale forever.
//
// MISSING VALUES ARE "…" (U+2026), not blank. Parsed as a float that is 0.0,
// which for gold reads as a free ounce; excluded rather than defaulted, the same
// rule as FRED's ".".
//
// KEYS COME FROM A STATIC MAP, never from the column label. Labels carry
// footnote markers that move between issues ("Coal, South African **"), and a
// label-derived key would fork the history the first time one changed.
const (
	pinkSheetPage      = "https://www.worldbank.org/en/research/commodity-markets"
	pinkSheetSheetName = "Monthly Prices"
	pinkSheetNameRow   = 5 // 1-indexed: series names
	pinkSheetUnitRow   = 6 // units, e.g. ($/mt)
	pinkSheetFirstData = 7
)

// pinkSeries maps an EXACT column label to a stable catalog entry. Matching is
// on the label to find the column (positions shift as columns are added) while
// the key is fixed here, so a renamed column fails loudly as "column not found"
// rather than silently writing a new series_key.
type pinkSeries struct {
	Label   string // exact text in row 5
	Metric  string
	Product string
	Unit    string
	Note    string
}

var pinkSeriesDefs = []pinkSeries{
	// ── Bulk: what Australia digs up and ships ────────────────────────────
	{"Iron ore, cfr spot", "spot_price", "iron_ore", "usd_per_dmtu",
		"Iron ore cfr spot, China import. Australia's largest single export."},
	{"Coal, Australian", "spot_price", "coal_australian", "usd_per_metric_ton",
		"Newcastle thermal coal — the Australian benchmark."},
	{"Coal, South African", "spot_price", "coal_south_african", "usd_per_metric_ton",
		"Richards Bay thermal coal. The competing benchmark: the Newcastle-Richards Bay " +
			"spread is what an Australian producer's margin actually turns on."},

	// ── Gas ───────────────────────────────────────────────────────────────
	// Three regional prices, not one: gas does not arbitrage across oceans, so
	// Henry Hub, TTF and landed-Japan LNG diverge by multiples and the spread
	// between them IS the Australian LNG export story.
	{"Liquefied natural gas, Japan", "spot_price", "lng_japan", "usd_per_mmbtu",
		"LNG landed Japan — a major destination for Australian LNG."},
	{"Natural gas, Europe", "spot_price", "natural_gas_europe", "usd_per_mmbtu",
		"European natural gas (TTF-equivalent), the marginal buyer for spot LNG cargoes."},
	{"Natural gas, US", "spot_price", "natural_gas_us", "usd_per_mmbtu",
		"US natural gas (Henry Hub), monthly average."},

	// ── Base metals (LME) ─────────────────────────────────────────────────
	{"Copper", "spot_price", "copper", "usd_per_metric_ton", "LME copper."},
	{"Aluminum", "spot_price", "aluminium", "usd_per_metric_ton",
		"LME aluminium. Column label uses the US spelling; the key does not."},
	{"Nickel", "spot_price", "nickel", "usd_per_metric_ton", "LME nickel."},
	{"Zinc", "spot_price", "zinc", "usd_per_metric_ton", "LME zinc."},
	{"Lead", "spot_price", "lead", "usd_per_metric_ton", "LME lead."},
	{"Tin", "spot_price", "tin", "usd_per_metric_ton", "LME tin."},

	// ── Precious ──────────────────────────────────────────────────────────
	{"Gold", "spot_price", "gold", "usd_per_troy_oz", "Gold spot."},
	{"Silver", "spot_price", "silver", "usd_per_troy_oz", "Silver spot."},
	{"Platinum", "spot_price", "platinum", "usd_per_troy_oz", "Platinum spot."},

	// ── Fertiliser ────────────────────────────────────────────────────────
	// The input cost behind the ASX fertiliser and explosives names, and one of
	// the few commodity groups whose price moves an industrial margin directly
	// rather than through a mined volume.
	{"Urea", "spot_price", "urea", "usd_per_metric_ton", "Urea, granular, fob."},
	{"DAP", "spot_price", "dap", "usd_per_metric_ton", "Diammonium phosphate, fob."},
	{"Phosphate rock", "spot_price", "phosphate_rock", "usd_per_metric_ton", "Phosphate rock, fob."},
	{"Potassium chloride", "spot_price", "potassium_chloride", "usd_per_metric_ton",
		"Muriate of potash, fob."},

	// ── Agriculture ───────────────────────────────────────────────────────
	// Barley and Sorghum are DELIBERATELY ABSENT despite being the obvious
	// Australian grains: both columns exist in the workbook and both read "…"
	// at the tail (checked 2026-09-10). Importing them would produce a chart
	// that stops years short with nothing on the page saying why.
	{"Wheat, US HRW", "spot_price", "wheat_us_hrw", "usd_per_metric_ton",
		"US hard red winter wheat, fob Gulf — the global grain benchmark."},
	{"Cotton, A Index", "spot_price", "cotton", "usd_per_kg", "Cotton, Cotlook A index."},
	{"Sugar, world", "spot_price", "sugar", "usd_per_kg", "Raw sugar, world price."},
	{"Beef", "spot_price", "beef", "usd_per_kg",
		"Beef, Australian and New Zealand cif US — the export price for Australian cattle."},
}

// normalisePinkLabel strips the footnote markers the workbook attaches to some
// column headers ("Coal, South African **", "Beef **"). The markers move
// between issues — they mark a definitional note, not the series — so matching
// on the raw text makes an unrelated editorial change look like a dropped
// column. Only trailing markers are stripped; the label text itself is matched
// exactly, so "Coal, Australian" still cannot match "Coal, South African".
func normalisePinkLabel(s string) string {
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(s), "*"))
}

func ingestPinkSheet(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
	xlsxURL, err := discoverPinkSheetXLSX(ctx)
	if err != nil {
		return nil, err
	}
	body, err := httpGet(ctx, xlsxURL, 90*time.Second, 32<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch pink sheet %s: %w", xlsxURL, err)
	}
	f, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("open pink sheet workbook: %w", err)
	}
	defer f.Close() //nolint:errcheck
	return parsePinkSheet(f, xlsxURL)
}

// discoverPinkSheetXLSX resolves the CURRENT monthly workbook from the release
// page. Only the page URL is stable enough to pin.
func discoverPinkSheetXLSX(ctx context.Context) (string, error) {
	body, err := httpGet(ctx, pinkSheetPage, 60*time.Second, 8<<20)
	if err != nil {
		return "", fmt.Errorf("commodity markets page: %w", err)
	}
	return selectPinkSheetLink(pinkSheetPage, body)
}

// selectPinkSheetLink picks the MONTHLY historical workbook. The page also
// advertises an Annual file whose name differs by one word, so the match is
// explicit about both halves rather than taking the first CMO xlsx it sees.
func selectPinkSheetLink(pageURL string, body []byte) (string, error) {
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("parse commodity markets page: %w", err)
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return "", fmt.Errorf("parse commodity markets URL: %w", err)
	}

	var selected string
	doc.Find("a[href]").EachWithBreak(func(_ int, a *goquery.Selection) bool {
		href, ok := a.Attr("href")
		if !ok {
			return true
		}
		lower := strings.ToLower(href)
		if !strings.HasSuffix(lower, ".xlsx") ||
			!strings.Contains(lower, "cmo-historical-data-monthly") {
			return true
		}
		if ref, parseErr := url.Parse(href); parseErr == nil {
			selected = base.ResolveReference(ref).String()
			return false
		}
		return true
	})
	if selected == "" {
		return "", fmt.Errorf("no CMO-Historical-Data-Monthly.xlsx link on %s — the release page layout changed", pageURL)
	}
	return selected, nil
}

func parsePinkSheet(f *excelize.File, xlsxURL string) ([]Obs, error) {
	return parsePinkSheetFor(f, xlsxURL, pinkSeriesDefs)
}

// parsePinkSheetFor takes the wanted series explicitly so tests can drive it
// with a two-column workbook instead of a fixture carrying all 72 columns.
func parsePinkSheetFor(f *excelize.File, xlsxURL string, defs []pinkSeries) ([]Obs, error) {
	rows, err := f.GetRows(pinkSheetSheetName)
	if err != nil {
		return nil, fmt.Errorf("read sheet %q: %w", pinkSheetSheetName, err)
	}
	if len(rows) < pinkSheetFirstData {
		return nil, fmt.Errorf("sheet %q has %d rows, expected at least %d — layout changed",
			pinkSheetSheetName, len(rows), pinkSheetFirstData)
	}
	names := rows[pinkSheetNameRow-1]

	// Resolve each wanted label to a column index. A label we cannot find is a
	// hard error: silently importing 7 of 8 series would leave a gap that only
	// shows up as a chart with no line.
	// Normalising the header row can, in principle, make two distinct columns
	// collide ("Beef" and "Beef **" both becoming "Beef"). That would silently
	// bind a series to whichever came first, so it is checked rather than
	// assumed: a collision is format drift and fails the whole import.
	byLabel := make(map[string]int, len(names))
	for i, n := range names {
		norm := normalisePinkLabel(n)
		if norm == "" {
			continue
		}
		if prev, dup := byLabel[norm]; dup {
			return nil, fmt.Errorf("columns %d and %d both normalise to %q in %q — ambiguous header",
				prev, i, norm, pinkSheetSheetName)
		}
		byLabel[norm] = i
	}

	cols := make(map[string]int, len(defs))
	for _, def := range defs {
		idx, ok := byLabel[normalisePinkLabel(def.Label)]
		if !ok {
			return nil, fmt.Errorf("column %q not found in %q — the label changed or the column was dropped",
				def.Label, pinkSheetSheetName)
		}
		cols[def.Label] = idx
	}

	var out []Obs
	for _, def := range defs {
		series := SeriesDef{
			Topic:   "commodities",
			Metric:  def.Metric,
			Product: def.Product,
			// national, for the same reason as the FRED series:
			// eligibleCorrelationOverlay pairs an overlay with an AU base on
			// `RegionCode == base.RegionCode || RegionType == "national"`, so a
			// global price must be national to be usable as an overlay at all.
			// The region CODE carries the honesty that this is a world price.
			RegionType: "national",
			RegionCode: "world",
			RegionName: "World",
			Unit:       def.Unit,
			Frequency:  "monthly",
			Adjustment: "original",
			Dimensions: map[string]string{
				"pink_sheet_label": def.Label,
				"source_url":       xlsxURL,
			},
			SourceKey: "worldbank-pink-sheet",
			Licence:   "CC-BY-4.0",
		}
		col := cols[def.Label]
		for _, row := range rows[pinkSheetFirstData-1:] {
			if col >= len(row) {
				continue
			}
			period, ok := parsePinkPeriod(row[0])
			if !ok {
				continue
			}
			value, ok := parsePinkValue(row[col])
			if !ok {
				continue
			}
			out = append(out, Obs{Series: series, Period: period, Value: value})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("pink sheet produced 0 observations — treating as format drift, not success")
	}
	return out, nil
}

// parsePinkPeriod turns "2026M08" into the first of that month.
func parsePinkPeriod(cell string) (time.Time, bool) {
	s := strings.TrimSpace(cell)
	year, month, found := strings.Cut(s, "M")
	if !found {
		return time.Time{}, false
	}
	y, err := strconv.Atoi(year)
	if err != nil {
		return time.Time{}, false
	}
	m, err := strconv.Atoi(month)
	if err != nil || m < 1 || m > 12 {
		return time.Time{}, false
	}
	return time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.UTC), true
}

// parsePinkValue rejects the "…" missing marker rather than defaulting it.
func parsePinkValue(cell string) (float64, bool) {
	s := strings.TrimSpace(cell)
	// U+2026 HORIZONTAL ELLIPSIS, and the ASCII spelling some issues use.
	if s == "" || s == "…" || s == "..." || s == ".." {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
