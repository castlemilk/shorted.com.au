package strategies

import (
	"reflect"
	"testing"
)

func pickWith(code string, rank int, mutate func(c *Candidate)) Pick {
	c := Candidate{StockCode: code}
	if mutate != nil {
		mutate(&c)
	}
	return Pick{Rank: rank, Candidate: c, Score: float64(100 - rank)}
}

func sortedCodes(picks []Pick) []string {
	out := make([]string, len(picks))
	for i, p := range picks {
		out[i] = p.Candidate.StockCode
	}
	return out
}

func TestSortKeysAreTheClosedSet(t *testing.T) {
	want := []string{"score", "revenue_yoy", "eps_yoy", "roe", "net_margin", "fcf_margin", "pe", "market_cap"}
	if !reflect.DeepEqual(SortKeys(), want) {
		t.Fatalf("SortKeys() = %v", SortKeys())
	}
	for _, k := range want {
		if !ValidSortBy(k) {
			t.Errorf("%q must be valid", k)
		}
	}
	for _, k := range []string{"", "SCORE", "pe_ratio", "rank", "revenue"} {
		if ValidSortBy(k) {
			t.Errorf("%q must be invalid", k)
		}
	}
}

func TestSortPicksByGrowthPutsOutOfRangeAfterMeasuredAndUnknownLast(t *testing.T) {
	rev := func(v float64) func(c *Candidate) {
		return func(c *Candidate) { c.Growth = &Growth{RevenueYoYPct: f(v)} }
	}
	picks := []Pick{
		pickWith("UNK", 1, nil),                                         // no growth row
		pickWith("HUGE", 2, rev(900)),                                   // out of range, high
		pickWith("MID", 3, rev(20)),                                     // measured
		pickWith("NUL", 4, func(c *Candidate) { c.Growth = &Growth{} }), // row, no figure
		pickWith("TOP", 5, rev(480)),                                    // measured, just inside
		pickWith("CRASH", 6, rev(-97)),                                  // out of range, low
		pickWith("DOWN", 7, rev(-95)),                                   // measured, at the floor
		pickWith("TIE", 8, rev(20)),                                     // ties MID: rank order kept
	}
	input := append([]Pick(nil), picks...)
	got := sortedCodes(SortPicks(picks, SortRevenueYoY))
	want := []string{"TOP", "MID", "TIE", "DOWN", "HUGE", "CRASH", "UNK", "NUL"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(picks, input) {
		t.Fatal("SortPicks mutated its input")
	}
	for _, p := range SortPicks(picks, SortRevenueYoY) {
		if p.Rank == 0 {
			t.Fatal("rank must be kept")
		}
	}
}

func TestSortPicksByPEIsAscendingAndByMarketCapUsesTheResolvedValue(t *testing.T) {
	pe := func(v float64) func(c *Candidate) { return func(c *Candidate) { c.Valuation.PERatio = f(v) } }
	picks := []Pick{pickWith("DEAR", 1, pe(40)), pickWith("NONE", 2, nil), pickWith("CHEAP", 3, pe(8)), pickWith("MID", 4, pe(15))}
	if got := sortedCodes(SortPicks(picks, SortPE)); !reflect.DeepEqual(got, []string{"CHEAP", "MID", "DEAR", "NONE"}) {
		t.Errorf("pe order = %v", got)
	}

	caps := []Pick{
		pickWith("SCR", 1, func(c *Candidate) { c.MarketCap = f(5e9) }),                                  // screener only
		pickWith("OWN", 2, func(c *Candidate) { c.MarketCap = f(1e12); c.Valuation.MarketCap = f(1e9) }), // our own wins
		pickWith("BIG", 3, func(c *Candidate) { c.Valuation.MarketCap = f(9e10) }),
		pickWith("NIL", 4, nil),
	}
	if got := sortedCodes(SortPicks(caps, SortMarketCap)); !reflect.DeepEqual(got, []string{"BIG", "SCR", "OWN", "NIL"}) {
		t.Errorf("market cap order = %v", got)
	}
}

func TestSortPicksByQualityRatiosReadsTheDecidedRow(t *testing.T) {
	q := func(roe, fcf float64) func(c *Candidate) {
		return func(c *Candidate) {
			c.Quality = &Quality{ROEPct: f(roe), FCFMarginPct: f(fcf), NetMarginPct: f(roe / 2)}
		}
	}
	bank := pickWith("BANK", 1, func(c *Candidate) {
		c.Quality = &Quality{ROEPct: f(30), FCFMarginPct: f(90)}
		ApplyQualityRules(c.Quality, "Banks")
	})
	picks := []Pick{bank, pickWith("LOW", 2, q(5, 5)), pickWith("HIGH", 3, q(25, 20))}
	if got := sortedCodes(SortPicks(picks, SortROE)); !reflect.DeepEqual(got, []string{"BANK", "HIGH", "LOW"}) {
		t.Errorf("roe order = %v (a bank's ROE is meaningful)", got)
	}
	if got := sortedCodes(SortPicks(picks, SortFCFMargin)); !reflect.DeepEqual(got, []string{"HIGH", "LOW", "BANK"}) {
		t.Errorf("fcf margin order = %v (a bank's is not meaningful, so unknown)", got)
	}
	if got := sortedCodes(SortPicks(picks, SortNetMargin)); !reflect.DeepEqual(got, []string{"HIGH", "LOW", "BANK"}) {
		t.Errorf("net margin order = %v", got)
	}
}

func TestSortPicksScoreAndEmptyReturnTheInput(t *testing.T) {
	picks := []Pick{pickWith("A", 1, nil), pickWith("B", 2, nil)}
	for _, by := range []string{"", SortScore} {
		got := SortPicks(picks, by)
		if len(got) != 2 || &got[0] != &picks[0] {
			t.Errorf("%q must return the rank-ordered input itself", by)
		}
	}
	if got := SortPicks(nil, SortPE); len(got) != 0 {
		t.Error("nil in, empty out")
	}
}
