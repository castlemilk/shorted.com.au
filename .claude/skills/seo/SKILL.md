---
name: seo
description: Review and improve Shorted's search performance - pull Search Console data and run a site crawl through the OpenSEO connector, find what costs rankings or clicks (canonicals, titles, indexability, thin or stale pages, broken links), fix it in the web app with a test, and record the round in docs/seo-audit-YYYY-MM.md. Use when asked for an SEO review or audit, when Search Console traffic moves, before or after changing page metadata, sitemaps or robots, or when a page type is added.
---

# SEO: measure, fix, record

Shorted earns search traffic from three clusters: the per-ticker stock pages
(`/shorts/<CODE>`, about half of all clicks), the homepage and `/top` for
"most shorted ASX stocks" / "ASX short positions", and a long tail of
housing, economy, politicians, news and learn pages. This skill is the loop
that keeps them honest:

1. **Measure** first-party data (Search Console) and crawl the live site.
2. **Diagnose** against the checklist below; most findings are one of a
   handful of known failure shapes.
3. **Fix** in the web app, each with a test that would have caught it.
4. **Record** the round in `docs/seo-audit-YYYY-MM.md`.

History lives in `docs/seo-strategy-2026-07.md` and the monthly audits
`docs/seo-audit-2026-08.md`, `-09.md`, `-10.md`. Read the latest one first:
it lists what is open and which experiments are being measured.

## 1. Measure (OpenSEO connector, free tools only)

The OpenSEO instance is `seo.benebsworth.com`; the Shorted project id is
`fc96ca3a-0345-41ef-bc77-76f816e0d5b9` (market: Australia, `2036`). Find it
again with `list_projects`.

**Do not call DataForSEO-backed tools** (`get_serp_results`,
`research_keywords`, `get_keyword_metrics`, `get_ranked_keywords`,
`find_serp_competitors`, `get_domain_overview`, backlinks, rank trackers).
The owner decided to skip DataForSEO; they return `HTTP 401` on this instance
anyway. Lighthouse in `run_site_audit` also fails there; use the
`perf-optimization` skill for Core Web Vitals.

What works and costs nothing:

| Tool | Use |
|---|---|
| `get_search_console_performance` | clicks, impressions, CTR, position by `query`, `page`, `["query","page"]`, `device`, `date`. Rows sort by clicks and cap at 1,000; a page dump overflows the tool result, so save and summarise it with `jq`. |
| `run_site_audit` then `get_audit_status`, `get_audit_issues`, `get_audit_pages` | crawl `https://shorted.com.au/` (it reaches the real domain as of 2026-10-15; earlier rounds had to crawl `shorted-com-au.vercel.app`). 500 pages takes about 90 seconds. Query `get_audit_issues` per `issueType`: an unfiltered call is capped at `limit` and drops the later types. |
| `inspect_urls` | Google's index state for up to 10 URLs. It timed out at 60s on 2026-10-15; retry with fewer URLs. |
| `get_google_analytics_*` | GA4 organic sessions and landing pages. |
| `get_project_context` | the owner's stated goals and competitors (Shortman, `shortman.com.au`). |

Useful cuts:

- **Striking distance**: queries at positions 4-15 with impressions over
  about 200 and CTR under 2%. That is where a title or a better-targeted
  page moves clicks.
- **Cannibalisation**: `["query","page"]` filtered to a head term; two
  Shorted URLs both ranking 7-15 for one query means neither wins.
- **Section yield**: group the `page` rows by first path segment
  (`/shorts/*/<tab>` separately) and compare pages, clicks and impressions.
- **Trend**: `["date"]` over 6 months.

The production database is readable through the Supabase connector (project
`core`) when a finding needs data behind it, for example which codes a news
feed links to. Read-only queries only.

## 2. Diagnose: the checklist

Each item is a defect that has shipped before.

- **Canonical inheritance.** Next merges metadata per segment: anything in
  `app/layout.tsx` is inherited by every page that does not override it. The
  root layout carried `alternates.canonical: siteConfig.url` until
  2026-10-15, so `/pricing`, `/terms`, `/docs/api` and others declared
  themselves copies of the homepage (and `/signin` before that, see
  `app/__tests__/auth-routes-noindex.test.ts`). The root now has no
  `alternates`; `app/__tests__/root-canonical.test.ts` keeps it that way. A
  page that should rank names its own canonical.
- **`robots: undefined`.** Next 14.2 merges with `for (key in source)`, so an
  own `robots` key holding undefined wipes the root's googleBot directives.
  Omit the key when indexable (`stock-tab-metadata.ts`, stock `page.tsx`).
  It was still on 6,655 sitemap URLs on 2026-10-21 (suburbs, politicians,
  reports, insider pages); `app/__tests__/robots-undefined.test.ts` now fails
  any page or layout whose `robots` can be undefined.
- **Indexability and the sitemap must agree.** `lib/seo/stock-indexability.ts`
  is the one gate for stock pages and the sitemap is a strict subset of it.
  Never list a URL the page noindexes.
- **Titles.** The root template appends ` | Shorted`; a page whose title
  already carries the brand must use `title: { absolute }` or it renders
  "... | Shorted | Shorted". Keep the visible title under about 60
  characters before the template (65 rendered), query first. Stock titles
  come from `lib/seo/stock-page-title.ts`, the tabs' from
  `lib/seo/stock-tab-title.ts`. `app/__tests__/title-brand.test.ts` fails a
  page or layout title that carries the brand, and `title-length.test.ts`
  pins one page of each template.
- **Live claims on stale data.** A stock missing from ASIC's report for more
  than 90 days (`isStaleShortDate`, `lib/stocks/as-of-date.ts`) keeps its
  page but its snippet drops the %, the 30-day move and "Updated daily". Any
  new "as of" or "updated" claim must come from the data's own date, never
  `new Date()`. Structured data too: `DatasetStructuredData` omits
  `dateModified` when the caller passes no date (it stamped the render time
  on `/`, `/data` and `/battlegrounds` until 2026-10-21), so pass the data's
  date (`app/__tests__/home-dataset-date.test.tsx`).
- **Stale codes in aggregates.** `mv_screener_data` keeps each code's last
  ASIC row however old, so a count or a "4-week move" over the screener took
  in codes last reported in 2011-2023 (CSJ, 2012, led `/statistics`' risers
  on 2026-10-21). `/statistics` counts only codes in the latest ASIC report
  (`app/actions/getShortStatistics.ts`, pinned by its test). `/screener`,
  `/scans`, `/battlegrounds` and the MCP `screen_stocks` tool read the
  unbounded view until its `latest_shorts` is bounded.
- **JSON-LD.** Write structured data through `<JsonLd data={...} />`
  (`components/seo/json-ld.tsx`). It escapes `<`, `>` and `&`, so a stored
  value cannot close the script, which a bare `JSON.stringify` in
  `dangerouslySetInnerHTML` allows. `app/__tests__/json-ld-escaping.test.ts`
  fails any other `application/ld+json` script.
- **ISR killers.** Reading `searchParams`, `cookies()` or `headers()` in a
  server page makes it dynamic. Read query state client-side. See the stock
  page landmines in CLAUDE.md. Four more, all found on 2026-10-21. A page is
  ISR when its second GET answers `HIT` with `public, max-age=0,
  must-revalidate`.
  - On a dynamic route `revalidate` does nothing without
    `generateStaticParams`: every blog post, take, compare pair and insider
    page (about 940 sitemap URLs) rendered per request, `private, no-store`.
    Add an empty one with `dynamicParams = true`
    (`app/__tests__/isr-static-params.test.ts`).
  - `dynamic = "force-dynamic"` beside `revalidate` wins (`/shorts`);
    `app/__tests__/isr-hubs.test.ts` fails the pair anywhere.
  - A Connect POST with no `next` lifetime goes `no-store` at runtime and
    throws inside a regeneration, so Next discards the render:
    `/battlegrounds` sat `STALE` with a frozen `age`.
    `app/actions/__tests__/serverApiSurface.test.ts` walks every static
    route's imports for one.
  - ISR caches what a regeneration renders, a `notFound()` or an empty list
    from a failed read included, for the whole revalidate. Make a page fail
    closed before making it ISR: 404 only on NotFound, and throw on a failed
    read (`loadStockOrFail`) or cap the render with `bailOnEmptyRender`
    (`app/__tests__/isr-degraded-render.test.ts`).
- **Junk URL fan-out.** Links carrying per-page query strings (sign-in
  `callbackUrl`, filters) multiply crawlable URLs. Noindex the target and
  `rel="nofollow"` the link; do not `Disallow` in robots.txt, which strands
  already-indexed URLs.
- **Broken internal links.** The crawl's `broken-internal-link` list. Known
  open: news cards link `/shorts/<CODE>` for every tagged code, and a company
  that has never appeared in ASIC's short report has no stock page (404). 214
  codes tagged in the last 30 days of news had no page on 2026-10-15
  (ANT and WC1 reached the homepage), and 217 of 2,151 on 2026-10-21, when
  the `/politicians` most-declared table also linked ERL, a 404. Fixing it is
  a product call: render a company page without short data, or only link
  codes that have one.
- **Thin programmatic sections.** `/compare/*` (123 pages, 4 clicks in 28
  days) and `/glossary/*` (67 pages, 2 clicks, entries of 130-150 words) on
  2026-10-15. Prefer noindexing or merging over adding more pages of a type
  that does not earn clicks.
- **Head-term cannibalisation.** `/` and `/top` both target "most shorted ASX
  stocks". `siteConfig.fullTitle` keeps that phrase on the homepage on
  purpose (see the comment in `@/config/site.ts`); changing it is a ranking
  bet for the owner to make, not a cleanup.
- **Cloudflare features that rewrite HTML.** Email Obfuscation turned every
  `mailto:` into a 404ing `/cdn-cgi/l/email-protection` link; it is off in
  `terraform/modules/cloudflare-edge/main.tf`. Check the crawl for
  `/cdn-cgi/` targets after any zone setting change.
- **Slow pages.** The crawl's `slow-response` list (over about 1.5s). Rarely
  visited ISR pages are slow on a cache miss, and crawlers mostly hit cold
  pages. Hand real performance work to `perf-optimization`.
- **Fixed-size images.** `next/image` with a fixed width and height plus
  `sizes` lists all 16 widths, 16w to 3840w: a 20 px logo carried 2 KB of
  `srcSet`, and `/reports/weekly` 747 KB. Drop `sizes` for a 1x/2x pair; a
  `fill` image gets a fixed width and height instead
  (`components/reports/__tests__/stock-logo-img.test.tsx`).

## 3. Fix

- Metadata changes need a test that pins the rendered metadata, not the
  helper (`app/shorts/[stockCode]/__tests__/page-metadata.test.tsx` is the
  pattern). Source-scan tests are fine for "this file must not contain X"
  guards where importing the module would pull fonts or providers into Jest.
- Run `npx jest <paths>` and `npx tsc --noEmit` in `web/` before pushing.
- If a change touches a measurement that is in flight (the latest audit's
  "What remains"), say in the audit that the baseline moved.

## 4. Record

Add the round to the current month's `docs/seo-audit-YYYY-MM.md` (create it
if the month has none) with: the Search Console window and headline numbers,
the crawl date and scope, each finding with its evidence (query, page,
numbers), what shipped with file paths, and what remains. Keep numbers dated;
the next round compares against them.
