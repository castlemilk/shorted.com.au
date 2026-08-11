package houseprices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These tests exercise the rewired Tier-3 crawl ORCHESTRATION end-to-end with a
// fake htmlFetcher (canned HTML, no browser) and a fake brandbrain server (no live
// REA/Domain). They assert that both sources are fetched, an aggregate-only
// projection is routed to brandbrain's ExtractRealEstate, the returned aggregates
// are mapped to Observations with the correct Source, and the pacing /
// circuit-breaker / dry-run scaffolding still holds. NO browser and NO live
// anti-bot site are touched.

// fakeFetcher is a scripted htmlFetcher: it returns canned HTML keyed by a
// substring of the URL (so REA vs Domain can return different bodies), records
// every URL it was asked for, and can be told to "block" or error specific hosts.
type fakeFetcher struct {
	html     map[string]string // url-substring -> html body
	blockOn  map[string]bool   // url-substring -> return a block error
	errorOn  map[string]bool   // url-substring -> return a transient error
	calls    []string
	closed   int32
	fetchDur time.Duration // optional artificial latency
}

func (f *fakeFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	f.calls = append(f.calls, url)
	if f.fetchDur > 0 {
		select {
		case <-time.After(f.fetchDur):
		case <-ctx.Done():
			return nil, "", ctx.Err()
		}
	}
	for sub := range f.blockOn {
		if strings.Contains(url, sub) {
			return nil, "", errors.New("net::ERR_HTTP_RESPONSE_CODE_FAILURE 403")
		}
	}
	for sub := range f.errorOn {
		if strings.Contains(url, sub) {
			return nil, "", errors.New("net::ERR_TIMED_OUT")
		}
	}
	for sub, body := range f.html {
		if strings.Contains(url, sub) {
			return []byte(body), url, nil
		}
	}
	// default: an innocuous page with no anti-bot markers and no usable medians.
	return []byte("<html><body>no data</body></html>"), url, nil
}

func (f *fakeFetcher) Close() { atomic.AddInt32(&f.closed, 1) }

// newTestCrawler wires a crawler with a fake fetcher, a Sydney baseline (so the
// capital-band gate is active) and fast pacing for tests.
func newTestCrawler(ff htmlFetcher, brandbrainURL string) *crawler {
	return &crawler{
		fetcher:   ff,
		baselines: map[string]float64{"1GSYD": 1_485_000.0, "2GMEL": 850_000.0},
		cfg: crawlConfig{
			maxSuburbs:      len(crawlTargets),
			minDelay:        1 * time.Millisecond,
			maxDelay:        2 * time.Millisecond,
			maxConsecBlocks: 3,
			fetchTimeout:    60 * time.Second,
			brandbrainURL:   brandbrainURL,
			profileDir:      "/tmp/test-profile",
		},
	}
}

// brandbrainServer returns a fake brandbrain that echoes a canned ExtractRealEstate
// response and records how many times it was hit + the suburb/state hints seen.
func brandbrainServer(t *testing.T, body string) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		var req extractRealEstateReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("brandbrain: bad request body: %v", err)
		}
		var contract brandbrainMediansContract
		if err := json.Unmarshal([]byte(req.HTML), &contract); err != nil {
			t.Errorf("brandbrain: invalid aggregate projection: %v", err)
		} else if len(contract.AggregateFields) == 0 {
			t.Errorf("brandbrain: projection has no aggregate_fields: %s", req.HTML)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	return srv, &hits
}

func projectableHTML(label string) string {
	return `<html><body>` + label + `<script type="application/json">{"medianHousePrice":1850000}</script></body></html>`
}

func TestCrawlSuburb_RoutesBothSourcesToBrandbrain(t *testing.T) {
	bb, hits := brandbrainServer(t, bondiExtractJSON())
	defer bb.Close()

	ff := &fakeFetcher{html: map[string]string{
		"realestate.com.au": projectableHTML("REA Bondi rendered"),
		"domain.com.au":     projectableHTML("Domain Bondi rendered"),
	}}
	cr := newTestCrawler(ff, bb.URL)

	obs := cr.crawlSuburb(context.Background(), bondi)

	// Both sources fetched, in REA-then-Domain order.
	if len(ff.calls) != 2 {
		t.Fatalf("expected 2 fetches (REA+Domain), got %d: %v", len(ff.calls), ff.calls)
	}
	if !strings.Contains(ff.calls[0], "realestate.com.au") || !strings.Contains(ff.calls[1], "domain.com.au") {
		t.Errorf("fetch order wrong: %v", ff.calls)
	}
	// Brandbrain hit once per source.
	if got := atomic.LoadInt32(hits); got != 2 {
		t.Errorf("brandbrain hits = %d, want 2", got)
	}

	// Each source produces the full bondi measure set; assert both Source tags.
	var reaCount, domCount int
	for _, o := range obs {
		switch o.Source {
		case "brandbrain_rea":
			reaCount++
		case "brandbrain_domain":
			domCount++
		default:
			t.Errorf("unexpected source %q", o.Source)
		}
		if o.SourceLicence != "proprietary-tos-restricted" {
			t.Errorf("licence = %q, want proprietary-tos-restricted", o.SourceLicence)
		}
	}
	if reaCount == 0 || domCount == 0 {
		t.Errorf("expected observations from BOTH sources, got rea=%d dom=%d", reaCount, domCount)
	}
	// 5 measures (house, unit, yield, days, growth) per source = 10.
	if len(obs) != 10 {
		t.Errorf("expected 10 observations (5×2 sources), got %d", len(obs))
	}
	if cr.stats.accepted != 1 || cr.stats.attempted != 1 {
		t.Errorf("stats attempted/accepted = %d/%d, want 1/1", cr.stats.attempted, cr.stats.accepted)
	}
}

func TestCrawlSource_BlockTripsCircuitBreaker(t *testing.T) {
	bb, hits := brandbrainServer(t, bondiExtractJSON())
	defer bb.Close()

	// REA always blocks; Domain always succeeds.
	ff := &fakeFetcher{
		html:    map[string]string{"domain.com.au": projectableHTML("Domain ok")},
		blockOn: map[string]bool{"realestate.com.au": true},
	}
	cr := newTestCrawler(ff, bb.URL)

	// Crawl three suburbs: REA should block 3× then the breaker opens for REA;
	// Domain succeeds each time.
	targets := crawlTargets[:3]
	for _, target := range targets {
		_ = cr.crawlSuburb(context.Background(), target)
	}

	if cr.reaBlocks < cr.cfg.maxConsecBlocks {
		t.Errorf("expected REA breaker to reach %d blocks, got %d", cr.cfg.maxConsecBlocks, cr.reaBlocks)
	}
	if cr.stats.blocked != cr.cfg.maxConsecBlocks {
		t.Errorf("blocked stat = %d, want %d (breaker stops further REA fetches)", cr.stats.blocked, cr.cfg.maxConsecBlocks)
	}
	// Domain was never blocked, so it keeps its counter at 0.
	if cr.domBlocks != 0 {
		t.Errorf("domain breaker should stay closed, got %d", cr.domBlocks)
	}
	// brandbrain only ever saw Domain pages (3), never the blocked REA pages.
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Errorf("brandbrain hits = %d, want 3 (Domain only)", got)
	}
}

func TestCrawlSource_BlockedHTMLBodyDetected(t *testing.T) {
	bb, hits := brandbrainServer(t, bondiExtractJSON())
	defer bb.Close()

	// REA returns 200 but with a Kasada interstitial body — must be treated as a
	// block, NOT forwarded to brandbrain.
	ff := &fakeFetcher{html: map[string]string{
		"realestate.com.au": `<html><body>Please enable JavaScript and cookies to continue. (kasada)</body></html>`,
		"domain.com.au":     projectableHTML("Domain ok"),
	}}
	cr := newTestCrawler(ff, bb.URL)

	_ = cr.crawlSuburb(context.Background(), bondi)

	if cr.reaBlocks != 1 {
		t.Errorf("kasada interstitial should trip a block, reaBlocks=%d", cr.reaBlocks)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("brandbrain hits = %d, want 1 (only Domain forwarded; blocked REA skipped)", got)
	}
}

func TestRunCrawl_RespectsMaxSuburbs_viaLoop(t *testing.T) {
	// Mirror runCrawl's target-slicing + pacing loop without a DB/browser: assert
	// CRAWL_MAX_SUBURBS bounds the number of suburbs crawled.
	bb, _ := brandbrainServer(t, bondiExtractJSON())
	defer bb.Close()

	ff := &fakeFetcher{html: map[string]string{
		"realestate.com.au": projectableHTML("x"),
		"domain.com.au":     projectableHTML("x"),
	}}
	cr := newTestCrawler(ff, bb.URL)
	cr.cfg.maxSuburbs = 2

	targets := crawlTargets
	if cr.cfg.maxSuburbs >= 0 && cr.cfg.maxSuburbs < len(targets) {
		targets = targets[:cr.cfg.maxSuburbs]
	}
	for i, target := range targets {
		if i > 0 {
			cr.sleepJitter(context.Background())
		}
		_ = cr.crawlSuburb(context.Background(), target)
	}

	if cr.stats.attempted != 2 {
		t.Errorf("attempted = %d, want 2 (CRAWL_MAX_SUBURBS honored)", cr.stats.attempted)
	}
	// 2 suburbs × 2 sources fetched.
	if len(ff.calls) != 4 {
		t.Errorf("fetch calls = %d, want 4", len(ff.calls))
	}
}

func TestSleepJitter_HonorsPacingAndCancellation(t *testing.T) {
	cr := newTestCrawler(&fakeFetcher{}, "")
	cr.cfg.minDelay = 50 * time.Millisecond
	cr.cfg.maxDelay = 60 * time.Millisecond

	start := time.Now()
	cr.sleepJitter(context.Background())
	if elapsed := time.Since(start); elapsed < cr.cfg.minDelay {
		t.Errorf("sleepJitter returned in %v, want >= %v", elapsed, cr.cfg.minDelay)
	}

	// A cancelled context returns promptly (no hang).
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start = time.Now()
	cr.sleepJitter(ctx)
	if elapsed := time.Since(start); elapsed > 20*time.Millisecond {
		t.Errorf("sleepJitter ignored cancellation, took %v", elapsed)
	}
}

func TestCrawlConfig_HeavyPacingDefaults(t *testing.T) {
	// With no CRAWL_* env set, the headed-browser tier defaults to heavy pacing.
	for _, k := range []string{"CRAWL_MIN_DELAY_MS", "CRAWL_MAX_DELAY_MS", "CRAWL_FETCH_TIMEOUT_S", "CRAWL_PROFILE_DIR", "BRANDBRAIN_URL"} {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
	cfg := loadCrawlConfig()
	if cfg.minDelay != 20*time.Second {
		t.Errorf("default minDelay = %v, want 20s", cfg.minDelay)
	}
	if cfg.maxDelay != 45*time.Second {
		t.Errorf("default maxDelay = %v, want 45s", cfg.maxDelay)
	}
	if cfg.profileDir != "/data/pw-profile" {
		t.Errorf("default profileDir = %q, want /data/pw-profile", cfg.profileDir)
	}
}

func TestCrawlConfig_EnvOverrides(t *testing.T) {
	t.Setenv("CRAWL_MIN_DELAY_MS", "1000")
	t.Setenv("CRAWL_MAX_DELAY_MS", "2000")
	t.Setenv("CRAWL_PROFILE_DIR", "/mnt/warm-profile")
	t.Setenv("BRANDBRAIN_URL", "https://bb.example/x")
	cfg := loadCrawlConfig()
	if cfg.minDelay != time.Second || cfg.maxDelay != 2*time.Second {
		t.Errorf("env override delays = %v/%v", cfg.minDelay, cfg.maxDelay)
	}
	if cfg.profileDir != "/mnt/warm-profile" {
		t.Errorf("profileDir override = %q", cfg.profileDir)
	}
	if cfg.brandbrainURL != "https://bb.example/x" {
		t.Errorf("brandbrainURL override = %q", cfg.brandbrainURL)
	}
}

func TestCrawlSource_BrandbrainErrorSkips(t *testing.T) {
	// brandbrain returns persistent 5xx → extractRealEstate fails after retries →
	// the source yields nothing, the breaker is NOT tripped (a real page was
	// fetched), and nothing is stored.
	orig := brandbrainBackoffs
	brandbrainBackoffs = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	defer func() { brandbrainBackoffs = orig }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	ff := &fakeFetcher{html: map[string]string{
		"realestate.com.au": projectableHTML("real page"),
		"domain.com.au":     projectableHTML("real page"),
	}}
	cr := newTestCrawler(ff, srv.URL)

	obs := cr.crawlSuburb(context.Background(), bondi)
	if len(obs) != 0 {
		t.Errorf("brandbrain failure must yield no observations, got %d", len(obs))
	}
	if cr.reaBlocks != 0 || cr.domBlocks != 0 {
		t.Errorf("a brandbrain error is not a fetch block; breakers should stay closed (rea=%d dom=%d)", cr.reaBlocks, cr.domBlocks)
	}
}

func TestCrawlSource_EmptyProjectionSkipsBrandbrain(t *testing.T) {
	originalClient := brandbrainHTTPClient
	var hits int32
	brandbrainHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		atomic.AddInt32(&hits, 1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(bondiExtractJSON())),
		}, nil
	})}
	defer func() { brandbrainHTTPClient = originalClient }()

	ff := &fakeFetcher{html: map[string]string{
		"realestate.com.au": "<html><body>rendered but schema drifted</body></html>",
	}}
	cr := newTestCrawler(ff, "http://brandbrain.test/extract")

	var logs bytes.Buffer
	originalLogOutput := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(originalLogOutput)

	obs := cr.crawlSource(context.Background(), bondi, "rea", bondi.reaURL(), &cr.reaBlocks)
	if len(obs) != 0 {
		t.Fatalf("empty projection produced observations: %+v", obs)
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("empty projection made %d brandbrain request(s), want 0", got)
	}
	if cr.stats.rejected != 1 {
		t.Fatalf("rejected = %d, want 1 for an empty local projection", cr.stats.rejected)
	}
	if got := logs.String(); !strings.Contains(got, "brandbrain skipped: local aggregate projection empty") {
		t.Fatalf("empty-projection log missing; got %q", got)
	}
}

// TestCrawlConfig_ReadsCDPURL verifies loadCrawlConfig wires CRAWL_CDP_URL into
// the config (the option-(b) host-Chrome-over-CDP selector), and that an unset
// var leaves it empty (the native/launchd persistent-Chromium fallback).
func TestCrawlConfig_ReadsCDPURL(t *testing.T) {
	t.Setenv("CRAWL_CDP_URL", "http://host.docker.internal:9222")
	if got := loadCrawlConfig().cdpURL; got != "http://host.docker.internal:9222" {
		t.Errorf("cdpURL = %q, want http://host.docker.internal:9222", got)
	}

	t.Setenv("CRAWL_CDP_URL", "")
	_ = os.Unsetenv("CRAWL_CDP_URL")
	if got := loadCrawlConfig().cdpURL; got != "" {
		t.Errorf("cdpURL with unset env = %q, want empty", got)
	}
}

// TestSelectFetcherMode_BranchesOnCDPURL pins the pure selection rule: CDP path
// when CRAWL_CDP_URL is set, persistent-Chromium path when it's empty.
func TestSelectFetcherMode_BranchesOnCDPURL(t *testing.T) {
	if m := selectFetcherMode(crawlConfig{cdpURL: "http://host.docker.internal:9222"}); m != fetcherModeCDP {
		t.Errorf("cdpURL set: mode = %v, want fetcherModeCDP", m)
	}
	if s := crawlFetcherMode(crawlConfig{cdpURL: "http://host.docker.internal:9222"}); s != "cdp-host-chrome" {
		t.Errorf("cdpURL set: label = %q, want cdp-host-chrome", s)
	}

	if m := selectFetcherMode(crawlConfig{cdpURL: ""}); m != fetcherModePlaywright {
		t.Errorf("cdpURL empty: mode = %v, want fetcherModePlaywright", m)
	}
	if s := crawlFetcherMode(crawlConfig{cdpURL: ""}); s != "headed-playwright" {
		t.Errorf("cdpURL empty: label = %q, want headed-playwright", s)
	}
}

// TestNewCDPFetcher_UnreachableEndpoint asserts that connecting to a bogus/dead
// CDP endpoint returns a clear "connect over CDP to <url>" error (no browser
// needed). It skips only if the Playwright DRIVER is absent (the CDP client needs
// the driver to even attempt the connect), so the no-driver build still passes.
func TestNewCDPFetcher_UnreachableEndpoint(t *testing.T) {
	cfg := loadCrawlConfig()
	cfg.cdpURL = "http://127.0.0.1:1" // nothing listens here
	cfg.fetchTimeout = 2 * time.Second

	f, err := newCDPFetcher(cfg)
	if err == nil {
		f.Close()
		t.Fatal("expected an error connecting to an unreachable CDP endpoint")
	}
	low := strings.ToLower(err.Error())
	// If the driver itself is missing we get a "playwright driver unavailable"
	// error before the connect is even attempted — that's the hermetic-CI case;
	// the connect-error contract can't be exercised, so skip.
	if strings.Contains(low, "driver unavailable") {
		t.Skip("Playwright driver absent in this environment; CDP connect path not exercised")
	}
	if !strings.Contains(low, "connect over cdp to http://127.0.0.1:1") {
		t.Errorf("error should clearly name the failed CDP connect, got: %v", err)
	}
}

// TestNewCrawlFetcher_SelectsCDPPath confirms the dispatcher routes a set
// CRAWL_CDP_URL through the CDP fetcher (we observe the CDP-specific connect error
// rather than the Playwright launch error). Skips if the driver is absent.
func TestNewCrawlFetcher_SelectsCDPPath(t *testing.T) {
	cfg := loadCrawlConfig()
	cfg.cdpURL = "http://127.0.0.1:1"
	cfg.fetchTimeout = 2 * time.Second

	f, err := newCrawlFetcher(cfg)
	if err == nil {
		f.Close()
		t.Skip("a reachable CDP endpoint exists on 127.0.0.1:1?? — unexpected; skipping")
	}
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "driver unavailable") {
		t.Skip("Playwright driver absent; CDP selection path not exercised")
	}
	if !strings.Contains(low, "connect over cdp") {
		t.Errorf("newCrawlFetcher with CRAWL_CDP_URL should take the CDP path, got: %v", err)
	}
}

// TestPlaywrightFetcher_NoDriver verifies the build is usable without browsers:
// newPlaywrightFetcher returns a clear error when the Playwright driver/browsers
// are absent (the case in CI / on this disk-constrained dev box). We force the
// driver lookup at a directory we know has no driver.
func TestPlaywrightFetcher_NoDriver(t *testing.T) {
	t.Setenv("PLAYWRIGHT_DRIVER_PATH", filepath.Join(t.TempDir(), "no-driver-here"))
	cfg := loadCrawlConfig()
	cfg.profileDir = t.TempDir()

	f, err := newPlaywrightFetcher(cfg)
	if err == nil {
		// If a driver IS somehow present in this environment, don't fail the suite —
		// just clean up. The contract we care about (clear error when ABSENT) can't
		// be exercised here, so skip.
		f.Close()
		t.Skip("a Playwright driver is present in this environment; no-driver path not exercised")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "playwright") {
		t.Errorf("error should mention playwright, got: %v", err)
	}
}

// TestCrawlSource_WithRealFixtureHTML feeds a captured REA suburb page (if present
// locally) through the fake fetcher to brandbrain, proving the HTML→brandbrain→
// Observation path handles a real rendered DOM. The fixture lives OUTSIDE the repo
// (~/projects/housing-fixtures, gitignored/uncommittable) — the test skips if it's
// absent so the suite stays hermetic.
func TestCrawlSource_WithRealFixtureHTML(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	path := filepath.Join(home, "projects", "housing-fixtures", "rea-bondi-2026.html")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture absent (%s) — skipping (this is expected in CI)", path)
	}
	html := unescapeFixture(raw)

	// The fixture is whatever that machine happened to capture, and a capture that
	// missed the SRP JSON blob carries none of the allowlisted aggregate keys
	// (listingsTotal / totalResultsCount / pageSize / totalPages). crawlSource then
	// correctly short-circuits on errBrandbrainProjectionEmpty and never calls
	// brandbrain — so the assertions below would fail on the FIXTURE's shape, not on
	// a defect. That precondition is checked here for the same reason the missing
	// fixture is: this test can only assert what its input can actually exercise.
	// The projection contract itself is covered hermetically in crawl_brandbrain_test.go
	// (incl. TestBrandbrain_ExtractRealEstate_SkipsEmptyProjection).
	var projected brandbrainMediansContract
	if err := json.Unmarshal([]byte(brandbrainMediansPayload(html)), &projected); err != nil {
		t.Fatalf("local aggregate projection did not decode: %v", err)
	}
	if len(projected.AggregateFields) == 0 {
		t.Skipf("fixture %s carries no aggregate SRP blob (0 allowlisted fields) — "+
			"it cannot exercise the HTML→brandbrain path; recapture it from a live SRP", path)
	}

	bb, hits := brandbrainServer(t, bondiExtractJSON())
	defer bb.Close()

	ff := &fakeFetcher{html: map[string]string{"realestate.com.au": html}}
	cr := newTestCrawler(ff, bb.URL)

	obs := cr.crawlSource(context.Background(), bondi, "rea", bondi.reaURL(), &cr.reaBlocks)
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("brandbrain hits = %d, want 1", got)
	}
	if len(obs) == 0 {
		t.Fatal("expected observations from the real fixture HTML routed through brandbrain")
	}
	for _, o := range obs {
		if o.Source != "brandbrain_rea" {
			t.Errorf("source = %q, want brandbrain_rea", o.Source)
		}
	}
}

// unescapeFixture handles the captured fixtures which may be stored as a
// JSON-escaped HTML string (leading quote + \" escapes). If it doesn't look
// JSON-escaped, the bytes are returned as-is.
func unescapeFixture(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if strings.HasPrefix(s, "\"") {
		var unq string
		if err := json.Unmarshal([]byte(s), &unq); err == nil {
			return unq
		}
	}
	return s
}
