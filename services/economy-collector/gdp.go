package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Flow + dimension codes pinned from the SDMX probe (Task 8 Step 1,
// 2026-07-21). The plan guessed a dataflow "ANA_AGG" carrying a "GSP_CVM"
// (Gross State Product, chain volume measures) code, but the probe found
// that guess wrong on both counts:
//
//   - There is NO dedicated "Gross State Product" dataflow in the ABS Data
//     API. `GET /rest/dataflow/ABS?detail=allstubs` lists five ANA_*
//     dataflows (ANA_AGG, ANA_EXP, ANA_INC, ANA_IND_GVA, ANA_SFD); the ABS
//     catalogue that actually publishes GSP (5220.0, "Australian National
//     Accounts: State Accounts") is not exposed via SDMX at all — it's
//     Excel-only. ANA_AGG ("Australian National Accounts Key Aggregates")
//     is national-only (REGION=AUS exclusively, confirmed by probing every
//     row); it has no per-state breakdown.
//   - The only ANA_* dataflow that carries a REGION dimension with the
//     8-state codes (matching lfStates) is ANA_SFD ("Australian National
//     Accounts - State Final Demand"). Its DATA_ITEM=SFD ("STATE FINAL
//     DEMAND") total, at MEASURE=VCH ("Chain volume measures"), SECTOR=SSS
//     ("All sectors"), TSEST=20 ("Seasonally Adjusted"), is the closest
//     state-level national-accounts chain-volume level series actually
//     available — so that's what this importer ingests. It is an
//     expenditure-side aggregate (final demand), not the production-side
//     GSP, which is why the metric is named "state_final_demand_chain_volume"
//     rather than "gsp_chain_volume".
//
// TIME_PERIOD is plain quarterly ("2026-Q1", not a fiscal-year label like
// "2023-24"), so no absdata.PeriodDate extension was needed for this flow.
//
// UNIT_MULT landmine: every VCH/SFD row in this dataflow reports
// UNIT_MEASURE="NA: Not Applicable" and UNIT_MULT="0: Units" — i.e. the
// metadata claims no scaling — but the raw OBS_VALUE is genuinely in $
// million, matching every other ABS national-accounts dollar series. This
// was confirmed by cross-checking against ANA_AGG, whose GDP row for the
// same quarter (2026-Q1) DOES carry correct metadata
// (UNIT_MEASURE=AUD, UNIT_MULT=6: Millions, value 695945 => $695.945B).
// Summing the 8 ANA_SFD state VCH/SFD/SSS/20 values for that same quarter
// (215548+171658+136599+44603+81279+12991+8740+21086 = 692504) lands
// within 0.5% of that $695.945B national GDP figure — exactly what's
// expected of state final demand aggregating to roughly national GDP. So
// this importer applies a hardcoded 1e6 ($ million) scale instead of
// trusting absdata.ApplyMult's UNIT_MULT column, which is simply broken
// for this dataflow.
const (
	sfdFlow          = "ANA_SFD"
	sfdMeasureVCH    = "VCH" // Chain volume measures (levels, not % change)
	sfdDataItemSFD   = "SFD" // STATE FINAL DEMAND (the all-items total, not a component)
	sfdSectorAll     = "SSS" // All sectors
	sfdTsestSeasAdj  = "20"  // Seasonally Adjusted
	sfdFreqQuarterly = "Q"
	sfdStartPeriod   = "2000-Q1"
	// sfdUnitMillion is the hardcoded $-million scale documented above —
	// this dataflow's own UNIT_MULT column is unreliable.
	sfdUnitMillion = 1e6
	// sfdKey covers just MEASURE.DATA_ITEM.SECTOR.TSEST.REGION.FREQ = the one
	// series per state we want, rather than pulling `all` (~3.3k rows for a
	// single quarter across every measure/data-item/sector/tsest/region combo).
	sfdKey = "VCH.SFD.SSS.20.1+2+3+4+5+6+7+8.Q"
)

func ingestStateAccounts(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, sfdFlow, sfdKey, sfdStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseStateAccounts(rows)
}

func parseStateAccounts(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	// Fail closed: MEASURE/DATA_ITEM/SECTOR/TSEST are what prevent double
	// counting (levels vs. % change, the SFD total vs. its components, all
	// sectors vs. sub-sector splits, seasonally-adjusted vs. original/trend
	// duplicates of the same period). If the schema has drifted and any of
	// these are missing, refuse to ingest rather than silently letting
	// everything through unfiltered.
	for _, name := range []string{"MEASURE", "DATA_ITEM", "SECTOR", "TSEST", "REGION", "FREQ"} {
		if _, ok := idx[name]; !ok {
			return nil, fmt.Errorf("parseStateAccounts: %s dimension not found — schema drift, refusing to ingest", name)
		}
	}
	var obs []Obs
	for _, row := range rows[1:] {
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != sfdMeasureVCH {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["DATA_ITEM"])) != sfdDataItemSFD {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["SECTOR"])) != sfdSectorAll {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["TSEST"])) != sfdTsestSeasAdj {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["FREQ"])) != sfdFreqQuarterly {
			continue
		}
		regionCode := absdata.Code(absdata.Cell(row, idx["REGION"]))
		st, ok := lfStates[regionCode]
		if !ok {
			continue
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
				Topic: "gdp", Metric: "state_final_demand_chain_volume", Product: "total",
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: "aud", Frequency: freq, Adjustment: "seasadj",
				SourceKey: "abs-state-accounts", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow": sfdFlow,
					"measure":      sfdMeasureVCH,
					"data_item":    sfdDataItemSFD,
					"sector":       sfdSectorAll,
					"tsest":        sfdTsestSeasAdj,
					"region":       regionCode,
				},
			},
			Period: period,
			Value:  val * sfdUnitMillion,
		})
	}
	return obs, nil
}
