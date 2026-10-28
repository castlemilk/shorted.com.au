package ingest

import (
	"context"
	"testing"
	"time"
)

// The rig gate caches an answer for one minute. A disabled rig is refused once the
// cache is past its TTL, not before: that is the kill switch's latency, and the
// database is not read on every push.
func TestRigGate_TTLIsOneMinute(t *testing.T) {
	pool := ingestTestDB(t)
	clock := newTestClock()
	seedRig(t, pool, testRig, true)
	g := newRigGate(pool, clock.Now)
	ctx := context.Background()

	if on, err := g.enabled(ctx, testRig); err != nil || !on {
		t.Fatalf("enabled rig: on=%v err=%v", on, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE housing_ingest_rigs SET enabled = false WHERE subject = $1`, testRig); err != nil {
		t.Fatal(err)
	}

	clock.Advance(59 * time.Second) // 59s: the cached answer is honoured
	if on, _ := g.enabled(ctx, testRig); !on {
		t.Fatal("the cache was not honoured inside its one-minute TTL")
	}

	clock.Advance(2 * time.Second) // 61s: past the TTL, the database answers
	if on, _ := g.enabled(ctx, testRig); on {
		t.Fatal("a disabled rig still passes after the one-minute TTL")
	}
}

// A subject with no row is not enabled.
func TestRigGate_AbsentRowIsNotEnabled(t *testing.T) {
	pool := ingestTestDB(t)
	g := newRigGate(pool, newTestClock().Now)
	if on, err := g.enabled(context.Background(), "rig:nobody"); err != nil || on {
		t.Fatalf("absent rig: on=%v err=%v", on, err)
	}
}
