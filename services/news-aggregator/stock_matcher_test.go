package main

import "testing"

// newTestMatcher builds an in-memory matcher with codes that overlap
// with common English words plus a couple of unambiguous tickers, so we
// can verify the strict-casing rule fires only for the stop-word codes.
func newTestMatcher() *StockMatcher {
	return &StockMatcher{
		codeToName: map[string]string{
			"BHP": "BHP Group",
			"CSL": "CSL Limited",
			"ZIP": "Zip Co",
			"NEW": "New Energy Solar",
			"BUY": "Bounty Oil & Gas Nl",
			"HAS": "Hastings Technology Metals",
			"AGO": "Atlas Iron",
			"GOLD": "Gblx Gold",
			"DRO": "Droneshield",
			"LYC": "Lynas Rare Earths",
		},
		nameToCode: map[string]string{
			"bhp group":               "BHP",
			"csl limited":             "CSL",
			"zip co":                  "ZIP",
			"new energy solar":        "NEW",
			"bounty oil & gas nl":     "BUY",
			"hastings technology metals": "HAS",
			"droneshield":             "DRO",
			"lynas rare earths":       "LYC",
		},
	}
}

func TestMatch(t *testing.T) {
	m := newTestMatcher()
	cases := []struct {
		name     string
		headline string
		want     string
	}{
		// Unambiguous codes — match regardless of casing
		{"all-caps real ticker", "BHP hits new high", "BHP"},
		{"title-case real ticker", "Zip shorts doubled while the chart halved", "ZIP"},
		{"company name match (no ticker)", "Droneshield faces ASIC probe", "DRO"},
		{"another name match", "Why Lynas Rare Earths shares fell today", "LYC"},

		// Ambiguous codes — strict casing required
		{"lowercase 'buy' must not match BUY", "Down 55%: Should I buy Zip shares?", "ZIP"},
		{"title-case 'New' must not match NEW", "5 new ASX stocks to watch", ""},
		{"title-case 'Has' in mid-sentence must not match", "Why green hydrogen still has investors talking", ""},
		{"title-case 'For' must not match", "How to invest for retirement", ""},
		{"ALL CAPS NEW still matches the NEW ticker", "NEW announces dividend boost", "NEW"},
		{"$BUY cashtag matches BUY ticker", "$BUY rallies on oil discovery", "BUY"},
		{"ASX:NEW prefix matches NEW ticker", "ASX:NEW posts quarterly update", "NEW"},

		// Empty / no match
		{"unrelated headline", "Bond yields shock the market today", ""},
		{"ticker-shaped non-code", "OPEC announces output cut", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := m.Match(c.headline)
			if got != c.want {
				t.Errorf("Match(%q) = %q, want %q", c.headline, got, c.want)
			}
		})
	}
}
