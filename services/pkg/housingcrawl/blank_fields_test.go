package housingcrawl

import (
	"testing"
	"time"
)

// A listing with a blank URL, state and suburb is a valid sweep: the store's validator
// accepts it, and the listing still matches the target on its postcode. A blank is a miss
// for matching, never an error.
func TestBlankNonIdentityFieldsPassTheStore(t *testing.T) {
	target := Target{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW"}
	l := RawListing{Source: "domain", ListingID: "L1", Postcode: "2026"}
	sw := Sweep{
		Target: target, Source: "domain", Status: Complete, Pages: 1,
		Listings: []RawListing{l}, RunTS: time.Now(),
		Rules: Config{DelistGrace: 2, NoiseAbs: 5000, NoisePct: 0.005},
	}
	if err := validateSweep(sw); err != nil {
		t.Fatalf("the store refused a sweep with blank non-identity fields: %v", err)
	}
	if !MatchesTarget(l, target) {
		t.Fatal("a listing kept on its postcode no longer matches the target")
	}
}
