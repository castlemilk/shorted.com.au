package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,HSI_M(1.6.0) SDMX probe on 2026-07-23.
// Dimension order is MEASURE.CATEGORY.PRICE_ADJUSTMENT.TSEST.STATE.FREQ.
// The constrained key selects current-price total household spending and
// through-the-year growth, seasonally adjusted, for the eight states and
// territories plus Australia.
//
// The two measures deliberately carry different UNIT_MULT codes: measure 7
// is reported in millions of dollars (6), while measure 9 is already a
// percentage (0). Both are scaled per row through sdmxScaleStrict, for which
// UNIT_MULT=0 correctly yields a factor of one. The probe yielded Australian
// spending of $80.6355B and through-the-year growth of 5.5% for 2026-05.
const (
	spendingFlow          = "HSI_M"
	spendingVersion       = "1.6.0"
	spendingMeasureLevel  = "7"
	spendingMeasureYoY    = "9"
	spendingCategoryTotal = "TOT"
	spendingPriceCurrent  = "CUR"
	spendingTsestSeasAdj  = "20"
	spendingFreqMonthly   = "M"
	spendingStartPeriod   = "2019-01"
	spendingKey           = "7+9.TOT.CUR.20.1+2+3+4+5+6+7+8+AUS.M"
)

var spendingMeasures = map[string][2]string{
	spendingMeasureLevel: {"household", "aud"},
	spendingMeasureYoY:   {"household_yoy", "percent"},
}

func ingestSpending(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, spendingFlow+","+spendingVersion, spendingKey, spendingStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseSpending(rows)
}

func parseSpending(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	requiredColumns := []string{"MEASURE", "CATEGORY", "PRICE_ADJUSTMENT", "TSEST", "STATE", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseSpending", requiredColumns...); err != nil {
		return nil, err
	}
	requiredRow := []string{"MEASURE", "CATEGORY", "PRICE_ADJUSTMENT", "TSEST", "STATE", "FREQ", "TIME_PERIOD", "UNIT_MULT"}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseSpending", csvRow, requiredRow...); err != nil {
			return nil, err
		}
		valueCell := absdata.Cell(row, idx["OBS_VALUE"])
		if valueCell == "" {
			continue
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseSpending", csvRow)
		if err != nil {
			return nil, err
		}
		measureCode := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		measure, ok := spendingMeasures[measureCode]
		if !ok ||
			absdata.Code(absdata.Cell(row, idx["CATEGORY"])) != spendingCategoryTotal ||
			absdata.Code(absdata.Cell(row, idx["PRICE_ADJUSTMENT"])) != spendingPriceCurrent ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != spendingTsestSeasAdj ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != spendingFreqMonthly {
			continue
		}
		stateCode := absdata.Code(absdata.Cell(row, idx["STATE"]))
		region, ok := lfStates[stateCode]
		if !ok {
			continue
		}
		period, frequency, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		value, err := strconv.ParseFloat(valueCell, 64)
		if err != nil {
			return nil, fmt.Errorf("parseSpending: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "spending", Metric: measure[0], Product: "total",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: measure[1], Frequency: frequency, Adjustment: "seasadj",
				SourceKey: "abs-household-spending", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":         spendingFlow,
					"abs_dataflow_version": spendingVersion,
					"measure":              measureCode,
					"category":             spendingCategoryTotal,
					"price_adjustment":     spendingPriceCurrent,
					"tsest":                spendingTsestSeasAdj,
					"state":                stateCode,
					"freq":                 spendingFreqMonthly,
					"unit_mult":            unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
