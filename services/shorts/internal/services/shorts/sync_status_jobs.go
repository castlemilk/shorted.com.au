package shorts

import (
	"fmt"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// sync_status_jobs.go folds the DEEPEST health signal we have for the short
// positions sync into its Cloud Run row on the admin jobs dashboard.
//
// Cloud Run only knows "the container exited 0". The sync_status table (migration
// 000006) knows how many records the run actually WROTE — which is how the class of
// failure that exits 0 and does nothing (the uvicorn-zombie, an empty ASIC file, a
// resumed-but-never-finished checkpoint) becomes visible at all.
//
// IDENTIFYING THE WRITER: sync_status has no job column — it is a shared table with
// two writers (the short-positions sync and the market-data sync). The only reliable
// discriminator is which columns a run populates: the short sync writes
// shorts_records_updated (and zeroes prices/metrics), the market-data sync writes
// prices/metrics and leaves shorts at 0. So we take the newest row that touched
// shorts, and never guess from the newest row overall.

// syncStatusJobName is the Cloud Run job the sync_status detail is attached to.
// The July consolidation ports this job to Go but KEEPS the resource name.
const syncStatusJobName = "shorts-data-sync"

// shortsSyncRun picks the most recent sync_status row attributable to the short
// positions sync. Returns nil when no row qualifies (fresh DB, or every recent run
// belongs to market-data).
func shortsSyncRun(runs []*shortsv1alpha1.SyncRun) *shortsv1alpha1.SyncRun {
	// Runs arrive newest-first (ORDER BY started_at DESC). Return the newest row
	// attributable to the short sync:
	//
	//   - prices==0 && metrics==0, ANY status — the Go job's shape. This must
	//     include completed runs with 0 shorts records (a normal no-new-files
	//     day): skipping them made the console show a stale prior run's counts
	//     as current, and made the zero-write escalation below unreachable.
	//   - shorts > 0 — a legacy Python row (it wrote prices/metrics in the same
	//     row); still the short sync's latest state in rollback mode.
	//
	// Known ambiguity, accepted: a market-data row that failed before writing
	// anything is zero-shaped and would attribute here. sync_status has no job
	// column; the shape is all there is.
	for _, r := range runs {
		if r == nil {
			continue
		}
		if (r.PricesRecordsUpdated == 0 && r.MetricsRecordsUpdated == 0) ||
			r.ShortsRecordsUpdated > 0 {
			return r
		}
	}
	return nil
}

// applySyncStatusDetail merges a sync_status run into the shorts-data-sync job row:
// record counts for display, plus a health ESCALATION for the states Cloud Run
// reports as success.
func applySyncStatusDetail(jobs []jobmonitor.JobStatus, run *shortsv1alpha1.SyncRun, now time.Time) []jobmonitor.JobStatus {
	if run == nil {
		return jobs
	}
	for i := range jobs {
		if jobs[i].Name != syncStatusJobName {
			continue
		}
		st := &jobs[i]
		st.Records = []jobmonitor.RecordCount{
			{Label: "shorts", Count: int64(run.ShortsRecordsUpdated)},
			{Label: "algolia", Count: int64(run.AlgoliaRecordsSynced)},
		}

		switch run.Status {
		case "failed":
			// The container may have exited 0 while the sync itself recorded a
			// failure — the DB row is the more truthful of the two.
			st.Health = jobmonitor.HealthCritical
			st.Message = firstNonEmptyStr(run.ErrorMessage, "sync_status recorded a failed run")
		case "running":
			// A row left "running" long after the execution ended is a crashed run
			// that never got to write its terminal status.
			if started := parseSyncTime(run.StartedAt); !started.IsZero() && now.Sub(started) > 8*time.Hour {
				st.Health = jobmonitor.HealthCritical
				st.Message = fmt.Sprintf("sync_status row stuck in 'running' for %dh", int(now.Sub(started).Hours()))
			}
		default:
			// Exited clean but wrote nothing: the silent-no-op failure mode.
			// A single 0-record day is NORMAL (ASIC publishes T+4, weekends and
			// holidays produce no file), so only escalate when the newest
			// attributable run is old enough that publications must have been
			// missed: >78h clears a full weekend plus one slipped day. Precise
			// trading-day staleness is the freshness sentinel's job.
			if st.Health == jobmonitor.HealthOK && run.ShortsRecordsUpdated == 0 {
				if started := parseSyncTime(run.StartedAt); !started.IsZero() && now.Sub(started) > 78*time.Hour {
					st.Health = jobmonitor.HealthWarning
					st.Message = fmt.Sprintf(
						"Newest short-sync run wrote 0 records and is %dh old", int(now.Sub(started).Hours()))
				}
			}
		}

		if run.Environment != "" || run.Hostname != "" {
			st.Note = appendNote(st.Note, fmt.Sprintf("last run on %s/%s",
				orDash(run.Environment), orDash(run.Hostname)))
		}
		break
	}
	return jobs
}

// syncStatusDetail reads the latest sync runs and returns the short-sync one.
// Best-effort: a read failure logs and returns nil rather than failing the whole
// /api/admin/jobs response.
func (s *ShortsServer) syncStatusDetail() *shortsv1alpha1.SyncRun {
	runs, err := s.store.GetSyncStatus(shortsstore.SyncStatusFilter{Limit: 20})
	if err != nil {
		log.Warnf("syncStatusDetail: failed to read sync_status (short-sync detail omitted): %v", err)
		return nil
	}
	return shortsSyncRun(runs)
}

func parseSyncTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, _ := parseStoreTimestamp(s)
	return t
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func appendNote(existing, add string) string {
	if existing == "" {
		return add
	}
	return existing + " · " + add
}

func orDash(s string) string {
	if s == "" {
		return "–"
	}
	return s
}
