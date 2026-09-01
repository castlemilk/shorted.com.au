# SEO Audit — August 2026 (OpenSEO crawl + competitor re-assessment)

**Follows:** `docs/seo-strategy-2026-07.md`. That document is the strategy; this
one records what actually shipped, what a fresh 200-page crawl found, and where
the competitive field moved in six weeks.

**Method:** self-hosted [OpenSEO](https://github.com/every-app/open-seo) (Docker,
`ghcr.io/every-app/open-seo:latest`, MCP driven over `localhost:3011/mcp`), run
**without a DataForSEO key**. That is not a partial setup — it is a hard split in
what the tool can do, and it decides what below is measured vs. inferred:

| Works keyless | Needs DataForSEO |
|---|---|
| `run_site_audit` (own crawler), `get_audit_issues`, `get_audit_pages`, project context | `research_keywords`, `get_domain_overview`, `get_backlinks_overview`, `get_serp_results`, rank tracking |

So the **crawl findings below are measured**; everything about volume,
difficulty, backlinks and exact rank is not, and SERP claims here come from
US-localized web search (same caveat as §9 of the July doc — AU positions for a
`.com.au` are likely somewhat better).

---

## 1. Crawling our own site requires the Vercel origin

`shorted.com.au` returns **HTTP 403 `cf-mitigated: challenge`** to any
non-browser client — Super Bot Fight Mode, set in the Cloudflare dashboard, not
Terraform (July §3.5). Verified Googlebot is exempt and indexation is healthy,
so this is **not** a ranking problem. It does mean no SEO tool can crawl prod.

The audit therefore ran against the Vercel production origin
(`shorted-com-*.vercel.app`), which is not behind Cloudflare. Two consequences,
both artifacts rather than defects, and both must be discarded from any future
run of this kind:

- `noindex-page: 198` — Vercel stamps `x-robots-tag: noindex` on deployment URLs.
- `canonicalized-page: 198` — our canonicals correctly point at `shorted.com.au`.

Discovery files are **no longer challenged** — `/feed.xml`, `/sitemap.xml`,
`/robots.txt` and `/llms.txt` all return 200 to a feed-reader UA. July §3.5's
"RSS is dead to every non-verified feed reader" is resolved. Only HTML pages are
challenged.

*Untested:* whether PerplexityBot (Cloudflare-de-verified Aug 2025) clears the
challenge. Our robots.txt explicitly invites it, so the invitation and the edge
may still disagree. This cannot be tested from outside Perplexity's IP ranges —
check server-side logs, don't infer it from a UA spoof.

---

## 2. The July plan largely shipped — verified, not assumed

Every item below was checked against live HTML, not a status line:

| July item | State |
|---|---|
| §3.1 weekly generator stale (W25 of W29) | **Fixed** — week 35 live, today is week 36; 165 report URLs sitemapped |
| §4.3 human-readable report slugs | **Shipped** — `/reports/weekly/10-most-shorted-asx-stocks-week-35-2026` |
| §3.2 stock pages thin + `no-store` | **Fixed** — `/shorts/PLS` 278KB (was ~2.8k chars), `public, max-age=0, must-revalidate`, Vercel `HIT`, TTFB 0.26s warm |
| §4.2 stock title retarget | **Shipped** — `LOT Short Interest — Lotus Resources (ASX:LOT) \| 22.80% Shorted \| Shorted` |
| §4.7 `/statistics` citation magnet | **Shipped** — live, `Dataset` + `DataDownload` schema |
| §4.4 `/battlegrounds` discovery | **Shipped** — retitled "ASX Short Squeeze Candidates", in `sitemap-core.xml` |
| §3.3 nav signin equity leak | **Fixed in nav/footer** — they now `router.push` rather than bake an href. **Not fixed in `intel-lock.tsx`** — see §3 |
| §0.1 W28 soft-404 | Resolved |

Movement since July, on the two clusters the plan targeted:

- **"most shorted asx stocks"** — shorted.com.au now appears on page 1 (July: #8).
- **"asx short interest"** — now visible (July: #9).
- **Per-ticker "{company} short interest"** — `/shorts/LOT` now ranks on page 1
  against stocktrack and shortinterest.au. July recorded this cluster as
  **"absent (1,600 pages exist!)"**. This is the single clearest win, and it
  validates the title retarget: the live `22.80% Shorted` renders in the SERP
  title as a freshness signal.

---

## 3. What the crawl actually found

200/200 pages crawled, 767 issues. Discarding the two origin artifacts (§1):

| Issue | Count | Verdict |
|---|---|---|
| `/signin` index bloat | ~1,600 URLs | **Real, fixed — see below** |
| Meta description > 160 chars | 168 | Cosmetic — see §4 |
| Title > 60 chars | 144 | Cosmetic — see §4 |
| Slow response (2.5–3.3s) | 34 | **Misleading** — these were cold ISR renders during the crawl; warm TTFB is 0.10–0.26s on Vercel `HIT`. Real only insofar as a 1,642-page crawl hits many cold pages |
| Multiple H1 | 1 (`/blog`) | Trivial |
| Heading level skips | 15 | Trivial (a11y polish) |

### The one finding worth acting on: `/signin` was indexable and fanned out

`intel-lock.tsx` renders a sign-in CTA on **every locked module** with a
per-page `?callbackUrl=`, so the route fanned out into ~1,600 near-identical
crawlable URLs — one per stock page, plus housing/politician/economy variants.
Measured: the crawler spent **7 of its 200-page budget** on
`/signin?callbackUrl=%2Fshorts%2F*` before reaching real content.

Both `/signin` and `/signup` had no layout of their own, so they:

- shipped `index, follow`, and
- inherited the **root** `alternates.canonical`, declaring
  `https://shorted.com.au` — the homepage — as their canonical URL.

This site has already lost a crawl budget to junk paths once: per
`robots.txt/__tests__/robots-rpc-disallow.test.ts`, 56.7% of Googlebot hits were
going to Connect-RPC endpoints (measured 2026-08-23). Same failure mode, new
path.

**Fixed** in `web/src/app/signin/layout.tsx` + `signup/layout.tsx`
(`noindex, nofollow` + self-canonical) and `intel-lock.tsx` (`rel="nofollow"` on
the CTA). Verified in a running dev server, not just unit-tested. Regression
coverage: `web/src/app/__tests__/auth-routes-noindex.test.ts`.

**Deliberately not a robots.txt `Disallow`.** A disallowed URL can never be
crawled to see its `noindex`, which would strand any variant Google has already
indexed. Crawl-and-noindex is the de-indexing path; the `nofollow` is what
protects the budget.

---

## 4. What the crawl flagged that is not worth fixing

Recorded so it does not get "found" and actioned again next quarter.

- **Meta descriptions (168 pages, 170–255 chars).** All are front-loaded — the
  first ~155 chars carry the whole value proposition, so truncation costs
  almost nothing, and meta description is not a ranking factor. Rewriting 168
  templated descriptions is churn.
- **Titles (144 pages, 61–86 chars).** Keywords are front-loaded; what
  truncates is the trailing `| Shorted` brand suffix. The stock-page title
  format is a *deliberate* July decision (live % as a SERP freshness signal)
  and it is now demonstrably working (§2). Do not "fix" it by shortening.

---

## 5. Competitive field — what moved since July

| Site | July | Now |
|---|---|---|
| **shortman.com.au** | Incumbent citation; 0 schema, technically hollow | **Unchanged** — 11.6KB homepage, still zero JSON-LD. Moat remains links, not product |
| **shortinterest.au** | #1 "asx short interest"; **"No schema"** | **Now ships `Dataset`, `DataDownload`, `FAQPage`, `Answer`, `ContactPoint`** |
| **asxshort.app** | #1 "short squeeze asx stocks" | **Now ships `FAQPage`, `FinancialService`, `Answer`** |
| **marketindex.com.au** | Strongest all-rounder | Unchanged strategically; now also behind a Cloudflare challenge |
| **stocktrack.com.au** | Ranked on stale data | Still ranking per-ticker; now current (20 Aug data) — the July "7 weeks stale" opening has **closed** |
| **asxshorts.com** | not in July teardown | **New entrant** — squeeze-alert positioning (short interest ≥10% + days-to-cover), 392KB, no schema |

**The read:** our structured-data lead is eroding — it was a differentiator in
July and is now table stakes among the specialists. Two caveats before anyone
races to add `FAQPage` everywhere:

1. Google **restricted FAQ rich results to authoritative government and health
   sites in August 2023**. Competitors' `FAQPage` markup is almost certainly
   *not* earning them rich results.
2. The real value is **AI answer extraction**, and the July audit already
   observed AI summaries quoting our live numbers. That is the channel to
   defend, and it is a reason to keep `/statistics` and the discovery files
   healthy — not a reason to bulk-add FAQ markup.

Meanwhile stocktrack's freshness gap closing means **freshness alone is no
longer a per-ticker differentiator**. Depth (full history since 2010) and the
narrative/peer/news modules are.

---

## 6. What actually remains

The July diagnosis still holds and is now sharper: **technical SEO is no longer
the constraint — authority is.** Phase 0 and most of Phase 1 shipped, the
per-ticker cluster is ranking, and this crawl surfaced exactly one real defect
across 200 pages.

Ranked by expected effect:

1. **Authority / citations (July §5) — unblocked and untouched.** `/statistics`
   now exists, which was the prerequisite for the journalist-outreach play.
   Referring domains was ~2 in July with a 3-month target of 10. Nothing in
   this audit moves it; it is not a code task.
2. **Confirm PerplexityBot's actual treatment** at the edge (§1) — server-side
   logs, not UA spoofing.
3. **Codify SBFM in Terraform** (July §0.5, still open). A dashboard flip of
   `sbfm_verified_bots` to block would be invisible to `terraform plan` and
   would deindex the site.
4. **Phase 3 features** — short-crossover scan pages remain the
   highest-value/lowest-effort differentiated surface.

**Do not** re-run a keyless OpenSEO audit expecting new technical findings; this
one returned a single actionable defect. The next useful OpenSEO run is a
**keyed** one, for the backlink and keyword data that speaks to constraint #1.
