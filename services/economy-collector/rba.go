package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

type rbaSpec struct {
	seriesID string
	metric   string
	unit     string
}

// F1.1 = cash rate (RBA publishes monthly-average observations); F11.1 =
// exchange rates (AUD/USD FXRUSD, TWI FXRTWI), which RBA publishes daily.
var rbaTables = []struct {
	file  string
	freq  string
	specs []rbaSpec
}{
	{"f1.1-data.csv", "monthly", []rbaSpec{
		{seriesID: "FIRMMCRT", metric: "cash_rate_target", unit: "percent"},
	}},
	{"f11.1-data.csv", "daily", []rbaSpec{
		{seriesID: "FXRUSD", metric: "aud_usd", unit: "usd"},
		{seriesID: "FXRTWI", metric: "trade_weighted_index", unit: "index"},
	}},
}

func ingestRBA(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	var all []Obs
	for _, t := range rbaTables {
		rows, err := c.FetchRBATable(ctx, t.file)
		if err != nil {
			return nil, err
		}
		obs, err := parseRBASeries(rows, t.file, t.freq, t.specs)
		if err != nil {
			return nil, err
		}
		all = append(all, obs...)
	}
	return all, nil
}

func parseRBASeries(rows [][]string, file, freq string, specs []rbaSpec) ([]Obs, error) {
	var obs []Obs
	for _, s := range specs {
		col, dataStart, ok := absdata.FindRBASeries(rows, s.seriesID)
		if !ok {
			return nil, fmt.Errorf("RBA %s: series %s not found", file, s.seriesID)
		}
		// def is copied by value into every Obs below, but its Dimensions
		// map is a reference shared across all of them — never mutate def
		// (or def.Dimensions) after this point.
		def := SeriesDef{
			Topic: "rates", Metric: s.metric,
			RegionType: "national", RegionCode: "aus", RegionName: "Australia",
			Unit: s.unit, Frequency: freq, Adjustment: "original",
			SourceKey: "rba-key-indicators", Licence: absdata.RBALicence,
			Dimensions: map[string]string{"rba_series_id": s.seriesID, "rba_table": file},
		}
		for _, row := range rows[dataStart:] {
			if len(row) <= col {
				continue
			}
			period, ok := absdata.ParseRBADate(row[0])
			if !ok {
				continue
			}
			val, err := strconv.ParseFloat(strings.TrimSpace(row[col]), 64)
			if err != nil {
				continue // blank/withheld cell
			}
			obs = append(obs, Obs{Series: def, Period: period, Value: val})
		}
	}
	return obs, nil
}
