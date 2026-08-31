package shorts

import "testing"

// The three instruments reported in issue #563, each of which appeared in a
// GetMarketByDate universe at or above 100% short. They are not miscalculated —
// reported/issued reproduces the percentage exactly — they are instruments
// where "percent of shares on issue" is not the quantity it is for an ordinary
// share.
func TestClassifySecurityOnTheReportedInstruments(t *testing.T) {
	tests := []struct {
		name    string
		product string
		code    string
		issued  float64
		want    SecurityType
	}{
		{
			// 6-character code: a warrant / secondary line.
			name: "GSBW34 at 132.54%", product: "GLOBAL X PHYS GOLD WARRANT",
			code: "GSBW34", issued: 224_000_000, want: SecurityTypeOther,
		},
		{
			// The bond named in migration 000043's own header. Two independent
			// signals catch it: the coupon in the name and the 5-char code.
			name: "ATBHQ at 100%", product: "ASIAN DEVELOPMENT 4.35% 17-JAN-29",
			code: "ATBHQ", issued: 200_000, want: SecurityTypeDebt,
		},
		{
			// 4-char code, so only the name and the tiny denominator give it
			// away: 51,303 units short over 50,000 on issue.
			name: "UYLD at 102.61%", product: "GLOBAL X USD YIELD ETF UNITS",
			code: "UYLD", issued: 50_000, want: SecurityTypeETF,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifySecurity(tc.product, tc.code, tc.issued); got != tc.want {
				t.Errorf("ClassifySecurity(%q, %q, %v) = %q, want %q",
					tc.product, tc.code, tc.issued, got, tc.want)
			}
			if IsOrdinary(tc.product, tc.code, tc.issued) {
				t.Error("must not be classified as an ordinary share line")
			}
		})
	}
}

func TestClassifySecurity(t *testing.T) {
	tests := []struct {
		name    string
		product string
		code    string
		issued  float64
		want    SecurityType
	}{
		// Ordinary listings, which must survive every rule.
		{"BHP", "BHP GROUP LIMITED ORDINARY", "BHP", 5_084_182_500, SecurityTypeOrdinary},
		{"CBA", "COMMONWEALTH BANK. ORDINARY", "CBA", 1_673_462_358, SecurityTypeOrdinary},
		{"a numeric code", "3P LEARNING ORDINARY", "3PL", 200_000_000, SecurityTypeOrdinary},
		{"a 4-char code", "AAPL SOMETHING ORDINARY", "AAPL", 100_000_000, SecurityTypeOrdinary},
		{"unknown shares on issue is not evidence", "SOMETHING ORDINARY", "XYZ", 0, SecurityTypeOrdinary},

		// ETFs name themselves.
		{"ETF units", "ETFS GLB COPPER EW ETF UNITS", "CPPR", 100_000, SecurityTypeETF},
		{"lowercase etf", "vaneck australian etf", "VAS", 10_000_000, SecurityTypeETF},

		// A word merely starting with ETF is not an ETF.
		{"ETFERSON is not an ETF", "ETFERSON MINING ORDINARY", "ETM", 50_000_000, SecurityTypeOrdinary},

		// Debt named by coupon.
		{"coupon with decimals", "TREASURY 4.35% 2029", "GSBK29", 1_000_000_000, SecurityTypeDebt},
		{"whole-number coupon", "SOME NOTE 3% PERPETUAL", "ABCHA", 900_000_000, SecurityTypeDebt},

		// Secondary lines and deferred settlement.
		{"5-char code", "SOMETHING PREFERENCE", "NWSLV", 900_000_000, SecurityTypeOther},
		{"deferred settlement", "MINER LTD DEFERRED SETTLEMENT", "MNR", 900_000_000, SecurityTypeOther},
		{"micro denominator", "TINY THING ORDINARY", "TNY", 50_000, SecurityTypeOther},
		{"just under the floor", "TINY THING ORDINARY", "TNY", 4_999_999, SecurityTypeOther},
		{"exactly at the floor", "ORDINARY THING", "ORD", 5_000_000, SecurityTypeOrdinary},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifySecurity(tc.product, tc.code, tc.issued); got != tc.want {
				t.Errorf("ClassifySecurity(%q, %q, %v) = %q, want %q",
					tc.product, tc.code, tc.issued, got, tc.want)
			}
		})
	}
}

// A short position above 100% of shares on issue is the signature of a
// non-ordinary instrument. Any such case must be classified as something other
// than an ordinary share — that is the whole purpose of this classifier.
func TestInstrumentsOverOneHundredPercentAreNeverOrdinary(t *testing.T) {
	cases := []struct {
		product  string
		code     string
		reported float64
		issued   float64
	}{
		{"GLOBAL X USD YIELD ETF UNITS", "UYLD", 51_303, 50_000},
		{"GLOBAL X PHYS GOLD WARRANT", "GSBW34", 296_899_840, 224_000_000},
		{"ASIAN DEVELOPMENT 4.35% 17-JAN-29", "ATBHQ", 200_000, 200_000},
	}
	for _, c := range cases {
		pct := c.reported / c.issued * 100
		if pct < 100 {
			t.Fatalf("%s: fixture is not actually >= 100%% (%.2f)", c.code, pct)
		}
		if IsOrdinary(c.product, c.code, c.issued) {
			t.Errorf("%s reports %.2f%% short yet classifies as an ordinary share", c.code, pct)
		}
	}
}
