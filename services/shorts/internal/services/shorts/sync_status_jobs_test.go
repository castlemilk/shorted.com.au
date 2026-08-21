package shorts

import (
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

func TestShortsSyncRunPicksTheShortSyncWriter(t *testing.T) {
	// sync_status is shared by two writers with no job column; only the column
	// shape distinguishes them.
	marketDataRun := &shortsv1alpha1.SyncRun{
		Status: "completed", PricesRecordsUpdated: 3400, MetricsRecordsUpdated: 900,
	}
	shortRun := &shortsv1alpha1.SyncRun{Status: "completed", ShortsRecordsUpdated: 2100}

	got := shortsSyncRun([]*shortsv1alpha1.SyncRun{marketDataRun, shortRun})
	if got != shortRun {
		t.Fatalf("picked the wrong writer's row")
	}

	// An in-flight short run (no records yet) is fresher truth than a completed one.
	inFlight := &shortsv1alpha1.SyncRun{Status: "running"}
	if got := shortsSyncRun([]*shortsv1alpha1.SyncRun{inFlight, shortRun}); got != inFlight {
		t.Errorf("expected the in-flight short run to win")
	}

	// The NEWEST attributable row wins even when it wrote 0 records (a normal
	// quiet day) — showing an older run's counts as current hides the truth.
	quietDay := &shortsv1alpha1.SyncRun{Status: "completed", ShortsRecordsUpdated: 0}
	if got := shortsSyncRun([]*shortsv1alpha1.SyncRun{quietDay, shortRun}); got != quietDay {
		t.Errorf("expected the newest completed-0 short-sync row to win")
	}

	// Nothing attributable -> nil, never a market-data row mislabelled as the short sync.
	if got := shortsSyncRun([]*shortsv1alpha1.SyncRun{marketDataRun}); got != nil {
		t.Errorf("got %v, want nil when no row is attributable to the short sync", got)
	}
	if got := shortsSyncRun(nil); got != nil {
		t.Errorf("got %v, want nil for no rows", got)
	}
}

func TestApplySyncStatusDetail(t *testing.T) {
	now := time.Now().UTC()
	base := func() []jobmonitor.JobStatus {
		return []jobmonitor.JobStatus{
			{Name: "shorted-news", Health: jobmonitor.HealthOK},
			{Name: syncStatusJobName, Health: jobmonitor.HealthOK},
		}
	}

	// Healthy run: records surface, health untouched.
	out := applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "completed", ShortsRecordsUpdated: 2100, AlgoliaRecordsSynced: 4400,
	}, now)
	if len(out[1].Records) != 2 || out[1].Records[0].Count != 2100 {
		t.Errorf("records = %+v, want the shorts count", out[1].Records)
	}
	if out[1].Health != jobmonitor.HealthOK {
		t.Errorf("health = %v, want ok", out[1].Health)
	}

	// A single completed-0 run is a NORMAL no-new-files day (T+4, weekends) and
	// must not alarm.
	out = applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "completed", ShortsRecordsUpdated: 0,
		StartedAt: now.Add(-14 * time.Hour).Format(time.RFC3339),
	}, now)
	if out[1].Health != jobmonitor.HealthOK {
		t.Errorf("fresh zero-record run health = %v, want ok", out[1].Health)
	}

	// But a zero-write run that is DAYS old means publications were missed —
	// the silent-no-op failure Cloud Run reports as success.
	out = applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "completed", ShortsRecordsUpdated: 0,
		StartedAt: now.Add(-80 * time.Hour).Format(time.RFC3339),
	}, now)
	if out[1].Health != jobmonitor.HealthWarning {
		t.Errorf("stale zero-record run health = %v, want warning", out[1].Health)
	}

	// sync_status says failed even though the container exited 0.
	out = applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "failed", ErrorMessage: "ASIC download 404",
	}, now)
	if out[1].Health != jobmonitor.HealthCritical || out[1].Message != "ASIC download 404" {
		t.Errorf("failed run = %v / %q, want critical + the error", out[1].Health, out[1].Message)
	}

	// A row abandoned in 'running' is a crashed run that never wrote its status.
	out = applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "running", StartedAt: now.Add(-20 * time.Hour).Format(time.RFC3339),
	}, now)
	if out[1].Health != jobmonitor.HealthCritical {
		t.Errorf("stuck running health = %v, want critical", out[1].Health)
	}

	// A recent running row is normal.
	out = applySyncStatusDetail(base(), &shortsv1alpha1.SyncRun{
		Status: "running", StartedAt: now.Add(-10 * time.Minute).Format(time.RFC3339),
	}, now)
	if out[1].Health != jobmonitor.HealthOK {
		t.Errorf("fresh running health = %v, want untouched ok", out[1].Health)
	}

	// No row at all: every other job row is left alone.
	out = applySyncStatusDetail(base(), nil, now)
	if out[0].Health != jobmonitor.HealthOK || out[1].Records != nil {
		t.Errorf("nil run should be a no-op")
	}
}
