package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A smoke that BrandBrain deduplicated onto a job another run already holds must leave that job's
// row alone: the run id stays with the other run, and so does its 72-hour expiry. A job this smoke
// created gets the smoke's run id and the 6-hour expiry.
func TestSmokeLedgerLeavesAnotherRunsRowAlone_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()

	other := time.Now().UTC().Add(72 * time.Hour).Truncate(time.Second)
	if _, err := pool.Exec(ctx, `INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, expires_at)
		VALUES ('job-pending-manly', 'delta-20261031T080000Z', 'delta', 'Manly', 'NSW', '2095', 'rea', $1)`, other); err != nil {
		t.Fatal(err)
	}

	jobs := []crawlEnqueueInput{
		{Suburb: "Manly", State: "NSW", Postcode: "2095", Source: "rea"},
		{Suburb: "Manly", State: "NSW", Postcode: "2095", Source: "domain"},
	}
	got := []enqueueTargetItem{
		{JobID: "job-pending-manly", Created: false},
		{JobID: "job-smoke-domain", Created: true},
	}
	run := serverRun{Selection: "smoke", RunID: "smoke-20261031T100000Z-0a1b2c3d", Now: time.Now().UTC(), TTL: smokeDispatchTTL}
	expires := run.Now.Add(run.TTL)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeDispatchRowsTx(ctx, tx, insertDispatchIfAbsentSQL, jobs, got, run, expires); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("smoke ledger write: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	kept, ok := readDispatch(t, pool, "job-pending-manly")
	if !ok {
		t.Fatal("the deduplicated job's row disappeared")
	}
	if kept.RunID != "delta-20261031T080000Z" {
		t.Fatalf("run id = %q; the other run's id was overwritten", kept.RunID)
	}
	if !kept.Expires.Equal(other) {
		t.Fatalf("expiry = %s, want the other run's %s: the smoke shortened a scheduled job", kept.Expires, other)
	}

	mine, ok := readDispatch(t, pool, "job-smoke-domain")
	if !ok {
		t.Fatal("the smoke's own job has no ledger row")
	}
	if mine.RunID != run.RunID || mine.Selection != "smoke" {
		t.Fatalf("run=%q selection=%q, want the smoke run", mine.RunID, mine.Selection)
	}
	if d := mine.Expires.Sub(run.Now); d < 5*time.Hour || d > 7*time.Hour {
		t.Fatalf("smoke expiry is %s from now, want about 6h", d)
	}
}

// A second smoke cannot start while the first holds the smoke lock: the transaction lock is taken
// before the target is chosen and released only at commit, so two smokes never pick one suburb.
func TestSmokeLockSerialisesRuns_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()

	first, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	if _, err := first.Exec(ctx, "SELECT pg_advisory_xact_lock("+smokeAdvisoryLock+")"); err != nil {
		t.Fatalf("first smoke lock: %v", err)
	}
	if got := tryLock(t, pool); got {
		t.Fatal("a second smoke acquired the lock while the first holds it")
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := tryLock(t, pool); !got {
		t.Fatal("the lock was not released at the first smoke's commit")
	}
}

// tryLock reports whether a fresh transaction can take the smoke lock now. It releases the lock again.
func tryLock(t *testing.T, pool *pgxpool.Pool) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ok bool
	if err := tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock("+smokeAdvisoryLock+")").Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}
