# Housing iconography — design

**Date:** 2026-07-02
**Branch:** `feat/housing-iconography`
**Status:** approved (design), spike pending

## Goal

Give the Shorted housing surface a custom, on-brand icon system — one
warm-duotone icon per metric / suburb-profile section / dashboard tile /
dropdown — **generated through the brandbrain flow-orchestrator MCP server**,
packed into a single sprite sheet, and wired into the UI. The housing view
currently uses **zero icons** (no lucide, no inline SVG, no emoji), so this is a
greenfield addition.

## Non-goals

- No new data pipeline, RPC, or migration. Presentation layer only.
- No per-suburb dynamic imagery. A fixed, curated icon set.
- Not replacing the choropleth colour palettes — icons *label* metrics; the map
  fill still encodes value.

## Approach at a glance

Three deliverables sharing one config:

1. **Icon-set definition** — per-component prompts (the flow inputs).
2. **The flow** — a committed orchestration script that drives the brandbrain
   `flow-orchestrator` MCP over stdio → prod backend → generates icons with a
   shared style + reference anchor → retrieves base64 → packs a sprite sheet.
3. **UI wiring** — a `<HousingIcon>` component + icon references across the
   metric registry, profile sections, dashboard tiles, and dropdowns.

## 1. Icon set (per-component prompts)

`web/scripts/housing-icons/icon-set.config.mjs` exports:

- `STYLE` — the shared style spec (below).
- `ICONS` — array of `{ id, label, subject, group, usedBy[] }`. `subject` is the
  concept-specific prompt fragment; the final prompt = `subject` + STYLE suffix.

~30 deduped concepts, grouped: **finance** (median-price, income, rent,
mortgage, debt-to-income, price-index), **people** (population, age, dwellings),
**culture** (religion, language, born-overseas, diversity), **electoral**
(representation, party, federal-lean), **amenities** (amenity-density,
supermarket, grocery, pubs, parks, libraries), **education** (school), **health**
(healthcare, hospital, pharmacy), **transport/geo** (train, coast, distance,
location), **infrastructure/civic** (nbn, council, grants), **relationships**
(compare, similar, nearby).

The exact list is finalised in the config after the spike; the anchor icon is
generated first and every other icon references it for consistency.

## 2. Style spec

Warm duotone in the housing palette — amber `#FFA94D` + olive `#87A96B` +
clay-rust `#D16A47` accent, **transparent background**, flat/editorial, single
centred subject, consistent stroke weight, generous padding, **no text/numbers**,
no shadows/gradients/frames. Amber-forward so it reads on both warm-white
(`40 25% 97%`) and terminal-black (`0 0% 5%`) themes. Delivered as a PNG sprite
(fixed colours, raster). Escalate to a second dark-theme sheet only if the
single sheet fails the both-themes read test in the spike.

## 3. The flow (drives the brandbrain MCP server)

`web/scripts/housing-icons/generate-icons.mjs` — a Node script that spawns the
brandbrain flow-orchestrator (`~/projects/brandbrain/mcp/flow-orchestrator/dist/index.js`)
over stdio against the **prod** backend (`BRANDBRAIN_API_URL=https://api.brandbrain.dev`,
already authenticated as ben.ebsworth@gmail.com, refresh token valid to Aug 1).
It holds **one persistent MCP connection** for the whole run (the polling task
registry is per-process).

Sequence:

1. `whoami_brandbrain` — verify auth; abort with a `login_brandbrain` hint if not.
2. `create_asset_flow` — title "Shorted Housing Iconography" (explicit blank
   flowSpec, no template — full graph control).
3. `apply_flow_edits` — one shared **style** node + the **anchor**
   prompt→generate→output chain.
4. `start_asset_flow_run {mode:"mock"}` → poll `get_asset_flow_task` — validate
   the graph executes with **no spend**.
5. `start_asset_flow_run {mode:"live"}` → poll → `get_flow_outputs` → save
   `anchor.png`; capture its `artifact_id`.
6. Add a **reference** node (the anchor, via `assetRef`/`storagePath`) and batch
   the remaining concepts (~5/run) as prompt→generate→output chains wired to the
   shared style + reference nodes. Live-run each batch → poll → save each PNG.
7. **Pack** all PNGs into `web/public/housing-icons/housing-icons.png` (grid, @2x)
   + `housing-icons.manifest.json` (`id → {x,y,w,h}`), plus a typed TS manifest.

**Provider/model:** `gpt-image-1` (transparent PNG), 1024², downscaled on pack.
Generate `target`: `surface:"app icon"`, `aspectRatio:"1:1"`, `textPolicy:"no text"`.

Graph facts (verified in `flow-spec-edit.ts`): `generate` accepts inputs from
`{prompt, reference, style}`; `generate → output` only; the whole graph is
validated per-PUT, so multi-node builds must go through `apply_flow_edits`.

## 4. Output artifacts

- `web/public/housing-icons/housing-icons.png` — the sprite sheet (@2x).
- `web/public/housing-icons/housing-icons.manifest.json` — slice coordinates.
- `web/src/@/components/housing/housing-icon.tsx` — `<HousingIcon name size/>`
  renders a slice via background-image + background-position from the manifest.
- Individual source PNGs retained under `web/scripts/housing-icons/out/` for
  re-packing without regenerating.

## 5. UI wiring

- `web/src/@/lib/housing/highlight-metrics.ts` — add an `icon` key per metric
  (surfaces in the "Colour by" dropdown + legend).
- `web/src/@/components/housing/suburb-profile.tsx` — icon beside each of the
  ~11 section headings.
- `web/src/app/housing/page.tsx` — icons on BigStats + capital-city tiles.
- `web/src/@/components/housing/state-suburb-explorer.tsx` — icons on
  sort/summary chips.

## 6. Execution phases & gates

- **Phase 0 — spike (GATE):** generate a **3-icon probe** in the proposed style.
  Validates: auth→backend→live gen end-to-end, transparency + duotone quality,
  and the cross-run reference-anchor mechanism (`artifact_id` → reference node).
  Show the 3 real icons to the user.
- **GATE:** user approves the style (or the spec is adjusted) → generate the full
  set, pack, wire, and verify in the running `/housing` app with screenshots.

## 7. Cost, risks, gates

- **Cost:** gpt-image-1 ≈ a few cents/image; full set + spike + a little
  iteration ≈ **$2–8** of OpenAI spend on the brandbrain prod backend.
- **Known unknown:** exact cross-run reference-anchor wiring (`artifact_id` vs
  `storagePath`). The spike resolves it; **fallback** = strong textual style spec
  (no image anchor) if anchoring doesn't wire cleanly.
- **Light/dark:** single amber-forward sheet; dual sheet only if the spike shows
  poor contrast on one theme.
- **Spend gate:** mock-run before every live run; live full-set run only after
  the Phase-0 style gate.

## 8. Reusability

The orchestration script is a generic "per-component-prompts → consistent icon
set → sprite sheet" harness driven by the brandbrain MCP; the icon list is data.
Re-runnable to regenerate or extend the set. Documented for future icon sets
(e.g. a shorts/markets icon system) via the same flow.
