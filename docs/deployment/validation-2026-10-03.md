# Cost change validation — 2026-10-03

The staged production-environment candidate `dpl_DG3RRB1TSoX1tucx9EtTcxYj23LQ` was ready at [shorted-com-kn3teibz9-document-analyser.vercel.app](https://shorted-com-kn3teibz9-document-analyser.vercel.app). Its merge commit `cd1e3cc8e342a32a9fd0c779964397c862c2a08f` has parents main `a1643ec4d` and PR #675 implementation `7155100aa`. This candidate is an intermediate validation build, before the subsequent duration guard and cold-warm timeout adjustment.

The Vercel deployment API confirmed `functionType: fluid`, `functionMemoryType: standard`, `isUsingActiveCPU: true`, Sydney (`syd1`), and the four reduced cron schedules. The previous deployment `dpl_2eg9v9B8wC9La25CJU5f5pk3oEgp` used `standard`, `standard_legacy`, `isUsingActiveCPU: false` and a 15-second default. The follow-up source guard preserves 15 seconds for ordinary source functions and verifies generated metadata before upload; explicit 120/300-second warmer exports must survive the builder.

All 15 static pages were ready on a repeat repair in 419 ms; every result was `checked`, with no invalidation. Invalidate and prime were also verified as distinct requests: the invalidation response queued all 15 pages, then priming reached 14/15 while the initial 12-second read budget timed out on `/price-drops`. Source raises this per-read bound to 30 seconds, with five concurrent reads and a 120-second function cap. The final release candidate must verify that cold path again. Local Next verification independently showed `/market` changing from `x-nextjs-cache: HIT` to `MISS` only after the invalidation response completed.

## Bounded compatibility comparison

From 08:49:42.488Z to 08:50:26.618Z, the benchmark completed 104 successful GET status/content checks: 52 against the intermediate candidate and 52 against the prior production deployment. Concurrency was limited to four, with six measurements per route/phase.

All 26 statistics responses were CDN MISS and application cache HIT. The unique probe query exercised the Node.js endpoint without adding backend refresh work. All measured HTML pages were CDN HIT.

| Statistics TTFB p95 | Prior deployment | Candidate |
| --- | --- | --- |
| Concurrency 1 | 403.38 ms | 309.16 ms |
| Concurrency 4 | 1,932.07 ms | 427.19 ms |

These are small-sample compatibility observations. The deployments use different source, and page timing was mixed; this comparison does not isolate Fluid's effect or establish realized billing savings.

## Source and browser checks

- 3,228 frontend tests passed; backend short tests passed across 21 packages.
- Production build marked all four historical detail routes static/on-demand; bundle budgets passed.
- TypeScript and lint passed on all 29 changed production TS/TSX files; GitHub's pinned Go lint also passed.
- Actual widgets in a browser shared one 24-symbol request across three sector views and one quote request across two portfolios. A holding edit recalculated without a request; hidden polling paused and resumed once per shared query.
- Three mover cards rendered five summaries each, correct signed badges and 15 stock links. Table sparklines remained present. The actual local `/top` empty states had no browser JavaScript errors.
- Two earlier CI failures occurred during checkout, before any tests ran. The performance CI server startup also exposed an inherited background-pipe hang; the server now redirects its streams to the existing uploaded log directory.
- A production build with the release's pinned Vercel 54.10.2 builder passed the generated-function guard: statistics/about/homepage warm APIs retain 15 seconds, static-page warming retains 120 seconds, and page warming retains 300 seconds on Node.js 24. Both configs use the supported Next.js `src/app/**/*` glob.
- The final build used the exact release Node.js 24.8.0 runtime. All 62 social-image sources export a literal 15-second limit; the artifact guard verified all 124 generated image functions and aliases retain that limit. Firebase and Stripe price preflights passed with the project's production configuration. The local release script now runs the same artifact guard before upload.

Production promotion still depends on the final candidate's generated duration verification and existing release smoke. Actual dollar savings require a comparable traffic-normalized billing window after rollout.
