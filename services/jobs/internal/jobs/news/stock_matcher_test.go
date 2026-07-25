package news

import "testing"

// newTestMatcher builds an in-memory matcher with codes that overlap
// with common English words plus a couple of unambiguous tickers, so we
// can verify the strict-casing rule fires for ALL bare-ticker matches.
func newTestMatcher() *StockMatcher {
	return &StockMatcher{
		codeToName: map[string]string{
			"BHP":  "BHP Group",
			"CSL":  "CSL Limited",
			"ZIP":  "Zip Co",
			"NEW":  "New Energy Solar",
			"BUY":  "Bounty Oil & Gas Nl",
			"HAS":  "Hastings Technology Metals",
			"AGO":  "Atlas Iron",
			"GOLD": "Gblx Gold",
			"DRO":  "Droneshield",
			"LYC":  "Lynas Rare Earths",
			"LOT":  "Lotus Resources",
		},
		nameToCode: map[string]string{
			"bhp group":                  "BHP",
			"csl limited":                "CSL",
			"zip co":                     "ZIP",
			"new energy solar":           "NEW",
			"bounty oil & gas nl":        "BUY",
			"hastings technology metals": "HAS",
			"droneshield":                "DRO",
			"lynas rare earths":          "LYC",
			"lotus resources":            "LOT",
			"lotus":                      "LOT",
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
		// Bare tickers require an exact UPPERCASE word in the original headline
		{"all-caps real ticker", "BHP hits new high", "BHP"},
		{"normal uppercase still works", "BHP announces buyback", "BHP"},
		{"all-caps LOT matches LOT", "LOT shorts surge as Kayelekera burns", "LOT"},
		{"lowercase 'lot' must not match LOT", "'A lot of confidence' for Ash Gardner ahead of T20 Cup", ""},
		{"title-case 'Lot' must not match LOT", "Lot of upside left in lithium, brokers say", ""},
		{"title-case bare ticker no longer matches", "Zip shorts doubled while the chart halved", ""},
		{"lowercase 'buy' must not match BUY", "Down 55%: Should I buy Zip shares?", ""},
		{"title-case 'New' must not match NEW", "5 new ASX stocks to watch", ""},
		{"title-case 'Has' in mid-sentence must not match", "Why green hydrogen still has investors talking", ""},
		{"title-case 'For' must not match", "How to invest for retirement", ""},
		{"'New' skipped, uppercase BHP wins", "New CEO for BHP", "BHP"},
		{"ALL CAPS NEW still matches the NEW ticker", "NEW announces dividend boost", "NEW"},

		// Explicit ticker references
		{"$BUY cashtag matches BUY ticker", "$BUY rallies on oil discovery", "BUY"},
		{"ASX:NEW prefix matches NEW ticker", "ASX:NEW posts quarterly update", "NEW"},
		{"(ASX:LOT) with company name", "Lotus Resources (ASX:LOT) faces production halt", "LOT"},
		{"(ASX: LOT) with space after colon", "Uranium hopeful (ASX: LOT) flags production halt", "LOT"},
		{"lowercase asx: prefix with uppercase code", "asx:LOT in the spotlight", "LOT"},

		// Company-name matching is unaffected by the casing rule
		{"company name match (no ticker)", "Droneshield faces ASIC probe", "DRO"},
		{"another name match", "Why Lynas Rare Earths shares fell today", "LYC"},
		{"first-word name match", "Lotus boss talks up Kayelekera restart", "LOT"},

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
