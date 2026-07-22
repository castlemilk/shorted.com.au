package main

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_delta.go implements the DEMAND-RIGHT-SIZING delta selection for
// `-mode enqueue` (CRAWL_ENQUEUE_SELECTION=delta). Instead of enqueuing the whole
// catalog every run, it re-crawls ONLY the suburbs that need it — never crawled,
// gone stale past a TTL, or churning (recent price events) — capped per run. This
// keeps the residential-Mac crawl within a "right-size demand, no proxy spend"
// budget while still surfacing fresh drops where activity actually is.

// suburbFreshness pairs a catalog CrawlTarget with its current freshness + churn
// signals, read read-only from prod. It is the unit selectDeltaSuburbs ranks. A
// suburb the crawl has NEVER reached (or whose portal suburb name didn't match the
// catalog Display) has LastCrawled==nil — the safe default, because "never crawled"
// ⇒ always selected: the delta over-crawls a name/casing mismatch slightly rather
// than silently skipping it forever.
type suburbFreshness struct {
	Target      CrawlTarget
	LastCrawled *time.Time // nil = never crawled (no matching property_listings row)
	Active      int        // currently-active listings for this suburb
	Churn7d     int        // property_price_events in the churn window (default 7d)
}

// deltaConfig knobs the delta selection. All are env-overridable with the defaults
// noted; loadDeltaConfig reads them.
type deltaConfig struct {
	ttl        time.Duration // CRAWL_DELTA_TTL_HOURS  (default 24h): re-crawl if last crawl older than this
	churnMin   int           // CRAWL_DELTA_CHURN_MIN  (default 1):  re-crawl if recent events >= this
	churnDays  int           // CRAWL_DELTA_CHURN_DAYS (default 7):  the "recent events" window (days)
	maxSuburbs int           // CRAWL_DELTA_MAX_SUBURBS(default 60):  per-run selection cap
}

func loadDeltaConfig() deltaConfig {
	return deltaConfig{
		ttl:        time.Duration(envInt("CRAWL_DELTA_TTL_HOURS", 24)) * time.Hour,
		churnMin:   envInt("CRAWL_DELTA_CHURN_MIN", 1),
		churnDays:  envInt("CRAWL_DELTA_CHURN_DAYS", 7),
		maxSuburbs: envInt("CRAWL_DELTA_MAX_SUBURBS", 60),
	}
}

// deltaSelection is the ranked result of a delta run: the chosen targets plus a
// primary-reason breakdown (Never+Stale+Churny == len(Targets)) and the count of
// candidates capped off. Dropped is logged, never silently discarded.
type deltaSelection struct {
	Targets []CrawlTarget
	Never   int // selected because never crawled
	Stale   int // selected because last crawl older than the TTL (and not never-crawled)
	Churny  int // selected because recent churn >= churnMin (and fresh — TTL didn't already select it)
	Dropped int // candidates that matched a rule but were capped off (NOT crawled this run)
}

// selectDeltaSuburbs ranks the catalog for a delta run. Pure + DB-free so it unit
// tests without a database (fed by queryCatalogFreshness in production).
//
// A suburb is a CANDIDATE if any hold: never crawled, OR last crawl older than
// cfg.ttl, OR recent churn >= cfg.churnMin. Candidates are ranked
// never-crawled-first, then highest churn, then oldest last-crawled, and the top
// cfg.maxSuburbs are taken (the tail is reported as Dropped). Each selected suburb
// is attributed a single PRIMARY reason (never > stale > churny) so the counts sum
// to the selection size for an honest log.
//
// Returns a deltaSelection (rather than a bare []CrawlTarget) so the caller can log
// the WHY + the capped-off count without re-deriving it — the no-silent-truncation
// requirement. The pure ranking is still fully unit-testable via the struct.
func selectDeltaSuburbs(rows []suburbFreshness, cfg deltaConfig, now time.Time) deltaSelection {
	type scored struct {
		f      suburbFreshness
		never  bool
		stale  bool
		churny bool
	}
	cands := make([]scored, 0, len(rows))
	for _, f := range rows {
		never := f.LastCrawled == nil
		stale := !never && now.Sub(*f.LastCrawled) >= cfg.ttl
		churny := cfg.churnMin > 0 && f.Churn7d >= cfg.churnMin
		if never || stale || churny {
			cands = append(cands, scored{f: f, never: never, stale: stale, churny: churny})
		}
	}

	// Rank: never-crawled first, then highest churn, then oldest last-crawled.
	// SliceStable so two equal candidates keep catalog order (deterministic runs).
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.never != b.never {
			return a.never // a never-crawled ⇒ a sorts first
		}
		if a.f.Churn7d != b.f.Churn7d {
			return a.f.Churn7d > b.f.Churn7d // churnier first
		}
		// Oldest last-crawled first. Both are non-nil here unless both are
		// never-crawled (handled above / equal), in which case fall through to
		// the stable catalog order.
		if a.f.LastCrawled != nil && b.f.LastCrawled != nil && !a.f.LastCrawled.Equal(*b.f.LastCrawled) {
			return a.f.LastCrawled.Before(*b.f.LastCrawled)
		}
		return false
	})

	var sel deltaSelection
	if cfg.maxSuburbs > 0 && len(cands) > cfg.maxSuburbs {
		sel.Dropped = len(cands) - cfg.maxSuburbs
		cands = cands[:cfg.maxSuburbs]
	}
	sel.Targets = make([]CrawlTarget, 0, len(cands))
	for _, c := range cands {
		sel.Targets = append(sel.Targets, c.f.Target)
		switch {
		case c.never:
			sel.Never++
		case c.stale:
			sel.Stale++
		default:
			sel.Churny++
		}
	}
	return sel
}

// freshnessKey is the case/space-insensitive join key between a catalog CrawlTarget
// (Display/State/Postcode) and a property_listings row (suburb/state_code/postcode).
// Both sides are lower/upper/trim-normalised so "St Kilda" vs "ST KILDA" and a
// padded/space-padded postcode still match. The DB side lowers/uppers/trims in SQL
// and this re-normalises the catalog side identically (all ASCII, so Go and
// Postgres case-folding agree).
func freshnessKey(suburb, state, postcode string) string {
	return strings.ToLower(strings.TrimSpace(suburb)) + "|" +
		strings.ToUpper(strings.TrimSpace(state)) + "|" +
		strings.TrimSpace(postcode)
}

// queryCatalogFreshness reads (READ-ONLY) the current per-suburb freshness + churn
// from prod and aligns it to the catalog. Two cheap aggregate SELECTs — one over
// property_listings (max last_seen_at + active count, grouped by the normalised
// suburb key), one over property_price_events joined back to listings for the same
// key (recent event count) — merged onto the catalog in Go. A catalog suburb with
// no matching rows keeps LastCrawled==nil (never crawled). Writes NOTHING.
func queryCatalogFreshness(ctx context.Context, pool *pgxpool.Pool, targets []CrawlTarget, churnDays int) ([]suburbFreshness, error) {
	type agg struct {
		last   *time.Time
		active int
	}
	byKey := map[string]agg{}

	frows, err := pool.Query(ctx, `
		SELECT lower(suburb) AS s, upper(state_code) AS st, trim(postcode) AS pc,
		       max(last_seen_at) AS last_crawled,
		       count(*) FILTER (WHERE is_active) AS active
		FROM property_listings
		WHERE suburb IS NOT NULL AND state_code IS NOT NULL AND postcode IS NOT NULL
		GROUP BY 1, 2, 3`)
	if err != nil {
		return nil, err
	}
	for frows.Next() {
		var s, st, pc string
		var last *time.Time
		var active int
		if err := frows.Scan(&s, &st, &pc, &last, &active); err != nil {
			frows.Close()
			return nil, err
		}
		byKey[freshnessKey(s, st, pc)] = agg{last: last, active: active}
	}
	frows.Close()
	if err := frows.Err(); err != nil {
		return nil, err
	}

	churnByKey := map[string]int{}
	if churnDays > 0 {
		crows, err := pool.Query(ctx, `
			SELECT lower(pl.suburb) AS s, upper(pl.state_code) AS st, trim(pl.postcode) AS pc,
			       count(*) AS churn
			FROM property_price_events e
			JOIN property_listings pl ON pl.id = e.listing_pk
			WHERE e.observed_at >= now() - ($1 * interval '1 day')
			  AND pl.suburb IS NOT NULL AND pl.state_code IS NOT NULL AND pl.postcode IS NOT NULL
			GROUP BY 1, 2, 3`, churnDays)
		if err != nil {
			return nil, err
		}
		for crows.Next() {
			var s, st, pc string
			var churn int
			if err := crows.Scan(&s, &st, &pc, &churn); err != nil {
				crows.Close()
				return nil, err
			}
			churnByKey[freshnessKey(s, st, pc)] = churn
		}
		crows.Close()
		if err := crows.Err(); err != nil {
			return nil, err
		}
	}

	out := make([]suburbFreshness, 0, len(targets))
	for _, t := range targets {
		k := freshnessKey(t.Display, t.State, t.Postcode)
		f := suburbFreshness{Target: t}
		if a, ok := byKey[k]; ok {
			f.LastCrawled = a.last
			f.Active = a.active
		}
		f.Churn7d = churnByKey[k]
		out = append(out, f)
	}
	return out, nil
}
