package main

import (
	"context"
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
		obs, err := parseTrade(rows, p.metric, p.stateDim)
		if err != nil {
			return nil, err
		}
		all = append(all, obs...)
	}
	return all, nil
}

// parseTrade parses one MERCH_EXP/MERCH_IMP SDMX-CSV body. stateDim is
// "STATE_ORIGIN" (export) or "STATE_DEST" (import) — the column resolved by
// name so one parser serves both flows.
func parseTrade(rows [][]string, metric, stateDim string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	countryCol, hasCountry := countryColumn(idx)
	var obs []Obs
	for _, row := range rows[1:] {
		// Only country=Total rows — per-country splits would double count
		// against the Total-country row for the same commodity/state/period.
		if hasCountry && absdata.Code(absdata.Cell(row, countryCol)) != tradeTotalCode {
			continue
		}
		if freqCol, ok := idx["FREQ"]; ok && absdata.Code(absdata.Cell(row, freqCol)) != tradeFreqMonthly {
			continue
		}
		stateCode := tradeStateCode(absdata.Code(absdata.Cell(row, idx[stateDim])))
		st, ok := lfStates[stateCode]
		if !ok {
			continue
		}
		commodity := absdata.Cell(row, idx["COMMODITY_SITC"])
		commodityCode := absdata.Code(commodity)
		product := slug(absdata.Label(commodity))
		if commodityCode == tradeTotalCode {
			product = "total"
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
				Dimensions: map[string]string{"sitc_code": commodityCode},
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
