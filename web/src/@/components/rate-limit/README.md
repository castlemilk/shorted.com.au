# Rate-limit UX + analytics

`RateLimitNotice` is the single surface a user sees when they hit a limit. It is
rendered by the page error boundary (`app/error.tsx`), the widget error boundary
(`components/ui/error-boundary.tsx`) and the standalone `/rate-limit` route.

Everything below is instrumentation for the rate-limit experience **and** the
adjacent developer surface (`/developer`), which is where a user who keeps
hitting API limits goes to fix it. Two independent streams, on purpose:

| Stream | Where it lands | What it answers |
|---|---|---|
| **GA4 events** | Google Analytics 4 (`window.gtag`) | What did a *user* experience, and did it convert? |
| **`product_event` logs** | stdout JSON + OTel counter | Which server paths are limiting, at what rate, to whom? |

---

## GA4 events (the funnel)

Helper: `src/@/lib/rate-limit-analytics.ts`. Names are exported as
`RATE_LIMIT_EVENTS` consts so call sites and GA4 config cannot drift.

```
rate_limit_encountered  ← EVERY classified 429, UI or not (the denominator)
   ├─► rate_limit_auto_recovered                        ← the quiet path
   └─► rate_limit_notice_shown ──► rate_limit_upgrade_click  ← the conversion
                               └─► rate_limit_signin_click   ← anonymous → free

rate_limit_page_view    ← arrival on /rate-limit from OUTSIDE the app
```

| Event | Fires when | Fires from |
|---|---|---|
| `rate_limit_encountered` | a classified 429 comes back on the wire, **whether or not anything renders** | `handleRateLimitCacheEvent` in `lib/query-client.ts` |
| `rate_limit_notice_shown` | a rate-limit notice is actually rendered to the user | `RateLimitNotice` mount effect |
| `rate_limit_upgrade_click` | the free-tier upgrade CTA is clicked | `TierCta` upgrade `<Link>` |
| `rate_limit_signin_click` | the anonymous sign-in CTA is clicked | `TierCta` sign-in `<Link>` |
| `rate_limit_auto_recovered` | a transient 429 was auto-retried and then succeeded | `handleRateLimitCacheEvent` in `lib/query-client.ts` |
| `rate_limit_page_view` | the standalone `/rate-limit` route is opened | `RateLimitPageClient` effect |

### `encountered` vs `notice_shown` — they are not duplicates

They count different nouns, and the gap between them is the point:

- **`rate_limit_encountered` counts requests.** It fires at the transport layer,
  before any UI decision. Most 429s here are background refetches that retry and
  succeed; the user never sees a thing, and before this event we could not see
  them either. It is the only denominator that makes the others rates.
- **`rate_limit_notice_shown` counts users seeing something.** It fires from the
  component, once per occurrence.

So one user-visible limit produces **one of each**. `notice_shown ÷ encountered`
is "what fraction of limiting is visible to a human" — if that climbs, the quiet
path is failing. `auto_recovered ÷ encountered` is its complement.

`rate_limit_page_view` and `notice_shown` also both fire on `/rate-limit`, and
again are not duplicates: the page view says the deep link was followed (this can
be a session's first event, arriving from an API error body or an email); the
`notice_shown` says the panel rendered, with `variant = page`.

### Params (all low-cardinality, no PII)

| Param | Values | Notes |
|---|---|---|
| `kind` | `per_minute` \| `monthly` \| `unknown` | which limit fired. `monthly` is the only upgrade moment |
| `tier` | `anonymous` \| `free` \| `paid` \| `unknown` | caller tier as resolved by the notice |
| `variant` | `inline` \| `page` | omitted on `rate_limit_auto_recovered` and `rate_limit_encountered` — there is no UI |
| `surface` | route **group**, e.g. `/shorts/*`, `/top`, `/` | never a full path; see `routeGroupFromPath` |
| `non_interaction` | `true` on `notice_shown`, `auto_recovered`, `encountered`, `page_view`; `false` on the two clicks | being limited is not engagement; clicking is |

On `rate_limit_page_view`, `kind` and `tier` come from the **query params the
link carried** (`?kind=monthly&tier=free`), so an unparameterised deep link
reports `unknown` for both rather than guessing.

### Suggested GA4 queries

- **Conversion rate:** `rate_limit_upgrade_click` ÷ `rate_limit_notice_shown`,
  segmented by `tier` (only `free` can convert) and `kind` (only `monthly`
  should show a CTA at all).
- **Sign-in lift:** `rate_limit_signin_click` ÷ `rate_limit_notice_shown` where
  `tier = anonymous`.
- **Is the quiet path working?** `rate_limit_auto_recovered` should dominate
  `rate_limit_notice_shown` with `kind = per_minute`. If `notice_shown /
  per_minute` climbs while `auto_recovered` does not, users are getting stuck.
- **Alarm:** any `notice_shown` with `tier = paid` — a paid caller should never
  see a limit.

### Safety properties (do not regress)

- GA absent (adblocked, not yet loaded, not configured) is a **no-op**;
  `trackRateLimitEvent` resolves `window.gtag` at call time and returns if it is
  not a function.
- Every call is wrapped in `try/catch`. Analytics cannot throw into render or
  into the retry path.
- The helper imports **nothing** at runtime (types only), so it adds ~0 to any
  shared chunk. Relevant because `/`, `/top` and `/statistics` are under a 5%
  first-load budget gate.
- `window.gtag` is installed by `deferred-google-analytics.tsx`, which **must**
  push `arguments` objects into `dataLayer`, not arrays — an array-shaped stub
  zeroed all GA traffic for 9 days in July 2026. Pinned by
  `components/__tests__/deferred-google-analytics.test.tsx`.

### Once-per-occurrence guards

Two of them, same idea, different re-render trap:

- `handleRateLimitCacheEvent` keeps a `reportedEncounters` map of
  `queryHash → kind|tier|resetWindow`. TanStack dispatches one `failed` action
  **per retry attempt**, so without this a single 429 with three retries would
  emit four `rate_limit_encountered` events and read 4x. The entry is dropped on
  success or terminal error, so the next real 429 counts again.
- `RateLimitPageClient` holds `kind|tier` in a ref, so StrictMode's double
  invoke and ordinary re-renders do not re-fire `rate_limit_page_view`, but a
  client-side param change (a second deep link in one session) does.

### Once-per-occurrence guard (the notice)

`RateLimitNotice` re-renders every second while its countdown ticks, so a naive
effect would emit one `notice_shown` per second. The effect is keyed on an
**occurrence key** — `kind | tier | variant | resetWindow` — held in a ref. A
tick does not change the key; a genuinely new 429 (new reset window) does, and
correctly re-fires. Asserted in
`__tests__/rate-limit-notice-analytics.test.tsx`.

---

## Developer surface (`/developer`)

Helper: `src/@/lib/developer-analytics.ts`, names in `DEVELOPER_EVENTS`. These
users are the ones most likely to hit an API limit, and until now we could not
tell whether any of them self-served.

```
api_token_view ──► api_token_created ──► api_token_copied
               ├─► api_token_regenerated    (rotation IS revocation here)
               └─► api_token_create_failed  (the silent failure)
```

| Event | Fires when | Fires from |
|---|---|---|
| `api_token_view` | the developer surface renders (once per mount, ref-guarded) | `ApiKeyManager` effect |
| `api_token_created` | a mint succeeded and the caller had **no** token | `handleGenerateToken` |
| `api_token_regenerated` | a mint succeeded over an existing token | `handleGenerateToken` |
| `api_token_copied` | the token was copied to the clipboard | `handleCopy` (both the clipboard and `execCommand` fallback paths) |
| `api_token_create_failed` | the mint threw — previously only local error state | `handleGenerateToken` catch |

Params: `surface` (hard-coded `/developer`) and `first_token` (boolean).
**No token material, ever** — not masked, not a prefix, not a length. There is
no explicit revoke in this product: regenerating invalidates the previous token,
so `api_token_regenerated` *is* the revocation event, named for what the user
does rather than what the backend does.

`api_token_view` ÷ `rate_limit_notice_shown` (with `tier != anonymous`) answers
"do limited users find the page that fixes it"; `api_token_copied ÷
api_token_created` catches a mint flow people abandon halfway.

The server side of the same flow is the `api_token` / `mint` `product_event`
below — GA is adblocked for a meaningful share of developers, so the two are
needed together.

---

## `product_event` (server / log side)

Contract in `src/@/lib/product-events.ts`. Rate-limit denials in web API route
handlers emit:

```jsonc
{
  "type": "product_event",
  "feature": "market_data",        // search | market_data | payment
  "action": "historical_prices",   // matches the existing per-route convention
  "status": "rate_limited",
  "route_group": "/api/market-data/*",
  "limit_kind": "per_minute",      // per_minute | monthly | unknown
  "tier": "anonymous"              // anonymous | authenticated | premium | …
}
```

`limit_kind` was **added to `ALLOWED_PROPERTY_KEYS`** for this, with a closed
value set (`LIMIT_KINDS`) — it is the join key against the edge rate-limit
events and the thing that separates a self-healing burst from an exhausted
quota. Every web-side bucket is a per-minute window, so these routes emit
`per_minute`; `monthly` is only ever enforced by the Go API.

`tier` on the denial comes from `rateLimit()`, which now returns the caller tier
it already computed — no second `auth()` round-trip.

### Emitting paths

| Feature | Actions | Where |
|---|---|---|
| `search` | `stocks` | `/api/search/stocks` |
| `market_data` | `historical_prices`, `multiple_quotes`, `correlations` | `/api/market-data/*` |
| `payment` | checkout / portal | `/api/stripe/*` |
| `community` | `pulse_post`, `pulse_reply`, `thread_create`, `comment_create`, `vote`, `report` | `/api/community/*` (6 routes) |
| `chat` | `sendmessage`, `getconversationhistory`, `listconversations`, `deleteconversation`, `other` | `enforceChatRateLimits` in `lib/chat-server-guards.ts` |
| `api_token` | `mint` | `app/actions/mintToken.ts` (statuses `success` / `error` / `unauthenticated`, **not** `rate_limited`) |

Notes on the two non-obvious ones:

- **Chat** is entitlement-gated, so a 429 there is always a *paying* user being
  told no — the highest-value rate-limit signal on the site, and it previously
  carried no telemetry at all. Its action label is mapped through the closed
  `ALLOWED_CHAT_METHODS` set (unknown → `other`) because the proxy route can
  reach the guard with an arbitrary method string, and an unbounded `action`
  would be a cardinality hole. Its `route_group` is derived from the request
  path because two entry routes (`/api/chat` and `/chat.v1.ChatService/[method]`)
  share the guard.
- **`limit_kind` gained `daily`.** Chat sends are capped per minute, per day and
  per month; the daily window exists only server-side, so `RateLimitKind` in
  `retry.ts` has no such member. Calling a daily cap `per_minute` would be
  wrong; calling it `unknown` would erase the only interesting thing about it.
  Still a closed set.

`/api/community/*` was explicitly deferred in #469 and is now covered; every one
of those buckets is a 60s window, so they all emit `per_minute`.
