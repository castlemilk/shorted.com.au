# MCP server: OAuth 2.1, the public tools and the admin server

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

Companions: `docs/mcp-admin.md` (the admin server), `docs/superpowers/handover-2026-08-29-mcp-oauth.md` (the OAuth record), `web/public/docs/mcp-markdown.md` (the connection guide).

## MCP server — OAuth 2.1, 32 tools, protocol `2026-07-28`

`https://api.shorted.com.au/mcp` — read-only Model Context Protocol access to
everything above: short positions, stocks, housing, economy, the register of
interests, ownership. **LIVE on prod**, streamable HTTP, 32 read-only data tools, 3 resources,
3 prompts. Plus six alert tools (`list_my_alerts`, `create_alert`, `pause_alert`, `resume_alert`,
`delete_alert`, `list_my_alert_history`) for the signed-in user's own alerts, served ONLY to a
token carrying `alerts:write` (`services/shorts/internal/mcp/alerts_write.go`,
`HandlerWithAlerts`). The one write scope, and the one exception to the read-only rule below.
Anonymous and unscoped callers also see ONE discovery tool, `manage_my_alerts`
(`alerts_discovery.go`), which does nothing itself: calling it returns the sign-in challenge
(401 `resource_metadata` + `scope="alerts:write"` for an anonymous caller; 403
`insufficient_scope` for a signed-in caller without the scope), before any tool runs. Scoped
callers do not see it. The challenge is a status code, not a tool result, because a client starts
its OAuth flow on the status.
Go SDK (`modelcontextprotocol/go-sdk`), served by the shorts API.

**The product promise, and the constraint every change here answers to:** a user
adds the URL to Claude or ChatGPT and the client does the rest — challenge,
discovery, registration, browser consent, callback, token, tools. Nothing
hand-configured. **Anonymous access must keep working**: OAuth *raises* limits
and identifies a caller, it is never a gate on first contact, and no tool is
reserved for a paid plan.

The Go API is BOTH the resource server and the authorization server, on purpose:
access tokens are HS256 with a symmetric secret, so splitting mint and verify
across two platforms would mean sharing that secret and rotating it twice.
Next.js contributes only the consent screen.

### Key files

| File | Purpose |
|------|---------|
| `services/shorts/internal/mcp/` | Server, registry, 32 tools, catalog, resources, prompts |
| `services/shorts/internal/mcp/auth.go` | Audience-bound verification, RFC 9728 metadata, `OptionalBearerToken` |
| `services/shorts/internal/mcp/ratelimit.go` | Per-tool-call cost, identity, JSON-RPC 429 |
| `services/shorts/internal/oauth/` | AS metadata, consent tickets, grant, token, CIMD + DCR |
| `services/pkg/ratelimit/http.go` | `HTTPMiddleware` — the same limiter, over plain HTTP handlers |
| `web/src/app/oauth/authorize/` | Consent screen (page + client component + server actions) |
| `services/migrations/000116_*` | `oauth_clients`, `oauth_consent_tickets`, `oauth_authorization_codes`, `oauth_refresh_tokens` |
| `web/public/docs/mcp-markdown.md` | The connection guide served at `/docs/mcp.md` |

### The rules that shape every change here

- **A grant needs a CONSENT TICKET, not just an identity.** The grant was once
  authenticated by a Firebase ID token alone — that proves someone holds a
  credential, not that a human approved anything, and with open dynamic
  registration it was exploitable end to end. Tickets are mintable ONLY via
  `POST /oauth/consent/ticket` behind `INTERNAL_SERVICE_SECRET`, so minting
  needs a server-held secret an attacker with a stolen credential does not have.
  Single-use, ~2 min, hashed, bound to user + client + redirect URI + PKCE
  challenge + resource + scope — **all six re-checked by the grant**.
- **Do not require a Firebase ID token in the browser.** next-auth's cookie
  lives 30 days and the Firebase client session does not, so a properly
  signed-in user often cannot produce one. Requiring it fails real users,
  silently and only for some of them. It is an optional cross-check.
- **Tier is not a scope.** Every scope is read-only except `alerts:write`, which
  is the one write scope and names the signed-in user's own alerts, not a plan. Every
  other scope names a data domain
  (`shorts:read`, `housing:read`, `economy:read`, `politics:read`). Expressing a
  plan as a scope would send a paying customer through a pointless
  re-authorisation to fix a quota problem.
- **Never publish a ceiling you do not enforce.** The catalog reports
  `authentication.rateLimits.enforced` read from the RUNNING config, and derives
  the numbers from `ratelimit.DefaultConfig` rather than restating them. #455 was
  three published rows over-promising against the code; this is the same defect
  in the other direction.
- **Loopback redirect URIs ignore the PORT (RFC 8252 §7.3), and nothing else.**
  A desktop client registers `127.0.0.1:51763` and listens on a different
  ephemeral port next time, because binding a fixed port is what would be
  insecure. Host, scheme, path, query and fragment stay exact-match.

### Landmines

- **Anonymous access is never challenged, and that is the adoption path.** MCP
  auth is challenge-driven: a client learns OAuth exists from a `401` carrying
  `WWW-Authenticate`. First contact must stay free, so the ONLY place we
  challenge is the ceiling — an anonymous caller who exhausts their quota gets a
  **401** (not a 429) with the RFC 9728 challenge, because clients branch on the
  status and a 429 is a transport failure to all of them. An *authenticated*
  caller at their ceiling gets a plain 429: they have already done what a
  challenge asks, and what they need is `upgrade_url`. Do NOT "fix" adoption by
  gating anonymous access. (Before this, OAuth was live but fully dormant —
  measured 2026-08-30, a real client connected, got 24 tools (32 today), stored no auth
  state and never started the flow.)
- **`RATE_LIMIT_ENABLED` is now TRUE in prod (Terraform, `shorts-api` module).**
  It was off everywhere until the app layer could tell our own traffic apart:
  the Connect interceptor buckets unauthenticated callers as `ip:<address>` at
  the anonymous tier, and Vercel SSR arrives from a handful of shared egress IPs
  with no token. The **`first-party` / `first-party-unverified` tiers**
  (`interceptor.go` `classifyFirstParty`) are that class, keyed `first-party:<ip>`
  and matched on the SAME user-agent marker + secret header the edge worker uses
  — change one layer's marker and you must change the other. **Both classes are
  per-minute UNLIMITED**: this class carries our own SSR *and* every anonymous
  browser RPC (middleware stamps the marker on rewrite-proxied paths), so a
  rejection here does not throttle one caller — it fails every reader behind
  that shared egress address at the same instant. The edge's first-party bucket
  (600/10s) is the ceiling for it, and the 200k monthly meter on the
  *unverified* class is what makes copying the marker worthless. The secret
  therefore decides only the MONTHLY ceiling, so a rotation gap or an unreadable
  env var costs a meter, never a 429 on our own site. That asymmetry
  is deliberate; the edge learned it the expensive way (7,045 self-inflicted
  429s when CI's prerender could not read the sensitive var).
- **Resolving WHO a caller is takes THREE layers, and any one alone does
  nothing.** `buildPublicEdgeReadHeaders` (synthesized `/edge/v1/*` requests must
  copy the address AND the bypass secret forward — a marker without its proof is
  `first-party-unverified`), `filterRequestHeaders` (strip client-supplied hops
  first, then re-add Cloudflare's own `cf-connecting-ip`), and `resolveClientIP`
  (believe those headers only when the rightmost forwarded hop is a published
  Cloudflare address, because Cloud Run is publicly reachable). Symptom when it
  breaks: every identifier in `api_usage_monthly` is a Cloudflare address and
  callers behind a colo share one bucket. Measured 2026-08-30/31 — **two
  consecutive fixes deployed cleanly and changed nothing**, each blocked by a
  different layer. A deploy succeeding proves nothing here: snapshot
  `api_usage_monthly`, wait a flush cycle, diff, and classify what grew.
- **Ordinary browsing carries NO auth token** (no auth interceptor on
  `client-api.ts`'s transport), so page views land in `first-party`, not on a
  user identity. The published free browser cap is therefore **not reachable by
  browsing** — only authenticated feature calls touch it. Corollary: a reader
  cannot be rejected by the app layer at all, so browser 429s are the edge or the
  zone rule.
- **The `/oauth/` routes render WITHOUT the site header and footer**, and the
  success screen's `min-h-screen` depends on that. Chrome is dropped in
  `conditional-header.tsx` / `conditional-footer.tsx` (the same mechanism embed
  and roadmap use) because a nav bar beside a consent decision invites people to
  wander off mid-authorisation. Put chrome back and the approval screen exceeds
  the viewport, the page scrolls, and on a phone the artwork is clipped out of
  sight before anyone sees it. `conditional-chrome.test.tsx` pins the routing;
  the height coupling is a comment, not a test.
- **Approving holds the browser for ~1.5s before redirecting.** Without the
  pause the navigation fires within a frame and the confirmation is never seen,
  which is exactly when people wonder whether it worked. It is not latency to
  trim.
- **`Stateless: true` on the streamable handler is load-bearing.** Without it the
  SDK silently negotiates *down* to legacy `initialize`, and an in-memory
  transport cannot detect it. Any test for protocol behaviour must drive a real
  socket.
- **Not every MCP request is a call — some are streams, and the platform will
  end them for you if you do not.** A `subscriptions/listen` POST (SEP-2575) has
  no synchronous result: the SDK acknowledges the subscription and blocks.
  **There are TWO ceilings on that, at different times, costing different
  things** — Cloudflare's **120s** proxy read timeout is what the CLIENT sees (a
  stream that sends no bytes for 120s earns a 524), and Cloud Run's **300s** is
  what WE pay (the request slot stays occupied). Measured 2026-09-10: all 53 API
  POST 5xx in 24h were `/mcp`, every one with an origin latency of 299.98s
  reported at the edge as 524, from a perfectly healthy client — the edge bailing
  early while the origin held on. **A first fix at 240s cleared only the second
  ceiling; a prod probe still returned `524 total=127.5s`.**
  `mcp.StreamLifetime` is now **90s**, under both: the stream ends as a completed
  200 and the client reconnects as it already does. Nothing is lost by ending
  early — this server's tools, prompts and resources are static, so a listen
  stream has no notification to deliver. `TestStreamLifetimeClearsBothTimeouts`
  reads the 300s out of `terraform/modules/shorts-api/main.tf` rather than
  restating it, and carries the Cloudflare number with the probe that measured
  it (that one is a plan default, not in this repo). A test for this must use a
  data source — **a server with no tools honours no subscriptions and completes
  the listen instantly**, so against `Handler(nil)` it passes with the bound
  removed.
- **Tools call `ShortsServer` IN PROCESS**, skipping the Connect interceptor
  chain — which is why they are constrained to `VISIBILITY_PUBLIC` methods
  (`TestToolsOnlyCallPublicMethods`) and why rate limiting needed its own HTTP
  middleware rather than riding the interceptor.
- **Rate limiting is composed INSIDE the bearer middleware.** Outside it, the
  identity function sees no verified token and every authenticated caller is
  metered as anonymous.
- **`encoding/json` refuses `±Inf`; protojson does not.** Same value, two
  behaviours — which is why the website's screener worked while MCP's died.
  Guarded at the write funnel in `services/pkg/keymetrics/finite.go`. Note
  **Postgres accepts `-NaN`/`+NaN` where Go's `ParseFloat` does not**, so that
  guard cannot lean on `ParseFloat` alone.
- **The MCP SDK emits no `$defs`/`$ref`** — every nested struct is inlined at
  every use site. `tools/list` is ~97KB for 32 tools (99,763 of the 101,376 B budget), paid every session; the
  lever is fewer fields and fewer redundant descriptions, never flattening. An
  `int32` output field costs ~55 bytes of schema bounds an `int` does not.
- **The SDK exports no setter for `TokenInfo` in a context.** A test wanting an
  authenticated request must drive `auth.RequireBearerToken` — which is
  fortunate, because a faked context would pass even with the middleware
  composed in the wrong order.
- **`/mcp` is never cached and is not exempt from the edge.** A cached MCP
  response is one client's session served to another. Its edge bucket is
  `mcp-anon` (`m:<ip>`, 60/10s + 300/60s), resolved AFTER the credential check so
  presenting a token is never a downgrade.
- **Migration `000116` is in the deploy allowlist and REPLAYED every deploy** —
  every statement is `IF NOT EXISTS` and touches no rows. Supabase ships its own
  unrelated `auth.oauth_*` tables; ours are in `public`, so pin `search_path` on
  any hand-apply.

Full record: `docs/superpowers/handover-2026-08-29-mcp-oauth.md`.

**Admin MCP server — `/mcp/admin`** (`docs/mcp-admin.md`). A SECOND resource
for administrators, connected once as a claude.ai custom connector:
`publish_news_article` / `news_publish_status` (scope `news:publish`) and
`run_picks_job` / `picks_job_status` (scope `jobs:run`, starts `shorted picks
-mode fundamentals|filings|refresh|all` via a `run.developer` grant on that one
job, argv built server-side from the enum in `jobmonitor/picks.go`), the alerts
smoke test (`run_alerts_smoke_test`, `find_alert_crossing`, `alerts_status`,
`alerts_smoke_result`, `delete_alert_monitor`: the caller's own account only;
the replay is `shorted-alerts-replay` with the argv from
`jobmonitor/alerts_replay.go`, and the monitor rule is shared with the web
handlers through `services/shorts/internal/services/shorts/alerts_core.go`),
the `jobs:read` fleet tools, and the `users:read` personal-data tools
(`people_overview`, `list_users`, `list_paying_users`, `list_mailing_list`,
`lookup_person`: Firebase accounts via the web app's `/api/internal/admin-users`,
`api_subscriptions`, the `subscriptions` mailing list; minimal fields, every
call logged with its actor), and the housing crawl authorization
(`housing_crawl_rigs` / `housing_crawl_authorize`, scope `crawl:authorize`:
turns a BrandBrain rig on or off on both shorted's `housing_ingest_rigs` and
BrandBrain's `housing_crawl_v1` grant; `internal/brandbrain` is the client, and
`docs/mcp-admin.md` "Housing crawl authorization" has the sequencing). It is a
separate OAuth resource with its own scope vocabulary (`oauth/resources.go`) —
on the public server, the read-only rule has ONE exception: `alerts:write`
(`mcp.Scopes`), which unlocks the signed-in user's own alert tools. Constraints that
keep it safe, each tested: those tools are NOT in `Registry()`, and a
second prebuilt server lists them only to a request whose VERIFIED token carries the
scope (`HandlerWithAlerts`; `Stateless: true` stays on, the choice is per request);
anonymous and unscoped `tools/list` are the old list plus `manage_my_alerts`, and nothing else changes; the owner is the verified
token's uid and no tool takes one; every write goes through `alerts_core.go`; and a
token gets the scope only when it asks for it by name, never by default
(`mcp.DefaultScopes`). Any other write tool or non-`:read` scope still needs its own
decision, documented the same way. Admin scopes stay separate. Admin scopes name actions and are checked PER TOOL; the HTTP
layer requires at least one, never all, so adding a scope does not log an
existing connector out (a token minted before the scope gets a tool error
naming it). Admin = verified email on the web app's `ADMIN_EMAILS`, resolved
from the token's uid via the web app's `/api/internal/admin-check` and
re-checked at ticket, grant, token, every refresh and every request.

