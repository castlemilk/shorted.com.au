package housingingest

import (
	"reflect"
	"testing"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

func f64(v float64) *float64 { return &v }
func i16(v int16) *int16     { return &v }
func i32(v int32) *int32     { return &v }

// fullListing sets every field the wire carries, so a dropped field fails the round trip.
// AddressKey is left empty: the server re-derives it, so a round trip clears it on purpose.
func fullListing() housingcrawl.RawListing {
	return housingcrawl.RawListing{
		Source:       "domain",
		ListingID:    "L-42",
		ListingURL:   "https://example.test/listing/42",
		DisplayAddr:  "1 Example St, Bondi NSW 2026",
		Suburb:       "Bondi",
		State:        "NSW",
		Postcode:     "2026",
		Lat:          f64(-33.89),
		Lng:          f64(151.27),
		PropertyType: "apartment",
		Bedrooms:     i16(2),
		Bathrooms:    i16(1),
		CarSpaces:    i16(1),
		LandSizeSqm:  f64(0),
		PriceDisplay: "Offers over $1.2m",
		PriceLow:     f64(1_200_000),
		PriceHigh:    f64(1_300_000),
		PriceKind:    "offers_over",
		Status:       "for_sale",
		AgencyID:     "ag-1",
		AgencyName:   "An Agency",
		AgentNames:   []string{"A. Agent", "B. Agent"},
	}
}

// TestRoundTrip_ToRawInvertsFromRaw is the proof that the rig's mapping and the server's
// mapping are inverses: a listing that goes to the wire and back is the same listing.
func TestRoundTrip_ToRawInvertsFromRaw(t *testing.T) {
	in := []housingcrawl.RawListing{fullListing(), {Source: "rea", ListingID: "bare"}}
	out := ToRawListings(FromRawListings(in))
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round trip changed the listings:\n in=%+v\nout=%+v", in, out)
	}
}

// TestRoundTrip_AddressKeyIsNeverTrusted: the rig may stamp an address key, the wire
// carries it, and the server's mapping drops it, so the server re-derives it.
func TestRoundTrip_AddressKeyIsNeverTrusted(t *testing.T) {
	in := fullListing()
	in.AddressKey = "rig-stamped-key"
	wire := FromRawListings([]housingcrawl.RawListing{in})
	if wire[0].GetAddressKey() != "rig-stamped-key" {
		t.Fatalf("the wire did not carry the rig's address key")
	}
	if got := ToRawListings(wire)[0].AddressKey; got != "" {
		t.Fatalf("the server kept a wire address key %q; it must re-derive it", got)
	}
}

// TestEnumsRoundTrip: source and status map both ways, and an unknown status is Blocked.
func TestEnumsRoundTrip(t *testing.T) {
	for _, name := range []string{"rea", "domain"} {
		if got := SourceName(SourceEnum(name)); got != name {
			t.Errorf("SourceName(SourceEnum(%q)) = %q", name, got)
		}
	}
	if SourceName(pb.Source_SOURCE_UNSPECIFIED) != "" || SourceEnum("both") != pb.Source_SOURCE_UNSPECIFIED {
		t.Error("an unknown source must map to nothing")
	}
	for _, s := range []housingcrawl.SweepStatus{housingcrawl.Complete, housingcrawl.Partial, housingcrawl.Blocked} {
		if got := StatusLib(StatusEnum(s)); got != s {
			t.Errorf("StatusLib(StatusEnum(%v)) = %v", s, got)
		}
	}
	if StatusLib(pb.SweepStatus_SWEEP_STATUS_UNSPECIFIED) != housingcrawl.Blocked {
		t.Error("an unspecified status must read as Blocked, the status that writes nothing")
	}
}

// TestCountPointers keeps the narrowing exact for every value the sanitiser allows and
// keeps nil as nil.
func TestCountPointers(t *testing.T) {
	if Int16Ptr(nil) != nil || Int32Ptr(nil) != nil {
		t.Fatal("a nil count must stay nil")
	}
	if got := Int16Ptr(i32(100)); got == nil || *got != 100 {
		t.Fatalf("Int16Ptr(100) = %v", got)
	}
	if got := Int32Ptr(i16(7)); got == nil || *got != 7 {
		t.Fatalf("Int32Ptr(7) = %v", got)
	}
}
