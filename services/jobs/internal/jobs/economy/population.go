package economy

import (
	"context"
	"fmt"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from live ABS,ERP_Q(1.0.0) and ABS,ERP_COMP_Q(1.0.0) SDMX
// probes on 2026-07-22. ERP_Q's dimension order is MEASURE.SEX.AGE.REGION.
// FREQ; ERP_COMP_Q's is MEASURE.REGION.FREQ. Both fetches use constrained
// keys covering the eight states/territories plus Australia.
//
// ERP_Q has no UNIT_MULT dimension: its values are already persons. The
// latest magnitude check was NSW=8,641,085 and Australia=27,801,023 at
// 2025-Q4.
//
// ERP_COMP_Q has a row-specific UNIT_MULT. At 2025-Q4, NSW natural increase
// 6.5 with UNIT_MULT=3 becomes 6,500; NSW net internal migration -5,842 with
// UNIT_MULT=0 remains -5,842; and Australian net overseas migration 56.6
// with UNIT_MULT=3 becomes 56,600. ApplyMult is therefore mandatory per row.
// The constrained flow currently yields 26 latest component series because
// ABS does not publish national (AUS) measure=6 net internal migration.
const (
	erpFlow          = "ERP_Q"
	erpMeasure       = "1"   // Estimated Resident Population
	erpSexPersons    = "3"   // Persons
	erpAgeAll        = "TOT" // All ages
	erpFreqQuarterly = "Q"
	erpStartPeriod   = "2000-Q1"
	erpKey           = "1.3.TOT.1+2+3+4+5+6+7+8+AUS.Q"

	populationComponentsFlow        = "ERP_COMP_Q"
	populationComponentsFreq        = "Q"
	populationComponentsStartPeriod = "2000-Q1"
	populationComponentsKey         = "3+6+9.1+2+3+4+5+6+7+8+AUS.Q"
)

var populationComponentMeasures = map[string]string{
	"3": "natural_increase",
	"6": "net_interstate_migration",
	"9": "net_overseas_migration",
}

func ingestPopulation(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	erpRows, err := c.FetchSDMXCSV(ctx, erpFlow, erpKey, erpStartPeriod)
	if err != nil {
		return nil, fmt.Errorf("fetch %s population levels: %w", erpFlow, err)
	}
	erpObs, err := parseERP(erpRows)
	if err != nil {
		return nil, fmt.Errorf("parse %s population levels: %w", erpFlow, err)
	}

	componentRows, err := c.FetchSDMXCSV(ctx, populationComponentsFlow, populationComponentsKey, populationComponentsStartPeriod)
	if err != nil {
		return nil, fmt.Errorf("fetch %s population components: %w", populationComponentsFlow, err)
	}
	componentObs, err := parsePopulationComponents(componentRows)
	if err != nil {
		return nil, fmt.Errorf("parse %s population components: %w", populationComponentsFlow, err)
	}
	return append(erpObs, componentObs...), nil
}

func parseERP(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	required := []string{"MEASURE", "SEX", "AGE", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE"}
	if err := requireSDMXColumns(idx, "parseERP", required...); err != nil {
		return nil, err
	}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseERP", csvRow, required...); err != nil {
			return nil, err
		}
		if absdata.Code(absdata.Cell(row, idx["MEASURE"])) != erpMeasure ||
			absdata.Code(absdata.Cell(row, idx["SEX"])) != erpSexPersons ||
			absdata.Code(absdata.Cell(row, idx["AGE"])) != erpAgeAll ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != erpFreqQuarterly {
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
			return nil, fmt.Errorf("parseERP: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "population", Metric: "erp", Product: "total",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "persons", Frequency: frequency, Adjustment: "original",
				SourceKey: "abs-population", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow": erpFlow,
					"measure":      erpMeasure,
					"sex":          erpSexPersons,
					"age":          erpAgeAll,
					"region":       regionCode,
					"freq":         erpFreqQuarterly,
				},
			},
			Period: period,
			Value:  value,
		})
	}
	return obs, nil
}

func parsePopulationComponents(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	required := []string{"MEASURE", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parsePopulationComponents", required...); err != nil {
		return nil, err
	}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parsePopulationComponents", csvRow, required...); err != nil {
			return nil, err
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parsePopulationComponents", csvRow)
		if err != nil {
			return nil, err
		}
		measureCode := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		metric, ok := populationComponentMeasures[measureCode]
		if !ok || absdata.Code(absdata.Cell(row, idx["FREQ"])) != populationComponentsFreq {
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
			return nil, fmt.Errorf("parsePopulationComponents: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "population", Metric: metric, Product: "total",
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "persons", Frequency: frequency, Adjustment: "original",
				SourceKey: "abs-population", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow": populationComponentsFlow,
					"measure":      measureCode,
					"region":       regionCode,
					"freq":         populationComponentsFreq,
					"unit_mult":    unitMult,
				},
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
