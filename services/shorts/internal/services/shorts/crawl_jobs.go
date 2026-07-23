package shorts

import (
	"fmt"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// crawl_jobs.go merges the Mac-based residential-crawl HEALTH RECORDS (migration
// 000089, table crawl_run_status) into the admin jobs dashboard.
//
// The dashboard's /api/admin/jobs endpoint is populated by jobmonitor.Collect(),
// which reads GCP Cloud Run Job executions + Cloud Scheduler triggers directly — it
// is structurally blind to anything that does not run on GCP. The residential crawl
// runs on a Mac (Kasada needs a residential IP + warm host-Chrome, so it CANNOT run
// on Cloud Run), so it self-reports a DB row per scheduled run and we translate those
// rows into the SAME jobmonitor.JobStatus shape the Cloud Run jobs use — so the crawl
// appears as a first-class scheduled job with the same health/last-run/schedule chrome.
//
// DEAD-RIG DETECTION: a live rig re-writes finished_at every round; a rig that stops
// (crashed launchd, machine off, Chrome permanently wedged) stops writing, so its
// finished_at goes stale. crawlRunHealth escalates a stale-but-last-"ok" row to
// warning, then critical once it crosses the dead-rig horizon — no heartbeat job
// needed, the absence of writes IS the signal.

const crawlCategory = "Housing crawl"

// crawlStaleAfter is the maximum gap between finishes before a run-type's row is
// considered STALE (→ warning). A DEAD rig crosses 2× this (→ critical). The delta
// crawl runs daily and the full crawl fortnightly (see the launchd templates), with
// generous margins for a skipped run / a long full pass.
func crawlStaleAfter(runType string) time.Duration {
	switch runType {
	case "delta":
		return 30 * time.Hour // daily cadence + a skipped-run margin
	case "full":
		return 16 * 24 * time.Hour // fortnightly cadence + a long-pass margin
	default: // "agent" (bundled/ad-hoc) and anything else
		return 48 * time.Hour
	}
}

// crawlRunHealth classifies a crawl health record for the dashboard. Rules:
//   - error / blocked        → critical (a wasted or failed run)
//   - rewarm / partial       → warning  (degraded but productive), critical if ALSO
//     past the dead-rig horizon (the rig degraded AND then went silent)
//   - ok + fresh             → ok
//   - ok + stale             → warning  (a run is overdue — likely a stopped rig)
//   - ok + dead (2× stale)   → critical (the rig has definitively stopped writing)
//   - anything else / ""     → unknown  (e.g. a freshness-only marker with no status)
func crawlRunHealth(status, runType string, finishedAt *time.Time, now time.Time) jobmonitor.Health {
	stale := crawlAge(finishedAt, now) > crawlStaleAfter(runType)
	dead := crawlAge(finishedAt, now) > 2*crawlStaleAfter(runType)
	switch status {
	case "error", "blocked":
		return jobmonitor.HealthCritical
	case "rewarm", "partial":
		if dead {
			return jobmonitor.HealthCritical
		}
		return jobmonitor.HealthWarning
	case "ok":
		if dead {
			return jobmonitor.HealthCritical
		}
		if stale {
			return jobmonitor.HealthWarning
		}
		return jobmonitor.HealthOK
	default:
		return jobmonitor.HealthUnknown
	}
}

// crawlAge is the time since a (nullable) finish. A nil finish (never finished, or a
// bare freshness marker) has no measurable age, so it returns 0 — we never escalate
// to critical on MISSING data, only on data that is provably old.
func crawlAge(finishedAt *time.Time, now time.Time) time.Duration {
	if finishedAt == nil {
		return 0
	}
	d := now.Sub(*finishedAt)
	if d < 0 {
		return 0 // clock skew: a future finish is treated as "just now"
	}
	return d
}

// crawlDisplayName is the dashboard label for a run-type.
func crawlDisplayName(runType string) string {
	switch runType {
	case "delta":
		return "Housing Crawl — Delta"
	case "full":
		return "Housing Crawl — Full"
	case "agent":
		return "Housing Crawl — Agent"
	default:
		return "Housing Crawl — " + runType
	}
}

// crawlScheduleHuman is the static cadence label shown in the Schedule column. The
// crawl is scheduled by launchd on the rig (not Cloud Scheduler), so there is no cron
// to humanize — these are the templates' cadences.
func crawlScheduleHuman(runType string) string {
	switch runType {
	case "delta":
		return "Daily ~03:00 (launchd)"
	case "full":
		return "Fortnightly (launchd)"
	case "agent":
		return "On demand (launchd)"
	default:
		return "launchd"
	}
}

// crawlLastRunStatus maps the crawl status enum to the GCP run-status vocabulary the
// dashboard already renders (succeeded | failed | unknown).
func crawlLastRunStatus(status string) string {
	switch status {
	case "ok", "partial", "rewarm":
		return "succeeded" // the run executed; degraded states surface via Health/Message
	case "error", "blocked":
		return "failed"
	default:
		return "unknown"
	}
}

// crawlRunToJobStatus maps ONE crawl health record to a dashboard JobStatus. Pure so
// the mapping + health derivation are unit-testable without a DB.
func crawlRunToJobStatus(rec *shortsstore.CrawlRunStatus, now time.Time) jobmonitor.JobStatus {
	finished := rfc3339OrEmpty(rec.FinishedAt)
	health := crawlRunHealth(rec.Status, rec.RunType, rec.FinishedAt, now)

	lastSuccess := ""
	if rec.Status == "ok" || rec.Status == "partial" {
		lastSuccess = finished
	}

	dur := 0.0
	if rec.StartedAt != nil && rec.FinishedAt != nil {
		if d := rec.FinishedAt.Sub(*rec.StartedAt); d > 0 {
			dur = d.Seconds()
		}
	}

	return jobmonitor.JobStatus{
		// Name must be unique across the whole dashboard (React keys) — include the
		// host so multiple rigs running the same run-type don't collide.
		Name:            "housing-crawl-" + rec.RunType + "-" + rec.Host,
		DisplayName:     crawlDisplayName(rec.RunType),
		Category:        crawlCategory,
		Type:            "rig",
		ScheduleHuman:   crawlScheduleHuman(rec.RunType),
		LastRunAt:       finished,
		LastRunStatus:   crawlLastRunStatus(rec.Status),
		LastSuccessAt:   lastSuccess,
		DurationSeconds: dur,
		Message:         crawlMessage(rec),
		Health:          health,
	}
}

// crawlMessage builds the human message: the run's detail line, the rig host, and the
// corpus-freshness annotation from `-mode freshness` when present.
func crawlMessage(rec *shortsstore.CrawlRunStatus) string {
	msg := rec.Detail
	if rec.FreshnessOldestHours != nil {
		if msg != "" {
			msg += " · "
		}
		msg += fmt.Sprintf("freshness %.0fh", *rec.FreshnessOldestHours)
	}
	if rec.Host != "" {
		if msg != "" {
			msg += " · "
		}
		msg += "rig " + rec.Host
	}
	return msg
}

// crawlRunStatusesToJobs maps a slice of health records to JobStatus rows. Pure +
// nil-safe so it is directly unit-testable.
func crawlRunStatusesToJobs(recs []*shortsstore.CrawlRunStatus, now time.Time) []jobmonitor.JobStatus {
	out := make([]jobmonitor.JobStatus, 0, len(recs))
	for _, r := range recs {
		if r == nil {
			continue
		}
		out = append(out, crawlRunToJobStatus(r, now))
	}
	return out
}

// crawlJobStatuses reads the crawl health records via the store and maps them to
// dashboard JobStatus rows. Best-effort: a query error logs + returns nothing rather
// than failing the whole /api/admin/jobs response (the GCP jobs still render). The
// store degrades gracefully when the 000089 table is absent (returns an empty slice).
func (s *ShortsServer) crawlJobStatuses() []jobmonitor.JobStatus {
	recs, err := s.store.GetCrawlRunStatuses()
	if err != nil {
		log.Warnf("crawlJobStatuses: failed to read crawl_run_status (residential-crawl jobs omitted): %v", err)
		return nil
	}
	return crawlRunStatusesToJobs(recs, time.Now().UTC())
}

func rfc3339OrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
