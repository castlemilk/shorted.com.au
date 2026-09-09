# design-sync notes — shorted.com.au

Target project: `019deca6-dc8b-799d-8540-48cd1618f35d` ("Design System").
Shape: **package** (pinned in config). Auto-detect says `storybook` — see below for
why that is deliberately overridden.

## The big one: web/ is a Next.js app, not a component library

There is no `dist/`, no `main`/`module`/`exports`, and no shipped `.d.ts`. Almost
every quirk below follows from that. Three generated, gitignored files bridge the
gap, all produced by `cfg.buildCmd`:

| File | Why |
|---|---|
| `web/.ds-sync-entry.tsx` | the barrel the converter bundles (there is no dist entry) |
| `web/.ds-sync-styles.css` | compiled Tailwind + a font header (there is no shipped stylesheet) |
| `web/index.d.ts` + `web/.ds-types/` | `tsc --emitDeclarationOnly` output, so props can be extracted |

`.design-sync/gen-entry.mjs` is the durable input that writes the entry. **Run
`cfg.buildCmd` before the converter on every re-sync.**

## Why shape=package and not storybook

`web/.storybook/` is real (23 story files) but the storybook shape is the wrong
tool here, for two independent reasons:

- **Roster.** In storybook shape the component roster IS the storybook index
  (`lib/source-storybook.mjs`), so the ~80 unstoried `components/ui` primitives —
  the actual design system — are unreachable. Package shape takes the roster from
  source exports instead.
- **Fidelity.** The storied components are data-bound widgets whose renders depend
  on `sb.mock(...)`, which `.storybook/preview.tsx` itself notes is "statically
  rewritten by Storybook's vite plugin". The converter compiles story modules with
  **esbuild** and stubs `@storybook/*` with inert callables, so `mocked(fn)
  .mockResolvedValue(fixture)` never takes and the widgets would hit the real API
  from the preview iframe — Loading/Error states, graded `mismatch`. They also need
  `@storybook/nextjs-vite`'s app-router mock (`parameters.nextjs.appDirectory`),
  which esbuild previews do not have.

If you ever DO want the widgets, that is a second, separate project — one config
carries one `shape`, and `_ds_sync.json` records it.

## Inclusion is probed, never pattern-matched

`gen-entry.mjs` bundles each `components/ui/*.tsx` with esbuild and keeps only what
resolves. A regex on `next/`-imports was tried first and was wrong in both
directions: `next/image` and `next/link` bundle fine, while modules reaching
`next-auth` server config pull `jwks-rsa` → node builtins. Currently 7 excluded
(6 next-auth, 1 missing `@/styles/markdown-styles.module.css`).

## Landmines (each cost a build cycle)

- **`PKG_DIR` is walked up from `--entry`.** With the entry at repo root it
  resolved to the monorepo root, so `@types/react` never resolved (it lives in
  `web/node_modules`) → every props body came out `[key: string]: unknown`, and
  `guidelinesGlob` swept up 23 unrelated repo docs. The entry MUST live in `web/`.
- **`cssEntry` and `extraFonts` are workspace-bounded.** A path outside the package
  is silently `skipped` and you get `[CSS_RUNTIME]` with no styling at all. Keep
  generated CSS inside `web/`.
- **`export *` does not re-export `default`.** 20 components here are default
  exports; without explicit `export { default as X }` they land on the roster (they
  are real `.d.ts` exports) but not on `window.Shorted` → `[BUNDLE_EXPORT] 14/79 not
  a component`. `gen-entry.mjs` emits both forms.
- **`componentSrcMap` only ADDS.** Once `index.d.ts` existed the roster jumped
  79 → 183 (every compound part got a card). Sub-parts need an explicit `null`.
  The generator emits primary → path and every other export → null.
- **`process is not defined`, then `React.cache is not a function`.** A bundle built
  from app source keeps `process.env` reads and reaches app actions importing
  React 19's `cache`. Fixed in `web/.ds-sync-process-shim.ts`, imported FIRST from
  the barrel — ESM evaluates imports before the module body, so a shim in the
  entry's own body would be too late. `bundle.mjs` is app-contract surface and must
  never be forked for this.
- **Fonts come from `next/font`, so the bundle ships none.** `--font-sans` is
  IBM Plex Mono (this design language is monospace throughout), `--font-serif` is
  Newsreader, vendored OFL at `src/fonts/newsreader`. `extraFonts` parses only
  `@font-face` — the `@import` and `:root` vars are dropped, so they live in
  `.ds-sync-css-header.css`, prepended to the compiled Tailwind by `buildCmd`.

## Authoring previews (folded from the fan-out wave, 2026-09-09)

- **Preview `.tsx` files must be in Tailwind's content globs or their classes do not
  exist.** The DS stylesheet is compiled by `npx tailwindcss` over the APP's globs; a
  utility the app itself never uses is simply absent and silently no-ops. Two agents hit
  this independently. **Missing HEIGHT classes are the dangerous ones** — a missing width
  is cosmetic, but a dropped `h-48` removed ScrollArea's scrollbar, i.e. the entire point
  of the card. Fixed by `web/.ds-sync-tailwind.config.ts`, which spreads the app config
  and appends `../.design-sync/previews/**/*.tsx`. If you author previews without running
  `cfg.buildCmd`, new classes will not be in the CSS.
- **`next/image` needed an interop shim** (`web/.ds-sync-next-image.tsx`, aliased via
  `cfg.tsconfig` -> `web/.ds-sync-paths.json`). esbuild compiles the CJS import to
  `__toESM(require_image(), 1)`, and node-compat mode **always** overwrites `.default`
  with the whole namespace even though `image-external.js` sets `__esModule: true` — so
  React got an object and threw. The throw is inside `createRoot().render()`, which is
  async, so `emit.mjs`'s synchronous try/catch never fires: **the card paints white with
  no error marker.** A silent blank is the signature of this class of bug. Affected
  Avatar, CompanyLogo, CoverImage, HeroPost, PostPreview.
- **`.design-sync/gen-entry.mjs` must parse tsconfig with `ts.parseConfigFileTextToJson`,
  never a comment-stripping regex.** The naive `/\/\*[\s\S]*?\*\//` sweep treats the
  `"**/*.ts"` globs in this tsconfig's `include` as a block comment and mangles the JSON.
  (The converter's own `tsconfigPathsPlugin` has this bug and silently returns null for
  this repo — aliases resolve anyway because esbuild natively discovers `tsconfig.json`.)
- **`asChild` needs a ref-forwarding child.** `Button` uses `forwardRef` and is safe;
  `Badge` is a plain function, so `<TooltipTrigger asChild><Badge/></TooltipTrigger>`
  renders the trigger and NO tooltip — Radix loses the ref, the popper anchor is never
  measured, nothing positions. Wrap in a `<span tabIndex={0} className="inline-flex">`.
  Same trap for `PopoverTrigger` / `DropdownMenuTrigger`. Documented in conventions.md
  because the design agent will hit it too.
- **A blank cell is not always a missing provider.** `ModeToggle` calls next-themes'
  `useTheme` with no ThemeProvider and renders fine (next-themes falls back to an internal
  default context). **`cfg.provider` is not needed anywhere in this DS.** Before assuming
  a provider gap, drive the card HTML in playwright and read `pageerror`.
- **Overlays render statically with just `open` on the root** — no `forceMount`. Keep
  `modal` at its default: `DialogOverlay`/`AlertDialogOverlay` return `null` when
  `modal={false}` and the scrim silently vanishes. A closed Radix `Select` is NOT blank —
  it mounts `SelectContent` detached so `SelectValue` still resolves its label.
- **`Form` cannot be composed presentationally.** `FormLabel`/`FormDescription`/
  `FormMessage` call `useFormField` -> `useFormContext()`, which returns null outside a
  provider and throws on destructure. A real `useForm()` works in a preview (the preview
  bundles its own react-hook-form copy, but `control` is passed explicitly to `FormField`
  so the two module instances never share context identity), and a static invalid state
  needs no `setError` effect — `useForm({ errors: {...} })` seeds `formState.errors`
  before paint.

## Known render warns (triaged — a warn NOT listed here is new)

- `[FONT_REMOTE]` — expected. IBM Plex Mono loads via a Google Fonts `@import`.
- `[TOKENS_MISSING]` ×8 — `--radix-*` (set by Radix at runtime), `--tw`,
  `--banner-light/dark`, `--movers-grid-cols` (set inline by components). Expected
  absent from a static stylesheet.
- `[BUNDLE_EXPORT] Icons` — compound namespace, usable via `.Sub`. Not a failure.
- `[RENDER_THIN]` — `CompanyLogo`, `GoogleLogo` (logo components: no text by
  design), `Disclosure`, `CompanyProfileView`, `CompanyProfileWithRetry` (floor
  cards awaiting data-shaped previews).

## Re-sync risks

- **`tsc -p .ds-sync-tsconfig.json` exits 2** on pre-existing app type errors
  (protobuf variance in `src/app/actions/getStockDetails.ts`). It still emits, so
  `buildCmd` tolerates it with `|| true`. If declaration emit ever produces
  *nothing*, that tolerance is hiding the reason — run it directly.
- **`dtsPropsFor` is hand-written for Button/Badge/Toggle.** cva variant props come
  from `VariantProps<typeof xVariants>` in `node_modules`, so `isOwnProp` filters
  them out and the variant axis — the DS's core vocabulary — silently vanishes.
  **If a cva variant list changes in source, these go stale with no warning.**
  Re-check against `web/.ds-types/src/@/components/ui/<name>.d.ts`.
- The Google Fonts `@import` is a **network dependency at render time**. If designs
  start rendering in a fallback face, check that first.
- `web/node_modules/@types/react` is what makes props extraction work; a hoist
  change that moves it would silently empty every props body again.
- **`--font-display` is defined here but dead in the app.** DESIGN.md §6 says Space
  Grotesk was removed in 2026-07 and the var now silently falls back to system sans.
  `.ds-sync-css-header.css` deliberately points it at IBM Plex Mono instead, so a stray
  `font-display` in a generated design renders mono ("chrome is mono") rather than
  system sans. That is a deliberate divergence from the app, not a mistake.
- Grouping is flat (`general`) — all 79 sit in one section because the source dir is
  flat and `ui` is in the converter's GENERIC_DIR list. Fixing it needs `docsMap`
  stubs with `category:` frontmatter.
