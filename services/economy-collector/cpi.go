package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from the SDMX probe (Task 5 Step 1, 2026-07-21) against the
// live ABS,CPI(2.0.0) dataflow. The plan's guessed constants were wrong in
// two ways the probe corrected:
//   - REGION=50 is labelled "Australia" (the national aggregate), not
//     "weighted average of eight capital cities" as guessed.
//   - The dataflow has no UNIT_MULT dimension at all (values are already
//     correctly scaled), and MEASURE=3 (% change from corresponding period
//     of previous year) only exists at FREQ=M for INDEX=10001/REGION=50 —
//     ABS has no quarterly-frequency annual-change series here. MEASURE=1
//     (index numbers) exists at both FREQ=Q (long history back to 2000) and
//     FREQ=M (since the 2025 Monthly CPI Indicator merge), so it's pinned to
//     FREQ=Q to avoid double-counting the same period under one series key.
const (
	cpiFlow           = "CPI"
	cpiIndexAllGroups = "10001" // All groups CPI
	cpiMeasureIndex   = "1"     // Index numbers
	cpiMeasureAnnual  = "3"     // % change from corresponding period of previous year
	cpiRegionAus      = "50"    // Australia
	cpiTsestOriginal  = "10"    // Original series
	cpiFreqQuarterly  = "Q"
	cpiFreqMonthly    = "M"
	cpiStartPeriod    = "2000-Q1"
)

func ingestCPI(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, cpiFlow, "all", cpiStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseCPI(rows)
}

func parseCPI(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	var obs []Obs
	for _, row := range rows[1:] {
		if absdata.Code(absdata.Cell(row, idx["INDEX"])) != cpiIndexAllGroups {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["REGION"])) != cpiRegionAus {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["TSEST"])) != cpiTsestOriginal {
			continue
		}
		measure := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		freq := absdata.Code(absdata.Cell(row, idx["FREQ"]))
		var metric, unit string
		switch measure {
		case cpiMeasureIndex:
			if freq != cpiFreqQuarterly {
				continue
			}
			metric, unit = "index", "index"
		case cpiMeasureAnnual:
			if freq != cpiFreqMonthly {
				continue
			}
			metric, unit = "annual_change", "percent"
		default:
			continue
		}
		period, periodFreq, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			continue
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "cpi", Metric: metric, Product: "all_groups",
				RegionType: "national", RegionCode: "aus", RegionName: "Australia",
				Unit: unit, Frequency: periodFreq, Adjustment: "original",
				SourceKey: "abs-cpi", Licence: absdata.Licence,
			},
			Period: period,
			Value:  val,
		})
	}
	return obs, nil
}
