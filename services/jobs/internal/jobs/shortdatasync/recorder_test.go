package shortdatasync

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestHostIdentityPrefersExecutionID is the PR #231 guard. CLOUD_RUN_JOB is
// identical every day, so preferring it would make a retry unable to find its
// own in-progress row.
func TestHostIdentityPrefersExecutionID(t *testing.T) {
	t.Setenv("CLOUD_RUN_JOB", "shorts-data-sync")
	t.Setenv("K_SERVICE", "shorts-data-sync")
	t.Setenv("CLOUD_RUN_EXECUTION", "shorts-data-sync-hztgm")
	if got := hostIdentity(); got != "shorts-data-sync-hztgm" {
		t.Fatalf("hostIdentity = %q, want the execution id", got)
	}

	t.Setenv("CLOUD_RUN_EXECUTION", "")
	if got := hostIdentity(); got != "shorts-data-sync" {
		t.Fatalf("hostIdentity fallback = %q", got)
	}
}

func TestFindResumableRunUsesExecutionScopedQuery(t *testing.T) {
	processed, total := 0, 10
	db := &fakeDB{rowScan: func(sql string, args []any, dest []any) error {
		if !strings.Contains(sql, "hostname = $1") {
			t.Fatalf("execution-scoped lookup expected, got %q", sql)
		}
		if strings.Contains(sql, "DATE(started_at)") {
			t.Fatal("resume must never be scoped by calendar date (PR #231)")
		}
		if args[0] != "exec-1" {
			t.Fatalf("args = %+v", args)
		}
		*(dest[0].(*string)) = "run-1"
		*(dest[1].(**int)) = &processed
		*(dest[2].(**int)) = &total
		return nil
	}}
	got, err := (&pgStore{db: db}).findResumableRun(context.Background(), "exec-1")
	if err != nil || got != "run-1" {
		t.Fatalf("findResumableRun = %q, %v", got, err)
	}
}

func TestFindResumableRunSkipsFinishedAndMissing(t *testing.T) {
	done, total := 10, 10
	full := &fakeDB{rowScan: func(_ string, _ []any, dest []any) error {
		*(dest[0].(*string)) = "run-1"
		*(dest[1].(**int)) = &done
		*(dest[2].(**int)) = &total
		return nil
	}}
	if got, _ := (&pgStore{db: full}).findResumableRun(context.Background(), "exec-1"); got != "" {
		t.Fatalf("a completed run must not be adopted, got %q", got)
	}

	none := &fakeDB{rowScan: func(_ string, _ []any, _ []any) error { return errors.New("no rows") }}
	if got, err := (&pgStore{db: none}).findResumableRun(context.Background(), ""); got != "" || err != nil {
		t.Fatalf("no row should mean a fresh run, got %q %v", got, err)
	}
}

func TestFindResumableRunOffCloudRunUsesRollingWindow(t *testing.T) {
	db := &fakeDB{rowScan: func(sql string, args []any, _ []any) error {
		if len(args) != 0 {
			t.Fatalf("no args expected off Cloud Run, got %+v", args)
		}
		if !strings.Contains(sql, "INTERVAL '20 hours'") {
			t.Fatalf("expected the 20h rolling window, got %q", sql)
		}
		return errors.New("no rows")
	}}
	if _, err := (&pgStore{db: db}).findResumableRun(context.Background(), ""); err != nil {
		t.Fatalf("findResumableRun: %v", err)
	}
}

func TestRecorderStartInsertsOrResumes(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("CLOUD_RUN_EXECUTION", "exec-9")

	fresh := &fakeDB{}
	rec := newRecorder(&pgStore{db: fresh}, "")
	if rec.runID == "" {
		t.Fatal("a fresh run must mint a run id")
	}
	if err := rec.Start(context.Background(), 0, 500, false); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !strings.Contains(fresh.calls[0].SQL, "INSERT INTO sync_status") {
		t.Fatalf("expected an insert, got %q", fresh.calls[0].SQL)
	}
	args := fresh.calls[0].Args
	if args[1] != "production" || args[2] != "exec-9" || args[4] != 500 {
		t.Fatalf("row identity/batch size wrong: %+v", args)
	}

	resumed := &fakeDB{}
	rec2 := newRecorder(&pgStore{db: resumed}, "run-7")
	if err := rec2.Start(context.Background(), 0, 500, true); err != nil {
		t.Fatalf("Start(resume): %v", err)
	}
	if !strings.Contains(resumed.calls[0].SQL, "UPDATE sync_status") {
		t.Fatalf("expected an update, got %q", resumed.calls[0].SQL)
	}
	if resumed.calls[0].Args[0] != "run-7" {
		t.Fatalf("resume must keep the existing run id, got %+v", resumed.calls[0].Args)
	}
}

func TestRecorderCompleteStatus(t *testing.T) {
	db := &fakeDB{}
	rec := newRecorder(&pgStore{db: db}, "run-1")
	rec.shortsRecordsUpdated = 742
	if err := rec.Complete(context.Background(), true); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if db.calls[0].Args[1] != statusCompleted || db.calls[0].Args[2] != 742 {
		t.Fatalf("args = %+v", db.calls[0].Args)
	}

	if err := rec.Complete(context.Background(), false); err != nil {
		t.Fatalf("Complete(partial): %v", err)
	}
	if db.calls[1].Args[1] != statusPartial {
		t.Fatalf("partial status not written: %+v", db.calls[1].Args)
	}
}

// TestRecorderFailWritesOnCancelledContext matters because the run context is
// usually ALREADY cancelled (SIGTERM / task timeout) exactly when this row is
// the only record of what happened.
func TestRecorderFailWritesOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	db := &fakeDB{}
	rec := newRecorder(&pgStore{db: db}, "run-1")
	rec.Fail(ctx, "terminated")

	if len(db.calls) != 1 {
		t.Fatalf("%d Exec calls, want 1 (detached write)", len(db.calls))
	}
	if !strings.Contains(db.calls[0].SQL, "status = 'failed'") || db.calls[0].Args[1] != "terminated" {
		t.Fatalf("unexpected fail write: %q %+v", db.calls[0].SQL, db.calls[0].Args)
	}
}
