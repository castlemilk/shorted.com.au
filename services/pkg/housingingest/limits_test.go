package housingingest

import (
	"math"
	"strings"
	"testing"
	"unicode/utf8"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// TestCapsPinTheOldLiterals pins the values the server enforced before the caps moved
// here. The server must keep the same limits with no behaviour change, so a change to
// any of these numbers is a deliberate contract change and must update this test too.
func TestCapsPinTheOldLiterals(t *testing.T) {
	want := map[string]struct {
		got  int
		want int
	}{
		"MaxListingsPerSweep": {MaxListingsPerSweep, 2000},
		"MaxPagesPerSweep":    {MaxPagesPerSweep, 50},
		"MaxKeyBytes":         {MaxKeyBytes, 300},
		"MaxJobIDBytes":       {MaxJobIDBytes, 128},
		"MaxAttempt":          {MaxAttempt, 10000},
		"MaxSuburbBytes":      {MaxSuburbBytes, 100},
		"MaxStateBytes":       {MaxStateBytes, 10},
		"MaxPostcodeBytes":    {MaxPostcodeBytes, 10},
		"MaxListingIDBytes":   {MaxListingIDBytes, 200},
		"MaxAddressBytes":     {MaxAddressBytes, 300},
		"MaxURLBytes":         {MaxURLBytes, 2048},
		"MaxPropertyBytes":    {MaxPropertyBytes, 100},
		"MaxPriceTextBytes":   {MaxPriceTextBytes, 200},
		"MaxKindBytes":        {MaxKindBytes, 20},
		"MaxStatusBytes":      {MaxStatusBytes, 20},
		"MaxAgencyIDBytes":    {MaxAgencyIDBytes, 100},
		"MaxAgencyNameBytes":  {MaxAgencyNameBytes, 200},
		"MaxAgentNames":       {MaxAgentNames, 20},
		"MaxAgentNameBytes":   {MaxAgentNameBytes, 200},
		"MaxRevisionBytes":    {MaxRevisionBytes, 100},
		"MaxCycleIDBytes":     {MaxCycleIDBytes, 128},
		"MaxCountValue":       {MaxCountValue, 1_000_000},
		"MaxBedroomsValue":    {MaxBedroomsValue, 100},
		"MaxLandSizeSqm":      {MaxLandSizeSqm, 10_000_000},
	}
	for name, c := range want {
		if c.got != c.want {
			t.Errorf("%s = %d, want the pinned %d", name, c.got, c.want)
		}
	}
}

// overCapListing is a collector-shaped listing with every over-cap field set. Each value
// is past its cap, or out of range, or an unknown enum.
func overCapListing(src string) *pb.Listing {
	big := func(n int) string { return strings.Repeat("é", n/2) } // two bytes per rune
	i32 := func(v int32) *int32 { return &v }
	f64 := func(v float64) *float64 { return &v }
	return &pb.Listing{
		Source:       src,
		ListingId:    "L-over-cap",
		ListingUrl:   "https://example.test/x",
		DisplayAddr:  big(400),
		Suburb:       "Bondi",
		State:        "NSW",
		Postcode:     "2026",
		AddressKey:   big(500),
		PropertyType: big(150),
		PriceDisplay: big(300),
		PriceKind:    "bogus-kind",
		Status:       "bogus-status",
		AgencyId:     big(150),
		AgencyName:   big(300),
		AgentNames:   []string{big(300), big(300), "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u"},
		LandSizeSqm:  f64(20_000_000),
		Lat:          f64(120),
		Lng:          f64(-400),
		PriceLow:     f64(-1),
		PriceHigh:    f64(math.NaN()),
		Bedrooms:     i32(500),
		Bathrooms:    i32(-3),
		CarSpaces:    i32(7),
	}
}

// Item 6: every over-cap field of a collector-shaped listing is either sanitised to a
// value the shared validator accepts, or unknown. The listing is kept, not the sweep.
func TestSanitizeOverCapFieldsPassTheSharedValidator(t *testing.T) {
	in := overCapListing("domain")
	if err := ValidateListing("", in, "domain"); err == nil {
		t.Fatal("the raw listing must fail the validator, or the test proves nothing")
	}
	kept, skipped, overflow := SanitizeListings([]*pb.Listing{in}, "domain")
	if skipped != 0 || overflow || len(kept) != 1 {
		t.Fatalf("kept=%d skipped=%d overflow=%v, want the listing kept", len(kept), skipped, overflow)
	}
	l := kept[0]
	if err := ValidateListing("", l, "domain"); err != nil {
		t.Fatalf("sanitised listing still fails the shared validator: %v", err)
	}
	if len(l.DisplayAddr) > MaxAddressBytes || !utf8.ValidString(l.DisplayAddr) {
		t.Errorf("display_addr = %d bytes, valid=%v", len(l.DisplayAddr), utf8.ValidString(l.DisplayAddr))
	}
	if l.PriceKind != "" || l.Status != "" {
		t.Errorf("unknown enums must become unknown: price_kind=%q status=%q", l.PriceKind, l.Status)
	}
	if l.LandSizeSqm != nil || l.Lat != nil || l.Lng != nil || l.PriceLow != nil || l.PriceHigh != nil {
		t.Error("out-of-range or non-finite numbers must become nil, not zero")
	}
	if l.Bedrooms != nil || l.Bathrooms != nil {
		t.Error("out-of-range counts must become nil")
	}
	if l.CarSpaces == nil || *l.CarSpaces != 7 {
		t.Errorf("an in-range count must survive: car_spaces=%v", l.CarSpaces)
	}
	if len(l.AgentNames) != MaxAgentNames {
		t.Errorf("agent names = %d, want the cap %d", len(l.AgentNames), MaxAgentNames)
	}
	for _, n := range l.AgentNames {
		if len(n) > MaxAgentNameBytes {
			t.Errorf("an agent name is %d bytes", len(n))
		}
	}
	if len(in.DisplayAddr) <= MaxAddressBytes {
		t.Error("sanitising must not change the input")
	}
}

// Item 6: each over-cap identity field drops the listing, and the drop is counted.
func TestSanitizeDropsAnUnusableIdentity(t *testing.T) {
	cases := map[string]func(*pb.Listing){
		"listing_id over cap":  func(l *pb.Listing) { l.ListingId = strings.Repeat("x", MaxListingIDBytes+1) },
		"empty listing_id":     func(l *pb.Listing) { l.ListingId = " " },
		"listing_url over cap": func(l *pb.Listing) { l.ListingUrl = strings.Repeat("u", MaxURLBytes+1) },
		"suburb over cap":      func(l *pb.Listing) { l.Suburb = strings.Repeat("s", MaxSuburbBytes+1) },
	}
	for name, mutate := range cases {
		l := &pb.Listing{Source: "rea", ListingId: "ok", Suburb: "Bondi", State: "NSW", Postcode: "2026"}
		mutate(l)
		kept, skipped, _ := SanitizeListings([]*pb.Listing{l}, "rea")
		if len(kept) != 0 || skipped != 1 {
			t.Errorf("%s: kept=%d skipped=%d, want the listing dropped and counted", name, len(kept), skipped)
		}
	}
}

// Item 6: repeated listing_ids keep the first copy; past the cap the rest are dropped
// and overflow is reported.
func TestSanitizeDedupesAndReportsOverflow(t *testing.T) {
	dup := []*pb.Listing{
		{Source: "domain", ListingId: "a", Suburb: "Bondi", State: "NSW", Postcode: "2026"},
		{Source: "domain", ListingId: "a", Suburb: "Bondi", State: "NSW", Postcode: "2026"},
	}
	kept, skipped, overflow := SanitizeListings(dup, "domain")
	if len(kept) != 1 || skipped != 1 || overflow {
		t.Errorf("dedupe: kept=%d skipped=%d overflow=%v", len(kept), skipped, overflow)
	}

	var many []*pb.Listing
	for i := 0; i <= MaxListingsPerSweep; i++ {
		many = append(many, &pb.Listing{Source: "domain", ListingId: strings.Repeat("9", 1) + string(rune('A'+i%26)) + itoa(i), Suburb: "Bondi", State: "NSW", Postcode: "2026"})
	}
	kept, skipped, overflow = SanitizeListings(many, "domain")
	if len(kept) != MaxListingsPerSweep || skipped != 1 || !overflow {
		t.Errorf("overflow: kept=%d skipped=%d overflow=%v, want the cap, one skipped, overflow", len(kept), skipped, overflow)
	}
}

// Item 6: truncation never splits a rune.
func TestTruncateRunesKeepsUTF8(t *testing.T) {
	for _, tc := range []struct {
		in   string
		max  int
		want string
	}{
		{"ééé", 3, "é"},  // 6 bytes; byte 3 is mid-rune, so back up to 2
		{"ééé", 4, "éé"}, // exact boundary
		{"abc", 10, "abc"},
		{"😀😀", 5, "😀"}, // 8 bytes; cut back to the first rune
	} {
		got := TruncateRunes(tc.in, tc.max)
		if got != tc.want || !utf8.ValidString(got) {
			t.Errorf("TruncateRunes(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
		}
	}
}

// Item 6: the rig never sends a value the server would reject as out of range.
func TestSanitizeNilsOutOfRangeNumbers(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	l := &pb.Listing{Source: "rea", ListingId: "n", Suburb: "Bondi", State: "NSW", Postcode: "2026",
		Lat: f(90.5), Lng: f(180), LandSizeSqm: f(MaxLandSizeSqm + 1), PriceLow: f(math.Inf(1))}
	kept, _, _ := SanitizeListings([]*pb.Listing{l}, "rea")
	if len(kept) != 1 {
		t.Fatalf("kept = %d", len(kept))
	}
	k := kept[0]
	if k.Lat != nil || k.LandSizeSqm != nil || k.PriceLow != nil {
		t.Errorf("out-of-range numbers survived: lat=%v land=%v low=%v", k.Lat, k.LandSizeSqm, k.PriceLow)
	}
	if k.Lng == nil || *k.Lng != 180 {
		t.Errorf("an in-range boundary value must survive: lng=%v", k.Lng)
	}
}

// itoa avoids a strconv import for one helper.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	n := len(b)
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	return string(b[n:])
}
