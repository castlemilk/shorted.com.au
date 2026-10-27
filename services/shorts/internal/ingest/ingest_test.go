package ingest

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
)

// The end-to-end PushSweep outcomes, through a real Connect client, against the
// migrated schema. Each test names the spec case it pins.

const testSuburbDisplay = "Testville"

func srcName(s pb.Source) string { return sourceName(s) }

// sweepReq builds a valid PushSweep for job and source. The key is derived from
// the same fields the service checks, so a test only names what it varies.
func sweepReq(job string, attempt int32, source pb.Source, status pb.SweepStatus, listings ...*pb.Listing) *pb.PushSweepRequest {
	return &pb.PushSweepRequest{
		IdempotencyKey:    fmt.Sprintf("%s:%d:%s", job, attempt, srcName(source)),
		JobId:             job,
		Attempt:           attempt,
		Target:            &pb.Target{Suburb: testSuburbDisplay, State: "VIC", Postcode: "3000"},
		Source:            source,
		Status:            status,
		Pages:             1,
		PageMeta:          &pb.PageMeta{TotalResults: int32(len(listings)), TotalPages: 1, PageSize: 20, OnTargetResults: int32(len(listings))},
		Listings:          listings,
		ContractVersion:   DefaultMinContractVersion,
		CollectorRevision: "test-revision",
	}
}

// fixedRea is a priced, on-target REA listing.
func fixedRea(id string, price float64) *pb.Listing {
	p := price
	return &pb.Listing{
		Source: "rea", ListingId: id, ListingUrl: "https://example.test/" + id,
		DisplayAddr: "1 " + id + " Street", Suburb: testSuburbDisplay, State: "VIC", Postcode: "3000",
		PriceLow: &p, PriceKind: "fixed", Status: "for_sale",
	}
}

// push sends req with a fresh token for the test rig.
func (r *ingestRig) push(t *testing.T, req *pb.PushSweepRequest) (*pb.PushSweepResponse, error) {
	t.Helper()
	token := r.issuer.mint(t, testRig, r.clock.Now(), nil)
	resp, err := r.client().PushSweep(context.Background(), withToken(connect.NewRequest(req), token))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

func mustPush(t *testing.T, r *ingestRig, req *pb.PushSweepRequest) *pb.PushSweepResponse {
	t.Helper()
	resp, err := r.push(t, req)
	if err != nil {
		t.Fatalf("PushSweep %s: %v", req.IdempotencyKey, err)
	}
	return resp
}

// count runs a COUNT query.
func count(t *testing.T, r *ingestRig, query string, args ...any) int {
	t.Helper()
	var n int
	if err := r.pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// seedListing inserts an active listing directly, for the boundary tests that need
// a region already holding listings.
func seedListing(t *testing.T, r *ingestRig, id string, price float64, missed int) {
	t.Helper()
	if _, err := r.pool.Exec(context.Background(), `
		INSERT INTO property_listings
		  (source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode,
		   display_address, price, price_kind, listing_status, is_active, missed_sweeps, content_hash)
		VALUES ('rea', $1, $2, $3, 'SUBURB:VIC-3000-TESTVILLE', 'Testville', 'VIC', '3000', $4,
		        $5, 'fixed', 'for_sale', true, $6, 'seed')`,
		id, "seed-"+id, "https://example.test/"+id, "1 "+id+" Street", price, missed); err != nil {
		t.Fatalf("seed listing %s: %v", id, err)
	}
}

// TestPush_HappyPathWritesStampedRows: a valid COMPLETE sweep writes its listings and
// first_seen events, every one stamped with the idempotency key, and the response
// carries counts only.
func TestPush_HappyPathWritesStampedRows(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	resp := mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedRea("A", 1_000_000), fixedRea("B", 1_200_000)))

	if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_COMPLETE || resp.Quarantined || resp.Replayed {
		t.Fatalf("unexpected response flags: %+v", resp)
	}
	if resp.ListingsUpserted != 2 || resp.Events != 2 {
		t.Fatalf("want 2 upserted and 2 events (first_seen), got %+v", resp)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE ingest_receipt_key = 'job-1:1:rea'`); n != 2 {
		t.Errorf("every listing row must carry the receipt, got %d stamped", n)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_price_events WHERE ingest_receipt_key = 'job-1:1:rea'`); n != 2 {
		t.Errorf("every event must carry the receipt, got %d stamped", n)
	}
}

// TestPush_ReplayReturnsTheStoredResponse: the same key and body returns the stored
// response with replayed=true, and writes nothing new.
func TestPush_ReplayReturnsStoredResponse(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	first := mustPush(t, rig, req)
	events := count(t, rig, `SELECT count(*) FROM property_price_events`)

	clock.Advance(time.Minute) // a retry a minute later is still the same push
	second := mustPush(t, rig, req)
	if !second.Replayed {
		t.Fatal("a repeated push must be a replay")
	}
	if second.ListingsUpserted != first.ListingsUpserted || second.Events != first.Events {
		t.Errorf("replay must return the stored counts: first %+v second %+v", first, second)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_price_events`); n != events {
		t.Errorf("a replay must write no events: had %d, now %d", events, n)
	}
}

// TestPush_SameKeyDifferentBodyIsAlreadyExists: the key was used for other content.
func TestPush_SameKeyDifferentBodyIsAlreadyExists(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	mustPush(t, rig, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	_, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("B", 1_000_000)))
	wantCode(t, err, connect.CodeAlreadyExists)
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE listing_id = 'B'`); n != 0 {
		t.Errorf("a refused reuse must write nothing, found %d row(s) for B", n)
	}
}

// TestPush_UndispatchedIsFailedPrecondition: a job the ledger never dispatched is not
// applied, whatever its content.
func TestPush_UndispatchedIsFailedPrecondition(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	_, err := rig.push(t, sweepReq("job-ghost", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000)))
	wantCode(t, err, connect.CodeFailedPrecondition)
	if !strings.Contains(err.Error(), "not_dispatched") {
		t.Errorf("want the not_dispatched reason, got %v", err)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("an undispatched sweep must write nothing, found %d", n)
	}
}

// TestPush_TargetMismatchIsFailedPrecondition: the request's target or source must
// name the dispatched job. The canonical target is the ledger's, never the request's.
func TestPush_TargetMismatchIsFailedPrecondition(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	wrongSuburb := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	wrongSuburb.Target.Suburb = "Bondi"
	_, err := rig.push(t, wrongSuburb)
	wantCode(t, err, connect.CodeFailedPrecondition)

	wrongPostcode := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	wrongPostcode.Target.Postcode = "2026"
	_, err = rig.push(t, wrongPostcode)
	wantCode(t, err, connect.CodeFailedPrecondition)

	wrongSource := sweepReq("job-1", 1, pb.Source_SOURCE_DOMAIN, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	_, err = rig.push(t, wrongSource)
	wantCode(t, err, connect.CodeFailedPrecondition)

	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("a mismatched sweep must write nothing, found %d", n)
	}
}

// TestPush_RunTSIsTheServerReceiveTime: observed_at is informational. Whether it is
// far in the past or the future, every write is stamped with the server's clock.
func TestPush_RunTSIsServerTime(t *testing.T) {
	for name, observed := range map[string]time.Time{
		"far past":   time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
		"far future": time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC),
	} {
		t.Run(name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			rig := startIngest(t, pool, issuer, clock, nil)
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")

			req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
			req.ObservedAt = timestamppb.New(observed)
			mustPush(t, rig, req)

			var seen, first time.Time
			if err := pool.QueryRow(context.Background(), `SELECT observed_at FROM property_price_events LIMIT 1`).Scan(&seen); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(context.Background(), `SELECT first_seen_at FROM property_listings WHERE listing_id = 'A'`).Scan(&first); err != nil {
				t.Fatal(err)
			}
			if !seen.Equal(clock.Now()) || !first.Equal(clock.Now()) {
				t.Errorf("writes must carry the server clock %v, got event=%v first_seen=%v", clock.Now(), seen, first)
			}
		})
	}
}

// TestPush_BlockedWritesNothingButIsRecorded: a BLOCKED sweep touches no rows, and
// its receipt is still stored, so a retry replays rather than re-applies.
func TestPush_BlockedWritesNothing(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_BLOCKED, fixedRea("A", 1_000_000))
	resp := mustPush(t, rig, req)
	if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_BLOCKED || resp.ListingsUpserted != 0 || resp.Events != 0 {
		t.Fatalf("a BLOCKED sweep reports no writes, got %+v", resp)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("BLOCKED must write no listing, found %d", n)
	}
	if again := mustPush(t, rig, req); !again.Replayed {
		t.Error("a BLOCKED push's receipt must be stored, so the retry replays")
	}
}

// TestPush_EmptyCompleteAcceptedOnlyWithZeroResults: an empty COMPLETE sweep is a
// PARTIAL, which never delists, unless the portal reported zero results.
func TestPush_EmptyCompleteAcceptedOnlyWithZeroResults(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-seed", "run-1", "rea")
	seedDispatch(t, pool, "job-empty", "run-1", "rea")
	seedDispatch(t, pool, "job-zero", "run-1", "rea")
	seedDispatch(t, pool, "job-nometa", "run-1", "rea")
	seedDispatch(t, pool, "job-late", "run-1", "rea")

	mustPush(t, rig, sweepReq("job-seed", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		fixedRea("A", 1_000_000), fixedRea("B", 1_000_000), fixedRea("C", 1_000_000)))

	// The portal reports 5 results, yet the rig sent nothing: this must not delist.
	empty := sweepReq("job-empty", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	empty.PageMeta.TotalResults = 5
	resp := mustPush(t, rig, empty)
	if resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_PARTIAL {
		t.Errorf("an empty COMPLETE with results must apply as PARTIAL, got %v", resp.AppliedStatus)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active AND missed_sweeps = 0`); n != 3 {
		t.Errorf("the empty sweep must not touch the listings, %d unchanged", n)
	}

	// No page metadata at all is not evidence of zero results either.
	nometa := sweepReq("job-nometa", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	nometa.PageMeta = nil
	if resp := mustPush(t, rig, nometa); resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_PARTIAL {
		t.Errorf("an empty COMPLETE without page metadata must be PARTIAL, got %v", resp.AppliedStatus)
	}

	// Zero results is the one case an empty COMPLETE is believed. It is a miss, not a
	// delist, on the first sweep (grace is 2).
	zero := sweepReq("job-zero", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE)
	if resp := mustPush(t, rig, zero); resp.AppliedStatus != pb.SweepStatus_SWEEP_STATUS_COMPLETE {
		t.Fatalf("an empty COMPLETE with zero results is COMPLETE, got %v", resp.AppliedStatus)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active`); n != 3 {
		t.Errorf("one miss must not delist (grace 2), %d still active", n)
	}
}

// TestPush_DryRunWritesNothing: a dry run reports what it would have produced and
// leaves no row, no receipt and no key, so the real push still applies.
func TestPush_DryRunWritesNothing(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	dry := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000), fixedRea("B", 1_200_000))
	dry.DryRun = true
	resp := mustPush(t, rig, dry)
	if resp.ListingsUpserted != 2 || resp.Events != 2 {
		t.Errorf("a dry run reports the counts it would have produced, got %+v", resp)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("a dry run must write no listing, found %d", n)
	}
	if n := count(t, rig, `SELECT count(*) FROM crawl_ingest_receipts`); n != 0 {
		t.Errorf("a dry run must store no receipt, found %d", n)
	}

	real := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000), fixedRea("B", 1_200_000))
	applied := mustPush(t, rig, real)
	if applied.Replayed {
		t.Fatal("the real push after a dry run must apply, not replay")
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 2 {
		t.Errorf("the real push must write its two listings, found %d", n)
	}
}

// TestPush_QuarantineAtThePriceBoundary: more than 25% of the listings that already
// existed moving more than 10% quarantines the sweep. Exactly 25% passes.
func TestPush_QuarantineAtThePriceBoundary(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	for _, j := range []string{"job-seed", "job-just-under", "job-over"} {
		seedDispatch(t, pool, j, "run-1", "rea")
	}

	var seed []*pb.Listing
	for i := 1; i <= 8; i++ {
		seed = append(seed, fixedRea(fmt.Sprintf("P%d", i), 1_000_000))
	}
	mustPush(t, rig, sweepReq("job-seed", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, seed...))

	// Exactly 2 of 8 existing listings move +20%: 25%, not more than 25%. It passes.
	var justUnder []*pb.Listing
	for i := 1; i <= 8; i++ {
		price := 1_000_000.0
		if i <= 2 {
			price = 1_200_000
		}
		justUnder = append(justUnder, fixedRea(fmt.Sprintf("P%d", i), price))
	}
	resp := mustPush(t, rig, sweepReq("job-just-under", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, justUnder...))
	if resp.Quarantined {
		t.Fatalf("exactly 25%% of existing listings moving must pass, got quarantined")
	}
	if resp.ListingsUpserted != 8 {
		t.Errorf("the passing sweep applies its 8 listings, got %d", resp.ListingsUpserted)
	}

	// Stored now: P1 and P2 at 1,200,000; P3 to P8 at 1,000,000. This sweep moves P3
	// to P5 up 20% and leaves the rest. That is 3 of 8 existing (37.5%): held.
	var over []*pb.Listing
	for i := 1; i <= 8; i++ {
		price := 1_000_000.0
		if i <= 5 {
			price = 1_200_000
		}
		over = append(over, fixedRea(fmt.Sprintf("P%d", i), price))
	}
	held, err := rig.push(t, sweepReq("job-over", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, over...))
	if err != nil {
		t.Fatalf("a quarantined sweep is a success for the rig: %v", err)
	}
	if !held.Quarantined || held.ListingsUpserted != 0 || held.Events != 0 {
		t.Fatalf("a held sweep reports quarantined with zero writes, got %+v", held)
	}
	if n := count(t, rig, `SELECT count(*) FROM property_listings WHERE ingest_receipt_key = 'job-over:1:rea'`); n != 0 {
		t.Errorf("a held sweep must write no row, found %d stamped", n)
	}
	if n := count(t, rig, `SELECT count(*) FROM crawl_ingest_quarantine WHERE reason = 'price_moves_over_threshold' AND job_id = 'job-over'`); n != 1 {
		t.Errorf("the hold must be recorded once, found %d", n)
	}
	var stats string
	if err := pool.QueryRow(context.Background(), `SELECT stats::text FROM crawl_ingest_quarantine WHERE job_id = 'job-over'`).Scan(&stats); err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"example.test", "Street", "P3"} {
		if strings.Contains(stats, leaked) {
			t.Errorf("quarantine stats must hold counts only, found %q in %s", leaked, stats)
		}
	}

	// The held receipt replays as quarantined: a retry does not re-apply.
	replay := mustPush(t, rig, sweepReq("job-over", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, over...))
	if !replay.Replayed || !replay.Quarantined {
		t.Errorf("a retried held sweep must replay as quarantined, got %+v", replay)
	}
}

// TestPush_QuarantineAtTheDelistBoundary: a sweep may delist max(25% of the active
// listings, 20). Exactly the floor passes; one more is held and delists nothing.
func TestPush_QuarantineAtTheDelistBoundary(t *testing.T) {
	cases := []struct {
		name        string
		absent      int
		quarantined bool
	}{
		{"exactly the 20 floor passes", 20, false},
		{"one over the floor is held", 21, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := ingestTestDB(t)
			issuer := newIssuerFixture(t)
			clock := newTestClock()
			rig := startIngest(t, pool, issuer, clock, nil)
			seedRig(t, pool, testRig, true)
			seedDispatch(t, pool, "job-1", "run-1", "rea")

			// 40 active listings, each already missed once: one more COMPLETE miss
			// delists them (grace 2).
			for i := 1; i <= 40; i++ {
				seedListing(t, rig, fmt.Sprintf("D%02d", i), 1_000_000, 1)
			}
			// The rig sees the last 40-tc.absent listings, so tc.absent are missing.
			var present []*pb.Listing
			for i := tc.absent + 1; i <= 40; i++ {
				present = append(present, fixedRea(fmt.Sprintf("D%02d", i), 1_000_000))
			}
			resp, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, present...))
			if err != nil {
				t.Fatalf("PushSweep: %v", err)
			}
			if resp.Quarantined != tc.quarantined {
				t.Fatalf("quarantined = %v, want %v (%+v)", resp.Quarantined, tc.quarantined, resp)
			}
			active := count(t, rig, `SELECT count(*) FROM property_listings WHERE is_active`)
			if tc.quarantined {
				if active != 40 {
					t.Errorf("a held delist must leave all 40 active, got %d", active)
				}
				if n := count(t, rig, `SELECT count(*) FROM crawl_ingest_quarantine WHERE reason = 'delists_over_threshold'`); n != 1 {
					t.Errorf("the held delist must be recorded, found %d", n)
				}
			} else {
				if active != 40-tc.absent {
					t.Errorf("the 20 floor passes and delists 20: want %d active, got %d", 40-tc.absent, active)
				}
			}
		})
	}
}

// TestPush_MinDelistIntervalEndToEnd: a second COMPLETE miss within 12 hours does not
// advance delisting, through the real push path.
func TestPush_MinDelistIntervalEndToEnd(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	for _, j := range []string{"job-a", "job-b", "job-c", "job-d"} {
		seedDispatch(t, pool, j, "run-1", "rea")
	}

	mustPush(t, rig, sweepReq("job-a", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("X", 1_000_000), fixedRea("Y", 1_000_000)))

	// First miss of X: counts (missed 1).
	clock.Advance(time.Hour)
	mustPush(t, rig, sweepReq("job-b", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("Y", 1_000_000)))
	if got := missedOf(t, rig, "X"); got != 1 {
		t.Fatalf("after the first miss X must be missed=1, got %d", got)
	}

	// Second miss, 2 hours later: inside 12h, so it does not advance.
	clock.Advance(2 * time.Hour)
	res := mustPush(t, rig, sweepReq("job-c", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("Y", 1_000_000)))
	if res.Delisted != 0 || missedOf(t, rig, "X") != 1 {
		t.Errorf("a miss inside 12h must not advance X: delisted=%d missed=%d", res.Delisted, missedOf(t, rig, "X"))
	}

	// A miss past 12 hours from the first counts and delists at grace 2.
	clock.Advance(12 * time.Hour)
	mustPush(t, rig, sweepReq("job-d", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("Y", 1_000_000)))
	if active := activeOf(t, rig, "X"); active {
		t.Error("a miss past the interval must delist X at grace 2")
	}
}

func missedOf(t *testing.T, r *ingestRig, id string) int {
	t.Helper()
	var n int
	if err := r.pool.QueryRow(context.Background(), `SELECT missed_sweeps FROM property_listings WHERE listing_id = $1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func activeOf(t *testing.T, r *ingestRig, id string) bool {
	t.Helper()
	var a bool
	if err := r.pool.QueryRow(context.Background(), `SELECT is_active FROM property_listings WHERE listing_id = $1`, id).Scan(&a); err != nil {
		t.Fatal(err)
	}
	return a
}

// TestPush_RateLimitAt121: 120 pushes an hour per rig are served. The 121st is
// ResourceExhausted with a retry hint.
func TestPush_RateLimitAt121(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	req.DryRun = true // a dry run writes nothing, so 120 of them are cheap and identical
	for i := 1; i <= 120; i++ {
		if _, err := rig.push(t, req); err != nil {
			t.Fatalf("push %d of 120 must be served: %v", i, err)
		}
	}
	_, err := rig.push(t, req)
	wantCode(t, err, connect.CodeResourceExhausted)
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Meta().Get("Retry-After") == "" {
		t.Errorf("the 121st push must carry a Retry-After hint, got %v", err)
	}
}

// TestPush_ContractTooOldIsFailedPrecondition is the contract floor.
func TestPush_ContractTooOldIsFailedPrecondition(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	req := sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, fixedRea("A", 1_000_000))
	req.ContractVersion = 0
	_, err := rig.push(t, req)
	wantCode(t, err, connect.CodeFailedPrecondition)
	if !strings.Contains(err.Error(), "contract_too_old") {
		t.Errorf("want the contract_too_old reason, got %v", err)
	}
}

// TestPush_OversizeSweepIsInvalidArgument: 2,001 listings is refused whole.
func TestPush_OversizeSweepIsInvalidArgument(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	var listings []*pb.Listing
	for i := 0; i < MaxListingsPerSweep+1; i++ {
		listings = append(listings, fixedRea(fmt.Sprintf("L%05d", i), 1_000_000))
	}
	_, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, listings...))
	wantCode(t, err, connect.CodeInvalidArgument)
	if n := count(t, rig, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("a refused sweep must write nothing, found %d", n)
	}
}

// TestPush_BodyOverFourMiBIsRefused: the read limit refuses the body before decode.
func TestPush_BodyOverFourMiBIsRefused(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)
	seedDispatch(t, pool, "job-1", "run-1", "rea")

	huge := fixedRea("A", 1_000_000)
	huge.ListingUrl = strings.Repeat("x", 5<<20)
	_, err := rig.push(t, sweepReq("job-1", 1, pb.Source_SOURCE_REA, pb.SweepStatus_SWEEP_STATUS_COMPLETE, huge))
	if err == nil {
		t.Fatal("a body over 4 MiB must be refused")
	}
	if code := connect.CodeOf(err); code != connect.CodeResourceExhausted && code != connect.CodeInvalidArgument {
		t.Errorf("an oversize body is refused as ResourceExhausted or InvalidArgument, got %v", code)
	}
}

// TestReportCycle_RecordsTheRigsRow: the cycle lands on crawl_run_status under the rig
// subject, with the outcome mapped onto the table's vocabulary.
func TestReportCycle_RecordsTheRigsRow(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)
	seedRig(t, pool, testRig, true)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	_, err := rig.client().ReportCycle(context.Background(), withToken(connect.NewRequest(&pb.ReportCycleRequest{
		CycleId:  "cycle-1",
		Outcome:  "rewarm",
		ExitCode: 3,
		Counts:   &pb.CycleCounts{SuburbsSelected: 4, SuburbsDone: 1, ListingsTouched: 9, EventsWritten: 2},
	}), token))
	if err != nil {
		t.Fatalf("ReportCycle: %v", err)
	}
	var status, runID string
	var rewarm bool
	var listings int
	if err := pool.QueryRow(context.Background(), `
		SELECT status, run_id, rewarm_needed, listings_touched FROM crawl_run_status
		WHERE run_type = 'agent' AND host = $1`, testRig).
		Scan(&status, &runID, &rewarm, &listings); err != nil {
		t.Fatalf("the cycle row: %v", err)
	}
	if status != "rewarm" || runID != "cycle-1" || !rewarm || listings != 9 {
		t.Errorf("cycle row = status %q run %q rewarm %v listings %d", status, runID, rewarm, listings)
	}
}

// TestHealth_ReportsReadinessWithoutSecrets: Health exposes the verifier's status and
// nothing a credential could be built from.
func TestHealth_ReportsReadinessWithoutSecrets(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	rig := startIngest(t, pool, issuer, clock, nil)

	h := rig.svc.Health()
	if h["enabled"] != true || h["ready"] != true {
		t.Fatalf("a loaded service reports enabled and ready, got %v", h)
	}
	v, ok := h["verifier"].(map[string]any)
	if !ok || v["key_count"] != 1 {
		t.Fatalf("the verifier's key count is reported, got %v", h["verifier"])
	}
	for k := range h {
		if strings.Contains(strings.ToLower(k), "secret") || strings.Contains(strings.ToLower(k), "token") {
			t.Errorf("health exposes %q", k)
		}
	}
}

// TestMisconfiguredServiceRefusesEverything: an enabled service with a config
// problem is mounted and answers Unavailable, even to a valid credential.
func TestMisconfiguredServiceRefusesEverything(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	seedRig(t, pool, testRig, true)

	svc := New(context.Background(), Options{
		Config:        Config{Enabled: true, Issuer: issuer.issuer, Audience: testAudience},
		ConfigProblem: "HOUSING_INGEST_ORG is required",
		Pool:          pool,
		Now:           clock.Now,
		HTTPClient:    issuer.client,
	})
	path, h := svc.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	client := housingingestv1connect.NewCrawlIngestServiceClient(http.DefaultClient, srv.URL)
	_, err := client.ProbeAuth(context.Background(), withToken(connect.NewRequest(&pb.ProbeAuthRequest{}), token))
	wantCode(t, err, connect.CodeUnavailable)
	if !strings.Contains(err.Error(), msgMisconfigured) {
		t.Errorf("want the ingest_unavailable category, got %v", err)
	}
}
