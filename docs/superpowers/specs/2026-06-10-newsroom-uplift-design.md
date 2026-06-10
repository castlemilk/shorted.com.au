# Newsroom Uplift — Design Spec

**Date:** 2026-06-10
**Branch:** `feat/investigative-newsroom`
**Status:** Approved design, pending implementation plan

## Goal

Uplift the Shorted investigative newsroom from "AI takes with images" to a credible
digital masthead: MDX-powered data-journalism articles grounded in short data,
historical prices, and financial reports; a newspaper-grade front page; deduplicated
wire coverage; topical photojournalistic imagery; and a project skill that codifies
the whole operating loop for future runs and continuous improvement.

Five workstreams:

1. Duplicate cleanup & prevention (wire feed)
2. Article generation — editorial data spine + MDX output
3. Masthead UI redesign (`/news`, `/news/[slug]`)
4. Image generation uplift (topical heroes, photographic craft)
5. `newsroom` project skill

## Decisions taken (with user)

| Decision | Choice |
|---|---|
| UI scope | Full masthead redesign of `/news` front page + article page |
| Bylines | Desk byline + beat (e.g. "The Shorted Desk — Mining & Resources"); no fake human personas |
| Data viz | Real charts + stat callouts embedded in articles from live DB data |
| Hero images | Topical photojournalistic hero; abstract dark-amber brand art retained for OG/social cards only |
| Article format | **MDX** with a whitelisted component palette, compiled at request time from DB content |

## Current state (verified 2026-06-10)

- **Pipeline** (`scripts/take-writer/`): editor → investigator (Gemini function-calling
  over drilldown tools) → writer (`narrative.ts`) → art-director → cohesion validator.
  Grounding via `CitationLedger`; `compactCitations` + `shouldHoldAsDraft` enforce
  ledger-only citations. Models default `gemini-3.5-flash`; images via gpt-image-2 → GCS.
- **Data available**: `shorts` (365d), `stock_prices` (365d), `news_articles` (90d),
  `director_trades` (180d), peers (`mv_top_shorts`), `financial_report_extractions.metrics`
  JSONB via `report_line` (one metric per call), `company-metadata`.
- **Duplicates**: ingestion dedupes by `UNIQUE(url)` only (`store.go`). A 3-gram headline
  clustering job exists (`clustering.go`, migration 000033: `cluster_id`,
  `cluster_is_primary`, `v_news_clusters`) but runs only as a manual
  `RUN_MODE=cluster-news` job and the `/news` feed renders raw rows — so syndicated
  Nine-masthead pairs (SMH / The Age) display twice.
- **UI**: `web/src/app/news/page.tsx` (hero + take grid + day-grouped article cards),
  `web/src/app/news/[slug]/page.tsx` + `take-body.tsx` (react-markdown, citation pills,
  magazine layout images via `anchorAfterBlock`). Dark/amber theme, sans-serif.
- **Hero image**: intentionally abstract brand art (dark `#0a0a0a` / amber `#FFA94D`),
  also used for OG cards.

## Workstream 1 — Duplicate cleanup & prevention

**Prevention (aggregator)**
- Run the existing shingle clustering inline at the end of every aggregation run in
  `services/news-aggregator` (after `StoreArticles`), instead of requiring the separate
  manual `cluster-news` run mode. Keep the standalone mode for backfills.
- Clustering logic itself is unchanged (3-gram shingles, ≥3 shared, same stock, 12h window).

**Cleanup (one-off)**
- Backfill pass: run clustering over the full `news_articles` history (window widened for
  the backfill only), so existing SMH/Age duplicates get clustered.

**UI**
- The `/news` wire feed queries cluster primaries only (`cluster_is_primary = TRUE` or
  un-clustered rows), with a source-count chip on cards when `source_count > 1`
  (e.g. "SMH · also in The Age"). No rows are deleted; secondary articles remain
  reachable as "Also covered by" links on hover/detail.
- The feed's data path (the server action / RPC behind `web/src/app/news/page.tsx` —
  pinned during planning) defaults to primaries-only, exposing `source_count` and
  secondary sources per cluster via `v_news_clusters`.

**Pipeline**
- Investigator drilldowns `search_news` / `news_detail` prefer cluster primaries so a
  dossier never cites the same syndicated story twice.

## Workstream 2 — Article generation: data spine + MDX

### MDX storage & rendering
- `editorial_takes.body` stores MDX. New column `body_format` (`markdown` | `mdx`,
  default `markdown`) so all existing takes render exactly as before. Migration applied
  **directly to prod via psql** (`ADD COLUMN IF NOT EXISTS`) per the known
  schema_migrations drift gotcha; also added to `services/migrations/` for the record.
- New columns `standfirst TEXT` and `byline TEXT` (small, needed outside the body for
  front page / SEO / OG). These replace the earlier `article_meta` JSONB idea — pull
  quotes, stats, and charts live in the MDX body instead.
- `EditorialTake` proto gains `body_format`, `standfirst`, `byline` fields; Go store maps them.
- Rendering: `next-mdx-remote` (RSC variant) in the article page server component —
  content comes from the DB at request time so build-time `@next/mdx` does not apply.
  Components resolve against an explicit whitelist map; anything outside it does not render.

### Component palette (writer's vocabulary)
Lives in `web/src/@/components/news/mdx/` as one registry exporting:
1. the React component map (for `next-mdx-remote`), and
2. a JSON manifest (name + prop schema + usage guidance) consumed by the writer prompt
   and the pipeline compile gate.

| Component | Purpose |
|---|---|
| `<ShortInterestChart code window />` | visx short-interest vs price chart; data fetched server-side via existing actions |
| `<PriceChart code window />` | price/volume chart |
| `<StatGroup>` / `<Stat label value context cite />` | key-numbers callout box; `cite` ties to a ledger refId |
| `<PullQuote>` | editorial pull quote |
| `<Figure src caption credit placement />` | art-directed layout images placed explicitly inline (replaces `anchorAfterBlock` index math for MDX takes) |
| `<Timeline>` / `<TimelineEvent date label cite />` | event sequences from `align_events` output |

Citation pills keep the existing `[ref-N]` text-pattern handling — the grounding model
(ledger-only refs, `compactCitations`, hold-as-draft) is unchanged.

### Pipeline compile gate (load-bearing)
- The writer prompt teaches the palette from the JSON manifest with strict prop schemas.
- Before publish, the pipeline compiles the MDX with the same compiler the site uses and
  validates every component instance against zod prop schemas.
- Chart/stat props are verified against real data: stock code exists, window valid,
  cited refIds present in the ledger.
- Invalid MDX → auto-strip to plain markdown fallback (publish with `body_format=markdown`);
  if stripped components were semantically essential (e.g. the only data evidence),
  `shouldHoldAsDraft` holds the piece.

### Data spine (investigator + writer)
- New drilldown `get_financials(stock, n)`: returns the last *n* reports' full
  key-metric sets from `financial_report_extractions` in one call (vs `report_line`'s
  one metric per call). Each report registered in the ledger as a `report` source.
  `report_line` remains for targeted single-metric follow-ups.
- Investigator instructions: every dossier must include (a) the short-interest
  trajectory, and (b) at least one financial-report citation when extractions exist
  for the stock.
- Writer (`narrative.ts`) emits: `standfirst`, `byline` (desk + beat derived from the
  company's industry), and an MDX body. Voice tuned to masthead register: standfirst
  discipline, concrete numbers in the first three paragraphs, at least one
  `<ShortInterestChart>` and one `<StatGroup>` per article, pull quotes where earned,
  no hedging filler.

## Workstream 3 — Masthead UI redesign

All components shadcn-based; dark/amber theme retained; serif display typography
(via `next/font`) layered on for editorial voice. Existing route structure unchanged.

**Front page (`/news`)**
- Masthead header with section identity + date.
- Market-pulse strip: top short movers (existing data/actions).
- Lead story: full-width topical hero, standfirst, byline, beat tag.
- Secondary story stack (2–4 recent takes) + beats rail.
- "The Wire": deduplicated aggregated feed (cluster primaries), compact day-grouped
  list with source-count chips, sentiment accents retained.

**Article page (`/news/[slug]`)**
- Header: beat tag, headline, standfirst, desk byline, date, reading time.
- Captioned topical hero with "AI-generated illustration" credit line.
- Body: MDX render (drop cap on first paragraph, pull quotes, charts, stat boxes,
  figures with captions); citation pills as today.
- Footer: "Sources" section (ledger citations as a proper list), related coverage from
  the same news cluster, related takes.
- Legacy markdown takes render through the existing `take-body.tsx` path unchanged.

## Workstream 4 — Image generation uplift

- **Topical hero**: the art-director plans the hero as image #1 of its plan —
  photojournalistic, content-grounded (real project / place / material from the dossier),
  landscape, rendered at high quality tier, with caption + credit. Stored in
  `hero_image_url` as today, plus new `hero_caption TEXT` and `hero_credit TEXT` columns
  (same migration as `body_format`/`standfirst`/`byline`).
- **OG/social cards**: keep the abstract dark-amber brand treatment — generated via the
  existing brand-prompt path, decoupled from the article hero.
- **Craft**: expand the style library in `art-director.ts` with photographic language
  (lens, lighting, composition vocabulary) and per-style negative constraints.
- **Validation**: the cohesion validator now includes the hero in judging (it currently
  ignores it by design) and judges the rendered MDX page (charts/components included).

## Workstream 5 — `newsroom` project skill

`.claude/skills/newsroom/SKILL.md` — the operating manual for running and improving the
newsroom. Contents:
- Pipeline architecture summary + grounding invariants that must never break
  (ledger-only citations, compile gate, hold-as-draft).
- Commands: `newsroom-preview`, `newsroom-daily [--auto-publish] [--with-images]`,
  `regen-images --slug=X`, `validate-article --slug=X [--rounds=N]`.
- Secrets/ADC gotchas (GEMINI_API_KEY, OPENAI_API_KEY/DATABASE_URL via gcloud secrets,
  legacy ADC for GCS writes), prod migration drift rules.
- MDX palette: how to add a component (registry map + JSON manifest + writer prompt).
- Quality rubric + the improvement loop: preview → judge → tune prompts → validate → publish.
- Dedup/backfill runbook for the aggregator.

## Testing

- **vitest** (`scripts/take-writer`): MDX compile gate (valid palette passes, unknown
  component stripped, bad chart props rejected, essential-component strip → draft hold),
  `get_financials` drilldown, writer envelope parsing.
- **Go**: clustering-inline change in news-aggregator; feed query returns primaries only.
- **Frontend**: type check + unit tests for the MDX registry; existing take-body tests
  stay green (legacy path untouched).
- **End-to-end**: `newsroom-preview` on a real stock; generate one full article on a
  test slug; `validate-article` pass; visual review of `/news` front page.

## Sequencing

1. Dedup (aggregator inline clustering + feed query + backfill) — independent quick win.
2. MDX foundation: DB columns + proto + registry + renderer + compile gate.
3. Writer/investigator data-spine changes (emit MDX, `get_financials`).
4. Masthead UI (front page, article page).
5. Image uplift (topical hero, OG decoupling, validator update).
6. Skill doc (written last so it documents what actually shipped).

## Risks / notes

- Prod DB migration drift: never `make migrate-up`; apply via psql with `IF NOT EXISTS`.
- `next-mdx-remote` must not pull `@connectrpc/connect` into SSR paths (known SSR
  landmine); chart components fetch via server actions / client-side hooks per the
  existing SSR-safety rules.
- LLM-emitted MDX is untrusted input even though the pipeline is ours: the component
  whitelist + zod prop validation is the security boundary (no arbitrary JSX/imports —
  compile gate rejects `import`/`export` statements and unknown elements).
- Daily cron remains unprovisioned (out of scope here; unchanged from PR #147 state).
