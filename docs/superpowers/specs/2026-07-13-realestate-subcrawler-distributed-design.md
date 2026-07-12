# Real-estate sub-crawler in brandbrain + distributed residential/mobile agents

**Status:** Draft design v2 (post adversarial review) — awaiting user review
**Date:** 2026-07-13
**Author:** Ben Ebsworth (with Claude)
**Related:** `2026-06-24-residential-housing-crawl-design.md`, memories `housing-residential-crawl`, `property-listings-price-tracking`, `intelligent-crawler`, `housing-crawl-tier-extension`

> **What changed from v1 (a 5-lens adversarial review corrected several load-bearing errors):**
> - brandbrain **already ships a residential desktop agent** (`backend/cmd/agent/`: launchd plist, OAuth + scoped revocable tokens, `GET /api/v1/agent/poll` + `POST /api/v1/agent/results`, a 64MB upload cap, a Swift-menubar integration surface) and **has Postgres** (pgx repos). v1 proposed to *build* this from scratch on an unauthenticated `makeHandler` path — that was wrong and would have re-opened a known OOM.
> - **iOS/cellular is the *weakest* egress, not the strongest** (WKWebView can't inherit Safari's warm Kasada cookie; no airplane-mode API for IP rotation; ~30s background suspension). So it does **not** justify building a bespoke queue now. It's gated behind a Phase-0 spike.
> - The near-term goal ("productionize the existing prototype") needs **no new platform at all**: the prototype already works end-to-end; productionizing = apply migrations + partition targets across 2 macs + schedule + land the branch.
> - Two v1 decisions are reversed: (a) job = one **suburb sweep**, not one URL; (b) listing extraction stays **agent-local**, not ported into brandbrain (keeps microsecond parsing off the 502-prone LLM pod and keeps ToS-restricted PII out of a third party's store).

---

## 1. Problem & goal

Crawl AU real-estate portals (realestate.com.au / Domain) for suburb medians and for-sale listings, on an ongoing schedule, and:

1. Make **brandbrain the home** of the real-estate crawler — as the *orchestration + extraction brain*, not the fetcher.
2. **Intelligently slow down and distribute** the crawl across **local (residential IP)** — and *possibly*, if proven, **mobile (cellular IP)** — egress, because that is the only egress that beats the portals' anti-bot.

### The hard constraint that shapes everything

Only a **residential (or cellular) IP driving a real, warm browser** beats REA's Kasada and Domain's Akamai. Every datacentre egress — Cloud Run, GCP, the Vultr K8s pod brandbrain runs on, the DO droplet — is **blocked or served deliberately poisoned data**. stealth has **no Kasada/Akamai solver**; the "solver" is a real warm browser on a residential/cellular IP. Therefore "distribute across local and server-side" **cannot** mean "fetch the portals from a server." It means:

- **Fetch** stays on residential/cellular egress (the agents).
- **Everything else** — cadence, queue, extraction of medians, aggregate storage — is IP-independent and can live server-side.

The split is **fetch (IP-bound, on agents) vs coordinate (portable).** "Server-side" = the *coordination*, never the *fetch*.

## 2. Current state (verified 2026-07-13)

- **shorted `house-price-collector`** is today the fetcher + orchestrator + validator + store. Winning fetch path = `cdpFetcher` (`crawl_cdp.go`) connecting over CDP to a warm host-macOS Chrome that already holds the Kasada clearance cookie (`browser.Contexts()[0]`). **Serial, single-process, single-IP by design.** Run **by hand** (`docker run … -e CRAWL_CDP_URL=http://host.docker.internal:9222`). Two tiers exist, tested, and back the live UI:
  - `-mode crawl` — suburb medians → POST rendered HTML to brandbrain `ExtractRealEstate` → validate (4 anti-poison gates) → `house_prices`.
  - `-mode listings` — listing-level, **extracted locally** (`crawl_listings_extract.go`, pure goquery/JSON, µs, 171 tests), diffed into price-drop/rise/relist/delist events (delist only on a `complete` sweep past `delistGrace`); migrations 000076/000077; `mv_suburb_price_drops` / `mv_suburb_listing_stats`.
- **brandbrain already has the agent backbone** (this is `backend/cmd/agent/`, NOT the dead `cmd/worker/*` scaffold): a launchd-managed desktop agent (`com.brandbrain.agent.plist`), OAuth login + **scoped revocable tokens** (`APITokenScopeAgentCrawl` / `AgentUpload` / `AgentFlows`, `agent_session_repository.go`), server routes `GET /api/v1/agent/poll` (claim jobs) + `POST /api/v1/agent/results` (submit, **64MB `LimitReader` cap** at `agent_handler.go:1294` explicitly to avoid accept-then-OOM), an `upload_queue.go`, a `harvest_worker.go` dispatch loop, and an `agent_state.go` surface the Swift menubar app reads. It **has Postgres** (pgx repos). It owns `ExtractRealEstate` (HTML-in pure compute: JSON-LD / REA `ArgonautExchange` / Domain `__NEXT_DATA__` deterministic passes + optional Gemini langextract; hand-rolled protojson mux, unary only). Deploys to **Vultr K8s** (`vke-omega`, HPA 1–4, 1 CPU/1536Mi pod, ~2-concurrent extraction 502 ceiling; the collector already carries `1s/3s/6s` 5xx backoff because of it). Job delivery today is **GCP Pub/Sub push + a 60s HTTP poll fallback** — there is *no* multi-agent lease/claim.
- **cuttlefish** has a durable Postgres `SKIP LOCKED` leased queue, pool/label run-pinning (per-**Run**, not per-node), **wired cron with per-trigger pool pinning**, per-node retry/backoff, and expired-lease reclaim — but is **Docker/Podman-only** (an iOS app can never be a runner) and has **no built-in pacing**. Track A already wired cuttlefish cron for this job.

## 3. Design principles (locked by the review)

These are constraints every phase must respect:

1. **Fetch is IP-bound and stays on the agent.** The warm-Chrome-over-CDP path (holds the human-warmed Kasada cookie) is the only thing that works; do not indirect it behind machinery that could cool the context.
2. **Job = one suburb sweep**, not one URL. The agent pages locally (exactly as `sweepSuburbSource` does today) and submits one assembled result. This keeps the tested delist-safety (`sweep_status ∈ complete|partial|blocked`) byte-for-byte and avoids per-page round-trips through the 502-prone pod. (It's also fully iOS-compatible — WKWebView can loop `?page=N`.)
3. **Listing extraction stays agent-local.** It's deterministic, µs-scale, 171-test-covered, and needs no server. Only **medians** use brandbrain's `ExtractRealEstate` LLM path (the one extraction a server-side LLM actually helps).
4. **No raw HTML and no ToS-restricted PII enters brandbrain.** brandbrain is a separate company with other customers, a domain index, eval fixtures, and auto-deploy-on-merge. Agents submit **minimal de-identified derived numerics** (price, beds/baths/car, land, `listing_id`, `listing_url`, suburb, status). Median HTML that must be LLM-parsed is sent transiently to `ExtractRealEstate` and never persisted by brandbrain.
5. **The capital-band anti-poison gate runs in shorted before any median is persisted or served.** REA serves deliberately false *in-band* medians; only shorted's `validateMedian` (0.15×–8× vs `mv_housing_headline` GCCSA baselines) catches wrong-suburb-plausible poison. brandbrain never stores or serves an ungated median.
6. **Pacing is fixed, generous, and non-adaptive; enforced per observed egress IP.** Keep the proven jitter (20–45s inter-suburb / 8–22s inter-page) + consecutive-block circuit breaker. **Do not** build a controller that learns the portal's detection threshold — it's unnecessary at 2-mac scale and reads as intent-to-circumvent (Criminal Code s477.1). Any server-side cooldown keys to the **observed source IP**, never a self-reported `agent_id` (which resets on restart and collapses under CGNAT).
7. **Reuse the existing agent auth + capped upload.** Extend `cmd/agent/`'s scoped revocable tokens and the 64MB cap; never add a parallel unauthenticated protocol on `makeHandler`. Any large blob uses presigned-PUT-to-GCS + async extraction, not synchronous-in-submit.

## 4. Phased plan

### Phase MVP — productionize the prototype (mac-only, static partition; ~1–2 days, zero net-new platform)

This is the whole near-term ask. The prototype already works; make it run unattended and distributed across the macs you have.

1. **Apply migrations 000076/000077 to prod Supabase** (session pooler 5432, `PGOPTIONS="-c statement_timeout=0"` for `REFRESH … CONCURRENTLY`).
2. **Expand `crawlTargets`** from ~10 to the curated suburb set, and **statically partition it into disjoint halves** — one half per mac. *That partition IS the distribution across two residential IPs.*
3. **One `launchd` timer per mac** running the existing `-mode listings` + `-mode crawl` with `CRAWL_CDP_URL` (host Chrome) + `CRAWL_DRY_RUN=false` + the proven jitter/breaker; one-time human warms a dedicated-profile Chrome per mac (never the personal profile).
4. **Keep as-is:** local listing extraction, the capital-band gate, the `source_licence='proprietary-tos-restricted'` tag, the `HOUSING_DROP_LISTINGS_ENABLED` publish gate, `mv_suburb_price_drops`/`mv_suburb_listing_stats`.
5. **Land the residential + listing crawl branch** (`feat/housing-listing-price-tracking` and the sibling residential-crawl work) once reviewed.
6. **Add a "re-warm required" health state + alert** (§6): a Kasada cookie is short-lived and re-challenges on risk; an unattended loop will eventually hit a challenge with no human present and stall on `blocked`. Treat "max unattended hours between warms" as an SLO. *(This bites the mac backbone, not just iOS.)*

Outcome: paced, distributed-across-2-macs, unattended weekly crawl feeding the live housing surface. **Distribution = list partition. Pacing = existing jitter+breaker. Extraction = local. Queue = none.**

### Phase Queue — dynamic distribution when you outgrow a static split (optional)

Trigger: a 3rd+ mac, or you want dynamic rebalancing / crash-resilient claim instead of a hand-maintained partition.

- Use **cuttlefish's existing** durable `SKIP LOCKED` leased queue + wired cron + pool pinning + lease-reclaim. Model **one suburb sweep = one run**, pinned `pool=residential`, `capacity=1` per rig; cron cadence is the coarse pacer; the fine jitter/breaker stays *inside the task* (the collector already has it). Docker Desktop on mac reaches host Chrome at `host.docker.internal:9222` with no extra flags.
- Package the existing collector crawl path as a cuttlefish TaskPackage image (entrypoint reads one suburb from `CUTTLE_INPUT`). No new queue is built; this is wiring the tested collector onto a queue that already exists.
- Server-side pacing, *if* added, is a fixed per-egress-IP not-before enforced at claim time — not an adaptive controller.

### Phase Mobile — cellular agents (gated on a Phase-0 spike; do not build first)

The user's "brandbrain Apple app to crawl on mobile networks" idea. **Do not invest until a Phase-0 cellular spike passes** — the mac Phase-0 GO test's analogue:

- **Phase-0 spike (cheap, first):** on a real iPhone over cellular, drive a `WKWebView` to a REA and a Domain suburb page, measure real **block/poison rates with and without a warming step**, and confirm you can read `documentElement.outerHTML`. Success gate mirrors the mac gate (full page, real medians, `blockedSweeps≈0`).
- **Only if it passes:** build the iOS agent against brandbrain's **existing** `/api/v1/agent/poll` + `/results` + scoped-token auth. The one genuinely-new server piece is an HTTP **pull-claim with a lease** (the current `/poll` is Pub/Sub-push + poll-fallback, no multi-agent lease) — add that to the existing agent surface, not a new service. Agents page locally and submit assembled sweeps (Principle 2/3), so the Swift agent is thin (WKWebView + URLSession, no extraction logic).
- **Constraints that likely cap this:** WKWebView is app-data-isolated (no inherited warm Kasada jar → must solve fresh per session, the canonical bot signature); no public airplane-mode API (so "rotate IP on cooldown" is unachievable in a normal build); iOS suspends backgrounded apps (~30s) so the loop can't run unattended without foreground/`BGProcessingTask` gymnastics; CGNAT may not change the IP and never changes the fingerprint. **Restrict to the operator's own device** — never TestFlight/enterprise-sideload to third parties (conscripts them as the visible ToS-breach actor + shifts metered-data cost).

## 5. The two data contracts (brandbrain ⇄ shorted)

Only two shapes cross the boundary; both are versioned and contract-tested.

- **`RealEstateMedianResult`** — brandbrain's `ExtractRealEstate` output for a suburb page: medians + rental_yield/clearance/growth/days-on-market + confidence + source tag. **Transient** (returned to the caller; not persisted by brandbrain). shorted runs `validateMedian` + cross-check, then stores in `house_prices`.
- **`SuburbSweepResult{ listings[], sweep_status, pages }`** — the agent's assembled per-suburb listing sweep. **One status-tagged array** (a `sold` listing stays in `listings[]` with `status=sold`; splitting it out would make the delist loop mark a just-sold listing `withdrawn`). shorted diffs it against its snapshot → events, applies delist-grace, stores `property_listings`/`property_price_events`.

Contract rules (from the protocol lens): every field shorted nil-checks (e.g. `canonicalPrice` returns nil for auction/POA and is excluded from drop math) must be proto `optional`/wrapper type — a bare proto3 scalar collapses absent→0 and produces phantom "100% drop to $0" on the public panel. Add a `contract_version` field and a round-trip contract test asserting `nil→absent→nil` plus the licence/PII invariants; make that test **gate brandbrain's auto-deploy**.

## 6. Operations

- **Re-warm health state** (all phases with unattended runs): sustained `blocked` + expired clearance → human-actionable "re-warm the profile" alert; SLO = max unattended hours between warms.
- **Licence/PII posture** (gating, promoted from notes to blockers): confirm Vultr `vke-omega` region is `australia-southeast` before *any* data transits brandbrain; scrub page content from brandbrain logs; exclude crawl tables from backups; keep the stored footprint to derived per-suburb aggregates (n≥3), not a listing-level mirror (database-right exposure scales with aggregation regardless of the licence gate); a written REA/Domain ToS + s477.1/circumvention review gates any *scale-up* of acquisition; a DPA between Gamma Systems Pty Ltd and brandbrain's entity is required if data ever transits; write a one-page mini-PIA (APP 3/5/6/8/11).

## 7. Risks & open questions

1. **Does the mobile leg ever clear Kasada?** Unknown until the Phase-0 cellular spike. Everything mobile is gated on it. Likely the hardest of the three egresses.
2. **Extraction bottleneck** — brandbrain's 1-CPU pod 502s above ~2 concurrent extractions. Only the **median** tier hits it, at low paced rate; the serial collector already respects it via 5xx backoff. If a queue fans medians across agents, cap concurrent `ExtractRealEstate` calls (a small semaphore) or route medians through the queue too. Listings never touch it (local extraction).
3. **Static partition drift** — a hand-maintained two-way suburb split can skew if one mac is down; the re-warm alert + a simple "last successful sweep per suburb" check covers detection. Promote to the cuttlefish queue when this becomes annoying.
4. **Cross-repo contract** — brandbrain and shorted now share `RealEstateMedianResult` + `SuburbSweepResult`; version + contract-test them (mirror the weekly-report json-contract discipline) and gate brandbrain deploy on the test.
5. **iOS App Store / device scope** — a scraping app won't pass public review; keep it to the operator's own device.

## 8. What this explicitly does NOT do

- Does **not** fetch REA/Domain from any datacentre egress (no viable code path).
- Does **not** build a bespoke brandbrain-native queue for the near term (cuttlefish's existing queue covers Phase-Queue; the existing `/api/v1/agent/*` surface covers agent I/O).
- Does **not** port listing extraction into brandbrain, nor store raw HTML / listing-level PII there.
- Does **not** build an adaptive threshold-learning pacer (unnecessary + legally risky); pacing stays fixed and generous.
- Does **not** ship the iOS app before a passing Phase-0 cellular spike.
- Does **not** move shorted's `house_prices`/`property_listings` store, gates, or MVs (they stay in shorted, tested and UI-backing).
