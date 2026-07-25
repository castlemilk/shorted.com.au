package main

import (
	"context"
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type freshnessCadence struct {
	Cadence      string
	ExpectedDays int
	GraceDays    int
	Frozen       bool
	Note         string
}

func (c freshnessCadence) thresholdDays() int {
	return c.ExpectedDays + c.GraceDays
}

var (
	rbaFreshnessCadence               = freshnessCadence{Cadence: "daily/monthly", ExpectedDays: 30, GraceDays: 45}
	monthlyFreshnessCadence           = freshnessCadence{Cadence: "monthly", ExpectedDays: 30, GraceDays: 80}
	quarterlyFreshnessCadence         = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 140}
	populationFreshnessCadence        = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 230}
	governmentFinanceFreshnessCadence = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 150}
	annualFreshnessCadence            = freshnessCadence{Cadence: "annual", ExpectedDays: 365, GraceDays: 255}
	correlationFreshnessCadence       = freshnessCadence{Cadence: "monthly", ExpectedDays: 30, GraceDays: 10}
	frozenRetailFreshnessCadence      = freshnessCadence{
		Cadence:      "monthly",
		ExpectedDays: 30,
		GraceDays:    80,
		Frozen:       true,
		Note:         "upstream discontinued 2025-06, superseded by abs-household-spending",
	}
)

// sourceFreshnessCadences is intentionally pinned separately from sourceDefs.
// TestFreshnessCadencesCoverExactlyRegisteredEconomySources is the drift
// tripwire: adding or removing an economic source requires an explicit
// freshness decision here. Multi-cadence sources use their slowest meaningful
// family; derived crime rates rely on the separately monitored ABS crime source.
var sourceFreshnessCadences = map[string]freshnessCadence{
	"rba-key-indicators":          rbaFreshnessCadence,
	"rba-commodity-prices":        rbaFreshnessCadence,
	"rba-credit-aggregates":       rbaFreshnessCadence,
	"abs-cpi":                     quarterlyFreshnessCadence,
	"abs-labour-force":            monthlyFreshnessCadence,
	"abs-job-vacancies":           quarterlyFreshnessCadence,
	"abs-wage-price-index":        quarterlyFreshnessCadence,
	"abs-household-spending":      monthlyFreshnessCadence,
	"abs-lending-indicators":      quarterlyFreshnessCadence,
	"abs-construction-work-done":  quarterlyFreshnessCadence,
	"abs-business-indicators":     quarterlyFreshnessCadence,
	"abs-recorded-crime-victims":  annualFreshnessCadence,
	"abs-merch-trade-state":       monthlyFreshnessCadence,
	"abs-state-accounts":          quarterlyFreshnessCadence,
	"abs-building-approvals":      monthlyFreshnessCadence,
	"abs-retail-trade":            frozenRetailFreshnessCadence,
	"abs-population":              populationFreshnessCadence,
	"abs-government-finance":      governmentFinanceFreshnessCadence,
	"dcceew-petroleum-statistics": monthlyFreshnessCadence,
	"derived-shorted-markets":     rbaFreshnessCadence,
	"derived-shorted-economy":     quarterlyFreshnessCadence,
}

const sourceFreshnessQuery = `
SELECT
  series.source_key,
  MAX(obs.period)
FROM economic_series AS series
JOIN economic_observations AS obs ON obs.series_id = series.id
GROUP BY series.source_key`

const correlationFreshnessQuery = `
SELECT MAX(computed_at)
FROM economic_correlations`

type freshnessResult struct {
	SourceKey     string
	MaxPeriod     *time.Time
	AgeDays       *int
	ThresholdDays int
	Stale         bool
	Frozen        bool
	Note          string
}

func classifyFreshness(sourceKey string, maxPeriod *time.Time, now time.Time, cadence freshnessCadence) freshnessResult {
	result := freshnessResult{
		SourceKey:     sourceKey,
		MaxPeriod:     maxPeriod,
		ThresholdDays: cadence.thresholdDays(),
		Stale:         maxPeriod == nil && !cadence.Frozen,
		Frozen:        cadence.Frozen,
		Note:          cadence.Note,
	}
	if maxPeriod == nil {
		return result
	}

	ageDays := int(now.Sub(*maxPeriod).Hours() / 24)
	result.AgeDays = &ageDays
	result.Stale = !result.Frozen && ageDays > result.ThresholdDays
	return result
}

func collectFreshness(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]freshnessResult, error) {
	maxPeriods := make(map[string]time.Time, len(sourceFreshnessCadences))
	rows, err := pool.Query(ctx, sourceFreshnessQuery)
	if err != nil {
		return nil, fmt.Errorf("query source freshness: %w", err)
	}
	for rows.Next() {
		var (
			sourceKey string
			maxPeriod pgtype.Date
		)
		if err := rows.Scan(&sourceKey, &maxPeriod); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan source freshness: %w", err)
		}
		if maxPeriod.Valid {
			maxPeriods[sourceKey] = maxPeriod.Time
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read source freshness: %w", err)
	}
	rows.Close()

	results := make([]freshnessResult, 0, len(sourceFreshnessCadences)+1)
	for sourceKey, cadence := range sourceFreshnessCadences {
		maxPeriod, ok := maxPeriods[sourceKey]
		if !ok {
			results = append(results, classifyFreshness(sourceKey, nil, now, cadence))
			continue
		}
		results = append(results, classifyFreshness(sourceKey, &maxPeriod, now, cadence))
	}

	var maxComputedAt pgtype.Timestamptz
	if err := pool.QueryRow(ctx, correlationFreshnessQuery).Scan(&maxComputedAt); err != nil {
		return nil, fmt.Errorf("query correlation freshness: %w", err)
	}
	if maxComputedAt.Valid {
		results = append(results, classifyFreshness(
			"economic_correlations", &maxComputedAt.Time, now, correlationFreshnessCadence,
		))
	} else {
		results = append(results, classifyFreshness(
			"economic_correlations", nil, now, correlationFreshnessCadence,
		))
	}
	return results, nil
}

func writeFreshnessReport(w io.Writer, results []freshnessResult) int {
	sorted := append([]freshnessResult(nil), results...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].SourceKey < sorted[j].SourceKey
	})

	stale := 0
	frozen := 0
	for _, result := range sorted {
		maxPeriod := "NULL"
		ageDays := "unknown"
		status := "OK"
		if result.MaxPeriod != nil {
			maxPeriod = result.MaxPeriod.UTC().Format(time.DateOnly)
		}
		if result.AgeDays != nil {
			ageDays = fmt.Sprintf("%d", *result.AgeDays)
		}
		if result.Frozen {
			status = "FROZEN"
			frozen++
		} else if result.Stale {
			status = "STALE"
			stale++
		}
		fmt.Fprintf(w, "source_key=%s max_period=%s age_days=%s threshold=%d status=%s",
			result.SourceKey, maxPeriod, ageDays, result.ThresholdDays, status)
		if result.Note != "" {
			fmt.Fprintf(w, " note=%q", result.Note)
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintf(w, "freshness: total=%d stale=%d frozen=%d\n", len(sorted), stale, frozen)
	return stale
}
