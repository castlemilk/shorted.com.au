# Dashboard Harness (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Storybook 9 component harness, interaction + visual regression test suites, and the perf benchmark script that gate all later dashboard improvements (spec: `docs/superpowers/specs/2026-06-12-dashboard-improvement-design.md`).

**Architecture:** Storybook 9 with `@storybook/nextjs-vite` runs the 11 dashboard widgets + chrome in isolation. Data modules (server actions + lib fetchers) are mocked with Storybook's module-mocking (`sb.mock`) backed by shared protobuf fixtures — no app-code refactor needed. Interaction tests run via the Vitest addon (browser mode, headless Chromium); visual regression is a Playwright spec screenshotting every story of the built Storybook against committed Linux-generated PNG baselines. A Playwright-driven benchmark script measures `/` and `/dashboards` on a production build and supports `--compare` for before/after gating.

**Tech Stack:** Storybook 9 (`@storybook/nextjs-vite`), `@storybook/addon-vitest`, Vitest 3 (browser mode + `@vitest/browser`, `playwright` provider), Playwright (already installed, 1.52), `@bufbuild/protobuf` `create()` for fixtures, GitHub Actions.

**Working branch:** `feat/dashboard-improvements` (already exists; spec committed).

**All paths relative to repo root** (`/Users/benebsworth/projects/shorted`). All npm commands run from `web/`.

---

## Context an engineer needs (read this first)

- **Two path aliases coexist**: `~/*` → `web/src/*` and `@/lib|components|types|config/*` → `web/src/@/...` (see `web/tsconfig.json:28-36`). Vite must resolve both — use `vite-tsconfig-paths` in the Storybook vite config.
- **Widget data flow**: widgets are `"use client"` components calling TanStack Query hooks in `web/src/@/hooks/use-stock-queries.ts`. Those hooks call functions from FOUR data modules (these are the ONLY modules that need mocking for widget stories):
  1. `web/src/app/actions/getTopShorts.ts` → `getTopShortsData(period, limit, offset)` returns `GetTopShortsResponse` (`{ timeSeries: TimeSeriesData[] }`)
  2. `web/src/app/actions/getStock.ts` → `getStock(code)`
  3. `web/src/@/lib/stock-data-service.ts` → `getMultipleStockQuotes`, `getHistoricalData`, `getStockPrice`
  4. `web/src/@/lib/client-api.ts` → `fetchStockDataClient`, `fetchStockDetailsClient`
  Plus widget-specific modules (treemap/news/screener) — each widget-story task names its module after checking that widget's imports.
- **SSR landmine does not apply here**: Storybook renders client-side only, but `getTopShorts.ts` imports `kv-cache`/`tracing` server modules — another reason module mocking (which replaces the whole module) is the right seam.
- **Protobuf types**: `TimeSeriesData` etc. are `@bufbuild/protobuf` v2 messages. Fixtures MUST be built with `create(TimeSeriesDataSchema, {...})` from `@bufbuild/protobuf` — plain object literals fail type checks.
- **`useWidgetVisibility`** (`web/src/@/hooks/use-widget-visibility.ts`) gates fetching on IntersectionObserver. Stories render in a real browser so it fires naturally; visual tests must wait for content, not assume sync render.
- **Pre-commit hook** runs lint + frontend build + unit + integration tests and currently fails on `test-integration-local` (status unknown whether pre-existing). Task 0 establishes this. The hook also mutates `web/package.json` (version bump) — `git restore web/package.json web/package-lock.json` after any hook run.
- **Widget story prop contract**: every widget takes `WidgetProps` (`web/src/@/types/dashboard.ts:157`): `{ config: WidgetConfig, sizeVariant?: "compact"|"standard"|"expanded" }`. `WidgetConfig` requires `id`, `type` (enum `WidgetType`), `title`, `dataSource: { endpoint: string }`, `layout: {x,y,w,h}`, `settings`.

---

### Task 0: Establish pre-commit hook baseline

**Files:** none (investigation only)

- [ ] **Step 1: Run the integration suite on the branch as-is**

Run: `cd /Users/benebsworth/projects/shorted/services && make test-integration-local 2>&1 | tail -30`

- [ ] **Step 2: Record the outcome**

If it FAILS with the same error seen on 2026-06-12 (exit 1 from `test-integration-local`), the failure is pre-existing and unrelated to this work: note the failing test name in the PR description, and for the remainder of this plan commit with `--no-verify` ONLY when the commit touches no Go/services code (all commits in this plan are `web/`-only or docs-only). If it PASSES, commit normally throughout and ignore the `--no-verify` instructions below.

- [ ] **Step 3: Clean up hook side effects**

Run: `git -C /Users/benebsworth/projects/shorted status --short` — if `web/package.json`/`web/package-lock.json` show modified (version bump side effect), run `git -C /Users/benebsworth/projects/shorted restore web/package.json web/package-lock.json`.

---

### Task 1: Install and boot Storybook 9 (nextjs-vite)

**Files:**
- Create: `web/.storybook/main.ts`
- Create: `web/.storybook/preview.tsx`
- Create: `web/src/@/components/ui/skeleton.stories.tsx` (smoke-test story)
- Modify: `web/package.json` (deps + scripts)
- Modify: `web/.gitignore` (add `storybook-static/`)

- [ ] **Step 1: Install Storybook with the nextjs-vite framework**

Run from `web/`:
```bash
npx storybook@latest init --builder vite --no-dev
```
If the init wizard picks `@storybook/nextjs` (webpack) instead of `@storybook/nextjs-vite`, install explicitly:
```bash
npm i -D storybook @storybook/nextjs-vite @storybook/addon-vitest vite vite-tsconfig-paths
```
Expected: `storybook`, `@storybook/nextjs-vite` in `devDependencies`; `.storybook/` directory created.

- [ ] **Step 2: Write `.storybook/main.ts`**

```ts
import type { StorybookConfig } from "@storybook/nextjs-vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config: StorybookConfig = {
  framework: "@storybook/nextjs-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-vitest"],
  staticDirs: ["../public"],
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tsconfigPaths()];
    return viteConfig;
  },
};
export default config;
```

- [ ] **Step 3: Write `.storybook/preview.tsx`**

```tsx
import type { Preview, Decorator } from "@storybook/nextjs-vite";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../src/@/components/providers";
import "../src/styles/globals.css";

// Fresh QueryClient per story: no retries (errors surface immediately),
// no GC churn, infinite staleTime (fixtures never refetch).
const withQueryClient: Decorator = (Story) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};

const withTheme: Decorator = (Story) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <Story />
  </ThemeProvider>
);

const preview: Preview = {
  decorators: [withQueryClient, withTheme],
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
  },
};
export default preview;
```
Note: check `web/src/@/components/providers.tsx` for `ThemeProvider`'s actual props (it wraps `next-themes`); match them. If it requires more context (session providers), prefer importing `next-themes`' `ThemeProvider` directly here instead — widgets only need the `class` attribute for Tailwind dark mode.

- [ ] **Step 4: Write the smoke-test story**

`web/src/@/components/ui/skeleton.stories.tsx`:
```tsx
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Skeleton } from "./skeleton";

const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Skeleton className="h-8 w-48" />,
};
```

- [ ] **Step 5: Boot Storybook and verify**

Run from `web/`: `npx storybook dev -p 6006 --no-open` in background, then verify the LISTEN pid is the storybook process (`lsof -nP -iTCP:6006 -sTCP:LISTEN`), then `curl -s http://localhost:6006/index.json | head -c 400`.
Expected: JSON containing `"ui-skeleton--default"`. Open `http://localhost:6006` if running interactively — Skeleton story renders with Tailwind styles (animated gray bar, not unstyled). Kill the dev server after.

- [ ] **Step 6: Add scripts and gitignore, commit**

In `web/package.json` scripts:
```json
"storybook": "storybook dev -p 6006",
"storybook:build": "storybook build"
```
Append `storybook-static/` to `web/.gitignore`.

```bash
git add web/.storybook web/src/@/components/ui/skeleton.stories.tsx web/package.json web/package-lock.json web/.gitignore
git commit --no-verify -m "feat(storybook): Storybook 9 nextjs-vite harness boots with smoke story"
```

---

### Task 2: Shared fixtures module

**Files:**
- Create: `web/src/@/mocks/fixtures/short-data.ts`
- Test: `web/src/@/mocks/fixtures/__tests__/short-data.test.ts`

Deterministic, realistic ASIC-style data. One canonical module reused by stories, interaction tests, and (later phases) jest tests. No `Date.now()` — fixed base date so visual snapshots are stable.

- [ ] **Step 1: Write the failing test**

`web/src/@/mocks/fixtures/__tests__/short-data.test.ts`:
```ts
import {
  topShortsFixture,
  topShortsResponseFixture,
  stockQuotesFixture,
  historicalDataFixture,
} from "../short-data";

describe("short-data fixtures", () => {
  it("provides 10 top-short series with descending short positions", () => {
    const series = topShortsFixture();
    expect(series).toHaveLength(10);
    expect(series[0]!.productCode).toBe("PLS");
    const positions = series.map((s) => s.latestShortPosition);
    expect([...positions].sort((a, b) => b - a)).toEqual(positions);
  });

  it("each series has 90 daily points with deterministic timestamps", () => {
    const series = topShortsFixture();
    for (const s of series) {
      expect(s.points).toHaveLength(90);
    }
    // Determinism: two calls produce identical data
    expect(topShortsFixture()).toEqual(series);
  });

  it("wraps series in a GetTopShortsResponse", () => {
    const resp = topShortsResponseFixture();
    expect(resp.timeSeries).toHaveLength(10);
  });

  it("provides quotes and historical prices for fixture codes", () => {
    const quotes = stockQuotesFixture(["PLS", "BHP"]);
    expect(quotes.get("PLS")?.price).toBeGreaterThan(0);
    const hist = historicalDataFixture("PLS", "3m");
    expect(hist.length).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `web/`: `npx jest src/@/mocks/fixtures --verbose`
Expected: FAIL — `Cannot find module '../short-data'`.

- [ ] **Step 3: Implement the fixtures**

`web/src/@/mocks/fixtures/short-data.ts`:
```ts
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  TimeSeriesDataSchema,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  GetTopShortsResponseSchema,
  type GetTopShortsResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import type { StockQuote, HistoricalDataPoint } from "@/lib/stock-data-service";

/** Fixed reference date so fixtures (and screenshots) never drift. */
export const FIXTURE_BASE_DATE = new Date("2026-06-01T00:00:00Z");

const STOCKS: Array<{ code: string; name: string; short: number; base: number }> = [
  { code: "PLS", name: "Pilbara Minerals Limited", short: 19.4, base: 3.2 },
  { code: "SYR", name: "Syrah Resources Limited", short: 15.1, base: 0.45 },
  { code: "IEL", name: "IDP Education Limited", short: 12.8, base: 14.6 },
  { code: "LTR", name: "Liontown Resources Limited", short: 11.2, base: 0.92 },
  { code: "FLT", name: "Flight Centre Travel Group", short: 9.7, base: 17.3 },
  { code: "CTT", name: "Cettire Limited", short: 8.9, base: 1.1 },
  { code: "BOE", name: "Boss Energy Limited", short: 8.2, base: 3.8 },
  { code: "DMP", name: "Domino's Pizza Enterprises", short: 7.6, base: 32.4 },
  { code: "MIN", name: "Mineral Resources Limited", short: 6.8, base: 52.1 },
  { code: "SLX", name: "Silex Systems Limited", short: 5.9, base: 4.7 },
];

/** Deterministic pseudo-random walk (mulberry32, seeded per code). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayOffset(days: number): Date {
  return new Date(FIXTURE_BASE_DATE.getTime() - days * 86_400_000);
}

export function topShortsFixture(): TimeSeriesData[] {
  return STOCKS.map((stock, i) => {
    const rand = seeded(i + 1);
    const points = Array.from({ length: 90 }, (_, p) => {
      const drift = (rand() - 0.5) * 0.4;
      return {
        timestamp: timestampFromDate(dayOffset(89 - p)),
        shortPosition: Math.max(0.5, stock.short - (89 - p) * 0.01 + drift),
      };
    });
    return create(TimeSeriesDataSchema, {
      productCode: stock.code,
      name: stock.name,
      latestShortPosition: stock.short,
      points,
    });
  });
}

export function topShortsResponseFixture(): GetTopShortsResponse {
  return create(GetTopShortsResponseSchema, { timeSeries: topShortsFixture() });
}

export function stockQuotesFixture(codes: string[]): Map<string, StockQuote> {
  const map = new Map<string, StockQuote>();
  for (const code of codes) {
    const stock = STOCKS.find((s) => s.code === code) ?? STOCKS[0]!;
    map.set(code, {
      symbol: code,
      price: stock.base,
      change: Number((stock.base * 0.012).toFixed(2)),
      changePercent: 1.2,
      previousClose: Number((stock.base * 0.988).toFixed(2)),
    } as StockQuote);
  }
  return map;
}

export function historicalDataFixture(code: string, _period: string): HistoricalDataPoint[] {
  const stock = STOCKS.find((s) => s.code === code) ?? STOCKS[0]!;
  const rand = seeded(stock.code.charCodeAt(0));
  return Array.from({ length: 65 }, (_, i) => ({
    date: dayOffset(64 - i).toISOString().slice(0, 10),
    close: Number((stock.base * (1 + (rand() - 0.5) * 0.1)).toFixed(2)),
    volume: Math.floor(rand() * 5_000_000),
  })) as HistoricalDataPoint[];
}
```
IMPORTANT: before writing, open `web/src/@/lib/stock-data-service.ts` and copy the REAL `StockQuote` and `HistoricalDataPoint` field names — the shapes above are indicative; the test compiles only if fields match. Also verify the exact schema export names in `web/src/gen/shorts/v1alpha1/shorts_pb.ts` (`GetTopShortsResponseSchema`) and the `points` field name on `TimeSeriesDataSchema` (check `web/src/gen/stocks/v1alpha1/stocks_pb.ts` around line 100).

- [ ] **Step 4: Run test to verify it passes**

Run from `web/`: `npx jest src/@/mocks/fixtures --verbose`
Expected: PASS (4 tests). Also `npx tsc --noEmit` passes.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/mocks/fixtures
git commit --no-verify -m "feat(storybook): deterministic protobuf fixtures for dashboard widgets"
```

---

### Task 3: Story helpers + module-mock wiring

**Files:**
- Create: `web/src/@/mocks/widget-story-helpers.tsx`
- Create: `web/src/@/mocks/STORY_GUIDE.md`
- Modify: `web/.storybook/preview.tsx` (register `sb.mock` calls)

- [ ] **Step 1: Write `widget-story-helpers.tsx`**

```tsx
import React from "react";
import type { Decorator } from "@storybook/nextjs-vite";
import {
  WidgetType,
  type WidgetConfig,
} from "@/types/dashboard";

/** Builds a valid WidgetConfig with sane defaults; override per story. */
export function makeWidgetConfig(
  type: WidgetType,
  settings: Record<string, unknown> = {},
  overrides: Partial<WidgetConfig> = {},
): WidgetConfig {
  return {
    id: `story-${type.toLowerCase()}`,
    type,
    title: type.replace(/_/g, " "),
    dataSource: { endpoint: "mock" },
    layout: { x: 0, y: 0, w: 8, h: 10 },
    settings,
    ...overrides,
  };
}

/**
 * Renders the story inside a fixed-size box matching a dashboard grid cell,
 * so widgets see realistic dimensions (they fill h-full containers).
 * Sizes mirror the grid snap sizes in dashboard-grid.tsx.
 */
export const GRID_SIZES = {
  small: { width: 360, height: 240 },
  medium: { width: 720, height: 420 },
  large: { width: 1080, height: 640 },
} as const;

export function withGridCell(size: keyof typeof GRID_SIZES = "medium"): Decorator {
  const { width, height } = GRID_SIZES[size];
  return (Story) => (
    <div style={{ width, height }} className="rounded-lg border bg-background p-2">
      <Story />
    </div>
  );
}

/** A promise that never settles — drives perpetual Loading states. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
```

- [ ] **Step 2: Register module mocks in `.storybook/preview.tsx`**

Add at the TOP of the file (before other imports), per Storybook 9 module-mocking docs:
```tsx
import { sb } from "storybook/test";

sb.mock(import("../src/app/actions/getTopShorts.ts"), { spy: true });
sb.mock(import("../src/app/actions/getStock.ts"), { spy: true });
sb.mock(import("../src/@/lib/stock-data-service.ts"), { spy: true });
sb.mock(import("../src/@/lib/client-api.ts"), { spy: true });
```
`{ spy: true }` keeps real exports wrapped in spies so stories override per-story via `mocked(fn).mockResolvedValue(...)` in `beforeEach`. NOTE: if `sb.mock` with `spy: true` still executes the original module's top-level imports and that drags in server-only code that breaks the vite build (kv-cache/tracing), switch those entries to full mocks: create `web/src/app/actions/__mocks__/getTopShorts.ts` exporting `getTopShortsData = fn()` (from `storybook/test`), and drop `{ spy: true }`. Verify by booting Storybook.

- [ ] **Step 3: Write `STORY_GUIDE.md`**

`web/src/@/mocks/STORY_GUIDE.md` — the contract every widget story file follows (used by Tasks 5, 6, 8):
```markdown
# Widget Story Guide

Every widget gets `<widget>.stories.tsx` next to its source with these stories:

| Story    | How |
|----------|-----|
| Default  | mock data fns -> mockResolvedValue(fixture); decorator withGridCell("medium") |
| Loading  | mock data fns -> mockReturnValue(never()) |
| Error    | mock data fns -> mockRejectedValue(new Error("Failed to fetch")) |
| Empty    | mock data fns -> mockResolvedValue(empty fixture: [] / empty response) |
| Compact  | Default mocks + sizeVariant="compact" + withGridCell("small") |
| Mobile   | Default mocks + parameters: { viewport: { defaultViewport: "mobile1" } } + withGridCell("small") |

Rules:
- Mock in `beforeEach` (story-level), import mocked fns via `import { mocked } from "storybook/test"`.
- Always reset: preview has `parameters.test.restoreMocks` default; do not rely on mock state across stories.
- One `play` function minimum per widget exercising its main interaction
  (sort a column, switch a period, open a tooltip).
- Data ALWAYS comes from `@/mocks/fixtures/short-data` — never inline literals,
  so visual baselines stay consistent when fixtures evolve.
- Story IDs feed the visual test: keep `title: "Widgets/<Name>"`.
```

- [ ] **Step 4: Verify Storybook still boots**

Run from `web/`: `npx storybook dev -p 6006 --no-open` (background) → `curl -s http://localhost:6006/index.json | grep -c stories` returns without error; no vite build errors in output. Kill server.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/mocks web/.storybook/preview.tsx
git commit --no-verify -m "feat(storybook): story helpers, module-mock wiring, story authoring guide"
```

---

### Task 4: Vitest addon wiring (interaction test runner)

**Files:**
- Create: `web/vitest.config.ts`
- Create: `web/.storybook/vitest.setup.ts`
- Modify: `web/package.json` (script `test:storybook`)

- [ ] **Step 1: Install vitest browser-mode deps**

Run from `web/`:
```bash
npm i -D vitest @vitest/browser playwright
```
(Playwright the library is already a dep via `@playwright/test` — keep versions aligned; if `@playwright/test@1.52` conflicts, pin `playwright@1.52.0`.)

- [ ] **Step 2: Write `web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import path from "node:path";

export default defineConfig({
  plugins: [
    storybookTest({ configDir: path.join(__dirname, ".storybook") }),
  ],
  test: {
    name: "storybook",
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: [".storybook/vitest.setup.ts"],
  },
});
```

- [ ] **Step 3: Write `web/.storybook/vitest.setup.ts`**

```ts
import { setProjectAnnotations } from "@storybook/nextjs-vite";
import * as previewAnnotations from "./preview";

const annotations = setProjectAnnotations([previewAnnotations]);
beforeAll(annotations.beforeAll);
```
(If `beforeAll` is not exported on the returned annotations in the installed version, follow the generated setup file `storybook init` produced — the addon scaffolds this file; prefer the scaffolded content.)

- [ ] **Step 4: Add script and run against the smoke story**

`web/package.json`: `"test:storybook": "vitest run --project=storybook"`

Run from `web/`: `npm run test:storybook`
Expected: PASS — the `UI/Skeleton` Default story renders as a smoke test (story files without play functions still get render-tested by the addon).

- [ ] **Step 5: Commit**

```bash
git add web/vitest.config.ts web/.storybook/vitest.setup.ts web/package.json web/package-lock.json
git commit --no-verify -m "feat(storybook): vitest addon interaction-test runner"
```

---

### Task 5: Exemplar widget story — TopShortsWidget (full pattern)

**Files:**
- Create: `web/src/@/components/widgets/top-shorts-widget.stories.tssx` → NOTE: extension is `.stories.tsx`
- Reference: `web/src/@/components/widgets/top-shorts-widget.tsx` (component), `web/src/@/hooks/use-stock-queries.ts:130` (`useTopShorts` → `getTopShortsData`)

- [ ] **Step 1: Write the story file**

`web/src/@/components/widgets/top-shorts-widget.stories.tsx`:
```tsx
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, mocked, waitFor, within } from "storybook/test";
import { TopShortsWidget } from "./top-shorts-widget";
import { WidgetType } from "@/types/dashboard";
import {
  makeWidgetConfig,
  withGridCell,
  never,
} from "../../mocks/widget-story-helpers";
import { topShortsResponseFixture } from "../../mocks/fixtures/short-data";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { create } from "@bufbuild/protobuf";
import { GetTopShortsResponseSchema } from "~/gen/shorts/v1alpha1/shorts_pb";

const meta = {
  title: "Widgets/TopShorts",
  component: TopShortsWidget,
  args: {
    config: makeWidgetConfig(WidgetType.TOP_SHORTS, { period: "3m", limit: 10 }),
    sizeVariant: "standard",
  },
  decorators: [withGridCell("medium")],
} satisfies Meta<typeof TopShortsWidget>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  beforeEach: () => {
    mocked(getTopShortsData).mockResolvedValue(topShortsResponseFixture());
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Data renders (PLS is rank 1 in the fixture)
    await waitFor(() => expect(canvas.getByText("PLS")).toBeInTheDocument());
    // Interaction: click the Short % column header to sort
    const header = canvas.getByText(/short/i, { selector: "th *, th" });
    header.click();
    await waitFor(() => expect(canvas.getByText("SLX")).toBeInTheDocument());
  },
};

export const Loading: Story = {
  beforeEach: () => {
    mocked(getTopShortsData).mockReturnValue(never());
  },
};

export const Error: Story = {
  beforeEach: () => {
    mocked(getTopShortsData).mockRejectedValue(new globalThis.Error("backend unavailable"));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText(/failed to load/i)).toBeInTheDocument(),
    );
  },
};

export const Empty: Story = {
  beforeEach: () => {
    mocked(getTopShortsData).mockResolvedValue(
      create(GetTopShortsResponseSchema, { timeSeries: [] }),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/no results/i)).toBeInTheDocument());
  },
};

export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getTopShortsData).mockResolvedValue(topShortsResponseFixture());
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [withGridCell("small")],
  beforeEach: () => {
    mocked(getTopShortsData).mockResolvedValue(topShortsResponseFixture());
  },
};
```
Adjustments expected while implementing: (a) the sort-interaction selector — open the rendered DOM in Storybook and use the real header text from `~/app/topShortsView/components/columns.tsx`; (b) the widget reads `percentageShorted`/`shortPercentageChange` fields cast onto `TimeSeriesData` (see `top-shorts-widget.tsx:87-89`) — if compact mode shows `0%`, extend the fixture objects with those two extra fields via `Object.assign`; (c) `useWidgetVisibility` requires the element to intersect — `withGridCell` renders in-viewport so it fires.

- [ ] **Step 2: Verify interactively**

Run from `web/`: `npx storybook dev -p 6006 --no-open` → check all six stories render correct states (table with 10 rows / skeletons / "Failed to load data" / "No results." / horizontal cards / mobile). Kill server.

- [ ] **Step 3: Run the interaction tests**

Run from `web/`: `npm run test:storybook -- top-shorts`
Expected: PASS — Default, Error, Empty play functions pass; Loading/Compact/Mobile pass as render smoke tests.

- [ ] **Step 4: Commit**

```bash
git add web/src/@/components/widgets/top-shorts-widget.stories.tsx
git commit --no-verify -m "feat(storybook): TopShorts widget stories — all six contract states"
```

---

### Task 6: Exemplar widget story — IndustryTreemapWidget (Visx path)

**Files:**
- Create: `web/src/@/components/widgets/industry-treemap-widget.stories.tsx`
- Reference: `web/src/@/components/widgets/industry-treemap-widget.tsx`
- Possibly create: fixture additions in `web/src/@/mocks/fixtures/short-data.ts`

- [ ] **Step 1: Identify the widget's data module**

Open `web/src/@/components/widgets/industry-treemap-widget.tsx` and find its data import (expected: `getIndustryTreeMapData` from `~/app/actions/getIndustryTreeMap` or `~/app/actions/client/getIndustryTreeMap` — check which). Add that module to the `sb.mock` list in `.storybook/preview.tsx` (same pattern as Task 3 Step 2).

- [ ] **Step 2: Add a treemap fixture**

In `web/src/@/mocks/fixtures/short-data.ts`, add `industryTreemapFixture()` returning the response type the widget consumes (check the gen type used by the action, e.g. `GetIndustryTreeMapResponse` from `~/gen/shorts/v1alpha1/shorts_pb.ts`, built with `create(...)`). Cover ≥4 industries × ≥3 stocks each using the `STOCKS` table plus an `industry` assignment map, so the treemap has visible hierarchy. Extend the Task 2 jest test with one assertion: fixture has ≥4 distinct industries. Run `npx jest src/@/mocks/fixtures` → PASS.

- [ ] **Step 3: Write the story file**

Same six-state structure as Task 5 (Default/Loading/Error/Empty/Compact/Mobile) with `WidgetType.INDUSTRY_TREEMAP`, settings `{ period: "3m", viewMode: "CURRENT_CHANGE", showSectorGrouping: true }`, and this play function on Default (tooltip interaction — the treemap's main behavior):
```tsx
play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Treemap rect for a fixture stock appears
  const cell = await waitFor(() => canvas.getByText("PLS"));
  // Hovering shows the tooltip with the company name
  await userEvent.hover(cell);
  await waitFor(() =>
    expect(canvas.getByText(/Pilbara Minerals/i)).toBeInTheDocument(),
  );
},
```
(`userEvent` imported from `storybook/test`.) The Visx treemap sizes from its container — `withGridCell` provides non-zero dimensions; if the chart renders 0×0, the widget likely uses `@visx/responsive` `ParentSize` which needs a resize tick: wrap assertions in `waitFor`.

- [ ] **Step 4: Verify and test**

`npx storybook dev` visual check (treemap renders colored rectangles, not blank) → `npm run test:storybook -- industry-treemap` → PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/components/widgets/industry-treemap-widget.stories.tsx web/src/@/mocks/fixtures web/.storybook/preview.tsx
git commit --no-verify -m "feat(storybook): IndustryTreemap widget stories with tooltip interaction test"
```

---

### Task 7: Remaining widget stories (9 widgets)

**Files (one story file per widget, same directory as each component):**
- Create: `web/src/@/components/widgets/stock-chart-widget.stories.tsx`
- Create: `web/src/@/components/widgets/market-watchlist-widget.stories.tsx`
- Create: `web/src/@/components/widgets/portfolio-summary-widget.stories.tsx`
- Create: `web/src/@/components/widgets/time-series-widget.stories.tsx`
- Create: `web/src/@/components/widgets/correlation-matrix-widget.stories.tsx`
- Create: `web/src/@/components/widgets/sector-performance-widget.stories.tsx`
- Create: `web/src/@/components/widgets/watchlist-widget.stories.tsx`
- Create: `web/src/@/components/widgets/news-feed-widget.stories.tsx`
- Create: `web/src/@/components/widgets/screener-widget.stories.tsx`
- Modify: `web/.storybook/preview.tsx` (add `sb.mock` entries for any new data modules)
- Modify: `web/src/@/mocks/fixtures/short-data.ts` (add fixtures as needed: news articles, screener rows, correlations, sector aggregates — each with a jest assertion added to the Task 2 test file)

Work through the widgets ONE AT A TIME; each follows the exact pattern established in Task 5 and codified in `web/src/@/mocks/STORY_GUIDE.md`. For each widget:

- [ ] **Step 1: Read the widget source; list its data imports** (hooks from `use-stock-queries.ts` resolve to the four modules already mocked in Task 3; anything else — e.g. news fetch, screener action — gets a new `sb.mock` entry and fixture).
- [ ] **Step 2: Add any missing fixture + one jest assertion; run `npx jest src/@/mocks/fixtures`** → PASS.
- [ ] **Step 3: Write the six contract stories** (Default/Loading/Error/Empty/Compact/Mobile) with settings matching the widget's settings type in `web/src/@/types/dashboard.ts:4-78` (e.g. StockChart: `{ stocks: ["PLS","BHP"], period: "3m", viewMode: "absolute", dataTypes: ["shorts","market"], indicators: [], stockShortsVisibility: {} }`; MarketWatchlist: `{ stocks: ["PLS","BHP","MIN"], timeInterval: "1m", refreshInterval: 0 }`; NewsFeed: `{ limit: 10, priceSensitiveOnly: false, refreshInterval: 0 }`; Screener: `{ limit: 20 }`; CorrelationMatrix: `{ stocks: ["PLS","BHP","MIN","SYR"], period: "3m" }`; SectorPerformance: `{ period: "1m", displayType: "bar" }`; TimeSeriesAnalysis: `{ stocks: ["PLS"], analysisType: "trend", period: "3m" }`; PortfolioSummary: `{ portfolio: [{ symbol: "PLS", shares: 100 }, { symbol: "BHP", shares: 50 }], refreshInterval: 0 }`; Watchlist: `{ watchlist: ["PLS","BHP"], timeInterval: "1m" }`).
- [ ] **Step 4: One play function on Default** exercising the widget's primary interaction (chart: period/series toggle; watchlist: row hover/click; news: article expand; screener: filter change — pick what the widget actually has).
- [ ] **Step 5: Verify in Storybook dev, run `npm run test:storybook -- <widget-name>`** → PASS.
- [ ] **Step 6: Commit per widget**: `git add <story + fixture + preview files> && git commit --no-verify -m "feat(storybook): <Widget> stories"`.

Note on `stock-chart-widget` (841 lines, heaviest): its Default story may surface animation flicker — if the chart animates on mount, add a `chartAnimationDisabled`-style prop only if one already exists; otherwise rely on the visual test's `animations: "disabled"` (Task 9) and `prefers-reduced-motion` emulation. Do NOT modify widget source in this phase.

---

### Task 8: Dashboard chrome stories

**Files:**
- Create: `web/src/@/components/dashboard/widget-wrapper.stories.tsx`
- Create: `web/src/@/components/dashboard/save-status-indicator.stories.tsx`
- Create: `web/src/@/components/ui/error-boundary.stories.tsx`

- [ ] **Step 1: WidgetWrapper stories**

`web/src/@/components/dashboard/widget-wrapper.stories.tsx` — states: `Default` (children content), `EditMode` (`isEditMode` + `onRemove`), `Loading` (`isLoading`), `ErrorState` (`error: new Error("boom")`), `Selected` (`isSelected`). Use `makeWidgetConfig(WidgetType.TOP_SHORTS)` for `config` and a simple `<div className="p-4">Widget content</div>` child. Play function on EditMode: open the settings dropdown, assert "Configure Widget" menu item appears.

- [ ] **Step 2: SaveStatusIndicator stories**

One story per `SaveStatus` value (`idle`, `pending`, `saving`, `saved`, `error`, `offline` — type at `web/src/@/types/dashboard.ts:183`). Check the component's props signature first (`web/src/@/components/dashboard/save-status-indicator.tsx`) and pass `lastSavedAt: new Date("2026-06-01T10:00:00Z")` (fixed — visual determinism; if the component renders relative time like "2 minutes ago" it will drift — in that case pass a `now`-adjacent fixed date AND mask this story's timestamp region in the visual test, or skip the `saved` story from visual snapshots via the `visual: false` tag convention defined in Task 9).

- [ ] **Step 3: ErrorBoundary stories**

`Default` (child throws a plain `Error` → fallback card with "Try again"), `RateLimited` (child throws an object shaped like a Connect rate-limit error: `{ code: 8, message: "resource exhausted", metadata: new Headers({ "retry-after": "30" }) }` — check `isRateLimitError` in `web/src/@/lib/retry.ts` for the exact duck-type it sniffs). Play function on Default: click "Try again", assert the boundary resets (render a stateful child that succeeds on second mount).

- [ ] **Step 4: Verify + test + commit**

`npm run test:storybook -- dashboard` and `-- error-boundary` → PASS.
```bash
git add web/src/@/components/dashboard/*.stories.tsx web/src/@/components/ui/error-boundary.stories.tsx
git commit --no-verify -m "feat(storybook): dashboard chrome stories (wrapper, save status, error boundary)"
```

---

### Task 9: Visual regression suite

**Files:**
- Create: `web/tests/visual/storybook-visual.spec.ts`
- Create: `web/playwright.visual.config.ts`
- Modify: `web/package.json` (scripts `test:visual`, `test:visual:update`)
- Create: `web/tests/visual/README.md`

- [ ] **Step 1: Write the Playwright config**

`web/playwright.visual.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      // Tolerate sub-pixel AA differences, fail on real changes
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    },
  },
  use: {
    baseURL: process.env.STORYBOOK_URL ?? "http://localhost:6007",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "npx http-server storybook-static --port 6007 --silent",
    url: "http://localhost:6007/index.json",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
```
Install the static server: `npm i -D http-server`.

- [ ] **Step 2: Write the visual spec**

`web/tests/visual/storybook-visual.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

type IndexEntry = {
  id: string;
  title: string;
  name: string;
  type: "story" | "docs";
  tags?: string[];
};

// Read the build manifest synchronously at collection time so each story
// becomes its own test (parallelizable, individually reportable).
const indexPath = path.join(__dirname, "../../storybook-static/index.json");
const entries: IndexEntry[] = Object.values(
  (JSON.parse(fs.readFileSync(indexPath, "utf8")) as { entries: Record<string, IndexEntry> })
    .entries,
).filter(
  (e) => e.type === "story" && !(e.tags ?? []).includes("no-visual"),
);

for (const entry of entries) {
  test(`${entry.title} — ${entry.name}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${entry.id}&viewMode=story`);
    // Wait for storybook to finish rendering (root populated, no error screen)
    const root = page.locator("#storybook-root");
    await expect(root).not.toBeEmpty({ timeout: 15_000 });
    await expect(page.locator(".sb-show-errordisplay")).toHaveCount(0);
    // Let fonts/charts settle
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot(`${entry.id}.png`, { fullPage: false });
  });
}
```
Opt-out convention: stories that cannot be deterministic (e.g. relative timestamps) set `tags: ["no-visual"]` in their story definition.

- [ ] **Step 3: Add scripts**

`web/package.json`:
```json
"test:visual": "npm run storybook:build && playwright test -c playwright.visual.config.ts",
"test:visual:update": "npm run storybook:build && playwright test -c playwright.visual.config.ts --update-snapshots"
```

- [ ] **Step 4: Generate Linux baselines via Docker (determinism)**

Baselines MUST be Linux-rendered (CI is ubuntu). From `web/`:
```bash
docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.52.0-jammy \
  bash -c "npm ci && npm run test:visual:update"
```
(Match the image tag to the installed `@playwright/test` version.) Expected: `web/tests/visual/__screenshots__/**/*.png` created — one per story (~70+ files). Spot-check a handful of PNGs render real content (not blank/error frames).

- [ ] **Step 5: Verify the suite passes against the baselines**

Same docker command without `--update-snapshots` flag (`npm run test:visual`).
Expected: all tests PASS.

- [ ] **Step 6: Write `web/tests/visual/README.md`**

Document: what the suite does, the docker command for regenerating baselines, the `no-visual` tag convention, and that macOS-local runs will diff (fonts) — use docker or rely on CI.

- [ ] **Step 7: Commit (baselines included)**

```bash
git add web/tests/visual web/playwright.visual.config.ts web/package.json web/package-lock.json
git commit --no-verify -m "feat(storybook): visual regression suite with Linux PNG baselines"
```

---

### Task 10: Perf benchmark script

**Files:**
- Create: `web/scripts/perf-benchmark.mjs`
- Create: `docs/perf/README.md`
- Modify: `web/package.json` (scripts `perf:bench`, `perf:compare`)
- Modify: `web/.gitignore` (add `perf-results/`)

- [ ] **Step 1: Write the benchmark script**

`web/scripts/perf-benchmark.mjs`:
```js
#!/usr/bin/env node
/**
 * Dashboard perf benchmark. Measures / and /dashboards on a running
 * production server (default http://localhost:3020).
 *
 * Usage:
 *   node scripts/perf-benchmark.mjs                          # 5 runs/page -> perf-results/<ts>.json
 *   node scripts/perf-benchmark.mjs --runs 9
 *   node scripts/perf-benchmark.mjs --compare docs/perf/baseline-2026-06.json
 *   node scripts/perf-benchmark.mjs --out docs/perf/baseline-2026-06.json
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE_URL = flag("url", "http://localhost:3020");
const RUNS = Number(flag("runs", "5"));
const COMPARE = flag("compare", null);
const OUT = flag("out", null);
const PAGES = ["/", "/dashboards"];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p75 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.75)];

async function measurePage(browser, pagePath) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE_URL + pagePath, { waitUntil: "load", timeout: 60_000 });
  // Allow LCP/CLS to settle and client hydration to finish
  await page.waitForTimeout(4_000);
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
    const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : null;
    let cls = 0;
    for (const e of performance.getEntriesByType("layout-shift")) {
      if (!e.hadRecentInput) cls += e.value;
    }
    const fcp = performance
      .getEntriesByType("paint")
      .find((e) => e.name === "first-contentful-paint")?.startTime ?? null;
    const widgetMarks = performance
      .getEntriesByType("mark")
      .filter((m) => m.name.startsWith("widget:"))
      .map((m) => ({ name: m.name, time: m.startTime }));
    return {
      ttfb: nav ? nav.responseStart : null,
      fcp,
      lcp,
      cls: Number(cls.toFixed(4)),
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      load: nav ? nav.loadEventEnd : null,
      transferKB: nav ? Math.round(nav.transferSize / 1024) : null,
      requestCount: performance.getEntriesByType("resource").length + 1,
      widgetMarks,
    };
  });
  await ctx.close();
  return metrics;
}

async function main() {
  // LCP/layout-shift need PerformanceObserver buffering — inject before nav
  const browser = await chromium.launch();
  const results = {};
  for (const pagePath of PAGES) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(await measurePage(browser, pagePath));
      process.stderr.write(`${pagePath} run ${i + 1}/${RUNS} done\n`);
    }
    const agg = {};
    for (const key of ["ttfb", "fcp", "lcp", "cls", "domContentLoaded", "load", "transferKB", "requestCount"]) {
      const vals = runs.map((r) => r[key]).filter((v) => v != null);
      agg[key] = vals.length ? { median: median(vals), p75: p75(vals) } : null;
    }
    results[pagePath] = { runs: RUNS, metrics: agg, sampleWidgetMarks: runs[0].widgetMarks };
  }
  await browser.close();

  const report = {
    url: BASE_URL,
    capturedAt: new Date().toISOString(),
    gitRef: process.env.GIT_REF ?? null,
    pages: results,
  };

  const outPath =
    OUT ?? path.join("perf-results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`written: ${outPath}`);

  if (COMPARE) {
    const base = JSON.parse(fs.readFileSync(COMPARE, "utf8"));
    console.log(`\nComparison vs ${COMPARE} (median):`);
    console.log("page | metric | baseline | current | delta");
    console.log("---- | ------ | -------- | ------- | -----");
    for (const [pagePath, data] of Object.entries(report.pages)) {
      const baseMetrics = base.pages?.[pagePath]?.metrics ?? {};
      for (const [metric, cur] of Object.entries(data.metrics)) {
        const b = baseMetrics[metric]?.median;
        if (b == null || cur == null) continue;
        const delta = cur.median - b;
        const pct = b !== 0 ? ((delta / b) * 100).toFixed(1) : "n/a";
        const marker = metric !== "cls" && delta > b * 0.1 ? " ⚠️ REGRESSION" : "";
        console.log(`${pagePath} | ${metric} | ${b} | ${cur.median} | ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} (${pct}%)${marker}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```
Known limitation to fix during implementation: `largest-contentful-paint` and `layout-shift` entries are only buffered if observed — if `page.evaluate` returns `lcp: null`, add a `page.addInitScript` that installs `new PerformanceObserver(...).observe({ type: "largest-contentful-paint", buffered: true })` (and same for `layout-shift`) stashing values on `window.__perf`, and read from there instead.

- [ ] **Step 2: Add scripts + gitignore**

`web/package.json`:
```json
"perf:bench": "node scripts/perf-benchmark.mjs",
"perf:compare": "node scripts/perf-benchmark.mjs --compare docs/perf/baseline-2026-06.json"
```
(Note: `docs/perf/` lives at repo root — the script runs from `web/`, so the compare path is `../docs/perf/baseline-2026-06.json`; set the script accordingly after checking where you run it from. Keep paths consistent.)
Append `perf-results/` to `web/.gitignore`.

- [ ] **Step 3: Verify against a production build**

From `web/`:
```bash
npm run build && npm run start &   # serves on the project's configured port — verify with lsof which port (expect 3020)
node scripts/perf-benchmark.mjs --runs 3 --url http://localhost:3020
```
Expected: JSON written; numbers non-null for ttfb/fcp/domContentLoaded/load on both pages; `lcp` non-null (after the addInitScript fix if needed). NOTE: `/dashboards` may redirect to login if auth-gated — check; if so, benchmark `/dashboards` unauthenticated as rendered (the redirect target IS the real first-paint experience) and note it in docs/perf/README.md, OR add a `--page` flag and measure `/` + `/shorts` instead. Decide based on what the page actually does; document the choice.

- [ ] **Step 4: Capture and commit the baseline**

```bash
GIT_REF=$(git rev-parse --short HEAD) node scripts/perf-benchmark.mjs --runs 5 --out ../docs/perf/baseline-2026-06.json
```
Write `docs/perf/README.md`: what the benchmark measures, how to run it (build first, server up, machine quiet), comparison usage, and the rule from the spec — each phase ends with a `--compare` run recorded in `docs/perf/PHASE-N.md`.

```bash
git add web/scripts/perf-benchmark.mjs web/package.json web/.gitignore docs/perf
git commit --no-verify -m "feat(perf): playwright benchmark script + phase-1 baseline"
```

---

### Task 11: CI workflow

**Files:**
- Create: `.github/workflows/storybook-tests.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Storybook Tests

on:
  pull_request:
    paths:
      - "web/**"
      - ".github/workflows/storybook-tests.yml"

concurrency:
  group: storybook-${{ github.ref }}
  cancel-in-progress: true

jobs:
  storybook:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: web/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Interaction tests (vitest)
        run: npm run test:storybook

      - name: Visual regression
        run: npm run test:visual

      - name: Upload visual diffs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-diffs
          path: |
            web/test-results/
            web/playwright-report/
          retention-days: 7
```
Check existing workflows in `.github/workflows/` for the Node version convention used by other web jobs and match it (the repo may use a different version or a setup action wrapper).

- [ ] **Step 2: Commit and push; verify on a PR**

```bash
git add .github/workflows/storybook-tests.yml
git commit --no-verify -m "ci: storybook interaction + visual regression workflow"
git push -u origin feat/dashboard-improvements
gh pr create --title "Dashboard harness (phase 1): Storybook, interaction + visual tests, perf benchmark" --body "Implements phase 1 of docs/superpowers/specs/2026-06-12-dashboard-improvement-design.md. See docs/superpowers/plans/2026-06-12-dashboard-harness-phase1.md."
```
Watch the `Storybook Tests` job: `gh pr checks --watch`. Expected: green. If visual tests fail on CI with small diffs (font rendering vs the docker image), regenerate baselines using the EXACT CI image version per Task 9 Step 4 and push again.

---

### Task 12: Phase-1 wrap-up record

**Files:**
- Create: `docs/perf/PHASE-1.md`
- Modify: `docs/superpowers/specs/2026-06-12-dashboard-improvement-design.md` (mark phase 1 done)

- [ ] **Step 1: Write `docs/perf/PHASE-1.md`**

Record: story count (`curl -s localhost:6006/index.json | jq '.entries | length'` from a dev run or count from `storybook-static/index.json`), interaction test count, visual baseline count, baseline benchmark medians for `/` and `/dashboards` (from `docs/perf/baseline-2026-06.json`), and the list of deferred items discovered while writing stories (these seed phase 2/3 work — e.g. widgets with ad-hoc fetching found in Task 7, missing empty states, CLS-y skeletons).

- [ ] **Step 2: Commit**

```bash
git add docs/perf/PHASE-1.md docs/superpowers/specs/2026-06-12-dashboard-improvement-design.md
git commit --no-verify -m "docs: phase 1 harness results and baseline record"
git push
```

---

## Later phases (outline only — each gets its own plan after phase 1 merges)

**Phase 2 — Performance & caching** (plan: `2026-XX-XX-dashboard-perf-phase2.md`): per-key staleTime tuning (hours for daily-cadence shorts/treemap keys, 30s quotes stay), gcTime 30min, migrate ad-hoc-fetching widgets (list produced by Task 7) onto `use-stock-queries.ts` hooks, `@tanstack/react-query-persist-client` + localStorage for daily keys, hover prefetch (stock details, /dashboards nav), dynamic-import stock-chart/Visx, `ANALYZE=true` before/after. Gate: `perf:compare` vs `docs/perf/baseline-2026-06.json` + visual suite green.

**Phase 3 — Reliability** (plan: `2026-XX-XX-dashboard-reliability-phase3.md`): widget-wrapper standardization (ErrorBoundary + `QueryErrorResetBoundary` + layout-matched skeletons), `useStaleWhileError` stale-data degradation with "data may be stale" indicator, layout-save retry/backoff + version-stamp conflict guard + `beforeunload` dirty check. Every new state gets a story + baseline. Gate: interaction tests for failure fixtures + visual suite.

**Phase 4 — Responsiveness & features** (plan: `2026-XX-XX-dashboard-responsive-phase4.md`): react-grid-layout `sm`/`xs` breakpoints (2/1 col, touch drag disabled), compact-mode audit via the Mobile stories from this phase, per-widget refresh + `dataUpdatedAt` timestamp, keyboard-accessible grid. Gate: Mobile visual baselines + benchmark on mobile viewport.

---

## Self-review notes (completed)

- **Spec coverage**: Storybook stack ✅ (T1), mocking ✅ (T3 — amended from transport injection to module mocking; spec updated), fixtures ✅ (T2), 11 widgets ✅ (T5–T7), chrome ✅ (T8), interaction tests ✅ (T4–T8), visual regression w/ Linux baselines ✅ (T9), perf benchmark + committed baseline ✅ (T10), CI ✅ (T11), results recording ✅ (T12). Phases 2–4 deliberately deferred to their own plans (scope rule).
- **Known uncertainty flagged inline** (not placeholders — verification steps): exact `StockQuote`/`HistoricalDataPoint` shapes (T2), `sb.mock` spy-vs-full behavior with server-only imports (T3), treemap data module path (T6), `/dashboards` auth gating for the benchmark (T10). Each has a decision rule, not a TODO.
- **Type consistency**: `makeWidgetConfig`/`withGridCell`/`never` used identically in T5/T6/T7/T8; fixture function names consistent between T2 test and T5/T6 usage.
