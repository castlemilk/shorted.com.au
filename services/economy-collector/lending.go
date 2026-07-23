package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,LEND_HOUSING(1.1) SDMX probe on 2026-07-23.
// Dimension order is MEASURE.DATA_ITEM.LOAN_TYPE.LOAN_PURPOSE.LENDER_TYPE.
// HOUSING_PURPOSE.TSEST.REGION.FREQ. The constrained key selects the value
// of new commitments for total dwellings excluding refinancing, across all
// lenders, split into owner-occupier and investor purposes for every state
// and territory plus Australia.
//
// TOTDWELL is intentional: TOTHOUS does not carry the plain DV5167/DV5168
// split. All selected rows carry UNIT_MULT=6 and are scaled strictly from
// the per-row metadata. The flow is quarterly as of this pinned version.
const (
	lendingFlow                 = "LEND_HOUSING"
	lendingVersion              = "1.1"
	lendingMeasureValue         = "FIN_VAL"
	lendingDataItemCommitments  = "NEWCOMMITS"
	lendingLoanTypeTotal        = "DV8368"
	lendingLoanPurposeDwellings = "TOTDWELL"
	lendingLenderTotal          = "TOT"
	lendingPurposeOwner         = "DV5167"
	lendingPurposeInvestor      = "DV5168"
	lendingTsestSeasAdj         = "20"
	lendingFreqQuarterly        = "Q"
	lendingStartPeriod          = "2019-Q3"
	lendingKey                  = "FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.DV5167+DV5168.20.1+2+3+4+5+6+7+8+AUS.Q"
)

var lendingPurposes = map[string]string{
	lendingPurposeOwner:    "owner_occupier",
	lendingPurposeInvestor: "investor",
}

func ingestLending(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, lendingFlow+","+lendingVersion, lendingKey, lendingStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseLending(rows)
}

func parseLending(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	requiredColumns := []string{"MEASURE", "DATA_ITEM", "LOAN_TYPE", "LOAN_PURPOSE", "LENDER_TYPE", "HOUSING_PURPOSE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseLending", requiredColumns...); err != nil {
		return nil, err
	}
	requiredRow := []string{"MEASURE", "DATA_ITEM", "LOAN_TYPE", "LOAN_PURPOSE", "LENDER_TYPE", "HOUSING_PURPOSE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "UNIT_MULT"}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseLending", csvRow, requiredRow...); err != nil {
			return nil, err
		}
		valueCell := absdata.Cell(row, idx["OBS_VALUE"])
		if valueCell == "" {
			continue
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseLending", csvRow)
		if err != nil {
			return nil, err
		}
		purposeCode := absdata.Code(absdata.Cell(row, idx["HOUSING_PURPOSE"]))
		purpose, ok := lendingPurposes[purposeCode]
		if !ok ||
			absdata.Code(absdata.Cell(row, idx["MEASURE"])) != lendingMeasureValue ||
			absdata.Code(absdata.Cell(row, idx["DATA_ITEM"])) != lendingDataItemCommitments ||
			absdata.Code(absdata.Cell(row, idx["LOAN_TYPE"])) != lendingLoanTypeTotal ||
			absdata.Code(absdata.Cell(row, idx["LOAN_PURPOSE"])) != lendingLoanPurposeDwellings ||
			absdata.Code(absdata.Cell(row, idx["LENDER_TYPE"])) != lendingLenderTotal ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != lendingTsestSeasAdj ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != lendingFreqQuarterly {
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
			return nil, fmt.Errorf("parseLending: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "lending", Metric: "new_commitments", Product: purpose,
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "aud", Frequency: frequency, Adjustment: "seasadj",
				SourceKey: "abs-lending-indicators", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":         lendingFlow,
					"abs_dataflow_version": lendingVersion,
					"measure":              lendingMeasureValue,
					"data_item":            lendingDataItemCommitments,
					"loan_type":            lendingLoanTypeTotal,
					"loan_purpose":         lendingLoanPurposeDwellings,
					"lender_type":          lendingLenderTotal,
					"housing_purpose":      purposeCode,
					"tsest":                lendingTsestSeasAdj,
					"region":               regionCode,
					"freq":                 lendingFreqQuarterly,
					"unit_mult":            unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
