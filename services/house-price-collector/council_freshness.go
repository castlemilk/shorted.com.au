package main

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Council sources the scheduled official run ingests (-mode official/all),
// and how stale each may get before the run fails loudly. Freshness is the
// newest PERIOD in lga_series, never fetched_at: a run that succeeds while
// ABS stops publishing must still alarm.
//
//   - abs_ba_lga: monthly, published ~5 weeks after the reference month, and
//     the job runs monthly — 120 days allows one missed release.
//   - abs_erp_lga: annual ERP at 30 June, published the following March-April
//     as a NEW flow (ERP_LGA<Y>), which erp-lga discovers each run
//     (latestERPFlow). Up to ~21 months old just before a release — 700 days
//     allows that, so this alarms when ABS skips a year or discovery breaks.
//
// census-lga (a 2021 snapshot), council-regional (annual, irregular) and
// wikidata-lga (a committed snapshot) are operator-run and carry no policy.
var councilFreshnessPolicies = []vgFreshnessPolicy{
	{source: baLGASource, maxAgeDays: 120, table: "lga_series"},
	{source: erpSource, maxAgeDays: 700, table: "lga_series"},
}

const councilFreshnessQuery = `
	SELECT source, MAX(period) AS max_period
	FROM lga_series
	WHERE source IN ('abs_ba_lga', 'abs_erp_lga')
	GROUP BY source
	ORDER BY source`

// scheduledCouncilJob is one council mode the scheduled official run drives.
type scheduledCouncilJob struct {
	name string
	run  func(context.Context, *pgxpool.Pool) error
}

// scheduledCouncilJobs are the council sources safe and cheap enough for the
// monthly Cloud Run job: key-filtered ABS pulls of a few MB, keyed by code,
// needing only the lga dimension already in the database.
func scheduledCouncilJobs() []scheduledCouncilJob {
	return []scheduledCouncilJob{
		{baLGASource, runBuildingApprovalsLGA},
		{erpSource, runERPLGA},
	}
}

// runScheduledCouncil runs each council job; a failure is counted (and was
// already recorded on its cursor by the mode itself), never fatal on its own.
func runScheduledCouncil(ctx context.Context, pool *pgxpool.Pool, jobs []scheduledCouncilJob) (total, failures int) {
	for _, job := range jobs {
		total++
		if err := job.run(ctx, pool); err != nil {
			log.Printf("[%s] scheduled council job failed: %v", job.name, err)
			failures++
		}
	}
	return total, failures
}

func loadCouncilFreshness(ctx context.Context, pool *pgxpool.Pool) (map[string]*time.Time, error) {
	rows, err := pool.Query(ctx, councilFreshnessQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*time.Time{}
	for rows.Next() {
		var source string
		var maxPeriod time.Time
		if err := rows.Scan(&source, &maxPeriod); err != nil {
			return nil, err
		}
		p := maxPeriod
		out[source] = &p
	}
	return out, rows.Err()
}

// assertCouncilFreshness checks every scheduled council source after the run.
func assertCouncilFreshness(ctx context.Context, pool *pgxpool.Pool) int {
	return assertVGFreshness(
		ctx,
		time.Now(),
		councilFreshnessPolicies,
		func(ctx context.Context) (map[string]*time.Time, error) {
			return loadCouncilFreshness(ctx, pool)
		},
		func(ctx context.Context, source string, lastPeriod *time.Time, status, detail string) error {
			return updateRun(ctx, pool, source, lastPeriod, 0, status, detail)
		},
	)
}
