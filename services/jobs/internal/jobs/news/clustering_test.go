package news

import (
	"testing"
)

func TestMakeShingles(t *testing.T) {
	shingles := makeShingles("This Insider Has Just Sold Shares In Gold Hydrogen - simplywall.st", 3)
	if len(shingles) == 0 {
		t.Error("expected non-empty shingles for a real headline")
	}
}

func TestSameStoryMarket(t *testing.T) {
	sh := func(h string) map[string]struct{} { return makeShingles(h, 3) }

	// Templated insider headlines about DIFFERENT companies must NOT cluster.
	insider1 := sh("This Insider Has Just Sold Shares In Gold Hydrogen - simplywall.st")
	insider2 := sh("This Insider Has Just Sold Shares In Challenger - simplywall.st")
	if sameStoryMarket(insider1, insider2, 3) {
		t.Error("templated insider headlines about different companies must NOT cluster")
	}

	// Same story with one differing word MUST cluster.
	oil1 := sh("Oil Falls 15% on Iran Ceasefire: What to Do With ASX Stocks like WDS, STO, BPT")
	oil2 := sh("Oil Crashed 15% on Iran Ceasefire: What to Do With ASX Stocks like WDS, STO, BPT")
	if !sameStoryMarket(oil1, oil2, 3) {
		t.Error("same story with one differing word MUST cluster")
	}

	// Suffix-only syndication MUST cluster.
	cu1 := sh("Copper is going ballistic. Which ASX shares are riding the boom?")
	cu2 := sh("Copper is going ballistic. Which ASX shares are riding the boom? - The Motley Fool Australia")
	if !sameStoryMarket(cu1, cu2, 3) {
		t.Error("suffix-only syndication MUST cluster")
	}
}

// TestSameStoryMarketOverlapRatios is a diagnostic test that reports computed
// overlap ratios for each case so the chosen threshold can be validated.
func TestSameStoryMarketOverlapRatios(t *testing.T) {
	sh := func(h string) map[string]struct{} { return makeShingles(h, 3) }

	cases := []struct {
		name        string
		a, b        string
		wantCluster bool
	}{
		{
			name:        "insider different companies",
			a:           "This Insider Has Just Sold Shares In Gold Hydrogen - simplywall.st",
			b:           "This Insider Has Just Sold Shares In Challenger - simplywall.st",
			wantCluster: false,
		},
		{
			name:        "oil one word diff",
			a:           "Oil Falls 15% on Iran Ceasefire: What to Do With ASX Stocks like WDS, STO, BPT",
			b:           "Oil Crashed 15% on Iran Ceasefire: What to Do With ASX Stocks like WDS, STO, BPT",
			wantCluster: true,
		},
		{
			name:        "copper suffix only",
			a:           "Copper is going ballistic. Which ASX shares are riding the boom?",
			b:           "Copper is going ballistic. Which ASX shares are riding the boom? - The Motley Fool Australia",
			wantCluster: true,
		},
	}

	for _, tc := range cases {
		sa := sh(tc.a)
		sb := sh(tc.b)
		shared := shingleOverlap(sa, sb)
		smaller := len(sa)
		if len(sb) < smaller {
			smaller = len(sb)
		}
		ratio := float64(shared) / float64(smaller)
		got := sameStoryMarket(sa, sb, 3)
		t.Logf("[%s] |A|=%d |B|=%d shared=%d smaller=%d ratio=%.3f clustered=%v (want=%v)",
			tc.name, len(sa), len(sb), shared, smaller, ratio, got, tc.wantCluster)
		if got != tc.wantCluster {
			t.Errorf("  FAIL: got clustered=%v, want=%v", got, tc.wantCluster)
		}
	}
}
