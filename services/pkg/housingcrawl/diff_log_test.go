package housingcrawl

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Item 4: a listing ID reaches neither the skip log nor a sweep error. The driver's text
// is kept out of the log, because it can carry the value that failed.
func TestSkipLogAndSweepErrorNameNoListing(t *testing.T) {
	const id = "LISTING-SECRET-42"

	pgErr := &pgconn.PgError{Code: "22P02", Message: "invalid input value carrying " + id}
	msg := rowSkipMessage("Bondi", "domain", fmt.Errorf("row write: %w", pgErr))
	if strings.Contains(msg, id) {
		t.Errorf("the skip log names the listing: %q", msg)
	}
	if strings.Contains(msg, "invalid input") {
		t.Errorf("the skip log carries the driver's text: %q", msg)
	}
	if !strings.Contains(msg, "22P02") || !strings.Contains(msg, "Bondi") {
		t.Errorf("the skip log lost the SQLSTATE or the suburb: %q", msg)
	}
	if got := rowErrorCode(fmt.Errorf("no pg error here")); got != "unknown" {
		t.Errorf("a non-Postgres error coded as %q, want unknown", got)
	}

	sw := Sweep{
		Target: Target{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW"},
		Source: "domain", Status: Complete, Pages: 1,
		Listings: []RawListing{{Source: "rea", ListingID: id}},
		RunTS:    time.Now(),
		Rules:    Config{DelistGrace: 2, NoiseAbs: 5000, NoisePct: 0.005},
	}
	err := validateSweep(sw)
	if err == nil {
		t.Fatal("a listing from the wrong source must be refused")
	}
	if strings.Contains(err.Error(), id) {
		t.Errorf("the sweep error names the listing, and it can reach a submit: %v", err)
	}
}
