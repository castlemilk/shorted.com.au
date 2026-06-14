# Storybook visual-regression suite

Screenshots every Storybook story and compares it against a committed,
Linux-generated PNG baseline. This catches unintended visual changes to the
dashboard widgets, chrome, and UI primitives.

## How it works

- `playwright.visual.config.ts` serves the built `storybook-static/` over
  `http-server` on port 6007 and runs the spec in `tests/visual/`.
- `storybook-visual.spec.ts` reads `storybook-static/index.json` at collection
  time and creates one test per story (`type === "story"`) that is **not**
  tagged `no-visual`. Each test navigates to
  `/iframe.html?id=<id>&viewMode=story`, waits for render
  (`#storybook-root` non-empty, no error display, `document.fonts.ready`, a
  short settle), then asserts `toHaveScreenshot(<id>.png)`.
- Determinism: the config sets `animations: "disabled"`, `reducedMotion:
  "reduce"`, fixed viewport (1280×800), `deviceScaleFactor: 1`, and
  `colorScheme: "light"`. The spec also injects a stylesheet that hard-freezes
  all `animation`/`transition` and hides the text caret so `animate-pulse`
  skeletons and chart transitions don't flicker between runs.
- Tolerance: `maxDiffPixelRatio: 0.01`. Do not weaken this globally — tag a
  flaky story `no-visual` instead.

## Baselines are committed

Baselines live in `tests/visual/__screenshots__/` and **are committed to git**.
Everything else Playwright produces (`test-results/`, `playwright-report/`,
`blob-report/`) is gitignored.

## Baselines MUST be Linux-generated

macOS renders fonts with different anti-aliasing than CI (ubuntu), so baselines
generated locally on a Mac **will diff** on CI. Always (re)generate baselines
inside the official Playwright Linux docker image whose tag matches the
installed `@playwright/test` version. Find the version with:

```bash
node -e "console.log(require('@playwright/test/package.json').version)"
```

Then regenerate (run from `web/`):

```bash
docker run --rm -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v<VERSION>-jammy \
  bash -lc "npm ci && npm run test:visual:update"
```

This builds Storybook and writes one PNG per non-tagged story into
`tests/visual/__screenshots__/`.

To verify the suite is green against its own baselines, re-run **without**
`--update` in the same image:

```bash
docker run --rm -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v<VERSION>-jammy \
  bash -lc "npm ci && npm run test:visual"
```

## The `no-visual` tag convention

A story that renders non-deterministic output (e.g. a null/empty render with
nothing stable to snapshot, or time-dependent content) should opt out of the
snapshot suite by adding the tag in its story file:

```ts
export const Idle: Story = {
  tags: ["no-visual"],
  // ...
};
```

The spec filters these out at collection time, so no baseline is generated or
asserted for them.

## Updating baselines after an intentional UI change

1. Make your UI change.
2. Regenerate baselines in docker with the `:update` command above.
3. Review the changed PNGs (`git diff --stat` / open them) to confirm the diffs
   are exactly the intended change and nothing else regressed.
4. Commit the updated baselines alongside the code change.

## Running locally (macOS) for a quick look

You *can* run `npm run test:visual` on macOS, but expect font-AA diffs against
the Linux baselines. Use this only for a rough local sanity check; rely on
docker or CI for authoritative results.
