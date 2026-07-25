package economy

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
	product  string
	unit     string
}

type rbaTable struct {
	file       string
	freq       string
	topic      string
	sourceKey  string
	adjustment string
	specs      []rbaSpec
}

// F1.1 = cash rate (RBA publishes monthly-average observations); F11.1 =
// exchange rates (AUD/USD FXRUSD, TWI FXRTWI), which RBA publishes daily. I2
// contains A$ commodity-price indexes; D1 contains 12-month-ended credit growth.
var rbaTables = []rbaTable{
	{file: "f1.1-data.csv", freq: "monthly", topic: "rates", sourceKey: "rba-key-indicators", adjustment: "original", specs: []rbaSpec{
		{seriesID: "FIRMMCRT", metric: "cash_rate_target", unit: "percent"},
	}},
	{file: "f11.1-data.csv", freq: "daily", topic: "rates", sourceKey: "rba-key-indicators", adjustment: "original", specs: []rbaSpec{
		{seriesID: "FXRUSD", metric: "aud_usd", unit: "usd"},
		{seriesID: "FXRTWI", metric: "trade_weighted_index", unit: "index"},
	}},
	{file: "i2-data.csv", freq: "monthly", topic: "commodities", sourceKey: "rba-commodity-prices", adjustment: "original", specs: []rbaSpec{
		{seriesID: "GRCPAIAD", metric: "price_index", product: "all_items", unit: "index"},
		{seriesID: "GRCPRCAD", metric: "price_index", product: "rural", unit: "index"},
		{seriesID: "GRCPNRAD", metric: "price_index", product: "non_rural", unit: "index"},
		{seriesID: "GRCPBMAD", metric: "price_index", product: "base_metals", unit: "index"},
		{seriesID: "GRCPBCAD", metric: "price_index", product: "bulk", unit: "index"},
		{seriesID: "GRCPBCSAD", metric: "price_index", product: "bulk_spot", unit: "index"},
	}},
	{file: "d1-data.csv", freq: "monthly", topic: "credit", sourceKey: "rba-credit-aggregates", adjustment: "seasadj", specs: []rbaSpec{
		{seriesID: "DGFACH12", metric: "growth_yoy", product: "housing", unit: "percent"},
		{seriesID: "DGFACOH12", metric: "growth_yoy", product: "owner_occupier_housing", unit: "percent"},
		{seriesID: "DGFACIH12", metric: "growth_yoy", product: "investor_housing", unit: "percent"},
		{seriesID: "DGFACOP12", metric: "growth_yoy", product: "personal", unit: "percent"},
		// DGFACB12 ("Business") was discontinued 2019-06; DGFACBNF12
		// ("Non-financial Business", 2004→) is the live successor (probed 2026-07-22).
		{seriesID: "DGFACBNF12", metric: "growth_yoy", product: "business", unit: "percent"},
	}},
}

func ingestRBA(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	var all []Obs
	for _, t := range rbaTables {
		rows, err := c.FetchRBATable(ctx, t.file)
		if err != nil {
			return nil, err
		}
		obs, err := parseRBASeries(rows, t)
		if err != nil {
			return nil, err
		}
		all = append(all, obs...)
	}
	return all, nil
}

func parseRBASeries(rows [][]string, table rbaTable) ([]Obs, error) {
	var obs []Obs
	for _, s := range table.specs {
		col, dataStart, ok := absdata.FindRBASeries(rows, s.seriesID)
		if !ok {
			return nil, fmt.Errorf("RBA %s: series %s not found", table.file, s.seriesID)
		}
		// def is copied by value into every Obs below, but its Dimensions
		// map is a reference shared across all of them — never mutate def
		// (or def.Dimensions) after this point.
		def := SeriesDef{
			Topic: table.topic, Metric: s.metric, Product: s.product,
			RegionType: "national", RegionCode: "aus", RegionName: "Australia",
			Unit: s.unit, Frequency: table.freq, Adjustment: table.adjustment,
			SourceKey: table.sourceKey, Licence: absdata.RBALicence,
			Dimensions: map[string]string{"rba_series_id": s.seriesID, "rba_table": table.file},
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
