# Investigative Newsroom Engine — Design Spec

**Date:** 2026-05-30
**Status:** Approved design, pre-implementation
**Scope:** Sub-project 1 of 2 (engine). Sub-project 2 (rich frontend rendering) is a follow-on spec.

## Goal

Turn the `scripts/take-writer/` suite from a fast, shallow single-LLM-call generator into a daily **investigative newsroom**: an editor commissions stories from the day's data, agentic investigators gather evidence through live data tools, and the tuned Shorted voice writes grounded, citation-backed pieces. Tiered output — most stories are tight 4-section Takes, 1–2 per day are promoted to long-form deep-dive investigations.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Investigation mechanism | Agentic loop with live data tools (multi-turn, plans an angle then queries) |
| Cadence | Daily editorial run (no event hotline in SP1) |
| Output shape | Tiered: short 4-section Takes + 1–2 promoted long-form deep-dives |
| Investigation/reasoning model | Claude Sonnet for editor + Takes; Claude Opus for deep-dives |
| Writer model | **Gemini 2.5 stays** — keeps the tuned voice + banned-phrase calibration |
| Cost posture | Strongest reasoning only where depth matters; hard turn/token/story caps |

## Why this shape

- **`scripts/take-writer/` already owns the editorial domain** — voice/persona (`persona.ts`, `narrative.ts`), the data bundle (`journalism.ts` `buildReport`), citation renumbering, OpenAI image generation, and the `editorial_takes` insert + draft/publish/tweet pipeline. We extend it rather than rebuild.
- **Claude investigates → hands a structured findings dossier + citation ledger to Gemini → Gemini writes.** This split puts the strongest tool-use/reasoning where it matters while keeping the final prose on the model the voice was calibrated against. No voice re-tune required.
- **Direct DB drill-downs, not the prod HTTP API.** A batch job hitting Postgres directly avoids the Cloudflare WAF bot-protection that bursting >20 req/min to `api.shorted.com.au` triggers (see project memory). `journalism.ts` already queries pg directly.

## Architecture

Daily Cloud Run Job runs three agent stages in sequence:

```
                    ┌─────────────────────────────────────────────┐
  signal board ───▶ │ EDITOR (Claude Sonnet)                       │
  + last-take/stock │  rank → novelty-gate → assignment desk       │
                    │  [{code, angle, tier: take|deep_dive}, …]    │
                    └───────────────────┬─────────────────────────┘
                                        │ per assignment
                    ┌───────────────────▼─────────────────────────┐
  data tools ◀────▶ │ INVESTIGATOR (Sonnet=take / Opus=deep_dive)  │
  (drill-downs)     │  agentic tool loop, turn-capped              │
                    │  → findings dossier + citation ledger        │
                    └───────────────────┬─────────────────────────┘
                                        │ dossier + ledger
                    ┌───────────────────▼─────────────────────────┐
                    │ WRITER (Gemini 2.5 — tuned voice)            │
                    │  dossier → prose, cites by ledger refId only │
                    └───────────────────┬─────────────────────────┘
                                        │
   VALIDATE (drop any citation not in ledger) → IMAGES (OpenAI, existing)
                                        │
   INSERT editorial_takes (tier, body_md, citations) → existing publish/tweet queue
```

### Stage 1 — Editor agent (Claude Sonnet)

**Input:** the day's signal board (per-stock computed signals already produced by `journalism.ts`: short slopes 7/30/90d, short% change, price changes 1/3/6/12m, price↔shorts correlation, news counts, sentiment trend, director-trade net value, peer-relative short%), plus the **most recent take per stock** (queried from `editorial_takes`).

**Output:** an *assignment desk* — a ranked list of story assignments, each `{ stockCode, angle, tier: "take" | "deep_dive", rationale }`.

**Novelty gate (load-bearing):** the editor commissions a story for a stock **only if there is a material new development since that stock's last take** — new price-sensitive news, a short-position regime change (slope/level shift beyond a threshold), or a new director trade. Stocks with no new development since last coverage are skipped. This prevents day-3 duplicate slop.

**Caps:** at most `MAX_TAKES_PER_DAY` (default 10) Takes and `MAX_DEEPDIVES_PER_DAY` (default 2) deep-dives commissioned per run.

### Stage 2 — Investigation agent (Claude; Sonnet for Takes, Opus for deep-dives)

An agentic tool-calling loop. Given the assignment's angle + tier, the agent calls data tools to gather evidence, builds a **findings dossier**, and registers every retrieved source in a **citation ledger**. The loop is **turn-capped** (`MAX_TURNS_TAKE` default 6, `MAX_TURNS_DEEPDIVE` default 14) and **token-budgeted** per investigation; on cap it must finalize the dossier with what it has.

**Data tools (the "investigation skill").** Thin TypeScript functions over `journalism.ts`'s existing pg queries, exposed as a Claude tool registry. **Incremental drill-downs, not bulk re-fetches** — the agent already receives the aggregated bundle summary in its opening context; tools zoom in:

| Tool | Returns |
|---|---|
| `zoom_window(code, date, days)` | short% + price + news + director trades in a ±`days` window around a date (e.g. the 3 days around a spike) |
| `follow_peer(code, peerCode)` | a named peer's short/price series for divergence comparison |
| `report_line(code, metric)` | one financial-report line (revenue, EBITDA, EPS, guidance, cash flow, net profit) from `financial_report_extractions` |
| `align_events(code)` | timeline aligning director-trade dates against price/short moves |
| `news_detail(articleId)` | full record for one `news_articles` row (headline, summary, sentiment, url, date) |
| `search_news(query, code?)` | keyword search across recent `news_articles` |

Each tool returns records carrying a **stable source ID** (`news_articles.id`, report extraction id, director-trade announcement url). The agent's harness appends each newly-seen source to the citation ledger as `{ refId, type: "news"|"report"|"director", url, source, headline, date }`.

**Findings dossier (handoff structure):** a JSON object the writer consumes —
```
{
  stockCode, tier, angle,
  threads: [ { claim, evidenceRefIds: [refId, …], note } ],
  timeline?: [ { date, event, refIds } ],   // deep-dives
  keyNumbers: [ { label, value, refId } ],
  ledger: [ { refId, type, url, source, headline, date } ]
}
```

### Stage 3 — Writer (Gemini 2.5, existing voice)

Consumes the dossier and writes the body in the Shorted voice via the existing `narrative.ts` machinery (system prompt, banned-phrase post-validation, slug generation).

- **Take tier:** the existing tight 4-section structure (background / recent events / the data / outlook).
- **Deep-dive tier:** long-form, variable markdown headings the writer derives from the dossier `threads`/`timeline` (e.g. `## The probe timeline`, `## What the shorts saw first`). 600–1200 words.

**Hard grounding rule:** the writer is instructed to make factual claims only from the dossier and to cite **only by ledger `refId`**. It may not introduce a `[ref-N]` for a source not in the ledger.

### Stage 4 — Validate, image, insert

- **Validate-before-insert:** parse the written body's citation markers; drop/flag any marker whose `refId` is not in the ledger. If a piece has dangling citations above a threshold, it is held as a draft and logged rather than auto-published — never publish fabricated sources.
- **Citation renumbering:** reuse the existing source-order renumber so rendered `[ref-N]` are contiguous; persist the unified `citations` JSONB (existing column from migration 000037).
- **Images:** unchanged — existing OpenAI `gpt-image` hero + inline image generation (`newsroom.ts`).
- **Insert:** into `editorial_takes` with the new `tier` column, `body_md`, `citations`, `model` set to the writer model. `published_at` stays NULL (existing admin/auto-publish queue and twitter bot pipeline unchanged).

## Schema change

**Migration 000038** (`000038_editorial_takes_tier.up.sql` / `.down.sql`):
```sql
ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'take';
-- allowed: 'take' | 'deep_dive'
```
Down migration drops the column. No other schema change — `body_md`, `citations` (JSONB), `hero_image_url`, `inline_images`, `model`, `word_count` all already exist.

## Cost controls

- **Model tiering:** Sonnet for editor + Take investigations; Opus only for the ≤2 deep-dives/day.
- **Turn caps:** `MAX_TURNS_TAKE`=6, `MAX_TURNS_DEEPDIVE`=14.
- **Story caps:** `MAX_TAKES_PER_DAY`=10, `MAX_DEEPDIVES_PER_DAY`=2.
- **Incremental tools** avoid re-sending the full 365-day series each turn.
- **Per-run cost logging:** total input/output tokens + model breakdown logged at end of run for the Cost Guardian to observe.
- Rough expected envelope: **~$2–5 per daily run** at these caps.

All caps are env-configurable so the run can be tuned or throttled without redeploy.

## Scheduling / infra

- New Cloud Run **Job** packaging `scripts/take-writer/` with a `newsroom-daily` entrypoint (extends the existing `newsroom` command).
- **Cloud Scheduler** trigger, daily, region `australia-southeast1` (scheduler limitation — see project memory), invoking the job.
- `min_instance_count = 0` (Jobs are run-to-completion; honors the cost guardrail rule).
- New terraform module under `terraform/modules/` following the existing Cloud Run Job pattern (service account + Secret Manager IAM for `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, GCS bucket), referenced from `terraform/environments/dev/main.tf`.
- Secrets: add `ANTHROPIC_API_KEY` to Secret Manager (new). `@anthropic-ai/sdk` added to `scripts/take-writer/package.json` (currently only `@google/generative-ai` + `openai`).

## New / changed files

| File | Change |
|---|---|
| `scripts/take-writer/src/tools.ts` | **New.** Data-tool registry + dispatch over `journalism.ts` queries; citation-ledger accumulation. |
| `scripts/take-writer/src/investigator.ts` | **New.** Claude agentic tool-calling loop → findings dossier. Turn/token caps. |
| `scripts/take-writer/src/editor.ts` | **New.** Claude editor: signal board → novelty gate → assignment desk. |
| `scripts/take-writer/src/journalism.ts` | Extend: expose existing internal queries as tool-callable drill-down functions; add "last take per stock" + signal-board helpers. |
| `scripts/take-writer/src/narrative.ts` | Extend: accept a dossier; deep-dive long-form prompt path; ledger-`refId`-only citation instruction. |
| `scripts/take-writer/src/newsroom.ts` | Rewire `runNewsroom` to the editor→investigator→writer pipeline; `newsroom-daily` entrypoint. |
| `scripts/take-writer/src/index.ts` | Add `newsroom-daily` command + validate-before-insert step. |
| `scripts/take-writer/package.json` | Add `@anthropic-ai/sdk`. |
| `services/migrations/000038_editorial_takes_tier.{up,down}.sql` | **New.** `tier` column. |
| `terraform/modules/newsroom-job/` | **New.** Cloud Run Job + Scheduler + IAM. |
| `terraform/environments/dev/main.tf` | Reference the new module. |

## Explicitly out of scope (→ Sub-project 2)

- Tier-aware frontend layout, long-form heading treatment, embedded Visx charts/tables, deep-dive page design. SP1's long-form `body_md` renders acceptably in today's `TakeBody` via markdown headings.
- Event-triggered / near-real-time hotline (SP1 is daily only).
- Cross-stock comparative pieces beyond single-stock peer context.
- Backend Go read API changes for `tier` (frontend can ignore the column until SP2).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cost overrun on agentic loop | Model tiering + turn/token/story caps, all env-configurable; per-run cost logging |
| Hallucinated facts/citations about named public companies (defamation / false-market risk) | Citation ledger + writer cites by `refId` only + validate-before-insert holds drafts with dangling citations |
| Voice drift | Writer stays on Gemini 2.5 with existing banned-phrase validation — no model swap on prose |
| Daily duplicate coverage | Editor novelty gate against last take per stock |
| WAF rate-limiting | Tools hit Postgres directly, not the prod HTTP API |
| Investigator stalls / never finalizes | Turn cap forces dossier finalization with evidence gathered so far |
