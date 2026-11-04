package instrument

import "testing"

// TestEligibleExcludesETPAndStale holds the universe rule to its two exclusions
// that do not depend on the ASIC product name: an exchange-traded product, from
// the ETP set or from its name, and a code with no bar on the session.
func TestEligibleExcludesETPAndStale(t *testing.T) {
	etps := map[string]bool{"VAS": true}
	tests := []struct {
		name         string
		code         string
		asicProduct  string
		companyName  string
		shares       float64
		barOnSession bool
		wantOrdinary bool
		wantReason   string
	}{
		{"ordinary share", "BHP", "BHP GROUP LIMITED ORDINARY", "BHP Group", 5_084_182_500, true, true, ""},
		{"ETP set member, even with an ordinary-looking product", "VAS", "VANGUARD AUST SHARES", "Vanguard", 100_000_000, true, false, ReasonExchangeTradedProduct},
		{"ETF named by its ASIC product", "CPPR", "ETFS GLB COPPER EW ETF UNITS", "", 100_000, true, false, ReasonExchangeTradedProduct},
		{"ETF named by its company name, not in ASIC", "QETH", "", "Betashares Ether ETF", 0, true, false, ReasonExchangeTradedProduct},
		{"debt named by its coupon", "ATBHQ", "ASIAN DEVELOPMENT 4.35% 17-JAN-29", "", 200_000, true, false, ReasonDebtOrHybrid},
		{"secondary line by code length", "NWSLV", "", "News Corp", 0, true, false, ReasonSecondaryLine},
		{"stale: no bar on the session", "CBA", "COMMONWEALTH BANK. ORDINARY", "Commonwealth Bank", 1_673_462_358, false, true, ReasonNoBarOnSession},
		{"stale ETP reports the stale reason first", "VAS", "", "", 0, false, false, ReasonNoBarOnSession},
		{"no name from either source, three characters", "ABC", "", "", 0, true, true, ""},
		{"no name from either source, four characters", "ABCD", "", "", 0, true, false, ReasonUnclassified},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := IneligibleReason(tc.code, tc.asicProduct, tc.companyName, tc.shares, etps, tc.barOnSession)
			if got != tc.wantReason {
				t.Errorf("IneligibleReason(%s) = %q, want %q", tc.code, got, tc.wantReason)
			}
			if ord := IsOrdinary(tc.code, tc.asicProduct, tc.companyName, tc.shares, etps); ord != tc.wantOrdinary {
				t.Errorf("IsOrdinary(%s) = %v, want %v", tc.code, ord, tc.wantOrdinary)
			}
		})
	}
}

// TestUnclassifiedIsTheNamelessThreeLetterFallback pins the one inclusion that
// rests on the code alone.
func TestUnclassifiedIsTheNamelessThreeLetterFallback(t *testing.T) {
	if !Unclassified("ABC", "", "") {
		t.Error("a nameless three-letter code is unclassified")
	}
	if Unclassified("ABCD", "", "") {
		t.Error("a nameless four-letter code is excluded, not unclassified")
	}
	if Unclassified("BHP", "BHP GROUP LIMITED ORDINARY", "") {
		t.Error("a code with an ASIC product name is classified")
	}
}
