# Property.com.au AVM valuations — read path + frontend (implementation spec)

**Status: DESIGN ONLY — nothing here is implemented.** This is a Codex-ready spec for
surfacing the `property_valuations` corpus (property.com.au / PropTrack AVM, crawled by
`house-price-collector -mode property`) on the existing per-address page
`/housing/property/[addressKey]`.

**Hard prerequisite:** the write side lives on branch `fix/property-resolver-search`
(PR #340) — migrations `000088_add_property_valuations` + `000091_add_property_valuation_granularity`
and the `-mode property` crawler. This read path assumes those are merged (or, for local
verify only, the two migration files hand-applied). Base the read-path branch on main
*after* #340 lands.

---

## 0. Data model being read (do not change it)

`property_valuations` — one row per physical address, keyed by the **same canonical
`address_key`** as `property_listings` (see `services/migrations/000088_add_property_valuations.up.sql`
on the #340 branch):

| column | notes |
|---|---|
| `address_key TEXT PRIMARY KEY` | bridges 1:1 to `property_listings.address_key` |
| `source` | `'property.com.au'` |
| `profile_url` | resolved property.com.au profile URL (deep-link-out target) |
| `fetched_at`, `fetch_status` | `ok\|blocked\|notfound\|error` — **only `ok` rows are servable** |
| `estimate_low/mid/high DOUBLE PRECISION` | AVM range + point estimate, AUD |
| `estimate_confidence TEXT` | free string; exact enum unverified — do NOT switch on values |
| `rent_estimate_mid` | weekly rent estimate; key existence still unverified upstream — render only when > 0 |
| `bedrooms/bathrooms/car_spaces SMALLINT`, `land_size_sqm`, `building_size_sqm`, `year_built SMALLINT`, `property_type` | attributes from the profile |
| `latitude/longitude` | **not exposed in v1** (see §2 exclusions) |
| `sales_history JSONB` | `[{date, price, agency, type}]`, lower-snake tags, `price` may be absent (undisclosed) — shape pinned by `saleRecord` in `services/house-price-collector/crawl_property_extract.go` (branch), json tags `date/price/agency/type` with `omitempty` |
| `raw JSONB` | recognized-fields payload — **NEVER exposed over any RPC** |
| `source_licence` | `'proprietary-tos-restricted'` — internal audit field, not exposed |
| `content_hash` | internal, not exposed |
| `valuation_granularity TEXT` (migration 000091) | `'exact'` \| `'building'` \| NULL. **`'building'` = a unit address that fell back to its whole-BUILDING AVM.** The UI MUST label it "building estimate" and must not present it as unit-precise. NULL only on notfound/error/blocked rows (which we never serve). |

Licence posture (mirrors the listings tier, `docs/housing-architecture.md` §10.2): derived
figures are displayable; per-address surfaces deep-link OUT to the live portal; raw is
never republished; the surface sits behind a kill switch.

---

## 1. RPC decision: EXTEND `GetPropertyHistory` (recommended) — no new RPC

**Extend `GetPropertyHistoryResponse` with an optional `PropertyValuation valuation = 12` block.**

Why extend rather than add `GetPropertyValuation(address_key)`:

1. **One fetch for the address page.** The page's only data source is
   `getPropertyHistoryClient(addressKey)` (`web/src/app/actions/client/getHousingClient.ts:171-187`),
   already session-cached and retry-wrapped. A second RPC means a second round trip, a
   second loading state, and a second session-cache entry for the same page.
2. **The whole cross-cutting checklist vanishes.** A new RPC must be dual-added to the
   legacy `ShortedStocksService` in `shorts.proto` (dual-add contract, enforced by
   `services/shorts/internal/services/shorts/proto_parity_test.go`), annotated with
   visibility on both copies, and considered for `internalOnlyMethods`. Extending a
   message touches none of that: `HousingService` and the legacy service already share
   the `GetPropertyHistoryResponse` message (messages live only in `housing.proto`;
   `shorts.proto` is message-less), so both services pick the field up for free and the
   parity test is unaffected.
3. **Coherent gating + caching.** `GetPropertyHistory` is already flag-gated
   (`dropListingsEnabled()`, `services/shorts/internal/services/shorts/house_prices.go:434-441`)
   and cached under one `MemoryCache` key (`GetPropertyHistoryKey`, `cache.go:256-259`).
   The valuation rides inside the same cached response — no cache-coherence split.
4. **Invariant: valuations ⊆ listing addresses.** The crawler's work-list is seeded from
   distinct `property_listings` addresses (000088 header comment), so there is no
   "valuation exists but history doesn't" consumer that would want a standalone RPC.
   (Corollary: the handler's existing early-return when no listing exists —
   `house_prices.go:448-450` — is acceptable; a valuation without listings is
   unreachable by construction. Note it in a comment, don't redesign for it.)

Proto-3 message fields are inherently optional: `valuation` is simply unset (`undefined`
in connect-es) when no valuation exists — old clients ignore it, new clients null-check.

### Gating: one new kill switch, ON by default

The valuation block inherits `HOUSING_DROP_LISTINGS_ENABLED` (whole response is gated)
**and** gets its own independent kill switch **`HOUSING_VALUATIONS_ENABLED`** (default
ON; only `"false"/"0"/"off"/"no"` disables — copy the `dropListingsEnabled()` idiom at
`house_prices.go:380-...`). Rationale: property.com.au's robots.txt names aggregators
explicitly (ToS escalation over REA/Domain — see memory `property-com-au-crawler.md`),
so the operator must be able to pull the AVM surface without killing the whole
price-history page. Same pattern as the `ListAgencyPriceStats` dedicated gate. When off:
`valuation` is simply omitted; the rest of the response is unchanged.

---

## 2. Proto changes — `proto/shortedapi/shorts/v1alpha1/housing.proto`

Current `GetPropertyHistoryResponse` occupies fields **1–11** (housing.proto:411-430) →
next free is **12**. Add (place the new messages after `GetPropertyHistoryResponse`):

```protobuf
// One historical sales/timeline event from the valuation source's property
// profile (property.com.au timeline). Distinct from PropertyPriceEvent: these
// are the portal's own transaction history (sold/listed/rented, potentially
// decades back), not our crawl-observed asking-price events.
message PropertyValuationSale {
  string date = 1;        // ISO date 'YYYY-MM-DD' ('' when unparsed)
  double price = 2;       // AUD; 0 = undisclosed (source omitted the figure)
  string agency = 3;      // '' when not captured
  string event_type = 4;  // source badge text, e.g. 'Sold' | 'Listed for sale' | 'Rented'
}

// AVM valuation snapshot for a physical address (property.com.au / PropTrack
// AVM). DERIVED figures from a proprietary-tos-restricted source: the raw
// harvested profile is never exposed; this surface deep-links OUT to the
// source profile. Absent entirely when the address has no successful
// valuation, or when the valuations kill switch is off.
message PropertyValuation {
  string source = 1;                 // 'property.com.au'
  string profile_url = 2;            // deep link OUT to the source profile page
  string fetched_at = 3;             // RFC3339 — AVMs are point-in-time; UI must show this
  double estimate_low = 4;           // AVM range low, AUD (0 = not provided)
  double estimate_mid = 5;           // AVM point estimate, AUD (0 = not provided)
  double estimate_high = 6;          // AVM range high, AUD (0 = not provided)
  string estimate_confidence = 7;    // source confidence string ('' when not exposed); free-form
  // 'exact'    — the profile is the exact dwelling this address names
  // 'building' — a unit whose own profile isn't indexed; this is the whole
  //              BUILDING's AVM used as a fallback. Consumers MUST label it
  //              "building estimate" and MUST NOT present it as unit-precise.
  string valuation_granularity = 8;
  double rent_estimate_mid = 9;      // weekly rent estimate, AUD (0 when not exposed)
  int32  bedrooms = 10;              // 0 = unknown
  int32  bathrooms = 11;
  int32  car_spaces = 12;
  double land_size_sqm = 13;         // 0 = unknown
  double building_size_sqm = 14;     // floor area; 0 = unknown
  int32  year_built = 15;            // 0 = unknown
  string property_type = 16;         // '' = unknown
  repeated PropertyValuationSale sales_history = 17;  // newest first
}
```

And on the response:

```protobuf
message GetPropertyHistoryResponse {
  // ...existing fields 1-11 unchanged...
  // AVM valuation for this address (property.com.au). Unset when none exists,
  // fetch_status != 'ok', or HOUSING_VALUATIONS_ENABLED is off.
  PropertyValuation valuation = 12;
}
```

**Deliberate exclusions** (do NOT add): `raw` (never leaves the DB), `content_hash`,
`fetch_status`, `source_licence` (internal audit; posture is enforced server-side),
`latitude`/`longitude` (no map on this page; smallest possible ToS surface — revisit
only if a locator map is wanted). **No int64 fields** — protobuf-es maps int64→BigInt,
which breaks the JSON session cache (BigInt trap noted in `price-drops-caching` memory);
everything here fits int32/double/string.

Then `cd proto && buf generate` and **commit ALL outputs** including the `sdks/java`
churn and `web/src/gen/shorts/v1alpha1/housing_pb.ts` (repo convention, root CLAUDE.md
"Adding a New API Endpoint" step 2). No `serve.go`, `next.config.mjs`, or
`internalOnlyMethods` changes — no new service or rpc.

---

## 3. Backend

### 3.1 Store — `services/shorts/internal/store/shorts/postgres_house_prices.go`

Add row types + one method (pattern-match `GetPropertyHistory` at lines 819-914):

```go
// PropertyValuationSaleRow is one entry of property_valuations.sales_history.
// json tags mirror the collector's saleRecord (crawl_property_extract.go) exactly.
type PropertyValuationSaleRow struct {
    Date   string   `json:"date"`
    Price  *float64 `json:"price"`   // nil = undisclosed
    Agency string   `json:"agency"`
    Type   string   `json:"type"`
}

// PropertyValuationRow is the servable slice of a property_valuations row.
// Raw/content_hash/lat/lng deliberately never leave the store layer.
type PropertyValuationRow struct {
    Source               string
    ProfileURL           string
    FetchedAt            time.Time
    EstimateLow          float64
    EstimateMid          float64
    EstimateHigh         float64
    EstimateConfidence   string
    ValuationGranularity string // 'exact' | 'building'
    RentEstimateMid      float64
    Bedrooms, Bathrooms, CarSpaces int32
    LandSizeSqm, BuildingSizeSqm   float64
    YearBuilt            int32
    PropertyType         string
    SalesHistory         []PropertyValuationSaleRow
}

// GetPropertyValuation returns the AVM snapshot for one address, or nil when
// no successful valuation exists. Only fetch_status='ok' rows are servable;
// blocked/notfound/error rows (and their NULL granularity) never surface.
func (s *postgresStore) GetPropertyValuation(addressKey string) (*PropertyValuationRow, error)
```

Query (COALESCE every nullable; **never select `raw`, `content_hash`, `latitude`,
`longitude`, `source_licence`**):

```sql
SELECT COALESCE(source, ''), COALESCE(profile_url, ''), fetched_at,
       COALESCE(estimate_low, 0), COALESCE(estimate_mid, 0), COALESCE(estimate_high, 0),
       COALESCE(estimate_confidence, ''), COALESCE(valuation_granularity, ''),
       COALESCE(rent_estimate_mid, 0),
       COALESCE(bedrooms, 0), COALESCE(bathrooms, 0), COALESCE(car_spaces, 0),
       COALESCE(land_size_sqm, 0), COALESCE(building_size_sqm, 0),
       COALESCE(year_built, 0), COALESCE(property_type, ''),
       COALESCE(sales_history, '[]'::jsonb)
FROM property_valuations
WHERE address_key = $1 AND fetch_status = 'ok'
```

Implementation notes:
- `pgx.ErrNoRows` → `(nil, nil)` (no valuation is the normal case for most addresses).
- Scan `sales_history` into `[]byte`, `json.Unmarshal` into `[]PropertyValuationSaleRow`;
  on unmarshal error, log-warn and return the row with empty `SalesHistory` (a corrupt
  JSONB must not kill the valuation, let alone the page).
- 10s context timeout, same as the sibling method (line 820).

### 3.2 Interface + mocks

- `services/shorts/internal/services/shorts/interfaces.go` — add
  `GetPropertyValuation(addressKey string) (*shortsstore.PropertyValuationRow, error)`
  to the `ShortsStore` interface, next to `GetPropertyHistory` (line 125).
- Regenerate mocks:
  `mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks`
  (directive at the top of `mocks/mock_interfaces.go`).

### 3.3 Handler — `services/shorts/internal/services/shorts/house_prices.go`

Inside the existing `GetPropertyHistory` `GetOrSet` closure (after the history mapping,
before constructing the response at line 474):

```go
var valuation *shortsv1alpha1.PropertyValuation
if valuationsEnabled() { // new gate, ON by default — see §1
    v, verr := s.store.GetPropertyValuation(m.AddressKey)
    if verr != nil {
        // WARN-ONLY degradation: the valuation is an enrichment. A failure here
        // (including "relation property_valuations does not exist" on a
        // pre-migration environment) must never 500 the history page.
        s.logger.Warnf("GetPropertyValuation(%s): %v", m.AddressKey, verr)
    } else if v != nil {
        valuation = toPropertyValuationProto(v)
    }
}
```

`toPropertyValuationProto` is a straight field-for-field map;
`FetchedAt.Format(time.RFC3339)` for the timestamp (matches the response's existing
RFC3339-string convention, e.g. `FirstSeenAt` at line 458); sale rows map
`Price: derefOrZero(r.Price)`. Set `Valuation: valuation` on the response literal
(line 474-480).

- **Caching**: no new cache key — the valuation is cached inside the existing
  `property_history:<addressKey>` MemoryCache entry. Flag flips take effect after cache
  expiry/restart; acceptable for a kill switch.
- **Gating recap**: `dropListingsEnabled()` off → whole response empty (unchanged);
  `valuationsEnabled()` off → history serves, `valuation` omitted.
- Add `valuationsEnabled()` next to `dropListingsEnabled()` (line 374-386), reading
  `HOUSING_VALUATIONS_ENABLED`, identical falsey-only-off semantics, with a comment
  citing the property.com.au ToS escalation.

### 3.4 Backend tests — `house_prices_test.go`

Extend the existing `GetPropertyHistory` tests (mock store):
1. valuation present + `exact` → response carries the block, fields mapped.
2. valuation present + `building` → `valuation_granularity == "building"` passes through untouched.
3. store returns `(nil, nil)` → `Valuation == nil`, history intact.
4. store returns error → `Valuation == nil`, history intact, **no RPC error** (warn-only path).
5. `HOUSING_VALUATIONS_ENABLED=false` (t.Setenv) → store's valuation method not called, `Valuation == nil`.
6. sales_history mapping incl. a nil-price sale → `price == 0`.

---

## 4. Frontend

### 4.1 Where it renders

The page `web/src/app/housing/property/[addressKey]/page.tsx` renders
`PropertyHistoryView` via the existing `dynamic({ssr:false})` loader
(`web/src/@/components/housing/property-history-view-loader.tsx`) — everything below it
is already client-only, so **no new loader and no RSC boundary concerns**: the AVM card
is a plain component imported directly by `property-history-view.tsx`. No function
props cross any server→client boundary (the whole tree is client-side), and no chart
library is needed — the range visual is pure CSS/SVG.

### 4.2 New component — `web/src/@/components/housing/property-valuation-card.tsx`

```tsx
import type { PropertyValuation } from "~/gen/shorts/v1alpha1/housing_pb";
export function PropertyValuationCard({ valuation }: { valuation: PropertyValuation }) { ... }
```

Rendered from `PropertyHistoryView` (`property-history-view.tsx`, insert between
`<CurrentListingCard/>` (line 120) and `<SummaryStrip/>` (line 122)):

```tsx
{data.valuation ? <PropertyValuationCard valuation={data.valuation} /> : null}
```

No valuation → the card is simply absent (no empty state). No new client action —
`getPropertyHistoryClient` already returns the whole response (session cache at
`getHousingClient.ts:174-182` serializes the new fields fine: no BigInt, see §2).

Card contents (follow the existing card idiom — `rounded-xl border border-border
bg-card p-5`, serif `h2` with `HousingIcon`, `font-mono tabular-nums` figures — exactly
as `CurrentListingCard` / `PriceTrendChart` in the same file):

1. **Header**: `Estimated value` + a right-aligned source line
   `property.com.au estimate` — and, when `profile_url` is set, a
   `View on property.com.au ↗` anchor with
   `target="_blank" rel="noopener noreferrer nofollow"` (deep-link-out posture, same as
   the `View live listing ↗` anchor at lines 235-244).
2. **Estimate block**: `estimate_mid` large (`fmtPriceShort` from
   `@/lib/housing/price-scale`), low–high underneath (`$1.2M – $1.4M range`), plus a
   simple CSS range bar: a muted track with a marker at the mid position
   (`(mid-low)/(high-low)`, clamped; render the bar only when `low>0 && high>low`).
   Render the block only when `estimate_mid > 0`; if only attributes exist, the card
   still shows them (header text falls back to `Property details`).
3. **Confidence badge**: when `estimate_confidence !== ""`, a muted pill with the raw
   string (`{confidence} confidence`, lowercased). Free-form — never `switch` on values.
4. **BUILDING-ESTIMATE badge (the landmine)**: when
   `valuation.valuationGranularity === "building"`, an amber warning pill
   `Building estimate` rendered immediately next to the price, wrapped in the shadcn
   `Tooltip` (`web/src/@/components/ui/tooltip.tsx`) with copy:
   > “This unit isn’t individually indexed by the valuation source, so this is the
   > estimate for the whole building — not this specific unit.”
   Also append an inline sentence under the range (tooltips are undiscoverable on
   mobile): `Whole-building estimate — this specific unit isn’t individually valued.`
   The card must never show a bare unit-precise-looking figure for a `building` row.
5. **Attributes row**: chips for beds/baths/cars (`3 bd · 2 ba · 1 car`), land
   (`450m² land`), floor area (`180m² floor`), `year_built` (`Built 1998`),
   `property_type` — each omitted when 0/''. Note these are the *source profile's*
   attributes and may differ from the listing snapshot above; the source line in the
   header covers that.
6. **Rent estimate**: `~$620/wk est. rent` — only when `rent_estimate_mid > 0`
   (upstream key existence is unverified; degrade silently).
7. **Freshness**: `Estimate as at {fmtDate(fetched_at)}` in the footer — AVMs go stale;
   always shown.
8. **Sales history** (own sub-section inside the card, heading `Sales history`):
   compact rows `{type badge} {date} {price or "Price undisclosed"} {agency}`.
   **Do NOT merge these into the existing `PriceTimeline`** — that timeline is our
   crawl-observed asking-price events (`property_price_events`, since ~2026); the AVM
   sales history is the source's transaction record (potentially decades). Merging
   would launder ToS-restricted source data into the primary timeline and create a
   false single-provenance impression; keeping them visually separate with per-section
   source labels IS the dedupe. Cap visible rows at ~8 with a `Show all (N)` toggle.
9. **Attribution footer**: small print
   `Estimate data: property.com.au. Figures are model estimates, not appraisals.`
   Reuse/extend `data-attribution.tsx` if its shape fits; otherwise inline copy.
   Never render anything resembling the raw payload.

### 4.3 Page metadata touch-up

`page.tsx:58` `dataSource="realestate.com.au, domain.com.au"` → append
`, property.com.au` (LLMMeta only; keep `robots: noindex` as-is — flag-gated rollout
posture, lines 38-41).

### 4.4 Frontend tests — `web/src/@/components/housing/__tests__/property-valuation-card.test.tsx`

jsdom + testing-library (existing pattern in that dir):
1. exact valuation → mid + range + confidence render; **no** building badge.
2. `valuationGranularity: "building"` → `Building estimate` badge + inline caveat visible.
3. no estimate (`estimateMid: 0`) but attributes → attributes render, no price block.
4. sales history rows render; nil-price row shows `Price undisclosed`.
5. `PropertyHistoryView` integration: response without `valuation` → card absent
   (extend the existing view test if one exists; otherwise a shallow render check).

---

## 5. Optional Phase 2 — suburb-level AVM aggregate (RECOMMENDED: DEFER)

**Recommendation: do not build this yet.** Two reasons, in order:
1. **The sample is biased and thin.** Valuations are seeded from `property_listings`
   addresses — i.e. only recently-FOR-SALE stock in the ~67 crawled suburbs. A "median
   AVM" over for-sale stock is not a suburb median and would sit next to genuinely
   representative medians (ABS + crawl asking medians) on the same map.
2. **Licence amplification.** Publishing per-suburb *aggregates of a proprietary AVM*
   moves from "derived per-address display with deep-link-out" toward exactly the
   aggregation the source's ToS names. Per-address display is the defensible surface.

If coverage later broadens (a dedicated non-listing-seeded valuation sweep), the design
is small and should be specced then as:
- MV `mv_suburb_avm_stats`: `property_valuations` (`fetch_status='ok' AND
  valuation_granularity='exact'` **only** — never let building fallbacks pollute a
  median) joined to `property_listings` on `address_key` for
  suburb/state/postcode (NB: `property_valuations` itself carries **no suburb column**),
  grouped with `percentile_cont(0.5)` on `estimate_mid`, **k-anon floor `n ≥ 10`**,
  folded into `refresh_housing_materialized_views()`.
- `SuburbSummary` fields **28** `double median_avm_estimate` + **29**
  `int32 avm_sample_count` (current max is 27, housing.proto:155-187).
- One continuous entry `avm_value` in
  `web/src/@/lib/housing/highlight-metrics.ts` (amber ramp, `sqrt: true`,
  `fmtPriceShort` — clone the `price` metric).
Phase 2 ships, if ever, as its own PR with its own review of the licence posture.

---

## 6. Landmines (bind these to the implementation)

1. **`valuation_granularity='building'` labelling is non-negotiable.** A whole-building
   AVM stored against a unit's `address_key` must carry the badge + inline caveat
   (§4.2.4) everywhere the figure appears. Backend passes the string through verbatim;
   the store never filters `building` rows out (the info is useful — labelled).
2. **`raw` JSONB / `content_hash` / lat-lng never cross the RPC.** The store SELECT
   list is the enforcement point — never `SELECT *` from `property_valuations`.
3. **ToS display posture**: derived figures + deep-link-out + attribution + kill switch
   (`HOUSING_VALUATIONS_ENABLED`), mirroring the listings tier
   (`docs/housing-architecture.md` §10.2). No bulk/exportable valuation surface; the
   only read is keyed by a single `address_key`.
4. **Staleness**: always render `fetched_at` (§4.2.7). The crawl is batch/residential-rig
   driven; a row can be weeks old.
5. **`fetch_status='ok'` filter in SQL** — blocked/notfound/error rows must never serve
   (their granularity is NULL by design, 000091).
6. **Warn-only degradation** (§3.3): a valuation-read error — including the table not
   existing in an env where 000088/000091 haven't been applied — must never fail
   `GetPropertyHistory`. This keeps the read path deploy-order-free relative to #340.
7. **address_key join correctness**: both tables key on the SAME canonical
   `address_key` (000088 seeds its work-list from `property_listings`). Exact string
   equality, no normalization in the read path — if a key mismatches, the fix belongs
   in the collector, not here.
8. **RSC rules**: the card lives under the existing `ssr:false` loader → no server
   rendering, no function props across a server boundary, no connect-web import from a
   server component. Don't move the card above `property-history-view-loader.tsx`.
9. **No int64 proto fields** (BigInt vs the JSON session cache — §2).
10. **`estimate_confidence` and sale `type` are free strings** — display raw, never
    exhaustively switch (upstream enums unverified).
11. **Session-cache staleness on flag flip** is bounded by the sessionStorage cache +
    MemoryCache TTL — acceptable; no busting work needed.

---

## 7. Ordered Codex task list

Work top-to-bottom on a branch off main **after PR #340 merges** (or cherry-pick
000088/000091 locally for the verify step only).

1. **Proto**: add `PropertyValuationSale` + `PropertyValuation` messages and
   `valuation = 12` to `GetPropertyHistoryResponse` in
   `proto/shortedapi/shorts/v1alpha1/housing.proto` exactly as §2 (comments included —
   the granularity comment is load-bearing documentation). No service changes.
2. **Generate**: `cd proto && buf generate`; commit all outputs (Go, TS
   `web/src/gen/shorts/v1alpha1/housing_pb.ts`, `sdks/java` churn).
3. **Store**: add `PropertyValuationRow`, `PropertyValuationSaleRow`, and
   `GetPropertyValuation` to
   `services/shorts/internal/store/shorts/postgres_house_prices.go` per §3.1.
4. **Interface + mocks**: extend `ShortsStore` in
   `services/shorts/internal/services/shorts/interfaces.go`; regenerate
   `mocks/mock_interfaces.go` with the mockgen command in its header.
5. **Handler**: add `valuationsEnabled()` and the warn-only valuation attach inside
   `GetPropertyHistory` in
   `services/shorts/internal/services/shorts/house_prices.go` per §3.3, plus
   `toPropertyValuationProto`.
6. **Backend tests**: the six cases in §3.4; `go test ./services/shorts/...` green;
   confirm `proto_parity_test.go` still passes (it must — no service change).
7. **Frontend card**: create
   `web/src/@/components/housing/property-valuation-card.tsx` per §4.2 (badge +
   tooltip + inline caveat + sales history + attribution).
8. **Wire in**: render it from `property-history-view.tsx` between
   `CurrentListingCard` and `SummaryStrip`; update `page.tsx` LLMMeta `dataSource`.
9. **Frontend tests**: §4.4; `npm --prefix web run test` green; `npm --prefix web run
   bundle:budget` unchanged (the card adds no new deps — verify).
10. **Local verify** (the definition of done):
    a. `make dev` (DB + backend + web). Apply 000088 + 000091 locally if not yet on
       main (`cd services && make migrate-up`, or `psql -f` the two files from the
       #340 branch).
    b. Seed one address end-to-end (listings + events + valuation), e.g.
       `address_key = '1-test-street-brighton-vic-3186'`: a `property_listings` row +
       two `property_price_events` rows (so the page renders history), then:
       ```sql
       INSERT INTO property_valuations (address_key, fetch_status, profile_url,
         estimate_low, estimate_mid, estimate_high, estimate_confidence,
         valuation_granularity, rent_estimate_mid, bedrooms, bathrooms, car_spaces,
         land_size_sqm, year_built, property_type, sales_history, raw, content_hash)
       VALUES ('1-test-street-brighton-vic-3186', 'ok', 'https://www.property.com.au/vic/brighton-3186/test-st/1-pid-999/',
         1150000, 1250000, 1350000, 'high', 'exact', 620, 3, 2, 1, 450, 1998, 'house',
         '[{"date":"2019-05-11","price":980000,"agency":"Test Realty","type":"Sold"},{"date":"2015-02-02","type":"Listed for sale"}]',
         '{}', 'seedhash');
       ```
    c. Visit `http://localhost:3020/housing/property/1-test-street-brighton-vic-3186`
       → AVM card renders: range + mid, confidence pill, attributes, rent, sales
       history (incl. the undisclosed-price row), `Estimate as at …`, source link.
    d. `UPDATE property_valuations SET valuation_granularity='building' WHERE
       address_key='1-test-street-brighton-vic-3186';` → hard-refresh (bust the
       session cache / new tab; backend MemoryCache may also need a restart or a
       distinct seeded address) → **`Building estimate` badge + inline caveat render**.
    e. `HOUSING_VALUATIONS_ENABLED=false` on the backend → card absent, history intact.
    f. Confirm the network response for `GetPropertyHistory` contains **no** `raw`,
       `content_hash`, `latitude`, `longitude`, or `source_licence` keys.
    g. Screenshot the exact + building states for the PR description.
