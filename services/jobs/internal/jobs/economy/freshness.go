package economy

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

// Threshold calibration rule (recalibrated 2026-08-22, see the block comment
// below): AgeDays is measured from the PERIOD START of the newest observation,
// so a threshold must cover the publisher's own lag, not just its cadence. The
// pipeline that consumes these thresholds is:
//
//	period start -> publisher release -> next collector run (monthly, 5th
//	17:00 UTC) -> freshness check (monthly, 8th)
//
// A release landing after the 5th therefore waits a FULL MONTH before it can
// be ingested, and that wait is the designed steady state — a threshold that
// does not cover it fires on healthy data and stops meaning anything. Every
// threshold below is period-start + measured publisher lag + one missed ingest
// cycle (31d) + one further missed cycle + 3d to the check, with ~1 month of
// slack. Publisher lags were measured from the live ABS/DCCEEW release pages
// on 2026-08-22 and are cited per-cadence.
var (
	rbaFreshnessCadence = freshnessCadence{Cadence: "daily/monthly", ExpectedDays: 30, GraceDays: 45}
	// ABS monthly releases land ~4-5 weeks after the reference month
	// (measured 2026-08-22: Building Approvals June 2026 -> released
	// 30/07/2026; International Trade in Goods June 2026 -> 6/08/2026).
	// Worst designed check age = 30 (period) + ~36 (release) + 31 (release
	// landed after the 5th) + 31 (one further missed cycle — the ABS Data API
	// can load a flow AFTER its own web release; BA_SA2 carried 2026-06 on
	// 2026-08-22 but not at the 2026-08-05 run) + 3 = ~131.
	monthlyFreshnessCadence = freshnessCadence{Cadence: "monthly", ExpectedDays: 30, GraceDays: 110}
	// ABS quarterly releases land ~60-70 days after quarter END, i.e. ~150-160
	// days after period start (measured 2026-08-22: Business Indicators Mar-2026
	// qtr -> 2/06/2026; National Accounts Mar-2026 qtr -> 3/06/2026; WPI Jun-2026
	// qtr -> 19/08/2026; Lending Indicators Jun-2026 qtr -> 14/08/2026).
	// Worst designed check age = 90 + ~160 + 31 (one missed ingest cycle) - the
	// quarter already replaced = ~250 before the next quarter lands.
	quarterlyFreshnessCadence = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 170}
	// ERP is quarterly with a ~6-month publication lag (measured 2026-08-22: the
	// Dec-2025 quarter, period start 2025-10-01, was released 18/06/2026 = 260
	// days). The Dec-2025 quarter stays our newest period until the Mar-2026
	// quarter is published (~18/09/2026) and ingested on 2026-10-05 = 369 days,
	// +3 to the check = 372. The old 320 threshold flipped this source STALE on
	// 2026-08-17 with the data fully caught up to the publisher.
	populationFreshnessCadence = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 310}
	// GFS is the quarterly XLSX cube, published a little later than the SDMX
	// quarterlies; same arithmetic as quarterlyFreshnessCadence plus its extra lag.
	governmentFinanceFreshnessCadence = freshnessCadence{Cadence: "quarterly", ExpectedDays: 90, GraceDays: 190}
	// ABS Recorded Crime — Victims is ANNUAL and published ~8 months after the
	// reference year ENDS: the 2024 issue (period start 2024-01-01) was released
	// 3/09/2025 = 611 days after period start (verified on the latest-release
	// page, 2026-08-22 — 2024 is still the newest issue upstream, so prod is
	// fully caught up). That issue then remains our newest period for a further
	// YEAR, until the 2025 issue is published (~3/09/2026) and ingested on the
	// following 5th: 611 + 365 + 31 + 3 = ~1010 days at the check.
	//
	// The old 365+255=620 threshold was therefore ~390 days short of the healthy
	// steady state: it tripped ~9 days after the 2024 issue was ingested and has
	// marked this source STALE on every monthly run since. ExpectedDays is two
	// annual cycles because that — not one — is the interval a given period start
	// must survive.
	annualFreshnessCadence      = freshnessCadence{Cadence: "annual", ExpectedDays: 730, GraceDays: 280}
	correlationFreshnessCadence = freshnessCadence{Cadence: "monthly", ExpectedDays: 30, GraceDays: 10}
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
