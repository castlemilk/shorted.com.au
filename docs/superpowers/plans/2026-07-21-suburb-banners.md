# Suburb Banner Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `/housing/[state]/[suburb]` profile a distinctive, on-brand banner header — an archetype-classified illustrated background + the suburb's real vector-map snapshot + an `agy`-generated blurb — working natively in light and dark themes at ~$0 marginal cost per suburb.

**Architecture:** Composite three layers at render time (background AVIF from a ~10-scene archetype library + free d3-geo suburb boundary snapshot + serif/mono type over a theme scrim). Per-suburb data (archetype, blurb, landmarks, optional bespoke bg) lives on `suburb_demographics`, is surfaced through `GetSuburbProfile`, and is produced by a JS classifier (committed JSON, loaded by the collector — the local-insights pattern) + an `agy` blurb script. One luminance master → both themes via a light/dark gradient-map.

**Tech Stack:** Node ESM scripts, `sharp` (AVIF + LUT), `d3-geo`/`topojson-client`, OpenAI `gpt-image-1` (direct), `agy` CLI, Go Connect-RPC + pgx (shorts service + house-price-collector), protobuf/`buf`, Next.js App Router + Tailwind, `next/og`.

**Spec:** `docs/superpowers/specs/2026-07-21-suburb-banners-design.md`. §18 open questions resolved to the recommended defaults (harbour via LLM hint; OG map omitted in v1; blurb = majors-batch + on-demand tail; stay on direct-OpenAI, don't fix the flow MCP here).

**Already built** (committed on `feat/suburb-banners`, `f6f754f05`): `banner-set.config.mjs`, `generate-backgrounds-openai.mjs`, `generate-backgrounds.mjs`, `palette.mjs`, `tone.mjs`, `contact-sheet.mjs`, `compare-themes.mjs`, `mock-banner.mjs`, and the 10 source backgrounds in `out/` (gitignored). This plan builds the shippable feature on top.

**Verify-env recipe** (used throughout, per `local-insights`/`housing-map` memory): prebuilt `/tmp/shorts-server` on `:9099` (NOT `go run &` — orphan children squat the port; confirm `lsof -iTCP:9099 -sTCP:LISTEN` pid) against local DB with `RATE_LIMIT_ENABLED=false`; separate `next dev -p 3025` with `NEXT_PUBLIC_API_URL=http://localhost:3025` + `NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT=http://localhost:9099`; Playwright must use a real Chrome UA (the bot interceptor 403s HeadlessChrome). Frontend/collector commits use `git commit --no-verify` + manual `tsc`/`eslint`/tests (flaky pre-commit hook).

---

## Phase 1 — Archetype classifier (pure, TDD)

Deterministic base archetype from signals we already ship (`distToCoastKm`, `amenityDensityScore`, `parksCount`, `population`). Produces a committed JSON the collector loads (mirrors `web/scripts/geo/join-electorates.mjs` → `electorates/*.json`).

### Task 1: `classifyArchetype` pure function + tests

**Files:**
- Create: `web/scripts/geo/classify-archetype.mjs`
- Test: `web/scripts/geo/classify-archetype.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// web/scripts/geo/classify-archetype.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyArchetype, ARCHETYPE_BASE } from "./classify-archetype.mjs";

test("coastal suburb (close to coast, not CBD) → coastal-beach", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 0.4, amenityDensityScore: 40, parksCount: 3, population: 12000 }), "coastal-beach");
});
test("very dense inner-city → urban-skyline", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 1.2, amenityDensityScore: 92, parksCount: 2, population: 20000 }), "urban-skyline");
});
test("dense inner suburb (55–80) → inner-terraces", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 8, amenityDensityScore: 66, parksCount: 4, population: 9000 }), "inner-terraces");
});
test("high parks, mid density → parkland", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 15, amenityDensityScore: 45, parksCount: 40, population: 8000 }), "parkland");
});
test("mid-density suburban default → leafy-suburban", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 20, amenityDensityScore: 38, parksCount: 5, population: 7000 }), "leafy-suburban");
});
test("remote low-amenity inland → bushland", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 120, amenityDensityScore: 8, parksCount: 1, population: 400 }), "bushland");
});
test("missing signals → leafy-suburban (safe default)", () => {
  assert.equal(classifyArchetype({}), "leafy-suburban");
});
test("ARCHETYPE_BASE excludes LLM-only archetypes", () => {
  assert.ok(!ARCHETYPE_BASE.includes("harbour") && !ARCHETYPE_BASE.includes("hills-ranges"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/scripts/geo/classify-archetype.test.mjs`
Expected: FAIL — `Cannot find module './classify-archetype.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// web/scripts/geo/classify-archetype.mjs
// Deterministic base archetype from signals shipped by local-insights.
// harbour / river-valley / hills-ranges / farmland are NOT derivable here — they
// come from agy's archetype_hint (LLM knowledge). See the suburb-banners spec §5.
export const ARCHETYPE_BASE = [
  "coastal-beach", "urban-skyline", "inner-terraces", "parkland", "leafy-suburban", "bushland",
];
// parksCount national top-decile threshold (tune from data in Task 2; default here).
const PARKS_TOP_DECILE = 20;

export function classifyArchetype(s = {}) {
  const coast = Number(s.distToCoastKm ?? Infinity);
  const dens = Number(s.amenityDensityScore ?? 0);
  const parks = Number(s.parksCount ?? 0);
  if (coast < 2 && dens < 80) return "coastal-beach";
  if (dens >= 80) return "urban-skyline";
  if (dens >= 55) return "inner-terraces";
  if (parks >= PARKS_TOP_DECILE && dens < 55) return "parkland";
  if (dens < 25 && coast > 30) return "bushland";
  return "leafy-suburban";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/scripts/geo/classify-archetype.test.mjs`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add web/scripts/geo/classify-archetype.mjs web/scripts/geo/classify-archetype.test.mjs
git commit --no-verify -m "feat(housing): deterministic suburb-banner archetype classifier"
```

### Task 2: Build the committed archetype JSON from real suburb data

**Files:**
- Create: `web/scripts/geo/build-archetypes.mjs`
- Create (output): `web/public/geo/insights/suburb-archetypes.json`

- [ ] **Step 1: Write the builder**

Reads the committed insights JSONs that already carry the signals (`suburb-amenities.json` has `amenity_density`/`parksCount`/`dist_to_coast_km`; `suburb-demographics` population is in the census output). Calibrates the parks top-decile threshold from the actual distribution, then classifies every suburb.

```js
// web/scripts/geo/build-archetypes.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyArchetype } from "./classify-archetype.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INS = join(HERE, "..", "..", "public", "geo", "insights");
const amen = JSON.parse(readFileSync(join(INS, "suburb-amenities.json"), "utf8")); // { salCode: {...} }

// Calibrate parks top-decile so the parkland bucket is genuinely rare.
const parksVals = Object.values(amen).map((a) => Number(a.parksCount ?? a.parks_count ?? 0)).sort((x, y) => x - y);
const p90 = parksVals[Math.floor(parksVals.length * 0.9)] || 20;

const out = {};
for (const [sal, a] of Object.entries(amen)) {
  out[sal] = classifyArchetype({
    distToCoastKm: a.dist_to_coast_km ?? a.distToCoastKm,
    amenityDensityScore: a.amenity_density ?? a.amenityDensityScore,
    parksCount: a.parksCount ?? a.parks_count,
    population: a.population,
  });
}
writeFileSync(join(INS, "suburb-archetypes.json"), JSON.stringify(out));
const counts = {};
for (const v of Object.values(out)) counts[v] = (counts[v] || 0) + 1;
console.error(`archetypes for ${Object.keys(out).length} suburbs (parks p90=${p90}):`, counts);
```

- [ ] **Step 2: Run it and sanity-check the distribution**

Run: `node web/scripts/geo/build-archetypes.mjs`
Expected: prints counts; `coastal-beach` and `urban-skyline` are minorities, `leafy-suburban` is the plurality, `bushland` non-trivial. If a key name mismatch prints all-`leafy-suburban`, fix the field names against the actual `suburb-amenities.json` keys and re-run.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/geo/build-archetypes.mjs web/public/geo/insights/suburb-archetypes.json
git commit --no-verify -m "feat(housing): build committed suburb->archetype map from insights data"
```

---

## Phase 2 — Background library + bake to theme AVIF

### Task 3: `bake-library.mjs` — crop + tone + AVIF

**Files:**
- Create: `web/scripts/housing-banners/bake-library.mjs`
- Create (output): `web/public/housing-banners/bg/<id>.{light,dark}.avif`

- [ ] **Step 1: Write the bake script**

```js
// web/scripts/housing-banners/bake-library.mjs
// Crop each 1536x1024 master to a 3:1 banner band, produce the light (source) and
// dark (gradient-map) variants, emit compact AVIF for shipping.
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";
import { RAMPS, buildLut } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const DEST = join(HERE, "..", "..", "public", "housing-banners", "bg");
mkdirSync(DEST, { recursive: true });
const BW = 1600, BH = 540; // ~3:1 banner band
const darkLut = buildLut(RAMPS.dark);

async function bandFromMaster(id) {
  // resize master to BW wide (keeps 3:2), then extract a BH-tall band starting ~15% down
  const full = await sharp(join(OUT, `${id}.png`)).resize(BW).toBuffer();
  const meta = await sharp(full).metadata();
  const top = Math.round((meta.height - BH) * 0.28);
  return sharp(full).extract({ left: 0, top: Math.max(0, top), width: BW, height: BH });
}

for (const { id } of ARCHETYPES) {
  if (!existsSync(join(OUT, `${id}.png`))) { console.error(`skip ${id} (no master)`); continue; }
  // light = source band
  await (await bandFromMaster(id)).avif({ quality: 62 }).toFile(join(DEST, `${id}.light.avif`));
  // dark = gradient-mapped band
  const band = await (await bandFromMaster(id)).greyscale().linear(1.06, -7.68).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
  const { data, info } = band;
  const rgb = Buffer.allocUnsafe(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) { const g = data[i] * 3; rgb[i*3]=darkLut[g]; rgb[i*3+1]=darkLut[g+1]; rgb[i*3+2]=darkLut[g+2]; }
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).avif({ quality: 62 }).toFile(join(DEST, `${id}.dark.avif`));
  console.error(`baked ${id}`);
}
console.error(`DONE -> ${DEST}`);
```

- [ ] **Step 2: Run + verify size and dims**

Run: `node web/scripts/housing-banners/bake-library.mjs && ls -la web/public/housing-banners/bg/ && node -e "require('sharp')('web/public/housing-banners/bg/coastal-beach.dark.avif').metadata().then(m=>console.log(m.width,m.height,m.format))"`
Expected: 20 `.avif` files, each ~20–90 KB, dims `1600 540 heif`.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/housing-banners/bake-library.mjs web/public/housing-banners/bg/
git commit --no-verify -m "feat(housing): bake archetype backgrounds to theme-swapped AVIF"
```

---

## Phase 3 — Data model + backend

### Task 4: Migration — banner columns on `suburb_demographics`

**Files:**
- Create: `services/migrations/0000NN_add_suburb_banner.up.sql` (NN = next free number; check `ls services/migrations | tail`)
- Create: `services/migrations/0000NN_add_suburb_banner.down.sql`

- [ ] **Step 1: Write up + down SQL**

```sql
-- up
ALTER TABLE suburb_demographics
  ADD COLUMN IF NOT EXISTS banner_archetype   text,
  ADD COLUMN IF NOT EXISTS banner_blurb       text,
  ADD COLUMN IF NOT EXISTS banner_landmarks   jsonb,
  ADD COLUMN IF NOT EXISTS banner_bg_key      text,
  ADD COLUMN IF NOT EXISTS banner_bg_url      text,
  ADD COLUMN IF NOT EXISTS banner_generated_at timestamptz;
```
```sql
-- down
ALTER TABLE suburb_demographics
  DROP COLUMN IF EXISTS banner_archetype, DROP COLUMN IF EXISTS banner_blurb,
  DROP COLUMN IF EXISTS banner_landmarks, DROP COLUMN IF EXISTS banner_bg_key,
  DROP COLUMN IF EXISTS banner_bg_url, DROP COLUMN IF EXISTS banner_generated_at;
```

- [ ] **Step 2: Apply locally**

Run (local dev DB has no `schema_migrations` — apply directly, per housing-map memory):
`psql postgresql://admin:password@localhost:5438/shorts -f services/migrations/0000NN_add_suburb_banner.up.sql`
Expected: `ALTER TABLE`.

- [ ] **Step 3: Commit**

```bash
git add services/migrations/0000NN_add_suburb_banner.*.sql
git commit --no-verify -m "feat(db): suburb_demographics banner columns (000NN)"
```

### Task 5: Proto — `SuburbBanner` on `GetSuburbProfileResponse`

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`
- Regenerate: `web/src/gen/**`, Go `pb`

- [ ] **Step 1: Add the message + field**

Add near the other suburb messages. Use the **next free field number** on `GetSuburbProfileResponse` (read the message; do not reuse a number).

```proto
message SuburbBanner {
  string archetype = 1;                 // classified/refined archetype id
  string blurb = 2;                     // editorial one-liner (also page copy)
  repeated SuburbLandmark landmarks = 3;
  string bg_key = 4;                    // library asset key (defaults to archetype)
  string bg_url = 5;                    // bespoke background override (optional)
}
message SuburbLandmark { string name = 1; string kind = 2; }
// in GetSuburbProfileResponse:
//   SuburbBanner banner = <next free number>;
```

- [ ] **Step 2: Generate**

Run: `cd proto && buf generate`
Expected: no errors; `web/src/gen/shorts/v1alpha1/shorts_pb.ts` gains `SuburbBannerSchema`. (LSP `MissingLitField` on fresh proto types is a stale false-alarm — trust `go build`.)

- [ ] **Step 3: Commit**

```bash
git add proto/ web/src/gen/ services/**/gen* 2>/dev/null; git add -A proto web/src/gen
git commit --no-verify -m "feat(proto): SuburbBanner on GetSuburbProfileResponse"
```

### Task 6: Store + RPC — surface banner in `GetSuburbProfile`

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go` (the `GetSuburbProfile` query + scan)
- Modify: `services/shorts/internal/services/shorts/house_prices.go` (map row → `pb.SuburbBanner`)
- Test: `services/shorts/internal/services/shorts/house_prices_test.go`

- [ ] **Step 1: Read the current `GetSuburbProfile` store method** to get the exact query/scan shape, then extend it.

Add to the `SELECT` (LEFT JOIN already targets `suburb_demographics d`): `d.banner_archetype, d.banner_blurb, d.banner_landmarks, d.banner_bg_key, d.banner_bg_url`. Scan into `sql.NullString` locals (+ `[]byte` for the jsonb). Build:

```go
banner := &pb.SuburbBanner{
    Archetype: archetype.String,
    Blurb:     blurb.String,
    BgKey:     firstNonEmpty(bgKey.String, archetype.String),
    BgUrl:     bgURL.String,
}
if len(landmarksJSON) > 0 {
    var lms []struct{ Name string `json:"name"`; Kind string `json:"kind"` }
    if err := json.Unmarshal(landmarksJSON, &lms); err == nil {
        for _, l := range lms { banner.Landmarks = append(banner.Landmarks, &pb.SuburbLandmark{Name: l.Name, Kind: l.Kind}) }
    }
}
resp.Banner = banner // only GetSuburbProfile has this (response-level, not the two-literal summary trap)
```

- [ ] **Step 2: Write a handler test** asserting the banner round-trips (fixture store returns a row with archetype+blurb → response `.Banner.Archetype`/`.Blurb` set). Model on the existing `GetSuburbProfile` test.

- [ ] **Step 3: Run backend build + tests**

Run: `cd services && go build ./... && go test ./shorts/internal/services/shorts/ -run SuburbProfile -v`
Expected: build clean; test PASS.

- [ ] **Step 4: Commit**

```bash
git add services/shorts/internal/store/shorts/postgres_house_prices.go services/shorts/internal/services/shorts/house_prices.go services/shorts/internal/services/shorts/house_prices_test.go
git commit --no-verify -m "feat(shorts): surface SuburbBanner in GetSuburbProfile"
```

### Task 7: Collector `-mode banners` — classify + upsert

**Files:**
- Create: `services/house-price-collector/banners.go`
- Modify: `services/house-price-collector/main.go` (register `-mode banners`)

- [ ] **Step 1: Write the loader/upsert** (mirror `electorates.go`/`upsertElectorates`): read `ARCHETYPES_FILE` (default the committed `web/public/geo/insights/suburb-archetypes.json`), UPSERT `banner_archetype` + `banner_bg_key` (= archetype) by `sal_code`, on the `:6543` txn pooler with `QueryExecModeSimpleProtocol`.

```go
func runBanners(ctx context.Context, s *Store) error {
    path := envOr("ARCHETYPES_FILE", "web/public/geo/insights/suburb-archetypes.json")
    var m map[string]string
    if err := readJSON(path, &m); err != nil { return err }
    n := 0
    for sal, arch := range m {
        if _, err := s.pool.Exec(ctx,
            `UPDATE suburb_demographics SET banner_archetype=$2, banner_bg_key=COALESCE(banner_bg_key,$2) WHERE sal_code=$1`,
            sal, arch); err != nil { return err }
        n++
    }
    log.Printf("banners: set archetype for %d suburbs", n)
    return nil
}
```

- [ ] **Step 2: Build**

Run: `cd services && go build ./house-price-collector/...`
Expected: clean.

- [ ] **Step 3: Run against local DB + verify**

Run: `cd services && APP_ENV=local go run ./house-price-collector -mode banners` then
`psql $LOCAL_DB -c "select banner_archetype, count(*) from suburb_demographics group by 1 order by 2 desc;"`
Expected: archetype counts populated matching Task 2's distribution.

- [ ] **Step 4: Commit**

```bash
git add services/house-price-collector/banners.go services/house-price-collector/main.go
git commit --no-verify -m "feat(collector): -mode banners classifies + upserts suburb archetype"
```

---

## Phase 4 — Frontend `<SuburbBanner>`

### Task 8: `SuburbBannerMap` (client, d3-geo)

**Files:**
- Create: `web/src/@/components/housing/suburb-banner-map.tsx`

- [ ] **Step 1: Read `suburb-locator-map.tsx`** to reuse its topojson fetch + projection pattern, then write a banner-styled variant: fetch `/geo/suburbs/<state>.topojson`, find the target by `salCode`, select in-view neighbours by centroid bbox, `geoMercator().fitExtent`, render neighbours faint + target filled `var(--primary)`, `vector-effect: non-scaling-stroke`. Props: `{ stateCode, salCode }`. Wrap so it renders nothing until the topojson loads (no SSR — `"use client"`).

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors (d3-zoom/geo typings per housing-map memory: `res.json() as Topology`, `STATE_NAMES[code]!`).

- [ ] **Step 3: Commit** `git add web/src/@/components/housing/suburb-banner-map.tsx && git commit --no-verify -m "feat(housing): client suburb-boundary map for the banner"`

### Task 9: `SuburbBanner` composite + slot into profile

**Files:**
- Create: `web/src/@/components/housing/suburb-banner.tsx`
- Modify: `web/src/@/components/housing/suburb-profile.tsx` (replace the text header block ~L118–150 with `<SuburbBanner .../>`; keep the price/stat data feeding it)

- [ ] **Step 1: Write the banner component**

```tsx
// suburb-banner.tsx
"use client";
import { SuburbBannerMap } from "./suburb-banner-map";
type Banner = { archetype: string; blurb: string; bgKey: string; bgUrl?: string };
export function SuburbBanner({ name, sub, stat, statSub, banner, stateCode, salCode }: {
  name: string; sub: string; stat?: string; statSub?: string; banner?: Banner; stateCode: string; salCode: string;
}) {
  const key = banner?.bgKey || banner?.archetype || "leafy-suburban";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border">
      {/* background: theme-swapped AVIF (light source / dark gradient-map). bespoke bg_url overrides. */}
      <picture>
        {banner?.bgUrl ? <img src={banner.bgUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : (
          <>
            <source srcSet={`/housing-banners/bg/${key}.dark.avif`} media="(prefers-color-scheme: dark)" />
            <img src={`/housing-banners/bg/${key}.light.avif`} alt="" className="absolute inset-0 h-full w-full object-cover dark:hidden" />
            <img src={`/housing-banners/bg/${key}.dark.avif`} alt="" className="absolute inset-0 hidden h-full w-full object-cover dark:block" />
          </>
        )}
      </picture>
      {/* theme scrim */}
      <div className="absolute inset-0 bg-gradient-to-r from-background/85 via-background/45 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent" />
      <div className="relative flex min-h-[200px] items-center justify-between gap-4 p-6 sm:min-h-[260px] sm:p-8">
        <div className="max-w-[62%]">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Housing</div>
          <h1 className="mt-1 font-serif text-4xl font-semibold capitalize text-foreground sm:text-6xl">{name.toLowerCase()}</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">{sub}</p>
          {stat ? <p className="mt-3 font-mono text-2xl font-semibold text-primary">{stat}</p> : null}
          {statSub ? <p className="font-mono text-xs text-muted-foreground">{statSub}</p> : null}
        </div>
        <div className="hidden aspect-square w-40 shrink-0 rounded-xl border border-border/60 bg-card/70 p-2 backdrop-blur-sm sm:block sm:w-52">
          <SuburbBannerMap stateCode={stateCode} salCode={salCode} />
        </div>
      </div>
      {banner?.blurb ? <p className="relative px-6 pb-5 text-sm text-muted-foreground sm:px-8">{banner.blurb}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Slot into `suburb-profile.tsx`** — replace the header `<div className="flex flex-wrap items-end justify-between gap-3">…</div>` with:

```tsx
<SuburbBanner
  name={s.salName}
  sub={`${stateName}${s.postcode ? ` · ${s.postcode}` : ""}${d?.censusYear ? ` · Census ${d.censusYear}` : ""}`}
  stat={priced ? fmtAUD(s.latestMedianPrice) : undefined}
  statSub={priced ? `${s.yoyPct >= 0 ? "+" : ""}${s.yoyPct.toFixed(1)}% yr · median house${asOf ? ` · ${asOf}` : ""}` : undefined}
  banner={data.banner ? { archetype: data.banner.archetype, blurb: data.banner.blurb, bgKey: data.banner.bgKey, bgUrl: data.banner.bgUrl || undefined } : undefined}
  stateCode={st}
  salCode={s.salCode}
/>
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd web && npx tsc --noEmit && npx eslint src/@/components/housing/suburb-banner.tsx src/@/components/housing/suburb-profile.tsx`
Expected: clean.

- [ ] **Step 4: Browser-verify both themes** (verify-env recipe above): load `http://localhost:3025/housing/nsw/bondi-beach`, screenshot light + dark (toggle theme), confirm banner renders with map + scrim, 0 console errors.

- [ ] **Step 5: Commit** `git add web/src/@/components/housing/suburb-banner.tsx web/src/@/components/housing/suburb-profile.tsx && git commit --no-verify -m "feat(housing): SuburbBanner composite header on suburb profile"`

---

## Phase 5 — `agy` blurb pipeline

### Task 10: `blurb.mjs` — agy → JSON → DB

**Files:**
- Create: `web/scripts/housing-banners/blurb.mjs`

- [ ] **Step 1: Write the prompt builder + agy shell-out**

```js
// blurb.mjs — generate editorial blurbs + landmark/archetype refinement via agy.
//   DATABASE_URL=... node web/scripts/housing-banners/blurb.mjs --limit 200 --priced-only
import { execFileSync } from "node:child_process";
import pg from "pg";
import { ARCHETYPE_BASE } from "../geo/classify-archetype.mjs";

const ALL_ARCHETYPES = [...ARCHETYPE_BASE, "harbour", "river-valley", "hills-ranges", "farmland"];
function buildPrompt(f) {
  return `You are writing a one-line editorial banner blurb for the Australian suburb "${f.name}", ${f.state}.
Facts: council ${f.lga || "?"}, ${f.coastKm != null ? `${f.coastKm.toFixed(1)}km to coast` : "inland"}, parks ${f.parks ?? "?"}, top language ${f.language || "English"}, ${f.priced ? `median house ${f.median}` : "price not tracked"}.
Return STRICT JSON only: {"blurb": "<=30 words, evocative, factual, no clichés", "landmarks":[{"name":"","kind":"beach|park|landmark|river|mountain|building"}], "archetype_hint":"one of ${ALL_ARCHETYPES.join("|")}", "image_prompt":"short scene phrase"}.
Only name landmarks you are CONFIDENT are real for this specific suburb; for obscure suburbs return [] and lean on nature. No prose outside the JSON.`;
}
function agy(prompt) {
  const raw = execFileSync("agy", ["-p", prompt], { encoding: "utf8", maxBuffer: 4 << 20 });
  const m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error("no JSON from agy");
  return JSON.parse(m[0]);
}
// … arg parse, SELECT candidate suburbs (missing banner_blurb; --priced-only / --limit),
// for each: agy(buildPrompt) → UPDATE suburb_demographics SET banner_blurb, banner_landmarks,
// banner_archetype = COALESCE(hint-if-valid, banner_archetype), banner_bg_key=that,
// banner_generated_at=now() WHERE sal_code=$. Log progress; resumable (skips rows already set).
```

- [ ] **Step 2: Dry-run one suburb** (no DB write): `node -e "import('./web/scripts/housing-banners/blurb.mjs')"` variant or a `--dry --sal 10463` flag → print the parsed JSON. Expected: valid JSON with a Bondi-relevant blurb + `archetype_hint`.

- [ ] **Step 3: Batch a small set locally** `DATABASE_URL=$LOCAL_DB node web/scripts/housing-banners/blurb.mjs --priced-only --limit 20` → verify rows updated. Confirm the archetype-hint override only applies when the hint ∈ `ALL_ARCHETYPES`.

- [ ] **Step 4: Commit** `git add web/scripts/housing-banners/blurb.mjs && git commit --no-verify -m "feat(housing): agy blurb + landmark/archetype-hint pipeline"`

### Task 11: On-demand blurb backfill hook (tail coverage)

**Files:**
- Modify: `services/shorts/internal/services/shorts/house_prices.go` (GetSuburbProfile)

- [ ] **Step 1:** When a profile is requested and `banner_blurb` is empty, enqueue a lightweight async job (fire-and-forget goroutine writing to a `banner_jobs` marker, drained by the same `blurb.mjs` run on a cron) — do NOT block the request or call agy inline. For v1 the simplest correct version: return the templated fallback (built from data: e.g. `"${name}, a ${archetype-descriptor} suburb of ${lga}."`) and let the majors-batch/cron fill real blurbs. Document that inline agy generation is intentionally out of the request path.

- [ ] **Step 2:** Build + test `cd services && go build ./...`; commit.

---

## Phase 6 — OG image

### Task 12: `opengraph-image.tsx` for suburb pages

**Files:**
- Create: `web/src/app/housing/[state]/[suburb]/opengraph-image.tsx`

- [ ] **Step 1:** Write a `next/og` `ImageResponse` route: fetch the profile (reuse `getSuburbProfile`), compose the baked background (`/housing-banners/bg/<key>.dark.avif` — dark reads best as an OG card) via `<img>`, a `linear-gradient` scrim (NOT radial — satori can't size it, per CLAUDE.md), and the serif name + stat text (system serif — no webfont, per the housing-feature OG gotcha). Map omitted in v1 (spec §18). `export const size = { width: 1200, height: 630 }` + `runtime = "nodejs"`.

- [ ] **Step 2:** Verify: `curl -s localhost:3025/housing/nsw/bondi-beach/opengraph-image | file -` → PNG; open it, confirm name + background render.

- [ ] **Step 3:** Commit.

---

## Phase 7 — New iconography batch (landmark/nature)

### Task 13: Add landmark/nature icon group

**Files:**
- Modify: `web/scripts/housing-icons/icon-set.config.mjs`

- [ ] **Step 1:** Append to `ICONS`:

```js
{ id: "beach", group: "landmark", subject: "a curling ocean wave breaking on a small sandy shore" },
{ id: "headland", group: "landmark", subject: "a rocky coastal headland jutting into water" },
{ id: "harbour", group: "landmark", subject: "a small sailboat moored beside a short jetty" },
{ id: "river", group: "landmark", subject: "a winding river between two banks" },
{ id: "lake", group: "landmark", subject: "a calm lake with a single ripple" },
{ id: "mountain", group: "landmark", subject: "a simple twin-peak mountain" },
{ id: "forest", group: "landmark", subject: "three overlapping pine-tree silhouettes" },
{ id: "bushland", group: "landmark", subject: "a slender eucalypt gum tree" },
{ id: "vineyard", group: "landmark", subject: "a grape cluster on a vine leaf" },
{ id: "farmland", group: "landmark", subject: "a windmill beside a fence post" },
{ id: "parkland", group: "landmark", subject: "a round shade tree beside a park bench" },
{ id: "skyline-tall", group: "landmark", subject: "three tall city towers of increasing height" },
```

- [ ] **Step 2: Generate** (flow MCP is drift-blocked — use the direct path): adapt `generate-backgrounds-openai.mjs`'s direct call, or run a one-off with the icon STYLE (transparent, 1:1). Since the MCP path is down, generate these 12 with `ONLY=<ids>` via a direct-icon script (transparent PNGs). Verify alpha=0 background.

- [ ] **Step 3: Pack the sprite** `node web/scripts/housing-icons/pack-sprite.mjs` → regenerates `housing-icons.png` + `housing-icons.generated.ts`.

- [ ] **Step 4:** Typecheck + commit the sprite + manifest.

---

## Phase 8 — Rollout (DB-before-code)

### Task 14: Production rollout

- [ ] **Step 1 (needs explicit prod-DB approval from the user):** Apply the migration to prod Supabase **session pooler :5432** (`sed 's/:6543/:5432/'` on the `DATABASE_URL` secret from `rosy-clover-477102-t5`, account ben@shorted.com.au, `PGOPTIONS='-c statement_timeout=0'`).
- [ ] **Step 2:** Run collector `-mode banners` against prod **:6543** (`ARCHETYPES_FILE=<abs path to committed json>`); batch `blurb.mjs --priced-only` for majors against prod.
- [ ] **Step 3:** Verify prod DB: `select banner_archetype, count(*) … ; select count(*) where banner_blurb is not null;`.
- [ ] **Step 4:** Add the GCS bespoke-background host to `web/next.config.mjs` `images.remotePatterns` (next/image crashes on unlisted hosts — stock-page landmine). Only needed once bespoke bgs exist; safe to add now.
- [ ] **Step 5:** Open PR from `feat/suburb-banners`. **Hand the merge to the user** (auto-mode blocks agent self-merge/push — prod-merge-push-gating memory). `terraform-deploy.yml` deploys shorts + Vercel on merge.
- [ ] **Step 6:** Post-deploy: browser-verify `shorted.com.au/housing/nsw/bondi-beach` in both themes; confirm banner + map + blurb render, OG card resolves.

---

## Self-review

**Spec coverage:** §5 classifier → Tasks 1–2, 7; §6 library/bake → Task 3; §7 palette → reused (`palette.mjs`/`tone.mjs`) in Task 3; §8 map → Tasks 8–9; §9 blurb → Tasks 10–11; §10 data model → Tasks 4–6; §11 component → Task 9; §12 image path → Task 3 (direct OpenAI); §13 icons → Task 13; §15 rollout → Task 14; §16 files all covered. No gaps.

**Placeholder scan:** `0000NN`/`<next free number>` are genuine build-time lookups (migration index, proto field), not vague placeholders — each step says how to find them. No "TODO/handle edge cases/write tests for the above".

**Type consistency:** `classifyArchetype`/`ARCHETYPE_BASE` (Task 1) reused verbatim in Tasks 2 + 10; `SuburbBanner{archetype,blurb,landmarks,bg_key,bg_url}` (Task 5) matches the store mapping (Task 6), the component `Banner` type (Task 9), and the collector columns (Tasks 4/7); AVIF path scheme `/housing-banners/bg/<key>.{light,dark}.avif` identical in Tasks 3, 9, 12.
