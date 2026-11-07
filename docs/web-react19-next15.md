# React 19 / Next 15: the web app upgrade (2026-11)

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

### React 19 / Next 15 (the web app's upgrade, 2026-11)

- **Production runs Next's bundled React, not the `react` in `package.json`.**
  The App Router renders `next/dist/compiled/react`, which is
  `19.2.0-canary-0bdb9206-20250818` in Next 15.5.28. `react` and `react-dom` are
  pinned to 19.2.9, the nearest release, and Jest and Storybook run 19.2.9. Only
  a browser run against `next start` exercises production's React.
- **Next is the 15.5 line (15.5.28).** Next 16 removes the synchronous request
  APIs, `next lint` and `publicRuntimeConfig`, so it is a separate upgrade.
- **Request APIs are async.** `cookies()`, `headers()`, `params` and
  `searchParams` are awaited, and their types are `Promise<...>`. Never read
  them as plain objects.
- **Lint runs on the ESLint CLI, not `next lint`.** `npm run lint`
  (web/package.json) is `eslint` over `app pages components lib src` with the
  extensions `next lint` used by default. Only `src` exists in web/ today. On
  2026-11-03 the CLI linted the same files as `next lint` and reported the same
  messages. ESLint 8 and `.eslintrc.cjs` are unchanged;
  flat config is a separate change. `next build` still lints in 15.5 and still
  gates the build. **Next 16 removes `next lint`, and `next build` no longer
  runs linting (the `eslint` key in next.config goes too), so when upgrading,
  add a CI step that runs `npm run lint`.** Like `next lint`, the script lints
  only those five directories: code in any other top-level directory under
  web/ is not linted unless it is added to the script.
- **The build identity is baked in, not read at runtime.** `/api/version` reads
  `process.env.SHORTED_BUILD_*` and `NEXT_PUBLIC_RELEASE_COMMIT`, which
  `next.config.mjs` passes to `env` from `src/config/build-identity.mjs`. Next
  inlines them at build time, so `publicRuntimeConfig` and `next/config` are
  gone (Next 16 removes both). Keep each read a literal `process.env.NAME`: a
  dynamic lookup is not inlined, and the release tooling then reads `local`.
  The deploy job (`terraform-deploy.yml`, `deploy-vercel-prod`) sets
  `SHORTED_RELEASE_SHA` and `SHORTED_RELEASE_REF` for `vercel build`, which runs
  on the runner, so Vercel's git variables are absent: `gitCommit` is the
  release SHA's first seven characters and `gitBranch` is `main` for a push to
  main. Local builds report `local`.
- **Build concurrency:** `experimental.staticGenerationMaxConcurrency: 1`
  (Next 15 renders 8 pages per export worker by default). A failed call during
  the prerender bakes the fallback page (`bailOnEmptyRender`). Measured
  2026-11-03 from the Cuttlefish logs of five production deploys: the CI
  prerender took 8 to 12 s at concurrency 1 (Next 14: 18 to 21 s) with no
  rate-limit, retry or fallback lines, because CI builds against the Cloud Run
  URL directly ("Resolve Service URLs"). Local builds go through Cloudflare
  without the bypass secret, which is where local 429s come from. Kept at 1:
  the default 8 would save under 10 s of a ~6 minute deploy at up to 8x the
  concurrent API and database load (Supabase `max_connections` 60). Re-measure
  before raising it: `cuttle run logs <run> --project shorted --format ndjson
  --grep "Generating static pages"` (a `shorted` project login).
- **Client router cache:** `experimental.staleTimes: { dynamic: 30 }` keeps
  Next 14's 30 s for dynamic pages (Next 15 defaults to 0). The browser's
  requests count against the rate limits, so keep it.
- **The warm-cache routes are dynamic and take three credentials.** All four
  `api/*/warm-cache` routes and `api/warm-pages` are `force-dynamic` and call
  `isCacheWarmAuthorized` (`web/src/@/lib/cache-warm-auth.ts`). They accept
  Vercel Cron's `CRON_SECRET` bearer, the `REVALIDATION_SECRET` bearer (the
  deploy's prime step) and an `X-Cache-Warm-Secret` header. They never accept a
  query-string secret. On Vercel they refuse everything else, which with nothing
  configured is every request. Off Vercel with nothing configured they answer
  everyone, so local dev keeps working.
- **`next/dynamic` with `ssr: false` belongs in a client module** (see the stock
  page section). Next 15 refuses it in a server component.
- **Forms:** React 19 resets an uncontrolled form once its `action` completes
  without throwing, whatever the action answered. The admin trigger form
  (`web/src/app/admin/enrichments/trigger-enrichment-form.tsx`) therefore submits
  through `onSubmit`. It clears its stock code and Force box only when the API
  created a job (`created` on the action's result), and then says what it
  queued, in a `role="status"` line that is always mounted and is cleared when
  the next submit starts. The clear is on purpose: a Force box left ticked made
  the next code a forced re-enrichment, which is a paid GPT run. An answer that
  created no job (a pending review, or a job already running) keeps the fields
  and shows the API's message, because the admin still has to act on it. A
  failed trigger reaches the root error boundary (`web/src/app/error.tsx`), which
  replaces the page, so what was typed is lost on failure whichever way the form
  submits. The review form (`web/src/app/admin/enrichments/page.tsx`) keeps
  React 19's reset: a successful review redirects to `/admin/enrichments` without
  `?id=`, which unmounts its card, so the reset loses nothing the admin still
  needs. The sign-in form (`web/src/@/components/ui/sign-in.tsx`) has no fields
  and its action redirects to the sign-in page (`/signin`), so its reset loses
  nothing.
- **Head scripts:** Discord's proxy adds a script to `<head>` ahead of the
  Discord address script (layout.tsx), so that script carries
  `suppressHydrationWarning`. The Discord e2e case (`chart-surfaces.spec.ts`,
  "proxy") stays strict and passes on `next dev` and `next start`. Any other
  third-party head script placed ahead of the address script is still a
  hydration mismatch (see the Discord landmine).
- **A `next` option on a POST stays out of Next's data cache.** Next 15 keys byte
  and string bodies alike, so a `next: { revalidate, tags }` option on any non-GET
  request would store the response for the whole revalidate window, and an empty
  response (a cold materialized view, the kill switch) would then be served to
  every caller. Next 14 never stored a Connect byte body. `serverFetchWithUserAgent`
  (config.ts) sends every non-GET request that carries `next` around the patched
  fetch and registers the route's revalidate and tags through `unstable_cache`
  (`applyRoutePolicy`). The route keeps its window, and nothing is stored, so a
  read that many renders or requests share does not dedupe here. Those take
  `sharedRead` (actions/shared-read.ts): one `unstable_cache` entry for the
  window that throws on an empty answer, so only a good one is held. Today that
  is the short-interest rank list (`getShortRank.ts`), the industry treemaps
  (`getIndustryData.ts`, read by the force-dynamic /industry page), the report OG
  images' GetMarketByDate reads (`market-by-date.ts`, one day) and the sitemaps'
  GetTopShorts and treemap reads (`sitemap-sections.ts`, one hour). Do not add a
  static `next/cache` import to config.ts: client components import that module,
  and the policy helper only runs on the server.
- **Metadata on dynamic pages.** `htmlLimitedBots: /.*/` (next.config.mjs)
  resolves metadata before the shell for every request, as Next 14 did. Without
  it, Next 15 streams title, canonical and robots after the shell, and on dynamic
  pages those tags stay in `<body>` (measured on /industry, /search and /alerts).
  Only metadata waits; the body still streams.
- **Image routes honour their revalidate export.** A metadata image route with
  `revalidate = 86400` (the `opengraph-image` files) now regenerates daily, where
  Next 14 kept it until the next deploy. The suburb OG image
  (`housing/[state]/[suburb]`) has an empty `generateStaticParams`, so it is
  on-demand ISR: a miss, then cached, instead of a render on every request.
- **Typeface.** IBM Plex Mono is the app face (DESIGN.md), set through
  `--font-plex-mono`. next/font puts that variable on `<html>` and preloads the four
  latin files (weights 400 to 700, 40,360 bytes), with `adjustFontFallback: false`, so
  no generated Arial face draws the triangles and arrows Plex lacks. The `--font-sans`
  stacks in globals.css and critical-css.ts read the variable, with the literal name
  as the fallback. Plex sets 6.00px a character at 10px (`AXIS_CHAR_PX` is 6.1). Without
  the web font the stack reaches SF Mono on macOS, at 6.18px. First-load layout shift
  in Chromium through the e2e fixture, read 8 s after load, with the font files delayed
  1.5 s and undelayed in brackets: the stock page 0.002 at 1280px and 0.000 at 390px
  [0.002 and 0.001]; the homepage 0.043 at 1280px, where the swap lands at 1.5 s, and
  0.000 at 390px [0.001 and 0.001]; /strategies 0.000 at both widths [0.001 and 0.001]. Every
  case is under the 0.1 "good" line. WebKit exposes no layout-shift entries, so these
  are Chromium's figures. Windows and Linux are not measured.
- **next-auth beta.32 Edge warnings are expected.** `next build` prints "Compiled
  with warnings" for the middleware: `next-auth/jwt` pulls in `jose` 6, whose
  `deflate.js` calls CompressionStream and DecompressionStream, which the Edge
  Runtime build flags as unsupported. They are harmless. jose decompresses only a
  token whose header says `zip` (Auth.js never writes one), and only after the
  token's tag verifies, which needs `NEXTAUTH_SECRET`. A new Edge warning that
  does not point at that module is a real one.
- **visx 4 (2026-11).** Every `@visx/*` package is `^4.0.0` (the first release
  that takes React 19; 3.x caps React at 18), and the packages must match each
  other. Three rules come with it:
  - **Measure charts with `ParentSize` from `@/components/charts/parent-size`,
    never from `@visx/responsive`.** visx 4's `ParentSize` puts its children in
    an absolutely positioned, overflow-hidden box, so a wrapper whose height
    comes from its content (a chart drawn at a fixed height, a treemap sized
    from its width) collapses to 0px, and a tooltip near an edge is clipped.
    The local one is visx 3's layout on visx 4's `useParentSize` (same 300 ms
    debounce with a leading call, 0 x 0 until the first measurement).
  - **No deep `lib/` imports.** visx 4's `exports` map refuses
    `@visx/brush/lib/BaseBrush` and `@visx/responsive/lib/...` at runtime
    (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and `tsc` still passes because it resolves
    the files. Import types from the package root (`BrushProps`, `UpdateBrush`,
    `Bounds`, `BrushHandleRenderProps`). The `BaseBrush` class is exported by no
    root, so its ref type is `NonNullable<NonNullable<BrushProps["innerRef"]>["current"]>`.
  - **Declare every visx package the app imports.** `@visx/event` and
    `@visx/grid` are direct dependencies (they had been reached only through
    other visx packages, `@visx/grid` only through `@visx/xychart`, now removed).
    Do not add `@visx/xychart` back: it is unused. Path data comes from d3-shape
    3 (vendored in `@visx/vendor`), which rounds coordinates to three decimals:
    sub-pixel, not a visual change.

