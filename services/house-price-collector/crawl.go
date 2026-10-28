package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"strconv"
	"time"
)

// The Tier-3 crawl. SUPPLEMENTARY and OPTIONAL: realestate.com.au (Kasada) and
// domain.com.au (Akamai) actively block and — in REA's case — feed false data to
// suspected bots. The stealth native/chromedp waterfall this tier originally used
// is reliably DETECTED and blocked/poisoned from a residential IP, so the page
// FETCH is now done with a real, HEADED, persistent-profile browser (see
// crawl_playwright.go) — the only client that survives Kasada/Akamai from a
// residential egress. An allowlisted counts/aggregate-only projection of the
// rendered HTML is then handed to brandbrain's ExtractRealEstate LLM
// (crawl_brandbrain.go) for the suburb-aggregate fields; listing rows stay local.
//
// This tier is built to FAIL SAFE: it never blocks the pipeline, never stores a
// value that fails validation, and self-throttles via a per-site circuit breaker.
// The official ABS/RBA backbone is the source of truth; the crawl only ever adds
// licence-gated suburb detail on top.

// htmlFetcher fetches a fully-rendered page and returns its HTML, the final URL
// after any redirects, and an error. The orchestration depends only on this seam
// (not on any concrete engine), which keeps the crawl flow unit-testable with a
// fake fetcher and lets the real fetch be a headed Playwright browser.
type htmlFetcher interface {
	fetch(ctx context.Context, url string) (html []byte, finalURL string, err error)
}

// crawlFetcher is the lifecycle-owning fetcher returned by newCrawlFetcher: a
// concrete browser-backed fetcher that the run owns and must Close(). Both
// fetchers (CDP-to-host-Chrome and self-launched persistent Chromium) satisfy it.
type crawlFetcher interface {
	htmlFetcher
	Close()
}

// fetcherMode names the browser-execution model selected for a run.
type fetcherMode int

const (
	// fetcherModePlaywright launches a self-contained, headed persistent
	// Chromium inside this process (native/launchd fallback).
	fetcherModePlaywright fetcherMode = iota
	// fetcherModeCDP connects over CDP to an already-running Chrome — in
	// option (b), the HOST's macOS Chrome reached via host.docker.internal.
	fetcherModeCDP
	// fetcherModeGateway POSTs each URL to a brandbrain macOS-agent residential
	// fetch gateway (CRAWL_GATEWAY_URL), which drives a warm host Chrome and
	// returns HTML. No browser in this process; residential egress is the agent's.
	fetcherModeGateway
)

// selectFetcherMode is the pure, testable selection rule. CRAWL_FETCH_MODE, when
// set, is an explicit override (gateway|cdp|playwright) and wins outright.
// Otherwise the precedence is gateway > cdp > playwright: CRAWL_GATEWAY_URL set
// -> POST to the brandbrain agent gateway; else CRAWL_CDP_URL set -> drive the
// host Chrome over CDP; else self-launch a persistent Chromium.
func selectFetcherMode(cfg crawlConfig) fetcherMode {
	switch cfg.fetchModeOverride {
	case "gateway":
		return fetcherModeGateway
	case "cdp":
		return fetcherModeCDP
	case "playwright":
		return fetcherModePlaywright
	}
	if cfg.gatewayURL != "" {
		return fetcherModeGateway
	}
	if cfg.cdpURL != "" {
		return fetcherModeCDP
	}
	return fetcherModePlaywright
}

func crawlFetcherMode(cfg crawlConfig) string {
	switch selectFetcherMode(cfg) {
	case fetcherModeGateway:
		return "gateway-residential"
	case fetcherModeCDP:
		return "cdp-host-chrome"
	default:
		return "headed-playwright"
	}
}

// newCrawlFetcher constructs the fetcher for the run, branching on the selected
// fetcherMode. Errors are returned (never panics) so runCrawl can fail
// non-fatally — the official ABS/RBA backbone is unaffected either way.
func newCrawlFetcher(cfg crawlConfig) (crawlFetcher, error) {
	if o := cfg.fetchModeOverride; o != "" && o != "gateway" && o != "cdp" && o != "playwright" {
		log.Printf("[crawl] ignoring unrecognized CRAWL_FETCH_MODE=%q (want gateway|cdp|playwright) — auto-selecting %s", o, crawlFetcherMode(cfg))
	}
	switch selectFetcherMode(cfg) {
	case fetcherModeGateway:
		return newGatewayFetcher(cfg)
	case fetcherModeCDP:
		return newCDPFetcher(cfg)
	default:
		return newPlaywrightFetcher(cfg)
	}
}

type crawlConfig struct {
	maxSuburbs      int
	minDelay        time.Duration
	maxDelay        time.Duration
	dryRun          bool
	maxConsecBlocks int
	fetchTimeout    time.Duration
	profileDir      string
	// cdpURL, when set, selects the "option (b)" local-agent execution model:
	// instead of the container rendering pages itself, the collector drives the
	// HOST's macOS-native Chrome over CDP (the only browser proven to beat
	// Kasada/Akamai). The container reaches the host via host.docker.internal.
	// Empty -> launch a self-contained persistent Chromium (native/launchd
	// fallback). See newCDPFetcher / newPlaywrightFetcher.
	cdpURL string
	// Static sharding for multi-rig distribution: each residential Mac runs a
	// disjoint modulo-slice of crawlTargets (shardIndex of shardCount). The
	// partition stays balanced as the list grows. shardCount<=1 disables it.
	shardIndex int
	shardCount int
	// gatewayURL, when set, selects the gateway-residential execution model:
	// each URL is POSTed to a brandbrain macOS-agent residential fetch gateway
	// (a warm host Chrome living behind this HTTP endpoint) instead of this
	// process driving a browser itself. See newGatewayFetcher.
	gatewayURL    string // CRAWL_GATEWAY_URL  e.g. http://<mac-lan-ip>:7799
	gatewayToken  string // CRAWL_GATEWAY_TOKEN
	gatewayWaitMS int    // CRAWL_GATEWAY_WAIT_MS (challenge-settle budget)
	// fetchModeOverride, when non-empty, forces a specific fetcherMode
	// regardless of gatewayURL/cdpURL (gateway|cdp|playwright). See
	// selectFetcherMode.
	fetchModeOverride string // CRAWL_FETCH_MODE = gateway|cdp|playwright (optional)
}

func loadCrawlConfig() crawlConfig {
	return crawlConfig{
		maxSuburbs: envInt("CRAWL_MAX_SUBURBS", len(crawlTargets)),
		// HEAVIER pacing than the old stealth tier: a headed browser hitting a
		// Kasada/Akamai-protected site must look human (20–45s between suburbs).
		minDelay: time.Duration(envInt("CRAWL_MIN_DELAY_MS", 20000)) * time.Millisecond,
		maxDelay: time.Duration(envInt("CRAWL_MAX_DELAY_MS", 45000)) * time.Millisecond,
		// Default to dry-run ON for this ToS-restricted tier: it only WRITES to
		// house_prices when CRAWL_DRY_RUN is explicitly "false". An accidental
		// `-mode crawl` is then a no-op harvest, never a silent persist of
		// proprietary REA/Domain medians.
		dryRun:            os.Getenv("CRAWL_DRY_RUN") != "false",
		maxConsecBlocks:   envInt("CRAWL_MAX_CONSEC_BLOCKS", 3),
		fetchTimeout:      time.Duration(envInt("CRAWL_FETCH_TIMEOUT_S", 60)) * time.Second,
		profileDir:        envStr("CRAWL_PROFILE_DIR", "/data/pw-profile"),
		cdpURL:            os.Getenv("CRAWL_CDP_URL"), // e.g. http://host.docker.internal:9222
		shardIndex:        envInt("CRAWL_SHARD_INDEX", 0),
		shardCount:        envInt("CRAWL_SHARD_COUNT", 1),
		gatewayURL:        os.Getenv("CRAWL_GATEWAY_URL"),
		gatewayToken:      os.Getenv("CRAWL_GATEWAY_TOKEN"),
		gatewayWaitMS:     envInt("CRAWL_GATEWAY_WAIT_MS", 8000),
		fetchModeOverride: os.Getenv("CRAWL_FETCH_MODE"),
	}
}

// selectTargets applies static sharding then the maxSuburbs cap, deterministically.
// With shardCount>1 each rig takes the targets whose index ≡ shardIndex (mod
// shardCount) — disjoint across rigs and balanced as the list grows. An
// out-of-range shardIndex yields an empty set (callers already log an empty run).
func selectTargets(all []CrawlTarget, cfg crawlConfig) []CrawlTarget {
	targets := all
	if cfg.shardCount > 1 {
		shard := make([]CrawlTarget, 0, len(all)/cfg.shardCount+1)
		for i, t := range all {
			if i%cfg.shardCount == cfg.shardIndex {
				shard = append(shard, t)
			}
		}
		targets = shard
	}
	if cfg.maxSuburbs >= 0 && cfg.maxSuburbs < len(targets) {
		targets = targets[:cfg.maxSuburbs]
	}
	return targets
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		// Don't silently swallow a typo: a SET-but-unparseable value used to fall
		// through to the default with no signal, so a misconfigured rig ran with a
		// silently-wrong knob. Warn loudly and keep the default.
		log.Printf("[config] %s=%q is not a valid integer — using default %d", key, v, def)
		return def
	}
	return n
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type fetchOutcome int

const (
	outcomeOK fetchOutcome = iota
	outcomeBlocked
	outcomeError
)

type crawler struct {
	fetcher   htmlFetcher        // headed Playwright in prod; a fake in tests
	baselines map[string]float64 // capital GCCSA region_code -> trusted ABS median
	cfg       crawlConfig
}

// fetchPage fetches one URL via the injected htmlFetcher and classifies the
// outcome. A block (Kasada/Akamai 403/429-style) trips the circuit breaker; any
// other error is transient and simply skips this source for this run.
func (cr *crawler) fetchPage(ctx context.Context, url string) ([]byte, string, fetchOutcome) {
	html, finalURL, err := cr.fetcher.fetch(ctx, url)
	if err != nil {
		if isBlockError(err) {
			return nil, "", outcomeBlocked
		}
		return nil, "", outcomeError
	}
	if looksBlocked(html, finalURL) {
		return nil, "", outcomeBlocked
	}
	return html, finalURL, outcomeOK
}

// needsRewarm reports whether a source's circuit breaker tripped — every recent
// fetch to that source was blocked, the signature of an expired Kasada/Akamai
// clearance that a human must re-warm on the dedicated Chrome profile. It drives
// the re-warm alert (process exit code 3). A disabled breaker (maxConsec<=0) never
// signals.
func needsRewarm(maxConsecBlocks, reaBlocks, domBlocks int) bool {
	if maxConsecBlocks <= 0 {
		return false
	}
	return reaBlocks >= maxConsecBlocks || domBlocks >= maxConsecBlocks
}

func (cr *crawler) sleepJitter(ctx context.Context) {
	d := cr.cfg.minDelay
	if cr.cfg.maxDelay > cr.cfg.minDelay {
		d += time.Duration(rand.Int63n(int64(cr.cfg.maxDelay - cr.cfg.minDelay)))
	}
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}
