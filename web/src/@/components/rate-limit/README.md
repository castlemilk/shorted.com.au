# Rate-limit UX + analytics

`RateLimitNotice` is the single surface a user sees when they hit a limit. It is
rendered by the page error boundary (`app/error.tsx`), the widget error boundary
(`components/ui/error-boundary.tsx`) and the standalone `/rate-limit` route.

Everything below is instrumentation. Two independent streams, on purpose:

| Stream | Where it lands | What it answers |
|---|---|---|
| **GA4 events** | Google Analytics 4 (`window.gtag`) | What did a *user* experience, and did it convert? |
| **`product_event` logs** | stdout JSON + OTel counter | Which server paths are limiting, at what rate, to whom? |

---

## GA4 events (the funnel)

Helper: `src/@/lib/rate-limit-analytics.ts`. Names are exported as
`RATE_LIMIT_EVENTS` consts so call sites and GA4 config cannot drift.

```
rate_limit_notice_shown ──► rate_limit_upgrade_click   ← the conversion
                        └─► rate_limit_signin_click    ← anonymous → free
rate_limit_auto_recovered                              ← the quiet path
```

| Event | Fires when | Fires from |
|---|---|---|
| `rate_limit_notice_shown` | a rate-limit notice is actually rendered to the user | `RateLimitNotice` mount effect |
| `rate_limit_upgrade_click` | the free-tier upgrade CTA is clicked | `TierCta` upgrade `<Link>` |
| `rate_limit_signin_click` | the anonymous sign-in CTA is clicked | `TierCta` sign-in `<Link>` |
| `rate_limit_auto_recovered` | a transient 429 was auto-retried and then succeeded | `handleRateLimitCacheEvent` in `lib/query-client.ts` |

### Params (all low-cardinality, no PII)

| Param | Values | Notes |
|---|---|---|
| `kind` | `per_minute` \| `monthly` \| `unknown` | which limit fired. `monthly` is the only upgrade moment |
| `tier` | `anonymous` \| `free` \| `paid` \| `unknown` | caller tier as resolved by the notice |
| `variant` | `inline` \| `page` | omitted on `rate_limit_auto_recovered` — there is no UI |
| `surface` | route **group**, e.g. `/shorts/*`, `/top`, `/` | never a full path; see `routeGroupFromPath` |
| `non_interaction` | `true` on `notice_shown` / `auto_recovered`, `false` on the two clicks | being limited is not engagement; clicking is |

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

### Once-per-occurrence guard

`RateLimitNotice` re-renders every second while its countdown ticks, so a naive
effect would emit one `notice_shown` per second. The effect is keyed on an
**occurrence key** — `kind | tier | variant | resetWindow` — held in a ref. A
tick does not change the key; a genuinely new 429 (new reset window) does, and
correctly re-fires. Asserted in
`__tests__/rate-limit-notice-analytics.test.tsx`.

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

Emitting routes: `/api/search/stocks`, `/api/market-data/{historical,
multiple-quotes,correlations}`, `/api/stripe/{checkout,portal}`.
