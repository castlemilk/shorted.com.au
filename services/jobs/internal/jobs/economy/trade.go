package economy

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Flow + dimension names pinned from the SDMX probe (Task 7 Step 1, 2026-07-21)
// against the live ABS,MERCH_EXP(1.0.0) / ABS,MERCH_IMP(1.0.0) dataflows, and
// cross-checked against services/influence-collector/trade.go (same flows,
// pulled at industry level, national totals only). The plan's guesses were
// right on flow names, the export state dim (STATE_ORIGIN), the import state
// dim (STATE_DEST), the country dims (COUNTRY_DEST export / COUNTRY_ORIGIN
// import), the country "Total" code (TOT), and the SITC section codes (single
// digits 0-9 + TOT for "all commodities"). One guess was wrong: the *national*
// aggregate on the STATE_ORIGIN/STATE_DEST dimension is coded "TOT" ("Total"),
// not "AUS" — lfStates (labour.go) only has an "AUS" key, so tradeStateCode
// normalizes "TOT" -> "AUS" before the lfStates lookup. UNIT_MULT is present
// (values are AUD thousands, UNIT_MULT=3) and scaled via absdata.ApplyMult.
//
// `MERCH_EXP/all` and `MERCH_IMP/all` return every commodity/country/state
// combination (~55k rows for a single month) — far too large for full 2015-
// present history. The fetch is constrained to a partial SDMX key covering
// just the SITC sections (single-digit 0-9, plus TOT for "all commodities")
// crossed with country=TOT (avoids double counting per-country splits) and
// all lfStates region codes, i.e.
// "0+1+2+3+4+5+6+7+8+9+TOT.TOT.1+2+3+4+5+6+7+8+TOT.M" (verified via probe:
// ~12.2k rows for 2015-01-present monthly history, ~1.6s response time).
//
// Series-count gap (verified against the live API 2026-07-21): SITC section 4
// ("Animal and vegetable oils, fats and waxes") has NO recorded export or
// import observations for ACT (state code 8) at any point in the pulled
// history — every other of the 99 possible (11 SITC groups incl. TOT) x
// (9 regions incl. AUS) combinations is present, so each metric yields 98
// series, not 99. This is a genuine ABS data gap (ACT records essentially no
// animal/vegetable oil trade), not a parsing bug.
const (
	tradeExportFlow  = "MERCH_EXP"
	tradeImportFlow  = "MERCH_IMP"
	tradeStartPeriod = "2015-01"
	tradeTotalCode   = "TOT"
	tradeFreqMonthly = "M"
	// tradeKey covers SITC sections 0-9 + TOT (all commodities), crossed with
	// country=TOT and every lfStates region code (state 9 "No state details"
	// is excluded from the pull since it isn't in lfStates and would only add
	// unused rows). Dimension order: COMMODITY_SITC.COUNTRY.STATE.FREQ.
	tradeKey = "0+1+2+3+4+5+6+7+8+9+TOT.TOT.1+2+3+4+5+6+7+8+TOT.M"
)

// sitcProducts maps ABS COMMODITY_SITC section codes to stable product slugs.
// Series identity must key off this static, code-driven map — NOT the SITC
// label text — because ABS labels can be re-worded upstream without the code
// changing, which would silently churn every series_key. Values were pinned
// 2026-07-21 by querying the already-ingested rows this importer produced
// from the live labels (`SELECT DISTINCT product, dimensions->>'sitc_code'
// FROM economic_series WHERE topic='trade' ORDER BY 2`), so switching to this
// map is a no-op for existing series keys. Codes not in this map are skipped
// (fail closed) rather than falling back to a label slug.
var sitcProducts = map[string]string{
	"0":   "food_and_live_animals",
	"1":   "beverages_and_tobacco",
	"2":   "crude_materials_inedible_except_fuels",
	"3":   "mineral_fuels_lubricants_and_related_materials",
	"4":   "animal_and_vegetable_oils_fats_and_waxes",
	"5":   "chemicals_and_related_products_nes",
	"6":   "manufactured_goods_classified_chiefly_by_material",
	"7":   "machinery_and_transport_equipment",
	"8":   "miscellaneous_manufactured_articles",
	"9":   "commodities_and_transactions_not_classified_elsewhere_in_the_sitc",
	"TOT": "total",
}

func ingestTradeByState(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	var all []Obs
	pulls := []struct {
		flow, metric, stateDim string
	}{
		{tradeExportFlow, "export_value", "STATE_ORIGIN"},
		{tradeImportFlow, "import_value", "STATE_DEST"},
	}
	for _, p := range pulls {
		rows, err := c.FetchSDMXCSV(ctx, p.flow, tradeKey, tradeStartPeriod)
		if err != nil {
			return nil, err
		}
		obs, err := parseTrade(rows, p.metric, p.stateDim, p.flow)
		if err != nil {
			return nil, err
		}
		all = append(all, obs...)
	}
	return all, nil
}

// parseTrade parses one MERCH_EXP/MERCH_IMP SDMX-CSV body. stateDim is
// "STATE_ORIGIN" (export) or "STATE_DEST" (import) — the column resolved by
// name so one parser serves both flows. dataflow ("MERCH_EXP"/"MERCH_IMP") is
// recorded verbatim into Dimensions.abs_dataflow.
func parseTrade(rows [][]string, metric, stateDim, dataflow string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	// Fail closed: the country dimension is what prevents double counting
	// (Total-country rows vs. per-country splits), and FREQ is what keeps
	// non-monthly rows out. If either is missing, the schema has drifted from
	// what this importer was built against — refuse to ingest rather than
	// silently disabling the guard.
	countryCol, hasCountry := countryColumn(idx)
	if !hasCountry {
		return nil, fmt.Errorf("parseTrade: country dimension not found — schema drift, refusing to ingest")
	}
	freqCol, hasFreq := idx["FREQ"]
	if !hasFreq {
		return nil, fmt.Errorf("parseTrade: FREQ dimension not found — schema drift, refusing to ingest")
	}
	var obs []Obs
	for _, row := range rows[1:] {
		// Only country=Total rows — per-country splits would double count
		// against the Total-country row for the same commodity/state/period.
		if absdata.Code(absdata.Cell(row, countryCol)) != tradeTotalCode {
			continue
		}
		if absdata.Code(absdata.Cell(row, freqCol)) != tradeFreqMonthly {
			continue
		}
		stateCode := tradeStateCode(absdata.Code(absdata.Cell(row, idx[stateDim])))
		st, ok := lfStates[stateCode]
		if !ok {
			continue
		}
		commodityCode := absdata.Code(absdata.Cell(row, idx["COMMODITY_SITC"]))
		product, ok := sitcProducts[commodityCode]
		if !ok {
			continue // unknown SITC code — fail closed rather than guess a slug
		}
		period, freq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "trade", Metric: metric, Product: product,
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: "aud", Frequency: freq, Adjustment: "original",
				SourceKey: "abs-merch-trade-state", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"sitc_code":    commodityCode,
					"abs_dataflow": dataflow,
				},
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}

// tradeStateCode normalizes the trade dataflows' national-aggregate code
// ("TOT") to the code lfStates uses for the national row ("AUS"); all other
// codes (the 1-8 state codes) already match lfStates verbatim.
func tradeStateCode(code string) string {
	if code == tradeTotalCode {
		return "AUS"
	}
	return code
}

// countryColumn finds whichever country dimension the flow carries
// (COUNTRY_DEST for exports, COUNTRY_ORIGIN for imports).
func countryColumn(idx map[string]int) (int, bool) {
	for _, name := range []string{"COUNTRY_DEST", "COUNTRY_ORIGIN", "COUNTRY"} {
		if i, ok := idx[name]; ok {
			return i, true
		}
	}
	return -1, false
}
