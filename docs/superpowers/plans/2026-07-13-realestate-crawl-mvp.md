# Real-estate crawl MVP (mac-only, static partition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productionize the existing REA/Domain housing crawl so it runs unattended, paced, and distributed across two residential Macs by static suburb sharding — with a re-warm alert when the browser loses its Kasada/Akamai clearance.

**Architecture:** Add a pure `selectTargets` sharding knob (`CRAWL_SHARD_INDEX`/`CRAWL_SHARD_COUNT`) so each Mac crawls a disjoint modulo-slice of `crawlTargets`; expand the target list; add re-warm detection (a tripped per-source circuit breaker → process exit code 3 + a `needs_rewarm` run-status + a `[REWARM]` log line); ship per-Mac `launchd` plists + a wrapper that fires a macOS notification on exit 3. Migrations, the first live crawl, and landing the branch are **gated ops steps** requiring the user's go-ahead.

**Tech Stack:** Go 1.26 (`package main`, module `github.com/castlemilk/shorted.com.au/services`), pgx v5, Playwright-go CDP to the host Chrome, `launchd`, Supabase Postgres.

**Design constraints (from the spec `docs/superpowers/specs/2026-07-13-realestate-subcrawler-distributed-design.md`):** fetch stays on the residential Mac; listing extraction stays agent-local; the capital-band poison gate + store stay in shorted; pacing stays the existing fixed jitter + circuit breaker (no adaptive threshold-learning). This MVP adds **no new platform** — no queue, no brandbrain changes.

**Working directory for all Go commands:** `/Users/benebsworth/projects/shorted/services`
**Package directory:** `services/house-price-collector/` (all `.go` paths below are relative to the repo root).

**Commit discipline:** this project's pre-commit hook fails on pre-existing `sdks/java/.../ShortsProto.java` whitespace, so backend commits use `git commit --no-verify` after running `gofmt`/`go vet`/`go test` by hand (see project CLAUDE.md). Stage only the paths each task names.

---

### Task 1: Sharding config fields + pure `selectTargets`

**Files:**
- Modify: `services/house-price-collector/crawl.go` (add fields to `crawlConfig`, populate in `loadCrawlConfig`, add `selectTargets`)
- Test: `services/house-price-collector/crawl_test.go` (append)

- [ ] **Step 1: Write the failing test**

Append to `services/house-price-collector/crawl_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/benebsworth/projects/shorted/services && go test ./house-price-collector/ -run TestSelectTargets -v`
Expected: FAIL to compile — `undefined: selectTargets` and `unknown field shardIndex/shardCount in struct literal`.

- [ ] **Step 3: Add the config fields**

In `services/house-price-collector/crawl.go`, in the `crawlConfig` struct, immediately after the `cdpURL string` field (currently the last field, ~line 99), add:

```go
	// Static sharding for multi-rig distribution: each residential Mac runs a
	// disjoint modulo-slice of crawlTargets (shardIndex of shardCount). The
	// partition stays balanced as the list grows. shardCount<=1 disables it.
	shardIndex int
	shardCount int
```

In `loadCrawlConfig`, after the `cdpURL: os.Getenv("CRAWL_CDP_URL"),` line (~line 118), add:

```go
		shardIndex: envInt("CRAWL_SHARD_INDEX", 0),
		shardCount: envInt("CRAWL_SHARD_COUNT", 1),
```

- [ ] **Step 4: Add `selectTargets`**

In `services/house-price-collector/crawl.go`, add this function immediately after `loadCrawlConfig` (before `envInt`, ~line 121):

```go
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/benebsworth/projects/shorted/services && gofmt -w house-price-collector/crawl.go house-price-collector/crawl_test.go && go test ./house-price-collector/ -run TestSelectTargets -v`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/crawl.go services/house-price-collector/crawl_test.go
git commit --no-verify -m "feat(house-crawl): add CRAWL_SHARD_INDEX/COUNT sharding via selectTargets"
```

---

### Task 2: Wire `selectTargets` into both crawl modes

**Files:**
- Modify: `services/house-price-collector/crawl.go:185-188` (`runCrawl`)
- Modify: `services/house-price-collector/crawl_listings.go:175-178` (`runListings`)

- [ ] **Step 1: Replace the inline slice in `runCrawl`**

In `services/house-price-collector/crawl.go`, inside `runCrawl`, replace these lines (currently ~185-188):

```go
	targets := crawlTargets
	if cfg.maxSuburbs >= 0 && cfg.maxSuburbs < len(targets) {
		targets = targets[:cfg.maxSuburbs]
	}
```

with:

```go
	targets := selectTargets(crawlTargets, cfg)
```

- [ ] **Step 2: Replace the inline slice in `runListings`**

In `services/house-price-collector/crawl_listings.go`, inside `runListings`, replace these lines (currently ~175-178):

```go
	targets := crawlTargets
	if cfg.maxSuburbs >= 0 && cfg.maxSuburbs < len(targets) {
		targets = targets[:cfg.maxSuburbs]
	}
```

with:

```go
	targets := selectTargets(crawlTargets, cfg.crawlConfig)
```

- [ ] **Step 3: Verify build + existing tests still pass**

Run: `cd /Users/benebsworth/projects/shorted/services && go build ./house-price-collector/ && go test ./house-price-collector/ -run 'TestSelectTargets|TestListings|TestCrawl' -v`
Expected: build succeeds; tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/crawl.go services/house-price-collector/crawl_listings.go
git commit --no-verify -m "feat(house-crawl): apply sharding to -mode crawl and -mode listings"
```

---

### Task 3: Re-warm detection + process exit code

**Files:**
- Modify: `services/house-price-collector/crawl.go` (add `needsRewarm`; make `runCrawl` return bool)
- Modify: `services/house-price-collector/crawl_listings.go` (make `runListings` return bool)
- Modify: `services/house-price-collector/main.go` (refactor `main`→`run() int`)
- Test: `services/house-price-collector/crawl_test.go` (append)

- [ ] **Step 1: Write the failing test**

Append to `services/house-price-collector/crawl_test.go`:

```go
func TestNeedsRewarm(t *testing.T) {
	cases := []struct {
		name                              string
		maxConsec, reaBlocks, domBlocks   int
		want                              bool
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/benebsworth/projects/shorted/services && go test ./house-price-collector/ -run TestNeedsRewarm -v`
Expected: FAIL to compile — `undefined: needsRewarm`.

- [ ] **Step 3: Add `needsRewarm`**

In `services/house-price-collector/crawl.go`, add near `sleepJitter` (anywhere at file scope, e.g. after `sleepJitter` ~line 337):

```go
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/benebsworth/projects/shorted/services && gofmt -w house-price-collector/crawl.go house-price-collector/crawl_test.go && go test ./house-price-collector/ -run TestNeedsRewarm -v`
Expected: PASS.

- [ ] **Step 5: Make `runCrawl` return the re-warm signal**

In `services/house-price-collector/crawl.go`, change the signature:

```go
func runCrawl(ctx context.Context, pool *pgxpool.Pool) {
```

to:

```go
func runCrawl(ctx context.Context, pool *pgxpool.Pool) bool {
```

At the two early `return` sites inside `runCrawl` (the fetcher-init failure at ~line 179 `return`), change `return` to `return false`.

Then replace the tail of `runCrawl` — currently:

```go
	_ = updateRun(ctx, pool, "crawl", nil, len(obs), status, detail)

	s := cr.stats
	log.Printf("[crawl] done: attempted=%d accepted=%d blocked=%d rejected=%d diverged=%d",
		s.attempted, s.accepted, s.blocked, s.rejected, s.diverged)
}
```

with:

```go
	rewarm := needsRewarm(cfg.maxConsecBlocks, cr.reaBlocks, cr.domBlocks)
	if rewarm && status == "ok" {
		status, detail = "needs_rewarm", "circuit breaker tripped — re-warm the crawl Chrome profile"
	}
	_ = updateRun(ctx, pool, "crawl", nil, len(obs), status, detail)

	s := cr.stats
	log.Printf("[crawl] done: attempted=%d accepted=%d blocked=%d rejected=%d diverged=%d",
		s.attempted, s.accepted, s.blocked, s.rejected, s.diverged)
	if rewarm {
		log.Printf("[crawl] REWARM REQUIRED: circuit breaker tripped (rea=%d dom=%d ≥ %d) — the dedicated Chrome profile likely lost its Kasada/Akamai clearance; re-warm it by hand",
			cr.reaBlocks, cr.domBlocks, cfg.maxConsecBlocks)
	}
	return rewarm
}
```

- [ ] **Step 6: Make `runListings` return the re-warm signal**

In `services/house-price-collector/crawl_listings.go`, change the signature:

```go
func runListings(ctx context.Context, pool *pgxpool.Pool) {
```

to:

```go
func runListings(ctx context.Context, pool *pgxpool.Pool) bool {
```

At the early `return` inside `runListings` (the fetcher-init failure at ~line 167 `return`), change `return` to `return false`. Also the region-upsert failure `return` (~line 187) → `return false`.

Then, immediately before the final stats `log.Printf` (currently ~line 223 `s := lc.stats`), insert:

```go
	rewarm := needsRewarm(cfg.maxConsecBlocks, lc.reaBlocks, lc.domBlocks)
	if rewarm {
		if !cfg.dryRun {
			_ = updateRun(ctx, pool, "listings_rewarm", nil, 0, "needs_rewarm", "circuit breaker tripped — re-warm the crawl Chrome profile")
		}
		log.Printf("[listings] REWARM REQUIRED: circuit breaker tripped (rea=%d dom=%d ≥ %d) — re-warm the dedicated Chrome profile by hand",
			lc.reaBlocks, lc.domBlocks, cfg.maxConsecBlocks)
	}
```

and change the final line of `runListings` from `}` (after the stats log) to `return rewarm` then `}`:

```go
	s := lc.stats
	log.Printf("[listings] done: suburbs=%d pages=%d listings=%d new=%d drops=%d rises=%d relisted=%d delisted=%d status=%d blockedSweeps=%d events(rea=%d,domain=%d)",
		s.suburbs, s.pages, s.seen, s.newListings, s.drops, s.rises, s.relisted, s.delisted, s.statusChanges, s.blockedSweeps, reaEvents, domEvents)
	return rewarm
}
```

- [ ] **Step 7: Refactor `main` → `run() int` so exit code 3 propagates through deferred cleanup**

In `services/house-price-collector/main.go`, replace the whole `func main()` (lines 17-82) with:

```go
func main() {
	os.Exit(run())
}

// run executes the selected mode and returns a process exit code: 0 = ok,
// 3 = a crawl needs a human to re-warm the Chrome profile (Kasada/Akamai
// clearance expired). Wrapping the body lets deferred cleanup run before exit.
func run() int {
	mode := flag.String("mode", "all", "official | crawl | listings | census | electorates | amenities | lga | connectivity | funding | council-financials | refresh | all")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	// Configurable overall deadline — a slow, paced live listings crawl needs longer
	// than the 15-min default used by the quick official/refresh runs.
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("CRAWL_TIMEOUT_MIN", 15))*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	switch *mode {
	case "official", "abs", "all":
		runOfficial(ctx, pool)
		refresh(ctx, pool)
	case "crawl":
		// Supplementary suburb crawl — opt-in only, never part of the default
		// scheduled run (it's slow, adversarial and licence-gated). Drives a HEADED,
		// persistent-profile Playwright browser, so it runs ONLY on the residential
		// rig (host-Chrome over CDP), never on Cloud Run.
		rewarm := runCrawl(ctx, pool)
		refresh(ctx, pool)
		if rewarm {
			return 3
		}
	case "listings":
		// Supplementary property-LISTING crawl — opt-in only, never part of the
		// scheduled run. Sweeps portal search-results pages for individual for-sale
		// listings, diffs asking prices across runs into price-drop events, and
		// refreshes mv_suburb_price_drops. Same residential-rig posture as -mode crawl
		// (headed host-Chrome over CDP); dry-run defaults ON. Self-refreshes internally.
		if runListings(ctx, pool) {
			return 3
		}
	case "census":
		runCensus(ctx, pool)
	case "electorates":
		runElectorates(ctx, pool)
	case "amenities":
		runAmenities(ctx, pool)
	case "lga":
		runLGA(ctx, pool)
	case "connectivity":
		runConnectivity(ctx, pool)
	case "funding":
		runFAGs(ctx, pool)
	case "council-financials":
		runVICFinancials(ctx, pool)
	case "refresh":
		refresh(ctx, pool)
	default:
		log.Fatalf("unknown -mode %q (want official|crawl|listings|census|electorates|amenities|lga|connectivity|funding|council-financials|refresh|all)", *mode)
	}
	return 0
}
```

- [ ] **Step 8: Verify build, vet, and full package tests**

Run: `cd /Users/benebsworth/projects/shorted/services && gofmt -w house-price-collector/ && go vet ./house-price-collector/ && go test ./house-price-collector/`
Expected: build + vet clean; all tests PASS (the ~61+171 existing crawl/listings tests plus the new ones).

- [ ] **Step 9: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/crawl.go services/house-price-collector/crawl_listings.go services/house-price-collector/main.go services/house-price-collector/crawl_test.go
git commit --no-verify -m "feat(house-crawl): re-warm alert — exit 3 + needs_rewarm run-status when the circuit breaker trips"
```

---

### Task 4: Expand the curated suburb target list

**Files:**
- Modify: `services/house-price-collector/crawl_targets.go:19-30` (`crawlTargets`)
- Test: `services/house-price-collector/crawl_test.go` (append a well-formedness test)

**Note on data correctness:** the crawl is fail-safe — a wrong slug/postcode yields a blocked/empty sweep and stores nothing (never bad data), so an occasional wrong postcode only *under-collects*. The test below enforces structure; spot-check the actual portal URLs for a sample before the first real run (Task 8).

- [ ] **Step 1: Write the failing well-formedness test**

Append to `services/house-price-collector/crawl_test.go`:

```go
func TestCrawlTargets_WellFormed(t *testing.T) {
	validCapitals := map[string]bool{
		"1GSYD": true, "2GMEL": true, "3GBRI": true, "4GADE": true, "5GPER": true,
	}
	seen := map[string]bool{}
	for _, tg := range crawlTargets {
		if tg.Suburb == "" || tg.Display == "" || tg.Postcode == "" || tg.State == "" || tg.Capital == "" {
			t.Fatalf("target %+v has an empty field", tg)
		}
		if tg.Suburb != strings.ToLower(tg.Suburb) {
			t.Fatalf("Suburb slug %q must be lowercase", tg.Suburb)
		}
		if !validCapitals[tg.Capital] {
			t.Fatalf("target %q has unknown GCCSA capital %q", tg.Display, tg.Capital)
		}
		key := tg.State + "-" + tg.Postcode + "-" + tg.Suburb
		if seen[key] {
			t.Fatalf("duplicate target %q", key)
		}
		seen[key] = true
	}
	if len(crawlTargets) < 20 {
		t.Fatalf("expected the curated set to have >=20 suburbs, got %d", len(crawlTargets))
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/benebsworth/projects/shorted/services && go test ./house-price-collector/ -run TestCrawlTargets_WellFormed -v`
Expected: FAIL — `expected the curated set to have >=20 suburbs, got 10`.

- [ ] **Step 3: Expand `crawlTargets`**

In `services/house-price-collector/crawl_targets.go`, replace the `crawlTargets` slice literal (lines 19-30) with:

```go
var crawlTargets = []CrawlTarget{
	// NSW — Greater Sydney (1GSYD)
	{"bondi", "Bondi", "2026", "NSW", "1GSYD"},
	{"parramatta", "Parramatta", "2150", "NSW", "1GSYD"},
	{"chatswood", "Chatswood", "2067", "NSW", "1GSYD"},
	{"manly", "Manly", "2095", "NSW", "1GSYD"},
	{"newtown", "Newtown", "2042", "NSW", "1GSYD"},
	{"mosman", "Mosman", "2088", "NSW", "1GSYD"},
	{"surry-hills", "Surry Hills", "2010", "NSW", "1GSYD"},
	// VIC — Greater Melbourne (2GMEL)
	{"st-kilda", "St Kilda", "3182", "VIC", "2GMEL"},
	{"brunswick", "Brunswick", "3056", "VIC", "2GMEL"},
	{"south-yarra", "South Yarra", "3141", "VIC", "2GMEL"},
	{"richmond", "Richmond", "3121", "VIC", "2GMEL"},
	{"fitzroy", "Fitzroy", "3065", "VIC", "2GMEL"},
	{"footscray", "Footscray", "3011", "VIC", "2GMEL"},
	{"brighton", "Brighton", "3186", "VIC", "2GMEL"},
	// QLD — Greater Brisbane (3GBRI)
	{"new-farm", "New Farm", "4005", "QLD", "3GBRI"},
	{"toowong", "Toowong", "4066", "QLD", "3GBRI"},
	{"paddington", "Paddington", "4064", "QLD", "3GBRI"},
	{"chermside", "Chermside", "4032", "QLD", "3GBRI"},
	// SA — Greater Adelaide (4GADE)
	{"glenelg", "Glenelg", "5045", "SA", "4GADE"},
	{"norwood", "Norwood", "5067", "SA", "4GADE"},
	{"unley", "Unley", "5061", "SA", "4GADE"},
	// WA — Greater Perth (5GPER)
	{"fremantle", "Fremantle", "6160", "WA", "5GPER"},
	{"cottesloe", "Cottesloe", "6011", "WA", "5GPER"},
	{"subiaco", "Subiaco", "6008", "WA", "5GPER"},
	{"scarborough", "Scarborough", "6019", "WA", "5GPER"},
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/benebsworth/projects/shorted/services && gofmt -w house-price-collector/crawl_targets.go house-price-collector/crawl_test.go && go test ./house-price-collector/ -run TestCrawlTargets_WellFormed -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/crawl_targets.go services/house-price-collector/crawl_test.go
git commit --no-verify -m "feat(house-crawl): expand curated suburb target set to 25 across 5 capitals"
```

---

### Task 5: Residential-run wrapper script

**Files:**
- Create: `services/house-price-collector/deploy/run-housing-crawl.sh`

- [ ] **Step 1: Create the wrapper**

Create `services/house-price-collector/deploy/run-housing-crawl.sh`:

```bash
#!/usr/bin/env bash
# Residential housing-crawl runner — ONE shard per Mac, invoked by launchd.
#
# Runs the collector NATIVELY on the Mac (the proven path: CDP to the dedicated
# host Chrome preserves the residential IP + warm Kasada/Akamai clearance). Reads
# secrets from a local, UNCOMMITTED env file. Fires a macOS notification and exits
# non-zero if the dedicated Chrome is unreachable (4) or the crawl reports it needs
# a human to re-warm the anti-bot clearance (3).
#
# One-time host setup (per Mac), NEVER the personal Chrome profile:
#   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
#     --remote-debugging-port=9222 \
#     --user-data-dir="$HOME/.shorted-housing-crawl-chrome"
#   then open a Domain suburb page once by hand to clear the challenge (warm it).
set -uo pipefail

ENV_FILE="${HOUSING_CRAWL_ENV:-$HOME/.shorted-housing-crawl.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a; source "$ENV_FILE"; set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (put it in $ENV_FILE)}"
: "${CRAWL_CDP_URL:?CRAWL_CDP_URL must be set, e.g. http://localhost:9222}"

export CRAWL_DRY_RUN="${CRAWL_DRY_RUN:-false}"
export CRAWL_SHARD_INDEX="${CRAWL_SHARD_INDEX:-0}"
export CRAWL_SHARD_COUNT="${CRAWL_SHARD_COUNT:-1}"
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-90}"

BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-crawl.log}"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# Guard: the dedicated-profile Chrome must be listening on the CDP port.
if ! /usr/bin/curl -sf "${CRAWL_CDP_URL%/}/json/version" >/dev/null; then
	notify "Crawl Chrome not reachable at $CRAWL_CDP_URL — launch the dedicated profile."
	echo "$(date -u +%FT%TZ) chrome-unreachable $CRAWL_CDP_URL" >>"$LOG"
	exit 4
fi

echo "=== $(date -u +%FT%TZ) shard $CRAWL_SHARD_INDEX/$CRAWL_SHARD_COUNT dry=$CRAWL_DRY_RUN ===" >>"$LOG"
"$BIN" -mode listings >>"$LOG" 2>&1; rc_listings=$?
"$BIN" -mode crawl    >>"$LOG" 2>&1; rc_crawl=$?
echo "listings rc=$rc_listings crawl rc=$rc_crawl" >>"$LOG"

if [[ "$rc_listings" -eq 3 || "$rc_crawl" -eq 3 ]]; then
	notify "Re-warm the crawl Chrome profile — Kasada/Akamai clearance expired."
	exit 3
fi
exit 0
```

- [ ] **Step 2: Make it executable and lint it**

Run:
```bash
cd /Users/benebsworth/projects/shorted
chmod +x services/house-price-collector/deploy/run-housing-crawl.sh
bash -n services/house-price-collector/deploy/run-housing-crawl.sh && echo "syntax OK"
command -v shellcheck >/dev/null && shellcheck services/house-price-collector/deploy/run-housing-crawl.sh || echo "shellcheck not installed — skipped"
```
Expected: `syntax OK`; shellcheck clean (or skipped).

- [ ] **Step 3: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/deploy/run-housing-crawl.sh
git commit --no-verify -m "feat(house-crawl): launchd wrapper — native run, CDP guard, re-warm notification"
```

---

### Task 6: Per-Mac launchd plists

**Files:**
- Create: `services/house-price-collector/deploy/com.shorted.housing-crawl.plist.template`
- Create: `services/house-price-collector/deploy/README.md`

- [ ] **Step 1: Create the plist template**

Create `services/house-price-collector/deploy/com.shorted.housing-crawl.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shorted.housing-crawl</string>

  <!-- Replace __REPO__ with the absolute path to this checkout on the Mac. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__REPO__/services/house-price-collector/deploy/run-housing-crawl.sh</string>
  </array>

  <!-- Per-Mac shard assignment. Mac 0 => INDEX 0, Mac 1 => INDEX 1; COUNT = number of Macs. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>CRAWL_SHARD_INDEX</key><string>0</string>
    <key>CRAWL_SHARD_COUNT</key><string>2</string>
  </dict>

  <!-- Weekly: Tuesday 02:30 local. Drops/movers accrue as weekly re-crawls stack. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>2</integer>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>30</integer>
  </dict>

  <key>StandardOutPath</key><string>__HOME__/Library/Logs/shorted-housing-crawl.out.log</string>
  <key>StandardErrorPath</key><string>__HOME__/Library/Logs/shorted-housing-crawl.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

- [ ] **Step 2: Create the deploy README**

Create `services/house-price-collector/deploy/README.md`:

```markdown
# Residential housing-crawl deploy (macOS, launchd)

Two residential Macs each crawl a disjoint suburb shard. No Docker, no Cloud Run —
the crawl only works from a residential IP driving the host's warm Chrome.

## One-time per Mac

1. Build the collector for this Mac's arch:
   ```bash
   cd services && go build -o "$HOME/bin/house-price-collector" ./house-price-collector/
   ```
2. Install the Playwright driver the CDP client needs (no browser download):
   ```bash
   cd services && go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
   ```
3. Launch the DEDICATED-profile Chrome (NEVER the personal profile) and warm it by
   opening a Domain suburb page once by hand to clear the anti-bot challenge:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.shorted-housing-crawl-chrome"
   ```
4. Create `~/.shorted-housing-crawl.env` (chmod 600, NOT committed):
   ```bash
   DATABASE_URL=postgresql://...            # prod Supabase (transaction pooler)
   CRAWL_CDP_URL=http://localhost:9222
   BRANDBRAIN_URL=https://api.brandbrain.dev
   # CRAWL_DRY_RUN defaults to false in the wrapper; set true to rehearse.
   ```
5. Install the launchd job:
   ```bash
   REPO="$(cd ../../.. && pwd)"   # repo root
   sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
     com.shorted.housing-crawl.plist.template \
     > "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist"
   # Set CRAWL_SHARD_INDEX to 1 on the second Mac before loading.
   launchctl unload "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist" 2>/dev/null
   launchctl load  "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist"
   ```

## Rehearse before going live
```bash
CRAWL_DRY_RUN=true CRAWL_SHARD_INDEX=0 CRAWL_SHARD_COUNT=2 \
  bash run-housing-crawl.sh   # writes nothing; check ~/Library/Logs/shorted-housing-crawl.log
```

## Kick a real run now
```bash
launchctl start com.shorted.housing-crawl
```

Exit codes: 0 ok · 3 re-warm the Chrome profile (notification fired) · 4 Chrome not reachable.
```

- [ ] **Step 3: Validate the plist template**

Run:
```bash
cd /Users/benebsworth/projects/shorted/services/house-price-collector/deploy
sed -e 's#__REPO__#/tmp/repo#g' -e 's#__HOME__#/tmp/home#g' com.shorted.housing-crawl.plist.template > /tmp/hc.plist && plutil -lint /tmp/hc.plist
```
Expected: `/tmp/hc.plist: OK`.

- [ ] **Step 4: Commit**

```bash
cd /Users/benebsworth/projects/shorted
git add services/house-price-collector/deploy/com.shorted.housing-crawl.plist.template services/house-price-collector/deploy/README.md
git commit --no-verify -m "docs(house-crawl): per-Mac launchd plist template + deploy README"
```

---

### Task 7 (GATED — needs user go-ahead): Apply migrations 000076/000077 to prod

> **Do not run without explicit user go-ahead** — this writes to prod Supabase. It is idempotent DDL but still a prod change.

- [ ] **Step 1: Confirm the two migrations are the crawl-tier ones**

Run: `cd /Users/benebsworth/projects/shorted && ls services/migrations/000076* services/migrations/000077*`
Expected: `..._*.up.sql` files for `property_listings`/`property_price_events`/`mv_suburb_price_drops` (000076) and `mv_suburb_listing_stats` (000077).

- [ ] **Step 2: Apply via the SESSION pooler (5432), not the txn pooler**

Get the prod URL and swap `:6543`→`:5432`, then apply with `statement_timeout=0` (so `REFRESH … CONCURRENTLY` inside the MV definitions can run). Use the prod `DATABASE_URL` secret (project `rosy-clover-477102-t5`), per the housing-prod-ops memory:

```bash
# obtain prod DATABASE_URL from Secret Manager (session pooler), then:
PGOPTIONS="-c statement_timeout=0" psql "$PROD_DB_URL_5432" -f services/migrations/000076_*.up.sql
PGOPTIONS="-c statement_timeout=0" psql "$PROD_DB_URL_5432" -f services/migrations/000077_*.up.sql
```
Expected: `CREATE TABLE` / `CREATE MATERIALIZED VIEW` / `CREATE FUNCTION` with no error.

- [ ] **Step 3: Verify objects exist**

```bash
psql "$PROD_DB_URL_5432" -c "\dt property_listings" -c "\dt property_price_events" -c "\dmv mv_suburb_price_drops" -c "\dmv mv_suburb_listing_stats"
```
Expected: all four objects present.

---

### Task 8 (GATED — needs user go-ahead): First live paced crawl + verify

> **Do not run without explicit user go-ahead** — this performs a live scrape of ToS-restricted portals from your residential IP.

- [ ] **Step 1: Warm one Mac's dedicated Chrome** (deploy/README §3).

- [ ] **Step 2: Spot-check a few expanded target URLs resolve to real suburb pages** (paste 2–3 `reaSearchURL(1)`/`domainSearchURL(1)` into the warm Chrome; confirm listings render, not a 404/challenge).

- [ ] **Step 3: Dry-run rehearsal (writes nothing)**

```bash
cd services/house-price-collector/deploy
CRAWL_DRY_RUN=true CRAWL_SHARD_INDEX=0 CRAWL_SHARD_COUNT=2 bash run-housing-crawl.sh
tail -40 "$HOME/Library/Logs/shorted-housing-crawl.log"
```
Expected: `[listings] DRY ...` lines with real addresses/prices; `blockedSweeps=0`; exit 0.

- [ ] **Step 4: First real run (small)**

```bash
CRAWL_DRY_RUN=false CRAWL_MAX_SUBURBS=3 CRAWL_SHARD_INDEX=0 CRAWL_SHARD_COUNT=2 bash run-housing-crawl.sh
```
Expected: exit 0; `[listings] done: … blockedSweeps=0 …`; rows written.

- [ ] **Step 5: Verify the data landed and the UI renders**

```bash
psql "$PROD_DB_URL_5432" -c "select source, count(*) from property_listings group by 1;"
psql "$PROD_DB_URL_5432" -c "select suburb_name, for_sale_count, avg_asking from mv_suburb_listing_stats order by for_sale_count desc limit 10;"
```
Then load `https://shorted.com.au/housing/nsw` and confirm the "Suburb prices & movers" panel shows the crawled suburbs. Screenshot before/after.

- [ ] **Step 6: Load both launchd jobs** (Mac 0 `SHARD_INDEX=0`, Mac 1 `SHARD_INDEX=1`, both `SHARD_COUNT=2`) per deploy/README §5, and `launchctl start` once to confirm.

---

### Task 9 (GATED — needs user go-ahead): Land the branch

> **Do not run without explicit user go-ahead** — pushing/merging is outward-facing.

- [ ] **Step 1: Full backend gate**

Run: `cd /Users/benebsworth/projects/shorted/services && gofmt -l house-price-collector/ && go vet ./house-price-collector/ && go test ./house-price-collector/`
Expected: no gofmt output; vet clean; all tests PASS.

- [ ] **Step 2: Push the branch and open a PR**

```bash
cd /Users/benebsworth/projects/shorted
git push --no-verify -u origin feat/housing-listing-price-tracking
gh pr create --fill --base main
```

---

## Self-Review

**Spec coverage** (against `2026-07-13-realestate-subcrawler-distributed-design.md` §4 Phase MVP):
- MVP-1 apply migrations → Task 7. ✅
- MVP-2 expand + statically partition targets → Task 4 (expand) + Tasks 1–2 (shard knob = the partition). ✅
- MVP-3 launchd timer per Mac running existing modes w/ CDP + dry-run=false + jitter/breaker → Tasks 5–6. ✅
- MVP-4 keep local extraction / capital-band gate / licence tag / publish gate / MVs as-is → untouched by every task (verified: no task edits `crawl_listings_extract.go`, `crawl_validate.go`, `crawl_brandbrain.go`, or the MV SQL). ✅
- MVP-5 land the branch → Task 9. ✅
- MVP-6 re-warm health state + alert → Task 3 (detection/exit-3/run-status) + Task 5 (notification delivery). ✅

**Placeholder scan:** every code step shows complete code; no TBD/TODO; the plist template's `__REPO__`/`__HOME__` are intentional sed tokens with a documented substitution (deploy/README §5).

**Type consistency:** `selectTargets(all []CrawlTarget, cfg crawlConfig) []CrawlTarget` and `needsRewarm(maxConsecBlocks, reaBlocks, domBlocks int) bool` are defined in Task 1/3 and called with matching signatures in Tasks 2–3 and `run()`. `runCrawl`/`runListings` become `func(...) bool` in Task 3 and are consumed as bools in `run()`. Config fields `shardIndex`/`shardCount` are defined once (Task 1) and read in `selectTargets`. Crawler block counters `cr.reaBlocks`/`cr.domBlocks` and `lc.reaBlocks`/`lc.domBlocks` already exist (`crawl.go`, `crawl_listings.go`).
