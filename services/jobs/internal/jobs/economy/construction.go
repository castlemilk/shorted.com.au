package economy

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,CWD(1.0.0) SDMX probe on 2026-07-23.
// Dimension order is MEASURE.PRICE_ADJUSTMENT.SECTOR_OWN.CONSTRUCTION_TYPE.
// TSEST.REGION.FREQ. Note that the SDMX-CSV column is labeled exactly
// "CONSTRUCTION_TYPE: Type of Construction"; ColIndex resolves its id
// prefix as CONSTRUCTION_TYPE.
//
// The constrained key selects chain-volume work done across total sectors,
// seasonally adjusted, for building, engineering and total construction in
// every state and territory plus Australia. Every selected row carries
// UNIT_MULT=3 (thousands), scaled strictly from the row metadata. The
// 2026-Q1 probe yielded Australian total work done of $83.360599B.
const (
	constructionFlow         = "CWD"
	constructionVersion      = "1.0.0"
	constructionMeasureValue = "M1"
	constructionPriceCVM     = "CVM"
	constructionSectorTotal  = "9"
	constructionTypeBuilding = "03"
	constructionTypeEngineer = "04"
	constructionTypeTotal    = "TOT"
	constructionTsestSeasAdj = "20"
	constructionFreqQuarter  = "Q"
	constructionStartPeriod  = "2000-Q1"
	constructionKey          = "M1.CVM.9.03+04+TOT.20.1+2+3+4+5+6+7+8+AUS.Q"
)

var constructionTypes = map[string]string{
	constructionTypeBuilding: "building",
	constructionTypeEngineer: "engineering",
	constructionTypeTotal:    "total",
}

func ingestConstruction(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, constructionFlow+","+constructionVersion, constructionKey, constructionStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseConstruction(rows)
}

func parseConstruction(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	requiredColumns := []string{"MEASURE", "PRICE_ADJUSTMENT", "SECTOR_OWN", "CONSTRUCTION_TYPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseConstruction", requiredColumns...); err != nil {
		return nil, err
	}
	requiredRow := []string{"MEASURE", "PRICE_ADJUSTMENT", "SECTOR_OWN", "CONSTRUCTION_TYPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "UNIT_MULT"}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseConstruction", csvRow, requiredRow...); err != nil {
			return nil, err
		}
		valueCell := absdata.Cell(row, idx["OBS_VALUE"])
		if valueCell == "" {
			continue
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseConstruction", csvRow)
		if err != nil {
			return nil, err
		}
		typeCode := absdata.Code(absdata.Cell(row, idx["CONSTRUCTION_TYPE"]))
		constructionType, ok := constructionTypes[typeCode]
		if !ok ||
			absdata.Code(absdata.Cell(row, idx["MEASURE"])) != constructionMeasureValue ||
			absdata.Code(absdata.Cell(row, idx["PRICE_ADJUSTMENT"])) != constructionPriceCVM ||
			absdata.Code(absdata.Cell(row, idx["SECTOR_OWN"])) != constructionSectorTotal ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != constructionTsestSeasAdj ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != constructionFreqQuarter {
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
			return nil, fmt.Errorf("parseConstruction: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "construction", Metric: "work_done", Product: constructionType,
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "aud", Frequency: frequency, Adjustment: "seasadj",
				SourceKey: "abs-construction-work-done", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow":         constructionFlow,
					"abs_dataflow_version": constructionVersion,
					"measure":              constructionMeasureValue,
					"price_adjustment":     constructionPriceCVM,
					"sector_own":           constructionSectorTotal,
					"construction_type":    typeCode,
					"tsest":                constructionTsestSeasAdj,
					"region":               regionCode,
					"freq":                 constructionFreqQuarter,
					"unit_mult":            unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
