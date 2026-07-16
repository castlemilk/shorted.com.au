---
name: perf-optimization
description: Diagnose and fix Shorted web performance (Core Web Vitals, bundle size, Lighthouse/PageSpeed) and keep it from regressing. Use when a PageSpeed/Lighthouse report comes in, LCP/TBT/CLS is high, the JS bundle grows, images are heavy, or someone asks to "make the site faster" / "improve the score".
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Web Performance Optimization

Playbook for measuring, fixing, and guarding front-end performance on the
Shorted web app (`web/`, Next.js 14 App Router). Structured data / rich-result
work is a **separate** concern (schema is a CTR lever, not a ranking or speed
lever) — this skill is about speed + Core Web Vitals + bundle size, which **do**
feed ranking.

## The measurement toolchain (all in `web/`)

Three complementary tools. Always measure against a **production build** — dev
mode is unminified and ~5-10× slower, so its scores are meaningless.

| Command | What | When |
|---|---|---|
| `npm run bundle:budget` | Gzipped **first-load JS per route** from `next build` manifests + heaviest chunks. Deterministic. | After any dep/import change. Needs `next build` first. |
| `npm run perf:lh` | **Lighthouse** mobile-throttled (matches PageSpeed mobile) — perf/a11y/bp/seo scores + LCP/TBT/CLS/FCP/SI. `--desktop` for desktop. | After a runtime/render/image change. Needs a running prod server. |
| `npm run perf:bench` | **Playwright** field-style TTFB/FCP/LCP/CLS/transfer/requests, median of N, unthrottled. | Quick before/after on a specific route. Needs a running server. |

Scripts: `web/scripts/{bundle-budget,lighthouse-bench,perf-benchmark}.mjs`.
Baselines live in `docs/perf/`. Ephemeral reports write to `web/perf-results/`
(gitignored).

### Standard run (prod build, both gates)

```bash
cd web
npx next build                         # prod build (SKIP_ENV_VALIDATION=1 if no .env)
npm run bundle:budget                  # first-load JS budgets
npm run start &                        # serve on :3020
until curl -sf localhost:3020 >/dev/null; do sleep 1; done
npm run perf:lh                        # mobile Lighthouse budgets
npm run perf:lh -- --desktop           # desktop too
kill %1                                 # stop the server when done
```

Local builds can fail at prerender (TLS mismatch fetching `api.shorted.com.au`);
that's a known env issue, not your code. Chrome is auto-found by chrome-launcher;
in CI (or if it can't find Chrome) set `CHROME_PATH` to the Playwright chromium:
`export CHROME_PATH="$(node -e 'console.log(require("playwright").chromium.executablePath())')"`.

### Baselines + budgets

Budgets are **regression guards** (set slightly looser than best-known), not
aspirations. They live inline in each script's `BUDGETS`. The committed
baselines are the real diff target:

```bash
# After an INTENTIONAL, verified change to the baseline (build first):
npm run bundle:baseline        # -> docs/perf/bundle-baseline.json
npm run start & ; npm run perf:lh:baseline   # -> docs/perf/lh-baseline.mobile.json
```

Commit the refreshed baseline in the same PR as the change that moved it, with a
one-line "why" in the PR body. Compare in CI/locally with `npm run bundle:compare`
/ `npm run perf:lh:compare`.

### CI

`.github/workflows/perf-budget.yml` runs on PRs touching `web/`:
- **Bundle budget = BLOCKING** (deterministic; fails the PR on real growth).
- **Lighthouse = ADVISORY** (`continue-on-error`; CI runner variance makes hard
  score gates flaky). Reports upload as the `perf-reports` artifact.

## The fix playbook — highest ROI first

Order matters. Images and JS dwarf everything else; do them before micro-tuning.

### 1. External / third-party images — usually the #1 LCP + transfer cost

Raw `<img src="https://publisher.cdn/...jpg">` ships the publisher's full-size
JPEG (500KB+). Route it through Next's optimizer instead → resized AVIF/WebP,
typically a **95%+** cut (measured: a 455KB stockhead JPEG → 15KB AVIF).

**The landmine:** `next/image` **throws at render** for a host not in
`next.config.mjs` `images.remotePatterns`. That's why external images are often
raw `<img>`. So the fix is *allowlist + safe wrapper*, never a blind swap:

1. Add the host to `remotePatterns` in `next.config.mjs` (the **effective**
   block — the one inside the `export default` that overrides `remotePatterns`,
   not the earlier `const config` one).
2. Use `web/src/@/components/news/news-image.tsx` (`<NewsImage>`) as the model:
   it optimizes hosts in `OPTIMIZED_HOSTS` and falls back to a plain `<img>` for
   anything else — so an unexpected host degrades to "unoptimized", never a
   crash. **Keep `OPTIMIZED_HOSTS` and `remotePatterns` in sync** (drift is safe:
   in-JS-but-not-config → falls back; the reverse is fine too).
3. Always pass a real `sizes` — without it `next/image` requests a full-width
   variant and you lose the resize win.
4. Verify the exact optimizer path (no full page needed):
   ```bash
   curl -H "Accept: image/avif" -o /tmp/opt.bin -w "%{http_code} %{size_download} %{content_type}\n" \
     "http://localhost:3020/_next/image?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' 'https://host/img.jpg')&w=750&q=65"
   ```
   200 + `image/avif` + small size = win. 400 = host not allowlisted.

Own (GCS) images already go through `next/image` — that's why the app
**preconnects only to GTM**, not `storage.googleapis.com` (the browser never
opens a direct GCS connection; a preconnect there is wasted — Lighthouse flags
it). Keep `dns-prefetch` (near-free) for any direct fetch.

### 2. JavaScript — unused JS + legacy polyfills

- **Legacy polyfills (verify the SOURCE before "fixing"):** Lighthouse's
  "Legacy JavaScript" flags `Array.prototype.at/flat/flatMap`,
  `Object.fromEntries/hasOwn`, `String.trim{Start,End}`, etc. There are TWO
  sources and only one is fixable via config:
  - **App-code transpilation** → a modern root `browserslist` in `package.json`
    (e.g. Chrome 93 / Safari 15.4) makes Next's SWC stop injecting core-js. Worth
    doing IF you confirm it changes output.
  - **A dependency's own inline feature-detected polyfills** (pattern:
    `"trimStart" in String.prototype || (String.prototype.trimStart = …)`,
    `Object.hasOwn || (…)`) shipped pre-built in its dist. **browserslist /
    transpilation CANNOT strip these** — they're runtime guards, not
    down-levelable syntax. On Shorted (checked 2026-07) the flagged ~12KB is
    exactly this: a shared vendor chunk (`47023-…`, loaded by `/layout` + many
    routes) with the identical content hash regardless of browserslist. Removing
    it means identifying the dep (`ANALYZE=true npx next build` treemap) and
    finding its modern build or lazy-loading it — low priority for ~12KB.
  - **Lesson:** before claiming a browserslist change dropped polyfills, rebuild
    and diff the flagged chunk's hash. Identical hash = no effect (it's a dep).
- **Unused/heavy chunks:** `npm run bundle:budget` lists the heaviest chunks;
  `ANALYZE=true npx next build` (via `build:analyze`) opens the treemap. Fixes:
  - `dynamic(() => import(...), { ssr: false })` for anything below the fold or
    interaction-gated (charts already do this — see `dashboards.tsx`,
    `housing-charts.tsx`). Note: connect-rpc/visx charts **must** be `ssr:false`
    or they crash SSR (see project CLAUDE.md).
  - `experimental.optimizePackageImports` in `next.config.mjs` for
    barrel-heavy libs (lucide, radix icons, visx are already listed — add new ones).

### 3. Accessibility (feeds the a11y score AND "Agentic browsing")

- **Nameless links:** an `<a>` wrapping only an image/icon has no accessible
  name → "Links must have discernible text". Give it `aria-label` (mirror the
  adjacent heading) and keep the image `alt=""` decorative. See the image anchor
  in `news-card.tsx`.
- **Text contrast:** semi-transparent tint chips (`bg-*-500/10`) need dark text
  in light mode: use `text-*-700 dark:text-*-300` (a single `-300` fails WCAG AA
  on white). See `web/src/@/lib/stock-color.ts`.

### 4. Render-blocking + hints (smaller wins)

- Critical CSS is inlined in `layout.tsx`; keep non-critical CSS out of the head.
- `preconnect` only origins the page connects to **directly** on first paint,
  ≤4 total. Everything else → `dns-prefetch`.

## Verify like production

A perf fix isn't done until measured on the path prod uses:
- Confirm the **compiled output** contains the change (stale dev chunks lie —
  clean `.next` and rebuild if a change doesn't show).
- Confirm the LISTEN pid is the server you just started
  (`lsof -nP -iTCP:3020 -sTCP:LISTEN`) — a stale squatter serves old code.
- Prove image optimization via the `/_next/image` curl above; prove score/CWV
  deltas via `perf:lh` before vs after; prove bundle deltas via `bundle:budget`.
- Component-level a11y/visual changes → add/extend a Storybook story with a
  `play()` assertion (e.g. `news-card.stories.tsx` asserts no nameless links)
  and run `npm run test:storybook -- <file>`.

## Landmines

- **Dev ≠ prod Lighthouse** — only trust prod-build numbers.
- **`next/image` unlisted-host crash** — allowlist + `<NewsImage>` fallback.
- **Two `images` blocks in `next.config.mjs`** — the `export default` one wins
  (it replaces `remotePatterns`, doesn't merge). Edit that one.
- **`caniuse-lite` outdated** warning → `npx update-browserslist-db@latest` so
  browserslist resolves current versions.
- **Local `next build` prerender failures** against `api.shorted.com.au` are an
  env/TLS issue, not code — the bundle manifests are still written; CI builds cleanly.
