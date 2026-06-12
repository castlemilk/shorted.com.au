# Widget Story Authoring Guide

Contract for all dashboard widget stories (Tasks 5-8). Everything in this
guide was validated against the running Storybook 9.1.20 (`@storybook/nextjs-vite`)
build — it is descriptive, not aspirational.

## The six required stories per widget

Every widget gets a `*.stories.tsx` with at least these stories:

| Story     | How                                                                                       |
| --------- | ----------------------------------------------------------------------------------------- |
| `Default` | `mocked(fn).mockResolvedValue(<fixture>)` in `beforeEach`                                  |
| `Loading` | `mocked(fn).mockReturnValue(never())` — `never()` from `widget-story-helpers`. Uses `animate-pulse` CSS animation; the visual suite (Task 9) disables CSS animations, so Loading stories do NOT need `no-visual` tags. |
| `Error`   | `mocked(fn).mockRejectedValue(new globalThis.Error("..."))` — use `globalThis.Error`, not bare `Error`; `export const Error` shadows the global, so bare `new Error()` inside that export crashes with "Error is not a constructor". |
| `Empty`   | resolve with the empty-shaped fixture (e.g. response with `timeSeries: []`)                |
| `Compact` | `args: { sizeVariant: "compact" }` (top-level `WidgetProps` arg, not a widget setting) + `decorators: [withGridCell("small")]` |
| `Mobile`  | `parameters: { viewport: { defaultViewport: "mobile1" } }` + `withGridCell("small")` — viewport parameter only affects the Storybook manager UI, NOT vitest browser mode; pair with `withGridCell("small")` so the story renders at mobile dimensions in all contexts. |

Plus **at least one `play` function** per widget exercising its primary
interaction (row click, period toggle, etc.) using `within(canvasElement)` /
`userEvent` / `expect` from `storybook/test`.

## Naming and tags

- `title: "Widgets/<Name>"` (e.g. `"Widgets/TopShorts"`).
- `tags: ["no-visual"]` on any story that is **not** deterministic
  pixel-for-pixel (animations, live timers). The visual regression suite
  (Task 9) excludes stories with this tag. Fixture-driven stories are
  deterministic by construction and must NOT carry it.

## Mocking — the validated pattern

Mock registration lives at the **top of `web/.storybook/preview.tsx`** via
`sb.mock()` from `storybook/test`. Stories never register mocks; they only
set per-story behavior in `beforeEach` with `mocked()`:

```tsx
import { mocked } from "storybook/test";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { topShortsResponseFixture } from "~/@/mocks/fixtures/short-data";

export const Default: Story = {
  beforeEach: () => {
    mocked(getTopShortsData).mockResolvedValue(topShortsResponseFixture());
  },
};
```

Notes:

- `beforeEach` runs in the preview runtime for every story render (verified
  in plain `storybook dev`, no test addon needed). Spies are reset between
  stories by Storybook automatically.
- **Fixtures only.** All mock data comes from `~/@/mocks/fixtures/short-data`
  (`topShortsFixture`, `topShortsResponseFixture`, `stockQuotesFixture`,
  `historicalDataFixture`). Never inline data literals in stories — fixtures
  are seeded/deterministic; inline literals rot and break visual snapshots.
- **Import-alias cheat-sheet:**
  - `~/app/actions/...` — server actions under `src/app/actions/`
  - `~/@/...` — everything under `src/@/` (mocks, lib, components, types)
  - There is **no** `@/mocks/*` alias in `tsconfig.json`; always use `~/@/mocks/...`

### Throwing defaults — what they mean

`preview.tsx` installs a throwing default for every spy-wrapped export (see
`beforeEach` in `.storybook/preview.tsx`). If a story renders a component that
calls a mocked function without first setting up a return value, the story will
error with:

```
Error: Unmocked call to getStockPrice() — add mocked(getStockPrice).mockResolvedValue(...) in your story's beforeEach
```

This is intentional: it surfaces forgotten mocks immediately as a visible
failure rather than a silent network request or an undefined return that
produces a subtly broken render. **Fix it by adding a `beforeEach` block to
your story that calls `mocked(fn).mockResolvedValue(...)` for every function
the component under test exercises.**

## Registered modules (and their mode)

| Module                          | Mode                  | Mocked exports usable in stories                              |
| ------------------------------- | --------------------- | ------------------------------------------------------------- |
| `~/app/actions/getTopShorts`    | **full** (`__mocks__`) | `getTopShortsData`                                            |
| `~/app/actions/getStock`        | spy                   | `getStock`, `getStockOrNotFound`                              |
| `~/@/lib/stock-data-service`    | spy                   | `getMultipleStockQuotes`, `getHistoricalData`, `getStockPrice`, plus all other exported fns |
| `~/@/lib/client-api`            | spy                   | `fetchStockDataClient`, `fetchStockDetailsClient`              |

### Spy vs full mock — the decision rule

- **Spy** (`sb.mock(import("..."), { spy: true })`): exports keep their real
  implementations wrapped in spies; the **real module still evaluates** in the
  browser. Use for browser-safe modules. Stories MUST still override every
  function the widget calls (`mockResolvedValue` / `mockReturnValue`) or the
  real implementation will fire network requests.
- **Full mock** (no `{ spy: true }` + a `__mocks__/<name>.ts` file next to
  the real module): the original module is **never evaluated**. Required when
  the module (transitively) imports Node-only code. `getTopShorts` is full
  because it imports `kv-cache` → `ioredis` (Node `net`/`tls`), which crashes
  Vite's browser build with
  `TypeError: Cannot read properties of undefined (reading 'charCodeAt')`
  inside `redis-errors` (observed, not hypothetical). The mock file is
  `web/src/app/actions/__mocks__/getTopShorts.ts`, exporting
  `export const getTopShortsData = fn<...>();` with `fn` from `storybook/test`.
- React's server `cache()` wrapper (used by `getStock`) is fine under spy —
  `@storybook/nextjs-vite` resolves Next's React build, verified working.

### Adding a new mocked module

1. Add at the top of `web/.storybook/preview.tsx` (must be the preview file —
   Storybook's Vite plugin statically rewrites these calls; the
   `import("...")` path is relative to `.storybook/`, no extension):

   ```tsx
   sb.mock(import("../src/@/lib/my-module"), { spy: true });
   ```

2. If Storybook's iframe then errors at module load (check the browser
   console for Node-builtin imports), drop `{ spy: true }` and create
   `__mocks__/my-module.ts` next to the real module exporting same-named
   `fn()` stubs. Use `import type` only in the mock file so nothing real
   evaluates.
3. Restart `storybook dev` — mock registration changes are not always picked
   up by HMR.

## Layout helpers

From `~/@/mocks/widget-story-helpers`:

- `makeWidgetConfig(type, settings?, overrides?)` — valid `WidgetConfig`
  with sane defaults for the `config` prop.
- `withGridCell(size)` — decorator wrapping the story in a fixed-size grid
  cell (`small` 360x240, `medium` 720x420, `large` 1080x640). Widgets fill
  `h-full` containers, so always use it; default to `medium`.
- `never<T>()` — promise that never settles, for `Loading` stories.

## Provider context

`preview.tsx` already wraps every story in a fresh `QueryClient`
(retry off, `staleTime: Infinity`) and `ThemeProvider` (light). Do not add
your own QueryClientProvider in stories.

## Hard-won learnings from the exemplar (TopShorts widget)

These were discovered while building the first widget story and apply to every
subsequent widget. Fix them upfront rather than debugging them story-by-story.

### 1 — next/navigation requirement

Widgets that call `useRouter`, `usePathname`, or `useSearchParams` will crash
Storybook with:

```
Error: invariant expected app router to be mounted
```

Fix: add `parameters: { nextjs: { appDirectory: true } }` to the story meta
(or the individual story). One-liner on the meta object:

```ts
export default {
  title: "Widgets/MyWidget",
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof MyWidget>;
```

### 2 — Error story: shadow the global constructor

`export const Error = { ... }` shadows the global `Error` constructor inside
that export's scope. Writing `new Error("msg")` inside it throws
`"Error is not a constructor"`. Always use `new globalThis.Error("msg")`.
See the `Error` row of the six-state table above.

### 3 — Compact is an arg, not a widget setting

`sizeVariant: "compact"` is a top-level prop on `WidgetProps`, not part of the
`settings` object passed to `makeWidgetConfig`. Set it in `args`:

```ts
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  // ...
};
```

Do NOT put it inside `args.config.settings` — the widget will not pick it up.

### 4 — Viewport parameter caveat

`parameters.viewport.defaultViewport` only affects the Storybook manager UI
chrome; it does NOT resize the iframe in vitest browser mode or direct iframe
loads. Mobile stories MUST pair it with `withGridCell("small")` to render at
mobile dimensions in all contexts. Do not write `play` assertions that depend
on viewport width.

### 5 — Visibility gating (IntersectionObserver)

Widgets using `useWidgetVisibility` only start fetching data once the component
enters the viewport (IntersectionObserver). `withGridCell` renders the story
in-viewport with explicit pixel dimensions, which makes the IO fire and the
fetch start. This is the primary reason `withGridCell` is mandatory for all
widget stories.

If a story is stuck showing skeleton UI indefinitely:
1. Check that `withGridCell` is in `decorators`.
2. Check the browser console for "Unmocked call to ..." — the IO fired but the
   mock returned undefined.
3. Check for missing `beforeEach` setup.
