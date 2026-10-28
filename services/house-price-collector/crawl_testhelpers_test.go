package main

import "time"

// The ingest URL check (validateIngestURL) refuses plain-http loopback in production. Tests
// point the sink at an httptest server, so this file, and only this file, opens it.
func init() { testAllowLoopbackIngest = true }

// bondi is the reference suburb the listings and resume tests sweep. It lived in the
// ExtractRealEstate test file, which S-FETCH removed; the fixture stays because the
// listings tests key their pages to its URLs.
var bondi = CrawlTarget{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW", Capital: "1GSYD"}

// newTestCrawler wires a crawler with a fake fetcher, a Sydney baseline (so the
// capital-band gate is active) and fast pacing for tests.
func newTestCrawler(ff htmlFetcher) *crawler {
	return &crawler{
		fetcher:   ff,
		baselines: map[string]float64{"1GSYD": 1_485_000.0, "2GMEL": 850_000.0},
		cfg: crawlConfig{
			maxSuburbs:      len(crawlTargets),
			minDelay:        1 * time.Millisecond,
			maxDelay:        2 * time.Millisecond,
			maxConsecBlocks: 3,
			fetchTimeout:    60 * time.Second,
			profileDir:      "/tmp/test-profile",
		},
	}
}
