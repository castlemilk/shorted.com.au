package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	correlationWindowMonths = 24
	correlationMinimumN     = 12
)

type correlationObservation struct {
	Period time.Time
	Value  float64
}

type correlationSeries struct {
	Key          string
	Topic        string
	RegionCode   string
	RegionType   string
	Frequency    string
	Observations []correlationObservation
}

type alignedCorrelationPair struct {
	Month  string
	Period time.Time
	X      float64
	Y      float64
}

type economicCorrelationRow struct {
	BaseSeriesKey    string
	OverlaySeriesKey string
	WindowMonths     int
	R                float64
	N                int
	LastPeriod       time.Time
}

type correlationStats struct {
	BaseSeries        int
	EligiblePairs     int
	ComputedPairs     int
	InsufficientPairs int
}

// correlationSeriesQuery reads every markets series as a potential base,
// including an empty base so stale stored rows can still be deleted. Potential
// overlays are restricted to the monthly/quarterly catalog before observations
// are transferred to the collector.
const correlationSeriesQuery = `
SELECT
  series.series_key,
  series.topic,
  series.region_code,
  series.region_type,
  series.frequency,
  obs.period,
  obs.value
FROM economic_series series
LEFT JOIN economic_observations obs ON obs.series_id = series.id
WHERE series.topic = 'markets'
   OR (series.topic <> 'markets' AND series.frequency IN ('monthly', 'quarterly'))
ORDER BY series.series_key, obs.period`

func loadCorrelationSeries(ctx context.Context, pool *pgxpool.Pool) ([]correlationSeries, error) {
	rows, err := pool.Query(ctx, correlationSeriesQuery)
	if err != nil {
		return nil, fmt.Errorf("load series: %w", err)
	}
	defer rows.Close()

	byKey := make(map[string]int)
	var series []correlationSeries
	for rows.Next() {
		var (
			key, topic, regionCode, regionType, frequency string
			period                                        pgtype.Date
			value                                         pgtype.Float8
		)
		if err := rows.Scan(&key, &topic, &regionCode, &regionType, &frequency, &period, &value); err != nil {
			return nil, fmt.Errorf("scan series: %w", err)
		}
		index, ok := byKey[key]
		if !ok {
			index = len(series)
			byKey[key] = index
			series = append(series, correlationSeries{
				Key:        key,
				Topic:      topic,
				RegionCode: regionCode,
				RegionType: regionType,
				Frequency:  frequency,
			})
		}
		if period.Valid && value.Valid {
			series[index].Observations = append(series[index].Observations, correlationObservation{
				Period: period.Time,
				Value:  value.Float64,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load series rows: %w", err)
	}
	return series, nil
}

func correlationMonthKey(period time.Time) string {
	return period.UTC().Format("2006-01")
}

func correlationMonthsBetween(a, b time.Time) int {
	a = a.UTC()
	b = b.UTC()
	return (b.Year()-a.Year())*12 + int(b.Month()-a.Month())
}

func sortedCorrelationObservations(observations []correlationObservation) []correlationObservation {
	sorted := append([]correlationObservation(nil), observations...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Period.Before(sorted[j].Period)
	})
	return sorted
}

// correlationSeriesIsQuarterly intentionally ports correlation.ts's cadence
// detection instead of trusting catalog metadata: the tightest consecutive
// gap must be at least two months, and a singleton is not assumed quarterly.
func correlationSeriesIsQuarterly(sorted []correlationObservation) bool {
	if len(sorted) < 2 {
		return false
	}
	minimumGap := int(^uint(0) >> 1)
	for i := 1; i < len(sorted); i++ {
		gap := correlationMonthsBetween(sorted[i-1].Period, sorted[i].Period)
		if gap < minimumGap {
			minimumGap = gap
		}
	}
	return minimumGap >= 2
}

// expandCorrelationToMonthly ports expandToMonthly from correlation.ts.
// Quarterly values carry only into later months of their own calendar quarter;
// they never fill backward or cross a missing-quarter boundary.
func expandCorrelationToMonthly(observations []correlationObservation) map[string]correlationObservation {
	sorted := sortedCorrelationObservations(observations)
	expanded := make(map[string]correlationObservation, len(sorted))
	for _, observation := range sorted {
		period := observation.Period.UTC()
		observation.Period = time.Date(period.Year(), period.Month(), 1, 0, 0, 0, 0, time.UTC)
		expanded[correlationMonthKey(period)] = observation
	}
	if !correlationSeriesIsQuarterly(sorted) {
		return expanded
	}

	for _, observation := range sorted {
		period := observation.Period.UTC()
		quarter := (int(period.Month()) - 1) / 3
		for month := int(period.Month()); month <= 12 && (month-1)/3 == quarter; month++ {
			filledPeriod := time.Date(period.Year(), time.Month(month), 1, 0, 0, 0, 0, time.UTC)
			key := correlationMonthKey(filledPeriod)
			if _, exists := expanded[key]; !exists {
				expanded[key] = correlationObservation{Period: filledPeriod, Value: observation.Value}
			}
		}
	}
	return expanded
}

func alignCorrelationMonthly(a, b []correlationObservation) []alignedCorrelationPair {
	expandedA := expandCorrelationToMonthly(a)
	expandedB := expandCorrelationToMonthly(b)
	aligned := make([]alignedCorrelationPair, 0)
	for month, x := range expandedA {
		y, ok := expandedB[month]
		if !ok {
			continue
		}
		aligned = append(aligned, alignedCorrelationPair{
			Month:  month,
			Period: x.Period,
			X:      x.Value,
			Y:      y.Value,
		})
	}
	sort.Slice(aligned, func(i, j int) bool {
		return aligned[i].Month < aligned[j].Month
	})
	return aligned
}

func correlationPearson(xs, ys []float64) (float64, bool) {
	n := min(len(xs), len(ys))
	if n < 3 {
		return 0, false
	}
	var sumX, sumY float64
	for i := range n {
		sumX += xs[i]
		sumY += ys[i]
	}
	meanX := sumX / float64(n)
	meanY := sumY / float64(n)

	var covariance, varianceX, varianceY float64
	for i := range n {
		deltaX := xs[i] - meanX
		deltaY := ys[i] - meanY
		covariance += deltaX * deltaY
		varianceX += deltaX * deltaX
		varianceY += deltaY * deltaY
	}
	if varianceX == 0 || varianceY == 0 {
		return 0, false
	}
	r := covariance / math.Sqrt(varianceX*varianceY)
	return max(-1, min(1, r)), true
}

func rollingPearson(
	a, b []correlationObservation,
	windowMonths int,
) (r float64, n int, lastPeriod time.Time, ok bool) {
	aligned := alignCorrelationMonthly(a, b)
	if len(aligned) > windowMonths {
		aligned = aligned[len(aligned)-windowMonths:]
	}
	n = len(aligned)
	if n > 0 {
		lastPeriod = aligned[n-1].Period
	}
	xs := make([]float64, n)
	ys := make([]float64, n)
	for i, pair := range aligned {
		xs[i] = pair.X
		ys[i] = pair.Y
	}
	r, ok = correlationPearson(xs, ys)
	return r, n, lastPeriod, ok
}

func eligibleCorrelationOverlay(base, overlay correlationSeries) bool {
	if base.Topic != "markets" || overlay.Topic == "markets" {
		return false
	}
	if overlay.Frequency != "monthly" && overlay.Frequency != "quarterly" {
		return false
	}
	return overlay.RegionCode == base.RegionCode || overlay.RegionType == "national"
}

func computeCorrelationRows(
	series []correlationSeries,
	windowMonths, minimumN int,
) ([]economicCorrelationRow, correlationStats) {
	stats := correlationStats{}
	var rows []economicCorrelationRow
	for _, base := range series {
		if base.Topic != "markets" {
			continue
		}
		stats.BaseSeries++
		for _, overlay := range series {
			if !eligibleCorrelationOverlay(base, overlay) {
				continue
			}
			stats.EligiblePairs++
			r, n, lastPeriod, ok := rollingPearson(base.Observations, overlay.Observations, windowMonths)
			if !ok || n < minimumN {
				stats.InsufficientPairs++
				continue
			}
			rows = append(rows, economicCorrelationRow{
				BaseSeriesKey:    base.Key,
				OverlaySeriesKey: overlay.Key,
				WindowMonths:     windowMonths,
				R:                r,
				N:                n,
				LastPeriod:       lastPeriod,
			})
			stats.ComputedPairs++
		}
	}
	return rows, stats
}

const insertEconomicCorrelation = `
INSERT INTO economic_correlations
  (base_series_key, overlay_series_key, window_months, r, n, last_period, computed_at)
VALUES ($1, $2, $3, $4, $5, $6, now())`

func replaceEconomicCorrelations(
	ctx context.Context,
	pool *pgxpool.Pool,
	series []correlationSeries,
	rows []economicCorrelationRow,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin replacement: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, candidate := range series {
		if candidate.Topic != "markets" {
			continue
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM economic_correlations WHERE base_series_key = $1`,
			candidate.Key,
		); err != nil {
			return fmt.Errorf("delete base %s: %w", candidate.Key, err)
		}
	}

	batch := &pgx.Batch{}
	for _, row := range rows {
		batch.Queue(
			insertEconomicCorrelation,
			row.BaseSeriesKey,
			row.OverlaySeriesKey,
			row.WindowMonths,
			row.R,
			row.N,
			row.LastPeriod,
		)
	}
	results := tx.SendBatch(ctx, batch)
	for _, row := range rows {
		if _, err := results.Exec(); err != nil {
			_ = results.Close()
			return fmt.Errorf("insert %s/%s: %w", row.BaseSeriesKey, row.OverlaySeriesKey, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("close replacement batch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit replacement: %w", err)
	}
	return nil
}

func ingestCorrelations(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	series, err := loadCorrelationSeries(ctx, pool)
	if err != nil {
		return 0, err
	}
	rows, stats := computeCorrelationRows(series, correlationWindowMonths, correlationMinimumN)
	log.Printf(
		"correlations: bases=%d eligible_pairs=%d computed_pairs=%d skipped_pairs=%d",
		stats.BaseSeries,
		stats.EligiblePairs,
		stats.ComputedPairs,
		stats.InsufficientPairs,
	)
	if len(rows) == 0 {
		return 0, fmt.Errorf(
			"computed 0 correlation rows from %d bases and %d eligible pairs — treating as stale or insufficient source history, not success",
			stats.BaseSeries,
			stats.EligiblePairs,
		)
	}
	if err := replaceEconomicCorrelations(ctx, pool, series, rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}
