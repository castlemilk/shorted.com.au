package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// realWagesQuery reads the original quarterly WPI YoY series and computes the
// national CPI comparison inputs from the quarterly CPI index. The exact
// one-year self-join prevents a missing quarter from turning "four rows ago"
// into the wrong comparison period. Arithmetic remains in Go so it is covered
// by a pure unit test.
const realWagesQuery = `
WITH cpi_yoy_inputs AS (
  SELECT
    current_obs.period,
    current_obs.value AS current_index,
    prior_obs.value   AS prior_year_index
  FROM economic_series cpi_series
  JOIN economic_observations current_obs ON current_obs.series_id = cpi_series.id
  JOIN economic_observations prior_obs
    ON prior_obs.series_id = cpi_series.id
   AND prior_obs.period = (current_obs.period - INTERVAL '1 year')::date
  WHERE cpi_series.series_key = 'cpi.index.all_groups.aus'
    AND prior_obs.value <> 0
), wpi_yoy AS (
  SELECT
    series.region_code,
    series.region_name,
    series.region_type,
    obs.period,
    obs.value AS wpi_yoy
  FROM economic_series series
  JOIN economic_observations obs ON obs.series_id = series.id
  WHERE series.topic = 'wages'
    AND series.metric = 'wpi_yoy'
    AND series.product IS NULL
    AND series.frequency = 'quarterly'
    AND series.adjustment = 'original'
)
SELECT
  wpi.region_code,
  wpi.region_name,
  wpi.region_type,
  wpi.period,
  wpi.wpi_yoy,
  cpi.current_index,
  cpi.prior_year_index
FROM wpi_yoy wpi
JOIN cpi_yoy_inputs cpi ON cpi.period = wpi.period
ORDER BY wpi.region_code, wpi.period`

// tradeBalanceQuery targets the all-commodities product emitted by trade.go:
// COMMODITY_SITC=TOT maps to the literal product segment "total". Inner joins
// on both catalog rows and observations ensure only months with both flows are
// presented for derivation.
const tradeBalanceQuery = `
WITH exports AS (
  SELECT
    series.region_code,
    series.region_name,
    series.region_type,
    obs.period,
    obs.value
  FROM economic_series series
  JOIN economic_observations obs ON obs.series_id = series.id
  WHERE series.topic = 'trade'
    AND series.metric = 'export_value'
    AND series.product = 'total'
    AND series.frequency = 'monthly'
    AND series.adjustment = 'original'
), imports AS (
  SELECT
    series.region_code,
    obs.period,
    obs.value
  FROM economic_series series
  JOIN economic_observations obs ON obs.series_id = series.id
  WHERE series.topic = 'trade'
    AND series.metric = 'import_value'
    AND series.product = 'total'
    AND series.frequency = 'monthly'
    AND series.adjustment = 'original'
)
SELECT
  exports.region_code,
  exports.region_name,
  exports.region_type,
  exports.period,
  exports.value,
  imports.value
FROM exports
JOIN imports
  ON imports.region_code = exports.region_code
 AND imports.period = exports.period
ORDER BY exports.region_code, exports.period`

type realWagesRow struct {
	RegionCode      string
	RegionName      string
	RegionType      string
	Period          time.Time
	WPIYoY          float64
	CPIIndex        float64
	CPIIndexYearAgo float64
}

func realWagesObs(row realWagesRow) (Obs, bool) {
	if row.CPIIndexYearAgo == 0 {
		return Obs{}, false
	}
	cpiYoY := (row.CPIIndex/row.CPIIndexYearAgo - 1) * 100
	value := row.WPIYoY - cpiYoY
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return Obs{}, false
	}
	return Obs{
		Series: SeriesDef{
			Topic:      "wages",
			Metric:     "real_wpi_yoy",
			RegionType: row.RegionType,
			RegionCode: row.RegionCode,
			RegionName: row.RegionName,
			Unit:       "percent",
			Frequency:  "quarterly",
			Adjustment: "original",
			SourceKey:  "derived-shorted-economy",
			Licence:    "derived",
			Dimensions: map[string]string{"deflator": "cpi-national"},
		},
		Period: row.Period,
		Value:  value,
	}, true
}

type tradeBalanceRow struct {
	RegionCode  string
	RegionName  string
	RegionType  string
	Period      time.Time
	ExportValue float64
	ImportValue float64
}

func assembleTradeBalanceObs(rows []tradeBalanceRow) []Obs {
	obs := make([]Obs, 0, len(rows))
	for _, row := range rows {
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic:      "trade",
				Metric:     "balance",
				Product:    "total",
				RegionType: row.RegionType,
				RegionCode: row.RegionCode,
				RegionName: row.RegionName,
				Unit:       "aud",
				Frequency:  "monthly",
				Adjustment: "original",
				SourceKey:  "derived-shorted-economy",
				Licence:    "derived",
			},
			Period: row.Period,
			Value:  row.ExportValue - row.ImportValue,
		})
	}
	return obs
}

func deriveRealWages(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	realRows, err := pool.Query(ctx, realWagesQuery)
	if err != nil {
		return nil, fmt.Errorf("derivation query: %w", err)
	}
	defer realRows.Close()

	var realWages []Obs
	for realRows.Next() {
		var row realWagesRow
		if err := realRows.Scan(
			&row.RegionCode, &row.RegionName, &row.RegionType, &row.Period,
			&row.WPIYoY, &row.CPIIndex, &row.CPIIndexYearAgo,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if obs, ok := realWagesObs(row); ok {
			realWages = append(realWages, obs)
		}
	}
	if err := realRows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	if len(realWages) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"quarterly WPI YoY or national quarterly CPI index history is missing; treating as drift, not success")
	}
	return realWages, nil
}

func deriveTradeBalances(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	tradeRows, err := pool.Query(ctx, tradeBalanceQuery)
	if err != nil {
		return nil, fmt.Errorf("derivation query: %w", err)
	}
	defer tradeRows.Close()

	var rawTradeRows []tradeBalanceRow
	for tradeRows.Next() {
		var row tradeBalanceRow
		if err := tradeRows.Scan(
			&row.RegionCode, &row.RegionName, &row.RegionType, &row.Period,
			&row.ExportValue, &row.ImportValue,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		rawTradeRows = append(rawTradeRows, row)
	}
	if err := tradeRows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	tradeBalances := assembleTradeBalanceObs(rawTradeRows)
	if len(tradeBalances) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"matching total export/import months are missing; treating as drift, not success")
	}
	return tradeBalances, nil
}

// ingestDerived runs both independent derivations even when either one fails.
// runJob persists the healthy family's observations alongside the returned
// error, so missing WPI/CPI cannot stale trade balance (or vice versa).
func ingestDerived(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return runDerivationFamilies(
		derivationFamily{name: "real wages", run: func() ([]Obs, error) {
			return deriveRealWages(ctx, pool)
		}},
		derivationFamily{name: "trade balance", run: func() ([]Obs, error) {
			return deriveTradeBalances(ctx, pool)
		}},
	)
}
