package ingest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// Database-backed policy tests: the off-target gate, the empty-COMPLETE rule over the
// gated set, dispatch expiry and closing, the region ensure, the cross-subject replay,
// the quarantine floor and bypass, and the concurrency properties of the transaction.

// seedDispatchRow records a job with an explicit target, for the tests that need a
// suburb other than the seeded one, or a non-canonical state.
func seedDispatchRow(t *testing.T, pool *pgxpool.Pool, job, suburb, state, postcode, source string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source)
		VALUES ($1, 'run-1', 'delta', $2, $3, $4, $5)`, job, suburb, state, postcode, source); err != nil {
		t.Fatalf("seed dispatch %s: %v", job, err)
	}
}

// seedActiveRea inserts an active REA listing in the seeded region, with missed absences.
func seedActiveRea(t *testing.T, pool *pgxpool.Pool, id string, price float64, missed int) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO property_listings
		  (source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode,
		   display_address, price, price_kind, listing_status, is_active, missed_sweeps, content_hash)
		VALUES ('rea', $1, $2, $3, 'SUBURB:VIC-3000-TESTVILLE', 'Testville', 'VIC', '3000', $4,
		        $5, 'fixed', 'for_sale', true, $6, 'seed')`,
		id, "seed-"+id, "https://example.test/"+id, "1 "+id+" Street", price, missed); err != nil {
		t.Fatalf("seed listing %s: %v", id, err)
	}
}

// activeCount is the number of active listings in the seeded region.
func activeCount(t *testing.T, r *ingestRig) int {
	t.Helper()
	return count(t, r, `SELECT count(*) FROM property_listings WHERE is_active AND region_code = 'SUBURB:VIC-3000-TESTVILLE'`)
}

// offTarget is a REA listing that is a hard miss: its postcode is not the target's.
func offTarget(id string) *pb.Listing {
	return fixedReaAt(id, 1_000_000, "Bondi", "2026")
}

// TestPush_AllOffTargetCompleteNeverDelists: a COMPLETE sweep whose every listing is
// off target is poison. It is applied as BLOCKED, so nothing is delisted however many
// misses the region has.
func TestPush_AllOffTargetCompleteNeverDelists(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	seedDispatch(t, pool, "job-2", "run-1", "rea")
	seedActiveRea(t, pool, "X", 1_000_000, 1) // one miss from delisting
	seedActiveRea(t, pool, "Y", 1_000_000, 1)

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, offTarget("O1"), offTarget("O2"))
	resp := mustPush(t, rig, req)
	if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED || !resp.Poisoned {
		t.Fatalf("an all-off-target COMPLETE must be applied as poisoned BLOCKED, got %+v", resp)
	}
	if n := activeCount(t, rig); n != 2 {
		t.Errorf("a poisoned sweep must delist nothing, %d of 2 active", n)
	}

	// A second such sweep, later, is the owner's case: two of them used to delist all.
	clock.Advance(13 * time.Hour)
	mustPush(t, rig, sweepReq("job-2", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, offTarget("O3"), offTarget("O4")))
	if n := activeCount(t, rig); n != 2 {
		t.Errorf("a second poisoned sweep 13h later must still delist nothing, %d of 2 active", n)
	}
}

// TestPush_PoisonBoundaryIsStrict: the threshold is more than 30% hard off-target. Three
// of ten (30%) is not poison; four of ten is, and is applied as BLOCKED.
func TestPush_PoisonBoundaryIsStrict(t *testing.T) {
	build := func(hard int) []*pb.Listing {
		var out []*pb.Listing
		for i := 0; i < 10; i++ {
			if i < hard {
				out = append(out, offTarget(fmt.Sprintf("H%d", i)))
			} else {
				out = append(out, fixedRea(fmt.Sprintf("T%d", i), 1_000_000))
			}
		}
		return out
	}
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-30", "run-1", "rea")
	seedDispatch(t, pool, "job-40", "run-1", "rea")

	at := mustPush(t, rig, sweepReq("job-30", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, build(3)...))
	if at.Poisoned || at.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_COMPLETE {
		t.Errorf("exactly 30%% off target must not poison, got %+v", at)
	}
	over := mustPush(t, rig, sweepReq("job-40", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, build(4)...))
	if !over.Poisoned || over.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED {
		t.Errorf("over 30%% off target must be poisoned BLOCKED, got %+v", over)
	}
}

// TestPush_SoftMissOnlyEmptyCompleteDoesNotDelist: a COMPLETE sweep whose listings are
// all same-postcode, other-suburb neighbours has no listings left after the gate, so it
// is not an empty sweep. The rule counts the gated set, and it never delists. The
// neighbours are soft misses, not poison, but they leave no gated listing, so the sweep
// is BLOCKED: it writes nothing and never closes the job.
func TestPush_SoftMissOnlyEmptyCompleteDoesNotDelist(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	seedActiveRea(t, pool, "X", 1_000_000, 1)
	seedActiveRea(t, pool, "Y", 1_000_000, 1)

	neighbour := func(id string) *pb.Listing { return fixedReaAt(id, 1_000_000, "Otherville", "3000") }
	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, neighbour("N1"), neighbour("N2"))
	req.PageMeta.TotalResults = 5
	resp := mustPush(t, rig, req)
	if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED || resp.Poisoned {
		t.Errorf("a COMPLETE of only soft misses must be BLOCKED (not poison), got %+v", resp)
	}
	if n := activeCount(t, rig); n != 2 {
		t.Errorf("a gated-empty sweep must delist nothing, %d of 2 active", n)
	}
}

// TestPush_ExpiredDispatchIsRefused: a job past its expires_at is refused with
// dispatch_expired, and writes nothing.
func TestPush_ExpiredDispatchIsRefused(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	if _, err := pool.Exec(context.Background(), `UPDATE crawl_dispatch SET expires_at = now() - interval '1 hour' WHERE job_id = 'job-1'`); err != nil {
		t.Fatal(err)
	}

	_, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	wantCode(t, err, connect.CodeFailedPrecondition)
	if !strings.Contains(err.Error(), "dispatch_expired") {
		t.Errorf("want dispatch_expired, got %v", err)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("an expired job must write nothing, found %d", n)
	}
}

// TestPush_AppliedCompleteClosesTheJob: the first applied COMPLETE closes the job, so
// a second attempt under a new key is refused. PARTIAL closes it too.
func TestPush_AppliedCompleteClosesTheJob(t *testing.T) {
	for name, status := range map[string]pb.SweepStatus{
		"COMPLETE": pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		"PARTIAL":  pb.SweepStatus_SWEEP_STATUS_PARTIAL,
	} {
		t.Run(name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			rig := startIngest(t, pool, issuer, clock, nil)
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")

			mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, status, fixedRea("A", 1_000_000)))
			_, err := rig.push(t, sweepReq("job-1", 2, pb.Source_SOURCE_REA, status, fixedRea("B", 1_000_000)))
			wantCode(t, err, connect.CodeFailedPrecondition)
			if !strings.Contains(err.Error(), "dispatch_applied") {
				t.Errorf("a second attempt after an applied %s must be dispatch_applied, got %v", name, err)
			}
			if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE listing_id = 'B'`); n != 0 {
				t.Errorf("the refused attempt must write nothing, found %d", n)
			}
		})
	}
}

// TestPush_BlockedDoesNotCloseTheJob: a BLOCKED sweep may be retried, so it leaves the
// job open for the next attempt.
func TestPush_BlockedDoesNotCloseTheJob(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	blocked := mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_BLOCKED))
	if blocked.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED {
		t.Fatalf("setup: want BLOCKED, got %+v", blocked)
	}
	retry := mustPush(t, rig, sweepReq("job-1", 2, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	if retry.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_COMPLETE || retry.ListingsUpserted != 1 {
		t.Errorf("a retry after BLOCKED must apply, got %+v", retry)
	}
}

// TestPush_ReplayOfAClosedJobStillReplays: the receipt is read before the dispatch
// state, so the original push replays even after the job closed.
func TestPush_ReplayOfAClosedJobStillReplays(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	mustPush(t, rig, req)
	again := mustPush(t, rig, req) // the job is closed now
	if !again.Replayed {
		t.Fatalf("the original push must replay after the job closed, got %+v", again)
	}
}

// TestPush_NeverCrawledSuburbGetsItsRegion: a suburb with no house_price_regions row
// is created by the sweep, so its listings are written and none is skipped as a failed
// foreign key.
func TestPush_NeverCrawledSuburbGetsItsRegion(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatchRow(t, pool, "job-1", "Newville", "VIC", "3111", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedReaAt("A", 1_000_000, "Newville", "3111"), fixedReaAt("B", 1_100_000, "Newville", "3111"))
	req.Target = &pb.Target{Suburb: "Newville", State: "VIC", Postcode: "3111"}
	resp := mustPush(t, rig, req)
	if resp.SkippedRows != 0 || resp.ListingsUpserted != 2 {
		t.Fatalf("a never-crawled suburb must write both listings with none skipped, got %+v", resp)
	}
	if n := count(t, rig, `SELECT count(*) FROM house_price_regions WHERE region_code = 'SUBURB:VIC-3111-NEWVILLE' AND state_code = 'VIC'`); n != 1 {
		t.Errorf("the region row must be created, found %d", n)
	}
}

// TestPush_StateIsUpperCaseInTheRegionCode: a dispatch row stored in lower case writes
// the same region the collector writes, which is upper case.
func TestPush_StateIsUpperCaseInTheRegionCode(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatchRow(t, pool, "job-1", "Testville", "vic", "3000", "rea")

	mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE listing_id = 'A' AND region_code = 'SUBURB:VIC-3000-TESTVILLE'`); n != 1 {
		t.Errorf("the listing must land in the upper-case region, found %d", n)
	}
	if n := count(t, rig, `SELECT count(*) FROM house_price_regions WHERE region_code = 'SUBURB:vic-3000-TESTVILLE'`); n != 0 {
		t.Errorf("no lower-case region may be created, found %d", n)
	}
}

// TestPush_SameKeyFromAnotherSubjectIsAlreadyExists: a replay must come from the same
// rig. Another rig that sends the same key and the same body is refused, not replayed.
func TestPush_SameKeyFromAnotherSubjectIsAlreadyExists(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedRig(t, pool, testRig2, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	mustPush(t, rig, req)
	_, err := rig.pushAs(t, testRig2, req)
	wantCode(t, err, connect.CodeAlreadyExists)
}

// TestPush_ObservedAtIsNotPartOfTheDigest: observed_at is informational. A retry that
// carries a re-serialised timestamp replays, and does not conflict.
func TestPush_ObservedAtIsNotPartOfTheDigest(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	req.ObservedAt = timestampAt(clock.Now())
	mustPush(t, rig, req)

	retry := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	retry.ObservedAt = timestampAt(clock.Now().Add(7 * time.Second))
	got := mustPush(t, rig, retry)
	if !got.Replayed {
		t.Errorf("a retry differing only in observed_at must replay, got %+v", got)
	}
}

// TestQuarantineBypass: an operator row releases a held suburb until it expires. The
// sweep is the four-large-moves case, which the default threshold holds.
func TestQuarantineBypass(t *testing.T) {
	setup := func(t *testing.T) (*ingestRig, *pgxpool.Pool) {
		pool := ingestTestDB(t)
		issuer := newIssuerFixture(t)
		clock := newTestClock()
		rig := startIngest(t, pool, issuer, clock, nil)
		seedRig(t, pool, testRig, true)
		seedDispatch(t, pool, "job-1", "run-1", "rea")
		for i := 1; i <= 8; i++ {
			seedActiveRea(t, pool, fmt.Sprintf("P%d", i), 1_000_000, 0)
		}
		return rig, pool
	}
	moves := func() []*pb.Listing {
		var out []*pb.Listing
		for i := 1; i <= 8; i++ {
			price := 1_000_000.0
			if i <= 4 {
				price = 1_200_000
			}
			out = append(out, fixedRea(fmt.Sprintf("P%d", i), price))
		}
		return out
	}

	t.Run("an unexpired release applies the sweep", func(t *testing.T) {
		rig, pool := setup(t)
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO crawl_ingest_quarantine_bypass (suburb, state, source, expires_at, note)
			VALUES ('testville', 'VIC', 'rea', now() + interval '1 hour', 'test release')`); err != nil {
			t.Fatal(err)
		}
		resp := mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, moves()...))
		if resp.Quarantined || resp.ListingsUpserted != 8 {
			t.Errorf("a live release must let the sweep apply, got %+v", resp)
		}
	})

	t.Run("an expired release holds the sweep again", func(t *testing.T) {
		rig, pool := setup(t)
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO crawl_ingest_quarantine_bypass (suburb, state, source, expires_at, note)
			VALUES ('testville', 'VIC', 'rea', now() - interval '1 minute', 'expired release')`); err != nil {
			t.Fatal(err)
		}
		resp := mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, moves()...))
		if !resp.Quarantined {
			t.Errorf("an expired release must not apply, got %+v", resp)
		}
	})
}

// TestQuarantineFloorKeepsSmallSuburbsOpen: with three existing listings, one genuine
// 20% drop used to hold the suburb forever. The floor of three moves now lets it pass.
func TestQuarantineFloorKeepsSmallSuburbsOpen(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	for i := 1; i <= 3; i++ {
		seedActiveRea(t, pool, fmt.Sprintf("S%d", i), 1_000_000, 0)
	}
	resp := mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedRea("S1", 1_200_000), fixedRea("S2", 1_000_000), fixedRea("S3", 1_000_000)))
	if resp.Quarantined || resp.ListingsUpserted != 3 {
		t.Errorf("one genuine move among three must apply, got %+v", resp)
	}
}

// TestCycleRateLimitIsShared: ReportCycle draws on the same per-rig budget as
// PushSweep, so the 121st call of either kind is refused.
func TestCycleRateLimitIsShared(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	token := issuer.mint(t, testRig, clock.Now(), nil)
	client := rig.client()
	for i := 1; i <= 120; i++ {
		if _, err := client.ReportCycle(context.Background(), withToken(connect.NewRequest(&pb.ReportCycleRequest{
			CycleId: fmt.Sprintf("c-%d", i), Outcome: "ok",
		}), token)); err != nil {
			t.Fatalf("cycle %d of 120 must be served: %v", i, err)
		}
	}
	_, err := client.ReportCycle(context.Background(), withToken(connect.NewRequest(&pb.ReportCycleRequest{
		CycleId: "c-121", Outcome: "ok",
	}), token))
	wantCode(t, err, connect.CodeResourceExhausted)
}

// TestCancelledCycleIsNotAnError: a cancelled cycle (a routine stop) is recorded as
// partial, which the freshness sentinel does not alarm on. Only error and blocked do.
func TestCancelledCycleIsNotAnError(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	token := issuer.mint(t, testRig, clock.Now(), nil)
	if _, err := rig.client().ReportCycle(context.Background(), withToken(connect.NewRequest(&pb.ReportCycleRequest{
		CycleId: "c-1", Outcome: "cancelled", ExitCode: 10,
	}), token)); err != nil {
		t.Fatalf("ReportCycle: %v", err)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM crawl_run_status WHERE host = $1`, testRig).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "partial" {
		t.Errorf("a cancelled cycle must record as partial, got %q", status)
	}
}

// identicalConcurrentPushes sends n copies of one push at once and checks the
// transaction's guarantees: exactly one apply, every other call a replay, every call
// returns within its deadline, and no advisory lock is left behind.
func identicalConcurrentPushes(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedRea("A", 1_000_000), fixedRea("B", 1_200_000))
	token := issuer.mint(t, testRig, clock.Now(), nil)

	const n = 8
	type result struct {
		resp *pb.PushSweepResponse
		err  error
	}
	results := make(chan result, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			resp, err := rig.client().PushSweep(ctx, withToken(connect.NewRequest(req), token))
			if err != nil {
				results <- result{err: err}
				return
			}
			results <- result{resp: resp.Msg}
		}()
	}
	wg.Wait()
	close(results)

	applied, replayed := 0, 0
	for r := range results {
		if r.err != nil {
			t.Fatalf("a concurrent push failed or hung: %v", r.err)
		}
		switch {
		case r.resp.Replayed:
			replayed++
		case !r.resp.Quarantined:
			applied++
		}
	}
	if applied != 1 || replayed != n-1 {
		t.Errorf("want exactly one apply and %d replays, got applied=%d replayed=%d", n-1, applied, replayed)
	}
	if got := count(t, rig, `SELECT count(*) FROM property_price_events WHERE event_type = 'first_seen'`); got != 2 {
		t.Errorf("the sweep must be applied once: 2 first_seen events, got %d", got)
	}
	if got := count(t, rig, `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'`); got != 0 {
		t.Errorf("no advisory lock may remain after the pushes, found %d", got)
	}
}

// TestPush_IdenticalConcurrentPushesApplyOnce proves the transaction-level lock on the
// direct connection pool.
func TestPush_IdenticalConcurrentPushesApplyOnce(t *testing.T) {
	identicalConcurrentPushes(t, ingestTestDB(t))
}

// TestPush_PoolOfTwoNeverBlocksForever: pushes that each hold a connection for their
// whole transaction, against a pool of two, all complete. Distinct jobs, so nothing is
// replayed and each one must do real work.
func TestPush_PoolOfTwoNeverBlocksForever(t *testing.T) {
	pool := ingestTestDBSized(t, 2)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	const n = 6
	for i := 1; i <= n; i++ {
		seedDispatchRow(t, pool, fmt.Sprintf("job-%d", i), "Testville", "VIC", "3000", "rea")
	}
	token := issuer.mint(t, testRig, clock.Now(), nil)

	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 1; i <= n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			req := sweepReq(fmt.Sprintf("job-%d", i), 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
				fixedRea(fmt.Sprintf("Q%d", i), 1_000_000))
			_, err := rig.client().PushSweep(ctx, withToken(connect.NewRequest(req), token))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a push against a pool of two failed or blocked: %v", err)
		}
	}
	if got := count(t, rig, `SELECT count(*) FROM property_listings`); got != n {
		t.Errorf("all %d pushes must write their listing, got %d", n, got)
	}
}

// TestPushThroughTransactionPooler runs the concurrency guarantees through a
// transaction-mode pooler (pgbouncer pool_mode=transaction, or Supavisor on 6543). It
// needs HOUSING_TEST_PGBOUNCER_URL to name that pooler, and skips without it. The
// pooler's backend changes between statements, so a session advisory lock would leak
// here.
func TestPushThroughTransactionPooler(t *testing.T) {
	dsn := os.Getenv("HOUSING_TEST_PGBOUNCER_URL")
	if dsn == "" {
		t.Skip("set HOUSING_TEST_PGBOUNCER_URL to a transaction-mode pooler to run this test")
	}
	identicalConcurrentPushes(t, ingestPoolAt(t, dsn, 4))
	concurrentAttemptsOfOneJob(t, ingestPoolAt(t, dsn, 4))
}

// TestPush_StaleBacklogDoesNotHoldASoundSweep: a COMPLETE sweep that sees the live
// listings and drops a backlog no sweep has seen for weeks is applied, and the stale
// listings are delisted. A sweep whose RECENT delists are over the threshold is still
// held, whatever its stale count. The threshold on 70 active is 17.5.
func TestPush_StaleBacklogDoesNotHoldASoundSweep(t *testing.T) {
	cases := []struct {
		name        string
		staleGone   int
		recentGone  int
		quarantined bool
	}{
		{"30 stale delists, none recent: applied", 30, 0, false},
		{"10 stale and 20 recent delists: recent 20 is over 17.5, held", 10, 20, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			// The production exemption, as ConfigFromEnv sets it. The harness's own Config
			// leaves it at 0 (off), which is the disabled case.
			rig := startIngest(t, pool, issuer, clock, func(c *Config) { c.DelistStaleAfter = DefaultDelistStaleAfter })
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")

			const live = 40
			var present []*pb.Listing
			for i := 1; i <= live; i++ {
				id := fmt.Sprintf("L%02d", i)
				seedListing(t, rig, id, 1_000_000, 0)
				present = append(present, fixedRea(id, 1_000_000))
			}
			// The absent backlog: missed once, last seen 40 days ago (stale) or 5 days ago (recent).
			for i := 1; i <= tc.staleGone; i++ {
				seedListing(t, rig, fmt.Sprintf("S%02d", i), 1_000_000, 1)
				mustExec(t, pool, `UPDATE property_listings SET last_seen_at = now() - interval '40 days' WHERE listing_id = $1`, fmt.Sprintf("S%02d", i))
			}
			for i := 1; i <= tc.recentGone; i++ {
				seedListing(t, rig, fmt.Sprintf("R%02d", i), 1_000_000, 1)
				mustExec(t, pool, `UPDATE property_listings SET last_seen_at = now() - interval '5 days' WHERE listing_id = $1`, fmt.Sprintf("R%02d", i))
			}

			resp, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, present...))
			if err != nil {
				t.Fatalf("PushSweep: %v", err)
			}
			if resp.Quarantined != tc.quarantined {
				t.Fatalf("quarantined = %v, want %v (%+v)", resp.Quarantined, tc.quarantined, resp)
			}
			if tc.quarantined {
				var stats string
				if err := pool.QueryRow(context.Background(), `SELECT stats::text FROM crawl_ingest_quarantine WHERE job_id = 'job-1'`).Scan(&stats); err != nil {
					t.Fatalf("read quarantine stats: %v", err)
				}
				if !strings.Contains(stats, `"delisted_stale": 10`) || !strings.Contains(stats, `"would_delist": 30`) {
					t.Errorf("a held sweep must report both delist counts, got %s", stats)
				}
				return
			}
			if resp.Delisted != int32(tc.staleGone+tc.recentGone) {
				t.Errorf("Delisted = %d, want %d (the total is unchanged)", resp.Delisted, tc.staleGone+tc.recentGone)
			}
			if active := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active`); active != live {
				t.Errorf("want %d live listings after the sweep, got %d", live, active)
			}
		})
	}
}

// mustExec runs one statement against the pool and fails the test on error.
func mustExec(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// TestPush_OutageThenTruncatedSweepPairIsHeld is the B1 outage. A region went dark 25
// days ago, and then two page-1-truncated COMPLETE sweeps arrive 13 hours apart. The
// first arms the 100 unseen listings (0 -> 1) and passes. The second would delist all
// 100, and every one is stale, so the stale exemption must not let it through: the
// sweep covered 20 of 120, under half. It is held with exemption on or off, the live
// listings all stay active, and the held sweep rolls back.
func TestPush_QuarantineHoldsTheOutageThenTruncatedPair(t *testing.T) {
	for _, tc := range []struct {
		name       string
		staleAfter time.Duration
	}{
		{"exemption on (the default)", DefaultDelistStaleAfter},
		{"exemption off (pre-exemption behaviour)", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			rig := startIngest(t, pool, issuer, clock, func(c *Config) { c.DelistStaleAfter = tc.staleAfter })
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")
			seedDispatch(t, pool, "job-2", "run-2", "rea")

			const live, truncated = 120, 20
			var page1 []*pb.Listing
			for i := 1; i <= live; i++ {
				id := fmt.Sprintf("L%03d", i)
				seedListing(t, rig, id, 1_000_000, 0)
				if i <= truncated {
					page1 = append(page1, fixedRea(id, 1_000_000))
				}
			}
			// The region went dark 25 days ago: nothing has been seen since.
			mustExec(t, pool, `UPDATE property_listings SET last_seen_at = $1`, clock.Now().Add(-25*24*time.Hour))

			first, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, page1...))
			if err != nil {
				t.Fatalf("truncated sweep 1: %v", err)
			}
			if first.Quarantined || first.Delisted != 0 {
				t.Fatalf("sweep 1 arms the unseen listings and delists none, got %+v", first)
			}
			if armed := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active AND missed_sweeps = 1`); armed != live-truncated {
				t.Fatalf("sweep 1 must arm the %d unseen listings, armed %d", live-truncated, armed)
			}

			clock.Advance(13 * time.Hour) // past MinDelistInterval
			second, err := rig.push(t, sweepReq("job-2", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, page1...))
			if err != nil {
				t.Fatalf("truncated sweep 2: %v", err)
			}
			if !second.Quarantined {
				t.Fatalf("HOLE: a truncated COMPLETE sweep over a dark region was applied (delisted %d)", second.Delisted)
			}
			if active := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active`); active != live {
				t.Errorf("the held sweep rolls back, so all %d listings stay active, got %d", live, active)
			}
			if n := count(t, rig, `SELECT count(*) FROM property_price_events WHERE event_type = 'delisted'`); n != 0 {
				t.Errorf("a held sweep writes no delisted event, found %d", n)
			}
		})
	}
}

// TestPush_StaleCleanupIsLogged: an applied sweep that withdraws listings leaves one
// line with the stale split and whether the exemption applied, and a dry run reports
// its delisted_stale too. The log is captured through zap's observer.
func TestPush_StaleCleanupIsLogged(t *testing.T) {
	capture := func(t *testing.T) *observer.ObservedLogs {
		t.Helper()
		core, logs := observer.New(zap.InfoLevel)
		restore := zap.ReplaceGlobals(zap.New(core))
		t.Cleanup(restore)
		return logs
	}
	seed := func(t *testing.T) (*ingestRig, []*pb.Listing) {
		pool := ingestTestDB(t)
		issuer := newIssuerFixture(t)
		clock := newTestClock()
		rig := startIngest(t, pool, issuer, clock, func(c *Config) { c.DelistStaleAfter = DefaultDelistStaleAfter })
		seedRig(t, pool, testRig, true)
		seedDispatch(t, pool, "job-1", "run-1", "rea")
		var present []*pb.Listing
		for i := 1; i <= 40; i++ {
			id := fmt.Sprintf("L%02d", i)
			seedListing(t, rig, id, 1_000_000, 0)
			present = append(present, fixedRea(id, 1_000_000))
		}
		for i := 1; i <= 10; i++ {
			id := fmt.Sprintf("S%02d", i)
			seedListing(t, rig, id, 1_000_000, 1)
			mustExec(t, pool, `UPDATE property_listings SET last_seen_at = now() - interval '40 days' WHERE listing_id = $1`, id)
		}
		return rig, present
	}
	find := func(logs *observer.ObservedLogs, parts ...string) string {
		for _, e := range logs.All() {
			ok := true
			for _, p := range parts {
				if !strings.Contains(e.Message, p) {
					ok = false
					break
				}
			}
			if ok {
				return e.Message
			}
		}
		return ""
	}

	t.Run("an applied cleanup records the split and the exemption", func(t *testing.T) {
		logs := capture(t)
		rig, present := seed(t)
		resp, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, present...))
		if err != nil || resp.Quarantined {
			t.Fatalf("the sweep must apply, got err=%v resp=%+v", err, resp)
		}
		line := find(logs, "applied", "delisted=10", "delisted_stale=10", "stale_exempt=true")
		if line == "" {
			t.Fatalf("want one applied-cleanup line with delisted=10 delisted_stale=10 stale_exempt=true, logged: %v", logs.All())
		}
	})

	t.Run("a dry run reports delisted_stale", func(t *testing.T) {
		logs := capture(t)
		rig, present := seed(t)
		req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, present...)
		req.DryRun = true
		if _, err := rig.push(t, req); err != nil {
			t.Fatalf("dry run: %v", err)
		}
		if find(logs, "dry run", "delisted_stale=10") == "" {
			t.Fatalf("the dry-run line must carry delisted_stale=10, logged: %v", logs.All())
		}
	})
}
