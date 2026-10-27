package housingcrawl

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The Begin hook: it runs first in the sweep's transaction, a false return applies
// nothing, and an error rolls back.

// TestBegin_RunsBeforeAnyWrite: when Begin runs, the region holds no listing from this
// sweep yet. It is the first statement, so a lock or a read it takes is taken first.
func TestBegin_RunsBeforeAnyWrite_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	var seen int
	_, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_000_000)},
		Begin: func(ctx context.Context, tx pgx.Tx) (bool, error) {
			// Read on tx, never the pool: the hook must not hold one connection while it takes
			// another.
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM property_listings`).Scan(&seen); err != nil {
				return false, err
			}
			return true, nil
		},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if seen != 0 {
		t.Errorf("Begin must run before the sweep writes, but %d listing(s) already existed", seen)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='A'`); n != 1 {
		t.Errorf("a proceeding Begin must let the sweep apply, got %d row(s)", n)
	}
}

// TestBegin_FalseAppliesNothing: a Begin that returns false (a replay) makes ApplySweep
// return a zero Result and no error, and nothing is written, not even the region.
func TestBegin_FalseAppliesNothing_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_000_000)},
		Begin: func(context.Context, pgx.Tx) (bool, error) {
			return false, nil
		},
	})
	if err != nil {
		t.Fatalf("a refused Begin is not an error: %v", err)
	}
	if res.Upserted != 0 || res.Events != 0 {
		t.Errorf("a false Begin reports a zero Result, got %+v", res)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("a false Begin must write no listing, found %d", n)
	}
}

// TestBegin_ErrorRollsBack: a Begin error is returned as is, and rolls back whatever
// the sweep had already written. Begin runs first, so nothing is written yet; this
// pins that the error path does not commit.
func TestBegin_ErrorRollsBack_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	sentinel := errors.New("begin refused")
	_, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_000_000)},
		Begin: func(context.Context, pgx.Tx) (bool, error) {
			return false, sentinel
		},
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("the Begin error must be returned, got %v", err)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("a failed Begin must write nothing, found %d", n)
	}
}

// TestBlockedWithRecordStillRecords: a BLOCKED sweep with a Record hook runs the hook,
// so the caller's receipt is written, while no listing is touched.
func TestBlockedWithRecordStillRecords_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	recorded := false
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Blocked, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_000_000)},
		Record: func(context.Context, pgx.Tx, Result) error {
			recorded = true
			return nil
		},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if !recorded {
		t.Error("the Record hook must run for a BLOCKED sweep")
	}
	if res.Applied != Blocked || res.Upserted != 0 {
		t.Errorf("a BLOCKED sweep writes no listing, got %+v", res)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings`); n != 0 {
		t.Errorf("BLOCKED must write no listing, found %d", n)
	}
}
