# Dashboard Performance Benchmarks

Playwright-driven performance benchmark for the Shorted dashboard surfaces. Used
by the dashboard-harness plan to prove improvements across phases with a
committed baseline + `--compare`.

Script: [`web/scripts/perf-benchmark.mjs`](../../web/scripts/perf-benchmark.mjs)
Baseline: [`baseline-2026-06.json`](./baseline-2026-06.json)

## What it measures

For each page in `["/", "/dashboards"]`, it runs N fresh browser contexts
(1280×800, Chromium) and collects per run:

| Metric             | Source                                                        |
| ------------------ | ------------------------------------------------------------ |
| `ttfb`             | `PerformanceNavigationTiming.responseStart`                  |
| `fcp`              | `paint` entry `first-contentful-paint`                       |
| `lcp`              | `PerformanceObserver("largest-contentful-paint", buffered)` |
| `cls`              | cumulative `PerformanceObserver("layout-shift", buffered)`  |
| `domContentLoaded` | `domContentLoadedEventEnd`                                    |
| `load`             | `loadEventEnd`                                                |
| `transferKB`       | navigation + all resource `transferSize`                     |
| `requestCount`     | network responses observed (floored by resource entries)     |
| `sampleWidgetMarks`| `performance` marks named `widget:*` (latest run)            |

> **LCP / CLS observer fix (required):** `getEntriesByType("largest-contentful-paint")`
> returns `[]` without an active observer — LCP and layout-shift are buffered-only.
> The script installs both observers via `page.addInitScript(...)` **before**
> `goto`, stashing `window.__perf = { lcp, cls }`, then reads them in the
> evaluate. Verified empirically: with the observer, LCP is non-null on every
> run; the homepage baseline LCP median is ~84ms.

Each metric is aggregated to **median** and **p75** across runs.

### `widget:*` marks

The harness will emit `performance.mark("widget:<id>:ready")` style marks as
later phases land per-widget data-ready instrumentation. None exist yet, so
`sampleWidgetMarks` is currently `[]` — the collector is in place and will pick
them up automatically once widgets start marking.

## `/dashboards` is auth-gated (decision)

`/dashboards` is a client component that checks `useSession()` and, for
**unauthenticated** requests, redirects to `/signin?callbackUrl=%2Fdashboards`.
That signin redirect **is** the real unauthenticated first-paint, so the
benchmark measures it and records `redirected: true` + the `finalUrl` in the
report. We keep `/dashboards` as the target (per the harness spec: "benchmark
whatever renders and document it") rather than swapping in `/shorts`.

If a future phase wants to benchmark the *authenticated* dashboard, it must forge
a session (see `CLAUDE.md` browser-automation notes) before `goto`. `/shorts`
remains a good alternative second content page if richer above-the-fold content
is wanted — add it to `PAGES` in the script.

## How to run

Benchmarks must run against a **production build**, on a **quiet machine** (close
other apps; results are sensitive to CPU contention).

```bash
cd web

# 1. Build (production). If the build aborts on pre-existing lint/type errors in
#    uncommitted storybook/visual files, build with checks skipped:
#       npx next build --no-lint
#    (and, if a stale playwright.visual.config.ts / storybook-static/ is present,
#     temporarily exclude them in tsconfig.json — these are pre-existing local
#     env issues, not app code). A clean tree builds with `npm run build`.

# 2. Serve the build (background) and confirm the listener is yours:
npx next start -p 3020 &
lsof -nP -iTCP:3020 -sTCP:LISTEN   # verify the LISTEN pid is the process you started

# 3. Run the benchmark
npm run perf:bench -- --runs 5 --url http://localhost:3020

# 4. Stop the server (use the pid from step 2)
```

### Flags

| Flag                | Default                  | Purpose                                       |
| ------------------- | ------------------------ | --------------------------------------------- |
| `--url <base>`      | `http://localhost:3020`  | Base URL to benchmark                         |
| `--runs <n>`        | `5`                      | Runs per page                                 |
| `--out <path>`      | `perf-results/<ts>.json` | Report output path (gitignored by default)    |
| `--compare <path>`  | —                        | Baseline JSON to diff the current run against |

`GIT_REF` env is recorded in the report (`gitRef`) — set it when capturing a
baseline: `GIT_REF=$(git rev-parse --short HEAD) npm run perf:bench -- ...`.

> Paths are relative to `web/` (the script runs from there). The committed
> baseline lives one level up at `../docs/perf/baseline-2026-06.json`, which is
> why `perf:compare` uses that path.

## Comparing against the baseline (the gate)

```bash
cd web
# serve a fresh production build first (steps 1-2 above), then:
npm run perf:compare              # diffs current run vs ../docs/perf/baseline-2026-06.json
```

`--compare` prints a per-page, per-metric table: `baseline median | current
median | delta | pct`, and flags `⚠️ REGRESSION` when a non-CLS lower-is-better
metric worsens by **>10%**. The process exits non-zero if any regression is
flagged.

### Phase gate rule

Each phase of the dashboard-harness plan **ends with a `perf:compare` run
recorded in `docs/perf/PHASE-N.md`** (paste the comparison table + the git ref
of the build). A phase must not regress a non-CLS metric by >10% vs the prior
phase's baseline without an explicit, documented justification. When a phase
intentionally moves the baseline (e.g. a redesign), regenerate
`baseline-2026-06.json` against the new production build and note it.

## Baseline provenance

`baseline-2026-06.json` was captured with `--runs 5` against a local production
build (`npx next start -p 3020`), git ref `0a11bb02`,
branch `feat/dashboard-improvements`. Homepage `/` rendered fully; `/dashboards`
redirected to `/signin` (unauthenticated). Re-capture against a clean production
build whenever the baseline is intentionally moved.
