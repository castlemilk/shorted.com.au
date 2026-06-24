# Design — Residential intelligent housing crawl (cuttlefish × brandbrain × shorted)

**Date:** 2026-06-24
**Branch:** `feat/residential-housing-crawl` (shorted), plus feature branches in `cuttlefish` and `brandbrain`
**Status:** Approved (design); implementation plan to follow

## Goal

Combine three of the user's systems into one scheduled, residential-IP, intelligent
housing-data pipeline:

1. **cuttlefish** (the user's DAG workflow engine) — schedules the crawl and runs it on a
   runner pinned to a **home macOS rig**, so REA/Domain see a **residential egress IP**.
2. **brandbrain** (the user's AI crawler/extraction platform) — turns fetched listing/suburb
   HTML into structured real-estate metadata via a new `ExtractRealEstate` RPC.
3. **shorted** (`services/house-price-collector`) — orchestrates the crawl, validates against
   poisoning, and stores everything in the existing `house_prices` EAV table.

Plus a parallel, low-risk **open Valuer-General backbone** (NSW/QLD/WA/TAS/ACT/NT) that needs
no residential egress and powers the public surface.

### This is also a dogfooding exercise

A first-class objective is to **validate and improve cuttlefish and brandbrain** against a real
use-case. Gaps this use-case exposes in either product are fixed *properly* — to their
conventions, with tests — not papered over with shorted-side hacks. Concrete improvement
targets are listed per-repo below.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Crawl target | Open-VG backbone (public) **+** residential REA/Domain (internal) |
| Residential egress | cuttlefish runner on the home macOS rig (Docker NATs via host IP) |
| Metadata extraction | new brandbrain `ExtractRealEstate(html, url, …)` RPC (HTML-in) |
| Scheduling | wire cuttlefish's built-in cron (`TickCronSchedules`) |
| **Licensing/display** | REA/Domain + brandbrain output = **acquire-only, internal, never publicly republished**. Open-VG (CC-BY) is what the public `/housing/suburbs` shows. The stored `source_licence` gate is **enforced** in the query/RPC layer. |

## Architecture

```
 cuttlefish CONTROL PLANE  (DigitalOcean droplet, always-on)
    │  wired cron → fires "au-housing-residential-crawl" workflow on a schedule
    │  run pinned to the residential runner pool (cron trigger carries a runner selector)
    ▼
 cuttlefish RUNNER on the HOME MACOS RIG  ◄── residential egress IP (Docker default bridge → host NAT)
    │  leases the run, executes the crawl task container (chromium-bearing image)
    │  collector `-mode crawl` → stealth (native→chromium) fetches REA/Domain suburb pages
    │  forwards RAW page bytes ──HTTPS──► brandbrain ExtractRealEstate (droplet; datacenter is fine — pure compute)
    │                                        └─► {price, beds/baths/car, land, sale_date, agency, suburb stats…}
    ▼
 collector: SAME 4 anti-poisoning gates applied to brandbrain output → house_prices EAV
            (source=brandbrain_rea / brandbrain_domain, source_licence=proprietary-tos-restricted, is_preliminary as warranted)
    ▼
 store.refreshHousingMV()

 ── INDEPENDENT path (existing Cloud Run Job, datacenter is fine — all open-gov CC-BY) ──
 open Valuer-General ingest NSW/QLD/WA/TAS/ACT/NT  →  house_prices  →  /housing/suburbs (PUBLIC)
```

**Key insight:** only the *fetch* needs the residential IP. Extraction is pure compute on
already-fetched HTML, so brandbrain stays where it is (DO droplet). A DO droplet is **not**
residential — only the home mac-rig runner provides residential egress.

## Component design

### A. cuttlefish (workflow engine) — improvements + integration

**Gaps this use-case exposed:**
- **Cron is implemented but never fires.** `PostgresRunStore.TickCronSchedules`
  (`internal/controlplane/store/postgres_schedule_store.go:30`) is complete and tested, but the
  running loop (`internal/controlplane/background_tick.go:76`) only calls `ws.Tick`. Their own
  TODO 14.3.5 / line 381: "Cuttlefish doesn't have scheduled triggers yet."
- **No working declarative runner pinning.** Run-level pinning works only via
  `POST /api/runs/start` context (`run_scope.go`). The node-level `runsOn` field exists in the
  schema and is parsed (`extractRunsOn`, `runner_handlers.go:1599`) but has **no live consumer**
  — authoring it validates and silently does nothing. Cron-created runs get **empty**
  pool/labels and lease to *any* runner.

**Changes (proper fixes, with tests):**
1. **Wire cron into the loop** — in `backgroundTickOnce` call
   `ws.TickCronSchedules(ctx, time.Now(), 100)` alongside `ws.Tick`; on `created > 0` call
   `publishWorkAvailable`. Keep it out of the poll path (`TestPollWork_DoesNotTick` guards that).
2. **Make cron runs targetable to a pool/labels (declarative).** Add an optional runner
   selector to the **cron trigger** in `docs/specs/schemas/workflow-v1alpha1.schema.json`
   (strict `additionalProperties:false`, so the schema + `internal/specvalidate/workflow.go`
   struct must be extended) — fields `runnerPoolName` / `runnerLabels`. In `TickCronSchedules`,
   wrap ctx with `store.WithTargetRunnerPool` / `store.WithTargetRunnerLabels` before
   `createRunTx` so the cron run pins to the residential rig via the existing lease SQL
   (`postgres_run_store.go:2070-2075`).
   *Fallback if we descope (2): run the rig as the only runner in a dedicated cuttlefish
   project — runners are project-scoped, so cron runs in that project lease only to the rig
   with zero code change. We will do the proper selector since this is a dogfood exercise; the
   project-scoping is the smoke-test shortcut.*
3. **Author artifacts** — a `Workflow` (`cuttlefish.dev/v1alpha1`, cron + manual triggers) and a
   `TaskPackage` (image + `${secrets.SHORTED_DATABASE_URL}` / `${secrets.BRANDBRAIN_*}` env,
   `protocol {version:v0, transport:stdio}`).
4. **Optional hardening (note, not commit-blocking):** clearer error when a referenced
   `${secrets.NAME}` is missing at lease time (currently HTTP 500); a "latest-only / no
   backfill-burst" option for cron catch-up.

**Runner setup:** register the mac rig via `cuttle agent install --start` with
`RUNNER_POOL_NAME=residential`, `RUNNER_LABELS=residential=true,location=home`,
`RUNNER_CAPABILITIES=docker`. Verify the container's actual egress IP is residential before
trusting any crawl result.

### B. brandbrain (AI crawler) — `ExtractRealEstate` + extraction improvements

**Changes:**
1. **New RPC `ExtractRealEstate(html, url, suburb_hint, state_hint)`** → `{listings[], agency,
   confidence, notes}` with a `RealEstateListing` message (address, suburb, state, postcode,
   price_display, price, property_type, bedrooms, bathrooms, car_spaces, land_size,
   listing_url, listing_status, agent_name, rating_value, review_count).
   - proto: `api/brandbrain/v1/discovery.proto` (`idempotency_level = NO_SIDE_EFFECTS`).
   - **Footgun:** the server hand-registers handlers via `makeHandler` on a `ServeMux`
     (`adapters/http/server.go:301`), **not** buf-connect. Must add the method to the anonymous
     interface **and** a `mux.HandleFunc(".../ExtractRealEstate", makeHandler(...))` line or it
     compiles but 404s. Add a registration test to catch this class of bug (dogfood improvement).
2. **Real-estate langextract schema** — clone `companyMetadataExtractionPrompt` +
   `companyMetadataExamples` (`company_metadata_langextract.go:13-172`) into
   `realEstateExtractionPrompt` + `realEstateExamples` + `buildRealEstateFromExtractions`.
3. **Extract-from-provided-HTML** — the extractor already supports it via
   `CompanyMetadataExtractionInput.ArtifactHTML` (`extractionHTML()` prefers it). New
   `real_estate_extractor.go` synthesizes a minimal `&SiteProfile{URL,Domain}` (required
   non-nil) and runs langextract with `WithFetchURLs(false)` — **no server-side fetch**.
4. **`__NEXT_DATA__` / `__INITIAL_STATE__` JSON-blob parser** (generalizable improvement) —
   REA/Domain ship listing data as embedded JSON in `<script>`, not Schema.org. A dedicated
   blob parser materially improves extraction on modern SPAs beyond this use-case.
5. **Widen structured-data coverage** — `isContactBearingType`
   (`jsonld_contact_extractor.go:117-132`) and the Product `@type` gate
   (`product_extractor.go:51`) extended for `RealEstateListing/Residence/Apartment/House/
   Place/Offer`, reading `offers.price` + `aggregateRating`.
6. **Reliability note:** brandbrain 502s above ~2 concurrent workers (project memory). The
   crawl is serial (5–15s jitter between suburbs) so this is fine now; flagged as a future
   concurrency-robustness improvement, not in scope.

**Deploy:** `make proto` (buf) + `make do-deploy` (DigitalOcean — **not** Cloud Run).

### C. shorted (collector + web)

**Crawl tier (`services/house-price-collector`):**
1. After a validated residential fetch, forward **raw bytes** (switch crawl fetch to
   `FetchBytes`, not `FetchHTML`, to avoid goquery re-serialization breaking JSON-blob parsing)
   to brandbrain. New `crawl_brandbrain.go`: Connect-JSON POST with 5xx backoff (mirror
   `signals-collector/collect.py` retry).
2. Map brandbrain rich fields to **new EAV measures** (`measure` is free-text TEXT — no
   migration): `rental_yield` (ratio), `days_on_market` (count), `auction_clearance` (ratio),
   `price_growth_12m` (ratio), plus existing `median_price`/`median_rent`/`transfer_count`.
   Store under **segregated sources** `brandbrain_rea` / `brandbrain_domain` so they never
   collide with the raw-crawl `median_price` on the UNIQUE key.
3. **Gate brandbrain output through the same anti-poisoning validation** as the raw median
   (`crawl_validate.go`); poisoned/blocked HTML must not launder bad data. Mark
   `is_preliminary` / source-segregate as warranted.
4. All crawl + brandbrain rows keep `source_licence='proprietary-tos-restricted'`.
5. **Chromium-bearing crawl image** — the shipped collector image is distroless/static (no
   Chromium); native-only weakens Kasada bypass. Build a chromium variant for the residential
   task (runs fine in Docker on the mac rig). `CRAWL_DISABLE_CHROMIUM` stays the escape hatch.
6. The residential crawl runs **only** as the cuttlefish task — **never** on Cloud Run (GCP
   datacenter IPs get blocked).

**Open-VG backbone (runs in existing `-mode all` on Cloud Run):**
- Add `ingestNSWMedians` / `QLD` / `WA` / `TAS` / `ACT` / `NT`, each
  `func(ctx) ([]Observation, error)` appended to `runOfficial`'s job list (`main.go`). Two
  reference shapes already in-repo: CKAN datastore JSON (`sa_vg.go`) and Cloudflare-walled XLSX
  via stealth native (`vic_vpsr.go`).
- **Each state's source is an assumption that must be verified first** (only SA/VIC confirmed).
  Likely: NSW PSI bulk DAT files; QLD/WA/ACT via CKAN/Socrata; TAS/NT possibly XLSX/PDF.
  `region_code='SUBURB:<STATE>-…'`, `source='vg_<state>'`, `source_licence` set per the actual
  state licence. ACT (districts) / NT (tiny) likely `region_type='lga'`.

**Web + hygiene:**
- **Enforce the `source_licence` gate** in the RPC/query layer so
  `proprietary-tos-restricted` rows never reach public surfaces (stored today, **not enforced**).
- Surface the new open-VG states + any new public measures on `/housing/suburbs`.
- Fix the pre-existing **state-filter bug** (VIC/SA return mixed results — filter ignored
  server-side).

## Data model

No migration required:
- Crawl + brandbrain measures are new free-text `measure` values under new `source` values in
  the existing `house_prices` EAV (UNIQUE `region_code, measure, dwelling_type, period, source`).
- New-state VG rows reuse `region_type='suburb'` (+ `'lga'` for ACT/NT) and `state_code`.

## Phasing (de-risked: feasibility gate first, cheap reliable win in parallel)

| Phase | What | Risk | Depends on |
|---|---|---|---|
| **0 — Feasibility spike** | Register mac-rig runner; run existing `-mode crawl` (native→chromium) from it manually. **Measure:** does REA/Domain return clean, validation-passing data from the residential IP? Confirm egress IP is residential. | Make-or-break | — |
| **1 — Open-VG backbone** | Verify each state's source; add 6 ingest funcs (existing Cloud Run path). Independent — can land first. | Low | — |
| **2 — cuttlefish pipeline** | Wire cron; declarative pool/label selector; chromium crawl image; TaskPackage + Workflow; secrets; smoke-test manual → scheduled. | Med | Phase 0 green |
| **3 — brandbrain extraction** | `ExtractRealEstate` RPC + real-estate schema + `__NEXT_DATA__` parser + allowlist widening + deploy; collector calls it, gates output, stores segregated. | Med | Phase 2 |
| **4 — Web + hygiene** | Enforce licence gate; surface new open-VG states; fix state-filter bug. | Low | Phases 1–3 |

**Gate:** if Phase 0 shows residential IP still can't beat Kasada (REA), **stop** and escalate
to a managed unblocker before investing in Phases 2/3. Verify before building.

## Risks & mitigations

- **Kasada (REA) / Akamai (Domain) may still block even from residential IP.** → Phase 0 gate;
  chromium engine; fallback to managed unblocker if proven necessary.
- **REA/Domain ToS.** → Acquire-only, internal, never republished; `source_licence` enforced.
- **Poisoned data laundering via brandbrain.** → brandbrain output passes the same 4 gates;
  source-segregated; `is_preliminary` where uncertain.
- **Open-VG source assumptions wrong.** → Verify each source before coding; best-effort/skip
  states with no machine-readable suburb medians (note what's dropped — no silent gaps).
- **Stale-branch landmine.** → All work in the clean `~/projects/shorted-housing-crawl` worktree
  off `origin/main`.
- **cuttlefish cron backfill burst** after downtime. → bounded by `limit=100`/tick; consider
  latest-only option (optional).

## Explicitly NOT doing (YAGNI)

- Kasada/Akamai sensor reverse-engineering or a wired CAPTCHA solver.
- Commercial residential proxy pools (the mac rig *is* the residential IP).
- Fixing stealth's broken native-proxy path.
- Per-listing scraping at scale (suburb-level aggregates + sampled listings only).
- The brandbrain desktop-agent route (the cuttlefish runner replaces it).
- Public display of REA/Domain data.

## Success criteria

1. A scheduled cuttlefish workflow fires on cron and runs the crawl on the mac-rig runner
   (verified by `run.triggered` event with `triggerKind:cron` + run landing on the residential
   runner).
2. From the residential IP, the crawl retrieves **validation-passing** REA/Domain suburb data
   for the seed suburbs (Phase 0 proves this or we escalate).
3. brandbrain `ExtractRealEstate` returns structured real-estate metadata for fetched HTML;
   collector stores it as segregated, licence-gated EAV rows that pass anti-poisoning gates.
4. Open-VG suburb medians for the remaining states (those with machine-readable sources) are
   ingested via `-mode all` and visible on the public `/housing/suburbs`.
5. `proprietary-tos-restricted` rows are provably excluded from public RPC/query paths.
6. cuttlefish gains working scheduled triggers + declarative runner pinning (with tests);
   brandbrain gains real-estate extraction + `__NEXT_DATA__` parsing + a handler-registration
   test (with tests).
