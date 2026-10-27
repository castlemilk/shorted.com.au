package housingcrawl

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

// validSweep is a sweep every rule accepts. Each rule test breaks exactly one field.
func validSweep() Sweep {
	return Sweep{
		Target:   Target{Suburb: "testville", Display: "Testville", Postcode: "3000", State: "VIC"},
		Source:   "rea",
		Status:   Complete,
		RunTS:    time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC),
		Rules:    testRules(),
		Listings: []RawListing{{Source: "rea", ListingID: "A", Postcode: "3000", Suburb: "Testville"}},
	}
}

// The validation tests pass a nil pool. A sweep that gets past validateSweep would
// reach pool.Begin and panic, so these tests also prove that an invalid sweep never
// opens a transaction.
func TestApplySweep_RejectsInvalidInputBeforeAnyWrite(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Sweep)
	}{
		{"zero DelistGrace (delists on the first miss)", func(s *Sweep) { s.Rules.DelistGrace = 0 }},
		{"negative DelistGrace", func(s *Sweep) { s.Rules.DelistGrace = -1 }},
		{"empty Config{} (zero noise: $0 drops on every re-crawl)", func(s *Sweep) { s.Rules = Config{DelistGrace: 2} }},
		{"zero NoiseAbs", func(s *Sweep) { s.Rules.NoiseAbs = 0 }},
		{"negative NoiseAbs", func(s *Sweep) { s.Rules.NoiseAbs = -5000 }},
		{"NaN NoiseAbs", func(s *Sweep) { s.Rules.NoiseAbs = math.NaN() }},
		{"zero NoisePct", func(s *Sweep) { s.Rules.NoisePct = 0 }},
		{"NaN NoisePct", func(s *Sweep) { s.Rules.NoisePct = math.NaN() }},
		{"unknown status", func(s *Sweep) { s.Status = "COMPLETED" }},
		{"empty status", func(s *Sweep) { s.Status = "" }},
		{"zero RunTS", func(s *Sweep) { s.RunTS = time.Time{} }},
		{"listing from another source", func(s *Sweep) {
			s.Listings = append(s.Listings, RawListing{Source: "domain", ListingID: "B", Postcode: "3000", Suburb: "Testville"})
		}},
		{"listing with no source against a named sweep", func(s *Sweep) {
			s.Listings[0].Source = ""
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sw := validSweep()
			tc.mutate(&sw)
			res, err := ApplySweep(context.Background(), nil, sw)
			if !errors.Is(err, ErrInvalidSweep) {
				t.Fatalf("want ErrInvalidSweep, got %v", err)
			}
			if res != (Result{}) {
				t.Errorf("a refused sweep must report an empty Result, got %+v", res)
			}
		})
	}
}

// A malformed sweep is refused whatever its status, so a BLOCKED sweep with a bad
// config is also an error rather than a silent no-op.
func TestApplySweep_RejectsInvalidInputEvenWhenBlocked(t *testing.T) {
	sw := validSweep()
	sw.Status = Blocked
	sw.Rules = Config{}
	if _, err := ApplySweep(context.Background(), nil, sw); !errors.Is(err, ErrInvalidSweep) {
		t.Fatalf("blocked sweep with empty Config: want ErrInvalidSweep, got %v", err)
	}
}

// Every rule accepts the valid sweep, and each status is accepted. This is the
// collector's shape: a Config from loadListingsConfig, a named source, a run time.
func TestValidateSweep_AcceptsWellFormedSweeps(t *testing.T) {
	for _, st := range []SweepStatus{Complete, Partial, Blocked} {
		sw := validSweep()
		sw.Status = st
		if err := validateSweep(sw); err != nil {
			t.Errorf("status %s: valid sweep rejected: %v", st, err)
		}
	}
	empty := validSweep()
	empty.Listings = nil // an empty COMPLETE sweep is a legitimate sweep
	if err := validateSweep(empty); err != nil {
		t.Errorf("empty listings rejected: %v", err)
	}
}
