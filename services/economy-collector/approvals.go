package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,BA_SA2(2.0.0) SDMX probe on 2026-07-22.
// Dimension order is MEASURE.SECTOR.WORK_TYPE.BUILDING_TYPE.REGION_TYPE.
// REGION.FREQ. The constrained query returns exactly the eight state and
// territory series needed here, rather than the full building-approvals cube.
//
// Magnitude check from the probe: the latest observations at 2026-05 were
// NSW=4518, VIC=4710, QLD=3393, SA=1506, WA=2182, TAS=319, NT=120 and ACT=211.
// UNIT_MULT=0 for these rows, so ApplyMult intentionally preserves those raw
// dwelling-unit counts.
const (
	approvalsFlow            = "BA_SA2"
	approvalsMeasureUnits    = "1"   // Number of dwelling units
	approvalsSectorTotal     = "9"   // Total Sectors
	approvalsWorkTotal       = "TOT" // Total Work
	approvalsBuildingTotal   = "TOT" // Total
	approvalsRegionTypeState = "STE" // States/Territories
	approvalsFreqMonthly     = "M"
	approvalsStartPeriod     = "2021-07"
	approvalsKey             = "1.9.TOT.TOT.STE.1+2+3+4+5+6+7+8.M"
)

func ingestApprovals(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, approvalsFlow, approvalsKey, approvalsStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseApprovals(rows)
}

func parseApprovals(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	required := []string{
		"MEASURE", "SECTOR", "WORK_TYPE", "BUILDING_TYPE", "REGION_TYPE",
		"REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT",
	}
	if err := requireSDMXColumns(idx, "parseApprovals", required...); err != nil {
		return nil, err
	}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2 // one-based CSV row number, including the header
		if err := requireSDMXRow(row, idx, "parseApprovals", csvRow, required...); err != nil {
			return nil, err
		}
		// Validate the multiplier before selection filters so a malformed row
		// cannot disappear merely because an earlier dimension is untracked.
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseApprovals", csvRow)
		if err != nil {
			return nil, err
		}
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != approvalsMeasureUnits ||
			absdata.Code(absdata.Cell(row, idx["SECTOR"])) != approvalsSectorTotal ||
			absdata.Code(absdata.Cell(row, idx["WORK_TYPE"])) != approvalsWorkTotal ||
			absdata.Code(absdata.Cell(row, idx["BUILDING_TYPE"])) != approvalsBuildingTotal ||
			absdata.Code(absdata.Cell(row, idx["REGION_TYPE"])) != approvalsRegionTypeState ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != approvalsFreqMonthly {
			continue
		}
		regionCode := absdata.Code(absdata.Cell(row, idx["REGION"]))
		region, ok := lfStates[regionCode]
		if !ok || region[2] != "state" {
			continue
		}
		period, frequency, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		value, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			return nil, fmt.Errorf("parseApprovals: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "approvals", Metric: "dwelling_units", Product: "total",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "units", Frequency: frequency, Adjustment: "original",
				SourceKey: "abs-building-approvals", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":  approvalsFlow,
					"measure":       approvalsMeasureUnits,
					"sector":        approvalsSectorTotal,
					"work_type":     approvalsWorkTotal,
					"building_type": approvalsBuildingTotal,
					"region_type":   approvalsRegionTypeState,
					"region":        regionCode,
					"freq":          approvalsFreqMonthly,
					"unit_mult":     unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
