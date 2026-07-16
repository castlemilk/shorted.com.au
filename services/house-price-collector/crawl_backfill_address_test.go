package main

import "testing"

// TestAddressKeyForListing covers the pure derivation runBackfillAddress
// applies to every existing property_listings row (the DB read/write itself
// isn't unit-testable here — this repo's test suite is offline-only, see
// nsw_prod_ingest_test.go's DATABASE_URL-gated pattern for the one exception).
func TestAddressKeyForListing(t *testing.T) {
	s := func(v string) *string { return &v }

	cases := []struct {
		name string
		row  addressBackfillRow
		want string
	}{
		{
			name: "fully populated row",
			row: addressBackfillRow{
				pk: 1, displayAddr: s("1 Centre Road, Brighton, Vic 3186"),
				suburb: s("Brighton"), state: s("VIC"), pc: s("3186"),
			},
			want: "1-centre-road-brighton-vic-3186",
		},
		{
			name: "NULL display_address column -> street empty -> garbage key",
			row: addressBackfillRow{
				pk: 2, displayAddr: nil,
				suburb: s("Brighton"), state: s("VIC"), pc: s("3186"),
			},
			want: "",
		},
		{
			name: "NULL suburb column -> garbage key",
			row: addressBackfillRow{
				pk: 3, displayAddr: s("1 Centre Road"),
				suburb: nil, state: s("VIC"), pc: s("3186"),
			},
			want: "",
		},
		{
			name: "NULL postcode column -> garbage key",
			row: addressBackfillRow{
				pk: 4, displayAddr: s("1 Centre Road"),
				suburb: s("Brighton"), state: s("VIC"), pc: nil,
			},
			want: "",
		},
		{
			name: "all NULL -> garbage key, never panics",
			row:  addressBackfillRow{pk: 5},
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := addressKeyForListing(c.row); got != c.want {
				t.Errorf("addressKeyForListing(%+v) = %q, want %q", c.row, got, c.want)
			}
		})
	}
}

func TestStrOrEmpty(t *testing.T) {
	if got := strOrEmpty(nil); got != "" {
		t.Errorf("strOrEmpty(nil) = %q, want \"\"", got)
	}
	v := "x"
	if got := strOrEmpty(&v); got != "x" {
		t.Errorf("strOrEmpty(&x) = %q, want \"x\"", got)
	}
}
