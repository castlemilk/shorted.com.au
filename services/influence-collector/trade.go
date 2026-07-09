package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ABS International Trade in Goods (SDMX Data API). Free, CC-BY-4.0, no key —
// but a bare request 403s at the WAF, so the User-Agent + SDMX-CSV Accept
// headers are mandatory (same posture as services/house-price-collector/abs.go;
// helpers are local copies, the housing collector is a separate main package).
//
// Dataflows (verified live 2026-07-09):
//   ABS,MERCH_EXP,1.0.0  COMMODITY_SITC.COUNTRY_DEST.STATE_ORIGIN.FREQ
//   ABS,MERCH_IMP,1.0.0  COMMODITY_SITC.COUNTRY_ORIGIN.STATE_DEST.FREQ
// We pull national totals only (COUNTRY=TOT, STATE=TOT, monthly). OBS_VALUE is
// AUD thousands (UNIT_MULT=3) — scaled to raw AUD via the UNIT_MULT column.
// Basis: exports FOB; imports customs value. Original terms (not seasonally
// adjusted); recent months are revised upstream, which the deterministic
// source_record_id + ON CONFLICT DO UPDATE in upsertIndustryRecords absorbs.
const (
	tradeSource          = "abs-international-trade-goods"
	tradeSourceURL       = "https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release"
	absTradeBase         = "https://data.api.abs.gov.au/rest/data"
	absTradeCSVAccept    = "application/vnd.sdmx.data+csv;labels=both"
	absTradeStartPeriod  = "2015-01"
	absMerchExportFlow   = "ABS,MERCH_EXP,1.0.0"
	absMerchImportFlow   = "ABS,MERCH_IMP,1.0.0"
	tradeDirectionExport = "export"
	tradeDirectionImport = "import"
)

// absTradeMapping maps one ABS CL_MERCH_SITC commodity code (2-digit SITC
// division or 3-digit group) to a "company-metadata".industry string.
type absTradeMapping struct {
	Code      string // SITC code as used by the COMMODITY_SITC dimension
	Label     string // CL_MERCH_SITC label (descriptive; codes drive matching)
	Industry  string // exact "company-metadata".industry value
	Rationale string // why this commodity is a defensible ~1→1 industry read
}

// absTradeIndustryMap is the REVIEWED SITC commodity → GICS industry crosswalk.
// Reviewed 2026-07-09. INDUSTRY-LEVEL ONLY: records built from this map are
// aggregates across commodities and carry NO stock_code and NO entity_abn —
// no company-level claim is ever made from this source. Only commodities with
// a defensible ~1→1 industry reading are mapped; anything ambiguous
// (e.g. SITC 89 miscellaneous manufactures) is deliberately excluded.
// Industry strings match "company-metadata".industry exactly (verified against
// the local dataset 2026-07-09).
var absTradeIndustryMap = []absTradeMapping{
	// ── Food, Beverage & Tobacco: the agrifood export complex ────────────────
	{Code: "01", Label: "Meat and meat preparations", Industry: "Food, Beverage & Tobacco", Rationale: "Beef/lamb processors and exporters sit in GICS Food, Beverage & Tobacco."},
	{Code: "02", Label: "Dairy products and birds' eggs", Industry: "Food, Beverage & Tobacco", Rationale: "Dairy producers and processors (Bega-type) are Food, Beverage & Tobacco."},
	{Code: "03", Label: "Fish, crustaceans, molluscs and preparations thereof", Industry: "Food, Beverage & Tobacco", Rationale: "Aquaculture and seafood producers (Tassal-type) are Food, Beverage & Tobacco."},
	{Code: "04", Label: "Cereals and cereal preparations", Industry: "Food, Beverage & Tobacco", Rationale: "Grain handlers and processors (GrainCorp-type) are Food, Beverage & Tobacco."},
	{Code: "05", Label: "Vegetables and fruit", Industry: "Food, Beverage & Tobacco", Rationale: "Horticultural producers (Costa-type) are Food, Beverage & Tobacco."},
	{Code: "06", Label: "Sugars, sugar preparations and honey", Industry: "Food, Beverage & Tobacco", Rationale: "Sugar and honey producers are Food, Beverage & Tobacco."},
	{Code: "07", Label: "Coffee, tea, cocoa, spices, and manufactures thereof", Industry: "Food, Beverage & Tobacco", Rationale: "Packaged food and beverage-input manufacturers are Food, Beverage & Tobacco."},
	{Code: "08", Label: "Feeding stuff for animals (not including unmilled cereals)", Industry: "Food, Beverage & Tobacco", Rationale: "Stockfeed is an agrifood-processing product line within Food, Beverage & Tobacco."},
	{Code: "09", Label: "Miscellaneous edible products and preparations", Industry: "Food, Beverage & Tobacco", Rationale: "Packaged edible products map to Food, Beverage & Tobacco manufacturers."},
	{Code: "11", Label: "Beverages", Industry: "Food, Beverage & Tobacco", Rationale: "Wine and beverage exporters (Treasury Wine-type) are Food, Beverage & Tobacco."},
	{Code: "12", Label: "Tobacco and tobacco manufactures", Industry: "Food, Beverage & Tobacco", Rationale: "Tobacco is a named constituent of GICS Food, Beverage & Tobacco."},
	{Code: "22", Label: "Oil-seeds and oleaginous fruits", Industry: "Food, Beverage & Tobacco", Rationale: "Canola/oilseed handling belongs to the agrifood complex (GrainCorp-type)."},

	// ── Materials: mining, metals, chemicals, forestry and packaging ─────────
	{Code: "28", Label: "Metalliferous ores and metal scrap", Industry: "Materials", Rationale: "Iron ore/copper/gold concentrates — the BHP/RIO/FMG export line."},
	{Code: "97", Label: "Gold, non-monetary (excluding gold ores and concentrates)", Industry: "Materials", Rationale: "Gold miners (NST/EVN-type); bullion is a Materials-sector product."},
	{Code: "68", Label: "Non-ferrous metals", Industry: "Materials", Rationale: "Refined Al/Cu/Ni/Zn — smelter output (S32-type producers)."},
	{Code: "67", Label: "Iron and steel", Industry: "Materials", Rationale: "Steelmakers (BSL-type) sit in GICS Materials."},
	{Code: "27", Label: "Crude fertilizers and crude minerals", Industry: "Materials", Rationale: "Mineral sands and phosphate rock (ILU-type producers)."},
	{Code: "56", Label: "Fertilizers (other than those of group 272)", Industry: "Materials", Rationale: "Manufactured fertilisers are GICS Chemicals (IPL-type)."},
	{Code: "51", Label: "Organic chemicals", Industry: "Materials", Rationale: "Organic chemicals are GICS Chemicals within Materials."},
	{Code: "52", Label: "Inorganic chemicals", Industry: "Materials", Rationale: "Inorganic chemicals are GICS Chemicals within Materials."},
	{Code: "57", Label: "Plastics in primary forms", Industry: "Materials", Rationale: "Primary plastics are GICS Chemicals within Materials."},
	{Code: "58", Label: "Plastics in non-primary forms", Industry: "Materials", Rationale: "Non-primary plastics are GICS Chemicals within Materials."},
	{Code: "25", Label: "Pulp and waste paper", Industry: "Materials", Rationale: "Pulp is GICS Paper & Forest Products within Materials."},
	{Code: "64", Label: "Paper, paperboard and articles of paper pulp, of paper or of paperboard", Industry: "Materials", Rationale: "Paper and packaging converts to GICS Containers & Packaging (ORA-type)."},
	{Code: "24", Label: "Cork and wood", Industry: "Materials", Rationale: "Timber is GICS Paper & Forest Products within Materials."},

	// ── Energy: coal, petroleum and gas ──────────────────────────────────────
	{Code: "32", Label: "Coal, coke and briquettes", Industry: "Energy", Rationale: "Coal producers (WHC/YAL-type) sit in GICS Energy."},
	{Code: "33", Label: "Petroleum, petroleum products and related materials", Industry: "Energy", Rationale: "Oil producers and refiners (WDS/STO/VEA-type) are GICS Energy."},
	{Code: "34", Label: "Gas, natural and manufactured", Industry: "Energy", Rationale: "LNG export volumes come from GICS Energy producers (WDS/STO-type), not gas utilities."},

	// ── Health care ──────────────────────────────────────────────────────────
	{Code: "54", Label: "Medicinal and pharmaceutical products", Industry: "Pharmaceuticals, Biotechnology & Life Sciences", Rationale: "Plasma/pharma exports (CSL-type) map to Pharmaceuticals, Biotechnology & Life Sciences."},
	{Code: "872", Label: "Instruments and appliances, n.e.s., for medical, surgical, dental or veterinary purposes", Industry: "Health Care Equipment & Services", Rationale: "Medical devices (RMD/COH-type) map to Health Care Equipment & Services."},

	// ── Capital Goods: machinery and building products ───────────────────────
	{Code: "71", Label: "Power-generating machinery and equipment", Industry: "Capital Goods", Rationale: "Power-generation machinery is GICS Machinery within Capital Goods."},
	{Code: "72", Label: "Machinery specialized for particular industries", Industry: "Capital Goods", Rationale: "Specialised (incl. mining) machinery is GICS Machinery within Capital Goods."},
	{Code: "73", Label: "Metalworking machinery", Industry: "Capital Goods", Rationale: "Metalworking machinery is GICS Machinery within Capital Goods."},
	{Code: "74", Label: "General industrial machinery and equipment, n.e.s., and machine parts, n.e.s.", Industry: "Capital Goods", Rationale: "General industrial machinery is GICS Machinery within Capital Goods."},
	{Code: "81", Label: "Prefabricated buildings; sanitary, plumbing, heating and lighting fixtures and fittings, n.e.s.", Industry: "Capital Goods", Rationale: "Building products (RWC/JHX-type lines) sit under GICS Capital Goods."},

	// ── Transport equipment ──────────────────────────────────────────────────
	{Code: "78", Label: "Road vehicles (incl. air-cushion vehicles)", Industry: "Automobiles & Components", Rationale: "Road vehicles and components map to GICS Automobiles & Components (ARB-type)."},
	{Code: "79", Label: "Other transport equipment", Industry: "Transportation", Rationale: "Aircraft, ships and rolling stock are the fleet capital goods of transport operators (QAN/AZJ-type fleet trade)."},

	// ── Technology hardware ──────────────────────────────────────────────────
	{Code: "75", Label: "Office machines and automatic data-processing machines", Industry: "Technology Hardware & Equipment", Rationale: "Computing hardware maps to GICS Technology Hardware & Equipment."},
	{Code: "76", Label: "Telecommunications and sound-recording and reproducing apparatus and equipment", Industry: "Technology Hardware & Equipment", Rationale: "Comms equipment (CDA-type) maps to GICS Technology Hardware & Equipment."},
	{Code: "776", Label: "Thermionic, cold cathode or photo-cathode valves and tubes (incl. semiconductor devices)", Industry: "Semiconductors & Semiconductor Equipment", Rationale: "Semiconductor devices map to GICS Semiconductors & Semiconductor Equipment."},
}

// TradeRow is one commodity × month observation from a MERCH_* dataflow,
// scaled to raw AUD (UNIT_MULT applied).
type TradeRow struct {
	Direction      string // tradeDirectionExport | tradeDirectionImport
	CommodityCode  string // COMMODITY_SITC code, e.g. "28" or "776"
	CommodityLabel string // COMMODITY_SITC label
	Period         string // ABS monthly TIME_PERIOD, e.g. "2025-03"
	Value          float64
	Unit           string // UNIT_MEASURE code, e.g. "AUD"
}

// absTradeCommodityKey builds the +-joined COMMODITY_SITC key from the reviewed
// crosswalk (mixing 2- and 3-digit codes in one key is legal SDMX).
func absTradeCommodityKey() string {
	codes := make([]string, 0, len(absTradeIndustryMap))
	for _, m := range absTradeIndustryMap {
		codes = append(codes, m.Code)
	}
	return strings.Join(codes, "+")
}

// fetchABSTradeCSV GETs one dataflow as SDMX-CSV with the mandatory WAF-safe
// headers (bare requests 403 — never bypass; these are the ABS's published
// API conventions, mirrored from the housing collector's abs.go).
func fetchABSTradeCSV(ctx context.Context, dataflow, key, startPeriod string) ([]byte, error) {
	url := fmt.Sprintf("%s/%s/%s?startPeriod=%s", absTradeBase, dataflow, key, startPeriod)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", influenceUA)
	req.Header.Set("Accept", absTradeCSVAccept)

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("ABS %s: HTTP %d: %s", dataflow, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return io.ReadAll(resp.Body)
}

// ingestABSTrade fetches national monthly totals for both merchandise trade
// directions, restricted to the reviewed crosswalk's commodity codes.
func ingestABSTrade(ctx context.Context) ([]TradeRow, error) {
	key := absTradeCommodityKey() + ".TOT.TOT.M"
	var all []TradeRow
	for _, pull := range []struct {
		dataflow  string
		direction string
	}{
		{absMerchExportFlow, tradeDirectionExport},
		{absMerchImportFlow, tradeDirectionImport},
	} {
		data, err := fetchABSTradeCSV(ctx, pull.dataflow, key, absTradeStartPeriod)
		if err != nil {
			return all, fmt.Errorf("fetch %s: %w", pull.dataflow, err)
		}
		rows, err := parseABSTradeCSV(data, pull.direction)
		if err != nil {
			return all, fmt.Errorf("parse %s: %w", pull.dataflow, err)
		}
		all = append(all, rows...)
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("no ABS trade rows parsed")
	}
	return all, nil
}

// parseABSTradeCSV parses an SDMX-CSV (labels=both) MERCH_EXP/MERCH_IMP body.
// Columns are resolved by NAME so exports (COUNTRY_DEST/STATE_ORIGIN) and
// imports (COUNTRY_ORIGIN/STATE_DEST) share one parser.
func parseABSTradeCSV(data []byte, direction string) ([]TradeRow, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("ABS trade CSV has no data rows")
	}

	c := absTradeColIndex(rows[0])
	commodityIdx, okCommodity := c["COMMODITY_SITC"]
	periodIdx, okPeriod := c["TIME_PERIOD"]
	valueIdx, okValue := c["OBS_VALUE"]
	if !okCommodity || !okPeriod || !okValue {
		return nil, fmt.Errorf("ABS trade CSV missing required columns (have %v)", rows[0])
	}
	unitIdx, hasUnit := c["UNIT_MEASURE"]
	multIdx, hasMult := c["UNIT_MULT"]

	var out []TradeRow
	for _, row := range rows[1:] {
		commodityCell := readColumn(row, commodityIdx)
		code := absTradeCode(commodityCell)
		period := readColumn(row, periodIdx)
		if code == "" || period == "" {
			continue
		}
		if _, _, err := monthPeriodDates(period); err != nil {
			continue // only monthly YYYY-MM periods are in scope
		}
		val, err := strconv.ParseFloat(readColumn(row, valueIdx), 64)
		if err != nil {
			continue
		}
		if hasMult {
			val = absTradeApplyMult(val, readColumn(row, multIdx))
		}
		unit := "AUD"
		if hasUnit {
			if u := absTradeCode(readColumn(row, unitIdx)); u != "" {
				unit = u
			}
		}
		out = append(out, TradeRow{
			Direction:      direction,
			CommodityCode:  code,
			CommodityLabel: absTradeLabel(commodityCell),
			Period:         period,
			Value:          val,
			Unit:           unit,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no ABS trade observations parsed")
	}
	return out, nil
}

// buildTradeIndustryRecords aggregates commodity rows to industry × period ×
// direction records. Records are INDUSTRY-LEVEL: StockCode and EntityABN stay
// empty (NULL in the database) — no company-level claim is made. Returns the
// records plus the count of rows skipped (commodity not in the crosswalk).
func buildTradeIndustryRecords(rows []TradeRow) ([]IndustryRecord, int) {
	industryByCode := make(map[string]string, len(absTradeIndustryMap))
	for _, m := range absTradeIndustryMap {
		industryByCode[m.Code] = m.Industry
	}

	type aggKey struct {
		industry  string
		direction string
		period    string
	}
	type agg struct {
		total float64
		unit  string
		codes map[string]bool
	}
	sums := map[aggKey]*agg{}
	skipped := 0
	for _, row := range rows {
		industry, ok := industryByCode[row.CommodityCode]
		if !ok {
			skipped++
			continue
		}
		k := aggKey{industry, row.Direction, row.Period}
		a := sums[k]
		if a == nil {
			a = &agg{unit: row.Unit, codes: map[string]bool{}}
			sums[k] = a
		}
		a.total += row.Value
		a.codes[row.CommodityCode] = true
	}

	keys := make([]aggKey, 0, len(sums))
	for k := range sums {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].industry != keys[j].industry {
			return keys[i].industry < keys[j].industry
		}
		if keys[i].direction != keys[j].direction {
			return keys[i].direction < keys[j].direction
		}
		return keys[i].period < keys[j].period
	})

	records := make([]IndustryRecord, 0, len(keys))
	for _, k := range keys {
		a := sums[k]
		start, end, err := monthPeriodDates(k.period)
		if err != nil {
			continue
		}
		codes := make([]string, 0, len(a.codes))
		for code := range a.codes {
			codes = append(codes, code)
		}
		sort.Strings(codes)

		metricKey, metricLabel, noun, valuation, dataflow := "export_value",
			"Merchandise exports (mapped commodities)", "merchandise exports",
			"free on board (FOB)", absMerchExportFlow
		if k.direction == tradeDirectionImport {
			metricKey, metricLabel, noun, valuation, dataflow = "import_value",
				"Merchandise imports (mapped commodities)", "merchandise imports",
				"customs value", absMerchImportFlow
		}

		value := a.total
		periodLabel := end.Format("January 2006")
		records = append(records, IndustryRecord{
			SourceKey:      tradeSource,
			SourceRecordID: tradeRecordID(k.direction, k.industry, k.period),
			SignalKind:     "trade_exposure",
			Industry:       k.industry,
			StockCode:      "", // industry-level: never a company claim
			EntityABN:      "", // industry-level: never a company claim
			MetricKey:      metricKey,
			MetricLabel:    metricLabel,
			MetricValue:    &value,
			Unit:           a.unit,
			PeriodStart:    &start,
			PeriodEnd:      &end,
			AsOf:           end,
			Title:          fmt.Sprintf("%s %s: %s", k.industry, noun, periodLabel),
			Summary: fmt.Sprintf("ABS reported $%sm of %s across commodities mapped to %s for %s.",
				formatMillions(a.total), noun, k.industry, periodLabel),
			SourceURL:  tradeSourceURL,
			Confidence: 1.0,
			Metadata: map[string]any{
				"dataflow":        dataflow,
				"direction":       k.direction,
				"time_period":     k.period,
				"commodity_codes": codes,
				"commodity_count": len(codes),
				"valuation_basis": valuation,
				"adjustment":      "original terms (not seasonally adjusted)",
				"unit_note":       "OBS_VALUE scaled by UNIT_MULT to whole Australian dollars",
				"aggregation":     "industry_level_no_entity",
			},
		})
	}
	return records, skipped
}

// syncIndustryTradeRecords writes the industry-level aggregates. No entity
// mapping is involved by design (trade_exposure is an industry signal, not a
// company disclosure). Returns (imported, skippedUnmappedCommodities).
func syncIndustryTradeRecords(ctx context.Context, pool *pgxpool.Pool, rows []TradeRow) (int, int, error) {
	records, skipped := buildTradeIndustryRecords(rows)
	imported, err := upsertIndustryRecords(ctx, pool, tradeSource, records)
	return imported, skipped, err
}

// runTradeMode mirrors the other run* collectors: one observability run per
// invocation covering fetch, aggregation, and upsert.
func runTradeMode(ctx context.Context, pool *pgxpool.Pool) {
	runID, err := insertIndustryCollectionRun(ctx, pool, tradeSource)
	if err != nil {
		log.Fatalf("[trade] start collection run: %v", err)
	}
	rows, err := ingestABSTrade(ctx)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[trade]", err, map[string]any{
			"export_dataflow": absMerchExportFlow,
			"import_dataflow": absMerchImportFlow,
			"source_url":      tradeSourceURL,
		})
		log.Fatalf("[trade] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryTradeRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[trade]", err, map[string]any{
			"export_dataflow": absMerchExportFlow,
			"import_dataflow": absMerchImportFlow,
			"source_url":      tradeSourceURL,
		})
		log.Fatalf("[trade] sync error: %v", err)
	}
	status := "succeeded"
	if imported == 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"export_dataflow":            absMerchExportFlow,
		"import_dataflow":            absMerchImportFlow,
		"source_url":                 tradeSourceURL,
		"start_period":               absTradeStartPeriod,
		"crosswalk_commodities":      len(absTradeIndustryMap),
		"skipped_unmapped_commodity": skipped,
	}); err != nil {
		log.Fatalf("[trade] finish collection run: %v", err)
	}
	log.Printf("[trade] parsed %d ABS observations, upserted %d industry-level records (%d unmapped-commodity rows skipped)", len(rows), imported, skipped)
}

// tradeRecordID builds a deterministic, readable record ID:
// abs-trade:<direction>:<industry-slug>:<period>.
func tradeRecordID(direction, industry, period string) string {
	slug := strings.Trim(nonAlphaNumeric.ReplaceAllString(strings.ToLower(industry), "-"), "-")
	return fmt.Sprintf("abs-trade:%s:%s:%s", direction, slug, period)
}

// monthPeriodDates turns an ABS monthly TIME_PERIOD ("2025-03") into the first
// and last day of that month (UTC).
func monthPeriodDates(period string) (time.Time, time.Time, error) {
	start, err := time.ParseInLocation("2006-01", strings.TrimSpace(period), time.UTC)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("bad monthly period %q", period)
	}
	end := start.AddDate(0, 1, -1)
	return start, end, nil
}

// absTradeColIndex maps a logical SDMX-CSV column (prefix before ':') to its
// index, so parsers survive labelled headers and dataflow-specific dimensions.
func absTradeColIndex(header []string) map[string]int {
	m := map[string]int{}
	for i, h := range header {
		name := strings.TrimSpace(h)
		if idx := strings.Index(name, ":"); idx >= 0 {
			name = strings.TrimSpace(name[:idx])
		}
		m[name] = i
	}
	return m
}

// absTradeCode extracts the code from a labels=both "code: label" cell.
func absTradeCode(cell string) string {
	if code, _, ok := strings.Cut(cell, ":"); ok {
		return strings.TrimSpace(code)
	}
	return strings.TrimSpace(cell)
}

// absTradeLabel extracts the label from a labels=both "code: label" cell.
func absTradeLabel(cell string) string {
	if _, label, ok := strings.Cut(cell, ":"); ok {
		return strings.TrimSpace(label)
	}
	return strings.TrimSpace(cell)
}

// absTradeApplyMult scales an ABS value by its UNIT_MULT (power of ten).
func absTradeApplyMult(val float64, multCell string) float64 {
	if m, err := strconv.Atoi(absTradeCode(multCell)); err == nil {
		return val * math.Pow10(m)
	}
	return val
}

// formatMillions renders a raw-AUD value in millions with thousands grouping
// and one decimal, e.g. 15_025_448_000 → "15,025.4".
func formatMillions(v float64) string {
	s := strconv.FormatFloat(v/1e6, 'f', 1, 64)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	intPart, frac, _ := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := b.String() + "." + frac
	if neg {
		return "-" + out
	}
	return out
}
