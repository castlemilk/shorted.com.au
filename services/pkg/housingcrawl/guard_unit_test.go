package housingcrawl

import "testing"

// largeMove is the quarantine's price-move test. Its boundary is the contract: a
// move of exactly LargeMoveFraction does not count, a move just over it does.
func TestLargeMoveBoundary(t *testing.T) {
	p := func(v float64) *float64 { return &v }
	cases := []struct {
		name   string
		prior  *float64
		priorK string
		cur    *float64
		curK   string
		status string
		want   bool
	}{
		{"exactly 10% up does not count", p(1_000_000), PriceFixed, p(1_100_000), PriceFixed, "for_sale", false},
		{"exactly 10% down does not count", p(1_000_000), PriceFixed, p(900_000), PriceFixed, "for_sale", false},
		{"just over 10% up counts", p(1_000_000), PriceFixed, p(1_100_001), PriceFixed, "for_sale", true},
		{"just over 10% down counts", p(1_000_000), PriceFixed, p(899_999), PriceFixed, "for_sale", true},
		{"a sold listing never counts", p(1_000_000), PriceFixed, p(500_000), PriceFixed, "sold", false},
		{"an unpriced side never counts", nil, PriceFixed, p(500_000), PriceFixed, "for_sale", false},
		{"a new unpriced side never counts", p(1_000_000), PriceFixed, nil, PriceAuction, "for_sale", false},
		{"incomparable kinds never count", p(1_000_000), PriceRangeLow, p(2_000_000), PriceFixed, "for_sale", false},
		{"a range compares like-to-like", p(1_000_000), PriceRangeLow, p(2_000_000), PriceRangeLow, "for_sale", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := largeMove(tc.prior, tc.priorK, tc.cur, tc.curK, tc.status); got != tc.want {
				t.Errorf("largeMove = %v, want %v", got, tc.want)
			}
		})
	}
}
