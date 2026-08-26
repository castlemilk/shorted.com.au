# Data model

Migrations `000053`–`000092` — **27 housing migrations** interleaved with
non-housing ones (map at the bottom). The shape below is what exists now; the
reasoning is in [architecture.md](architecture.md).

**Prod DDL is applied BY HAND** (session pooler `:5432`,
`statement_timeout=0`). The deploy workflow's migration allowlist
(`terraform-deploy.yml`) contains **zero** housing files, so nothing here
reaches prod on merge — DB-before-code, always. See
[operations.md](operations.md).

## The flow

```
ABS/RBA/VG (open)            REA/Domain crawl (ToS-restricted)
  └─ house_prices  EAV          ├─ property_listings ── property_price_events
       │  + source_licence      ├─ property_listing_details   (000087)
       │                        └─ property_valuations        (000088/000091)
suburb_demographics  (spine, sal_code)          suburb_crime_stats (000090)
       │                                              │
  ┌────┴──────────────── MV layer ────────────────────┴────┐
  │ mv_housing_headline · mv_suburb_listing_stats          │
  │ mv_suburb_price_drops · mv_state_price_drops           │
  │ mv_agency_stats · mv_suburb_crime_latest               │
  └──────── refresh_housing_materialized_views() ──────────┘
                     │
        HousingService (11 rpcs, housing.proto)
```

**Raw crawl rows are never a public surface.** Every crawled row carries
`source_licence = 'proprietary-tos-restricted'` (a column DEFAULT, so the
unlicensed state is unstorable); the publishable surfaces are the derived
aggregates. The per-listing drill-downs that do read raw rows deep-link OUT to
the live portal and sit behind `HOUSING_DROP_LISTINGS_ENABLED`.

## Fact/dimension core (000053)

- `house_price_regions` — location dimension. `region_code` PK (`'AUS'`, state,
  `'1GSYD'`, `'SUBURB:NSW-2026-BONDI'`), `region_type`, `state_code`,
  `postcode`, plus `sal_code` (000055) — the bridge to the suburb spine,
  backfilled by exact name+state match (000056) then a strip-the-`(NSW)`
  qualifier fallback (000068). No manual re-apply is needed after a census
  re-ingest — `-mode refresh` runs `linkSuburbSalCodes` before the MV refresh
  ([pipeline.md](pipeline.md)), superseding the old "re-apply 000056" step.
- `house_prices` — narrow **EAV fact**: one row per region × measure ×
  dwelling × period × source, **UNIQUE on exactly that tuple**.
  `source_licence` (default `CC-BY-4.0`) rides on every row for republish
  gating; `content_hash` = sha1 for idempotent upserts.
- `house_price_ingest_runs` — per-source cursor (`source` PK, `last_period`,
  `rows_upserted`, `status`).

**`dwelling_type` has two vocabularies, and mixing them silently returns the
wrong number.** Measured in prod 2026-08-26:

| `region_type` | `dwelling_type` values | Source |
|---|---|---|
| `suburb` | `house` (31,681 rows) | state Valuer-General |
| `gccsa`, `rest_of_state` | **both** `established_house` and `attached` | ABS `RES_DWELL` |
| `state`, `national` | `all` | ABS/RBA aggregates |

So a regional region_code has **two `median_price` rows for the same quarter**.
Any "latest median" lateral that filters only on `measure = 'median_price'` and
takes `ORDER BY period DESC LIMIT 1` breaks that tie arbitrarily — and in
practice returned the **attached (unit)** median. That shipped: every capital
city's headline read the unit price, understating Greater Sydney by 43%
($848k against an established-house median of $1.485m at 2026-Q1). Fixed by
filtering `dwelling_type IN ('house', 'established_house')`, which is
unambiguous because no `region_type` carries both. Conversely, a query that
filters `dwelling_type = 'house'` is **suburb-only** and will silently return
nothing for gccsa/rest_of_state regions — correct for the suburb read paths
that do it, wrong if copied to a regional one. Regression:
`TestHousingRegionsQuery_PicksHousesNotUnits`.

Known-open: an official-ingest failure exits 0 with no freshness sentinel, so
a stale cursor looks healthy — fix in flight on the `feat/housing-*` branches
(2026-08-09 audit).

## The suburb spine (`suburb_demographics`)

One row per ABS SAL suburb, `sal_code` PK. Column families by migration:

| Migration | Columns |
|---|---|
| 000055 | identity (`sal_name`, `state_code`, `postcode`) + census base (`population`, `median_age`, incomes, rent, mortgage, `census_year`) |
| 000057 | culture: `pct_born_overseas`, `pct_english_only`, `top_religion`/`top_language` + pcts |
| 000058 | federal: `federal_division/member/party/party_ab`, `federal_tpp_alp` |
| 000059/000060 | `state_district`; `state_member/party/party_ab` — **NULL for TAS/ACT by design** (Hare-Clark) |
| 000084 | `banner_archetype/blurb/landmarks/bg_key/bg_url/generated_at` — hydrated on **`GetSuburbProfile` only**, never the list rpcs |

`pct_owned_*` / `pct_rented` / `dwelling_count` exist (000055) but `-mode
census` never populates them (G33/G37 unparsed) — reserved, NULL. Don't build
on them.

## The crawl pair (+ satellites)

- `property_listings` (000076) — one row per portal advert, **UNIQUE
  (source, listing_id)**; snapshot columns + `is_active`/`missed_sweeps`
  lifecycle; `address_key` (000078, default `''` — canonical address identity
  that survives relist churn and unifies REA/Domain);
  `agency_id/agency_name/agent_names` (000079).
- `property_price_events` (000076) — the asking-price time series. **UNIQUE
  (listing_pk, event_type, observed_at)** makes re-runs idempotent.
  **`drop_pct` is a FRACTION** (0.062 = a 6.2% drop) — the 40% cap below is
  `<= 0.40`, not `<= 40`.
- `property_listing_details` (000087) — detail-page harvest, PK `listing_pk`;
  `raw JSONB` holds recognized fields only, never the page; the
  `detail_fetched_at` row IS the work-list cursor (deliberately no base-row
  column).
- `property_valuations` (000088) — per-address AVM snapshot, PK `address_key`;
  `valuation_granularity` (000091) records `'exact'` vs `'building'` so a
  whole-building estimate is never silently read as unit-precise.
- `crawl_run_status` (000089) — rig health, PK `(run_type, host)` with CHECKs
  on `run_type` (`delta|full|agent|freshness`) and `status`; a dead rig stops
  writing and the stale `finished_at` flips the admin dashboard row.

## Crime (000090 → 000092)

`suburb_crime_stats` — PK `(sal_code, crime_type, fy_ending, pooled)`; CVS
re-benchmarked rates + national population-weighted `pct_rank`; quarantine
flags `small_pop` (ERP < 2000) and `unreliable` (state CVS anchor RSE > 25%).

`mv_suburb_crime_latest` (000092 rebuild) is the ONLY read surface:
`DISTINCT ON (sal_code, crime_type)` over `pooled AND pct_rank IS NOT NULL
AND NOT small_pop AND NOT unreliable AND source_licence <>
'wa-tou-noncommercial'`. 000092 exists because 000090 was hand-applied to
prod in a different shape — the DROP+CREATE makes prod deterministic. The MV
exposes `population` and the (now constant-false) flags so read paths can
re-assert the gate, and they do (`postgres_house_prices.go` re-filters
`NOT small_pop AND NOT unreliable` in both crime reads). No-data hatches;
never paints 0.

## Local insights (000061–000064, 000066–000067)

`lga` + `suburb_lga` bridge (dominant council + overlap shares),
`suburb_amenities` (OSM/ACARA/GA counts + derived 0–100 scores; raw OSM
points never stored — ODbL Produced Work), `suburb_connectivity` (NBN,
area-level only), `suburb_funding` (IIP). `lga` financial columns are
per-state licence-gated and stay NULL until cleared (NSW "Your Council" is
Crown copyright); `fed_fag_aud/_year` (000066) + `fin_year` (000067) record
grant and vintage.

## The MV layer

| MV | Migration | Grain | Floor / gate |
|---|---|---|---|
| `mv_housing_headline` | 000053, rebuilt 000054 | region × measure × dwelling (latest, QoQ/YoY) | **licence exclusion baked into the MV** — the MV carries no `source_licence`, so 000054 filters `proprietary-tos-restricted` before ranking |
| `mv_suburb_listing_stats` | 000077 | `region_code` asking/sold aggregates | **NONE — this is the k-anon gap** (below) |
| `mv_suburb_price_drops` | 000076, rebuilt 000086 | `region_code` 30-day drop signal | n≥3 dropped addresses; 40% cap; address dedup |
| `mv_state_price_drops` | 000086 | `state_code` + `'AU'` national row (GROUPING SETS) | 40% cap; address dedup; junk `state_code='AU'` rows excluded (they'd collide with the national row and abort the CONCURRENT refresh via the unique index) |
| `mv_agency_stats` | 000086 | `(source, agency_id, state_code)` — per-portal, no entity resolution | row floor `active_listings >= 3`; `avg_drop_pct`/`total_drop_value` NULL until **≥3 dropped addresses**; `agent_names` capped at 6 |
| `mv_suburb_crime_latest` | 000090, rebuilt 000092 | `(sal_code, crime_type)` pooled latest | `NOT small_pop AND NOT unreliable`, WA ToU excluded |

Shared dedup shape (000086, numerators AND denominators):
`COALESCE(NULLIF(address_key,''), source||':'||listing_id)`; per-address
dollar sums take the single portal that observed the most cutting, so a
dual-listed cut counts once while multiple real cuts still sum.

### `refresh_housing_materialized_views()`

Final body is 000092's: `mv_housing_headline` first (unguarded), then five
guarded blocks (CONCURRENTLY → blocking fallback) for the other MVs. The
collector calls it after every run (`store.go`
`SELECT refresh_housing_materialized_views()`); it is decoupled from the
daily shorts `refresh_all_materialized_views()`.

**Landmine (known-open, fix in flight):** the guards are plain
`EXCEPTION WHEN OTHERS`, and plpgsql's `OTHERS` deliberately does NOT match
`query_canceled` (57014) — exactly what a `statement_timeout` raises. This is
the failure mode 000095 fixed for the shorts refresh (19 days of silently
stale MVs); the housing function never got that pattern, so one timed-out MV
aborts the function and starves every MV after it.

## Where each guard actually lives

| Guard | Enforced by |
|---|---|
| Licence exclusion on the headline surface | **DB** — baked into `mv_housing_headline` (000054) |
| Licence exclusion on base-table series/suburb reads | **Code** — `source_licence <> 'proprietary-tos-restricted'` re-asserted in every `postgres_house_prices.go` query body |
| 40% cap, address dedup, `AU` guard, drop floors | **DB** — MV definitions (000086) |
| Agency k-anon (≥3 dropped addresses) | **DB** — `CASE WHEN COUNT(*) >= 3` in `mv_agency_stats` |
| Crime small-pop/unreliable/WA gate | **DB** (000092 MV) **+ code** re-assert |
| Per-listing surfaces off by kill switch | **Code** — `dropListingsEnabled()` reads `HOUSING_DROP_LISTINGS_ENABLED` (default ON) in the handler |
| AVM servability (`fetch_status='ok'`) | **Code** — `GetPropertyValuation` WHERE clause |
| "Gate per-dwelling use on `valuation_granularity='exact'`" | **Documented only** — a migration comment (000091); the store returns `'building'` rows too |
| "Raw profile is internal enrichment only" (000088) | **Documented only — and currently contradicted** (below) |

## Known-open (2026-08-09 audit; fixes in flight on `feat/housing-*`)

- **The k-anon floor stops at the drop MVs.** `mv_suburb_listing_stats` has
  no n-floor, and the ungated `ListSuburbPriceDrops` serves every suburb in
  it — a 1-listing suburb's `median_asking` IS that listing's exact asking
  price. The n≥3 privacy rationale in 000076/000086 is silently bypassed by
  the asking/sold aggregates.
- **Per-address AVM serving contradicts 000088's posture.** The migration
  says the raw profile is "stored for internal enrichment only"; the read
  path (`GetPropertyValuation`, surfaced via the flag-gated property-history
  drill-down) returns per-address estimates + full `sales_history`.
- **`refresh_housing_materialized_views()` lacks the 000095 guard pattern**
  (above).
- **4 committed testdata files carry real portal page content**
  (`rea-pagemeta.html` + `domain-pagemeta.html`, duplicated under
  `services/house-price-collector/testdata/` and
  `services/jobs/internal/jobs/houseprices/testdata/`) — at odds with the
  never-republish/never-upload posture.

## Migration map (housing subset, verified against `services/migrations/`)

| Migration | Adds |
|---|---|
| 000053 | `house_prices` EAV + `house_price_regions` + `house_price_ingest_runs` + `mv_housing_headline` + refresh fn |
| 000054 | licence gate baked into `mv_housing_headline` |
| 000055 / 000056 / 000068 | `suburb_demographics` + `house_price_regions.sal_code` bridge / exact-match backfill / stripped-qualifier backfill |
| 000057 / 000058 / 000059 / 000060 | culture / federal electoral / state district / state member |
| 000061–000064 | `lga` + `suburb_lga` / `suburb_amenities` / `suburb_connectivity` / `suburb_funding` |
| 000066 / 000067 | LGA FAG grants / LGA financial-year vintage |
| 000076 | `property_listings` + `property_price_events` + original drops MV |
| 000077 | `mv_suburb_listing_stats` |
| 000078 / 000079 | `address_key` / agency + agents |
| 000084 | suburb banner columns (renumbered off a stale 000083 after colliding with `000083_add_state_exposure`) |
| 000086 | price-drops rollups: rebuilt `mv_suburb_price_drops` + `mv_state_price_drops` + `mv_agency_stats` (authored as 000083, renumbered twice; applied to prod under its original number — fine only because prod DDL is manual) |
| 000087 | `property_listing_details` |
| 000088 / 000091 | `property_valuations` / `valuation_granularity` |
| 000089 | `crawl_run_status` |
| 000090 / 000092 | `suburb_crime_stats` + initial crime MV / deterministic gated rebuild + final refresh fn |
