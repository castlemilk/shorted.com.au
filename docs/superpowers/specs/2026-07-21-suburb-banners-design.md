# Per-suburb banner headers — design

**Date:** 2026-07-21
**Status:** Draft for review
**Surface:** `/housing/[state]/[suburb]` profile pages (`web/src/@/components/housing/suburb-profile.tsx`)
**Related:** `docs/housing-architecture.md`, the housing iconography flow (`web/scripts/housing-icons/`), memory `brandbrain-mcp-icon-flow`, `local-insights`, `housing-map`.

---

## 1. Goal

Give every suburb profile a distinctive, on-brand **banner header** — an illustrated
warm-duotone landscape with the suburb's **real vector-map snapshot** and an editorial
one-line **blurb**, working natively in both the light and dark themes, at near-zero
marginal cost per suburb (~15,300 suburbs).

Secondary win: the generated blurb doubles as visible page copy (the profile currently
has no prose), adding real content depth for SEO/GEO.

## 2. Key idea (why it's cheap)

The banner is **composited from three layers at render time**, not a baked AI image per
suburb:

1. **Background** — an illustrated warm-duotone scene from a small **archetype library**
   (~10 scenes), reused across all suburbs of that archetype. AI cost is a fixed ~$1–20
   library, not per-suburb.
2. **Vector-map snapshot** — the suburb's **actual** ABS boundary highlighted among its
   neighbours, rendered from `public/geo/suburbs/<ST>.topojson` via d3-geo. Free,
   deterministic, per-suburb-unique, un-hallucinatable.
3. **Type** — serif suburb name + one mono stat + the blurb, over a theme-aware scrim.

Per-suburb identity comes from layers 2–3 (free) + the blurb, so the AI in layer 1 stays a
tiny reusable set. Prototype validated 2026-07-21 (Bondi Beach, both themes) —
`web/scripts/housing-banners/out/_mock-banner.{light,dark}.png`.

## 3. Non-goals

- No per-suburb bespoke AI image as the baseline (bespoke is an on-demand upgrade for
  notable suburbs only).
- No street-level / road map — a suburb-boundary locator only.
- No elevation/land-use ingest in v1 (archetype gaps filled by the LLM hint — §5).

## 4. Architecture overview

```
ingest (collector/script)                 read (GetSuburbProfile)          render (SuburbBanner)
──────────────────────────                ───────────────────────          ─────────────────────
classify archetype (signals)  ─┐                                            bg layer  (static AVIF, theme-aware)
agy blurb + landmarks + hint   ─┼─► suburb_demographics.banner_* ─► RPC ─►  scrim     (theme gradient)
(optional) bespoke bg → GCS    ─┘        (archetype, blurb,               map layer (client SVG, d3-geo)
                                          landmarks, bg_key, bg_url)        type      (serif name + mono stat + blurb)
archetype background library (once) ─────────────────────────────────────► public/housing-banners/bg/<key>.{light,dark}.avif
```

## 5. Archetype system

### Library (10 scenes)
`web/scripts/housing-banners/banner-set.config.mjs` — `ARCHETYPES` (built):
`coastal-beach, harbour, river-valley, urban-skyline, inner-terraces, leafy-suburban,
parkland, hills-ranges, bushland, farmland`. Shared background `STYLE` suffix = the
scene-scale sibling of the icon style (warm amber/olive/rust screen-print, calm sky in the
upper third for overlaid text).

### Classification (deterministic base + LLM refinement)
Signals available per suburb (from `suburb_demographics` + `suburb_amenities`, shipped by
`local-insights`): `distToCoastKm`, `amenityDensityScore` (0–100), `parksCount`,
`population`. We do **not** have elevation/land-use, so some archetypes can't be derived —
be honest about it.

Deterministic base (priority order):

| Archetype | Rule |
|---|---|
| `coastal-beach` | `distToCoastKm < 2` and `amenityDensityScore < 80` |
| `urban-skyline` | `amenityDensityScore ≥ 80` |
| `inner-terraces` | `amenityDensityScore 55–80` |
| `parkland` | `parksCount` in national top decile, not coastal/urban |
| `leafy-suburban` | `amenityDensityScore 25–55` (default suburban) |
| `bushland` | `amenityDensityScore < 25` and `distToCoastKm > 30` |

`harbour`, `river-valley`, `hills-ranges`, `farmland` are **not** derivable from current
signals — they're reached only via the **LLM archetype hint**: `agy` returns
`archetype_hint` and may override the base when it confidently knows the suburb (Katoomba →
`hills-ranges`, Parkes → `farmland`, a harbour suburb → `harbour`). This is the
"LLM-landmarks + nature-fallback" decision applied to archetype selection: deterministic
base always exists; the LLM only *upgrades* known suburbs. Classifier lives in
`web/scripts/geo/classify-archetype.mjs` (pure, unit-tested) and runs at ingest.

## 6. Background library generation

- **Config:** `banner-set.config.mjs` (done). **Generator (production):**
  `generate-backgrounds-openai.mjs` — direct OpenAI `gpt-image-1`, `1536×1024`,
  shared-style-suffix consistency (done, verified). The flow-MCP generator
  (`generate-backgrounds.mjs`) is kept but **currently drift-blocked** (§12).
- **Bake step:** `bake-library.mjs` (new) — for each master: crop to a 3:1 banner band,
  produce the **light** asset (source, palette-matched) and the **dark** asset
  (gradient-map via `tone.mjs`), emit **AVIF** (~30–80 KB each) to
  `public/housing-banners/bg/<key>.{light,dark}.avif`. 10 scenes × 2 themes ≈ 20 committed
  files, ~1 MB total. Full-res `out/` PNGs stay gitignored.
- Extending the library = add an `ARCHETYPES` entry → generate → bake (same ergonomics as
  adding an icon).

## 7. Palette / theming system

The generated scenes are screen-print duotones, so we **decouple tone from color**:
`palette.mjs` (built) defines `LIGHT_RAMP` + `DARK_RAMP` (a luminance→color gradient map),
anchored to `web/src/styles/globals.css` tokens (light `--background` warm-white, dark
`--background #0C0C0C` + `--primary #FFA94D`). `tone.mjs` (built) applies a 256-entry LUT
via sharp.

**Default = hybrid** (validated as best-looking): **light theme uses the source image**
(already sits in the light palette); **dark theme uses the dark gradient-map** (amber-on-
black glow, shadows melt into the page). One luminance master + one ramp. Fully-systematic
(both ramps) remains available via `THEME=light tone.mjs` if strict consistency is ever
wanted.

Runtime theme swap: the `<SuburbBanner>` `<picture>`/CSS references
`<key>.light.avif` vs `<key>.dark.avif` by the active theme (class/`prefers-color-scheme`).
Baked rasters → OG-safe, no runtime SVG filters.

## 8. Vector-map snapshot

- Reuse the existing boundary data + d3-geo path rendering (same source as
  `suburb-locator-map.tsx`): `topojson.feature(NSW.topojson, …)` → target by `SAL_CODE21`,
  select in-view neighbours by centroid bbox, `geoMercator().fitExtent(...)`.
- **Style:** target suburb filled with the theme accent (amber), neighbours as faint
  strokes, inside a rounded "locator card" panel (theme card bg + border). Add per polish:
  a touch more zoom, heavier neighbour strokes, optional coastline emphasis, a "you are
  here" dot. `vector-effect: non-scaling-stroke` (per the choropleth landmine).
- **Runtime:** a `SuburbBannerMap` client component (inline SVG) — the map already renders
  client-side elsewhere, so no SSR concern.
- **OG:** the map is pre-rasterized to a small PNG in the OG route (resvg/sharp, node
  runtime) — or omitted in OG v1 (background + name is already a strong card).

## 9. `agy` blurb pipeline

- `web/scripts/housing-banners/blurb.mjs` (new): builds a prompt from real facts (name,
  state, LGA, coast km, parks, top religion/language, nearby suburbs, median price where
  priced) and shells out: `agy -p '<prompt>' --model <model>`. Prompt demands **strict
  JSON**: `{ blurb (≤30 words, editorial), landmarks: [{name, kind}], archetype_hint,
  image_prompt }`, instructed to surface *known* landmarks for well-known suburbs and lean
  on nature otherwise (no invented specifics for obscure suburbs).
- **Cadence:** on-demand-cached is the baseline (generate on first profile request if
  `banner_blurb` is null, persist), plus an optional batch backfill for priced + top-N-by-
  population suburbs so majors are warm immediately. Deterministic archetype is always
  present even before a blurb exists (templated fallback sentence from data).
- `image_prompt` only drives a **bespoke** background (on-demand, cached to GCS) when
  `landmarks` are confidently real; otherwise the archetype library asset is used.

## 10. Data model + backend

- **Migration** (`services/migrations/0000NN_add_suburb_banner`): add to
  `suburb_demographics` — `banner_archetype text`, `banner_blurb text`,
  `banner_landmarks jsonb`, `banner_bg_key text` (defaults to archetype),
  `banner_bg_url text` NULL (bespoke override), `banner_generated_at timestamptz` NULL.
- **Proto:** new `SuburbBanner { archetype, blurb, landmarks[], bg_key, bg_url }` on
  `GetSuburbProfileResponse` (field N). `buf generate`.
- **Store + RPC:** thread through `postgres_house_prices.go` / `GetSuburbProfile`
  (LEFT JOIN, graceful when null). **Both** the `ListStateSuburbs` and `GetSuburbProfile`
  literals must be updated if banner data is ever put on the summary (per the local-insights
  two-literal landmine) — here it's response-level, so only `GetSuburbProfile`.
- **Ingest:** collector `-mode banners` (classify → upsert archetype) + `blurb.mjs`
  (agy → upsert blurb/landmarks). Classification needs no new data; it reads existing
  amenity/demographic columns.

## 11. Frontend `<SuburbBanner>`

- New `web/src/@/components/housing/suburb-banner.tsx`, slotted **above the `<h1>`** in
  `suburb-profile.tsx` (replacing the plain text header block, which folds into the banner).
- Server passes `banner`, `salCode`, `stateCode`, `salName`, and the headline stat.
- Layers: `<picture>` background (theme AVIF) → theme scrim → `SuburbBannerMap` (client) →
  serif name + mono stat + blurb. Responsive: on mobile the map card drops below / shrinks,
  scrim covers full width, name scales down.
- The blurb also renders as a short intro paragraph under the banner (SEO copy).

## 12. Image-generation path (production)

**Default: direct OpenAI `gpt-image-1`** (`services/.env` key; verified working). The
brandbrain flow-orchestrator MCP is the nicer pipeline but its local build has **drifted**
behind the deployed "asset-set" canvas backend, which now rejects the old topology
(`apply_flow_edits` → `Invalid request.`; even the icon flow 500s). Reviving it =
`git pull` brandbrain + rebuild the MCP + port the generator to the asset-set API — tracked
as a follow-up, not a blocker for this feature. (Captured in memory `brandbrain-mcp-icon-flow`.)

## 13. Iconography (new POI motif batch)

Add a `landmark/nature` group to `web/scripts/housing-icons/icon-set.config.mjs` (same
warm-duotone icon style), used as banner accents / archetype badges: `beach, headland,
harbour, river, lake, mountain, forest, bushland, vineyard, farmland, parkland,
skyline-tall`. Generate (via the same drift-affected flow, so use the direct path or fix the
MCP) → `pack-sprite.mjs` → `<HousingIcon>`. Amenity-category POI icons (cafe/gym/childcare)
are deferred until we ingest that data — an icon with nothing to label is premature.

## 14. Cost

| Item | Cost |
|---|---|
| Archetype background library (10 × ~$0.06, one-off; ×2 if bespoke dark) | ~$1–2 |
| Bespoke backgrounds for majors (on-demand, cached) | <$15 at full national coverage |
| `agy` blurbs | local compute (no per-call $), batched/on-demand |
| Per-suburb map + composite + toning | $0 (deterministic / build-time) |
| **Total for full 15,300-suburb coverage** | **~$1–20** |

## 15. Rollout (DB-before-code, per local-insights)

1. Apply migration to prod Supabase **session pooler :5432** (`sed :6543→:5432`,
   `PGOPTIONS='-c statement_timeout=0'`), from the prod `DATABASE_URL` (project
   `rosy-clover-477102-t5`, account ben@shorted.com.au — needs explicit prod-DB approval).
2. Generate + bake the archetype library; commit the AVIF assets.
3. Collector `-mode banners` (classify all suburbs) on :6543; batch `blurb.mjs` for majors.
4. Merge PR → `terraform-deploy.yml` deploys shorts + Vercel.
- `next/image` host allowlist for the GCS bespoke-background host (per the stock-page
  landmine: next/image crashes on unlisted hosts).
- Frontend/collector commits use `--no-verify` + manual tsc/eslint/test (flaky pre-commit).

## 16. Files

| File | Status | Role |
|---|---|---|
| `web/scripts/housing-banners/banner-set.config.mjs` | built | 10 archetype prompts + background STYLE |
| `web/scripts/housing-banners/generate-backgrounds-openai.mjs` | built | direct gpt-image-1 generator |
| `web/scripts/housing-banners/generate-backgrounds.mjs` | built | flow-MCP generator (drift-blocked) |
| `web/scripts/housing-banners/palette.mjs` + `tone.mjs` | built | light/dark gradient-map + sharp LUT |
| `web/scripts/housing-banners/mock-banner.mjs`, `contact-sheet.mjs`, `compare-themes.mjs` | built | prototype/review harness |
| `web/scripts/housing-banners/bake-library.mjs` | new | crop + tone + AVIF → committed assets |
| `web/scripts/geo/classify-archetype.mjs` (+ test) | new | deterministic archetype classifier |
| `web/scripts/housing-banners/blurb.mjs` | new | `agy` blurb/landmarks/hint pipeline |
| `web/public/housing-banners/bg/<key>.{light,dark}.avif` | new | committed background library |
| `services/migrations/0000NN_add_suburb_banner.*.sql` | new | banner columns on suburb_demographics |
| `proto/shortedapi/shorts/v1alpha1/shorts.proto` | modify | `SuburbBanner` on GetSuburbProfileResponse |
| `services/shorts/.../postgres_house_prices.go`, `house_prices.go` | modify | store + RPC threading |
| `services/house-price-collector/` (`-mode banners`) | modify | classify + upsert |
| `web/src/@/components/housing/suburb-banner.tsx` (+ `suburb-banner-map.tsx`) | new | composite component |
| `web/src/@/components/housing/suburb-profile.tsx` | modify | slot banner above the header |
| `web/src/app/housing/[state]/[suburb]/opengraph-image.tsx` | new | baked OG banner |
| `web/scripts/housing-icons/icon-set.config.mjs` | modify | landmark/nature icon group |

## 17. Build phases (for the plan)

1. **Library + palette + bake** → committed AVIF assets (backgrounds done; needs `bake-library.mjs`).
2. **Classifier** (`classify-archetype.mjs` + tests).
3. **Data model** (migration + proto + store/RPC).
4. **`<SuburbBanner>` + map** (frontend composite, both themes, responsive) → slot into profile.
5. **`agy` blurb pipeline** + on-demand cache.
6. **OG route.**
7. **New iconography batch.**
8. **Rollout** (DB-before-code) + browser verification in both themes.

## 18. Open questions

- Harbour vs coastal-beach split — v1 folds harbour into the LLM hint; revisit if worth a
  cheap coastline-shape heuristic.
- OG map inclusion in v1 (background+name may be enough).
- Blurb backfill scope (majors-only batch vs full on-demand tail).
- Whether to also fix the flow MCP now or stay on direct-OpenAI (recommend: direct for this
  feature, fix MCP separately).
