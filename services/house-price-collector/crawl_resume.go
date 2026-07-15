package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_resume.go: an opt-in checkpoint/resume cursor for the listings tier.
// Rather than a separate tracking table, it reuses
// property_listings.last_seen_at (already bumped on every TRUSTED sweep — see
// upsertListing in crawl_listings_store.go) as the "last swept" signal per
// (source, region_code): a suburb+source pair swept inside the resume window
// is skipped this run, so a run interrupted partway through — or one kicked
// off again shortly after a full pass — doesn't re-walk suburbs it just
// finished. OFF by default (CRAWL_LISTINGS_RESUME_WINDOW_H<=0, see
// listingsConfig.resumeWindow in crawl_listings.go) — existing behaviour
// (always sweep every selected target) is unchanged unless enabled.
//
// NOTE: this collector keeps its DB-access helpers as flat files in `package
// main` (store.go, crawl_listings_store.go) rather than a `store/`
// subpackage — lastSweptBySuburbSource follows that existing convention.

// shouldSkip reports whether a (source,suburb) sweep last completed at `last`
// is still within the resume window and can be skipped. A zero `last` (never
// swept, or absent from the loaded snapshot) is never skipped — an unknown
// suburb always gets swept. window<=0 disables resume entirely (never
// skips), matching the feature's off-by-default posture.
func shouldSkip(last, now time.Time, window time.Duration) bool {
	if window <= 0 || last.IsZero() {
		return false
	}
	return now.Sub(last) < window
}

// resumeKey is the lookup key for a (source, region_code) pair in a resumeSet.
func resumeKey(source, regionCode string) string {
	return source + "|" + regionCode
}

// resumeSet is an in-memory snapshot of the last-swept timestamp per (source,
// region_code), loaded once at the start of a run. A nil/zero-value resumeSet
// behaves exactly like an empty one (Go map reads on a nil map are safe) —
// lastSweptAt always returns the zero Time, so shouldSkipTarget never skips.
type resumeSet map[string]time.Time

// lastSweptAt returns the last-swept timestamp for (source, regionCode), or
// the zero Time if never swept (or not present in the snapshot).
func (rs resumeSet) lastSweptAt(source, regionCode string) time.Time {
	return rs[resumeKey(source, regionCode)]
}

// shouldSkipTarget reports whether (source, t) should be skipped this run,
// given the loaded resumeSet, the current time, and the configured window.
func (rs resumeSet) shouldSkipTarget(source string, t CrawlTarget, now time.Time, window time.Duration) bool {
	return shouldSkip(rs.lastSweptAt(source, t.regionCode()), now, window)
}

// loadResumeSnapshot is the call-site convenience wrapper runListings/runAgent
// use: skip the DB round-trip entirely when resume is disabled (window<=0),
// returning a nil resumeSet (which behaves exactly like an empty one — see
// resumeSet's doc comment).
func loadResumeSnapshot(ctx context.Context, pool *pgxpool.Pool, window time.Duration) (resumeSet, error) {
	if window <= 0 {
		return nil, nil
	}
	return lastSweptBySuburbSource(ctx, pool)
}

// lastSweptBySuburbSource loads the current last-swept snapshot: the MAX
// last_seen_at per (source, region_code) across property_listings. This is
// the one piece of Task 8 that talks to a real database — exercised live (by
// the operator), not by the fixture-based unit tests, which cover the pure
// logic above (shouldSkip / resumeSet) instead.
func lastSweptBySuburbSource(ctx context.Context, pool *pgxpool.Pool) (resumeSet, error) {
	rows, err := pool.Query(ctx, `
		SELECT source, region_code, MAX(last_seen_at)
		FROM property_listings
		WHERE region_code IS NOT NULL
		GROUP BY source, region_code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := resumeSet{}
	for rows.Next() {
		var source, regionCode string
		var lastSeen time.Time
		if err := rows.Scan(&source, &regionCode, &lastSeen); err != nil {
			return nil, err
		}
		out[resumeKey(source, regionCode)] = lastSeen
	}
	return out, rows.Err()
}
