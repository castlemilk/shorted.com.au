# Housing crawl via brandbrain's macOS agent (residential fetch gateway)

**Status:** Draft design — approved in principle by user ("Option A, proceed"); awaiting spec review before implementation plan.
**Date:** 2026-07-14
**Decision:** Option A (agent = LAN fetch gateway), chosen by the user over B (poll-based `crawl_jobs` queue) and C (self-contained brandbrain job-kind).
**Related:** `2026-07-13-brandbrain-native-crawl-queue-design.md` (the superseded Approach B), `2026-07-13-realestate-subcrawler-distributed-design.md`, memories `housing-residential-crawl`, `property-listings-price-tracking`, `intelligent-crawler`.

## Goal

Make the shorted housing crawl (`-mode listings` for-sale listings; later `-mode crawl` suburb medians) actually fetch realestate.com.au (Kasada) and domain.com.au (Akamai) **through brandbrain's macOS agent**, so the page fetch runs from the residential Mac's IP using a warm, operator-cleared host Chrome. The agent exposes a small authenticated **LAN fetch endpoint** ("provide a local LAN address"); the shorted collector calls it per URL, gets raw HTML back, and does all extraction + storage locally.

The agent becomes a **generic residential fetch gateway** — "give me the rendered HTML for this URL from a warm residential browser" — reusable beyond housing. All housing-specific logic and every listing row/address stay in shorted.

## Why this shape (reconciliation with the current code)

Investigation of `~/projects/brandbrain` + `~/projects/stealth` (2026-07-14) established:

1. **The two halves exist but are disconnected.** brandbrain's macOS agent (`backend/cmd/agent/`) already crawls from the residential IP via the stealth engine; brandbrain already has a production AU real-estate extractor (`ExtractRealEstate`, parses REA `ArgonautExchange` + Domain `__NEXT_DATA__`). But nothing fetches a REA/Domain URL and feeds that extractor.
2. **There is no "LAN address" today.** The agent binds only `127.0.0.1:19179` — a loopback control API for its SwiftUI menu-bar shell (`backend/cmd/agent/diag.go`). No LAN server, no mDNS, no advertised address. The LAN endpoint is something we build.
3. **Anti-bot is the risk, not the plumbing.** stealth has a proven Cloudflare solver but **no demonstrated Kasada/Akamai bypass**; both brandbrain fetch paths spawn *fresh headless Chromium* (the weakest posture). stealth *supports* attaching to a warm host Chrome over CDP (`opts.DebuggerURL` → `chromedp.NewRemoteAllocator`, `brws/engine/chromium/chromium.go:34-47`; `ProfileDir` persistent profile, `stealth_engine.go:132-162`) but **brandbrain never wires it**. shorted's collector already drives a headed host-Chrome over CDP (`services/house-price-collector/crawl_cdp.go`) — the one path we concluded survives Kasada/Akamai from a residential IP.
4. **shorted already abstracts the fetch.** `htmlFetcher.fetch(ctx, url) → (html []byte, finalURL string, err error)` (`crawl.go`) with CDP + Playwright implementations, constructed by `newCrawlFetcher(cfg)` via `selectFetcherMode` (`crawl.go:60-82`). Both `-mode crawl` (`crawl.go:204`) and `-mode listings` (`crawl_listings.go:165`) go through it. A gateway fetcher is a drop-in third branch.

So: brandbrain gains one generic gateway endpoint that wires stealth's unused CDP-attach lever; shorted gains one new `htmlFetcher`. Everything downstream in shorted (extraction, poison/capital-band gate, delist safety, Supabase writes, MV refresh, 171 offline tests) is untouched.

## Principles (locked)

1. **The gateway is generic and housing-agnostic** — it fetches an arbitrary URL and returns HTML. No suburb/REA/Domain knowledge in brandbrain.
2. **No listing rows/addresses/PII persist in brandbrain.** HTML transits the gateway transiently; it is never stored, never logged as a body, never extracted there. shorted owns all extraction + storage (honors the locked "no listing PII in brandbrain" principle).
3. **Fetch uses the warm host Chrome over CDP** (stealth `DebuggerURL`), not fresh headless — the proven anti-bot lever.
4. **Pacing, circuit breaker, poison detection, licence gating stay in shorted.** The gateway is stateless per request; shorted remains authoritative for how fast/whether to fetch and whether to trust a result.
5. **Ships dark and gated.** The gateway is off unless explicitly enabled + a bearer token is set; the collector stays opt-in and dry-run-by-default.

## Architecture

Everything on the home LAN:

```
Residential Mac (home LAN)
 ├─ (1) Warm host Chrome — CDP :9222, persistent profile, operator-cleared Kasada/Akamai
 │          ▲ CDP attach (stealth DebuggerURL — the currently-unwired lever)
 ├─ (2) brandbrain macOS agent  +  NEW residential fetch gateway
 │          POST http://<mac-lan-ip>:PORT/gateway/v1/fetch {url} → {html, final_url, ...}
 │          bound to the LAN iface, bearer-token auth, stateless, never persists HTML
 │          drives (1) via stealth (CDP-attach + challenge-settle)
 │          ▲ POST (Authorization: Bearer <shared secret>)
 └─ (3) shorted house-price-collector (-mode listings | crawl)
           NEW gatewayFetcher (implements htmlFetcher) → extract locally → poison/capital-band gate
           → property_listings / property_price_events / house_prices → refresh MVs
                     │ writes
                     ▼
           shorted Supabase (prod)
```

If (2) and (3) run on the **same Mac**, `<mac-lan-ip>` can be `127.0.0.1` (or `host.docker.internal` if the collector is containerized). Binding the gateway to the **LAN interface** is what lets a *separate* home box run the collector while the Mac is purely the browser gateway — the flexibility "provide a local LAN address" buys. A LAN address is unreachable from the cloud by design; cloud orchestration is the Option-B fallback (see Alternatives).

## Components

### C1 — brandbrain agent: residential fetch gateway (new)
- Lives in `backend/cmd/agent/` (the desktop runtime — the only process with the residential IP and reach to the warm host Chrome; **not** `api.brandbrain.dev`, which runs on the datacenter droplet).
- A small HTTP server mirroring the existing loopback control server (`diag.go`), but:
  - **Bind** configurable via `GATEWAY_BIND` (e.g. the LAN iface / `0.0.0.0:PORT`); default disabled.
  - **Auth** required: `Authorization: Bearer <shared secret>`. The server **refuses to start LAN-bound without a non-empty token** (no open fetch proxy on the LAN).
  - **Enable gate**: only starts when `GATEWAY_ENABLED=true` + token set.
- Handler drives a stealth fetch configured to **attach to the warm host Chrome** and returns the settled HTML. Stateless; no persistence; never logs the HTML body.

### C2 — stealth CDP-attach wiring
- Build a `stealth.Client` (`brws/stealth/client.go:151` `NewWithConfig`) whose engine options set `DebuggerURL` to the warm Chrome's CDP URL (+ optional `ProfileDir`), so `Navigate` (`client.go:308`) attaches to the operator's warm session instead of spawning headless (the lever at `chromium.go:34-47` / `stealth_engine.go:132-162`, currently unused by brandbrain).
- Reuse stealth's **challenge-settle** logic (`stealth_engine.go:92-100,409-469`) so the DOM is captured *after* the anti-bot JS settles/renavigates. This is a gateway-local stealth client, separate from the discovery crawler — the brand-discovery path (`crawler_stealth.go`) is untouched.
- **Note:** stealth is a local `replace` + vendored dep in brandbrain (`backend/go.mod`); if the `DebuggerURL`/`ProfileDir` plumbing needs a stealth-side change it lands in `~/projects/stealth` first, then re-vendored.

### C3 — shorted collector: gateway fetcher (new)
- Add `fetcherModeGateway` to the `fetcherMode` enum (`crawl.go:47-55`).
- Add `gatewayURL` + `gatewayToken` to `crawlConfig` from env `CRAWL_GATEWAY_URL` / `CRAWL_GATEWAY_TOKEN` (`loadCrawlConfig`, `crawl.go:107-127`).
- Extend `selectFetcherMode` (`crawl.go:60-65`) with a single, explicit precedence: an optional `CRAWL_FETCH_MODE` override wins if set (`gateway|cdp|playwright`); otherwise infer — **gateway** (`CRAWL_GATEWAY_URL` set) > **CDP** (`CRAWL_CDP_URL` set) > **Playwright** (neither). `newCrawlFetcher` (`crawl.go:77-82`) returns a new `newGatewayFetcher(cfg)` for the gateway branch.
- `gatewayFetcher` implements `htmlFetcher` (`fetch` POSTs to the gateway, maps the JSON response to `(html, finalURL, err)`) + `Close()` (no-op). It is a plain `net/http` client — no browser, no CDP, in the collector process.
- Zero change downstream: `fetchAndClassify` (`crawl_listings.go:362`) and the `-mode crawl` loop already consume `htmlFetcher`. Serves both tiers.

## Protocol (`/gateway/v1/fetch`)

Request:
```
POST /gateway/v1/fetch
Authorization: Bearer <token>
Content-Type: application/json
{ "url": "https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1",
  "wait_ms": 8000,          // optional challenge-settle budget
  "engine": "auto" }        // optional: auto | chromium-cdp
```
Success:
```
200 { "html": "<!doctype html>…", "final_url": "…", "http_status": 200,
      "blocked": false, "engine_used": "chromium-cdp", "elapsed_ms": 5231 }
```
Error:
```
4xx/5xx { "error": { "kind": "unauthorized|bad_request|timeout|blocked|chrome_unreachable|needs_rewarm",
                     "message": "…" } }
```
- Response is gzip-encoded (search pages are large); a sane body cap (e.g. 25 MB).
- `blocked:true` and `needs_rewarm` are the coarse anti-bot hints; shorted still runs its own `looksBlocked` as a second gate and its capital-band poison gate on the extracted values.

## Data flow

shorted picks a suburb target URL (`crawl_listings_targets.go` / `crawl_targets.go`) → `gatewayFetcher.fetch` POSTs to `/gateway/v1/fetch` → agent drives the warm Chrome via stealth (CDP-attach + settle) → returns HTML → shorted `fetchAndClassify` classifies the sweep (`complete`/`partial`/`blocked`) → extract listings/medians **locally** → poison/capital-band gate → `property_listings` + `property_price_events` (listings) or `house_prices` (medians) → `refresh_housing_materialized_views()` → `mv_suburb_price_drops` / `mv_suburb_listing_stats` / `mv_housing_headline`.

## Anti-bot & egress

The fetch runs from the residential Mac's IP through a headed, warmed, persistent-profile Chrome the operator cleared once (CDP-attach). This is the only posture we believe survives Kasada/Akamai from a residential IP. Clearance expires → the fetch returns `needs_rewarm` → shorted maps it to the existing **exit code 3** re-warm alert (`main.go:22-24`, `crawl.go` `needsRewarm`). No unattended guarantee; an operator re-warms periodically.

**Kasada/Akamai remain unproven in-repo.** Before building out coverage, a Phase-0 spike (below) fetches one REA + one Domain suburb page through the gateway with a warm Chrome and confirms real (non-poison) DOM. If it fails, we stop and reassess (the official ABS/RBA/VG backbone is unaffected regardless).

## PII / licence posture

Raw HTML transits the gateway but is **never persisted, extracted, or logged as a body** there — brandbrain is a transparent pipe. shorted does all extraction + storage; raw listing rows keep `source_licence='proprietary-tos-restricted'` and only the derived `mv_suburb_price_drops` / `mv_suburb_listing_stats` are publishable. The per-listing drill-down stays flag-gated (`HOUSING_DROP_LISTINGS_ENABLED`).

## Error handling & pacing

- Pacing/jitter (20–45 s between suburbs), per-site circuit breaker, and `maxConsecBlocks` stay in shorted (`crawl.go`) — the gateway never rate-limits.
- Gateway errors are typed (`timeout|blocked|chrome_unreachable|needs_rewarm|unauthorized|bad_request`); `gatewayFetcher` maps `blocked`/`needs_rewarm` to `outcomeBlocked` and surfaces `needs_rewarm` to exit code 3; transport errors are non-fatal (the official backbone is unaffected — same discipline as `newCrawlFetcher` init failure, `crawl.go:204-209`).

## Config / auth / env

| Side | Var | Purpose |
|---|---|---|
| brandbrain agent | `GATEWAY_ENABLED` | start the gateway (default off) |
| brandbrain agent | `GATEWAY_BIND` | bind addr (LAN iface / `127.0.0.1:PORT`) |
| brandbrain agent | `GATEWAY_TOKEN` | shared bearer secret (required for LAN bind) |
| brandbrain agent | `GATEWAY_CDP_URL` | warm host Chrome CDP url (e.g. `http://127.0.0.1:9222`) |
| shorted collector | `CRAWL_GATEWAY_URL` | `http://<mac-lan-ip>:PORT` |
| shorted collector | `CRAWL_GATEWAY_TOKEN` | matches `GATEWAY_TOKEN` |
| shorted collector | `CRAWL_FETCH_MODE` | optional explicit `gateway` selector |

Token lives in the agent's config (`~/.brandbrain/`) and shorted's `~/.shorted-housing-crawl.env`.

## Build phases (each gated; brandbrain in a worktree off `origin/main`, draft PR)

- **P0 — spike (do first):** operator warms a dedicated-profile Chrome on `:9222`, hand-run a throwaway stealth fetch with `DebuggerURL` set against one REA + one Domain suburb search page; confirm real DOM (not Kasada/Akamai poison). GO/NO-GO gate for the rest.
- **P1 — brandbrain gateway:** `/gateway/v1/fetch` + `/gateway/v1/health` in `cmd/agent`, bind+auth+enable gates, the CDP-attach stealth fetcher (C2). Unit tests (fake fetcher + auth + refuse-LAN-without-token) + a local CDP smoke test. Ships dark. Draft PR.
- **P2 — shorted gatewayFetcher:** `fetcherModeGateway` + `gatewayFetcher` + config + `selectFetcherMode` precedence (C3). Unit test vs an `httptest` fake gateway (mirrors `crawl_agent_test.go`). Wire into `-mode listings`.
- **P3 — end-to-end verify (listings):** collector `-mode listings` (dry-run) against 1–2 seed suburbs pointed at the live gateway → HTML round-trips → extraction yields listings → then a live write run for one seed suburb → verify `property_listings` populated + `mv_suburb_price_drops` lights up + the `/housing` drops panel renders.
- **P4 — suburb-median tier:** same gateway serves `-mode crawl`; verify medians land in `house_prices` (licence-gated).
- **P5 — ops/visibility:** agent tray shows gateway status (requests served, last fetch, blocked count); shorted run logging; `needs_rewarm` alert.

## Landmines

- **Deploy vector is the agent app, not the API.** The gateway lives in the desktop runtime → it ships via the agent build/Sparkle appcast (operator installs), **not** the `api.brandbrain.dev` deploy-on-merge. brandbrain still auto-deploys the *API* on merge to main, so keep the PR draft and don't touch API surface.
- **LAN-bound open proxy** — refuse to start LAN-bound without a token; default dark. A tokenless LAN fetch proxy is a security hole.
- **Warm-Chrome clearance expiry** — `needs_rewarm`/exit-3; no unattended guarantee; operator must re-warm.
- **Kasada/Akamai unproven** — gate everything on the P0 spike; no in-repo proof of bypass yet (only uTLS fidelity + a settle wait).
- **stealth `DebuggerURL` may need a stealth-side change** — it's a local `replace`+vendored dep in brandbrain; land in `~/projects/stealth` first, re-vendor.
- **Collector→gateway reachability** — if the collector runs in Docker on the Mac use `host.docker.internal:PORT` (mirror the existing `CRAWL_CDP_URL=http://host.docker.internal:9222` pattern); native uses the LAN IP / localhost.
- **Don't log HTML bodies** anywhere in the gateway (PII/licence).
- **Two repos change** — sequence: stealth (if needed) → brandbrain agent (draft PR + new agent build) → shorted collector; the shorted side is inert until `CRAWL_GATEWAY_URL` is set.

## Alternatives considered

- **B — poll-based `crawl_jobs` queue** (`2026-07-13-brandbrain-native-crawl-queue-design.md`): brandbrain owns a queue, the agent polls out. The right choice **only if orchestration must run in the cloud** (a LAN address is then impossible). More infra (table + 5 routes + reclaim + tray) and doesn't provide the requested address. Kept as the documented fallback if the collector must move off the home LAN. shorted's `-mode agent`/`-mode enqueue` already target this shape.
- **C — self-contained brandbrain job-kind:** agent fetches *and* runs `ExtractRealEstate`, returns structured data. Pushes housing logic + listing data into brandbrain, breaking Principle 2. Rejected.
- **Status quo — shorted drives CDP directly** (`crawl_cdp.go`): already works when co-located with the warm Chrome, but doesn't centralize the residential browser in brandbrain, isn't reusable by other consumers, and isn't "run via brandbrain's crawler." Superseded by this design at the user's request; remains the local fallback if the gateway is unavailable.

## Future extensions

- Other consumers (brandbrain's own discovery, future crawls) reuse the same gateway → a single warm residential browser serves many jobs.
- If home-LAN orchestration becomes limiting, layer Option B (poll queue) on top without changing the fetch/extract seams.
- Multi-Mac: each Mac runs a gateway; shorted's existing static sharding (`selectTargets`, `CRAWL_SHARD_INDEX/COUNT`) fans suburbs across gateways.
