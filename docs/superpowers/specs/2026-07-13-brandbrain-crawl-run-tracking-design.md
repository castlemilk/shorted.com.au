# Brandbrain crawl-run tracking (housing-crawl visibility)

**Status:** Draft design — awaiting user's architecture pick before any brandbrain-repo change
**Date:** 2026-07-13
**Related:** `2026-07-13-realestate-subcrawler-distributed-design.md` (the deferred brandbrain-native phase), memory `realestate-subcrawler-distribution`

## Goal
Make the shorted housing crawl visible **in the brandbrain agent** — a run (suburbs, listings, status, re-warm signal) should show up where brandbrain's other agent activity lives, so the crawl isn't an invisible standalone process.

## Current reality (verified 2026-07-13)
brandbrain's agent is **brand-discovery-shaped**: it polls `agentJob{BrandName, WebsiteHint}` (`/api/v1/agent/poll`), crawls a company site, posts a `SiteProfile` (`/api/v1/agent/results`), and durably tracks work as `DiscoveryJob` records. `/api/v1/agent/status` is an **ephemeral in-memory heartbeat** (`lastPollAt`, single field, "connected if last poll < 30s") — not a per-agent activity log. There is **no real-estate surface and no generic "report a crawl run" endpoint**. So housing-crawl visibility is a new integration, not a toggle.

## Two approaches

**A — Minimal run-report (recommended now).** The collector POSTs a small run summary to a new brandbrain endpoint at the end of each run; brandbrain stores recent runs and exposes them; the agent tray/status shows them. One-way reporting — the collector keeps running standalone (launchd, as built). Cheap, gets visibility, no queue.

**B — Full brandbrain-native queue (the deferred phase).** brandbrain owns a durable job queue the collector *polls* (claim → fetch → submit), so the housing crawl runs *through* the agent like brand-discovery does. This is the larger integration the main spec deferred and gated on the iOS Phase-0 spike (§ Phase Mobile). Bigger surface: a real-estate job type, claim/lease semantics, the collector reworked into a poller.

**Recommendation: A now, B only if/when the queue + iOS phase happens.** A delivers the requested visibility for a fraction of the cost and doesn't commit us to the queue architecture before the iOS spike decides whether it's worth it.

## Approach A — design

**brandbrain (Go, `github.com/brandbrain/brandbrain/backend`; has Postgres + pgx):**
- New table `agent_crawl_runs`: `{id, agent_id, kind ('housing'), started_at, finished_at, status ('ok'|'needs_rewarm'|'error'), suburbs int, listings int, events int, blocked_sweeps int, detail text, created_at}`. Cap retention (keep last ~200, or 30-day TTL) — it's a telemetry log, not a source of truth.
- Endpoints (hand-rolled `mux.HandleFunc`, matching the existing agent surface):
  - `POST /api/v1/agent/crawl-runs` — insert a run record. Auth scope `APITokenScopeAgentUpload` (already exists). Payload is tiny; the existing 64MB `LimitReader` cap applies trivially.
  - `GET /api/v1/agent/crawl-runs?limit=N` — recent runs for the tray/status. Auth scope `APITokenScopeAgentCrawl`.
- Surface: extend the `/api/v1/agent/status` response with `recent_crawl_runs` (or the tray reads the GET directly). `cmd/agent/agent_state.go` + `tray.go` render a "Housing crawl" line (last run: N listings, status, time).

**shorted collector (`services/house-price-collector`):**
- `reportCrawlRun(ctx, summary)` — a plain `net/http` POST (mirror `crawl_brandbrain.go`'s client + retry) to `BRANDBRAIN_AGENT_URL` with `Authorization: Bearer $BRANDBRAIN_AGENT_TOKEN`. **Env-gated and non-fatal**: no URL/token → skip silently (never blocks a crawl).
- Called at the end of `runListings` / `runCrawl` with the existing stats (`listingsStats`/`crawlStats`) + the `needsRewarm` bool.

**Auth prerequisite (the one real snag):** the collector needs a scoped brandbrain agent token, which brandbrain issues via its OAuth agent-login flow (`/api/v1/agent/login`). One-time: mint a token, store it in the launchd env file (`~/.shorted-housing-crawl.env`) as `BRANDBRAIN_AGENT_TOKEN`. Until that's set, the poster is inert — so the collector change is safe to ship dark.

## Build plan (Approach A, when approved)
1. **brandbrain branch:** `agent_crawl_runs` migration + `POST`/`GET` handlers + status extension + tray line + tests → **draft PR** (brandbrain auto-deploys on merge, so this stays draft/reviewed, never auto-shipped).
2. **collector:** `reportCrawlRun` + wire into `runListings`/`runCrawl` + env docs in `deploy/README.md` + a unit test with a fake HTTP server → on the existing housing branch.
3. **Verify:** mint a token, set `BRANDBRAIN_AGENT_URL`/`_TOKEN`, run a crawl → `GET /api/v1/agent/crawl-runs` returns it → the agent tray shows the "Housing crawl" line.

## Explicitly out of scope here
Approach B (poll/claim/submit queue, brandbrain-owned real-estate jobs, sharding via brandbrain, iOS agents) — that's the deferred brandbrain-native phase in the main spec, gated on the iOS Phase-0 cellular spike.
