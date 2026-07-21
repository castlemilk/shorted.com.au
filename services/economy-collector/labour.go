package main

import (
	"context"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from the SDMX probe (Task 6 Step 1, 2026-07-21) against the
// live ABS,LF(1.0.0) dataflow. The plan's guessed constants were wrong in two
// ways the probe corrected:
//   - The region dimension is named REGION, not STATE.
//   - MEASURE codes are "M"-prefixed strings (M13=unemployment rate,
//     M12=participation rate, M3=employed persons), not the bare "14"/"15"/"5"
//     guessed.
// SEX=3 (Persons), AGE=1599 (Total (age)) and TSEST=20 (Seasonally Adjusted)
// all matched the plan's guesses. UNIT_MULT IS present on this dataflow
// (unlike CPI), so employed persons is scaled via absdata.ApplyMult rather
// than a hardcoded literal.
//
// `LF/all` returns every measure/sex/age/tsest/region combination (~745 rows
// per single month) — pulling full history that way is far too large, so the
// fetch is constrained to a partial SDMX key covering just what's needed:
// MEASURE.SEX.AGE.TSEST.REGION.FREQ, i.e.
// "M3+M12+M13.3.1599.20.1+2+3+4+5+6+7+8+AUS.M" (verified via probe: ~6.6k
// rows for the full 2000-present monthly history).
const (
	lfFlow         = "LF"
	lfSexPersons   = "3"
	lfAgeAll       = "1599"
	lfTsestSeasAdj = "20"
	lfFreqMonthly  = "M"
	lfStartPeriod  = "2000-01"
	lfKey          = "M3+M12+M13.3.1599.20.1+2+3+4+5+6+7+8+AUS.M"
)

// lfMeasures maps ABS MEASURE codes to (metric, unit).
var lfMeasures = map[string][2]string{
	"M13": {"unemployment_rate", "percent"},
	"M12": {"participation_rate", "percent"},
	"M3":  {"employed_persons", "persons"},
}

// lfStates maps ABS REGION dimension codes to (region_code, region_name,
// region_type). Exported at package level because Task 7 (trade-by-state)
// reuses the same state/national breakdown.
var lfStates = map[string][3]string{
	"AUS": {"aus", "Australia", "national"},
	"1":   {"nsw", "New South Wales", "state"},
	"2":   {"vic", "Victoria", "state"},
	"3":   {"qld", "Queensland", "state"},
	"4":   {"sa", "South Australia", "state"},
	"5":   {"wa", "Western Australia", "state"},
	"6":   {"tas", "Tasmania", "state"},
	"7":   {"nt", "Northern Territory", "state"},
	"8":   {"act", "Australian Capital Territory", "state"},
}

func ingestLabour(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	rows, err := c.FetchSDMXCSV(ctx, lfFlow, lfKey, lfStartPeriod)
	if err != nil {
		return nil, err
	}
	return parseLabour(rows)
}

func parseLabour(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	var obs []Obs
	for _, row := range rows[1:] {
		m, ok := lfMeasures[absdata.Code(absdata.Cell(row, idx["MEASURE"]))]
		if !ok {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["SEX"])) != lfSexPersons {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["AGE"])) != lfAgeAll {
			continue
		}
		if absdata.Code(absdata.Cell(row, idx["TSEST"])) != lfTsestSeasAdj {
			continue
		}
		st, ok := lfStates[absdata.Code(absdata.Cell(row, idx["REGION"]))]
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
				Topic: "labour", Metric: m[0], Product: "total",
				RegionType: st[2], RegionCode: st[0], RegionName: st[1],
				Unit: m[1], Frequency: freq, Adjustment: "seasadj",
				SourceKey: "abs-labour-force", Licence: absdata.Licence,
				Dimensions: map[string]string{
					"abs_dataflow": lfFlow,
					"measure":      absdata.Code(absdata.Cell(row, idx["MEASURE"])),
					"sex":          lfSexPersons,
					"age":          lfAgeAll,
					"tsest":        lfTsestSeasAdj,
					"region":       st[0],
				},
			},
			Period: period,
			Value:  absdata.ApplyMult(val, absdata.Cell(row, idx["UNIT_MULT"])),
		})
	}
	return obs, nil
}
