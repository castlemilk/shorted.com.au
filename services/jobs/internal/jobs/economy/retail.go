package economy

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from a live ABS,RT(1.0.0) SDMX probe on 2026-07-22.
// Dimension order is MEASURE.INDUSTRY.TSEST.REGION.FREQ. The constrained key
// selects current-price total retail turnover, seasonally adjusted, for the
// eight states/territories plus Australia.
//
// Magnitude check from the probe: 2025-06 was 37906.6 for Australia and
// 11665.8 for NSW with UNIT_MULT=6 (millions), yielding $37,906,600,000 and
// $11,665,800,000 respectively. ApplyMult must be used per row to preserve
// that order of magnitude.
const (
	retailFlow          = "RT"
	retailMeasurePrice  = "M1" // Current Prices
	retailIndustryTotal = "20" // Total
	retailTsestSeasAdj  = "20" // Seasonally Adjusted
	retailFreqMonthly   = "M"
	retailStartPeriod   = "2000-01"
	retailKey           = "M1.20.20.1+2+3+4+5+6+7+8+AUS.M"
)

func ingestRetail(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, retailFlow, retailKey, retailStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseRetail(rows)
}

func parseRetail(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	required := []string{"MEASURE", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseRetail", required...); err != nil {
		return nil, err
	}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseRetail", csvRow, required...); err != nil {
			return nil, err
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseRetail", csvRow)
		if err != nil {
			return nil, err
		}
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != retailMeasurePrice ||
			absdata.Code(absdata.Cell(row, idx["INDUSTRY"])) != retailIndustryTotal ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != retailTsestSeasAdj ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != retailFreqMonthly {
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
			return nil, fmt.Errorf("parseRetail: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "retail", Metric: "turnover", Product: "total",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "aud", Frequency: frequency, Adjustment: "seasadj",
				SourceKey: "abs-retail-trade", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow": retailFlow,
					"measure":      retailMeasurePrice,
					"industry":     retailIndustryTotal,
					"tsest":        retailTsestSeasAdj,
					"region":       regionCode,
					"freq":         retailFreqMonthly,
					"unit_mult":    unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
