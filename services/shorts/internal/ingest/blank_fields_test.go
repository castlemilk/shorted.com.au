package ingest

import (
	"testing"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
)

// The rig blanks a listing's over-cap URL, state, suburb and postcode rather than dropping
// the listing. The server must accept that listing: the wire validator takes a blank of
// each, and the gate still matches it on the postcode it kept.
func TestBlankedNonIdentityFieldsAreAcceptedByTheServer(t *testing.T) {
	msg := &pb.PushSweepRequest{
		IdempotencyKey:  "job-b:1:domain",
		JobId:           "job-b",
		Attempt:         1,
		Target:          &pb.Target{Suburb: "Bondi", State: "NSW", Postcode: "2026"},
		Source:          pb.Source_SOURCE_DOMAIN,
		Status:          pb.SweepStatus_SWEEP_STATUS_COMPLETE,
		Pages:           1,
		ContractVersion: 1,
		Listings: []*pb.Listing{{
			Source: "domain", ListingId: "L1", Status: "for_sale", PriceKind: "fixed",
			Postcode: "2026", // URL, state and suburb blank, as the rig sends them
		}},
	}
	if err := validateEnvelope(msg, 1); err != nil {
		t.Fatalf("the wire validator refused a blanked listing: %v", err)
	}
	target := housingcrawl.Target{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW"}
	gated, poisoned := gateSweep(housingingest.ToRawListings(msg.Listings), target)
	if gated != 1 || poisoned {
		t.Fatalf("gate: gated=%d poisoned=%v, want the listing kept on its postcode", gated, poisoned)
	}
}
