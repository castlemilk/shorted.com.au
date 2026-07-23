package main

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const stateFinalDemandForPerCapitaQuery = `
SELECT
  series.region_code,
  series.region_name,
  series.region_type,
  obs.period,
  obs.value
FROM economic_series series
JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'gdp'
  AND series.metric = 'state_final_demand_chain_volume'
  AND series.product = 'total'
  AND series.source_key = 'abs-state-accounts'
  AND series.region_type = 'state'
  AND series.unit = 'aud'
  AND series.frequency = 'quarterly'
  AND series.adjustment = 'seasadj'
ORDER BY series.region_code, obs.period`

const householdSpendingForPerCapitaQuery = `
SELECT
  series.region_code,
  series.region_name,
  series.region_type,
  obs.period,
  obs.value
FROM economic_series series
JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'spending'
  AND series.metric = 'household'
  AND series.product = 'total'
  AND series.source_key = 'abs-household-spending'
  AND series.unit = 'aud'
  AND series.frequency = 'monthly'
  AND series.adjustment = 'seasadj'
ORDER BY series.region_code, obs.period`

const dwellingApprovalsForPerCapitaQuery = `
SELECT
  series.region_code,
  series.region_name,
  series.region_type,
  obs.period,
  obs.value
FROM economic_series series
JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'approvals'
  AND series.metric = 'dwelling_units'
  AND series.product = 'total'
  AND series.source_key = 'abs-building-approvals'
  AND series.region_type = 'state'
  AND series.unit = 'units'
  AND series.frequency = 'monthly'
  AND series.adjustment = 'original'
ORDER BY series.region_code, obs.period`

const erpForPerCapitaQuery = `
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
  AND series.unit = 'persons'
  AND series.frequency = 'quarterly'
  AND series.adjustment = 'original'
ORDER BY series.region_code, obs.period`

type derivedValueRow struct {
	RegionCode string
	RegionName string
	RegionType string
	Period     time.Time
	Value      float64
}

type erpRow struct {
	RegionCode string
	Period     time.Time
	Population float64
}

func forwardFilledERP(region string, period time.Time, populations []erpRow) (float64, bool) {
	var latest erpRow
	found := false
	for _, population := range populations {
		if population.RegionCode != region || population.Period.After(period) {
			continue
		}
		if !found || population.Period.After(latest.Period) {
			latest = population
			found = true
		}
	}
	return latest.Population, found
}

type perCapitaSpec struct {
	topic          string
	metric         string
	product        string
	unit           string
	frequency      string
	adjustment     string
	scale          float64
	forwardFillERP bool
}

func assembleStateFinalDemandPerCapitaObs(values []derivedValueRow, populations []erpRow) ([]Obs, error) {
	return assemblePerCapitaObs(values, populations, perCapitaSpec{
		topic: "gdp", metric: "state_final_demand_per_capita", product: "total",
		unit: "aud", frequency: "quarterly", adjustment: "seasadj", scale: 1,
	})
}

func assembleHouseholdSpendingPerCapitaObs(values []derivedValueRow, populations []erpRow) ([]Obs, error) {
	return assemblePerCapitaObs(values, populations, perCapitaSpec{
		topic: "spending", metric: "household_per_capita", product: "total",
		unit: "aud", frequency: "monthly", adjustment: "seasadj", scale: 1,
		forwardFillERP: true,
	})
}

func assembleDwellingApprovalsPer100kObs(values []derivedValueRow, populations []erpRow) ([]Obs, error) {
	return assemblePerCapitaObs(values, populations, perCapitaSpec{
		topic: "approvals", metric: "dwelling_units_per_100k", product: "total",
		unit: "rate_per_100k", frequency: "monthly", adjustment: "original", scale: 100000,
		forwardFillERP: true,
	})
}

func assemblePerCapitaObs(values []derivedValueRow, populations []erpRow, spec perCapitaSpec) ([]Obs, error) {
	populationByRegionPeriod := make(map[string]float64, len(populations))
	if !spec.forwardFillERP {
		for _, population := range populations {
			populationByRegionPeriod[regionPeriodKey(population.RegionCode, population.Period)] = population.Population
		}
	}

	sortedValues := append([]derivedValueRow(nil), values...)
	sort.SliceStable(sortedValues, func(i, j int) bool {
		if sortedValues[i].RegionCode != sortedValues[j].RegionCode {
			return sortedValues[i].RegionCode < sortedValues[j].RegionCode
		}
		return sortedValues[i].Period.Before(sortedValues[j].Period)
	})

	obs := make([]Obs, 0, len(sortedValues))
	for _, value := range sortedValues {
		if value.Value < 0 || math.IsNaN(value.Value) || math.IsInf(value.Value, 0) {
			return nil, fmt.Errorf(
				"%s.%s numerator drift for %s at %s: %v",
				spec.topic, spec.metric, value.RegionCode, value.Period.Format("2006-01-02"), value.Value,
			)
		}

		var population float64
		var ok bool
		if spec.forwardFillERP {
			population, ok = forwardFilledERP(value.RegionCode, value.Period, populations)
		} else {
			population, ok = populationByRegionPeriod[regionPeriodKey(value.RegionCode, value.Period)]
		}
		if !ok {
			continue
		}
		if population <= 0 || math.IsNaN(population) || math.IsInf(population, 0) {
			return nil, fmt.Errorf(
				"ERP denominator drift for %s at %s: %v",
				value.RegionCode, value.Period.Format("2006-01-02"), population,
			)
		}

		perCapita := value.Value / population * spec.scale
		if math.IsNaN(perCapita) || math.IsInf(perCapita, 0) || perCapita < 0 {
			return nil, fmt.Errorf(
				"%s.%s result drift for %s at %s: %v",
				spec.topic, spec.metric, value.RegionCode, value.Period.Format("2006-01-02"), perCapita,
			)
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: spec.topic, Metric: spec.metric, Product: spec.product,
				RegionType: value.RegionType, RegionCode: value.RegionCode, RegionName: value.RegionName,
				Unit: spec.unit, Frequency: spec.frequency, Adjustment: spec.adjustment,
				SourceKey: "derived-shorted-economy", Licence: "derived",
				Dimensions: map[string]string{"denominator": "erp"},
			},
			Period: value.Period,
			Value:  perCapita,
		})
	}
	return obs, nil
}

func regionPeriodKey(region string, period time.Time) string {
	return region + "@" + period.Format("2006-01-02")
}

func queryDerivedValues(
	ctx context.Context,
	pool *pgxpool.Pool,
	query string,
	family string,
) ([]derivedValueRow, error) {
	rows, err := pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("%s numerator query: %w", family, err)
	}
	defer rows.Close()

	var values []derivedValueRow
	for rows.Next() {
		var value derivedValueRow
		if err := rows.Scan(
			&value.RegionCode, &value.RegionName, &value.RegionType, &value.Period, &value.Value,
		); err != nil {
			return nil, fmt.Errorf("%s numerator scan: %w", family, err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s numerator rows: %w", family, err)
	}
	return values, nil
}

func queryERPForPerCapita(ctx context.Context, pool *pgxpool.Pool, family string) ([]erpRow, error) {
	rows, err := pool.Query(ctx, erpForPerCapitaQuery)
	if err != nil {
		return nil, fmt.Errorf("%s ERP query: %w", family, err)
	}
	defer rows.Close()

	var populations []erpRow
	for rows.Next() {
		var population erpRow
		if err := rows.Scan(&population.RegionCode, &population.Period, &population.Population); err != nil {
			return nil, fmt.Errorf("%s ERP scan: %w", family, err)
		}
		populations = append(populations, population)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s ERP rows: %w", family, err)
	}
	return populations, nil
}

func derivePerCapitaFamily(
	ctx context.Context,
	pool *pgxpool.Pool,
	family string,
	query string,
	assemble func([]derivedValueRow, []erpRow) ([]Obs, error),
) ([]Obs, error) {
	values, err := queryDerivedValues(ctx, pool, query, family)
	if err != nil {
		return nil, err
	}
	populations, err := queryERPForPerCapita(ctx, pool, family)
	if err != nil {
		return nil, err
	}
	obs, err := assemble(values, populations)
	if err != nil {
		return nil, err
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf(
			"derivation produced 0 observations — matching numerator and ERP history is missing for %s; treating as drift, not success",
			family,
		)
	}
	return obs, nil
}

func deriveStateFinalDemandPerCapita(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return derivePerCapitaFamily(
		ctx, pool, "state final demand per capita", stateFinalDemandForPerCapitaQuery,
		assembleStateFinalDemandPerCapitaObs,
	)
}

func deriveHouseholdSpendingPerCapita(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return derivePerCapitaFamily(
		ctx, pool, "household spending per capita", householdSpendingForPerCapitaQuery,
		assembleHouseholdSpendingPerCapitaObs,
	)
}

func deriveDwellingApprovalsPer100k(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return derivePerCapitaFamily(
		ctx, pool, "dwelling approvals per 100k", dwellingApprovalsForPerCapitaQuery,
		assembleDwellingApprovalsPer100kObs,
	)
}
