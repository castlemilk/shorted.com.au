package housingcrawl

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests for the ingest additions to ApplySweep: the guard, the receipt
// stamp and the MinDelistInterval gate. They run against the same throwaway
// Postgres and skip the same way as apply_integration_test.go.

var errGuardRefused = errors.New("guard refused the sweep")

// seedLastSeen sets a seeded listing's last_seen_at, so a test's timeline is consistent.
func seedLastSeen(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, at time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE property_listings SET last_seen_at = $2 WHERE listing_id = $1`, id, at); err != nil {
		t.Fatalf("seed last_seen_at for %s: %v", id, err)
	}
}

// TestGuard_RefusalRollsBackEveryWrite proves a guard error is raised before the
// commit: the new listing, the price move and the delist are all undone.
func TestGuard_RefusalRollsBackEveryWrite_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "X", 1) // one prior absence: a COMPLETE miss delists it

	var seen Result
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("N", 1_200_000)},
		Guard: func(r Result) error {
			seen = r
			return errGuardRefused
		},
	})
	if !errors.Is(err, errGuardRefused) {
		t.Fatalf("ApplySweep must return the guard error, got %v", err)
	}
	// The guard saw the diff it would have committed.
	if seen.Upserted != 1 || seen.NewListings != 1 || seen.Delisted != 1 {
		t.Errorf("guard saw Upserted=%d NewListings=%d Delisted=%d, want 1/1/1", seen.Upserted, seen.NewListings, seen.Delisted)
	}
	if res.Delisted != 1 {
		t.Errorf("the returned Result must carry the counts the sweep would have committed, got Delisted=%d", res.Delisted)
	}
	// Nothing persisted: N was never inserted and X was not delisted.
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='N'`); n != 0 {
		t.Errorf("a refused sweep must insert nothing, found %d row(s) for N", n)
	}
	if active, missed := listingActive(t, ctx, pool, "X"); !active || missed != 1 {
		t.Errorf("a refused sweep must leave X untouched, got active=%v missed=%d", active, missed)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events`); n != 0 {
		t.Errorf("a refused sweep must write no events, found %d", n)
	}
}

// TestGuard_NilIsTodaysBehaviour proves a nil guard changes nothing: the same
// sweep commits, and the guard-only counts stay zero.
func TestGuard_NilIsTodaysBehaviour_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000)},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if res.Upserted != 1 || res.Events != 1 {
		t.Errorf("want Upserted=1 Events=1, got %+v", res)
	}
	if res.ActiveBefore != 0 {
		t.Errorf("ActiveBefore is counted only for a guarded sweep, got %d", res.ActiveBefore)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='A'`); n != 1 {
		t.Errorf("the sweep must commit without a guard, found %d row(s)", n)
	}
}

// TestGuard_CountsCarryWhatQuarantineNeeds pins the Result fields the quarantine
// reads: existing listings, large moves (over 10%, sold and incomparable kinds
// excluded) and the active baseline before the sweep.
func TestGuard_CountsCarryWhatQuarantineNeeds_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "P1", 0) // stored at 1,000,000
	seedActive(t, ctx, pool, "P2", 0) // stored at 1,000,000
	seedActive(t, ctx, pool, "P3", 0) // stored at 1,000,000
	seedActive(t, ctx, pool, "GONE", 0)

	var seen Result
	_, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Partial, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{
			fixedListing("P1", 1_200_000), // +20%: a large move
			fixedListing("P2", 1_050_000), // +5%: not large
			fixedListing("P3", 1_100_000), // exactly +10%: not large (strictly more than 10%)
		},
		Guard: func(r Result) error {
			seen = r
			return nil
		},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if seen.Existing != 3 {
		t.Errorf("Existing = %d, want 3 (P1, P2, P3 already had snapshots)", seen.Existing)
	}
	if seen.LargeMoves != 1 {
		t.Errorf("LargeMoves = %d, want 1 (only P1 moved more than 10%%)", seen.LargeMoves)
	}
	if seen.ActiveBefore != 4 {
		t.Errorf("ActiveBefore = %d, want 4 (the region's actives before the sweep)", seen.ActiveBefore)
	}
	if seen.Delisted != 0 {
		t.Errorf("a PARTIAL sweep delists nothing, got Delisted=%d", seen.Delisted)
	}
}

// TestReceiptKey_StampsEveryRowAndEvent proves an ingest sweep stamps its receipt
// on the listings it upserts and the events it inserts, and that a collector sweep
// (no receipt) writes NULL there.
func TestReceiptKey_StampsEveryRowAndEvent_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "S", 0) // stored at 1,000,000

	_, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		ReceiptKey: "job-9:1:rea",
		Listings: []RawListing{
			fixedListing("S", 1_000_000), // unchanged: upserted, no event
			fixedListing("N", 1_200_000), // new: first_seen event
		},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	for _, id := range []string{"S", "N"} {
		var key *string
		if err := pool.QueryRow(ctx, `SELECT ingest_receipt_key FROM property_listings WHERE listing_id=$1`, id).Scan(&key); err != nil {
			t.Fatalf("load %s: %v", id, err)
		}
		if key == nil || *key != "job-9:1:rea" {
			t.Errorf("listing %s receipt = %v, want job-9:1:rea", id, key)
		}
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events WHERE ingest_receipt_key = 'job-9:1:rea'`); n < 1 {
		t.Errorf("events inserted by an ingest sweep must carry the receipt, found %d stamped", n)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events WHERE ingest_receipt_key IS NULL`); n != 0 {
		t.Errorf("every event of a receipted sweep must be stamped, found %d NULL", n)
	}
}

// TestReceiptKey_CollectorWritesNullAndKeepsAPriorStamp proves a collector sweep
// (no receipt) leaves the columns NULL, and a sighting by it does not wipe the
// stamp an earlier ingest left on the row.
func TestReceiptKey_CollectorWritesNullAndKeepsAPriorStamp_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	rules := testRules()
	runTs := time.Now().UTC()

	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: runTs, Rules: rules,
		ReceiptKey: "job-1:1:rea", Listings: []RawListing{fixedListing("A", 1_000_000)},
	}); err != nil {
		t.Fatalf("ingest sweep: %v", err)
	}
	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: runTs.Add(time.Hour), Rules: rules,
		Listings: []RawListing{fixedListing("A", 1_000_000)},
	}); err != nil {
		t.Fatalf("collector sweep: %v", err)
	}
	var key *string
	if err := pool.QueryRow(ctx, `SELECT ingest_receipt_key FROM property_listings WHERE listing_id='A'`).Scan(&key); err != nil {
		t.Fatalf("load A: %v", err)
	}
	if key == nil || *key != "job-1:1:rea" {
		t.Errorf("a collector sighting must keep the ingest stamp, got %v", key)
	}

	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: runTs.Add(2 * time.Hour), Rules: rules,
		Listings: []RawListing{fixedListing("C", 1_000_000)},
	}); err != nil {
		t.Fatalf("collector sweep for C: %v", err)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='C' AND ingest_receipt_key IS NULL`); n != 1 {
		t.Errorf("a collector-written row must have a NULL receipt, found %d", n)
	}
}

// TestMinDelistInterval_ZeroIsTodaysBehaviour proves zero keeps the collector's
// rule: every COMPLETE miss counts, so two misses in a row delist at grace 2.
func TestMinDelistInterval_ZeroIsTodaysBehaviour_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	start := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	seedActive(t, ctx, pool, "X", 0)

	complete := func(at time.Time) Result {
		t.Helper()
		res, err := ApplySweep(ctx, pool, Sweep{
			Target: applyTarget, Source: "rea", Status: Complete, RunTS: at, Rules: testRules(),
		})
		if err != nil {
			t.Fatalf("ApplySweep at %v: %v", at, err)
		}
		return res
	}
	complete(start)
	if active, missed := listingActive(t, ctx, pool, "X"); !active || missed != 1 {
		t.Fatalf("after one miss want active missed=1, got active=%v missed=%d", active, missed)
	}
	// One hour later: with no interval, this is a second counted miss, and it delists.
	if res := complete(start.Add(time.Hour)); res.Delisted != 1 {
		t.Fatalf("with MinDelistInterval=0 the second miss must delist, got Delisted=%d", res.Delisted)
	}
}

// TestMinDelistInterval_SecondMissWithin12hDoesNotAdvance is the owner's rule: a
// re-swept job cannot speed up delisting. A second COMPLETE miss inside 12 hours
// leaves missed_sweeps and the listing alone; a miss after 12 hours counts.
func TestMinDelistInterval_SecondMissWithin12hDoesNotAdvance_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	start := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	seedActive(t, ctx, pool, "X", 0)
	// The clock gate compares last_seen_at with last_missed_at, so the seed must sit on
	// the sweep timeline, as a real sighting does, not on the wall clock.
	seedLastSeen(t, ctx, pool, "X", start.Add(-time.Hour))

	rules := testRules()
	rules.MinDelistInterval = 12 * time.Hour
	complete := func(at time.Time) Result {
		t.Helper()
		res, err := ApplySweep(ctx, pool, Sweep{
			Target: applyTarget, Source: "rea", Status: Complete, RunTS: at, Rules: rules,
		})
		if err != nil {
			t.Fatalf("ApplySweep at %v: %v", at, err)
		}
		return res
	}

	complete(start) // the first miss counts: missed 1
	if active, missed := listingActive(t, ctx, pool, "X"); !active || missed != 1 {
		t.Fatalf("after the first miss want active missed=1, got active=%v missed=%d", active, missed)
	}

	// A second COMPLETE miss inside the interval: nothing advances, nothing delists.
	if res := complete(start.Add(time.Hour)); res.Delisted != 0 {
		t.Errorf("a miss inside the interval must not delist, got Delisted=%d", res.Delisted)
	}
	if active, missed := listingActive(t, ctx, pool, "X"); !active || missed != 1 {
		t.Errorf("a miss inside the interval must not advance missed_sweeps, got active=%v missed=%d", active, missed)
	}

	// Still inside, at 11h59m: still no advance.
	complete(start.Add(11*time.Hour + 59*time.Minute))
	if _, missed := listingActive(t, ctx, pool, "X"); missed != 1 {
		t.Errorf("at 11h59m the listing must still not advance, got missed=%d", missed)
	}

	// Past the interval, the next miss counts and delists at grace 2.
	if res := complete(start.Add(13 * time.Hour)); res.Delisted != 1 {
		t.Errorf("a miss after the interval must count and delist, got Delisted=%d", res.Delisted)
	}
}

// TestMinDelistInterval_ResightClearsTheClock proves a sighting resets the absence
// clock, so the next miss after a sighting counts at once.
func TestMinDelistInterval_ResightClearsTheClock_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	start := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	seedActive(t, ctx, pool, "X", 0)
	seedLastSeen(t, ctx, pool, "X", start.Add(-time.Hour))

	rules := testRules()
	rules.MinDelistInterval = 12 * time.Hour
	sweep := func(at time.Time, listings ...RawListing) {
		t.Helper()
		if _, err := ApplySweep(ctx, pool, Sweep{
			Target: applyTarget, Source: "rea", Status: Complete, RunTS: at, Rules: rules, Listings: listings,
		}); err != nil {
			t.Fatalf("ApplySweep at %v: %v", at, err)
		}
	}
	sweep(start)                                              // missed 1, clock at start
	sweep(start.Add(time.Hour), fixedListing("X", 1_000_000)) // seen again: missed 0, clock cleared
	sweep(start.Add(2 * time.Hour))                           // a miss one hour after the sighting: counts
	if _, missed := listingActive(t, ctx, pool, "X"); missed != 1 {
		t.Errorf("a miss after a sighting must count at once, got missed=%d", missed)
	}
}

// TestMinDelistInterval_IsValidatedNonNegative proves a negative interval is an
// invalid sweep, refused before any transaction.
func TestMinDelistInterval_NegativeIsInvalid(t *testing.T) {
	err := validateSweep(Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now(),
		Rules: Config{DelistGrace: 2, NoiseAbs: 5000, NoisePct: 0.005, MinDelistInterval: -time.Second},
	})
	if err == nil || !strings.Contains(err.Error(), "MinDelistInterval") {
		t.Fatalf("a negative MinDelistInterval must be invalid, got %v", err)
	}
	if !errors.Is(err, ErrInvalidSweep) {
		t.Errorf("the error must wrap ErrInvalidSweep, got %v", err)
	}
}
