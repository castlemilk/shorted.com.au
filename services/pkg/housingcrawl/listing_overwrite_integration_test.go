package housingcrawl

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

// legacyUpsertSHA256 pins the collector's listing upsert (upsertListingSQL) to the bytes
// that ship on origin/main. The collector path must not change with the ingest columns, so
// any edit to that statement fails here.
const legacyUpsertSHA256 = "31e54e4ea5cec412c21a3edd46b853b89741da30fbdf3f94fef8ba4b5b543736"

func TestLegacyUpsertStatementUnchanged(t *testing.T) {
	sum := sha256.Sum256([]byte(upsertListingSQL))
	if got := hex.EncodeToString(sum[:]); got != legacyUpsertSHA256 {
		t.Fatalf("the collector's listing upsert changed (sha256 %s, want %s); it must stay as it ships", got, legacyUpsertSHA256)
	}
}

// Item 1a, against Postgres. A stored listing has its URL and state. An ingest sweep that
// carries blanks for those, and for suburb, must keep the stored values: a blank overwrite
// hides the listing from readers that filter on state_code and listing_url. A real new
// value still overwrites, so the keep-on-blank rule does not freeze the row.
func TestIngestBlankFieldsKeepStoredValues_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)

	// Seed through the collector path (no receipt), so the row has its URL and state.
	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("L1", 1_000_000)},
	}); err != nil {
		t.Fatalf("seed ApplySweep: %v", err)
	}

	// The ingest sweep: URL, state and suburb blank (over-cap on the rig), postcode kept.
	blank := fixedListing("L1", 1_000_000)
	blank.ListingURL, blank.State, blank.Suburb = "", "", ""
	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		ReceiptKey: "job-b:1:rea", Listings: []RawListing{blank},
	}); err != nil {
		t.Fatalf("blank ingest ApplySweep: %v", err)
	}
	var url, state, suburb, postcode, receipt string
	if err := pool.QueryRow(ctx,
		`SELECT listing_url, state_code, suburb, postcode, ingest_receipt_key FROM property_listings WHERE listing_id='L1'`,
	).Scan(&url, &state, &suburb, &postcode, &receipt); err != nil {
		t.Fatalf("load L1: %v", err)
	}
	if url != "http://x/L1" || state != "VIC" || suburb != "Testville" || postcode != "3000" {
		t.Errorf("blank ingest overwrote stored values: url=%q state=%q suburb=%q postcode=%q; want the stored ones", url, state, suburb, postcode)
	}
	if receipt != "job-b:1:rea" {
		t.Errorf("the receipt was not stamped by the blank sweep: %q", receipt)
	}

	// A real new URL still overwrites: the keep-on-blank rule applies to blanks only.
	moved := fixedListing("L1", 1_000_000)
	moved.ListingURL = "http://x/L1-moved"
	if _, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		ReceiptKey: "job-b:2:rea", Listings: []RawListing{moved},
	}); err != nil {
		t.Fatalf("moved ingest ApplySweep: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT listing_url FROM property_listings WHERE listing_id='L1'`).Scan(&url); err != nil {
		t.Fatalf("reload L1: %v", err)
	}
	if url != "http://x/L1-moved" {
		t.Errorf("a real new URL did not overwrite: %q", url)
	}
}
