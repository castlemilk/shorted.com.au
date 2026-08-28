# Shorted MCP Server + API Discoverability — Design

**Date:** 2026-08-27
**Status:** Approved (design); implementation not started

## Goal

Two outcomes, one spec because they are coupled:

1. **An LLM handed a single Shorted URL can discover, read and correctly call the whole
   public API** — without a human explaining it, and without executing JavaScript.
2. **A first-class MCP server** speaking the current protocol revision, covering core data
   fetching across shorts/market, housing, economy and politicians, with OAuth 2.1
   authorization and the same tier rate limits the REST/Connect surface enforces.

## Current state (verified 2026-08-27, not assumed)

| Thing | Reality |
|---|---|
| MCP server | `web/src/app/api/mcp/[transport]/route.ts` — `mcp-handler` + TS SDK, **4 tools**, shorts-only, **no auth, no rate limiting**. Calls `api.shorted.com.au` over HTTP with a browser UA. |
| Server card | `/.well-known/mcp/server-card.json` (SEP-1649 draft) via a `next.config.mjs` rewrite → `/api/agent/mcp-server-card`. Declares `authentication: {required: false}` and hand-lists the 4 tools. |
| OpenAPI | `web/public/openapi.json` — **6 paths, 5 of which are HTML pages**. The real API is **64 Connect-RPC methods across 12 domain services**. |
| Discovery spine | Already built: RFC 9727 `/.well-known/api-catalog`, `ai-plugin.json`, `llms.txt` (9K), `llms-full.txt`, `ai.txt`, `Link:` header on `/` with `api-catalog` / `service-desc` / `service-doc`. |
| `/docs/api` | React page rendering the thin spec via `~/lib/openapi/parser`. An agent fetching it gets a shell. |
| robots.txt | Deliberately `Disallow`s `/shorts.v1alpha1.*` etc. — 56.7% of Googlebot's budget was going there. **This stays.** |
| Auth | `Authorization: Bearer` → bespoke API token (`api_tokens`, 30-day, `TokenService`) or Firebase ID token. Tier always re-resolved from `api_subscriptions`; never trusted from the token. |
| Rate limits | `services/pkg/ratelimit`: Connect interceptor → in-process per-minute + Postgres monthly (`api_usage_monthly`). Cloudflare worker enforces a tier-blind ceiling on `api.shorted.com.au/*`. **Zero Upstash dependency, deliberately.** |
| Go layout | `services/` is **one module** (go 1.26). `ShortsServer` implements every RPC; `serve.go` mounts 12 domain handlers on one mux. |

So: the spine is right, the content behind it is wrong; and the MCP server is a 4-tool
prototype attributed to nobody.

## Protocol facts this design is built on

- **Current MCP revision: `2026-07-28`.** Handshake-less: a mandatory `server/discover`
  RPC returns supported versions + capabilities + identity; the version travels in
  `_meta` (`io.modelcontextprotocol/protocolVersion`) and, on Streamable HTTP, the
  `MCP-Protocol-Version` header. Servers accept/reject per request and return
  `UnsupportedProtocolVersionError` listing what they support. Backwards compatible with
  the initialize-based revisions (`2025-11-25` and earlier).
- **Go SDK**: `github.com/modelcontextprotocol/go-sdk` v1.2.0 — `mcp.StreamableHTTPHandler`,
  `mcp.AddTool` with derived input/output schemas, and `auth.RequireBearerToken` whose
  `ResourceMetadataURL` option emits the RFC 9728 `WWW-Authenticate` challenge.
- **Authorization (2026-07-28)**:
  - Resource server **MUST** implement RFC 9728 Protected Resource Metadata.
  - Resource server **MUST** validate that the token's audience is itself (RFC 8707).
    It **MUST NOT** accept or transit any other token.
  - AS **MUST** provide RFC 8414 or OIDC Discovery metadata.
  - **Client ID Metadata Documents** are the preferred registration path; **RFC 7591 DCR
    is deprecated but retained** — today's clients (Claude, ChatGPT) still use it, so we
    implement both.
  - PKCE mandatory; `resource` parameter mandatory on authorize *and* token requests;
    `iss` in authorization responses (RFC 9207) with
    `authorization_response_iss_parameter_supported: true`.
  - 401 = unauthenticated, 403 + `error="insufficient_scope"` + `scope="…"` = step-up.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| MCP placement | **Mounted in the existing shorts API binary** at `https://api.shorted.com.au/mcp` | `ShortsServer` already implements all 64 RPCs, so tools call handlers **in-process** — no HTTP hop, no Cloudflare/WAF round trip, no double-counted rate limits. Shares pgxpool, `pkg/ratelimit`, `TokenService`, OTel. No new Cloud Run service (cost guardrail: every new service is a new `min_instance_count` surface), no new TF module, no new deploy path. |
| Anonymous access | **Allowed** at the anonymous tier; OAuth raises limits and unlocks premium tools | Matches the existing `VISIBILITY_PUBLIC` model and the Part A goal — an agent handed the URL can act immediately. Auth is OPTIONAL per spec. |
| Auth model | **Full OAuth 2.1** (RFC 9728 + 8414 + 8707 + 9207 + PKCE + CIMD + DCR) with an audience-bound bearer fallback | One-click connectable from Claude/ChatGPT connectors. |
| OpenAPI | **Generated from proto** | 64 methods cannot be hand-maintained without drift. |
| Sequencing | **Three phases, one spec, separate PRs** | Phase 1 ships value alone; the discovery docs need to describe the final auth shape, hence one spec. |

## Architecture

```
                    ┌─────────────────────────────────────────┐
   Agent/LLM ──────▶│ shorted.com.au (Next.js / Vercel)       │
                    │  AUTHORIZATION SERVER + DOCS            │
                    │  /.well-known/oauth-authorization-server │
                    │  /.well-known/api-catalog  (exists)      │
                    │  /.well-known/mcp/server-card.json       │
                    │  /oauth/authorize  (Firebase session)    │
                    │  /oauth/token  /oauth/register           │
                    │  /openapi.json (generated)  /docs/api.md │
                    └────────────────┬────────────────────────┘
                                     │ mints audience-bound token
                                     ▼
                    ┌─────────────────────────────────────────┐
   Agent/LLM ──────▶│ api.shorted.com.au (Go, Cloud Run)      │
                    │  RESOURCE SERVER                         │
                    │  /.well-known/oauth-protected-resource/mcp│
                    │  /mcp   ← StreamableHTTPHandler          │
                    │    ├ auth: RequireBearerToken (aud check)│
                    │    ├ ratelimit.HTTPMiddleware            │
                    │    └ tools ──in-process──▶ ShortsServer  │
                    │  /shorts.v1alpha1.*Service/* (existing)  │
                    └─────────────────────────────────────────┘
```

The role split is the crux: the **AS lives in Next.js** because that is where Firebase
sign-in, the consent UI and the API-key manager already are; the **resource server lives
in Go** because that is where the data and the rate limiter are. RFC 9728 is the wire
between them, which is exactly what it is for.

## Part A — discoverability (Phase 1)

### A1. Generate OpenAPI 3.1 from the protos

Add an OpenAPI plugin to `proto/buf.gen.yaml` (`buf.build/gnostic/gnostic` is already a
declared dep in `buf.yaml`). Emit **only** methods annotated
`option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC`, from the **12 domain
services** — never the legacy monolithic `ShortedStocksService`, which would double every
path.

Connect-RPC is honestly describable in OpenAPI: each method is
`POST /shorts.v1alpha1.StockService/GetStock` with a JSON request body and JSON response,
`Connect-Protocol-Version: 1` required. The generated document therefore describes calls
an agent can actually make, which the current one does not.

- Output committed to `web/public/openapi.json`; a YAML twin at `/openapi.yaml`.
- Post-processing step injects `info`, `servers`, licence, auth schemes (bearer + OAuth
  flows), and the rate-limit header contract into responses.
- **Drift test**: CI regenerates and diffs; a stale spec fails the build. This is the
  whole point of generating it.

### A2. Markdown twins for every doc surface

`/docs/api` is React. Add static markdown routes that return the same content with no JS:

- `/docs/api.md` — overview, auth, rate limits, error contract, endpoint index.
- `/docs/api/<endpoint>.md` — per-method reference generated from the same spec.
- `/docs/mcp.md` — how to connect the MCP server, tool catalog, OAuth walkthrough.
- `Link: rel="service-desc" / rel="service-doc" / rel="alternate" type="text/markdown"`
  headers on `/docs/*` (today the `Link` header is only on `/`).

Generated from the OpenAPI document, so they cannot drift from it either.

### A3. Extend the discovery spine

- `/.well-known/api-catalog`: add `service-desc` for the YAML spec, and entries for the
  **MCP server**, `llms.txt`, `llms-full.txt`, and the dataset catalog. Currently it
  points at the API and the health check only.
- `/.well-known/mcp/server-card.json`: generated from the Go tool registry (see B6), not
  hand-listed; declares OAuth metadata once Phase 3 lands.
- `ai-plugin.json`: point at the generated spec, describe auth, link the MCP endpoint.
- `llms.txt` / `llms-full.txt`: an explicit **"Programmatic access"** section — the MCP
  URL, the OpenAPI URL, the auth model, the tier table, and a worked `curl`.
- `robots.txt`: keep the RPC `Disallow` (crawl budget — verified reasoning, do not
  revert), add explicit `Allow` for `/openapi.json`, `/openapi.yaml`, `/.well-known/`,
  `/docs/`.
- `WebAPI` JSON-LD on `/docs/api` and `/docs/mcp`.

## Part B — MCP server (Phases 2 and 3)

### B1. Package layout

```
services/shorts/internal/mcp/
  server.go        // registry assembly, StreamableHTTPHandler wiring
  tools_market.go  // one file per domain
  tools_housing.go
  tools_economy.go
  tools_politics.go
  resources.go     // MCP resources (llms.txt, glossary, dataset catalog)
  prompts.go       // MCP prompts
  auth.go          // TokenVerifier: audience-bound validation
  catalog.go       // registry → server-card / docs export
```

Tools depend on a narrow `DataSource` interface satisfied by `ShortsServer`, so the
package is testable against a mock and `ShortsServer` gains no MCP knowledge. Mounted in
`serve.go` alongside the existing `mount(...)` calls.

### B2. Tools (~22, curated)

Tool-count bloat degrades client tool selection, so this is a curated set, not a
mechanical wrap of all 64 RPCs. All tools declare **typed output schemas** (structured
content) with a text fallback.

- **Market**: `list_top_shorts`, `get_stock`, `get_stock_history`, `get_industry_treemap`,
  `screen_stocks`, `search`, `list_scans`, `compare_stocks`, `get_director_trades`,
  `get_peer_comparison`, `list_reports`, `get_report`, `get_stock_news`
- **Housing**: `get_house_price_series`, `get_suburb_metrics`, `list_price_drops`
- **Economy**: `list_economic_series`, `get_economic_series`, `get_state_company_exposure`
- **Politicians**: `search_politicians`, `get_politician_interests`,
  `get_stock_political_exposure`

**Resources**: `llms.txt`, glossary, dataset catalog, tier table.
**Prompts**: e.g. "short-interest briefing for {ticker}", "suburb housing brief for
{state}/{suburb}".

Payload discipline carries over from the existing route: history is downsampled to ~200
points; list tools cap and paginate. Agents need shape, not 3,000 rows.

#### Licence guards (non-negotiable, enforced in the tool layer)

- **Housing**: only publishable aggregates. REA/Domain/property.com.au rows carry
  `source_licence='proprietary-tos-restricted'` and are **never** returned raw. Kill
  switches `HOUSING_DROP_LISTINGS_ENABLED` / `HOUSING_VALUATIONS_ENABLED` are honoured.
- **Politicians**: facts only, no amount/quantity/value fields exist anywhere in that
  subsystem and none may appear here. APH is CC BY-NC-**ND** — verbatim atoms, never
  rewritten prose. Portrait attribution is a licence obligation and travels with the data.
- Ambiguity resolves to withholding, never guessing.

A test asserts no housing or politician tool can emit a restricted column.

### B3. Protocol

`mcp.StreamableHTTPHandler` at `/mcp`, protocol `2026-07-28` with negotiation back to
`2025-11-25` / `2025-06-18` (SDK-handled). `server/discover` answers with identity,
capabilities and supported versions. Server identity: `shorted-asx-and-au-data`.

### B4. Authorization

**Resource server (Go):**

- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728):
  `resource: "https://api.shorted.com.au/mcp"`,
  `authorization_servers: ["https://shorted.com.au"]`,
  `scopes_supported: ["shorts:read","housing:read","economy:read","politics:read"]`,
  `bearer_methods_supported: ["header"]`. **No `offline_access`** — refresh tokens are not
  a resource requirement.
- `auth.RequireBearerToken` with `ResourceMetadataURL` set, so 401s carry
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- `TokenVerifier` validates signature, `exp`, **`aud` == the canonical resource URI**, and
  scopes. Firebase ID tokens are **rejected here** — they are not audience-bound to this
  resource, and the spec forbids accepting them.
- Anonymous requests are allowed through to public tools at the anonymous tier; the 401
  challenge fires when a tool requires identity or when quota is exhausted.
- Premium-gated tools return a tool error carrying the existing `RateLimitDetail`-shaped
  upgrade payload — **tier is not a scope**, and conflating them would send a paying user
  through a pointless re-auth.

**Authorization server (Next.js):**

- `GET /.well-known/oauth-authorization-server` (RFC 8414), including
  `authorization_response_iss_parameter_supported: true`, `code_challenge_methods_supported: ["S256"]`.
- `GET /oauth/authorize` — requires a Firebase session (redirects to sign-in and back);
  renders a **real consent screen** naming the client, its redirect URI and the requested
  scopes; validates `resource` (RFC 8707) against known resources; requires PKCE S256;
  issues a single-use, short-lived (60s) code bound to
  `(client_id, redirect_uri, code_challenge, resource, scope, user)`; returns `iss`.
- `POST /oauth/token` — `authorization_code` + `refresh_token` grants, verifier check,
  `resource` re-validated and stamped into the access token's `aud`. Access token TTL 1h;
  refresh tokens **rotate** on use with reuse detection (a replayed refresh token revokes
  the family).
- `POST /oauth/register` — RFC 7591 DCR, retained for current clients; plus **Client ID
  Metadata Documents** as the preferred path (HTTPS `client_id` URL fetched, validated,
  cached, `redirect_uris` checked against it).
- Redirect URI matching is **exact string comparison**; loopback ports handled per OAuth
  2.1. No open redirects.

**Bearer fallback, done honestly.** Personal API tokens remain usable at `/mcp` — but by
**adding the MCP resource URI to their audience list at mint time**, not by weakening the
audience check. Tokens minted before this change do not carry it and are rejected at
`/mcp` with a challenge pointing at the OAuth flow. Audience validation stays a real
check; there is no bypass branch.

**New tables** (one migration): `oauth_clients`, `oauth_authorization_codes`,
`oauth_refresh_tokens`. Every statement `IF NOT EXISTS`.

### B5. Rate limits

New `ratelimit.HTTPMiddleware` wrapping the **same** `RateLimiter` + `AppLimiter` the
Connect interceptor uses — no second policy, no second store, no Upstash.

- Identifier: `oauth:<userID>` / `token:<sha256[:32]>` / `mcp-anon:<ip>`.
- Access class `api` (so the `access` field in `RateLimitDetail` is correct and the
  upgrade copy does not over-promise — paid *browser* is unlimited, paid *API* is not).
- Counted **per tool call**, not per HTTP request; a JSON-RPC batch counts each call.
- Anonymous stays monthly-unmetered per `SkipAnonymousMonthly` (one row per IP per month
  is an unbounded key space for no enforcement value); per-minute and the edge ceiling
  still apply.
- 429 → JSON-RPC error carrying the existing `RateLimitDetail` JSON, plus `Retry-After`.
  **Field names in that struct are a contract; do not rename.**
- Fails **open** on a sick quota store, like the existing limiter. A degraded database
  must never 429 an agent.
- Cloudflare worker: `/mcp` classified into the api buckets (`api-key` when a bearer is
  present, `api-anon` otherwise) and **exempt from hot-cache** — MCP POST bodies are
  JSON-RPC and must never be cross-poisoned. Verified crawlers stay unlimited.

### B6. Single source of truth for the catalog

The Go tool registry exports its catalog (names, descriptions, schemas, scopes, tier) at
`GET /mcp/catalog.json`. The Next.js server card, `/docs/mcp.md` and `llms.txt` render
from that, so the advertised tool list cannot drift from the registered one — the failure
mode the current hand-written card is already in.

### B7. Cutover

The existing `web/src/app/api/mcp/[transport]/route.ts` becomes a **deprecation shim**:
returns the new endpoint in an error message and, where the transport allows, a 307. It
is not deleted — existing client configs point at it. Removal is a later, announced step.

## Testing

| Layer | Test |
|---|---|
| Tools | Per-tool unit tests against a mocked `DataSource`; payload-cap assertions |
| Licence | Assertion that no housing/politician tool can emit a restricted column or an amount field |
| Protocol | In-process SDK client vs server: `server/discover`, version negotiation, `tools/list`, `tools/call`, structured output validation, unsupported-version error shape |
| Auth | 401 challenge shape and `WWW-Authenticate` parsing; audience rejection (wrong `aud`, Firebase token, pre-cutover API token); scope insufficiency → 403 |
| OAuth AS | PKCE required and verified; code single-use and replay-rejected; redirect_uri exact match; `resource` bound into `aud`; refresh rotation + reuse detection revokes family; DCR and CIMD both accepted |
| Rate limits | Per-tool-call counting, batch counting, identifier derivation, fail-open on store error, `RateLimitDetail` field names |
| Docs | OpenAPI regenerate-and-diff drift test; `.well-known` document contract tests; markdown twins non-empty and JS-free |
| Migration | `node --test` migration test in the existing style |

## Rollout order (the landmines this repo has already been bitten by)

1. **Apply the OAuth migration to prod BY HAND** — session pooler **5432**,
   `PGOPTIONS="-c statement_timeout=0"`. The prod deploy does **not** run `migrate up`; it
   applies a hardcoded allowlist. Add the migration to that allowlist in
   `.github/workflows/terraform-deploy.yml` as well, since it is replayed every deploy.
2. Deploy the Go API (resource server + tools + limits).
3. Deploy Next.js (AS + docs + generated spec).
4. Flip the server card and `.well-known` documents to advertise OAuth.
5. Run the revalidation sweep — a promote resets ISR pages to placeholders.
6. Verify live from a real MCP client (Claude connector) end-to-end, not just tests.

## Explicitly out of scope

- Any write/mutating tool. Read-only, entirely.
- Exposing raw crawl listings, any declared-interest amount, or aph.gov.au artefacts.
- Retiring the legacy `ShortedStocksService` or the current Next.js MCP route.
- Adding a `shorted.com.au/*` Cloudflare worker route (dormant browser-bucket code stays
  dormant; activating it is a separate rollout with a real blast radius).
- Sunsetting Firebase auth or the existing API-token UX.

## Open risks

- **Tool-count vs. client selection quality.** 22 tools is near the upper bound of what
  clients select well over. If evaluation shows degradation, consolidate (e.g. one
  `query_series` tool over a `domain` enum) rather than adding more.
- **OpenAPI fidelity for Connect-RPC.** Generated output may need meaningful
  post-processing to be genuinely callable. If the generated document proves misleading,
  a curated hand-written spec over ~20 endpoints is the fallback — a wrong spec is worse
  than a small one.
- **DCR abuse.** An open `/oauth/register` invites junk registrations. Mitigate with rate
  limiting, short-lived unused-client expiry, and a registration cap per IP.
