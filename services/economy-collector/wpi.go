package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,WPI(1.2.0) SDMX probe on 2026-07-22.
// Dimension order is MEASURE.INDEX.SECTOR.INDUSTRY.TSEST.REGION.FREQ. The
// constrained key selects headline total hourly rates of pay excluding
// bonuses (THRPEB), total private and public sectors, all industries, for
// the eight states/territories plus Australia.
//
// TSEST=10 is intentional because state and territory WPI observations are
// original-only. MEASURE=1 is the index and MEASURE=3 is the corresponding-
// quarter annual percentage change. The probe magnitude was about 160.3 for
// the Australian index and 3.2% for Australian annual growth. WPI 1.2.0 has
// no UNIT_MULT column (the same upstream quirk as CPI v2); index and percent
// observations are already direct values and must not be scaled.
const (
	wpiFlow          = "WPI"
	wpiVersion       = "1.2.0"
	wpiMeasureIndex  = "1"
	wpiMeasureYoY    = "3"
	wpiIndexHeadline = "THRPEB"
	wpiSector        = "7"
	wpiIndustry      = "TOT"
	wpiTsestOriginal = "10"
	wpiFreqQuarterly = "Q"
	wpiStartPeriod   = "2000-Q1"
	wpiKey           = "1+3.THRPEB.7.TOT.10.1+2+3+4+5+6+7+8+AUS.Q"
)

var wpiMeasures = map[string][2]string{
	wpiMeasureIndex: {"wpi", "index"},
	wpiMeasureYoY:   {"wpi_yoy", "percent"},
}

func ingestWPI(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, wpiFlow+","+wpiVersion, wpiKey, wpiStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseWPI(rows)
}

func parseWPI(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	required := []string{"MEASURE", "INDEX", "SECTOR", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE"}
	if err := requireSDMXColumns(idx, "parseWPI", required...); err != nil {
		return nil, err
	}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseWPI", csvRow, required...); err != nil {
			return nil, err
		}
		measureCode := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		measure, ok := wpiMeasures[measureCode]
		if !ok || absdata.Code(absdata.Cell(row, idx["INDEX"])) != wpiIndexHeadline ||
			absdata.Code(absdata.Cell(row, idx["SECTOR"])) != wpiSector ||
			absdata.Code(absdata.Cell(row, idx["INDUSTRY"])) != wpiIndustry ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != wpiTsestOriginal ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != wpiFreqQuarterly {
			continue
		}
		regionCode := absdata.Code(absdata.Cell(row, idx["REGION"]))
		region, ok := lfStates[regionCode]
		if !ok {
			continue
		}
		period, frequency, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		value, err := strconv.ParseFloat(absdata.Cell(row, idx["OBS_VALUE"]), 64)
		if err != nil {
			return nil, fmt.Errorf("parseWPI: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "wages", Metric: measure[0],
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: measure[1], Frequency: frequency, Adjustment: "original",
				SourceKey: "abs-wage-price-index", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":         wpiFlow,
					"abs_dataflow_version": wpiVersion,
					"measure":              measureCode,
					"index":                wpiIndexHeadline,
					"sector":               wpiSector,
					"industry":             wpiIndustry,
					"tsest":                wpiTsestOriginal,
					"region":               regionCode,
					"freq":                 wpiFreqQuarterly,
				},
			},
			Period: period,
			Value:  value,
		})
	}
	return obs, nil
}
