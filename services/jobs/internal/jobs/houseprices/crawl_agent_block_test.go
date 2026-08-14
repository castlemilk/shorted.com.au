package houseprices

import "testing"

// TestBlockTracker_SameSuburbRetryDoesNotDegrade is the regression for the
// observed full-pass killer: a failed job re-pends immediately and claim hands
// the SAME suburb straight back, so the old naive counter read one pathological
// target as two consecutive blocks and stopped a healthy run. Hinchinbrook/rea
// blocked twice 41s apart and ended a drain that had just crawled 6 suburbs
// cleanly, leaving 300 healthy pending jobs untouched.
func TestBlockTracker_SameSuburbRetryDoesNotDegrade(t *testing.T) {
	b := newBlockTracker(2)

	degraded, same := b.record("Hinchinbrook", true)
	if degraded {
		t.Fatalf("a single blocked suburb must not degrade the session")
	}
	if same {
		t.Fatalf("first block of a suburb is not a same-suburb retry")
	}

	degraded, same = b.record("Hinchinbrook", true)
	if degraded {
		t.Fatalf("the SAME suburb blocking again is a bad target, not a cold session — must not degrade")
	}
	if !same {
		t.Fatalf("expected the re-served suburb to be reported as a same-suburb retry")
	}

	// However many times the queue re-serves it, it must never take the run down.
	for i := range 5 {
		if degraded, _ = b.record("Hinchinbrook", true); degraded {
			t.Fatalf("repeat %d of the same bad target degraded the session", i)
		}
	}
}

// TestBlockTracker_DistinctSuburbsDegrade keeps the behaviour the breaker exists
// for: genuinely cold sessions block across different suburbs (observed live as
// New Farm then Toowong once the session throttled).
func TestBlockTracker_DistinctSuburbsDegrade(t *testing.T) {
	b := newBlockTracker(2)

	if degraded, _ := b.record("New Farm", true); degraded {
		t.Fatalf("one blocked suburb is not yet a degraded session")
	}
	degraded, same := b.record("Toowong", true)
	if !degraded {
		t.Fatalf("two DISTINCT suburbs blocking back to back must degrade the session")
	}
	if same {
		t.Fatalf("a different suburb is not a same-suburb retry")
	}
}

// TestBlockTracker_SuccessResets proves a good sweep clears the run of blocks —
// scattered bad targets across a long full-catalog pass must not accumulate into
// a false "session degraded".
func TestBlockTracker_SuccessResets(t *testing.T) {
	b := newBlockTracker(2)

	b.record("Hinchinbrook", true)
	if degraded, _ := b.record("Glebe", false); degraded {
		t.Fatalf("a successful sweep must never degrade the session")
	}
	// Fresh block after a success starts the count over, so this lone failure
	// must not trip the breaker.
	if degraded, _ := b.record("Lane Cove North", true); degraded {
		t.Fatalf("success must reset the consecutive-block count")
	}

	// And the same-suburb guard must survive the reset rather than latching.
	if _, same := b.record("Lane Cove North", true); !same {
		t.Fatalf("expected same-suburb retry to be tracked after a reset")
	}
}

// TestBlockTracker_TripIsConfigurable covers CRAWL_AGENT_BLOCK_TRIP being raised
// for a long pass where isolated bad targets are expected.
func TestBlockTracker_TripIsConfigurable(t *testing.T) {
	b := newBlockTracker(3)

	if degraded, _ := b.record("A", true); degraded {
		t.Fatalf("1 block must not trip a threshold of 3")
	}
	if degraded, _ := b.record("B", true); degraded {
		t.Fatalf("2 blocks must not trip a threshold of 3")
	}
	if degraded, _ := b.record("C", true); !degraded {
		t.Fatalf("3 distinct blocked suburbs must trip a threshold of 3")
	}

	// A nonsensical threshold must not disable the breaker entirely.
	if degraded, _ := newBlockTracker(0).record("A", true); !degraded {
		t.Fatalf("a sub-1 threshold must clamp to 1, not disable the breaker")
	}
}
