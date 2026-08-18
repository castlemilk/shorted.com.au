package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_freshness.go implements `-mode freshness` (READ-ONLY): it measures how
// stale the crawled corpus is across the catalog and ALARMS if the board has
// silently gone stale. This is the guard that would have caught the board sitting
// 3 days stale unnoticed — a scheduled freshness run exits non-zero (and optionally
// POSTs a webhook) the moment the oldest covered suburb crosses the alarm horizon.

// freshnessConfig knobs -mode freshness. ttl reuses the delta TTL so both modes
// agree on what "stale" means; alarmAfter is the louder horizon at which the run
// FAILS + alarms. webhook is an optional best-effort alarm sink.
type freshnessConfig struct {
	ttl        time.Duration // CRAWL_DELTA_TTL_HOURS       (default 24h): the "stale" line in the summary
	alarmAfter time.Duration // CRAWL_FRESHNESS_ALARM_HOURS (default 120h): oldest-covered horizon that alarms
	churnDays  int           // CRAWL_DELTA_CHURN_DAYS      (default 7):  passed through to the shared query
	webhook    string        // CRAWL_FRESHNESS_WEBHOOK (optional): POST target for the alarm
}

func loadFreshnessConfig() freshnessConfig {
	return freshnessConfig{
		ttl:        time.Duration(envInt("CRAWL_DELTA_TTL_HOURS", 24)) * time.Hour,
		alarmAfter: time.Duration(envInt("CRAWL_FRESHNESS_ALARM_HOURS", 120)) * time.Hour,
		churnDays:  envInt("CRAWL_DELTA_CHURN_DAYS", 7),
		webhook:    os.Getenv("CRAWL_FRESHNESS_WEBHOOK"),
	}
}

// freshnessReport is the pure classification of catalog freshness at an instant.
type freshnessReport struct {
	Catalog      int           // catalog size
	Covered      int           // catalog suburbs with >= 1 crawled listing
	NeverCrawled int           // catalog suburbs never crawled (a COVERAGE gap, not an alarm)
	FreshestAge  time.Duration // youngest covered suburb's age
	MedianAge    time.Duration // median covered-suburb age
	OldestAge    time.Duration // oldest covered suburb's age
	OldestSuburb CrawlTarget   // the worst (oldest) covered suburb
	StaleOverTTL int           // covered suburbs older than ttl
	Alarm        bool          // Covered>0 && OldestAge > alarmAfter
}

// classifyFreshness reduces per-suburb freshness rows to a report. Pure + DB-free
// for unit testing.
//
// The alarm keys on the OLDEST COVERED suburb — a suburb the crawl actually reached
// but hasn't refreshed within the horizon. Never-crawled suburbs are a COVERAGE gap
// (counted in NeverCrawled) and deliberately do NOT trip the alarm: otherwise a
// catalog that's only partially seeded (e.g. 67/500 suburbs crawled) would alarm
// forever regardless of how fresh the covered data is. Covered==0 (a fresh /
// never-run environment) has no baseline to alarm against, so it never alarms.
func classifyFreshness(rows []suburbFreshness, cfg freshnessConfig, now time.Time) freshnessReport {
	r := freshnessReport{Catalog: len(rows)}
	ages := make([]time.Duration, 0, len(rows))
	var oldest time.Duration
	var oldestSub CrawlTarget
	for _, f := range rows {
		if f.LastCrawled == nil {
			r.NeverCrawled++
			continue
		}
		age := now.Sub(*f.LastCrawled)
		if age < 0 {
			age = 0 // clock skew: a future last_seen_at is treated as "just now"
		}
		if age > cfg.ttl {
			r.StaleOverTTL++
		}
		if len(ages) == 0 || age > oldest {
			oldest = age
			oldestSub = f.Target
		}
		ages = append(ages, age)
	}
	r.Covered = len(ages)
	if r.Covered == 0 {
		return r
	}
	sort.Slice(ages, func(i, j int) bool { return ages[i] < ages[j] })
	r.FreshestAge = ages[0]
	r.OldestAge = ages[len(ages)-1]
	r.MedianAge = ages[len(ages)/2]
	r.OldestSuburb = oldestSub
	r.Alarm = r.OldestAge > cfg.alarmAfter
	return r
}

// runFreshness is the -mode=freshness entry point (READ-ONLY). It logs a structured
// staleness summary and returns a process exit code: 0 = fresh (or no baseline yet),
// 6 = ALARM (the board has silently gone stale). 1 = the freshness query itself
// failed. On alarm it logs prominently and best-effort POSTs CRAWL_FRESHNESS_WEBHOOK.
func runFreshness(ctx context.Context, pool *pgxpool.Pool) int {
	cfg := loadFreshnessConfig()
	rows, err := queryCatalogFreshness(ctx, pool, crawlTargets, cfg.churnDays)
	if err != nil {
		log.Printf("[freshness] query error: %v", err)
		return 1
	}
	rep := classifyFreshness(rows, cfg, time.Now().UTC())

	log.Printf("[freshness] catalog=%d covered=%d never_crawled=%d | freshest=%s median=%s oldest=%s | stale>%s=%d | alarm_horizon=%s",
		rep.Catalog, rep.Covered, rep.NeverCrawled,
		humanAge(rep.FreshestAge), humanAge(rep.MedianAge), humanAge(rep.OldestAge),
		cfg.ttl, rep.StaleOverTTL, cfg.alarmAfter)

	if rep.Covered == 0 {
		log.Printf("[freshness] no crawled listings yet — freshness N/A (fresh env or the crawl has never run); no alarm")
		return 0
	}

	log.Printf("[freshness] oldest covered suburb: %s (last crawled %s ago)",
		rep.OldestSuburb.regionName(), humanAge(rep.OldestAge))

	// Annotate this run-type/host's dashboard health row with the oldest-covered age
	// so the admin jobs dashboard shows corpus staleness alongside the crawl's run
	// counts. Best-effort + detached; targets the row the `-mode agent` rounds wrote
	// for the same launchd run (shared CRAWL_RUN_TYPE + host). No-op if none exists.
	func() {
		fctx, fcancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer fcancel()
		if err := updateCrawlRunFreshness(fctx, pool, crawlRunType(), crawlHost(), rep.OldestAge.Hours()); err != nil {
			log.Printf("[freshness] crawl_run_status freshness annotation failed (best-effort): %v", err)
		}
	}()

	if !rep.Alarm {
		return 0
	}

	msg := fmt.Sprintf("housing crawl freshness ALARM: oldest covered suburb %q last crawled %s ago (> %s threshold). The price-drops board is going stale — check the residential crawl rigs.",
		rep.OldestSuburb.regionName(), humanAge(rep.OldestAge), cfg.alarmAfter)
	log.Printf("[freshness] ***** %s *****", msg)
	postFreshnessAlarm(cfg.webhook, rep, msg)
	return 6
}

// humanAge rounds a staleness duration to a readable precision (minute for hours+,
// second for sub-hour) so the log reads "71h3m0s" not "71h3m17.4s".
func humanAge(d time.Duration) time.Duration {
	if d >= time.Hour {
		return d.Round(time.Minute)
	}
	return d.Round(time.Second)
}

// postFreshnessAlarm POSTs the alarm to CRAWL_FRESHNESS_WEBHOOK. Best-effort by
// design (same posture as pingRevalidate): a webhook failure must NEVER fail the
// run, and it no-ops silently when the webhook is unset. The payload carries a
// Slack/Discord-friendly `text` plus structured fields. Runs on a DETACHED context
// so a run deadline firing can't kill the alert.
func postFreshnessAlarm(webhook string, rep freshnessReport, msg string) {
	if webhook == "" {
		return
	}
	payload := map[string]any{
		"text":             msg,
		"oldest_suburb":    rep.OldestSuburb.regionName(),
		"oldest_age_hours": rep.OldestAge.Hours(),
		"covered":          rep.Covered,
		"never_crawled":    rep.NeverCrawled,
		"stale_over_ttl":   rep.StaleOverTTL,
	}
	// SECRET HYGIENE: the webhook URL may carry a Slack/Discord bearer token in its
	// path/query, and Go's *url.Error.Error() embeds the FULL request URL — so a bare
	// `%v` on a transport/build error would write that token into the local log.
	// Never log the raw error or URL: report only the redacted host, and (for a
	// transport failure) the UNWRAPPED inner error, which carries no URL.
	host := "webhook"
	if u, perr := url.Parse(webhook); perr == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	b, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[freshness] alarm webhook marshal failed: %v", err) // payload only — no URL
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhook, bytes.NewReader(b))
	if err != nil {
		log.Printf("[freshness] alarm webhook build failed (host %s): malformed webhook URL", host)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Unwrap *url.Error → its inner .Err carries the transport cause (e.g. "dial
		// tcp: connection refused") WITHOUT the URL; fall back to a generic note.
		inner := "transport error"
		var ue *url.Error
		if errors.As(err, &ue) && ue.Err != nil {
			inner = ue.Err.Error()
		}
		log.Printf("[freshness] alarm webhook post failed (host %s): %s", host, inner)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[freshness] alarm webhook non-2xx: %d", resp.StatusCode)
		return
	}
	log.Printf("[freshness] alarm webhook delivered (status %d)", resp.StatusCode)
}
