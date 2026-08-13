# Work package: web-suburbs

Suburb pages + sitemap: kill the 404 corpus, make pages static, small web fixes

## Ground rules (read first)

- You are in a git WORKTREE of the Shorted repo on your own branch. Commit ALL your work
  with conventional-commit messages (one commit per logical unit is fine). Do NOT push,
  do NOT merge, do NOT switch branches, do NOT touch main.
- Before coding, read the Housing section of the repo CLAUDE.md and skim
  docs/housing-architecture.md for the landmines that apply to your files. Non-negotiable
  repo rules: interactive charts import via dynamic(ssr:false) from "use client" modules;
  never pass functions across the RSC boundary; read searchParams client-side (useSearchParams
  under Suspense) on ISR pages - a server-page searchParams read silently forces dynamic;
  server actions use getShortsApiUrl() from app/actions/config.ts, never env vars directly;
  KV reads go through the readCached non-emptiness predicate.
- Migrations: the prod deploy does NOT run migrate up (hand-apply regime). Do NOT create
  migrations unless your spec explicitly assigns you migration numbers. If a schema change
  seems needed but is not assigned, write it up in your final summary instead.
- Do not modify .proto files or run buf generate. If a proto change seems needed, note it
  in the summary.
- Keep the diff scoped to the findings below. No drive-by refactors, no formatting sweeps.
- QA before you finish: run the narrowest relevant tests (go test ./... scoped to the
  packages you touched; for web: cd web && npx tsc --noEmit plus any touched jest suites)
  and report the actual results honestly in your final summary. If something fails and you
  cannot fix it within scope, say so plainly.
- Finish with a summary: what you changed per finding, what you deliberately did not do,
  test results, and anything the reviewer must hand-verify.

These findings come from a 24-agent adversarial audit (2026-08-09); each was independently
verified against the code. Evidence line references were correct as of audit time - re-locate
if lines shifted.

## Track notes

Priorities: F03 and F04 are the meat. For F03: single source of truth for the
suburb slug (import the shared suburbSlug from @/lib/housing/states everywhere), make
resolveSuburbSalCode tolerant of a trailing hyphen so already-indexed bad URLs recover
(redirect or resolve, do not 404). For F04: move the ?sal= read out of the server page
(client-side under Suspense, or drop the fast-path) so the exported revalidate actually
takes effect; validate any sal fast-path against state+slug before trusting it; make
resolveSuburbSalCode distinguish backend failure (throw/500 or serve stale) from a true
miss (404). Do NOT implement generateStaticParams warm-up or a KV slug index here - that
is a follow-up enhancement; just restore ISR semantics and correct resolution.

## Findings (verbatim from the audit)

### F03 [high/bug] All 1,165 suburb URLs in the live prod sitemap 404 (trailing-hyphen slug divergence)

**Detail:** The sitemap's inline slugifySuburb (sitemap.ts:538-539, duplicated in getHousingSitemap.ts:5-6) unconditionally appends `-${postcode}`, but suburb_demographics.postcode is never populated (the census upsert omits it; only migration 000055 defines the column), so every emitted slug ends with a bare dash. The canonical suburbSlug (states.ts:24-26) omits the suffix when postcode is empty, and resolveSuburbSalCode does an exact-equality match — so every sitemap-advertised suburb URL hard-404s while the real URLs are absent from the sitemap entirely. The whole priced-suburb SEO corpus is invisible to crawlers and the sitemap feeds Google 1,165 dead links (crawl-budget + trust damage).

**Evidence:** Live prod sitemap.xml: 1,165/1,165 two-segment /housing/<state>/<suburb> URLs end with '-' (e.g. /housing/vic/abbotsford-vic-). Live: /housing/vic/abbotsford-vic- → 404; /housing/vic/abbotsford-vic → 200 (independently reproduced by two finders incl. Playwright on /housing/vic/aberfeldie-). Code: sitemap.ts:539 `...-${postcode}` vs states.ts:25 `${postcode ? `-${postcode}` : ""}`; grep: no writer of suburb_demographics.postcode in census.go/store.go.

**Suggested fix (advisory, you may do better):** Delete both local slugify copies and import the shared suburbSlug from @/lib/housing/states (getHousingSuburbUrls in getHousingSitemap.ts is unimported dead code — fix-and-use or delete); make resolveSuburbSalCode tolerate a trailing hyphen so already-indexed bad URLs recover; resubmit the sitemap in Search Console.

**Verifier note:** CONFIRMED on all four legs. (1) Code: sitemap.ts:538-539 and getHousingSitemap.ts:5-6 both define an inline slugifySuburb that unconditionally appends `-${postcode}`, while the canonical suburbSlug (states.ts:24-25) appends only when postcode is non-empty; resolveSuburbSalCode (getHousing.ts:292-298) does exact `===` matching against the canonical slug, so trailing-hyphen slugs can never resolve. (2) Data: no writer of suburb_demographics.postcode exists anywhere in services/ — the census upsert (house-price-collector/store.go:162-209, mirrored in services/jobs/.../houseprices/store.go) omits the column entirely; only migration 000055 defines it; the RPC read path COALESCEs it to ''. (3) Live prod reproduced 2026-08-09: shorted.com.au/sitemap.xml contains exactly 1,165 two-segment /housing/<state>/<suburb> URLs and 1,165/1,165 end with a bare '-'; Playwright shows /housing/vic/abbotsford-vic- → HTTP 404 while /housing/vic/abbotsford-vic → 200. (4) Not fixed: origin/main still carries both buggy copies, no fix commit in git log on any cited path; the secondary claim that getHousingSuburbUrls is unimported dead code also holds (definition only, zero importers). Severity high (not critical): whole priced-suburb sitemap corpus is dead links with the real URLs absent — concrete SEO/crawl-budget damage, but no data corruption, security, or licence exposure.

### F04 [high/bug] Suburb pages are silently fully dynamic; every view pays a full-state ~5,000-row RPC, backend failures serve soft-404s, and ?sal= is unvalidated

**Detail:** page.tsx reads searchParams (?sal=) in the server page (:24, :43), which forces dynamic rendering — the exported `revalidate = 86400` (:13) is dead (the exact trap this repo already fixed on /price-drops). With no generateStaticParams and no KV layer, every request to any of the ~15k reachable suburb URLs runs resolveSuburbSalCode → listStateSuburbs(code, "", 5000) on a no-store transport (NSW ≈ 4,544 rows × ~40 fields, running the heaviest housing query server-side) plus getSuburbProfile, on the TTFB path; the opengraph-image route repeats the resolution per scrape. Two secondary defects on the same path: (a) resolveSuburbSalCode swallows ALL errors (withRetryAndNotFound + .catch(() => null)), so a Cloud Run blip yields notFound() — soft-404s on real suburb URLs, a deindexing vector this repo has been burned by before; (b) the ?sal= fast-path is never validated against the state/slug in the path, so /housing/nsw/bondi-beach?sal=<SA code> renders an SA suburb's profile, title and banner under the NSW URL. Note ?sal= is load-bearing (politicians declaration links use it) so it can't simply be deleted.

**Evidence:** page.tsx:13 (dead revalidate), :24/:43-46 (searchParams read; sal never cross-checked; !sal → notFound()); getHousing.ts:115-122, 292-298 (listStateSuburbs(stateCode, "", 5000), .catch(() => null)); price-drops/page.tsx:30-34 documents the identical searchParams trap; NSW.topojson = 4,544 SALs; store query postgres_house_prices.go:281-330 (per-suburb LATERAL + year-ago probe); CLAUDE.md contract 'withRetryAndNotFound returns undefined for ALL errors'.

**Suggested fix (advisory, you may do better):** Read ?sal= client-side (useSearchParams under Suspense, mirroring AddressDropsBoard) or fold sal into fallback slug matching, restoring on-demand ISR; KV-cache a per-state slug→sal index so resolution is a ~5ms GET; return a {miss|unavailable} union from resolveSuburbSalCode so backend failures 5xx instead of 404; after fetch, verify profile.summary.stateCode matches the path and redirect to canonical on mismatch.

**Verifier note:** Every cited fact holds in the current tree, and the core claim is proven by build artifacts, not just inference. (1) Dynamic rendering: web/src/app/housing/[state]/[suburb]/page.tsx:13 exports revalidate=86400 but reads searchParams at :24/:43; today's local build (web/.next, Aug 9 15:47) shows /housing/[state]/[suburb] AND its opengraph-image are absent from prerender-manifest.json routes+dynamicRoutes while siblings (/housing/[state], /economy/[state], /shorts/[stockCode]…) are ISR — the route is fully dynamic (λ) and the revalidate export is dead, exactly the trap the repo documents in price-drops/page.tsx:28-34. (2) Cost: getHousing.ts:115-122 listStateSuburbs uses the default no-store transport (config.ts:266-272 forces cache:'no-store' on POSTs) with no KV layer; resolveSuburbSalCode (:292-298) loads the full state (NSW.topojson = exactly 4,544 SALs; 15,345 nationally) through postgres_house_prices.go:281-330 — a ~50-column 5-way join with a per-row LATERAL + nested year-ago subquery, the heaviest housing read — on the TTFB path. Sitemap.ts:561-563 advertises the CLEAN URLs (no ?sal=), so all crawler traffic takes the slow path. (3) Soft-404: withRetry.ts withRetryAndNotFound returns undefined for ALL errors after retries, then resolveSuburbSalCode adds .catch(() => null), and page.tsx:44 maps null → notFound() — a Cloud Run blip 404s real suburb URLs. (4) ?sal= spoof: page.tsx never cross-checks the sal against path state/slug (profile fetched purely by sal, breadcrumb/state from path), and ?sal= is genuinely load-bearing (states.ts:27-31 suburbHref, politicians declaration-rows.tsx:103). No later commit fixes any of this (latest touches: dd9d0b3ba proto migration, fa9add423 which ADDED the slug fallback). One minor overstatement, not verdict-changing: views arriving WITH ?sal= (internal app links) skip the 5,000-row resolution and pay only getSuburbProfile — 'every view pays the full-state RPC' is strictly true only for clean/canonical/crawler URLs; every view does pay a per-request RPC render. Severity stays high (real perf/reliability gap + a proven deindexing vector on ~15k URLs), not critical: no data corruption, security, or licence exposure — pages render correctly when the backend is healthy.

### F26 [medium/cleanup] The redirected /housing/suburbs page and its whole component cluster still build and ship, and 'Valuer-General coverage spans SA & VIC' is string-hardcoded in 3 live places

**Detail:** next.config.mjs permanently 301s /housing/suburbs → /housing (deprecated 2026-06-29), yet the route + chain still compile: page.tsx (ISR, 131kB first-load per bundle-baseline), suburb-explorer.tsx, suburb-explorer-loader.tsx, suburb-map.tsx and its 50.3K suburb-centroids.json — none reachable. getHousingSuburbUrls in getHousingSitemap.ts is likewise unimported (sitemap.ts re-implements it inline — see F03). Separately, the VG coverage claim 'SA & VIC' is hardcoded in the state-explorer empty state, the suburb-profile chart empty state, and the dead page's metadata (plus a comment) — accurate today only because the NSW ingest hasn't landed (F01); the moment vg_nsw flows, three user-facing strings silently become wrong. CLAUDE.md:515 also still documents a national-housing-map.tsx that no longer exists (replaced by housing-zoom-map.tsx).

**Evidence:** next.config.mjs:274 (redirect); importer graph: suburb-explorer ← only the redirected page; suburb-centroids.json ← only suburb-map; getHousingSuburbUrls → 0 importers; docs/perf/bundle-baseline.json /housing/suburbs 131kB; grep 'SA & VIC|SA &amp; VIC' → 5 hits (state-suburb-explorer.tsx:139, suburb-profile.tsx:161, suburb-explorer.tsx:164, state-suburb-map.tsx:78, housing/suburbs/page.tsx:52); rg 'national-housing-map' → only CLAUDE.md:515.

**Suggested fix (advisory, you may do better):** Delete the page + explorer/map/loader/centroids cluster and getHousingSuburbUrls (after F03 reuses or removes it); derive the covered-states list from the data (states where any suburb has latestMedianPrice > 0 — already fetched by both components); fix the CLAUDE.md housing table row.

### F37 [low/bug] 'Dwellings' renders a permanent em-dash on all ~15.3k suburb profiles, and the flagship editorial + economy state pages are internal-linking dead-ends for the housing cluster

**Detail:** (a) suburb_demographics.dwelling_count exists in the schema (000055) and the profile UI renders a 'Dwellings' row, but the census ingester never populates it (census.go has zero dwelling mentions; the upsert column list omits it) — the stat has shown '—' on every suburb page since launch, reading as a data bug. (b) The Widow-Maker (FEATURED[0] on the /news masthead) links only /shorts/[code] bank tickers — no link to /housing, /price-drops or /housing/calculators, all shipped after it; /housing never links the feature back; and /economy/[state] pages contain no link to the matching /housing/[state] suburb explorer. The strongest editorial asset and the state economy pages send zero internal-link equity to the housing surfaces.

**Evidence:** grep 'DwellingCount|dwelling' census.go → 0; suburb-profile.tsx:175 (d?.dwellingCount ?? '—'); live GetSuburbProfile(10463) has no dwellingCount; grep href /housing in the-widow-maker/page.tsx → 0 (only /shorts/${c} at :429); grep '/housing' in app/economy/[state]/ + components/economy/ → 0; grep 'the-widow-maker' across app/housing + components/housing → 0.

**Suggested fix (advisory, you may do better):** Ingest G-table total private dwellings from the same 2021 GCP SAL DataPack (small census.go addition + re-run -mode census) or drop the row; add a live-data CTA block to the feature, a feature card on /housing, and a housing tile/link on /economy/[state] (state median already derivable from GetHousingOverview).

### F25 [medium/risk] The OG brand logo (icon-512.png) is not traced into the housing/price-drops card lambdas — the fs fallback is a network fetch that Cloudflare bot-protection 403s

**Detail:** getOgLogo reads public/icon-512.png via a for-loop over a path array — commit 8c120a352 (#416) measured that nft does not trace readFileSync in the OG card routes at all, and its fix only added the scene JPEGs and states.topojson to outputFileTracingIncludes, never icon-512.png. In the lambda the fs read fails and falls through to a network fetch of shorted.com.au/icon-512.png — the class of server-side fetch Cloudflare bot-protection 403s (reproduced in this audit: curl with a full browser UA → 403). Likely result: /housing/[state], /price-drops and /housing/calculators share cards render without the brand logo chip on prod.

**Evidence:** card.tsx getOgLogo for-loop over ["public/icon-512.png", "public/logo.png"]; next.config.mjs:392-397 outputFileTracingIncludes has no icon/logo entry for any og route; commit message 8c120a352; curl -A <Chrome UA> https://shorted.com.au/housing/vic/aberfeldie → 403 (same CF posture applies to the icon fetch).

**Suggested fix (advisory, you may do better):** Add ./public/icon-512.png (and logo.png) to outputFileTracingIncludes for every OgCard-based route (or one wildcard entry), then verify the route's .nft.json lists it, as #416 did.

