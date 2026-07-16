package main

import (
	"testing"
	"time"
)

func TestCircuitBreaker_OpensAfterTripConsecutiveBlocks(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(2, 5*time.Minute, 60*time.Minute)

	// First block: below trip (2) — must NOT open, must NOT skip.
	if opened, _ := cb.record("domain", true, base); opened {
		t.Fatal("1st block should not open the circuit (trip=2)")
	}
	if open, _ := cb.skip("domain", base); open {
		t.Fatal("circuit should still be closed after 1 block")
	}
	// Second consecutive block: trips.
	opened, cd := cb.record("domain", true, base)
	if !opened {
		t.Fatal("2nd consecutive block should open the circuit")
	}
	if cd < 4*time.Minute || cd > 6*time.Minute { // 5m ±20%
		t.Fatalf("first cooldown should be ~base (5m ±20%%), got %s", cd)
	}
	if open, rem := cb.skip("domain", base); !open || rem <= 0 {
		t.Fatalf("circuit should be OPEN with positive remaining, got open=%v rem=%s", open, rem)
	}
}

func TestCircuitBreaker_ExponentialBackoffDoublesAndCaps(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(1, 1*time.Minute, 4*time.Minute) // trip=1 opens on every block; cap 4m

	now := base
	// Each block re-opens with double the previous backoff (1,2,4,4 — capped).
	wantMins := []float64{1, 2, 4, 4}
	for i, want := range wantMins {
		opened, cd := cb.record("domain", true, now)
		if !opened {
			t.Fatalf("block %d should open (trip=1)", i)
		}
		lo := time.Duration(want*0.8*60) * time.Second
		hi := time.Duration(want*1.2*60) * time.Second
		if cd < lo || cd > hi {
			t.Fatalf("re-open %d: want ~%.0fm (±20%%), got %s", i, want, cd)
		}
		now = now.Add(cd + time.Second) // advance past the cooldown for the next probe
	}
}

func TestCircuitBreaker_CleanSweepClosesAndResets(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(1, 5*time.Minute, 60*time.Minute)

	// Open it, widen it once.
	cb.record("domain", true, base)
	_, cd1 := cb.record("domain", true, base.Add(10*time.Minute))
	if cd1 < 9*time.Minute { // should have doubled to ~10m
		t.Fatalf("expected backoff to have doubled to ~10m, got %s", cd1)
	}
	// A clean sweep closes it and resets the backoff to base.
	cb.record("domain", false, base.Add(30*time.Minute))
	if open, _ := cb.skip("domain", base.Add(30*time.Minute)); open {
		t.Fatal("clean sweep should close the circuit")
	}
	_, cd2 := cb.record("domain", true, base.Add(31*time.Minute))
	if cd2 > 6*time.Minute { // back to base (~5m), not the widened value
		t.Fatalf("backoff should reset to base after a clean sweep, got %s", cd2)
	}
}

func TestCircuitBreaker_PerSourceIndependence(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(2, 5*time.Minute, 60*time.Minute)

	// Domain blocks repeatedly (Akamai), REA stays healthy — the observed case.
	cb.record("domain", true, base)
	cb.record("domain", true, base) // opens domain
	cb.record("rea", false, base)   // rea clean

	if open, _ := cb.skip("domain", base); !open {
		t.Fatal("domain circuit should be open")
	}
	if open, _ := cb.skip("rea", base); open {
		t.Fatal("rea circuit must stay closed — healthy source keeps crawling")
	}
	if allOpen, _ := cb.allOpen([]string{"rea", "domain"}, base); allOpen {
		t.Fatal("allOpen must be false while rea is healthy (crawl continues on rea)")
	}
}

func TestCircuitBreaker_AllOpenWhenEverySourceBlocked(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(1, 5*time.Minute, 60*time.Minute)
	cb.record("rea", true, base)
	cb.record("domain", true, base)
	allOpen, rem := cb.allOpen([]string{"rea", "domain"}, base)
	if !allOpen || rem <= 0 {
		t.Fatalf("both sources blocked ⇒ allOpen with positive remaining, got open=%v rem=%s", allOpen, rem)
	}
}

func TestCircuitBreaker_HalfOpenProbeAfterCooldown(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	cb := newCircuitBreaker(1, 5*time.Minute, 60*time.Minute)
	_, cd := cb.record("domain", true, base)
	// Before cooldown: skip.
	if open, _ := cb.skip("domain", base.Add(cd-time.Minute)); !open {
		t.Fatal("should skip while within cooldown")
	}
	// After cooldown: half-open (a probe is allowed).
	if open, _ := cb.skip("domain", base.Add(cd+time.Second)); open {
		t.Fatal("after the cooldown the source should be probeable (half-open)")
	}
}
