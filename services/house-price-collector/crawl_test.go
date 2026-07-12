package main

import (
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// These tests are the crawl tier's "rock solid" proof: the anti-poisoning
// guarantees are verified here, not against the live (adversarial) sites.

func TestValidateMedian_AbsoluteBounds(t *testing.T) {
	cases := []struct {
		name  string
		value float64
		base  float64
		want  bool
	}{
		{"too low", 50_000, 0, false},
		{"too high", 80_000_000, 0, false},
		{"plausible, no baseline", 1_200_000, 0, true},
		{"zero", 0, 0, false},
		{"floor ok", 100_000, 0, true},
	}
	for _, c := range cases {
		if got := validateMedian(c.value, c.base).ok; got != c.want {
			t.Errorf("%s: validateMedian(%v,%v).ok=%v want %v", c.name, c.value, c.base, got, c.want)
		}
	}
}

func TestValidateMedian_CapitalBand(t *testing.T) {
	const sydney = 1_485_000.0
	// In-band: a premium suburb at ~2.4× the capital median.
	if !validateMedian(3_500_000, sydney).ok {
		t.Error("premium suburb within band should pass")
	}
	// Poison: a Kasada-style fixed/garbage value far outside the band.
	if validateMedian(25_000_000, sydney).ok {
		t.Error("value 16x the capital median should be rejected")
	}
	if validateMedian(150_000, sydney).ok {
		t.Error("value at 10% of the capital median should be rejected")
	}
}

func TestRobustMedian_DropsPoisonOutlier(t *testing.T) {
	const sydney = 1_485_000.0
	// Three plausible + one poisoned outlier that sneaks past absolute bounds.
	cands := []float64{1_800_000, 1_900_000, 2_000_000, 49_000_000}
	med, ok := robustMedian(cands, sydney)
	if !ok {
		t.Fatal("expected a robust median")
	}
	if med < 1_800_000 || med > 2_000_000 {
		t.Errorf("robust median %v should be among the plausible cluster, not dragged by the outlier", med)
	}
}

func TestRobustMedian_AllPoisonReturnsFalse(t *testing.T) {
	const sydney = 1_485_000.0
	if _, ok := robustMedian([]float64{40_000_000, 60_000_000, 90_000_000}, sydney); ok {
		t.Error("a fully-poisoned page must yield no value")
	}
	if _, ok := robustMedian(nil, sydney); ok {
		t.Error("empty candidates must yield no value")
	}
}

func TestCrossSourceAgrees(t *testing.T) {
	if !crossSourceAgrees(1_500_000, 1_600_000) {
		t.Error("6.25%% apart should agree")
	}
	if crossSourceAgrees(1_500_000, 2_500_000) {
		t.Error("40%% apart should NOT agree (one source likely poisoned)")
	}
	if crossSourceAgrees(0, 1_500_000) {
		t.Error("a zero source can't agree")
	}
}

func TestParseMoney(t *testing.T) {
	cases := map[string]float64{
		"$1.25m":      1_250_000,
		"1,250,000":   1_250_000,
		"$985k":       985_000,
		"$1.2 M":      1_200_000,
		"not a price": 0,
	}
	for in, want := range cases {
		got, ok := parseMoney(in)
		if want == 0 {
			if ok {
				t.Errorf("parseMoney(%q) should fail", in)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("parseMoney(%q)=%v,%v want %v", in, got, ok, want)
		}
	}
}

func TestBalancedJSON_NestedAndStrings(t *testing.T) {
	in := `prefix = {"a":1,"b":{"c":[2,3]},"s":"a } brace in a string"};suffix`
	want := `{"a":1,"b":{"c":[2,3]},"s":"a } brace in a string"}`
	got, ok := balancedJSON(in, strings.IndexByte(in, '{'))
	if !ok || got != want {
		t.Errorf("balancedJSON got %q ok=%v want %q", got, ok, want)
	}
}

func docFrom(html string) *goquery.Document {
	d, _ := goquery.NewDocumentFromReader(strings.NewReader(html))
	return d
}

func TestExtractSaleMedians_DomainNextData(t *testing.T) {
	// Domain-style embedded JSON (raw JSON in __NEXT_DATA__ script).
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">
	{"props":{"suburbInsights":{"medianPrice":1850000,"medianRentPrice":850,"avgDaysOnMarket":42}}}
	</script></body></html>`
	got := extractSaleMedians(docFrom(html))
	if len(got) != 1 || got[0] != 1_850_000 {
		t.Errorf("expected [1850000], got %v (rent must be excluded)", got)
	}
}

func TestExtractSaleMedians_REAArgonaut(t *testing.T) {
	// REA-style window assignment with a stringified money value.
	html := `<html><body><script>
	window.ArgonautExchange = {"suburb":{"metrics":{"medianSoldPrice":"$2.1m","medianRentPrice":"$1,100"}}};
	</script></body></html>`
	got := extractSaleMedians(docFrom(html))
	if len(got) != 1 || got[0] != 2_100_000 {
		t.Errorf("expected [2100000], got %v", got)
	}
}

func TestSelectTargets_ShardingDisjointAndBalanced(t *testing.T) {
	all := []CrawlTarget{
		{Suburb: "a"}, {Suburb: "b"}, {Suburb: "c"},
		{Suburb: "d"}, {Suburb: "e"}, {Suburb: "f"}, {Suburb: "g"},
	}
	shard0 := selectTargets(all, crawlConfig{maxSuburbs: len(all), shardIndex: 0, shardCount: 2})
	shard1 := selectTargets(all, crawlConfig{maxSuburbs: len(all), shardIndex: 1, shardCount: 2})

	// Union == all, intersection == empty.
	seen := map[string]int{}
	for _, x := range append(append([]CrawlTarget{}, shard0...), shard1...) {
		seen[x.Suburb]++
	}
	if len(seen) != len(all) {
		t.Fatalf("union covered %d suburbs, want %d", len(seen), len(all))
	}
	for s, n := range seen {
		if n != 1 {
			t.Fatalf("suburb %q appeared %d times across shards, want exactly 1", s, n)
		}
	}
	// Balanced: 7 items, 2 shards -> 4 and 3.
	if len(shard0) != 4 || len(shard1) != 3 {
		t.Fatalf("shard sizes = %d,%d, want 4,3", len(shard0), len(shard1))
	}
}

func TestSelectTargets_NoShardingIsIdentityThenCap(t *testing.T) {
	all := []CrawlTarget{{Suburb: "a"}, {Suburb: "b"}, {Suburb: "c"}}
	// shardCount<=1 disables sharding.
	got := selectTargets(all, crawlConfig{maxSuburbs: len(all), shardCount: 1})
	if len(got) != 3 {
		t.Fatalf("no-shard len = %d, want 3", len(got))
	}
	// maxSuburbs still caps (prefix) after sharding.
	capped := selectTargets(all, crawlConfig{maxSuburbs: 2, shardCount: 1})
	if len(capped) != 2 {
		t.Fatalf("capped len = %d, want 2", len(capped))
	}
}

func TestSelectTargets_OutOfRangeShardIsEmpty(t *testing.T) {
	all := []CrawlTarget{{Suburb: "a"}, {Suburb: "b"}}
	got := selectTargets(all, crawlConfig{maxSuburbs: len(all), shardIndex: 5, shardCount: 2})
	if len(got) != 0 {
		t.Fatalf("out-of-range shard len = %d, want 0", len(got))
	}
}

func TestNeedsRewarm(t *testing.T) {
	cases := []struct {
		name                            string
		maxConsec, reaBlocks, domBlocks int
		want                            bool
	}{
		{"no blocks", 3, 0, 0, false},
		{"rea tripped", 3, 3, 0, true},
		{"domain tripped", 3, 1, 3, true},
		{"both tripped", 3, 4, 5, true},
		{"under threshold", 3, 2, 2, false},
		{"breaker disabled", 0, 9, 9, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := needsRewarm(c.maxConsec, c.reaBlocks, c.domBlocks); got != c.want {
				t.Fatalf("needsRewarm(%d,%d,%d) = %v, want %v", c.maxConsec, c.reaBlocks, c.domBlocks, got, c.want)
			}
		})
	}
}
