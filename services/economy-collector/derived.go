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

const crimeVictimsForRatesQuery = `
SELECT
  series.region_code,
  series.region_name,
  series.region_type,
  obs.period,
  series.product,
  obs.value,
  COALESCE(series.dimensions->>'comparability', '')
FROM economic_series series
JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'crime'
  AND series.metric = 'victims'
  AND series.source_key = 'abs-recorded-crime-victims'
  AND series.region_type = 'state'
  AND series.unit = 'persons'
  AND series.frequency = 'annual'
  AND series.adjustment = 'original'
  AND series.product IN (
    'homicide',
    'assault',
    'sexual-assault',
    'robbery',
    'unlawful-entry',
    'motor-vehicle-theft',
    'other-theft'
  )
ORDER BY series.region_code, series.product, obs.period`

const crimePopulationForRatesQuery = `
SELECT
  series.region_code,
  obs.period,
  obs.value
FROM economic_series series
JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'population'
  AND series.metric = 'erp'
  AND series.product = 'total'
  AND series.source_key = 'abs-population'
  AND series.region_type = 'state'
  AND series.unit = 'persons'
  AND series.frequency = 'quarterly'
  AND series.adjustment = 'original'
ORDER BY series.region_code, obs.period`

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

type crimeVictimRow struct {
	RegionCode    string
	RegionName    string
	RegionType    string
	Period        time.Time
	Offence       string
	Victims       float64
	Comparability string
}

type crimePopulationRow struct {
	RegionCode string
	Period     time.Time
	Population float64
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

// assembleCrimeRateObs performs an exact in-memory inner join between each
// annual victim observation and that state's ERP at the start of the same
// year's June quarter (YYYY-04-01). Missing, non-positive, or non-finite ERP
// is skipped, as is any input or result that cannot produce a finite rate.
func assembleCrimeRateObs(victims []crimeVictimRow, populations []crimePopulationRow) []Obs {
	populationByRegionPeriod := make(map[string]float64, len(populations))
	for _, population := range populations {
		if population.Population <= 0 || math.IsNaN(population.Population) || math.IsInf(population.Population, 0) {
			continue
		}
		populationByRegionPeriod[population.RegionCode+"@"+population.Period.Format("2006-01-02")] = population.Population
	}

	obs := make([]Obs, 0, len(victims))
	for _, victim := range victims {
		if victim.Victims < 0 || math.IsNaN(victim.Victims) || math.IsInf(victim.Victims, 0) {
			continue
		}
		erpPeriod := time.Date(victim.Period.Year(), 4, 1, 0, 0, 0, 0, time.UTC)
		population, ok := populationByRegionPeriod[victim.RegionCode+"@"+erpPeriod.Format("2006-01-02")]
		if !ok {
			continue
		}
		rate := victim.Victims / population * 100000
		if math.IsNaN(rate) || math.IsInf(rate, 0) {
			continue
		}
		dimensions := map[string]string{
			"derivation":         "victims / June-quarter ERP * 100000",
			"denominator_series": "population.erp.total." + victim.RegionCode,
			"denominator_period": "June-quarter-start",
		}
		if victim.Comparability != "" {
			dimensions["comparability"] = victim.Comparability
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "crime", Metric: "victims_rate_100k", Product: victim.Offence,
				RegionType: victim.RegionType, RegionCode: victim.RegionCode, RegionName: victim.RegionName,
				Unit: "rate_per_100k", Frequency: "annual", Adjustment: "original",
				SourceKey: "derived-shorted-economy", Licence: "derived", Dimensions: dimensions,
			},
			Period: victim.Period,
			Value:  rate,
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

func deriveCrimeRates(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	victimRows, err := pool.Query(ctx, crimeVictimsForRatesQuery)
	if err != nil {
		return nil, fmt.Errorf("crime victims derivation query: %w", err)
	}
	var victims []crimeVictimRow
	for victimRows.Next() {
		var row crimeVictimRow
		if err := victimRows.Scan(
			&row.RegionCode, &row.RegionName, &row.RegionType, &row.Period,
			&row.Offence, &row.Victims, &row.Comparability,
		); err != nil {
			victimRows.Close()
			return nil, fmt.Errorf("crime victims scan: %w", err)
		}
		victims = append(victims, row)
	}
	if err := victimRows.Err(); err != nil {
		victimRows.Close()
		return nil, fmt.Errorf("crime victims rows: %w", err)
	}
	victimRows.Close()

	populationRows, err := pool.Query(ctx, crimePopulationForRatesQuery)
	if err != nil {
		return nil, fmt.Errorf("crime population derivation query: %w", err)
	}
	var populations []crimePopulationRow
	for populationRows.Next() {
		var row crimePopulationRow
		if err := populationRows.Scan(&row.RegionCode, &row.Period, &row.Population); err != nil {
			populationRows.Close()
			return nil, fmt.Errorf("crime population scan: %w", err)
		}
		populations = append(populations, row)
	}
	if err := populationRows.Err(); err != nil {
		populationRows.Close()
		return nil, fmt.Errorf("crime population rows: %w", err)
	}
	populationRows.Close()

	rates := assembleCrimeRateObs(victims, populations)
	if len(rates) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"annual recorded-crime victims or exact June-quarter state ERP is missing; treating as drift, not success")
	}
	return rates, nil
}

// ingestDerived runs every independent derivation even when another one fails.
// runJob persists healthy families' observations alongside the returned error,
// so missing crime/ERP cannot stale real wages or trade balance (and vice
// versa).
func ingestDerived(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return runDerivationFamilies(
		derivationFamily{name: "real wages", run: func() ([]Obs, error) {
			return deriveRealWages(ctx, pool)
		}},
		derivationFamily{name: "trade balance", run: func() ([]Obs, error) {
			return deriveTradeBalances(ctx, pool)
		}},
		derivationFamily{name: "recorded crime rates", run: func() ([]Obs, error) {
			return deriveCrimeRates(ctx, pool)
		}},
	)
}
