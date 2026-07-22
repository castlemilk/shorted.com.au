package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,JV(1.0) SDMX probe on 2026-07-22.
// Dimension order is MEASURE.SECTOR.INDUSTRY.TSEST.REGION.FREQ. The
// constrained key selects total private-and-public-sector job vacancies,
// original series, for the eight states/territories plus Australia.
//
// Version 1.0 is intentional: JV version 1.0.0 returns 404. State and
// territory rows exist only for TSEST=10 (original), so this importer must
// not substitute seasonally adjusted or trend codes. UNIT_MULT=3 means the
// reported thousands are multiplied by 1,000; the 2026-Q2 probe yielded
// Australia=324,000 and NSW=96,100 persons after scaling.
const (
	vacanciesFlow          = "JV"
	vacanciesVersion       = "1.0"
	vacanciesMeasure       = "M1"
	vacanciesSector        = "7"
	vacanciesIndustry      = "TOT"
	vacanciesTsestOriginal = "10"
	vacanciesFreqQuarterly = "Q"
	vacanciesStartPeriod   = "2009-Q3"
	vacanciesKey           = "M1.7.TOT.10.1+2+3+4+5+6+7+8+AUS.Q"
)

func ingestVacancies(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, vacanciesFlow+","+vacanciesVersion, vacanciesKey, vacanciesStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseVacancies(rows)
}

func parseVacancies(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	requiredColumns := []string{"MEASURE", "SECTOR", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseVacancies", requiredColumns...); err != nil {
		return nil, err
	}
	requiredRow := []string{"MEASURE", "SECTOR", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "UNIT_MULT"}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseVacancies", csvRow, requiredRow...); err != nil {
			return nil, err
		}
		valueCell := absdata.Cell(row, idx["OBS_VALUE"])
		if valueCell == "" {
			// ABS publishes unavailable quarters as blank observations (commonly
			// OBS_STATUS=q). They are missing data, not malformed numeric values.
			continue
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseVacancies", csvRow)
		if err != nil {
			return nil, err
		}
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != vacanciesMeasure ||
			absdata.Code(absdata.Cell(row, idx["SECTOR"])) != vacanciesSector ||
			absdata.Code(absdata.Cell(row, idx["INDUSTRY"])) != vacanciesIndustry ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != vacanciesTsestOriginal ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != vacanciesFreqQuarterly {
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
		value, err := strconv.ParseFloat(valueCell, 64)
		if err != nil {
			return nil, fmt.Errorf("parseVacancies: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "labour", Metric: "job_vacancies",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "persons", Frequency: frequency, Adjustment: "original",
				SourceKey: "abs-job-vacancies", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":         vacanciesFlow,
					"abs_dataflow_version": vacanciesVersion,
					"measure":              vacanciesMeasure,
					"sector":               vacanciesSector,
					"industry":             vacanciesIndustry,
					"tsest":                vacanciesTsestOriginal,
					"region":               regionCode,
					"freq":                 vacanciesFreqQuarterly,
					"unit_mult":            unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
