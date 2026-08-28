# Phase 3: MCP OAuth 2.1 + rate limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP server at `https://api.shorted.com.au/mcp` one-click connectable from Claude/ChatGPT via OAuth 2.1, and metered by the same tier limits the Connect API already enforces — without weakening the anonymous access that makes it usable today.

**Architecture:** The Go API is both the **resource server** and the **authorization server**. The SDK supplies the resource side (`auth.RequireBearerToken`, `auth.ProtectedResourceMetadataHandler`); Go gains `/oauth/*` endpoints for metadata, authorize-grant, token exchange and client registration. Next.js contributes only the human-facing consent screen, proving identity with a Firebase ID token that Go already knows how to verify. Rate limiting reuses `pkg/ratelimit` through a new HTTP middleware rather than a second policy.

**Tech Stack:** `github.com/modelcontextprotocol/go-sdk` v1.7.0 (`auth`, `oauthex`), `golang-jwt/jwt/v5`, Postgres, Next.js App Router, Cloudflare worker + Terraform.

**Spec:** `docs/superpowers/specs/2026-08-27-mcp-server-and-api-discoverability-design.md` (Part B, Phase 3)

**Depends on:** Phase 2 (PR #510, merged). The MCP server, tool registry and `DataSource` guard already exist.

---

## ⚠️ Deviation from the approved spec — read this first

The spec put the **authorization server in Next.js**, reasoning that Firebase sign-in and the API-key UI live there. Implementation reconnaissance changed that conclusion, and this plan puts the **AS in Go**. Three reasons, each checkable:

1. **Go already verifies Firebase ID tokens.** `services/shorts/internal/services/shorts/middleware_connect.go` does it today for browser-authenticated callers. So "the AS must live where the identity is" is not true — Go can establish the same identity from an ID token the browser hands it.
2. **Token material would otherwise be split across two platforms.** `TokenService` signs HS256 with a symmetric secret. An AS in Next.js means that secret lives on Vercel *and* Cloud Run, and every rotation touches both. Keeping minting and verification in one process removes a shared secret entirely.
3. **The resource server must validate what the AS mints.** Same process, same key, no JWKS fetch, no clock-skew-across-platforms class of bug.

Next.js still owns the **consent screen** — the only part that genuinely needs the browser session and a human. It posts a Firebase ID token to Go, which is the identity assertion.

If you disagree with this, stop at Task 3 — Tasks 1, 2, 7 and 8 are unaffected either way.

---

## Context an engineer needs before starting

- **Anonymous access must survive.** Phase 2 shipped 24 tools usable with no auth, and that is what makes the server adoptable. OAuth **raises** limits and unlocks tier-gated behaviour; it does not become mandatory. A 401 challenge fires when quota is exhausted or a premium tool is called — not on first contact.
- **`Claims` has no `aud` today.** `MintTokenWithTier` sets issuer `shorted-api` and never sets `Audience`. The MCP spec **requires** the resource server to validate that a token was minted for it (RFC 8707). So audience becomes load-bearing, and pre-existing tokens have none — see Task 1 for how that is handled without breaking them.
- **The prod deploy does NOT run `migrate up`.** It applies a hardcoded allowlist in `.github/workflows/terraform-deploy.yml`, replayed every deploy. New tables must be `IF NOT EXISTS` throughout and added to that allowlist, or hand-applied on the **session pooler (5432)** with `PGOPTIONS="-c statement_timeout=0"` before the code that reads them ships.
- **Rate limiting must not depend on Upstash.** There are deliberately no `RATE_LIMIT_UPSTASH_*` vars and a test asserts their absence. Quota counters live in Postgres on the pool the API already holds. Do not introduce a new store.
- **The limiter fails open.** A sick quota database must never 429 or 500 a caller. Preserve that.
- **`Stateless: true` on the streamable handler is load-bearing** — without it the SDK silently negotiates down to legacy `initialize`. Do not disturb it while adding middleware.
- **Tools call handlers in-process, skipping the Connect interceptor chain.** That is why `TestToolsOnlyCallPublicMethods` and `TestDataSourceExposesOnlyPublicMethods` exist. Rate limiting for MCP therefore cannot come from the Connect interceptor — hence Task 7.
- **`GOWORK=off`** on every Go invocation.

---

## What the SDK already gives us

Verified in the v1.7.0 module, so do not hand-roll these:

| Need | SDK |
|---|---|
| RFC 9728 protected-resource metadata document | `auth.ProtectedResourceMetadataHandler(*oauthex.ProtectedResourceMetadata)` |
| Bearer middleware + `WWW-Authenticate` challenge | `auth.RequireBearerToken(verifier, *auth.RequireBearerTokenOptions)` |
| Token plumbing into handlers | `auth.TokenInfo`, `auth.TokenInfoFromContext`, `req.Extra.TokenInfo` |

`RequireBearerTokenOptions` carries `ResourceMetadataURL`, `Scopes`, `ClockSkew` and `AllowMissingExpiration`. **Set `ClockSkew`** — the resource server sits behind Cloudflare and Cloud Run, and strict comparison rejects tokens that are valid by the issuer's clock.

---

### Task 1: Audience-bound verification + protected-resource metadata

Resource-server side only. MCP stays anonymous-allowed; this adds the ability to *recognise* a token and the document that tells clients where to get one.

**Files:** `services/shorts/internal/mcp/auth.go` (+ test), `services/shorts/internal/services/shorts/serve.go`, `services/shorts/internal/services/shorts/tokens.go`

- [ ] **Step 1** — Add `Audience` to minted tokens. `MintTokenWithTier` sets `RegisteredClaims.Audience` to include the API origin and the MCP resource URI (`https://api.shorted.com.au/mcp`).

  **Pre-existing tokens carry no `aud`.** Treat an absent audience as valid for the *Connect API only*, never for `/mcp`. That keeps every existing API token working while making the MCP surface strict, and it is why the spec's "add the resource to the audience at mint time" line exists. Write a test for both directions.

- [ ] **Step 2** — `TokenVerifier` in `internal/mcp/auth.go` wrapping `TokenService.ValidateToken`, additionally requiring the MCP resource URI in `aud`, and mapping `Claims` → `auth.TokenInfo` (`UserID`, `Scopes`, `Expiration`).

- [ ] **Step 3** — Serve `/.well-known/oauth-protected-resource/mcp` via `auth.ProtectedResourceMetadataHandler`, with `Resource: https://api.shorted.com.au/mcp`, `AuthorizationServers: ["https://api.shorted.com.au"]`, `ScopesSupported: ["shorts:read","housing:read","economy:read","politics:read"]`, `BearerMethodsSupported: ["header"]`. **No `offline_access`** — refresh tokens are not a resource requirement and the spec says not to advertise it here.

- [ ] **Step 4** — Wrap `/mcp` so that a *present* bearer token is verified and attached, but an *absent* one still proceeds anonymously. `RequireBearerToken` rejects missing tokens outright, so this is a thin wrapper: if no `Authorization` header, pass through; if present, delegate. Test both paths, plus that a wrong-audience token is rejected with a `WWW-Authenticate` naming the metadata URL.

- [ ] **Step 5** — Commit: `feat(mcp): audience-bound token verification and protected-resource metadata`.

---

### Task 2: OAuth storage

**Files:** `services/migrations/000116_add_oauth_clients.up.sql` / `.down.sql`, a `node --test` migration test, `.github/workflows/terraform-deploy.yml`

- [ ] **Step 1** — Three tables, every statement `IF NOT EXISTS`:
  - `oauth_clients` — `client_id` (PK), `client_id_issued_at`, `client_name`, `redirect_uris text[]`, `grant_types text[]`, `scope`, `client_uri`, `registration_source` (`dcr` | `cimd`), `client_secret_hash` (nullable — public clients have none), `created_at`, `last_used_at`.
  - `oauth_authorization_codes` — `code_hash` (PK, never the code itself), `client_id`, `user_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `resource`, `scope`, `expires_at`, `consumed_at`.
  - `oauth_refresh_tokens` — `token_hash` (PK), `family_id`, `client_id`, `user_id`, `resource`, `scope`, `expires_at`, `rotated_at`, `revoked_at`.

  Store **hashes, never secrets**, mirroring `api_tokens.token_hash`. Index what is looked up: `oauth_refresh_tokens(family_id)`, `oauth_authorization_codes(expires_at)` for sweeping.

- [ ] **Step 2** — Migration test in the style of `services/migrations/api_usage_monthly.test.mjs`: asserts idempotency (every statement `IF NOT EXISTS`), that no column stores a raw secret, and that the down migration drops cleanly.

- [ ] **Step 3** — Add to the terraform-deploy allowlist. **Verify the file's existing pattern first** — `000112` sits deliberately *before* `000095` so the hardened MV refresh applies last. Place yours so that ordering is not disturbed.

- [ ] **Step 4** — Apply locally, run the test, commit: `feat(oauth): storage for clients, codes and refresh tokens`.

---

### Task 3: Authorization server metadata + the authorize grant

**Files:** `services/shorts/internal/oauth/` (new package), `serve.go`

- [ ] **Step 1** — `GET /.well-known/oauth-authorization-server` (RFC 8414): `issuer: https://api.shorted.com.au`, `authorization_endpoint: https://shorted.com.au/oauth/authorize` (the Next.js consent screen), `token_endpoint`, `registration_endpoint`, `scopes_supported`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, and **`authorization_response_iss_parameter_supported: true`**.

- [ ] **Step 2** — `POST /oauth/authorize/grant`, called by the consent screen, not the browser directly. Body: Firebase ID token, `client_id`, `redirect_uri`, `code_challenge` (+method), `resource`, `scope`, `state`.

  It must: verify the Firebase ID token (reuse the middleware's path); validate `client_id` against `oauth_clients`; **exact-string-match** `redirect_uri` against the registered set (no prefix matching, no open redirect); require `code_challenge_method=S256`; validate `resource` against known resource URIs; mint a single-use code with a **60-second** TTL, storing only its hash; and return the redirect URL including `state` and **`iss`** (RFC 9207).

- [ ] **Step 3** — Tests: missing/invalid Firebase token rejected; unknown `client_id` rejected; `redirect_uri` mismatch rejected (including a prefix that would pass a sloppy check); `plain` PKCE rejected; unknown `resource` rejected; `iss` present in the response.

- [ ] **Step 4** — Commit: `feat(oauth): authorization server metadata and the authorize grant`.

---

### Task 4: Token endpoint

**Files:** `services/shorts/internal/oauth/token.go` (+ tests)

- [ ] **Step 1** — `POST /oauth/token`, `authorization_code` grant: look up by code **hash**; reject if expired, already consumed, or belonging to a different client; verify the PKCE `code_verifier` against the stored challenge; re-validate `resource`; mark consumed **atomically** (a replayed code must lose the race, so consume with a conditional UPDATE, not read-then-write).

  Mint an access token whose `aud` contains the requested `resource`, TTL **1 hour**, carrying the granted scopes and the user's tier resolved **at mint time from `api_subscriptions`** — and note the existing rule that tier is re-resolved on every request, so the token's tier is a hint, never the authority.

- [ ] **Step 2** — `refresh_token` grant with **rotation**: issue a new refresh token, revoke the presented one, keep `family_id`. **Reuse detection** — presenting an already-rotated token revokes the entire family. That is the difference between a stolen refresh token being useful once and being useful forever.

- [ ] **Step 3** — Tests, each asserting a security property rather than a happy path: code replay fails and consumes nothing; wrong `code_verifier` fails; cross-client code redemption fails; expired code fails; refresh rotation invalidates the old token; **refresh reuse revokes the family**; the minted token's `aud` contains the resource and is accepted by Task 1's verifier.

- [ ] **Step 4** — Commit: `feat(oauth): token endpoint with PKCE and refresh rotation`.

---

### Task 5: Client registration

**Files:** `services/shorts/internal/oauth/clients.go` (+ tests)

- [ ] **Step 1** — **Client ID Metadata Documents** (the preferred path in `2026-07-28`): when `client_id` is an HTTPS URL, fetch it, validate the returned metadata, cache it, and check `redirect_uris` against it. Bound the fetch: timeout, response size cap, and **no redirects to private address space** (SSRF — this endpoint fetches a URL an untrusted caller supplies).

- [ ] **Step 2** — `POST /oauth/register` (RFC 7591 DCR). Deprecated in the spec but retained because Claude and ChatGPT still use it. Rate-limit it, cap registrations per IP, and expire unused clients — an open registration endpoint invites junk.

- [ ] **Step 3** — Tests: CIMD fetch validates redirect URIs; SSRF attempt (private IP, redirect to private IP) refused; DCR returns a usable `client_id`; registration abuse limits fire.

- [ ] **Step 4** — Commit: `feat(oauth): client-ID metadata documents and dynamic registration`.

---

### Task 6: Consent screen

**Files:** `web/src/app/oauth/authorize/page.tsx` (+ tests)

**ACCEPTANCE CRITERION — the consent ticket.** A security review of Task 3 found that the grant is authenticated *only* by a Firebase ID token, so it is not proof a human approved anything. That is survivable in isolation, and stops being survivable the moment Task 5 ships open dynamic registration: an attacker holding a stolen ID token registers **their own** client with **their own** redirect URI, POSTs the grant, redeems the code, and converts a ~1h Firebase credential into an indefinitely-rotating refresh token — with no human ever seeing a screen.

So this task must introduce a server-side, single-use **consent ticket**: minted when the human approves, bound to `user_id + client_id + redirect_uri + code_challenge`, ~2 minute TTL, stored hashed, and **required by `/oauth/authorize/grant` alongside the ID token**. That is what turns "someone holds a token" into "a human approved this client". Do not weaken it by exposing the ID token to the client app, and do not auto-approve.

- [ ] **Step 1** — A real consent screen, not an auto-approve redirect. It must name the **client**, its **redirect URI**, and the **scopes** in plain language, and require an explicit action. Signed-out users go through the existing Firebase sign-in and return here with the request intact.

- [ ] **Step 2** — On approve, POST the Firebase ID token plus the request parameters to Go's `/oauth/authorize/grant`, then follow the returned redirect. On deny, redirect with `error=access_denied` **and `iss`**.

- [ ] **Step 3** — Tests: renders the client and scopes; deny path returns the right error; a signed-out user is routed to sign-in and back without losing parameters.

- [ ] **Step 4** — Commit: `feat(oauth): consent screen`.

---

### Task 7: Rate limiting for MCP

**Files:** `services/pkg/ratelimit/http.go` (+ tests), `services/shorts/internal/mcp/`

- [ ] **Step 1** — `ratelimit.HTTPMiddleware` over the **same** `RateLimiter` the Connect interceptor uses. No second policy, no second store, no Upstash.

  **Also cover `/oauth/authorize/grant`.** It is a plain mux handler, so it bypasses the Connect interceptor entirely, and each call costs one Firebase network verification driven by an unauthenticated caller. Today its only ceiling is the tier-blind, per-colo edge `api-anon` bucket, which is absent in local and preview. Limit per IP **before** `VerifyIDToken` runs, or the limiter does not protect the expensive part.

  Identifier: `oauth:<userID>` / `token:<sha256[:32]>` / `mcp-anon:<ip>`. Access class **`api`** — so `RateLimitDetail.access` is right and the upgrade copy does not over-promise (paid *browser* is unlimited; paid *API* is not).

- [ ] **Step 2** — Count **per tool call**, not per HTTP request. A JSON-RPC batch counts each call. `server/discover`, `tools/list`, `resources/list` and `prompts/list` are session preamble — decide deliberately whether they count, and say which you chose. (Recommendation: don't count preamble; it is paid once and charging for it punishes connecting.)

- [ ] **Step 3** — A 429 becomes a JSON-RPC error carrying the existing `RateLimitDetail` JSON and `Retry-After`. **`RateLimitDetail` field names are a contract — renaming one is a breaking change.** Reuse the struct; do not restate it.

- [ ] **Step 4** — Preserve fail-open: a degraded quota store allows the call. Test it explicitly.

- [ ] **Step 5** — Tests: per-tool-call counting, batch counting, identifier derivation for all three classes, fail-open, and the 429 payload shape.

- [ ] **Step 6** — Commit: `feat(mcp): tier rate limiting over the existing limiter`.

---

### Task 8: The edge bucket

**Files:** `services/edge-worker/worker.js`, `services/edge-worker/*.test.mjs`, `terraform/modules/cloudflare-edge/`

Phase 2 measured this: `/mcp` currently lands in `api-anon` at **10/10s, 30/60s**. The handshake is 1 POST, so ~8 tool calls trip the burst bucket — a "compare these five stocks" turn crosses it, and the SDK issues calls sequentially so elapsed time is no mitigation.

- [ ] **Step 1** — Add an `mcp-anon` class keyed `m:<ip>` at **60/10s and 300/60s**. Two bindings, because the Cloudflare `period` enum is 10 or 60 only. Authenticated MCP callers should fall into the existing `api-key` class once Task 1 lands.

- [ ] **Step 2** — **Do not exempt `/mcp`.** Until Task 7 is deployed the edge is the only ceiling on an unauthenticated tool surface, and after it the edge is still the abuse ceiling for callers who never authenticate.

- [ ] **Step 3** — Test alongside `ratelimit.test.mjs`; also assert `/mcp` remains a cache **BYPASS** route (a cached MCP session cross-poisons clients — Phase 2 verified it is BYPASS today, but nothing enforces it).

- [ ] **Step 4** — Terraform variables + the rate-limit expression test. Commit: `feat(edge): give MCP its own anonymous bucket`.

---

### Task 9: Tier gating and honest advertising

**Files:** `services/shorts/internal/mcp/`, `web/src/app/api/agent/mcp-server-card/route.ts`, `web/public/docs/mcp-markdown.md`, `web/public/llms.txt`

- [ ] **Step 1** — Where a tool is tier-gated, return a tool error carrying the `RateLimitDetail`-shaped upgrade payload. **Tier is not a scope** — do not express it as `insufficient_scope`; that would send a paying user through a pointless re-authorisation.

- [ ] **Step 2** — Update the server card: `authentication.required` stays `false` (anonymous still works) but now advertises the OAuth metadata URLs and scopes. The card renders from the Go catalog, so extend the catalog rather than hand-editing the card.

- [ ] **Step 3** — Update `/docs/mcp.md` and `llms.txt` with the OAuth flow and the real tier numbers. **`llms.txt` was audited on 2026-08-28** — keep it accurate: state limits that match `DefaultConfig`, and do not reintroduce a link that 403s.

- [ ] **Step 4** — Commit: `feat(mcp): advertise OAuth and gate premium tools honestly`.

---

### Task 10: Conformance, live verification, PR

- [ ] **Step 1** — Extend `conformance_test.go`: anonymous still works; a valid token is accepted; a wrong-audience token is rejected with the right `WWW-Authenticate`; quota exhaustion produces the documented 429 payload.

- [ ] **Step 2** — Full suite, `go vet`, `golangci-lint`, web tests, drift test.

- [ ] **Step 3** — **Verify the whole flow against a real MCP client** — Claude or ChatGPT connecting via OAuth, not curl. Record what the consent screen shows and confirm tools work afterwards. Anything less does not prove one-click connectability, which is the point of the phase.

- [ ] **Step 4** — Open a PR. Do not merge. State the rollout order explicitly: **migration by hand on the session pooler first**, then the API, then the edge/Terraform, then the docs.

---

## Rollout order (the landmines)

1. **Apply the OAuth migration by hand** — session pooler **5432**, `PGOPTIONS="-c statement_timeout=0"` — *before* merging code that reads those tables, and add it to the terraform-deploy allowlist.
2. Deploy the Go API (resource server, AS, rate limiting).
3. Apply Terraform for the edge bucket.
4. Deploy Next.js (consent screen, docs).
5. Verify with a real client, then run the revalidation sweep — a promote resets ISR pages to placeholders.

## Explicitly out of scope

- Making authentication mandatory. Anonymous access is the adoption path.
- Any write or mutating tool.
- Retiring the deprecated Next.js MCP shim.
- Activating the dormant `shorted.com.au/*` worker route.

## Open risks

- **An open `/oauth/register` invites junk registrations.** Rate limit, cap per IP, expire unused clients.
- **CIMD fetches a URL an untrusted caller supplies** — SSRF is the obvious attack. Timeout, size cap, no private address space, no redirect chasing into it.
- **Refresh-token theft** is the highest-value target here. Rotation with family revocation is the mitigation; it must be tested, not assumed.
- **Audience becomes load-bearing on a token type that never had it.** The pre-existing-token path (absent `aud` valid for the Connect API, never for `/mcp`) is the compatibility seam — get it wrong and either every existing API token breaks, or the MCP audience check is decorative.
