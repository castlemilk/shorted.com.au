# Stock report videos: design

**Status:** design approved in conversation on 7 Oct 2026; awaiting review of this written spec.
**Owner:** Ben Ebsworth. **Skill:** `stock-report-video`. **Studio:** `shorted-studio`, an OpenMontage fork.

## 1. Goal

Make it quick to turn an ASX ticker into two videos that walk through the company's latest financial report alongside Shorted's short-selling, price, news and insider data:

| Cut | Frame | Length | For |
| --- | --- | --- | --- |
| **Long form** | 16:9, 1920 × 1080, chapter markers | about 5 min (650–750 narrated words; accepted range 4:30–5:30) | YouTube; embedding in the matching /news analysis |
| **Short** | 9:16, 1080 × 1920, word-level captions burned in | 60–90 s (150–200 words) | TikTok, Reels, Shorts, X |

Each cut also ships as a clean version (no burned captions), with SRT and VTT, a 16:9 thumbnail and a 9:16 cover.

**Success criteria for the first version (MVP):**
- One command (`/stock-report-video DRO`) produces both cuts, reviewed and approved, in about 30 minutes of wall time plus review.
- Every figure on screen or in the narration matches the dossier (number audit passes).
- Speech-recognition word error rate on the final mix is under 3%; −14 LUFS integrated, −1 dBTP or lower.
- Nothing is published automatically.

## 2. Content and story

A results video is a factual walkthrough, never a recommendation.

**Long-form chapters.** A chapter whose data is missing is dropped and logged as a gap (§8).

| # | Chapter | Content |
| --- | --- | --- |
| 1 | Cold open (15 s) | The single most striking verified fact |
| 2 | The company in 30 s | What it does, sector, where it operates |
| 3 | The result | Revenue, NPAT, EPS against the comparable period; margins; the filing and its date |
| 4 | Cash and balance sheet | Free cash flow, cash conversion, net cash or debt |
| 5 | Outlook and dividends | Guidance quoted verbatim from the filing with its source; payout history |
| 6 | The bears | Short-interest level, trend, rank; short vs price; crowding vs peers |
| 7 | News and insiders | News timeline with sentiment; director buys and sells |
| 8 | What to watch | Upcoming events; how the stock-picker strategies read it |
| 9 | Close | Recap; "free to explore at shorted.com.au"; general-advice line |

**The short** reuses the same scenes, re-laid out for 9:16, with its own tighter narration: hook, the three numbers that matter, the bears, one news or insider beat, what to watch, call to action.

**Recurring identity:** the paper-collage field-guide world of *A Field Guide to the Bears* (`~/projects/shorted-promo-film`). That means the opening sting (binoculars find the ticker), chapter cards, lower-thirds, end card, the bear as recurring host, the signature score, and the Australian narrator voice.

**Editorial rules** (from `financial-report-analysis` and DESIGN.md):
- ASIC short positions are aggregated and carry no thesis.
- Never claim causation the data cannot isolate.
- Never use buy, sell or target language.
- Show the as-at date for every figure.
- Use the company's reporting currency (`$` only for AUD).
- Show `n/a` and `n/m` as such; never as 0.
- End with "General information only. Not financial advice."

## 3. Architecture

### 3.1 Components and where they live

| Component | Location | Licence |
| --- | --- | --- |
| **Studio:** a fork of OpenMontage (`calesthio/OpenMontage`) that tracks upstream, plus the Shorted pipeline pack | `~/projects/shorted-studio` (separate repo, private is fine) | AGPL-3.0 (inherited) |
| **Skill:** the entry point and operating manual | `shorted.com.au/.claude/skills/stock-report-video/SKILL.md` | Shorted |
| **Run folders and local kit cache** | inside the studio, gitignored (`projects/<TICKER>-<YYYY-MM-DD>/`, `kit/`) | n/a |
| **Shorted kit (source of truth)** | brandbrain canvas "Shorted kit" | Shorted assets |
| **Company brand data** | brandbrain via the `bb` CLI | per brand |

OpenMontage is agent-first. Claude Code is the orchestrator: it reads the pipeline manifest (YAML) and the stage-director skills (Markdown), then calls the Python tools. Checkpoints, decision and cost logs, budget caps and the Backlot storyboard UI come with it.

**The AGPL boundary.** No OpenMontage code is copied into shorted.com.au. The skill drives the studio by absolute paths. Running the studio ourselves creates no obligation, and the videos are not covered. Obligations would attach only if the modified studio were distributed or offered to others over a network; revisit that before batch mode becomes a hosted service.

**Remotion** (OpenMontage's renderer) is free for individuals and companies of up to 3 people; a larger team needs a company licence.

### 3.2 The Shorted pipeline pack (inside the studio)

| Piece | Path | Purpose |
| --- | --- | --- |
| Pipeline manifest | `pipeline_defs/shorted-results.yaml` | Stages, artefacts, gates, budget (default $2 cloud spend), approval points |
| Stage-director skills | `skills/pipelines/shorted-results/*.md` | How to run each stage, with the editorial rules |
| Tools | `tools/shorted/` | `dossier`, `bb_brand`, `kit` (index, resolve, register, sync), `number_audit`, `compliance_lint`, `gap_reflector`, `score` (signature theme cue builder) |
| Style playbook | `styles/shorted-field-guide.yaml` | Palette, typefaces (Newsreader, IBM Plex Mono, Caveat), paper-collage motion rules, audio profile |
| Remotion components | `remotion-composer/src/shorted/` | `PaperCollage` (the film's canvas engine inside a Remotion `<canvas>`, driven by `useCurrentFrame`), the scene catalogue (§6), and the `ShortedLong` and `ShortedShort` compositions |
| Tests | `tests/shorted/` | See §11 |

### 3.3 Pipeline

```
/stock-report-video DRO
  research   tools/shorted/dossier ............ dossier.json (+ research_brief, coverage)
  brand      tools/shorted/bb_brand + kit ..... brand.json
  script     stage skill (Claude) ............. script.long.json, script.short.json
     gates: binding · compliance · freshness   (refuses to continue on failure)
  ▶ APPROVAL (Backlot storyboard)
  scene      ................................... scene_plan.json (scene catalogue, both aspects)
  assets     kit-first; ComfyUI / brandbrain .. asset_manifest.json; kit updated
  voice      gemini_tts + alignment ........... audio/vo/*.wav, words.json
  music      tools/shorted/score + mixer ...... audio/music, audio/mix (−14 LUFS)
  compose    Remotion ......................... long.mp4, short.mp4 (+ clean, SRT/VTT)
  review     self-review + Shorted QA ......... qa.json, contact sheets
  reflect    tools/shorted/gap_reflector ...... reflect.md, gaps.jsonl, backlog
```

Each stage reads and writes files in the run folder and checkpoints, so any stage can be re-run without redoing the others. Artefacts use OpenMontage's schemas where they exist (`research_brief`, `script`, `scene_plan`, `asset_manifest`, `edit_decisions`, `render_report`, `review`, `decision_log`, `cost_log`). Shorted-specific files (`dossier.json`, `brand.json`, `coverage.json`, `gaps.jsonl`) have their own JSON Schemas in `schemas/shorted/`.

**Modes**
- **Interactive (MVP):** Claude writes the script; you approve before any paid generation and before render.
- **Batch (phase 3):** an `--auto` run under headless Claude, picking tickers from `take-writer results-watch`. The approval step becomes a queue of drafts. Nothing is published in either mode.

## 4. Research: the dossier

`tools/shorted/dossier <TICKER>` calls the public Connect-RPC API (`https://api.shorted.com.au`) with the E2E bypass headers (`User-Agent: Shorted-E2E/1.0`, `X-Shorted-Testing-Bypass` from the repo `.env`). It backs off on 429 responses.

| Area | Endpoints (all `VISIBILITY_PUBLIC`) |
| --- | --- |
| Identity | `StockService/GetStock`, `GetStockDetails`, `GetStockGraph`, `GetCompanyTaxProfile`, `GetStockSignals`, `GetStockVerdict` |
| Short interest | `GetStockData` (1Y or shorter, daily, for any point value; `MAX` only for shape), `MarketService/GetTopShorts`, `StockService/GetPeerComparison`, `MarketService/GetBattlegroundStocks`, `GetShortCampaignScoreboard` |
| Price | `StockService/GetStockPrices`, `MarketService/GetIndexSeries` (benchmark) |
| Results | `StockService/GetStockFundamentals` (periods, growth, quality, coverage, latest filing), `GetStockFinancialHighlights` (filing-derived, through the trust funnel), `GetDividendHistory` |
| Events and news | `StockService/GetEventTimeline`, `NewsService/GetStockNews`, `GetRelatedNews`, any /news take and weekly report that mention the ticker |
| Insiders and strategy | `StockService/GetDirectorTrades`, `StrategyService/GetStockStrategyFit` |
| Plates | Phone-size captures of `/shorts/<CODE>` sections with headless Chromium (the apex blocks curl) |

**Every value is stored as:**
`{ value, unit, currency, as_at, trust: ok|stale|withheld|untrusted, source: { endpoint, request, fetched_at } }`

**Normalisation rules, enforced in code with tests:**
- Reporting currency.
- `has_*` flags are respected.
- Unknowns stay null; never COALESCE an unknown to 0.
- `n/m` is withheld with its reason.
- Point values come only from daily series.
- Growth compares like spans only (as `GetStockFundamentals` already does).

`coverage.json` scores each chapter's required fields. A chapter below its threshold is dropped from both cuts.

## 5. Brand and kit

### 5.1 Company brand

`bb discover "<company name>" --website <website from GetStockDetails>` runs at standard depth (2–5 min) and is cached by brand slug, then `bb brand <slug> --json`. From it we keep logo variants (primary, dark, light, mono, icon), brand colours and fonts in `brand.json`.

**Use:** identification on report pages and one colour accent. The Shorted frame always dominates, and nothing implies endorsement. **Fallback:** Shorted's stored `logo_gcs_url`.

### 5.2 Shorted kit (grows with every run)

- **Source of truth:** a permanent brandbrain canvas, "Shorted kit". Each asset is a reference node tagged with:
  - `type` (bear-pose, prop, background, texture, lockup, logo, music-stem, sting, insert)
  - `ticker`, `sector`, `theme`, `chapter`, `aspect`
  - provenance: generator, model, prompt, cost, date, licence
- **Local mirror:** `kit/index.json` (OpenMontage `asset_manifest` format) plus the files, for instant lookups.
- **Seeded from the film:**
  - the bear rig and its poses;
  - the props and textures;
  - the binocular sting and the field-guide cards;
  - the signature score stems;
  - the logo badge.
- **Kit first:** every asset slot in the scene plan is resolved from the index by tags. Only a miss triggers generation (§5.3). New assets are approved by you in interactive mode, then registered to the local index and the brandbrain canvas. `kit sync` reconciles the two.

### 5.3 Generation routing

| Need | Route |
| --- | --- |
| Numbers, charts, tables, plates | Always drawn from data; never generated |
| Illustrated stills (scene backgrounds, sector vignettes) | Local ComfyUI (Flux 2 with kit style references), then brandbrain (gemini-3.1-flash-image about $0.09, gpt-image-2 about $0.21), then the nearest kit asset |
| Motion inserts (optional, 3–5 s) | Local Wan 2.2 5B image-to-video from a kit still |
| Music beds (optional) | Local ACE-Step |

- Generated art contains no text, numbers or logos.
- The run budget (default $2 cloud spend) is enforced by OpenMontage's budget controls.
- Paid calls need your OK in interactive mode.
- **ComfyUI** runs locally on Metal (M5 Max, 128 GB). The models need about 40–60 GB of the 179 GB free. OpenMontage connects through `COMFYUI_SERVER_URL`.

## 6. Scenes

There is one catalogue of typed scenes. Each declares:
- its data bindings (dossier paths);
- layouts for 16:9 and 9:16 from the frame's safe areas;
- minimum and maximum duration;
- a motion template in the paper-collage style.

| Group | Scenes |
| --- | --- |
| Frame | `opening_sting`, `chapter_card`, `lower_third`, `end_card` |
| Company | `company_card`, `live_plate` |
| Results | `result_compare`, `margins`, `cash_flow`, `balance_sheet`, `guidance_quote`, `dividend_history` |
| Bears | `short_vs_price`, `short_rank`, `peer_crowding` |
| Context | `news_timeline`, `director_ledger`, `strategy_fit`, `what_to_watch` |

Charts follow DESIGN.md:
- warm series colours;
- true red and green only for direction of movement;
- monospace tabular numerals;
- provenance shown in the frame.

## 7. Script, gates and approval

**Script files.** `script.long.json` and `script.short.json` hold ordered lines. Each line has:
- `text`, with `{{path|format}}` placeholders for every figure;
- `scene` and its bindings;
- a TTS `style`;
- a `caption` phrase list.

Formatters produce both spoken and display forms (for example "A$1.5 billion" / `$1.5B`, "twelve point six per cent" / `12.6%`). A pronunciation list covers tickers and names.

**Gates.** The script stage refuses to continue on any failure:
1. **Binding:** every numeral in the narration or on screen comes from a binding; free-typed numbers fail.
2. **Compliance lint:**
   - rejects advice and price-prediction language;
   - rejects causal claims about price or short moves;
   - requires the ASIC caveat wherever short data appears;
   - requires the general-advice line on the end card.
3. **Freshness:** stale values are flagged, and every chart shows its as-at date.
4. **Human approval:** you review the script and storyboard on Backlot before anything is generated or rendered.

## 8. Reflection

`gap_reflector` combines four inputs:
- coverage misses;
- the script's wishlist (`data_wishes`: what a chapter wanted but Shorted lacks);
- QA staleness;
- kit misses.

It classifies each item as:
- `missing_field` or `missing_endpoint` (a product gap);
- `stale_sync`;
- `low_trust_extraction`;
- `unavailable_by_law` (for example, who holds a position). This last class is recorded but never counted as a gap.

**Outputs:**
- `reflect.md` per run;
- a deduplicated `gaps.jsonl`;
- a ranked backlog (frequency × impact on the video);
- with your OK, `data-gap` issues opened or updated on shorted.com.au.

## 9. Voice, music and render

- **Voice:** Gemini TTS `gemini-3.8-flash-tts`, voice `en-au-tutor-5`, matching the film. Key lines get up to three takes, and every take is checked with speech recognition. Words are force-aligned for captions. If OpenMontage's `gemini_tts` tool cannot address Extended Voice Library ids through the Interactions API, a `tools/shorted/voice` wrapper reuses the film's client (`tools/tts.py`).
- **Music:** the signature theme's stems are arranged per chapter from the timeline, as in the film's `music.py`, with ACE-Step beds for variety. Stingers sit on chapter cards. The mix is three-band ducked under the voice to −14 LUFS and −1.5 dBTP before encoding.
- **Render:** Remotion compositions `ShortedLong` (16:9, chapter markers written to the metadata and to a YouTube chapters text file) and `ShortedShort` (9:16, word-level captions burned in). H.264 High, BT.709, AAC.
- **Deliverables per run:**
  - long and short (captioned and clean)
  - SRT and VTT
  - thumbnail and cover
  - script, storyboard, dossier, `qa.json`, `reflect.md`

## 10. QA and failure handling

**QA:** OpenMontage's post-render self-review (ffprobe, sampled frames, audio levels, subtitles, slideshow-risk score), plus:

| Check | Threshold |
| --- | --- |
| Number audit: values each component rendered (render manifest) vs dossier | exact match |
| Speech-recognition word error rate on the final mix vs script | < 3% |
| Loudness | −14 LUFS ±1, ≤ −1 dBTP |
| Caption reading speed | ≤ 20 characters/s |
| Durations | long 4:30–5:30; short 60–90 s |
| Safe areas | 9:16 key content and captions clear of the feed UI |

**Failure handling:**
- Stage errors stop at the checkpoint with a clear message.
- Missing data drops the chapter and logs a gap.
- Generation failures fall back from ComfyUI to brandbrain to the nearest kit asset.
- Hitting the budget cap stops before the paid call.
- 429 responses back off.
- The `bb` crawl times out to the stored logo.

## 11. Testing

- **Unit:**
  - dossier normalisation, against fixtures recorded from live responses (DRO, BHP for USD, a bank for `n/m`, a ticker with no filing);
  - formatters;
  - the binding gate;
  - the compliance lint, with a corpus of good and bad lines;
  - the gap classifier.
- **Components:** snapshot stills of every scene in both aspect ratios from fixture data.
- **End to end:** a smoke run on the recorded DRO dossier with mocked providers (no paid calls, no network), producing short and long cuts that pass QA.
- **Contracts:** OpenMontage's existing tests and schema validation stay green in the fork.

## 12. Phasing

1. **MVP:**
   - fork and setup;
   - pipeline pack skeleton;
   - dossier, binding gate and lint;
   - Remotion scenes plus `PaperCollage`;
   - voice, score and mix;
   - both cuts;
   - QA;
   - a local gap ledger;
   - kit seeded from the film, with no new generation.
2. **Generation:**
   - ComfyUI install and workflows (Flux 2, Wan 2.2, ACE-Step);
   - brandbrain kit canvas and sync;
   - the `bb` brand crawl;
   - gap issues on GitHub.
3. **Batch:**
   - `--auto` under headless Claude;
   - the `results-watch` trigger;
   - the draft queue.

## 13. Risks and open points

- **ComfyUI speed on Apple Silicon:** generated motion stays short and optional, and the kit absorbs repeat needs.
- **Disk space:** 179 GB free; models are budgeted at about 60 GB.
- **Guidance is unstructured in Shorted today:** the guidance chapter will often be dropped until the reflection loop surfaces it as a gap.
- **Naming companies in a promotion:** these are editorial walkthroughs of public data, but get a compliance check before any paid distribution.
- **Licences:** confirm Remotion's team-size eligibility; keep the AGPL boundary in §3.1.
- **Gemini TTS is a preview-era API:** voice ids may change; the voice is configured in one place.
