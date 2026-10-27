package main

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// The collector hands its diff thresholds to the store through rules(). A swapped
// or dropped field here changes what is delisted and what counts as a price move,
// so the hand-off is pinned at both the default and an explicit override.
func TestListingsRules_DefaultConfigHandsOffToStore(t *testing.T) {
	for _, k := range []string{"CRAWL_LISTINGS_DELIST_GRACE", "CRAWL_LISTINGS_NOISE_ABS", "CRAWL_LISTINGS_NOISE_PCT"} {
		t.Setenv(k, "") // empty means unset: defaults apply whatever the shell exports
	}
	got := loadListingsConfig().rules()
	want := housingcrawl.Config{DelistGrace: 2, NoiseAbs: 5000, NoisePct: 0.005}
	if got != want {
		t.Errorf("default rules() = %+v, want %+v", got, want)
	}
}

func TestListingsRules_EnvOverridesReachTheRightField(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_DELIST_GRACE", "3")
	t.Setenv("CRAWL_LISTINGS_NOISE_ABS", "7000")
	t.Setenv("CRAWL_LISTINGS_NOISE_PCT", "0.01")
	got := loadListingsConfig().rules()
	want := housingcrawl.Config{DelistGrace: 3, NoiseAbs: 7000, NoisePct: 0.01}
	if got != want {
		t.Errorf("overridden rules() = %+v, want %+v", got, want)
	}
}
