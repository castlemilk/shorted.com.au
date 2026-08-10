package houseprices

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type vgFreshnessPolicy struct {
	source     string
	maxAgeDays int
}

var vgFreshnessPolicies = []vgFreshnessPolicy{
	{source: "vg_nsw", maxAgeDays: 550},
	{source: "vg_sa", maxAgeDays: 270},
	{source: "vg_vic", maxAgeDays: 550},
}

const vgFreshnessQuery = `
	SELECT source, MAX(period) AS max_period
	FROM house_prices
	WHERE source IN ('vg_nsw', 'vg_sa', 'vg_vic')
	GROUP BY source
	ORDER BY source`

func loadVGFreshness(ctx context.Context, pool *pgxpool.Pool) (map[string]*time.Time, error) {
	rows, err := pool.Query(ctx, vgFreshnessQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	maxPeriods := make(map[string]*time.Time, len(vgFreshnessPolicies))
	for rows.Next() {
		var source string
		var maxPeriod time.Time
		if err := rows.Scan(&source, &maxPeriod); err != nil {
			return nil, err
		}
		period := maxPeriod
		maxPeriods[source] = &period
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return maxPeriods, nil
}

func classifyVGFreshness(now time.Time, policy vgFreshnessPolicy, maxPeriod *time.Time) string {
	if maxPeriod == nil {
		return fmt.Sprintf("LOUD: %s house_prices has never succeeded; no persisted period exists", policy.source)
	}
	threshold := time.Duration(policy.maxAgeDays) * 24 * time.Hour
	if now.After(maxPeriod.Add(threshold)) {
		return fmt.Sprintf(
			"LOUD: %s house_prices MAX(period) %s is stale beyond %d-day threshold",
			policy.source,
			maxPeriod.Format("2006-01-02"),
			policy.maxAgeDays,
		)
	}
	return ""
}

func enforceVGFreshness(
	ctx context.Context,
	now time.Time,
	policies []vgFreshnessPolicy,
	maxPeriods map[string]*time.Time,
	record func(context.Context, string, *time.Time, string, string) error,
) int {
	ordered := append([]vgFreshnessPolicy(nil), policies...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].source < ordered[j].source })

	exitCode := 0
	for _, policy := range ordered {
		maxPeriod := maxPeriods[policy.source]
		detail := classifyVGFreshness(now, policy, maxPeriod)
		if detail == "" {
			continue
		}
		exitCode = 1
		log.Printf("[vg-freshness] %s", detail)
		if err := record(ctx, policy.source, maxPeriod, "error", detail); err != nil {
			log.Printf("[vg-freshness] failed to persist %s error status: %v", policy.source, err)
		}
	}
	return exitCode
}

func assertOfficialVGFreshness(ctx context.Context, pool *pgxpool.Pool, policies []vgFreshnessPolicy) int {
	maxPeriods, err := loadVGFreshness(ctx, pool)
	if err != nil {
		log.Printf("[vg-freshness] LOUD: failed to load persisted MAX(period) freshness: %v", err)
		return 1
	}
	return enforceVGFreshness(
		ctx,
		time.Now(),
		policies,
		maxPeriods,
		func(ctx context.Context, source string, lastPeriod *time.Time, status, detail string) error {
			return updateRun(ctx, pool, source, lastPeriod, 0, status, detail)
		},
	)
}
