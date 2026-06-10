---
name: newsroom
description: Operate and improve the Shorted investigative newsroom — generate, validate, publish, and iterate on MDX editorial takes. Use when running newsroom-daily/preview, regenerating images, fixing article quality, extending the MDX component palette, or debugging duplicates in the wire feed.
---

# Shorted Investigative Newsroom

Operating manual for `scripts/take-writer/` (Gemini agentic pipeline → `editorial_takes` → `/news`) and the wire-feed dedup in `services/news-aggregator/`.

## 1. Architecture

Pipeline (one assignment, `newsroom-daily`):

```
editor (signal board + novelty gate, commissions angle + tier)
  → investigator (Gemini function-calling over drill-down tools; every retrieved
    source registered in the CitationLedger with a stable ref-N)
  → writer synthesiseFromDossier (MDX body + headline + standfirst; banned-phrase retry)
  → compactCitations (renumber/drop markers) → MDX compile gate
  → art-director (1 topical hero + 3 layout images) + brand OG image
  → insert into editorial_takes (hold-as-draft on weak grounding)
  → [separately] validate-article: Gemini-vision cohesion judge + auto-fix loop
```

- **Editor** (`editor.ts`): builds the signal board (pool 30), applies the pure novelty gate `hasNewDevelopment` — covers a stock only if never covered OR a price-sensitive headline / director trade post-dates the last take OR |Δ90d short| ≥ 2.0pp. Gemini (`EDITOR_MODEL`, default `gemini-3.5-flash`) commissions up to `MAX_TAKES_PER_DAY` (10) takes + `MAX_DEEPDIVES_PER_DAY` (2) deep-dives, caps enforced defensively in code.
- **Investigator** (`investigator.ts`, `tools.ts`, `drilldowns.ts`): tool loop, turn-capped (`MAX_TURNS_TAKE`=6, `MAX_TURNS_DEEPDIVE`=14; prompt says ≤4 / ≤10 investigative calls). Tools: `get_overview` (MUST be called first; Shorted's own numbers, registers NO citations), `get_financials`, `zoom_window`, `report_line`, `follow_peer`, `align_events`, `news_detail`, `search_news`, plus `emit_dossier` (exactly once). Mandates baked into the system prompt: state the short-interest trajectory; call `get_financials` and include ≥1 report citation when filings exist; an `emit_dossier` with an empty ledger is REJECTED in-loop and the agent is forced to gather sources.
- **Writer** (`narrative.ts` `synthesiseFromDossier`): `WRITER_MODEL` / `WRITER_MODEL_DEEPDIVE` (default `gemini-3.5-flash`). Structured-JSON output (4 sections for takes; 3-5 headed sections, 600-1200 words for deep-dives) + headline + standfirst. Up to 2 attempts if `findBanned()` hits — the sweep covers headline AND standfirst, not just body. Slug is derived deterministically from the headline (code-prefixed kebab), not an LLM call.
- **Art-director** (`art-director.ts`): plans 4 images (`designImagePlan`, `ART_DIRECTOR_MODEL` default `gemini-3.5-flash`), roles `hero` | `inline`, exactly-one-hero enforced by `normalisePlanRoles`. Styles: documentary, aerial, still_life, isometric, archival, abstract, environmental. Hero renders gpt-image-2 **high** quality landscape → `takes/{slug}-hero.png` (~$0.25); inline at medium (~$0.08 each) → `takes/{slug}-layout-N.png`.
- **Validator** (`validator.ts`): see §5.

### File map — `scripts/take-writer/src/`

| File | Role |
|---|---|
| `index.ts` | CLI entrypoint (THE entrypoint — not `run.ts`); commands + flags |
| `newsroom.ts` | `runNewsroomDaily` / `runNewsroomPreview` / `regenerateImages` / legacy `runNewsroom`; image flow; DB inserts |
| `editor.ts` | Novelty gate + assignment commissioning |
| `investigator.ts` | Agentic tool loop, `emit_dossier`, empty-ledger rejection |
| `tools.ts` / `drilldowns.ts` | Gemini tool declarations + SQL drill-downs; `dispatchTool` registers sources into the ledger |
| `ledger.ts` | `CitationLedger` + `compactCitations` (grounding spine) |
| `narrative.ts` | Writer prompts/schemas, `MDX_PALETTE_DOC` copy, banned phrases, gate wiring |
| `mdxgate.ts` | MDX compile gate: whitelist + zod props + compile check + `stripMdxComponents` |
| `art-director.ts` | Image plan, style prompts, hero/layout/single-image generation |
| `validator.ts` | Screenshot + Gemini-vision cohesion judge + auto-fix loop |
| `byline.ts` | `deskByline(industry)` → "The Shorted Desk — <Beat>" |
| `journalism.ts` / `agenda.ts` / `persona.ts` / `run.ts` / `discover.ts` | Legacy narrative/agenda paths (`newsroom`, `narrative`, `run`, `draft` commands) |

### Frontend render path

`web/src/app/news/[slug]/page.tsx` branches on `take.bodyFormat === "mdx"`:
- **mdx** → `MdxTakeBody` (`web/src/@/components/news/mdx-take-body.tsx`): `[ref-N]` markers preprocessed to `<Cite/>`, compiled via `next-mdx-remote/rsc` against the whitelist registry (`mdx/registry.tsx`; charts are `dynamic({ssr:false})` because connect-web). Compile failure falls back to the legacy markdown renderer at runtime.
- **markdown** → legacy `take-body.tsx` (untouched; react-markdown + citation pills).

`/news` index (`web/src/app/news/page.tsx`) is the masthead: `MastheadHeader`, `MarketPulse`, `LeadStory`, `StoryStack`, `WireList` (ISR `revalidate = 600`).

## 2. Grounding invariants (NEVER break)

1. **Ledger-only citations.** The writer may cite only `ref-N` ids registered in the `CitationLedger` by an actual tool retrieval. The investigator cannot invent refs; `compactCitations` drops anything not in the ledger.
2. **`compactCitations` is the single remap.** It renumbers BOTH bracketed `[ref-N]` prose markers AND `cite="ref-N"` MDX component props in one first-appearance-ordered pass (combined `[ref-1, ref-2]` markers are expanded first). Unknown ids: bracketed markers are deleted; dangling `cite=` props have the attribute removed (component kept). A source cited ONLY via a `cite=` prop still enters the `citations` array.
3. **MDX gate** (`validateMdx`): component whitelist, zod prop schemas, chart `code` verified against known stocks (subject + overview peers), `cite=` verified against the post-compact ledger refs, `import`/`export`/`<script>` forbidden, then a real `@mdx-js/mdx` compile. ANY failure → `stripMdxComponents()` + `body_format='markdown'` (degrade, never ship broken MDX). Gate passes with `componentCount === 0` → also `'markdown'` (no MDX render path needed).
4. **Hold-as-draft** (`shouldHoldAsDraft`): any dropped citation OR zero citations → never auto-publish; a human reviews at `/admin/takes`. Note: this gates markers resolving, not every claim being cited.
5. **Overview numbers are Shorted's own** (short %, slopes, price moves, correlation, peer-relative) — stated in prose WITHOUT a `[ref-N]` citation. `get_overview` deliberately registers nothing in the ledger.
6. Re-runs are idempotent on slug: `ON CONFLICT (slug)` preserves `published_at` (a reviewed draft's publish state never flips silently) and keeps existing images via `COALESCE`.

## 3. Commands

Env setup (all commands run from `scripts/take-writer`):

```bash
cd scripts/take-writer
export GEMINI_API_KEY=$(grep '^GEMINI_API_KEY' ../../.env | cut -d= -f2)
export DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 --account=ben@shorted.com.au)
export OPENAI_API_KEY=$(gcloud secrets versions access latest --secret=OPENAI_API_KEY --project=rosy-clover-477102-t5 --account=ben@shorted.com.au)   # images only
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/gcloud/legacy_credentials/ben@shorted.com.au/adc.json  # images only (GCS write)
```

Entrypoint is `npx tsx src/index.ts <command>` (NOT `run.ts`).

| Command | What it does | Notes / cost |
|---|---|---|
| `newsroom-preview --stock=CODE [--tier=deep_dive] [--angle="..."]` | Investigate ONE stock, print dossier + headline/standfirst/byline + body (with format) + sources + hold decision. **No DB write, no images** — safe against prod. | Token cost only. Preview byline always "— Markets" (industry not fetched). |
| `newsroom-daily [--auto-publish] [--with-images] [--no-images] [--pool=N] [--top=N]` | Full run: editor → investigate → write → insert. `--top` overrides max takes. Images default ON when `--auto-publish` (unless `--no-images`), OFF for drafts. | Per article with images: OG $0.075 + hero $0.25 + 3 layout $0.24 ≈ $0.57. Held drafts still get images if enabled. |
| `regen-images --slug=SLUG [--inline=N]` | Regenerate images for an existing take: brand OG (`-og.png`) + art-directed topical hero (high quality, `-hero.png`) + 3 layout images. Legacy inline images generated ONLY when the art-director plan fails (frontend ignores `inline_images` when `layout_images` is non-empty). Hero falls back to the OG image if the topical render fails. | ~$0.55–0.75 |
| `validate-article --slug=SLUG [--rounds=N]` | Screenshot the live page (Playwright, optional — degrades to per-image judging if chromium missing or `VALIDATOR_SCREENSHOT=0`), Gemini-vision judges cohesion + the hero (as a masthead lead image) + every layout image, then auto-regenerates anything flagged and re-judges. Default 2 rounds. | ~$0.08–0.33 per regenerated image |
| `newsroom [--auto-publish] [--with-images] [--top=N]` | Legacy agenda→narrative loop (no investigator/ledger; brand image doubles as hero). | Prefer `newsroom-daily`. |
| `agenda`, `narrative --stock=CODE`, `discover`, `draft`, `run` | Older single-purpose paths; still wired but not the investigative pipeline. | |

### Daily operating flow (draft → review → publish → tweet)

1. **Cron drafts** the takes each weekday morning (text only — no images, cheap, reviewable):
   ```
   30 7 * * 1-5  /Users/benebsworth/projects/shorted/scripts/take-writer/bin/newsroom-cron.sh >> $HOME/Library/Logs/shorted-newsroom.log 2>&1
   ```
   The script (`bin/newsroom-cron.sh`) self-sources `GEMINI_API_KEY` from repo `.env` and `DATABASE_URL` from Secret Manager, then runs `newsroom-daily --top=3`.
2. **Review** in the terminal:
   - `npx tsx src/index.ts list-drafts` — aligned table of unpublished drafts (slug, tier, images, citation count) with copy-paste publish commands.
   - `npx tsx src/index.ts list-drafts --slug=SLUG` — full markdown body + citations for one draft.
3. **Publish**: `npx tsx src/index.ts publish --slug=SLUG --tweet` — chains:
   - images: `regenerateImages` iff hero missing / layout empty / hero is the brand-OG fallback (skip with `--no-images`)
   - validate: `validate-article` 1 round, per-image mode (`VALIDATOR_SCREENSHOT=0` — draft page isn't live); judge failures warn but never block (skip with `--no-validate`)
   - flips `published_at = COALESCE(published_at, NOW())`
   - `--tweet`: spawns `scripts/twitter` `process-publish-queue --live --slug=SLUG` (queue only tweets published+untweeted takes, so re-runs can't double-tweet; a failed tweet prints the manual retry command).
4. Article is live at `/news/SLUG` (ISR ≤10 min) and posted to @shorted___.

Model env knobs: `EDITOR_MODEL`, `INVESTIGATOR_MODEL_TAKE`/`_DEEPDIVE`, `WRITER_MODEL`/`_DEEPDIVE`, `ART_DIRECTOR_MODEL`, `VALIDATOR_MODEL`, `INLINE_BRIEF_MODEL` — all default `gemini-3.5-flash`. `MAX_TURNS_TAKE`=6, `MAX_TURNS_DEEPDIVE`=14, `MAX_TAKES_PER_DAY`=10, `MAX_DEEPDIVES_PER_DAY`=2. (Known wart: `newsroom.ts` records `gemini-2.5-flash` in the DB `model` column when `WRITER_MODEL` is unset, but the writer actually runs `gemini-3.5-flash`.)

## 4. MDX palette

| Component | Props | Use |
|---|---|---|
| `<ShortInterestChart />` | `code` (^[A-Z0-9]{2,5}$), `window?` 1m\|3m\|6m\|1y | Short interest vs price. One per article, after the data discussion. REQUIRED in every take. |
| `<PriceChart />` | `code`, `window?` | Price/volume only, when price action is the story |
| `<StatGroup>` | (none) | Wrapper for 2-4 `<Stat>`s. REQUIRED in every take. |
| `<Stat />` | `label`, `value`, `context?`, `cite?` (^ref-\d+$) | Every value must come from sources or provided data |
| `<PullQuote>` | (none, children) | One striking sentence from the article's own prose |
| `<Figure />` | `src` (url), `caption?`, `credit?`, `placement?` full\|left\|right\|inset | Image embed |
| `<Timeline>` | (none) | Wrapper; only for genuine sequences (3+ events) |
| `<TimelineEvent />` | `date` (YYYY-MM-DD), `label`, `cite?` | One event |

Rules the writer is given: components on their own lines, never inside headings/lists; cite only ledger ref-N; no other components, no imports, no HTML.

### THE THREE-PLACE SYNC RULE

The palette is defined in three places that MUST stay in sync:

1. **Web manifest** — `web/src/@/components/news/mdx/manifest.ts` (zod `MDX_COMPONENT_SCHEMAS` + `MDX_PALETTE_DOC`)
2. **Pipeline gate** — `scripts/take-writer/src/mdxgate.ts` (`COMPONENT_SCHEMAS`)
3. **Writer prompt** — `scripts/take-writer/src/narrative.ts` (`MDX_PALETTE_DOC` copy — take-writer cannot import from `web/`)

(Minor existing drift: the web manifest uses `.default()` where the gate uses `.optional()` — semantically equivalent for validation.)

### Adding a component

1. Implement in `web/src/@/components/news/mdx/` and export from `registry.tsx`. Anything touching connect-web/browser APIs must be `"use client"` and loaded via `dynamic(..., { ssr: false })` in the registry (see the charts).
2. Add its zod schema to `manifest.ts` + describe it in the manifest `MDX_PALETTE_DOC`.
3. Mirror the schema in `mdxgate.ts` `COMPONENT_SCHEMAS`.
4. Mirror the doc line in `narrative.ts` `MDX_PALETTE_DOC`.
5. Update tests: `web/src/@/components/news/mdx/__tests__/manifest.test.ts` (jest) and `scripts/take-writer/src/mdxgate.test.ts` (vitest).
6. Run both: `cd web && npx jest manifest` and `cd scripts/take-writer && npm test`.

## 5. Quality rubric + improvement loop

1. **Preview**: `newsroom-preview --stock=CODE`. Judge:
   - Standfirst concrete? (≤30 words, real numbers, no clickbait)
   - `<ShortInterestChart>` placed AFTER the data discussion, not at the top?
   - `<StatGroup>` values actually grounded in sources/overview data?
   - Voice: no hedging filler ("it remains to be seen"), figures not spelled out ($600M not "six-hundred million"), headline leads with the short-story observation, sentence case, no AI-tell verbs (Reacts to / Faces).
   - Grounding line: 0 dropped, ≥1 citation, the "would auto-publish" decision.
2. **Tune prompts** when output misses: writer voice/structure → `narrative.ts` `NARRATIVE_SYSTEM_PROMPT`, `basePrompt` in `synthesiseFromDossier`, `HEADLINE_DESC`/`STANDFIRST_DESC`, `BANNED_PHRASES`; investigation depth → `investigator.ts` `systemPrompt`; visuals → `art-director.ts` `ART_SYSTEM` / `STYLE_PROMPTS`. Remember: the banned-phrase retry sweeps the standfirst and headline too — add new tells to `BANNED_PHRASES`, not just the prose prompt.
3. **Images**: `regen-images --slug=X`, then `validate-article --slug=X`. The validator judges the hero as a masthead lead image and auto-fixes anything flagged `regenerate` (a flagged hero is re-shot as a corrected-brief documentary landscape at high quality). Treat cohesion **< 7/10** after the fix loop as "hold — fix manually before publishing".
4. **Publish**: flip `published_at` in `/admin/takes`, or re-run with `--auto-publish` (held drafts still won't publish).

## 6. Dedup runbook (wire feed duplicates)

Clustering runs **inline after every aggregation run** (`runAggregation` → `ClusterNews`, non-dry-run only) in `services/news-aggregator/`:

- 48h lookback over unclustered articles, 3-gram headline shingles (stopwords/digits stripped), ≥3 shared shingles, 12h max time gap, union-find merge, buckets by `stock_code`.
- The no-stock-code `_MARKET` bucket additionally requires shared shingles ≥ 60% of the smaller set (`sameStoryMarket`) — flat overlap falsely merges templated headlines ("insider just sold..."). See `clustering_test.go`.
- Primary = earliest published (deterministic tiebreak); cluster UUID derived from the union-find root (stable across re-runs).
- Feeds serve cluster primaries only (`WHERE cluster_id IS NULL OR cluster_is_primary = TRUE`, partial index `idx_news_articles_feed`, migration 000042) with "+N sources" syndication chips (`wire-list.tsx`, `news-card.tsx`).

Manual backfill:

```bash
cd services
RUN_MODE=cluster-news CLUSTER_LOOKBACK_HOURS=2160 go run ./news-aggregator/ --dry-run   # preview
RUN_MODE=cluster-news CLUSTER_LOOKBACK_HOURS=2160 go run ./news-aggregator/             # write
# CLUSTER_MIN_OVERLAP=3 to tune
```

Verify:

```sql
SELECT COUNT(*) FILTER (WHERE cluster_id IS NOT NULL) AS clustered,
       COUNT(*) FILTER (WHERE cluster_is_primary) AS primaries,
       COUNT(DISTINCT cluster_id) AS clusters
FROM news_articles WHERE published_at > NOW() - INTERVAL '7 days';

SELECT * FROM v_news_clusters ORDER BY published_at DESC LIMIT 20;  -- migration 000033
```

## 7. Prod gotchas

- **Migrations**: apply 000041/000042-style changes via psql with `IF NOT EXISTS` — never `make migrate-up` against prod (schema_migrations version drift).
- **Models**: `gemini-3-pro-preview` 404s on the v1beta API (as of 2026-05-30) — use `gemini-3.5-flash` (the default everywhere; override via `VALIDATOR_MODEL` etc. when the preview model lands). gemini-3.5-flash needs `thinkingConfig: { thinkingBudget: 0 }` for short structured outputs or it burns the budget thinking.
- **Image gen auth**: GCS bucket writes (`shorted-company-logos`) need the legacy ADC export (`GOOGLE_APPLICATION_CREDENTIALS=.../legacy_credentials/ben@shorted.com.au/adc.json`).
- **Stale images**: GCS objects are uploaded with `cacheControl: public, max-age=86400` — a regenerated image can serve stale for up to a day (the validator cache-busts with `?t=` for its own re-judge, browsers won't). The article page itself is ISR-cached ~10 min.
- **Daily cron unprovisioned**: `terraform/modules/newsroom-job/` is referenced from `terraform/environments/dev/main.tf` only (scheduler region `australia-southeast1`) — prod scheduling is not live; runs are manual.
- **Vercel** deploys from the repo root (project Root Directory is `web/`).
- **Commits** on this branch use `--no-verify` (pre-existing lint debt in the pre-commit hook).
- Validator on serverless: Playwright is optional — missing chromium degrades to per-image judging (see `SERVERLESS.md` in `scripts/take-writer/`).
