package ingest

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// Tests for the second review: duplicate listing ids, the zero-gated rule's effect on
// the job, the dispatch reasons, and N concurrent attempts of one job.

// TestPush_DuplicateListingIDIsRefused: a repeated listing_id in one request is refused
// with InvalidArgument, and nothing is written. The review's case: nine stored listings,
// eight really halved, and the push padded with 31 copies of one unchanged listing. The
// copies used to count as existing listings and push the sweep under the threshold.
func TestPush_DuplicateListingIDIsRefused(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	for i := 1; i <= 9; i++ {
		seedActiveRea(t, pool, fmt.Sprintf("S%d", i), 1_000_000, 0)
	}

	var padded []*pb.Listing
	for i := 1; i <= 8; i++ {
		padded = append(padded, fixedRea(fmt.Sprintf("S%d", i), 500_000)) // halved
	}
	for i := 0; i < 31; i++ {
		padded = append(padded, fixedRea("S9", 1_000_000)) // unchanged, repeated
	}
	_, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, padded...))
	wantCode(t, err, connect.CodeInvalidArgument)
	if !strings.Contains(err.Error(), "repeats an earlier listing") {
		t.Errorf("the refusal must name the repeat, got %v", err)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_price_events WHERE event_type = 'price_drop'`); n != 0 {
		t.Errorf("a refused sweep must write no price drop, found %d", n)
	}
}

// TestPush_ZeroGatedNeverClosesTheJob: an empty PARTIAL, and a COMPLETE made only of soft
// misses, write nothing and leave the job open. The real attempt 2 then applies. Before
// this, both closed the job with zero writes, and attempt 2 was refused.
func TestPush_ZeroGatedNeverClosesTheJob(t *testing.T) {
	cases := map[string]func() *pb.PushSweepRequest{
		"empty PARTIAL": func() *pb.PushSweepRequest {
			r := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_PARTIAL)
			r.PageMeta = &pb.PageMeta{TotalResults: 5}
			return r
		},
		"COMPLETE of soft misses only": func() *pb.PushSweepRequest {
			r := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
				fixedReaAt("N1", 1_000_000, "Otherville", "3000"))
			return r
		},
	}
	for name, first := range cases {
		t.Run(name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			rig := startIngest(t, pool, issuer, clock, nil)
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")

			resp := mustPush(t, rig, first())
			if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED {
				t.Fatalf("%s must be applied as BLOCKED, got %v", name, resp.AppliedStatus)
			}
			if n := count(t, rig, `SELECT count(*) FROM crawl_dispatch WHERE closed_at IS NOT NULL`); n != 0 {
				t.Errorf("%s must not close the job, %d closed", name, n)
			}

			retry := mustPush(t, rig, sweepReq("job-1", 2, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
			if retry.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_COMPLETE || retry.ListingsUpserted != 1 {
				t.Errorf("attempt 2 after a %s must apply, got %+v", name, retry)
			}
		})
	}
}

// TestPush_AppliedJobReportsDispatchApplied: a second attempt after an applied job is
// refused with dispatch_applied, which a rig reads as done, not failed.
func TestPush_AppliedJobReportsDispatchApplied(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")
	mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))

	_, err := rig.push(t, sweepReq("job-1", 2, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	wantCode(t, err, connect.CodeFailedPrecondition)
	if !strings.Contains(err.Error(), "dispatch_applied") || strings.Contains(err.Error(), "dispatch_expired") {
		t.Errorf("an applied job reports dispatch_applied only, got %v", err)
	}
}

// TestPush_ConcurrentAttemptsOfOneJobApplyOnce sends N attempts of one job at once, each
// under its own key, and checks that exactly one applies. The others are refused with
// dispatch_applied, and nothing is written twice. The row lock on crawl_dispatch
// (FOR UPDATE) is what serialises them: each attempt takes a different key lock, so the
// key lock does not. A start barrier maximises the overlap, so a missing row lock shows
// up on the first run and not only on a rare one.
func TestPush_ConcurrentAttemptsOfOneJobApplyOnce(t *testing.T) {
	pool := ingestTestDBSized(t, 8)
	concurrentAttemptsOfOneJob(t, pool)
}

// concurrentAttemptsOfOneJob is the body of the test above. It is shared with the
// transaction-pooler test, where the same race must also hold.
func concurrentAttemptsOfOneJob(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-race", "run-1", "rea")
	token := issuer.mint(t, testRig, clock.Now(), nil)

	const n = 8
	type outcome struct {
		applied  bool
		reason   string
		replayed bool
		err      error
	}
	outcomes := make(chan outcome, n)
	start := make(chan struct{})
	var ready sync.WaitGroup
	for i := 1; i <= n; i++ {
		ready.Add(1)
		go func(attempt int32) {
			defer ready.Done()
			req := sweepReq("job-race", attempt, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
				fixedRea("R1", 1_000_000), fixedRea("R2", 1_200_000))
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			resp, err := rig.client().PushSweep(ctx, withToken(connect.NewRequest(req), token))
			if err != nil {
				outcomes <- outcome{reason: err.Error(), err: err}
				return
			}
			outcomes <- outcome{applied: !resp.Msg.Replayed, replayed: resp.Msg.Replayed}
		}(int32(i))
	}
	close(start)
	ready.Wait()
	close(outcomes)

	applied, refused := 0, 0
	for o := range outcomes {
		switch {
		case o.err != nil:
			if !strings.Contains(o.reason, "dispatch_applied") {
				t.Errorf("a losing attempt must be refused with dispatch_applied, got %v", o.err)
			}
			refused++
		case o.applied:
			applied++
		default:
			t.Errorf("no attempt may be a replay here: each has its own key")
		}
	}
	if applied != 1 || refused != n-1 {
		t.Fatalf("want exactly one apply and %d dispatch_applied, got applied=%d refused=%d", n-1, applied, refused)
	}
	if got := count(t, rig, `SELECT count(*) FROM property_price_events WHERE event_type = 'first_seen'`); got != 2 {
		t.Errorf("the job must be applied once: 2 first_seen events, got %d", got)
	}
	if got := count(t, rig, `SELECT count(*) FROM crawl_ingest_receipts`); got != 1 {
		t.Errorf("exactly one receipt must exist for the job, got %d", got)
	}
}
