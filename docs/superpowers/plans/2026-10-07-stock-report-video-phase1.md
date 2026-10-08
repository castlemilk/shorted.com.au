# Stock report videos: phase 1 (MVP) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running `/stock-report-video <TICKER>` produces a 5-minute 16:9 results walkthrough and a 60–90 s 9:16 short. Every figure comes from Shorted's API, and each run checks itself and records the data Shorted lacked.

**Architecture:** OpenMontage is cloned to `~/projects/shorted-studio`, and a Shorted pipeline pack is added to it:
- **Manifest and stage skills** — Claude Code orchestrates the run through a manifest plus stage skills.
- **Python tools (`tools/shorted/`)** — collect the dossier, enforce the gates, narrate, score, build the timeline, render, QA and reflect.
- **Remotion entry (`remotion-composer/src/shorted/`)** — reuses the promo film's vanilla-JS paper-collage engine inside a canvas.
- **The MCP pass (`tools/shorted/mcp.py`, `mcp_pass.py`)** — reads the ticker through Shorted's MCP server as well, checks the two product surfaces agree, and records what an AI client on MCP could not get.

Every number reaches the screen or the voice only through a `{{path|format}}` binding to `dossier.json`. Nothing in phase 1 generates images or publishes.

**Tech Stack:**
- Python 3.12 (uv venv), OpenMontage `BaseTool` and `lib.checkpoint`, numpy/scipy, soundfile, pyloudnorm, faster-whisper, tinysoundfont.
- Remotion 4 (React 18, TypeScript), plus the film's engine (`core`, `paper`, `type`, `bear`, `props`) as JavaScript modules.
- FFmpeg; Gemini TTS (`gemini-3.8-flash-tts`, voice `en-au-tutor-5`); Playwright (plate captures); pytest.

**Spec:** `docs/superpowers/specs/2026-10-07-stock-report-video-design.md` (read it first; this plan argues from it).

**Verification (7–8 Oct 2026):** every code block here was extracted into a scratch OpenMontage checkout and run, and again after the 8 Oct amendments (the MCP pass, dossier data-quality rules, renumbering to 25 tasks): 133 fast tests and the stand-in end-to-end run on freshly recorded DRO responses passed, with 8 of 8 figures agreeing across the API and MCP.
- **Passed:** the fast suite (114 tests) and the slow suite. The slow suite covered stem rendering with the film's SoundFont, Remotion scene sheets in both aspects, and two real end-to-end renders on recorded DRO responses. Those renders used stand-in voice, recognition and capture, produced both cuts, and passed QA.
- **Not exercised:** a paid Gemini TTS call (Task 19 Step 6), faster-whisper on real audio, `capture_plates.mjs` against shorted.com.au (Task 18 Step 6), the BHP, bank and no-filing fixtures, and OpenMontage's full contracts suite.

If a step's expected output differs, trust the test and fix the code, not the expectation.

## Global Constraints

- **Studio and git:** studio at `/Users/benebsworth/projects/shorted-studio`, a clone of `https://github.com/calesthio/OpenMontage`. Remote `upstream`, work on branch `shorted`. No OpenMontage code is copied into shorted.com.au, because of the AGPL boundary.
- **Commands:** Python is `/Users/benebsworth/projects/shorted-studio/.venv/bin/python` (3.12). Run tests with `.venv/bin/python -m pytest tests/shorted -q` from the studio root.
- **No network in tests:** OpenMontage's conftest blocks non-loopback sockets in tests. Recorded fixtures stand in for the network, and Remotion renders use loopback only.
- **Long cut:** 16:9, 1920 × 1080, 30 fps, 270–330 s, 650–750 spoken words.
- **Short cut:** 9:16, 1080 × 1920, 30 fps, 60–90 s, 150–200 spoken words, word-level captions burned in.
- **Per-cut outputs:** captioned and clean MP4; SRT and VTT; a 16:9 thumbnail and a 9:16 cover per run.
- **Encoding:** H.264 High, `yuv420p`, BT.709 tags (`color_primaries`, `color_trc`, `colorspace` = bt709), AAC 256 kb/s.
- **Loudness:** master −14 LUFS ±1; limiter ceiling −1.5 dBTP before encoding, so encoded files measure ≤ −1 dBTP.
- **QA thresholds:**
  - speech-recognition word error rate on the final mix < 3%;
  - caption reading speed ≤ 20 characters/s;
  - number audit exact.
- **Voice:** Gemini TTS `gemini-3.8-flash-tts`, Extended Voice Library voice `en-au-tutor-5`, at most 3 takes per line.
- **API calls:**
  - endpoint: `POST https://api.shorted.com.au/shorts.v1alpha1.<Service>/<Method>`, JSON body;
  - headers: `Content-Type: application/json`, `Connect-Protocol-Version: 1`, `User-Agent: Shorted-E2E/1.0`, plus `X-Shorted-Testing-Bypass: $SHORTED_API_BYPASS_SECRET` when set.
- **MCP:** `POST https://api.shorted.com.au/mcp`, JSON-RPC `tools/call`, with no initialize handshake (the server is stateless) and `Accept: application/json, text/event-stream`. Anonymous access is the default and allows 30 calls a minute per address, so the client paces one call per 2.2 s; `SHORTED_MCP_TOKEN` sends a bearer token. The MCP pass never blocks a run.
- **Point values** (current %, change, peak) come only from a `GetStockData` series with `period: "1Y"`, `fullResolution: true` and `downsampled: false`. `MAX` is for shape only.
- **Display rules:**
  - Money in the company's reporting currency, shown as `A$` / `US$`, never a bare `$`, in video copy.
  - Unknown → `n/a`; withheld → `n/m`; never 0.
  - True minus `−` (U+2212) for negatives.
- **Editorial rules:** no buy/sell/hold calls, targets, valuation opinions, predictions or causal claims about price or short moves.
- **Caveat super:** `ASIC data shows the size of short positions, not who holds them or why.` must appear on every scene that binds `short.*`.
- **End-card advice line:** `General information only. Not financial advice.`
- **Nothing publishes.** No paid image or video generation in phase 1, and no `bb` brand crawl (phase 2).
- **Run folders:** `projects/<TICKER>-<YYYY-MM-DD>/` with OpenMontage's layout (`artifacts/`, `assets/images/`, `assets/audio/`, `assets/music/`, `renders/`).
- **Imports:** `tools/shorted/` modules import faster-whisper, tinysoundfont, pyloudnorm, soundfile, scipy and Pillow inside the functions that use them. `ToolRegistry.discover()` imports every module under `tools/` and catches nothing, so one failing import hides every tool.

## Review Focus

No task's main tests cover these inputs, but users will hit them. Each line names the expected behaviour and the task that owns the pinning test:

1. **A ticker with no parsed filing** (`hasLatestFiling` false): coverage marks the `result` chapter not ok, and the run still builds from the remaining chapters. *Task 6 `test_missing_filing_drops_result_chapter`; Task 8 `test_uncovered_chapter_is_error`; Task 20 `test_dropped_chapter_has_no_scenes`.*
2. **A company that reports in USD (BHP):** shows `US$`, speaks "US dollars", and never shows a bare `$`. *Task 3 `test_money_usd`; Task 6 `test_reporting_currency_usd`.*
3. **A bank (CBA) with not-meaningful ratios:** those values are withheld (`n/m` on screen), and binding one into narration is a gate error. *Task 3 `test_withheld_display_and_unspeakable`; Task 8 `test_binding_withheld_value_in_narration_is_error`.*
4. **A stock outside the top-100 short list:** rank shows "outside the top 100", never `#0`. *Task 3 `test_rank_outside`; Task 6 `test_rank_outside_top`.*
5. **Ticker typed as `dro`, `DRO.AX` or `DR O`:** normalised to `DRO`, or rejected with a clear message. *Task 4 `test_normalise_ticker`.*

## Deviations from the spec

Each is deliberate and keeps phase 1 smaller without weakening a spec guarantee.

- **Stage names.** OpenMontage's checkpoint writer demands a schema-valid canonical artifact for any stage named `research`, `script`, `scene_plan`, `assets` or `compose` (`CANONICAL_STAGE_ARTIFACTS` in `lib/checkpoint.py`). Phase 1's artifacts are Shorted's own, so the spec's `research → script → scene → music → compose → review` become `dossier → storyboard → timeline → score → render → qa`. `assets` keeps its name and writes a valid `asset_manifest`. Emitting `research_brief`, `script` and `scene_plan` as well (what the Backlot storyboard view reads) is phase 2.
- **Script and scene plan are one file per cut** (`storyboard.<cut>.json`): each scene carries its lines, so bindings, lint and timing read one structure. Caption phrasing comes from the aligned words rather than a hand-written phrase list.
- **Approval** is `artifacts/review.md` plus `cli approve`, which refuses if a storyboard or the dossier changed after its gates ran. It replaces the Backlot UI for now.
- **Scene catalogue.** The spec's 19 named scenes are expressed with 10 data-bound types; the mapping is in the storyboard-director skill (Task 2).
- **AUD shows as `A$`**, not `$`, so a clip seen out of context is never ambiguous.
- **No `schemas/shorted/` JSON Schemas yet;** tests pin the formats. OpenMontage's slideshow-risk score reads a `scene_plan`, so it is not run; every scene type animates by construction.
- **The MCP pass (added 8 Oct 2026 at the user's request).** The dossier stays on the Connect API, because MCP has no tool for dividends, the event timeline, signals, per-stock strategy fit, or the latest filing and its guidance. MCP is read alongside it: headline figures are compared across the two surfaces, and the sections MCP cannot serve are recorded. Spec §8's reflection gains the classes `surface_mismatch`, `mcp_gap`, `pipeline_gap` and `unused_source`.
- **Dossier data-quality rules (also 8 Oct).** The company's own name casing, city and state from the stored address, third-party headlines filtered for advice bait, opinion and passing mentions, and peers from Shorted's similarity graph when at least 3 have short data.
- **Raw-only endpoints:** `GetStockGraph`, `GetCompanyTaxProfile`, `GetStockVerdict`, `GetBattlegroundStocks`, `GetShortCampaignScoreboard`, `GetIndexSeries` (XJO) and `GetRelatedNews` are kept in `dossier.raw` for reflection and later scenes; no scene binds them yet. /news takes and weekly reports that mention the ticker are phase 2.

---

## File map

All paths are in `~/projects/shorted-studio` unless prefixed with `shorted.com.au/`.

| Path | Responsibility |
| --- | --- |
| `pipeline_defs/shorted-results.yaml` | Stage order, gates, budget |
| `styles/shorted-field-guide.yaml` | Style playbook (palette, type, motion, audio) |
| `skills/pipelines/shorted-results/*.md` | Stage-director skills: `executive-producer`, `dossier-director`, `storyboard-director`, `production-director`, `review-director` |
| `tools/shorted/values.py` | `Value` and `Source` (value, unit, as-at, trust, provenance) |
| `tools/shorted/formatters.py` | Display and spoken forms; the only place numbers become text |
| `tools/shorted/api.py` | Connect-RPC JSON client with bypass headers and backoff |
| `tools/shorted/calls.py` | Ticker normalisation; the call list for a dossier |
| `tools/shorted/dossier.py` | Normalisers, coverage, `shorted_dossier` tool |
| `tools/shorted/mcp.py` | Shorted MCP client: stateless JSON-RPC `tools/call`, event-stream replies, pacing, backoff |
| `tools/shorted/mcp_pass.py` | The MCP pass: parity with the dossier, MCP coverage of each section, extras (`shorted_mcp_pass`) |
| `scripts/shorted/record_mcp_fixtures.py` | Records MCP tool responses as fixtures (run outside pytest) |
| `tools/shorted/bindings.py` | `{{path|format}}` resolution, free-numeral detection |
| `tools/shorted/lint.py` | Compliance lint |
| `tools/shorted/gates.py` | Storyboard gates and `shorted_script_gates` tool, `review.md` |
| `tools/shorted/kit.py` | Kit index `kit/index.json` (OpenMontage `asset_manifest` format): register, resolve, seed from the film; `shorted_kit` tool |
| `tools/shorted/music_theme.py` | Signature-score stems rendered into the kit |
| `tools/shorted/brand.py` | `brand.json` and the company logo (`shorted_brand` tool) |
| `tools/shorted/assets.py`, `tools/shorted/capture_plates.mjs` | Live plate captures, image staging and the run's `asset_manifest` (`shorted_assets` tool) |
| `tools/shorted/asr.py` | faster-whisper words, normalisation, WER |
| `tools/shorted/narration.py` | TTS takes, speech-recognition check, cleaning, alignment (`shorted_narration`) |
| `tools/shorted/timeline.py` | Scene timings, supers, captions, SRT/VTT, chapters, Remotion props (`shorted_timeline`) |
| `tools/shorted/score.py` | Chapter-aligned score and effects (`shorted_score`) |
| `tools/shorted/mixdown.py` | Voice, music and effects mix, ducking, −14 LUFS, limiter, report |
| `tools/shorted/render.py` | Remotion render and stills, mux with colour tags (`shorted_render`) |
| `tools/shorted/qa.py` | Number audit, speech-recognition WER, loudness, captions, durations, contact sheet (`shorted_qa`) |
| `tools/shorted/reflect.py` | Gap classification, ledger, backlog (`shorted_reflect`) |
| `tools/shorted/cli.py` | `python -m tools.shorted.cli <stage> --ticker X`; writes checkpoints |
| `scripts/shorted/record_fixtures.py` | Records live API responses as fixtures (run outside pytest) |
| `remotion-composer/src/shorted/**` | Engine port, `PaperCanvas`, theme, scenes, captions, compositions |
| `tests/shorted/**` | Unit tests, recorded fixtures, render tests (`-m slow`) |
| `shorted-gaps/` | `gaps.jsonl` and `backlog.md` (committed in the studio) |
| `shorted.com.au/.claude/skills/stock-report-video/SKILL.md` | The entry-point skill |
| `shorted.com.au/docs/superpowers/notes/2026-10-08-stock-video-data-collection.md` | Running reflection on data collection: findings with evidence, recommendations for Shorted |

---

## Part A: the studio

### Task 1: Studio workspace

**Files:**
- Create: `/Users/benebsworth/projects/shorted-studio/` (clone), `.env` (local, gitignored), `.shorted-upstream-base`
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - the venv at `.venv`;
  - `remotion-composer/node_modules` and the Remotion headless browser;
  - `.env` keys `GEMINI_API_KEY`, `SHORTED_API_BYPASS_SECRET`, `SHORTED_REPO`, `SHORTED_FILM_DIR`, `SHORTED_PLAYWRIGHT_MODULE`, read by every later task.

- [ ] **Step 1: Clone and branch**

```bash
git clone https://github.com/calesthio/OpenMontage.git /Users/benebsworth/projects/shorted-studio
cd /Users/benebsworth/projects/shorted-studio
git remote rename origin upstream
git checkout -b shorted
git rev-parse --short HEAD > .shorted-upstream-base
```

Do not create a GitHub repository; publishing the studio is a separate decision for the user. A GitHub fork of a public repo is always public, so if a remote is wanted later it should be a new private repo with `upstream` kept for merges.

- [ ] **Step 2: Python environment**

```bash
cd /Users/benebsworth/projects/shorted-studio
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
uv pip install --python .venv/bin/python faster-whisper pyloudnorm soundfile scipy numpy pillow jsonschema pyyaml
uv pip install --python .venv/bin/python --no-deps tinysoundfont
.venv/bin/python -c "import tinysoundfont, faster_whisper, pyloudnorm, soundfile; print('ok')"
```
Expected: `ok`. (`tinysoundfont` is installed without dependencies because its optional `pyaudio` dependency needs PortAudio, and offline rendering never uses it.)

- [ ] **Step 3: Node environment**

```bash
cd /Users/benebsworth/projects/shorted-studio/remotion-composer && npm install && npx remotion browser ensure
```
Expected: the install completes and the headless browser is present. `ensure` downloads it now, because tests may not use the network.

- [ ] **Step 4: Local environment file (never print it)**

```bash
cd /Users/benebsworth/projects/shorted-studio && umask 077
R=/Users/benebsworth/projects/shorted.com.au
{
  printf 'GEMINI_API_KEY=%s\n' "$(grep '^GEMINI_API_KEY=' $R/.env | head -1 | cut -d= -f2- | tr -d "\"'")"
  printf 'SHORTED_API_BYPASS_SECRET=%s\n' "$(grep '^TF_VAR_rate_limit_testing_bypass_secret=' $R/.env | head -1 | cut -d= -f2- | tr -d "\"'")"
  printf 'SHORTED_REPO=%s\n' "$R"
  printf 'SHORTED_FILM_DIR=%s\n' /Users/benebsworth/projects/shorted-promo-film
  printf 'SHORTED_PLAYWRIGHT_MODULE=%s\n' "$R/web/node_modules/playwright/index.mjs"
} >> .env
grep -cE '^(GEMINI_API_KEY|SHORTED_API_BYPASS_SECRET)=.+' .env
```
Expected: `2`. If it prints `1` or `0`, a key is missing from the shorted repo `.env`. Ask the user; do not guess.

- [ ] **Step 5: Gitignore the local caches**

Append to `.gitignore`:

```gitignore
# shorted pack
kit/
remotion-composer/public/shorted/
remotion-composer/public/shorted-runs/
tests/shorted/_out/
```

- [ ] **Step 6: Baseline the upstream suite**

```bash
cd /Users/benebsworth/projects/shorted-studio && .venv/bin/python -m pytest tests/contracts -q -p no:cacheprovider 2>&1 | tail -3 | tee .shorted-baseline.txt
```
Expected: a summary line such as `N passed`. Commit whatever it reports. Later tasks compare against it, so a pre-existing upstream failure is not mistaken for ours.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .shorted-upstream-base .shorted-baseline.txt
git commit -m "chore(shorted): studio workspace on OpenMontage $(cat .shorted-upstream-base)"
```

### Task 2: Pipeline pack skeleton

**Files:**
- Create: `pipeline_defs/shorted-results.yaml`, `styles/shorted-field-guide.yaml`, `tools/shorted/__init__.py`
- Create: `skills/pipelines/shorted-results/{executive-producer,dossier-director,storyboard-director,production-director,review-director}.md`
- Create: `tests/shorted/__init__.py`, `tests/shorted/conftest.py`, `tests/shorted/test_pack.py`

**Interfaces:**
- Produces:
  - pipeline name `shorted-results`, with stages in this order: `dossier, brand, storyboard, assets, voice, timeline, score, render, qa, reflect`;
  - `storyboard` has `human_approval_default: true`;
  - `assets` must checkpoint a schema-valid `asset_manifest` (OpenMontage's canonical artifact for that stage name);
  - playbook `shorted-field-guide`;
  - pytest marker `slow`, skipped unless `-m slow`.

- [ ] **Step 1: Write the failing test**

`tests/shorted/test_pack.py`:

```python
import pytest

from lib.checkpoint import CheckpointValidationError, init_project, write_checkpoint
from lib.pipeline_loader import load_pipeline
from styles.playbook_loader import load_playbook

STAGES = ["dossier", "brand", "storyboard", "assets", "voice", "timeline", "score", "render", "qa", "reflect"]


def test_manifest_loads_with_stage_order():
    manifest = load_pipeline("shorted-results")
    assert [s["name"] for s in manifest["stages"]] == STAGES


def test_storyboard_requires_human_approval(tmp_path):
    init_project("t1", title="t", pipeline_type="shorted-results", pipeline_dir=tmp_path)
    for stage in ("dossier", "brand"):
        write_checkpoint(tmp_path, "t1", stage, "completed", {}, pipeline_type="shorted-results")
    with pytest.raises(CheckpointValidationError):
        write_checkpoint(tmp_path, "t1", "storyboard", "completed", {}, pipeline_type="shorted-results")
    write_checkpoint(tmp_path, "t1", "storyboard", "completed", {}, pipeline_type="shorted-results",
                     human_approved=True)


def test_assets_stage_needs_a_valid_asset_manifest(tmp_path):
    init_project("t2", title="t", pipeline_type="shorted-results", pipeline_dir=tmp_path)
    for stage in ("dossier", "brand"):
        write_checkpoint(tmp_path, "t2", stage, "completed", {}, pipeline_type="shorted-results")
    write_checkpoint(tmp_path, "t2", "storyboard", "completed", {}, pipeline_type="shorted-results",
                     human_approved=True)
    with pytest.raises(CheckpointValidationError):
        write_checkpoint(tmp_path, "t2", "assets", "completed", {}, pipeline_type="shorted-results")
    manifest = {"version": "1.0", "assets": [{"id": "logo", "type": "image", "path": "assets/images/logo.png",
                                              "source_tool": "shorted_assets", "scene_id": "global"}]}
    write_checkpoint(tmp_path, "t2", "assets", "completed", {"asset_manifest": manifest},
                     pipeline_type="shorted-results")


def test_playbook_loads():
    playbook = load_playbook("shorted-field-guide")
    assert playbook["identity"]["name"] == "Shorted Field Guide"
```

`tests/shorted/__init__.py`: empty file.

`tests/shorted/conftest.py`:

```python
from pathlib import Path

import pytest

HERE = Path(__file__).parent


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: renders video or audio; run with -m slow")


def pytest_collection_modifyitems(config, items):
    """Skip this directory's slow tests unless -m slow is given; other directories are left alone."""
    if "slow" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="slow: run with -m slow")
    for item in items:
        if "slow" in item.keywords and HERE in Path(item.path).parents:
            item.add_marker(skip)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_pack.py -q`
Expected: FAIL, because the `shorted-results` manifest is not found.

- [ ] **Step 3: Write the manifest**

`pipeline_defs/shorted-results.yaml` (`tools_available` stays empty until Task 24 registers every tool):

```yaml
name: shorted-results
version: "1.0"
description: >
  One ASX ticker in, two videos out: a ~5 minute 16:9 walkthrough of the latest
  financial report with Shorted's short-interest, price, news and insider data,
  and a 60-90 second 9:16 short. Every figure is bound to the dossier.
  Nothing publishes automatically.
category: custom
stability: beta
default_checkpoint_policy: guided
compatible_playbooks:
  recommended: [shorted-field-guide]
  custom_allowed: false
required_skills:
  - pipelines/shorted-results/executive-producer
  - pipelines/shorted-results/dossier-director
  - pipelines/shorted-results/storyboard-director
  - pipelines/shorted-results/production-director
  - pipelines/shorted-results/review-director
  - meta/checkpoint-protocol
orchestration:
  mode: executive-producer
  skill: pipelines/shorted-results/executive-producer
  budget_default_usd: 2.00
  max_revisions_per_stage: 3
  max_send_backs: 3
  max_wall_time_minutes: 60
stages:
  - name: dossier
    skill: pipelines/shorted-results/dossier-director
    produces: [dossier, coverage]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus:
      - Point values come from the daily 1Y series (downsampled false)
      - Reporting currency recorded on every money value
      - Chapters with coverage ok=false are noted for omission
    success_criteria:
      - dossier.json and coverage.json exist
      - company and bears chapters have coverage ok=true
  - name: brand
    skill: pipelines/shorted-results/production-director
    produces: [brand]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Company logo present or the Shorted fallback recorded]
    success_criteria: [brand.json exists]
  - name: storyboard
    skill: pipelines/shorted-results/storyboard-director
    produces: [storyboard_long, storyboard_short, gates]
    tools_available: []
    checkpoint_required: true
    human_approval_default: true
    review_focus:
      - Every numeral is a binding; gates.json has zero errors
      - No advice, prediction or causal language
      - Long 650-750 spoken words; short 150-200
    success_criteria:
      - gates.json errors == 0
      - the user approved review.md
  - name: assets
    skill: pipelines/shorted-results/production-director
    produces: [asset_manifest, images]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Every plate and logo key used by the storyboards is staged]
    success_criteria:
      - images.json lists every image key the storyboards use
      - the asset_manifest artifact passes its OpenMontage schema
  - name: voice
    skill: pipelines/shorted-results/production-director
    produces: [narration]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Every line's best take has WER <= 0.10]
    success_criteria: [narration.json has a file and words for every line]
  - name: timeline
    skill: pipelines/shorted-results/production-director
    produces: [timeline_long, timeline_short]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Durations inside the cut bounds; captions <= 20 cps]
    success_criteria: [timeline.long.json and timeline.short.json exist]
  - name: score
    skill: pipelines/shorted-results/production-director
    produces: [mix]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Mix report -14 LUFS +/-1, true peak <= -1.5 dBTP]
    success_criteria: [mix.long.wav and mix.short.wav exist with reports]
  - name: render
    skill: pipelines/shorted-results/production-director
    produces: [renders]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Both cuts captioned and clean, thumbnail and cover]
    success_criteria: [render.json lists every output]
  - name: qa
    skill: pipelines/shorted-results/review-director
    produces: [qa]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Every QA check passes; failures name the owning stage]
    success_criteria: [qa.json overall == pass]
  - name: reflect
    skill: pipelines/shorted-results/review-director
    produces: [reflect]
    tools_available: []
    checkpoint_required: true
    human_approval_default: false
    review_focus: [Every coverage miss and data wish is classified]
    success_criteria: [reflect.md written; gaps.jsonl updated]
```

The checkpoint writer enforces this order, so a stage cannot complete before the stages above it.

- [ ] **Step 4: Write the playbook**

`styles/shorted-field-guide.yaml`:

```yaml
identity:
  name: "Shorted Field Guide"
  category: custom  # the schema enum has no paper-collage
  mood: wry, warm, factual, curious
  pace: moderate
  best_for: "Shorted results walkthroughs and short-interest explainers"

visual_language:
  color_palette:
    primary: ["#9E5210", "#D9842A"]
    accent: ["#B4532A", "#87A86B", "#2F5470"]
    background: "#1F3B33"
    text: "#F7F1E5"  # text on the desk and on caption bars; page text is ink #2B2622, drawn by the scenes
    muted: "#C9BBA3"  # muted text on the desk; muted page text is #72625A, drawn by the scenes
  composition: field-guide pages on an ink-green desk; one idea per page; key content inside the frame's safe area
  texture: hand-cut and torn paper with visible fibres, soft lifted shadows, 12 fps stop-motion boil

typography:
  headings:
    font: "Newsreader"
    weight: 700
  body:
    font: "IBM Plex Mono"
    weight: 500
  code:
    font: "IBM Plex Mono"
    weight: 500

motion:
  transitions: [page-turn, cut]
  animation_style: "paper pops with a small overshoot; lines drawn on; stop-motion boil at 12 fps"
  pacing_rules:
    min_scene_hold_seconds: 2.5
    max_scene_hold_seconds: 14
    transition_duration_seconds: 0.45

audio:
  voice_style: "Australian, warm, conversational, dry humour (Gemini en-au-tutor-5)"
  music_mood: "playful field-guide theme: marimba, pizzicato, harp, celesta; tension bed for the bears chapter"
  music_volume: 0.12
  sfx_style: "paper: page flips, pops, stamps"

asset_generation:
  image_prompt_prefix: "hand-made cut-paper collage illustration, warm ivory paper, charcoal, burnt amber, ink green, no text, "
  consistency_anchors:
    - "Kraft-paper bear host with cream muzzle and rust striped necktie"
    - "Ink-green desk, ivory field-guide pages, amber accents"
    - "Real paper texture; no glossy 3D; no rendered text or numbers"

quality_rules:
  - "Every number on screen comes from a dossier binding"
  - "True red and green only for direction of movement"
  - "Every chart shows its as-at date and source"
  - "Short-interest scenes carry the ASIC caveat super"
  - "End card carries the general-advice line"
```

- [ ] **Step 5: Write the stage skills**

`tools/shorted/__init__.py`:

```python
"""Shorted pipeline pack: dossier, gates, kit, narration, timeline, score, render, QA, reflection."""
```

`skills/pipelines/shorted-results/executive-producer.md`:

````markdown
# Shorted results — executive producer

You run `shorted-results`: one ASX ticker in, two videos out — a ~5 minute 16:9
long form and a 60-90 s 9:16 short — walking through the latest financial report
with Shorted's data. Design: shorted.com.au `docs/superpowers/specs/2026-10-07-stock-report-video-design.md`.

## Order

`dossier → brand → storyboard (APPROVAL) → assets → voice → timeline → score → render → qa → reflect`

Each stage is one command from the studio root:

```bash
.venv/bin/python -m tools.shorted.cli <stage> --ticker <CODE>
```

It writes files under `projects/<project_id>/` and a checkpoint. Re-run a stage
to redo it; every stage reads files, never memory. `status` prints the stage rail.

## Non-negotiables

- Every figure on screen or in the narration is a `{{path|format}}` binding to
  `artifacts/dossier.json`. Never type a number. The gates refuse free numerals.
- No buy/sell/hold, targets, valuation opinions, predictions, or causal claims
  about price or short moves. `tools/shorted/lint.py` enforces.
- ASIC data is aggregated: never say who is short or why. The timeline adds the
  caveat super to every scene that binds `short.*`.
- Nothing publishes. Phase 1 generates no images or video; its only paid call is Gemini TTS (a few cents a run).

## The approval

After `storyboard` passes its gates, show the user
`projects/<id>/artifacts/review.md` (the resolved script, every scene as it will be drawn, the
thumbnail, values shown as n/a or n/m, warnings, word counts)
and END YOUR TURN. Run `approve` only after they say yes.

## When something fails

- Gate errors: edit the storyboard JSON, re-run `storyboard`.
- A chapter with coverage `ok: false`: leave it out of both storyboards and add a
  `data_wishes` entry naming what was missing.
- QA failure: read `qa.json`; each failed check names the stage to re-run.
````

`skills/pipelines/shorted-results/dossier-director.md`:

````markdown
# Dossier director

`cli dossier --ticker X` calls every public Shorted endpoint (see
`tools/shorted/calls.py`) and writes `artifacts/dossier.json` and
`artifacts/coverage.json`.

Every leaf is a value: `{value, unit, as_at, trust, currency, note, source}`.

| trust | meaning | on screen | in narration |
| --- | --- | --- | --- |
| ok | usable | yes | yes |
| stale | older than its freshness window (short 10 d, price 5 d, results 400 d) | yes, with as-at | yes, warned |
| missing | not reported | `n/a` | refused |
| withheld | not meaningful for this company (`notMeaningful`) | `n/m` | refused |
| untrusted | e.g. a downsampled series used for a point value, a low-confidence digest | refused | refused |

Rules the code already enforces (do not work around them):

- Short %, its 30/90-day change and the 1-year peak come from the daily 1Y series
  (`downsampled: false`). `MAX` is never used for a figure.
- Money carries the reporting currency. BHP reports in USD.
- Growth is like-for-like and null when the prior is ≤ 0.
- Rank outside the top 100 is `null` with note "outside the top 100".

- Peers come from Shorted's similarity graph when at least 3 similar companies have short
  data, else from the industry; `peers.basis` says which.
- `company.name` keeps the company's own casing; `company.headquarters` is "City, STATE".
- Third-party headlines that bait advice, rate or value the stock, call its price, or round up
  several companies are left out of `news.items` and `events.items`, and so are routine ASX notices
  (Appendix 3B, 3D–3H, 3X–3Z, quotation, substantial holder); the note says how many. The company's
  own announcements are never treated as advice or a roundup, and results, quarterly and dividend
  announcements and buy-back notifications (Appendix 4C, 4D, 4E, 5B, 3A.1, 3C) are never routine. A headline seen
  twice (an announcement and its news echo) is shown once, on its Sydney date.
- Margins, ROE and FCF conversion come from Shorted's quality view only when its basis is the
  result's own period; otherwise they are recomputed from that period's lines or marked
  untrusted. Net debt needs the result's balance date.
- A director dealing's undisclosed shares, price or value stay unknown (never 0); a dealing listed
  twice is shown once; one with no director named and no amounts is counted, not shown.
- `results.guidance` is a verbatim quote for a period after the result, at most 400 days old.
- A bank or insurer has no cash-flow, cash or debt figures (withheld); its `cash` chapter uses
  net interest income, ROE, ROA, assets, equity and payout instead.

`cli dossier` then reads the ticker through Shorted's MCP server and writes `artifacts/mcp.json`:
`parity` (the API and MCP must agree on headline figures; a mismatch is a Shorted defect to
report, never a reason to stop), `coverage` (dossier sections no MCP tool serves) and `extras`.

Read `coverage.json` before writing the storyboard. If `company` or `bears` is not
ok (`cli dossier` exits 2), stop and tell the user: the video cannot be made honestly.
Otherwise run `cli brand --ticker X` next.
````

`skills/pipelines/shorted-results/storyboard-director.md`:

````markdown
# Storyboard director

You write `artifacts/storyboard.long.json` and `artifacts/storyboard.short.json`,
then run `cli storyboard --ticker X` (the gates). Fix every error; read every warning.

## Shape

```json
{
  "version": "1.0", "ticker": "DRO", "cut": "long", "title": "DroneShield's half, and the bears",
  "thumbnail": {"headline": ["Know where", "the bears are."], "kicker": "A field guide to the bears"},
  "chapters": [
    {"id": "result", "no": 3, "title": "The result", "scenes": [
      {"id": "s07", "type": "number_card", "transition": "page", "min_seconds": 4,
       "props": {"no": 3, "title": "The result",
                 "items": [{"label": "Revenue", "value": "{{results.revenue|money}}",
                            "prior": "vs {{results.revenue_prior|money}} a year earlier",
                            "change": "{{results.revenue_yoy_pct|change_pct}}", "direction": "up"}],
                 "as_at": "{{results.period|period}}", "source": "{{results.revenue|source}}"},
       "lines": [{"id": "L12", "style": "warm, confident",
                  "text": "Revenue came in at {{results.revenue|money}}, {{results.revenue_yoy_pct|change_pct}} on a year earlier."}]}
    ]}
  ],
  "data_wishes": [{"chapter": "outlook", "wanted": "FY27 revenue guidance range", "why": "the outlook chapter had nothing to quote"}]
}
```

Chapter ids: `cold_open, company, result, cash, outlook, bears, news, watch, close`.
The short uses `cold_open, result, bears, news or watch, close`. Every storyboard
ends with an `end_card` scene whose props equal `gates.END_CARD` exactly.

## Scene catalogue (props)

| type | props |
| --- | --- |
| `opening` | `ticker`, `company`, `kicker` |
| `chapter` | `no`, `title`, `sub?` |
| `company` | `no?`, `name`, `ticker`, `industry?`, `summary`, `logo?` (image key), `hq?` |
| `number_card` | `no?`, `title`, `items[1..3]: {label, value, prior?, change?, direction?}`, `as_at`, `source` |
| `bar_compare` | `no?`, `title`, `items` (structured: `bars_history` or `bars_peers`), `as_at`, `source` |
| `line_chart` | `no?`, `title`, `series[1..2]: {label, points (structured: series), unit: pct\|money, axis: left\|right, last}`, `as_at`, `source` |
| `list_card` | `no?`, `title`, `rows` (structured: `rows`, `rows3`, `rows5`), `as_at`, `source` |
| `quote_card` | `no?`, `title`, `quote` (verbatim from the filing; see "Text that fits"), `attribution`, `as_at` |
| `plate` | `no?`, `title`, `image` (`plate_topshorts`, `plate_stock_chart`, `plate_treemap`), `caption`, `as_at` |
| `end_card` | exactly `gates.END_CARD` |

`direction` (`up`, `down` or `flat`) must match the sign the change shows, so bind that change with
`change_pct` or `pp`; the gates check it. `axis`, `unit` and image keys are structural and need no binding.
Labels and titles (the storyboard's and every chapter's too) must not contain digits or number words
("two", "doubled", "half of"); put a period label in with `{{results.period|period}}`. Chapter titles are
plain words: they become the YouTube chapter list as written. Data cards and charts must carry `as_at` (one
binding formatted `as_at`, `period`, `date` or `month`) and `source` (one binding formatted `source`). A JSON
number is a typed figure; only `no` may be one. Scene ids and line ids are unique across the storyboard.

## Text that fits

Each scene shows text whole up to these lengths (characters as shown, after bindings resolve; `gates.TEXT_BUDGETS`).
Over a limit, text you type and the quote are errors: shorten it, or choose a shorter passage. Bound data you cannot
shorten (company name, summary, headlines, bar labels) is a warning on `review.md`: the scene shrinks it and cuts it only
as a last resort, so read those warnings.

| text | long (16:9) | short (9:16) |
| --- | --- | --- |
| card `title` | 88 | 46 |
| `chapter` `title` / `sub` | 88 / 108 | 46 / 102 |
| `opening` `kicker` | 68 | 48 |
| `number_card` `label`, three figures / one or two | 32 / 58 | 54 / 54 |
| `number_card` `prior`, three figures / one or two | 88 / 140 | 138 / 138 |
| `quote` (no run over 28 characters without a space) | 320 | 240 |
| `attribution` | 138 | 94 |
| `plate` `caption` | 24 | 37 |
| `line_chart` series `label` | 52 | 50 |
| bound, a warning: `opening` `company` / `company` `name` | 88 / 88 | 48 / 46 |
| bound, a warning: `summary`; list row text (a row with a value) | 840; 175 (150) | 460; 100 (60) |
| bound, a warning: `bar_compare` label | 58 | 46 |

One thumbnail headline is drawn on both the 16:9 thumbnail and the 9:16 cover, so it must fit both: at most 3 rows of
15 characters, and a `kicker` of 48.

## The spec's scenes, as types

| spec scene | type and bindings |
| --- | --- |
| `opening_sting` | `opening` (binoculars find the ticker) |
| `chapter_card` | `chapter` |
| `company_card`, `lower_third` | `company` (its name strip is the lower third) |
| `live_plate` | `plate` |
| `result_compare` | `number_card`: revenue, net income, EPS, each with `prior` and `change` |
| `margins` | `number_card`: gross, operating, net margin |
| `cash_flow` | `number_card`: `fcf`, `fcf_margin_pct`, `fcf_conversion` |
| `balance_sheet` | `number_card`: `cash`, `total_debt`, `net_debt` |
| `bank_balance_sheet` (when `results.is_financial`) | `number_card`: `net_interest_income` (`prior`, `change` from `net_interest_income_yoy_pct`), `roe_pct`, `roa_pct`; then `total_assets`, `total_equity`, `payout_ratio_pct`. A bank's cash flow, cash and debt are withheld: its `cash` chapter tells the balance sheet with these instead |
| `guidance_quote` | `quote_card`: `results.guidance` |
| `dividend_history` | `list_card`: `dividends.history|rows5` |
| revenue history | `bar_compare`: `results.history|bars_history` |
| `short_vs_price` | `line_chart`: `short.series_1y` (left, pct) and `price.series_1y` (right, money) |
| `short_rank` | `number_card`: `short.pct`, `short.rank`, `short.days_to_cover` |
| `peer_crowding` | `bar_compare`: `peers.items|bars_peers` |
| `news_timeline` | `list_card`: `news.items|rows5` |
| `director_ledger` | `list_card`: `insiders.trades|rows5` |
| `strategy_fit` | `list_card`: `strategy.fits|rows` |
| `what_to_watch` | `list_card`: `events.items|rows3` |

## Formats

Text (screen and voice): `money, money_abs, eps, pct, pct1, change_pct, pp, count,
int, rank, date, month, period, ratio, days, text, as_at, source`. Structured (a whole
prop value, screen only): `series, rows, rows3, rows5, bars_history, bars_peers`.

## Paths

`company.{name,ticker,industry,summary,website,logo_url,headquarters,address,market_cap}`
`short.{pct,change_30d_pp,change_90d_pp,peak_1y,reported_positions,shares_on_issue,days_to_cover,rank,series_1y}`
`price.{close,change_1y_pct,series_1y}`
`results.{period,revenue,revenue_prior,revenue_yoy_pct,net_income,net_income_prior,eps,eps_prior,eps_yoy_pct,gross_margin_pct,operating_margin_pct,net_margin_pct,fcf,fcf_margin_pct,fcf_conversion,cash,total_debt,net_debt,roe_pct,is_financial,filing,guidance,history,net_interest_income,net_interest_income_prior,net_interest_income_yoy_pct,total_assets,total_equity,roa_pct,payout_ratio_pct}`
`dividends.history` `news.items` `events.items` `insiders.{trades,net_value_90d}`
`peers.{items,basis,industry,subject_rank}` `strategy.{fits,regime}` `signals.{adverse,positive}`
Row fields: `news.items[i].{date,headline,source,sentiment}`, `events.items[i].{date,title,type}`,
`insiders.trades[i].{date,director,type,shares,value}`, `dividends.history[i].{ex_date,amount,franking,type}`,
`results.filing.{title,date,url,digest}`, `peers.items[i].{code,name,short_pct}`,
`strategy.fits[i].{name,status,score,rank,total}`.

`company.headquarters` is "City, STATE"; never narrate `company.address`. Say how the peer set
was chosen (`{{peers.basis|text}}`: "similar companies" or "<industry> industry").

## Research with the Shorted MCP server

If the Shorted connector is connected in your session (tools named like
`mcp__…shorted__get_stock_news`), use it to find the story before writing:
- the `short_interest_briefing` prompt;
- `get_stock_news` (ASX announcements are `is_price_sensitive`);
- `list_squeeze_candidates`;
- `get_report` for the latest weekly report.

It reads the same data as the dossier, but every figure must still be a dossier binding.
When MCP shows something the dossier lacks, do not type it. Add a `data_wishes` entry that names
the tool, e.g. `{"chapter": "news", "wanted": "the weekly report's mention of DRO (MCP get_report)",
"why": "..."}`. Reflection files it as a pipeline gap: data Shorted has that the pipeline does not
collect yet.

## Voice

Wry Australian nature-documentary warmth, never hype. Lead with the number. Use
`money_abs` with the word "loss" for negative profit. Never bind a `missing`,
`withheld` or `untrusted` value into a line. Short sentences; one figure per sentence.
Budgets: long 650-750 spoken words, short 150-200.

## Words that fail the lint

The lint reads every line, prop, title, chapter title and thumbnail string, and each bound text value
on its own: Shorted's own text (the company summary) fails, a third party's (a headline, the filing,
a guidance quote) is a warning for the reviewer. It rejects:
- advice: "you/investors should", "buy DRO", "hold your shares", "time to take profits", "entry point",
  ratings ("it's a buy", "rated outperform", "top pick") and price targets;
- valuation opinions: "undervalued", "looks cheap", "a bargain", "good value", "a bullish sign";
- predictions: "will / set to / likely to / poised to rise, fall, rally, squeeze", "could squeeze
  higher", "more upside", "ripe for a squeeze", "expect the price to recover"; and promises ("can't lose");
- who is short ("hedge funds are shorting it", "who's short") or why ("the bears are worried",
  "short sellers expect a weak result");
- any causal link in a clause about the share price or short interest: "because", "due to", "driven
  by", "on the back of", "as investors", "on weak guidance", "fuelled by", "reflects", "so the shares
  rose", "helped the share price", or "That was because ..." after a line about a move.

Say what happened and when; do not say why ("Over the same period, the shares fell", not "as the shares
fell"). The mechanism is fine: "short sellers borrow shares, sell them and bet the price will fall".
A scene that talks about short interest should bind a `short.*` or `peers.*` value, so it carries the
ASIC caveat.
````

`skills/pipelines/shorted-results/production-director.md`:

````markdown
# Production director

`brand` runs before the storyboard (`cli brand --ticker X`: brand.json and the company logo).
From the studio root, after the user approved the storyboard:

```bash
.venv/bin/python -m tools.shorted.cli assets --ticker X    # live plates; stages images; asset manifest
.venv/bin/python -m tools.shorted.cli voice --ticker X     # TTS takes, WER checked
.venv/bin/python -m tools.shorted.cli timeline --ticker X  # scene timings, captions, SRT/VTT, chapters
.venv/bin/python -m tools.shorted.cli score --ticker X      # music, effects, mix (-14 LUFS)
.venv/bin/python -m tools.shorted.cli render --ticker X    # long + short, captioned + clean, thumbnail, cover
```

Check after each:

- `assets`: every `plate` image key in the storyboards exists in `artifacts/images.json`.
  A failed capture: drop that plate scene (it is illustration, not data) and re-run timeline.
- `voice`: `artifacts/narration.json` lists a take for every line with `wer <= 0.10`.
  A line that fails three takes: rephrase it (numbers spoken awkwardly are the usual cause),
  re-run the gates, re-run `voice`.
- `timeline`: durations inside the cut bounds (the CLI prints them). Long too short: add a
  scene from an unused chapter's data; too long: trim lines.
- `score`: `artifacts/mix.<cut>.json` shows -14 LUFS ±1 and true peak <= -1.5.
- `render`: `artifacts/render.json` lists 4 videos and 3 stills (thumbnail PNG and JPG, cover).
````

`skills/pipelines/shorted-results/review-director.md`:

````markdown
# Review director

```bash
.venv/bin/python -m tools.shorted.cli qa --ticker X
.venv/bin/python -m tools.shorted.cli reflect --ticker X
```

`artifacts/qa.json` checks, thresholds and the stage that owns a failure:

| check | threshold | fix in |
| --- | --- | --- |
| number_audit | every rendered string equals its re-resolved binding; no unbound numerals | storyboard / timeline |
| spoken_figures | each line, heard in its window of the final mix, carries its take's figures exactly (sign, digits, scale) | score (ducking); voice (rephrase) when the take reads ambiguously |
| wer | every line heard (WER <= 0.5 in its window) and heard to its end; the cut's WER within 0.03 of the takes' own | score |
| loudness | -14 LUFS ±1, true peak <= -1.0 dBTP | score |
| captions | <= 20 characters/s, <= 42 characters per line | timeline |
| duration | long 270-330 s, short 60-90 s | storyboard / timeline |
| av_sync | video and audio durations within 0.1 s | render |
| colour | BT.709 primaries, transfer and matrix tags | render |

Look at `renders/contact.<cut>.jpg` yourself before calling a run done: legibility,
nothing under the caption band, no blank frames.

`reflect` classifies what the run lacked (`missing_field`, `missing_endpoint`,
`stale_sync`, `low_trust_extraction`, `kit_miss`; `unavailable_by_law` is recorded but
is never a gap), appends to `shorted-gaps/gaps.jsonl`, and rewrites
`shorted-gaps/backlog.md` ranked by count × impact. Mention the top three to the user.
````

- [ ] **Step 6: Exclude the pipeline from the runtime-selection contract**

OpenMontage's `tests/contracts/test_runtime_presentation_contract.py` requires every composing pipeline to have a `proposal` or `idea` stage whose skill offers a choice of render runtime (Remotion or HyperFrames). This pipeline has one fixed runtime. The test's own failure message offers the alternative of listing the pipeline in `_EXCLUDED_PIPELINES` with a reason. Add this entry to that dict:

```python
    "shorted-results": "one fixed runtime: the Remotion paper-collage canvas, so runtime selection does not apply",
```

- [ ] **Step 7: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_pack.py -q && .venv/bin/python -m pytest tests/contracts -q -p no:cacheprovider | tail -1`
Expected: the 4 pack tests pass, and the contract suite has no failures. Compare its counts with `.shorted-baseline.txt` (1229 passed, 7 skipped). New passing cases come from contracts parametrized over every manifest and playbook; name any new skip in your report.

- [ ] **Step 8: Commit**

```bash
git add pipeline_defs/shorted-results.yaml styles/shorted-field-guide.yaml skills/pipelines/shorted-results tools/shorted/__init__.py tests/shorted tests/contracts/test_runtime_presentation_contract.py
git commit -m "feat(shorted): pipeline pack skeleton (manifest, playbook, stage skills)"
```

---

## Part B: data and governance

### Task 3: Values and formatters

**Files:**
- Create: `tools/shorted/values.py`, `tools/shorted/formatters.py`
- Test: `tests/shorted/test_formatters.py`

**Interfaces:**
- Produces:
  - `Source(endpoint: str, request: dict, fetched_at: str)`.
  - `Value(value, unit, as_at, trust, source, currency=None, note=None)`, with `.usable`, `.to_json()` and `Value.from_json(d)`. `missing(unit, source, note) -> Value` and `is_value(d) -> bool` are helpers.
  - `render(v: Value, fmt: str, mode: "display"|"spoken") -> str | list`.
  - `axis_label(x: float, unit: "pct"|"money", currency: str|None) -> str` and `month_label(iso: str) -> str`.
  - `FormatError`, `Unspeakable(FormatError)`, `STRUCTURED_FORMATS`.
  - **Units:** `text, money, eps, pct, pp, count, int, days, rank, period, ratio, bool, filing, number, series:pct, series:money, rows:news, rows:events, rows:insiders, rows:dividends, rows:strategy, rows:signals, rows:peers, bars:history`.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_formatters.py`:

```python
import pytest

from tools.shorted.formatters import FormatError, Unspeakable, axis_label, month_label, render
from tools.shorted.values import Source, Value

SRC = Source("GetStockFundamentals", {}, "2026-10-07T00:00:00+00:00")


def V(value, unit, **kw):
    return Value(value, unit, kw.pop("as_at", "2026-06-30"), kw.pop("trust", "ok"), SRC, **kw)


def test_money_aud():
    v = V(1_523_000_000.0, "money", currency="AUD")
    assert render(v, "money", "display") == "A$1.5B"
    assert render(v, "money", "spoken") == "1.5 billion dollars"


def test_money_usd():
    v = V(58_800_000_000.0, "money", currency="USD")
    assert render(v, "money", "display") == "US$58.8B"
    assert render(v, "money", "spoken") == "58.8 billion US dollars"


def test_money_negative_uses_true_minus():
    v = V(-30_800_000.0, "money", currency="AUD")
    assert render(v, "money", "display") == "−A$30.8M"
    assert render(v, "money_abs", "spoken") == "30.8 million dollars"
    assert render(v, "money", "spoken") == "minus 30.8 million dollars"


def test_pct_change_and_pp():
    assert render(V(12.634, "pct"), "pct", "display") == "12.63%"
    assert render(V(12.634, "pct"), "pct", "spoken") == "12.6 per cent"
    assert render(V(73.0, "pct"), "change_pct", "display") == "+73.0%"
    assert render(V(-11.4, "pct"), "change_pct", "display") == "−11.4%"
    assert render(V(-11.4, "pct"), "change_pct", "spoken") == "down 11.4 per cent"
    assert render(V(0.95, "pp"), "pp", "display") == "+0.95 pp"
    assert render(V(-0.4, "pp"), "pp", "spoken") == "down 0.4 percentage points"


def test_eps_cents_aud_and_usd():
    assert render(V(0.121, "eps", currency="AUD"), "eps", "display") == "12.1c"
    assert render(V(0.121, "eps", currency="AUD"), "eps", "spoken") == "12.1 cents"
    assert render(V(1.354, "eps", currency="USD"), "eps", "display") == "US$1.354"


def test_counts_dates_and_period():
    assert render(V(139_403_700.0, "count"), "count", "display") == "139.4M"
    assert render(V(139_403_700.0, "count"), "count", "spoken") == "139.4 million"
    assert render(V("2026-09-30", "text"), "date", "display") == "30 Sep 2026"
    assert render(V("2026-09-30", "text"), "date", "spoken") == "30 September 2026"
    period = V({"end": "2026-06-30", "type": "annual"}, "period")
    assert render(period, "period", "display") == "12 months to 30 Jun 2026"
    assert render(period, "period", "spoken") == "the 12 months to 30 June 2026"
    assert render(V(1.0, "pct", as_at="2026-09-30"), "as_at", "display") == "30 Sep 2026"


def test_rank_outside():
    v = V(None, "rank", note="outside the top 100")
    assert render(v, "rank", "display") == "outside the top 100"
    assert render(v, "rank", "spoken") == "outside the top 100"
    assert render(V(3, "rank"), "rank", "display") == "#3"
    assert render(V(3, "rank"), "rank", "spoken") == "number 3"


def test_withheld_display_and_unspeakable():
    v = V(None, "pct", trust="withheld", note="not meaningful for this company")
    assert render(v, "pct", "display") == "n/m"
    with pytest.raises(Unspeakable):
        render(v, "pct", "spoken")


def test_missing_is_na_and_unspeakable():
    v = V(None, "money", trust="missing", note="not reported")
    assert render(v, "money", "display") == "n/a"
    with pytest.raises(Unspeakable):
        render(v, "money", "spoken")


def test_untrusted_cannot_be_shown():
    with pytest.raises(FormatError):
        render(V(10.0, "pct", trust="untrusted", note="downsampled"), "pct", "display")


def test_unit_mismatch_is_error():
    with pytest.raises(FormatError):
        render(V(10.0, "pct"), "money", "display")


def test_rows_news_and_bars_peers():
    news = V([{"date": "2026-09-28", "headline": "DroneShield wins contract", "source": "x",
               "sentiment": "positive"}], "rows:news")
    assert render(news, "rows3", "display") == [
        {"date": "28 Sep", "text": "DroneShield wins contract", "tag": "positive", "tone": "pos"}]
    peers = V([{"code": "EOS", "name": "EOS", "short_pct": 9.1, "subject": False},
               {"code": "DRO", "name": "DroneShield", "short_pct": 15.07, "subject": True}], "rows:peers")
    bars = render(peers, "bars_peers", "display")
    assert bars[0] == {"label": "DRO", "value": 15.07, "display": "15.07%", "highlight": True}
    assert bars[1]["label"] == "EOS"


def test_structured_cannot_be_spoken_or_empty():
    with pytest.raises(FormatError):
        render(V([["2026-09-30", 1.0]], "series:pct"), "series", "spoken")
    with pytest.raises(FormatError):
        render(V(None, "rows:news", trust="missing", note="none"), "rows", "display")


def test_axis_and_month_labels():
    assert axis_label(16.0, "pct", None) == "16.0%"
    assert axis_label(2.5, "money", "AUD") == "A$2.50"
    assert month_label("2025-10-01") == "Oct 2025"


def test_true_minus_everywhere_and_sign_after_rounding():
    assert render(V(-0.4, "ratio"), "ratio", "display") == "−0.4×"
    assert render(V(-0.4, "ratio"), "ratio", "spoken") == "minus 0.4 times"
    assert render(V(-1234.0, "int"), "int", "display") == "−1,234"
    assert render(V(-2.0, "days"), "days", "display") == "−2.0 days"
    assert render(V(-5e6, "count"), "count", "display") == "−5.0M"
    assert render(V(-0.004, "pct"), "pct", "display") == "0.00%"
    assert render(V(-0.004, "money", currency="AUD"), "money", "display") == "\u2212A$0.004"
    assert render(V(-0.0004, "money", currency="AUD"), "money", "display") == "A$0.00"
    assert axis_label(-2.5, "pct", None) == "−2.5%"


def test_scale_rolls_over_and_prices_keep_cents():
    assert render(V(999_950_000.0, "money", currency="AUD"), "money", "display") == "A$1.0B"
    assert render(V(999_949_999.0, "money", currency="AUD"), "money", "display") == "A$999.9M"
    assert render(V(123.45, "money", currency="AUD"), "money", "display") == "A$123.45"
    assert render(V(2.0, "money", currency="AUD"), "money", "spoken") == "2 dollars"
    assert render(V(12.0, "count"), "count", "display") == "12"


def test_axis_labels_keep_the_tick_exact():
    assert [axis_label(x, "pct", None) for x in (0.0, 0.25, 0.5, 0.75, 1.0)] == ["0.0%", "0.25%", "0.5%", "0.75%", "1.0%"]
    assert axis_label(100.0, "money", "AUD") == "A$100.00"
    with pytest.raises(FormatError):
        axis_label(5.0, "ratio", "AUD")


def test_withheld_or_missing_rank_is_never_shown_as_a_number():
    withheld = V(None, "rank", trust="withheld", note="not meaningful")
    assert render(withheld, "rank", "display") == "n/m"
    with pytest.raises(Unspeakable):
        render(withheld, "rank", "spoken")
    assert render(V(None, "rank", trust="missing", note="no list"), "rank", "display") == "n/a"


def test_bad_values_are_format_errors():
    with pytest.raises(FormatError):
        render(V(float("nan"), "pct"), "pct", "display")
    with pytest.raises(FormatError):
        render(V(None, "pct"), "pct", "display")
    with pytest.raises(FormatError):
        render(V({"end": "2026-03-31", "type": "quarter"}, "period"), "period", "display")
    with pytest.raises(ValueError):
        V(1.0, "pct", trust="estimated")


def test_spoken_small_values_and_singulars():
    assert render(V(0.04, "pct"), "pct", "spoken") == "0.04 per cent"
    assert render(V(0.5, "pct"), "pct", "spoken") == "0.5 per cent"
    assert render(V(1.0, "ratio"), "ratio", "spoken") == "1 time"
    assert render(V(1.0, "days"), "days", "spoken") == "1 day"


def test_eps_and_pp_take_their_sign_after_rounding():
    assert render(V(-0.0001, "eps", currency="AUD"), "eps", "display") == "0.0c"
    assert render(V(-0.0001, "eps", currency="AUD"), "eps", "spoken") == "0 cents"
    assert render(V(-0.0004, "eps", currency="USD"), "eps", "display") == "US$0.000"
    assert render(V(-0.001, "pp"), "pp", "display") == "0.00 pp"
    assert render(V(-0.04, "pct"), "change_pct", "display") == "0.0%"


def test_singular_units_and_small_prices():
    assert render(V(1.0, "money", currency="AUD"), "money", "spoken") == "1 dollar"
    assert render(V(0.01, "eps", currency="AUD"), "eps", "spoken") == "1 cent"
    assert render(V(0.455, "money", currency="AUD"), "money", "display") == "A$0.455"
    assert render(V(0.043, "money", currency="AUD"), "money", "display") == "A$0.043"
    assert render(V(1.5, "money", currency="AUD"), "money", "display") == "A$1.50"
    assert axis_label(0.025, "money", "AUD") == "A$0.025"
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_formatters.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.formatters'`.

- [ ] **Step 3: Implement `values.py`**

```python
"""A dossier value: a figure with its unit, as-at date, trust state and provenance."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional

Trust = Literal["ok", "stale", "withheld", "untrusted", "missing"]
USABLE = ("ok", "stale")
TRUST_STATES = {"ok", "stale", "withheld", "untrusted", "missing"}


@dataclass(frozen=True)
class Source:
    endpoint: str
    request: dict
    fetched_at: str

    def to_json(self) -> dict:
        return {"endpoint": self.endpoint, "request": self.request, "fetched_at": self.fetched_at}


@dataclass(frozen=True)
class Value:
    value: Any
    unit: str
    as_at: Optional[str]
    trust: Trust
    source: Source
    currency: Optional[str] = None
    note: Optional[str] = None

    def __post_init__(self) -> None:
        if self.trust not in TRUST_STATES:
            raise ValueError(f"unknown trust state {self.trust!r}; expected one of {sorted(TRUST_STATES)}")

    @property
    def usable(self) -> bool:
        return self.trust in USABLE and self.value not in (None, [], {})

    def to_json(self) -> dict:
        return {"value": self.value, "unit": self.unit, "as_at": self.as_at, "trust": self.trust,
                "currency": self.currency, "note": self.note, "source": self.source.to_json()}

    @classmethod
    def from_json(cls, d: dict) -> "Value":
        s = d["source"]
        return cls(d.get("value"), d["unit"], d.get("as_at"), d["trust"],
                   Source(s["endpoint"], s.get("request", {}), s["fetched_at"]),
                   d.get("currency"), d.get("note"))


def missing(unit: str, source: Source, note: str) -> Value:
    return Value(None, unit, None, "missing", source, note=note)


def is_value(d: Any) -> bool:
    return isinstance(d, dict) and {"value", "unit", "trust", "source"} <= set(d)
```

- [ ] **Step 4: Implement `formatters.py`**

```python
"""Display and spoken forms of dossier values: the only place numbers become text.

Display strings go on screen; spoken strings go to the voice. Rules (DESIGN.md + spec):
money in the reporting currency as A$/US$ (never a bare $), true minus for negatives,
missing -> n/a and withheld -> n/m on screen (neither can be spoken), untrusted never shown.
"""

from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Callable

from tools.shorted.values import Source, Value

MINUS = "−"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
CUR_DISPLAY = {"AUD": "A$", "USD": "US$", "NZD": "NZ$", "CAD": "C$", "GBP": "£", "EUR": "€"}
CUR_SPOKEN = {"AUD": "dollars", "USD": "US dollars", "NZD": "New Zealand dollars",
              "CAD": "Canadian dollars", "GBP": "pounds", "EUR": "euros"}
CUR_SPOKEN_ONE = {"AUD": "dollar", "USD": "US dollar", "NZD": "New Zealand dollar", "CAD": "Canadian dollar",
                  "GBP": "pound", "EUR": "euro"}
CUR_CENT_ONE = {"AUD": "cent", "USD": "US cent", "NZD": "New Zealand cent", "CAD": "Canadian cent", "GBP": "penny",
                "EUR": "euro cent"}
CUR_CENTS = {"AUD": "cents", "USD": "US cents", "NZD": "New Zealand cents",
             "CAD": "Canadian cents", "GBP": "pence", "EUR": "euro cents"}
SOURCE_LABELS = {
    "GetStock": "ASIC via Shorted", "GetStockDetails": "Shorted company profile",
    "GetStockData": "ASIC short position reports via Shorted", "GetStockPrices": "Shorted price history",
    "GetStockFundamentals": "Company accounts via Shorted",
    "GetStockFinancialHighlights": "Company filing via Shorted",
    "GetDividendHistory": "Shorted dividend history",
    "GetDirectorTrades": "Director's interest notices via Shorted", "GetPeerComparison": "ASIC via Shorted",
    "GetEventTimeline": "Shorted event timeline", "GetStockSignals": "Shorted signals",
    "GetStockStrategyFit": "Shorted stock picker", "GetStockNews": "Shorted news",
    "GetTopShorts": "ASIC via Shorted",
}
STRUCTURED_FORMATS = {"series", "rows", "rows3", "rows5", "bars_history", "bars_peers"}
_UNITS = {
    "money": {"money", "number"}, "money_abs": {"money", "number"}, "eps": {"eps", "number"},
    "pct": {"pct", "number"}, "pct1": {"pct", "number"}, "change_pct": {"pct", "number"},
    "pp": {"pp", "number"}, "count": {"count", "number"}, "int": {"int", "count", "number"},
    "rank": {"rank", "number"}, "period": {"period"}, "ratio": {"ratio", "number"},
    "days": {"days", "number"}, "text": {"text"}, "bars_history": {"bars:history"},
    "bars_peers": {"rows:peers"},
}
_ANY_UNIT = {"date", "month", "as_at", "source"}


class FormatError(ValueError):
    """The value cannot be shown in this format."""


class Unspeakable(FormatError):
    """Missing or withheld values may be shown (n/a, n/m) but never spoken."""


def _trim(s: str) -> str:
    return re.sub(r"\.0+$", "", s)


_STEPS = ((1e12, "T", "trillion"), (1e9, "B", "billion"), (1e6, "M", "million"), (1e3, "K", "thousand"))


def _scale(x: float) -> tuple[str, str, str]:
    """|x| -> (number text, short suffix, spoken word): 1.52e9 -> ('1.5', 'B', 'billion')."""
    a = abs(x)
    for div, short, word in _STEPS:
        if a >= div * 0.99995:  # 999.95M already rounds to 1.0B at one decimal
            return f"{a / div:.1f}", short, word
    if a < 2:  # ASX ticks are 0.1c below 10c and 0.5c below $2: keep a third decimal when it is used
        txt = f"{a:.3f}"
        return (txt[:-1] if txt.endswith("0") else txt), "", ""
    return f"{a:.2f}", "", ""


def _neg(x: float, rendered_abs: str) -> bool:
    """Negative after rounding: the sign comes from the rendered digits, so -0.004 never reads as a minus 0.00."""
    return x < 0 and any(ch in "123456789" for ch in rendered_abs)


def _sign(x: float, rendered_abs: str) -> str:
    """The sign a change shows: true minus, '+', or none for a change that rounds to zero."""
    if _neg(x, rendered_abs):
        return MINUS
    return "+" if any(ch in "123456789" for ch in rendered_abs) else ""


def _cur(v: Value) -> str:
    return (v.currency or "AUD").upper()


def _iso(s: Any) -> date:
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        raise FormatError(f"not an ISO date: {s!r}") from None


def _date_of(v: Value) -> date:
    if isinstance(v.value, str) and len(v.value) >= 10 and v.value[4] == "-":
        return _iso(v.value)
    if v.as_at:
        return _iso(v.as_at)
    raise FormatError("no date to show")


def _money(v: Value, mode: str, signed: bool = True) -> str:
    x = float(v.value)
    num, short, word = _scale(x)
    neg = signed and _neg(x, num)
    cur = _cur(v)
    if mode == "display":
        return f"{MINUS if neg else ''}{CUR_DISPLAY.get(cur, cur + ' ')}{num}{short}"
    name = CUR_SPOKEN_ONE.get(cur, cur) if _trim(num) == "1" and not word else CUR_SPOKEN.get(cur, cur)
    words = " ".join(p for p in (_trim(num), word, name) if p)
    return f"minus {words}" if neg else words


def _eps(v: Value, mode: str) -> str:
    x = float(v.value)
    cur = _cur(v)
    cents = abs(x) * 100
    if mode == "display":
        num = f"{cents:.1f}" if cur == "AUD" else f"{abs(x):.3f}"
        body = f"{num}c" if cur == "AUD" else f"{CUR_DISPLAY.get(cur, cur + ' ')}{num}"
        return (MINUS if _neg(x, num) else "") + body
    num = _trim(f"{cents:.1f}")
    unit = CUR_CENT_ONE.get(cur, cur + " cent") if num == "1" else CUR_CENTS.get(cur, cur + " cents")
    return f"minus {num} {unit}" if _neg(x, num) else f"{num} {unit}"


def _pct(dp: int) -> Callable[[Value, str], str]:
    def fmt(v: Value, mode: str) -> str:
        x = float(v.value)
        if mode == "display":
            body = f"{abs(x):.{dp}f}"
            return f"{MINUS if _neg(x, body) else ''}{body}%"
        body = f"{abs(x):.1f}" if abs(x) >= 1 else f"{abs(x):.2f}".rstrip("0").rstrip(".")  # 0.04 is "0.04", not "0"
        body = _trim(body)
        return f"{'minus ' if _neg(x, body) else ''}{body} per cent"
    return fmt


def _change_pct(v: Value, mode: str) -> str:
    x = float(v.value)
    if mode == "display":
        body = f"{abs(x):.1f}"
        return f"{_sign(x, body)}{body}%"
    if abs(x) < 0.05:
        return "flat"
    return f"{'up' if x > 0 else 'down'} {_trim(f'{abs(x):.1f}')} per cent"


def _pp(v: Value, mode: str) -> str:
    x = float(v.value)
    if mode == "display":
        body = f"{abs(x):.2f}"
        return f"{_sign(x, body)}{body} pp"
    if abs(x) < 0.005:
        return "unchanged"
    body = f"{abs(x):.2f}".rstrip("0").rstrip(".")
    return f"{'up' if x > 0 else 'down'} {body} percentage points"


def _count(v: Value, mode: str) -> str:
    x = float(v.value)
    num, short, word = _scale(x)
    if not short:  # a count below a thousand is a whole number
        num = f"{abs(x):,.0f}"
    neg = _neg(x, num)
    if mode == "display":
        return f"{MINUS if neg else ''}{num}{short}"
    return ("minus " if neg else "") + " ".join(p for p in (_trim(num), word) if p)


def _int(v: Value, mode: str) -> str:
    n = int(round(float(v.value)))
    body = f"{abs(n):,}"
    return (MINUS if mode == "display" else "minus ") + body if n < 0 else body


def _rank(v: Value, mode: str) -> str:
    """Reached only for ok/stale values: a known rank, or a known 'outside the top N' carried in the note."""
    if v.value is None:
        if not v.note:
            raise FormatError("rank has neither a value nor a note")
        return v.note
    return f"#{int(v.value)}" if mode == "display" else f"number {int(v.value)}"


def _date(v: Value, mode: str) -> str:
    d = _date_of(v)
    month = MONTHS[d.month - 1]
    return f"{d.day} {month[:3] if mode == 'display' else month} {d.year}"


def _month(v: Value, mode: str) -> str:
    d = _date_of(v)
    month = MONTHS[d.month - 1]
    return f"{month[:3] if mode == 'display' else month} {d.year}"


def _period(v: Value, mode: str) -> str:
    months = {"annual": 12, "half": 6}.get(v.value.get("type"))
    if months is None:
        raise FormatError(f"no period wording for type {v.value.get('type')!r}")
    end = _date(Value(v.value["end"], "text", None, "ok", v.source), mode)
    return f"{months} months to {end}" if mode == "display" else f"the {months} months to {end}"


def _ratio(v: Value, mode: str) -> str:
    x = float(v.value)
    body = f"{abs(x):.1f}"
    neg = _neg(x, body)
    if mode == "display":
        return f"{MINUS if neg else ''}{body}×"
    return f"{'minus ' if neg else ''}{_trim(body)} {'time' if _trim(body) == '1' else 'times'}"


def _days(v: Value, mode: str) -> str:
    x = float(v.value)
    body = f"{abs(x):.1f}"
    neg = _neg(x, body)
    if mode == "display":
        return f"{MINUS if neg else ''}{body} days"
    return f"{'minus ' if neg else ''}{_trim(body)} {'day' if _trim(body) == '1' else 'days'}"


def _text(v: Value, mode: str) -> str:
    return str(v.value)


def _as_at(v: Value, mode: str) -> str:
    if not v.as_at:
        raise FormatError("value has no as-at date")
    return _date(Value(v.as_at, "text", None, "ok", v.source), mode)


def _source(v: Value, mode: str) -> str:
    return SOURCE_LABELS.get(v.source.endpoint.split("#", 1)[0], "Shorted")


def _series(v: Value, mode: str) -> list:
    """For drawing only: thinning to about 400 points can drop a spike, so never read a figure off it."""
    pts = [[str(d)[:10], float(x)] for d, x in v.value]
    step = max(1, len(pts) // 400)
    thinned = pts[::step]
    if thinned[-1] != pts[-1]:
        thinned.append(pts[-1])
    return thinned


def _short_date(iso: str | None) -> str | None:
    if not iso:
        return None
    d = _iso(iso)
    return f"{d.day} {MONTHS[d.month - 1][:3]}"


def _tone(sentiment: str | None) -> str:
    s = (sentiment or "").lower()
    return "pos" if s.startswith("pos") else "neg" if s.startswith("neg") else "neutral"


def _row(unit: str, r: dict, v: Value) -> dict:
    money = lambda x: _money(Value(x, "money", None, "ok", v.source, v.currency), "display")
    if unit == "rows:news":
        return {"date": _short_date(r.get("date")), "text": r["headline"],
                "tag": (r.get("sentiment") or "").lower() or None, "tone": _tone(r.get("sentiment"))}
    if unit == "rows:events":
        return {"date": _short_date(r.get("date")), "text": r["title"],
                "tag": (r.get("type") or "").replace("_", " ").lower() or None, "tone": _tone(r.get("sentiment"))}
    if unit == "rows:insiders":
        kind = (r.get("type") or "").lower()
        return {"date": _short_date(r.get("date")), "text": " · ".join(p for p in (r.get("director"), kind) if p),
                "value": money(r["value"]) if r.get("value") is not None else None,
                "tone": "pos" if kind == "buy" else "neg" if kind == "sell" else "neutral"}
    if unit == "rows:dividends":
        cents = _eps(Value(r["amount"], "eps", None, "ok", v.source, v.currency), "display")
        return {"date": _short_date(r.get("ex_date")), "text": r.get("type") or "dividend",
                "value": cents, "tag": f"{r['franking']:.0f}% franked" if (r.get("franking") or 0) > 0 else None}  # 0 may mean unknown
    if unit == "rows:strategy":
        return {"text": r["name"], "value": f"score {r['score']:.0f}", "tag": r.get("status"), "tone": "neutral"}
    if unit == "rows:signals":
        return {"date": _short_date(r.get("date")), "text": r["headline"], "tag": r.get("kind"),
                "tone": "neg" if r.get("polarity") == "adverse" else "pos"}
    if unit == "rows:peers":
        return {"text": f"{r['code']} {r['name']}", "value": f"{r['short_pct']:.2f}%"}
    raise FormatError(f"no row layout for {unit}")


def _rows(limit: int | None) -> Callable[[Value, str], list]:
    def fmt(v: Value, mode: str) -> list:
        rows = [_row(v.unit, r, v) for r in v.value]
        rows = [{k: x for k, x in row.items() if x is not None} for row in rows]
        return rows[:limit] if limit else rows
    return fmt


def _bars_history(v: Value, mode: str) -> list:
    rows = [r for r in v.value if r.get("revenue") is not None][-4:]
    return [{"label": month_label(r["end"]), "value": float(r["revenue"]),
             "display": _money(Value(r["revenue"], "money", None, "ok", v.source, v.currency), "display"),
             "highlight": i == len(rows) - 1} for i, r in enumerate(rows)]


def _bars_peers(v: Value, mode: str) -> list:
    rows = sorted(v.value, key=lambda r: -float(r["short_pct"]))
    top = rows[:6]
    subject = next((r for r in rows if r.get("subject")), None)
    if subject is not None and subject not in top:
        top[-1] = subject
    return [{"label": r["code"], "value": float(r["short_pct"]), "display": f"{float(r['short_pct']):.2f}%",
             "highlight": bool(r.get("subject"))} for r in top]


_FORMATS: dict[str, Callable[[Value, str], Any]] = {
    "money": _money, "money_abs": lambda v, m: _money(v, m, signed=False), "eps": _eps,
    "pct": _pct(2), "pct1": _pct(1), "change_pct": _change_pct, "pp": _pp, "count": _count,
    "int": _int, "rank": _rank, "date": _date, "month": _month, "period": _period, "ratio": _ratio,
    "days": _days, "text": _text, "as_at": _as_at, "source": _source, "series": _series,
    "rows": _rows(None), "rows3": _rows(3), "rows5": _rows(5),
    "bars_history": _bars_history, "bars_peers": _bars_peers,
}


def _check_unit(v: Value, fmt: str) -> None:
    if fmt in _ANY_UNIT:
        return
    if fmt == "series":
        ok = v.unit.startswith("series:")
    elif fmt in ("rows", "rows3", "rows5"):
        ok = v.unit.startswith("rows:")
    else:
        ok = v.unit in _UNITS[fmt]
    if not ok:
        raise FormatError(f"format {fmt!r} does not apply to unit {v.unit!r}")


def render(v: Value, fmt: str, mode: str) -> Any:
    if mode not in ("display", "spoken"):
        raise ValueError(f"mode must be 'display' or 'spoken', not {mode!r}")
    if fmt not in _FORMATS:
        raise FormatError(f"unknown format {fmt!r}")
    _check_unit(v, fmt)
    structured = fmt in STRUCTURED_FORMATS
    if structured and mode == "spoken":
        raise FormatError(f"{fmt!r} is a structured format and cannot be spoken")
    if v.trust == "untrusted":
        raise FormatError(f"untrusted value ({v.note or 'no reason recorded'})")
    if v.trust in ("missing", "withheld") and fmt not in ("as_at", "source"):
        if structured:
            raise FormatError(f"{v.trust}: no data to show ({v.note or ''})")
        if mode == "spoken":
            raise Unspeakable(f"{v.trust} value cannot be narrated ({v.note or ''})")
        return "n/a" if v.trust == "missing" else "n/m"
    if isinstance(v.value, float) and not math.isfinite(v.value) and fmt not in ("as_at", "source"):
        raise FormatError(f"non-finite value {v.value!r}")
    if v.value in (None, [], {}) and fmt not in ("as_at", "source", "rank"):
        raise FormatError(f"{v.trust} value is empty; it should have been marked missing")
    return _FORMATS[fmt](v, mode)


def axis_label(x: float, unit: str, currency: str | None) -> str:
    """Chart axis labels; numbers still only become text here."""
    if unit == "pct":
        dp = next(d for d in (1, 2, 3, 4) if d == 4 or abs(round(x, d) - x) < 1e-9)
        body = f"{abs(x):.{dp}f}"
        return f"{MINUS if _neg(x, body) else ''}{body}%"
    if unit == "money":
        return _money(Value(x, "money", None, "ok", Source("axis", {}, ""), currency), "display")
    raise FormatError(f"no axis labels for unit {unit!r}")


def month_label(iso: str) -> str:
    d = _iso(iso)
    return f"{MONTHS[d.month - 1][:3]} {d.year}"
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_formatters.py -q`
Expected: PASS (22 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/values.py tools/shorted/formatters.py tests/shorted/test_formatters.py
git commit -m "feat(shorted): dossier values and display/spoken formatters"
```

### Task 4: API client and call list

**Files:**
- Create: `tools/shorted/api.py`, `tools/shorted/calls.py`
- Test: `tests/shorted/test_api.py`

**Interfaces:**
- Consumes: `Source` (Task 3).
- Produces:
  - `ShortedAPI(base_url=None, secret=None, transport=None, sleep=time.sleep, max_retries=4, clock=None).call(label, service, body) -> (dict, Source)`. Here `label` is the method name with an optional `#suffix`, used only to tell fixtures apart.
  - `ShortedAPIError(status, method, body)`, with `.status`; `BYPASS_HEADER = "X-Shorted-Testing-Bypass"`.
  - `normalise_ticker(raw) -> str` and `calls_for(ticker) -> list[(label, service, body)]`.
  - `similar_codes(graph, ticker, limit=6) -> list[str]` and `similar_peers_call(codes) -> (label, service, body)`. This is the one dependent call: once `GetStockGraph` names similar companies, `GetTopShorts` filtered to their codes returns their short positions.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_api.py`:

```python
import json

import pytest

from tools.shorted.api import BYPASS_HEADER, ShortedAPI, ShortedAPIError
from tools.shorted.calls import calls_for, normalise_ticker, similar_codes, similar_peers_call


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, headers, data):
        self.calls.append((url, headers, json.loads(data)))
        return self.responses.pop(0)


def test_call_builds_connect_request():
    t = FakeTransport([(200, {}, b'{"name": "DroneShield"}')])
    api = ShortedAPI(base_url="https://api.example", secret="s3cret", transport=t)
    body, src = api.call("GetStock", "StockService", {"productCode": "DRO"})
    url, headers, sent = t.calls[0]
    assert url == "https://api.example/shorts.v1alpha1.StockService/GetStock"
    assert headers["User-Agent"] == "Shorted-E2E/1.0"
    assert headers[BYPASS_HEADER] == "s3cret"
    assert headers["Connect-Protocol-Version"] == "1"
    assert sent == {"productCode": "DRO"} and body == {"name": "DroneShield"}
    assert src.endpoint == "GetStock" and src.request == {"productCode": "DRO"}


def test_label_suffix_is_not_sent_and_empty_secret_omits_header():
    t = FakeTransport([(200, {}, b"{}")])
    ShortedAPI(base_url="https://x", secret="", transport=t).call("GetStockData#MAX", "StockService", {"period": "MAX"})
    assert t.calls[0][0].endswith("/shorts.v1alpha1.StockService/GetStockData")
    assert BYPASS_HEADER not in t.calls[0][1]


def test_retries_429_honouring_retry_after():
    slept = []
    t = FakeTransport([(429, {"Retry-After": "3"}, b""), (200, {}, b"{}")])
    ShortedAPI(base_url="https://x", secret="", transport=t, sleep=slept.append).call("GetStock", "StockService", {})
    assert slept == [3.0] and len(t.calls) == 2


def test_network_errors_are_retried():
    slept = []
    t = FakeTransport([(599, {}, b"timed out"), (200, {}, b"{}")])
    ShortedAPI(base_url="https://x", secret="", transport=t, sleep=slept.append).call("GetStock", "StockService", {})
    assert slept == [1.0] and len(t.calls) == 2


def test_client_error_raises_with_status():
    t = FakeTransport([(404, {}, b'{"code":"not_found"}')])
    with pytest.raises(ShortedAPIError) as err:
        ShortedAPI(base_url="https://x", secret="", transport=t).call("GetStock", "StockService", {})
    assert err.value.status == 404


def test_normalise_ticker():
    assert normalise_ticker(" dro ") == "DRO"
    assert normalise_ticker("DRO.AX") == "DRO"
    with pytest.raises(ValueError):
        normalise_ticker("DR O")


def test_calls_cover_every_area_and_use_daily_series():
    calls = {label: body for label, _, body in calls_for("DRO")}
    assert {"GetStock", "GetStockDetails", "GetStockData", "GetStockPrices", "GetStockFundamentals",
            "GetStockFinancialHighlights", "GetDividendHistory", "GetDirectorTrades", "GetPeerComparison",
            "GetEventTimeline", "GetStockSignals", "GetStockStrategyFit", "GetStockNews",
            "GetTopShorts"} <= set(calls)
    assert calls["GetStockData"] == {"productCode": "DRO", "period": "1Y", "fullResolution": True}


def test_similar_peers_call_filters_top_shorts_to_the_graph():
    graph = {"similarCompanies": [{"stockCode": "MOB", "similarity": 0.7}, {"stockCode": "EOS", "similarity": 0.9},
                                  {"stockCode": "DRO", "similarity": 1.0}]}
    codes = similar_codes(graph, "DRO")
    assert codes == ["EOS", "MOB"]
    label, service, body = similar_peers_call(codes)
    assert (label, service, body["productCodes"], body["limit"]) == ("GetTopShorts#peers", "MarketService", ["EOS", "MOB"], 2)
    assert body["summaryOnly"] is False  # the summary path ignores product_codes
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.api'`.

- [ ] **Step 3: Implement `api.py`**

```python
"""Shorted public API client: Connect-RPC over JSON, with the E2E bypass headers and backoff."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Optional

from tools.shorted.values import Source

BASE_URL = "https://api.shorted.com.au"
PACKAGE = "shorts.v1alpha1"
USER_AGENT = "Shorted-E2E/1.0"
BYPASS_HEADER = "X-Shorted-Testing-Bypass"
NETWORK_ERROR = 599  # a timeout or a dropped connection, reported as a status so it can be retried
RETRY_STATUS = {429, 502, 503, 504, NETWORK_ERROR}
Transport = Callable[[str, dict, bytes], tuple[int, dict, bytes]]


class ShortedAPIError(RuntimeError):
    def __init__(self, status: int, method: str, body: str):
        super().__init__(f"{method}: HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


def _urllib_transport(url: str, headers: dict, data: bytes) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers or {}), err.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        return NETWORK_ERROR, {}, str(err).encode()


class ShortedAPI:
    def __init__(self, base_url: Optional[str] = None, secret: Optional[str] = None,
                 transport: Optional[Transport] = None, sleep: Callable[[float], None] = time.sleep,
                 max_retries: int = 4, clock: Optional[Callable[[], datetime]] = None):
        self.base_url = (base_url or os.environ.get("SHORTED_API_URL") or BASE_URL).rstrip("/")
        self.secret = os.environ.get("SHORTED_API_BYPASS_SECRET", "") if secret is None else secret
        self.transport = transport or _urllib_transport
        self.sleep = sleep
        self.max_retries = max_retries
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def headers(self) -> dict:
        h = {"Content-Type": "application/json", "Connect-Protocol-Version": "1", "User-Agent": USER_AGENT}
        if self.secret:
            h[BYPASS_HEADER] = self.secret
        return h

    def call(self, label: str, service: str, body: dict) -> tuple[dict, Source]:
        method = label.split("#", 1)[0]
        url = f"{self.base_url}/{PACKAGE}.{service}/{method}"
        data = json.dumps(body).encode()
        status, raw = 0, b""
        for attempt in range(self.max_retries + 1):
            status, headers, raw = self.transport(url, self.headers(), data)
            if status == 200:
                return json.loads(raw or b"{}"), Source(label, body, self.clock().isoformat(timespec="seconds"))
            if status in RETRY_STATUS and attempt < self.max_retries:
                retry_after = headers.get("Retry-After") or headers.get("retry-after")
                self.sleep(float(retry_after) if retry_after else float(2 ** attempt))
                continue
            break
        raise ShortedAPIError(status, label, raw.decode(errors="replace"))
```

- [ ] **Step 4: Implement `calls.py`**

```python
"""Ticker normalisation and the endpoint calls one dossier makes (all VISIBILITY_PUBLIC)."""

from __future__ import annotations

import re

_TICKER = re.compile(r"^[A-Z0-9]{2,6}$")


def normalise_ticker(raw: str) -> str:
    t = raw.strip().upper()
    if t.endswith(".AX"):
        t = t[:-3]
    if not _TICKER.match(t):
        raise ValueError(f"not an ASX code: {raw!r} (expected 2-6 letters or digits, e.g. DRO)")
    return t


def calls_for(t: str) -> list[tuple[str, str, dict]]:
    """(label, service, body). A '#suffix' on the label distinguishes two calls to one method."""
    return [
        ("GetStock", "StockService", {"productCode": t}),
        ("GetStockDetails", "StockService", {"productCode": t}),
        ("GetStockData", "StockService", {"productCode": t, "period": "1Y", "fullResolution": True}),
        ("GetStockData#MAX", "StockService", {"productCode": t, "period": "MAX"}),
        ("GetStockPrices", "StockService", {"productCode": t, "period": "1Y"}),
        ("GetStockFundamentals", "StockService", {"stockCode": t, "limit": 12}),
        ("GetStockFinancialHighlights", "StockService", {"stockCodes": [t], "maxReportsPerStock": 3}),
        ("GetDividendHistory", "StockService", {"stockCode": t, "years": 5}),
        ("GetDirectorTrades", "StockService", {"stockCode": t, "limit": 20}),
        ("GetPeerComparison", "StockService", {"stockCode": t, "limit": 8}),
        ("GetEventTimeline", "StockService", {"stockCode": t, "daysBack": 365, "limit": 30}),
        ("GetStockSignals", "StockService", {"stockCode": t, "limit": 10}),
        ("GetStockStrategyFit", "StrategyService", {"stockCode": t}),
        ("GetStockNews", "NewsService", {"stockCode": t, "limit": 12}),
        ("GetTopShorts", "MarketService", {"period": "3M", "limit": 100, "offset": 0, "summaryOnly": True}),
        ("GetStockVerdict", "StockService", {"productCode": t}),
        ("GetCompanyTaxProfile", "StockService", {"productCode": t}),
        ("GetStockGraph", "StockService", {"stockCode": t, "limit": 10}),
        ("GetBattlegroundStocks", "MarketService", {"view": "BATTLEGROUND_VIEW_SQUEEZE", "limit": 50}),
        ("GetShortCampaignScoreboard", "MarketService", {"limit": 50}),
        ("GetIndexSeries", "MarketService", {"indexCode": "XJO", "period": "1Y"}),
        ("GetRelatedNews", "NewsService", {"stockCode": t, "limit": 12}),
    ]


PEER_LIMIT = 6


def similar_codes(graph: dict, ticker: str, limit: int = PEER_LIMIT) -> list[str]:
    """The most similar companies in a GetStockGraph response, best first, without the subject."""
    peers = sorted(graph.get("similarCompanies", []), key=lambda p: -float(p.get("similarity", 0.0)))
    return [p["stockCode"] for p in peers if p.get("stockCode") and p["stockCode"] != ticker][:limit]


def similar_peers_call(codes: list[str]) -> tuple[str, str, dict]:
    """Short positions for the similar companies: one GetTopShorts call scoped to their codes.

    Not summaryOnly: Shorted's summary path reads mv_top_shorts and ignores product_codes, returning the
    top-N list instead (see the data-collection notes, finding 12). The full path honours the codes."""
    return ("GetTopShorts#peers", "MarketService",
            {"period": "1M", "limit": len(codes), "offset": 0, "summaryOnly": False, "productCodes": codes})
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_api.py -q`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/api.py tools/shorted/calls.py tests/shorted/test_api.py
git commit -m "feat(shorted): Connect-RPC client with bypass headers, backoff and call list"
```

### Task 5: Recorded API fixtures

**Files:**
- Create: `scripts/shorted/record_fixtures.py`, `tests/shorted/fixtures/<TICKER>/*.json`, `tests/shorted/fixtures/aliases.json`
- Modify: `tests/shorted/conftest.py` (append fixture helpers)
- Test: `tests/shorted/test_fixtures.py`

**Interfaces:**
- Consumes: `ShortedAPI`, `calls_for`, `normalise_ticker` (Task 4).
- Produces:
  - Fixture files `<label with # replaced by __>.json`, each `{status, request, response|error, fetched_at}`; the dependent peers call is `GetTopShorts__peers.json`.
  - `fixture_api(ticker) -> ShortedAPI`, whose transport replays the fixtures.
  - `aliases.json` `{"no_filing": "<CODE>", "with_filing": "<CODE>"}`: real stocks without and with a parsed latest filing.

- [ ] **Step 1: Write the recorder**

`scripts/shorted/record_fixtures.py`:

```python
"""Record live Shorted API responses as test fixtures. Needs the network, so run it OUTSIDE pytest:

    .venv/bin/python scripts/shorted/record_fixtures.py DRO BHP CBA --find-no-filing --find-with-filing
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.shorted.api import ShortedAPI  # noqa: E402
from tools.shorted.calls import calls_for, normalise_ticker, similar_codes, similar_peers_call  # noqa: E402

OUT = ROOT / "tests/shorted/fixtures"


def record_call(api: ShortedAPI, d: Path, label: str, service: str, body: dict) -> dict:
    try:
        resp, src = api.call(label, service, body)
        rec = {"status": 200, "request": body, "response": resp, "fetched_at": src.fetched_at}
    except Exception as err:  # recorded as-is: the dossier must cope with failed calls
        rec = {"status": getattr(err, "status", 0), "request": body, "error": getattr(err, "body", str(err))[:300],
               "fetched_at": None}
    (d / f"{label.replace('#', '__')}.json").write_text(json.dumps(rec, indent=1))
    return rec


def record(api: ShortedAPI, ticker: str) -> None:
    t = normalise_ticker(ticker)
    d = OUT / t
    d.mkdir(parents=True, exist_ok=True)
    for label, service, body in calls_for(t):
        record_call(api, d, label, service, body)
    codes = similar_codes(json.loads((d / "GetStockGraph.json").read_text()).get("response") or {}, t)
    if codes:
        record_call(api, d, *similar_peers_call(codes))
    fund = json.loads((d / "GetStockFundamentals.json").read_text()).get("response", {})
    print(t, "hasLatestFiling =", fund.get("hasLatestFiling", False), "periods =", len(fund.get("periods", [])))


def find_by_filing(api: ShortedAPI, has_filing: bool, limit: int = 60) -> str:
    """The most-shorted stock whose fundamentals do (or do not) carry a parsed latest filing."""
    resp, _ = api.call("GetTopShorts", "MarketService", {"period": "3M", "limit": limit, "offset": 0, "summaryOnly": True})
    for row in resp.get("timeSeries", []):
        code = row.get("productCode")
        fund, _ = api.call("GetStockFundamentals", "StockService", {"stockCode": code, "limit": 4})
        if bool(fund.get("hasLatestFiling")) == has_filing:
            return code
    raise SystemExit(f"no top-{limit} short with has_latest_filing={has_filing}; pick one by hand")


def main(argv: list[str]) -> None:
    api = ShortedAPI()
    tickers = [a for a in argv if not a.startswith("--")]
    for t in tickers:
        record(api, t)
    path = OUT / "aliases.json"
    aliases = json.loads(path.read_text()) if path.exists() else {}
    for flag, name, has_filing in (("--find-no-filing", "no_filing", False), ("--find-with-filing", "with_filing", True)):
        if flag in argv:
            code = find_by_filing(api, has_filing)
            record(api, code)
            aliases[name] = code
            print(name, "->", code)
    OUT.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(aliases, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
```

- [ ] **Step 2: Record (live, outside pytest)**

Run: `.venv/bin/python scripts/shorted/record_fixtures.py DRO BHP CBA --find-no-filing --find-with-filing`
Expected:
- one line per ticker, with DRO, BHP and CBA reporting `hasLatestFiling = True` or `False`;
- then `no_filing -> <CODE>` and `with_filing -> <CODE>`: the most-shorted stocks without and with a parsed filing (DRO, BHP and CBA had none on 8 Oct 2026);
- 22 files per ticker under `tests/shorted/fixtures/`, plus `GetTopShorts__peers.json` when the similarity graph names peers.

If a call fails with 401 or 403, check that `SHORTED_API_BYPASS_SECRET` is set in `.env`.

- [ ] **Step 3: Write the failing test**

Add `import json` to the imports at the top of `tests/shorted/conftest.py` (`Path` is already imported), then append:

```python
FIXTURES = Path(__file__).parent / "fixtures"


def fixture_transport(ticker: str):
    d = FIXTURES / ticker

    def transport(url, headers, data):
        method = url.rsplit("/", 1)[1]
        body = json.loads(data)
        if method == "GetStockData" and body.get("period") == "MAX":
            label = "GetStockData__MAX"
        elif method == "GetTopShorts" and body.get("productCodes"):
            label = "GetTopShorts__peers"
        else:
            label = method
        rec = json.loads((d / f"{label}.json").read_text())
        if rec.get("status") != 200:
            return rec.get("status") or 500, {}, (rec.get("error") or "").encode()
        return 200, {}, json.dumps(rec["response"]).encode()

    return transport


def fixture_api(ticker: str):
    from datetime import datetime, timezone

    from tools.shorted.api import ShortedAPI

    if not (FIXTURES / ticker).exists():
        pytest.skip(f"no recorded fixtures for {ticker}; run scripts/shorted/record_fixtures.py")
    return ShortedAPI(base_url="https://fixtures.invalid", secret="", transport=fixture_transport(ticker),
                      clock=lambda: datetime(2026, 10, 7, tzinfo=timezone.utc))


def alias(name: str) -> str:
    path = FIXTURES / "aliases.json"
    value = json.loads(path.read_text()).get(name) if path.exists() else None
    if not value:
        pytest.skip(f"no {name!r} fixture alias recorded")
    return value
```

`tests/shorted/test_fixtures.py`:

```python
import json

from tests.shorted.conftest import FIXTURES, fixture_api
from tools.shorted.calls import calls_for, similar_codes


def test_every_call_has_a_fixture_for_dro():
    for label, _, _ in calls_for("DRO"):
        assert (FIXTURES / "DRO" / f"{label.replace('#', '__')}.json").exists(), label


def test_similar_peers_are_recorded_when_the_graph_names_them():
    graph = json.loads((FIXTURES / "DRO" / "GetStockGraph.json").read_text()).get("response") or {}
    if similar_codes(graph, "DRO"):
        assert (FIXTURES / "DRO" / "GetTopShorts__peers.json").exists()


def test_fixture_api_replays_responses():
    api = fixture_api("DRO")
    body, src = api.call("GetStock", "StockService", {"productCode": "DRO"})
    assert body.get("productCode") == "DRO"
    assert src.fetched_at.startswith("2026-10-07")
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_fixtures.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/shorted/record_fixtures.py tests/shorted/fixtures tests/shorted/conftest.py tests/shorted/test_fixtures.py
git commit -m "test(shorted): recorded API fixtures (DRO, BHP, CBA, no-filing) and replay transport"
```

### Task 6: Dossier

**Files:**
- Create: `tools/shorted/dossier.py`
- Test: `tests/shorted/test_dossier.py`

**Interfaces:**
- Consumes: `ShortedAPI`, `calls_for`, `normalise_ticker`, `Value`, `Source`, `missing`.
- Produces:
  - `build_dossier(raw_ticker: str, api: ShortedAPI, today: date) -> dict`. Sections: `company, short, price, results, dividends, news, events, insiders, peers, strategy, signals`, plus `ticker, built_at, calls, raw, coverage`.
  - `coverage(d) -> {chapter: {ok, missing, stale}}` and `CHAPTERS`.
  - Tool `ShortedDossier` (name `shorted_dossier`): inputs `{ticker, project_dir}`; writes `artifacts/dossier.json` and `artifacts/coverage.json`.
  - Field names are the ones listed in the storyboard-director skill (Task 2).
  - Data-quality rules (each pinned by a test):
    - `company.name` keeps the company's own casing (`display_name`);
    - `company.headquarters` is "City, STATE" (`hq_city`) and `company.address` the stored address;
    - third-party headlines that bait advice, rate or value the stock, call its price, are a routine ASX notice (Appendix 3B/3D–3H/3X–3Z, quotation, substantial holder…; never a 4C/4D/4E/5B/3A.1/3C results, quarterly, dividend or buy-back announcement), are a roundup of several companies with this one among them, or only mention the company in passing are left out of `news.items` and `events.items`, and the value's note says how many; the company's own announcements are never treated as advice or a roundup, and a results headline is never a "vs" or list roundup; an announcement's title is its headline (`detail`), a publisher suffix is stripped only from Google News items, a headline repeated within 7 days under the other type (an announcement and its news echo) is shown once, an announcement without a headline is not shown, director trades stay out of events, and dates are Sydney dates (a timeline news row takes the news feed's date);
    - `peers.items` comes from the similarity graph when at least 3 similar companies have short data, else from the industry, and `peers.basis` says which;
    - `dividends.history` is `untrusted` when the company reports in a currency other than AUD, because the dividend data carries no currency;
    - a director trade's undisclosed shares, price or value is `None` (proto3 omits zero), and `insiders.net_value_90d` is missing unless every recent buy and sell discloses its value, and missing when every dealing the API returned (its page limit) falls inside the 90 days; "Unknown Director" is `None`; a dealing listed twice (the same person, type and shares on one day at a price within 1%, or an echo that discloses nothing — no shares, no value — and shares the disclosed dealing's ASX announcement, or failing that is by the same person, of any type, up to 7 days after it) is shown once; a dealing with no director named and no amounts is counted in the note, not shown; dividend rows without an amount are dropped, and there is no `dividends.trailing_yield` (the API's figure sums five years of amounts with no price);
    - margins, FCF conversion, ROE and net debt come from the quality block only when its basis (type and end) is the result period; otherwise they are recomputed from the period's own lines, or `untrusted` with the other basis in the note; net debt needs only the result's balance date, and is dated with it; `company.market_cap` is as at the latest price; banks and insurers have `fcf`, `cash` and `total_debt` withheld, and `is_financial` is missing without a quality block;
    - `results.guidance` is a verbatim quote whose label names a period after the result (FY26, 1H26, 2026; an undated quote is refused), from the filing's own report when there is one, never a blank or "null" quote, from a report at most 400 days old;
    - `price.change_1y_pct` uses the raw closes the chart draws and needs at least 330 days of them; `short.shares_on_issue` and `days_to_cover` are as at the latest short report; a similar peer whose last report is more than 7 days older than the subject's is left out; a signal's partial date is `None`;
    - a bank or insurer (`is_financial`) carries `net_interest_income` (with prior and growth), `total_assets`, `total_equity`, `roa_pct` and `payout_ratio_pct`, and its `cash` chapter is satisfied by them (`BANK_CASH`); for anyone else net interest income is withheld (it is a net finance cost there), while assets, equity, ROA and payout are kept;
    - a section that cannot be built becomes `{}` plus a failed `section:<name>` call, never a crash; the tool reports failure when neither `GetStock` nor `GetStockData` answered.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_dossier.py`:

```python
import json
from datetime import date, datetime, timezone

import pytest

import tools.shorted.dossier as dossier_module
from tests.shorted.conftest import alias, fixture_api
from tools.shorted.api import ShortedAPI
from tools.shorted.dossier import ShortedDossier, build_dossier, display_name, hq_city
from tools.shorted.formatters import render
from tools.shorted.values import Value

TODAY = date(2026, 10, 3)
SERIES = {"points": [
    {"timestamp": "2026-06-01T00:00:00Z", "shortPosition": 10.0, "reportedShortPositions": 100.0},
    {"timestamp": "2026-08-31T00:00:00Z", "shortPosition": 12.0, "reportedShortPositions": 120.0},
    {"timestamp": "2026-09-30T00:00:00Z", "shortPosition": 15.07, "reportedShortPositions": 139403700.0},
], "downsampled": False}


def api_for(responses: dict) -> ShortedAPI:
    def transport(url, headers, data):
        method = url.rsplit("/", 1)[1]
        body = json.loads(data)
        if method == "GetStockData" and body.get("period") == "MAX":
            key = "GetStockData#MAX"
        elif method == "GetTopShorts" and body.get("productCodes"):
            key = "GetTopShorts#peers"
        else:
            key = method
        if key not in responses:
            return 404, {}, b'{"code":"not_found"}'
        return 200, {}, json.dumps(responses[key]).encode()
    return ShortedAPI(base_url="https://x", secret="", transport=transport,
                      clock=lambda: datetime(2026, 10, 3, tzinfo=timezone.utc))


def test_short_point_values_come_from_daily_series():
    d = build_dossier("dro", api_for({"GetStockData": SERIES}), TODAY)
    assert d["ticker"] == "DRO"
    pct = d["short"]["pct"]
    assert (pct["value"], pct["as_at"], pct["trust"]) == (15.07, "2026-09-30", "ok")
    assert d["short"]["change_30d_pp"]["value"] == 3.07
    assert d["short"]["peak_1y"]["value"] == 15.07


def test_downsampled_series_is_untrusted():
    d = build_dossier("DRO", api_for({"GetStockData": {**SERIES, "downsampled": True}}), TODAY)
    assert d["short"]["pct"]["trust"] == "untrusted"


def test_rank_outside_top():
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetTopShorts": {"timeSeries": [
        {"productCode": "AAA"}, {"productCode": "BBB"}]}}), TODAY)
    rank = d["short"]["rank"]
    assert rank["value"] is None and rank["note"] == "outside the top 2" and rank["trust"] == "ok"


def test_reporting_currency_usd():
    fund = {"periods": [{"periodType": "annual", "periodEnd": "2026-06-30", "currency": "USD",
                         "hasRevenue": True, "revenue": 5.0e10}]}
    d = build_dossier("BHP", api_for({"GetStockFundamentals": fund}), TODAY)
    assert d["results"]["revenue"]["currency"] == "USD"


def test_growth_never_from_nonpositive_prior():
    fund = {"periods": [
        {"periodType": "annual", "periodEnd": "2026-06-30", "currency": "AUD", "hasRevenue": True, "revenue": 10.0},
        {"periodType": "annual", "periodEnd": "2025-06-30", "currency": "AUD", "hasRevenue": True},
    ]}
    d = build_dossier("DRO", api_for({"GetStockFundamentals": fund}), TODAY)
    assert d["results"]["revenue_prior"]["value"] == 0.0
    assert d["results"]["revenue_yoy_pct"]["trust"] == "missing"


def test_not_meaningful_is_withheld():
    fund = {"periods": [{"periodType": "annual", "periodEnd": "2026-06-30", "currency": "AUD",
                         "hasFreeCashFlow": True, "freeCashFlow": 5.0e9, "hasCashAndEquivalents": True,
                         "cashAndEquivalents": 9.0e10}],
            "hasQuality": True, "quality": {"isFinancial": True, "notMeaningful": ["fcf_conversion", "net_debt"],
                                             "hasFcfConversion": True, "fcfConversion": 0.9,
                                             "hasNetMarginPct": True, "netMarginPct": 30.0,
                                             "basisPeriodType": "annual", "basisPeriodEnd": "2026-06-30"}}
    d = build_dossier("CBA", api_for({"GetStockFundamentals": fund}), TODAY)
    assert d["results"]["fcf_conversion"]["trust"] == "withheld"
    assert d["results"]["net_debt"]["trust"] == "withheld"
    assert d["results"]["net_margin_pct"]["value"] == 30.0
    assert d["results"]["fcf"]["trust"] == "withheld" and d["results"]["cash"]["trust"] == "withheld"


def test_prior_period_is_never_stale():
    fund = {"periods": [
        {"periodType": "annual", "periodEnd": "2025-12-31", "currency": "AUD", "hasRevenue": True, "revenue": 216.5e6},
        {"periodType": "annual", "periodEnd": "2024-12-31", "currency": "AUD", "hasRevenue": True, "revenue": 57.9e6},
    ]}
    d = build_dossier("DRO", api_for({"GetStockFundamentals": fund}), TODAY)
    assert d["results"]["revenue"]["trust"] == "ok"
    assert d["results"]["revenue_prior"]["trust"] == "ok"  # a year older by design


def test_no_fundamentals_drops_the_result_chapter():
    d = build_dossier("DRO", api_for({"GetStockDetails": {"companyName": "DroneShield", "summary": "Counter-drone."}}), TODAY)
    assert d["coverage"]["result"]["ok"] is False
    assert d["coverage"]["company"]["ok"] is True


def test_failed_call_is_recorded():
    d = build_dossier("DRO", api_for({}), TODAY)
    news = next(c for c in d["calls"] if c["label"] == "GetStockNews")
    assert news["ok"] is False and news["status"] == 404
    assert d["news"]["items"]["trust"] == "missing"


def test_display_name_and_headquarters():
    assert display_name("Droneshield", "DroneShield (ASX:DRO) is a counter-drone company.") == "DroneShield"
    assert display_name("BHP Group", "BHP GROUP LIMITED mines iron ore.") == "BHP Group"
    assert display_name("Example", None) == "Example"
    assert display_name("Commonwealth Bank Of Australia.", "Commonwealth Bank of Australia (CBA) is a bank.") \
        == "Commonwealth Bank of Australia"
    assert display_name("Example Ltd.", None) == "Example Ltd"
    assert display_name("Droneshield", "droneshield builds it. DroneShield (ASX:DRO) sells it.") == "DroneShield"
    assert display_name("Ion", "Ionic Rare Earths is another company.") == "Ion"
    assert hq_city("Level 5, 126 Phillip Street, SYDNEY, NSW, AUSTRALIA, 2000") == "Sydney, NSW"
    assert hq_city("171 Collins Street Melbourne VIC 3000") == "Melbourne, VIC"
    assert hq_city("1 Pacific Highway, St Leonards NSW 2065") == "St Leonards, NSW"
    assert hq_city("PO Box 1") is None


def test_news_leaves_out_advice_bait_opinion_and_passing_mentions():
    news = {"articles": [
        {"headline": "Should I invest $1,000 into Example shares?", "publishedAt": "2026-10-05T01:00:00Z", "relevanceScore": 0.9},
        {"headline": "Example could be 32% undervalued", "publishedAt": "2026-10-05T02:00:00Z", "relevanceScore": 0.9},
        {"headline": "Quarterly activities report", "publishedAt": "2026-10-04T00:00:00Z", "relevanceScore": 0.9, "isPriceSensitive": True},
        {"headline": "Market wrap mentions Example", "publishedAt": "2026-10-03T00:00:00Z", "relevanceScore": 0.2},
        {"headline": "Example wins contract - thebull.com.au", "publishedAt": "2026-10-02T00:00:00Z", "source": "googlenews"},
    ]}
    items = build_dossier("DRO", api_for({"GetStockNews": news}), TODAY)["news"]["items"]
    assert [r["headline"] for r in items["value"]] == ["Quarterly activities report", "Example wins contract"]
    assert items["note"].startswith("3 ")


def test_peers_prefer_similar_companies():
    graph = {"similarCompanies": [{"stockCode": c, "companyName": c.title(), "similarity": s}
                                  for c, s in (("EOS", 0.9), ("MOB", 0.8), ("AL3", 0.7), ("XYZ", 0.6))]}
    tops = {"timeSeries": [{"productCode": "EOS", "latestShortPosition": 6.1}, {"productCode": "MOB", "latestShortPosition": 0.4},
                           {"productCode": "AL3", "points": [{"timestamp": "2026-09-29T00:00:00Z", "shortPosition": 1.1},
                                                             {"timestamp": "2026-09-30T00:00:00Z", "shortPosition": 1.2}]},
                           {"productCode": "LOT", "latestShortPosition": 14.0}]}  # not asked for: ignored
    industry = {"industry": "Capital Goods", "peers": [{"stockCode": "REH", "shortPositionPercent": 2.6}]}
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetStockGraph": graph, "GetTopShorts#peers": tops,
                                      "GetPeerComparison": industry}), TODAY)
    assert [r["code"] for r in d["peers"]["items"]["value"]] == ["DRO", "EOS", "AL3", "MOB"]
    assert d["peers"]["basis"]["value"] == "similar companies" and d["peers"]["subject_rank"]["value"] == 1
    assert d["calls"][-1]["label"] == "GetTopShorts#peers"


def test_dividends_in_a_foreign_reporting_currency_are_untrusted():
    divs = {"dividends": [{"exDate": "2026-09-04", "amountPerShare": 0.6, "frankingPercentage": 100}]}
    usd = {"periods": [{"periodType": "annual", "periodEnd": "2026-06-30", "currency": "USD", "hasRevenue": True, "revenue": 5.0e10}]}
    d = build_dossier("BHP", api_for({"GetStockFundamentals": usd, "GetDividendHistory": divs}), TODAY)
    assert d["dividends"]["history"]["trust"] == "untrusted"
    aud = {"periods": [{"periodType": "annual", "periodEnd": "2026-06-30", "currency": "AUD"}]}
    d = build_dossier("CBA", api_for({"GetStockFundamentals": aud, "GetDividendHistory": divs}), TODAY)
    assert d["dividends"]["history"]["trust"] == "ok" and d["dividends"]["history"]["currency"] == "AUD"


def test_undisclosed_trade_values_are_unknown_not_zero():
    trades = {"trades": [{"tradeDate": "2026-09-20", "directorName": "A Director", "tradeType": "buy", "sharesTraded": "1000"},
                         {"tradeDate": "2026-09-10", "directorName": "B Director", "tradeType": "sell", "totalValue": 5000.0}]}
    d = build_dossier("DRO", api_for({"GetDirectorTrades": trades}), TODAY)
    first = d["insiders"]["trades"]["value"][0]
    assert first["value"] is None and first["price"] is None and first["shares"] == 1000
    assert d["insiders"]["net_value_90d"]["trust"] == "missing"


def test_peers_fall_back_to_the_industry():
    industry = {"industry": "Capital Goods", "subject": {"stockCode": "DRO", "shortPositionPercent": 14.9},
                "peers": [{"stockCode": "REH", "shortPositionPercent": 2.6}, {"stockCode": "WOR", "shortPositionPercent": 2.0}]}
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetPeerComparison": industry}), TODAY)
    assert d["peers"]["basis"]["value"] == "Capital Goods industry"
    assert [r["code"] for r in d["peers"]["items"]["value"]] == ["DRO", "REH", "WOR"]


def test_recorded_dro_bears_chapter():
    d = build_dossier("DRO", fixture_api("DRO"), date(2026, 10, 7))
    assert d["coverage"]["bears"]["ok"] is True
    assert d["short"]["pct"]["trust"] in ("ok", "stale")


def test_recorded_dro_company_and_peers():
    d = build_dossier("DRO", fixture_api("DRO"), date(2026, 10, 7))
    assert d["company"]["name"]["value"] == "DroneShield"
    assert d["company"]["headquarters"]["value"] == "Sydney, NSW"
    assert d["peers"]["basis"]["value"] == "similar companies"
    assert not any("should i" in r["headline"].lower() for r in d["news"]["items"]["value"])


def test_recorded_bhp_reports_usd():
    d = build_dossier("BHP", fixture_api("BHP"), date(2026, 10, 7))
    assert d["results"]["revenue"]["currency"] == "USD"


def test_recorded_bank_is_financial():
    d = build_dossier("CBA", fixture_api("CBA"), date(2026, 10, 7))
    assert d["results"]["is_financial"]["value"] is True
    assert not d["company"]["name"]["value"].endswith(".")


def test_recorded_no_filing():
    code = alias("no_filing")
    d = build_dossier(code, fixture_api(code), date(2026, 10, 7))
    assert d["results"]["filing"]["trust"] == "missing"


def test_recorded_with_filing():
    code = alias("with_filing")
    d = build_dossier(code, fixture_api(code), date(2026, 10, 7))
    filing = d["results"]["filing"]
    assert filing["trust"] in ("ok", "stale") and filing["value"]["title"] and filing["value"]["date"]
    assert d["coverage"]["result"]["ok"] is True


def test_ratios_only_on_the_result_period():
    period = {"periodType": "annual", "periodEnd": "2025-12-31", "currency": "AUD", "hasRevenue": True, "revenue": 200.0,
              "hasNetIncome": True, "netIncome": 10.0, "hasGrossProfit": True, "grossProfit": 120.0}
    ttm = {"basisPeriodType": "ttm", "basisPeriodEnd": "2026-06-30", "hasNetMarginPct": True, "netMarginPct": 2.0,
           "hasRoePct": True, "roePct": 4.0}
    d = build_dossier("DRO", api_for({"GetStockFundamentals": {"periods": [period], "hasQuality": True, "quality": ttm}}),
                      TODAY)
    r = d["results"]
    assert r["net_margin_pct"]["value"] == 5.0 and r["net_margin_pct"]["note"].startswith("computed from")
    assert r["gross_margin_pct"]["value"] == 60.0
    assert r["roe_pct"]["trust"] == "untrusted" and "ttm basis to 2026-06-30" in r["roe_pct"]["note"]
    same = {**ttm, "basisPeriodType": "annual", "basisPeriodEnd": "2025-12-31"}
    d = build_dossier("DRO", api_for({"GetStockFundamentals": {"periods": [period], "hasQuality": True, "quality": same}}),
                      TODAY)
    assert d["results"]["roe_pct"]["value"] == 4.0 and d["results"]["net_margin_pct"]["value"] == 2.0


def test_is_financial_is_unknown_without_quality():
    fund = {"periods": [{"periodType": "annual", "periodEnd": "2026-06-30", "currency": "AUD", "hasRevenue": True,
                         "revenue": 1.0e9}]}
    d = build_dossier("DRO", api_for({"GetStockFundamentals": fund}), TODAY)
    assert d["results"]["is_financial"]["trust"] == "missing"


def test_guidance_is_forward_looking_and_recent():
    fund = {"periods": [{"periodType": "annual", "periodEnd": "2025-12-31", "currency": "AUD", "hasRevenue": True,
                         "revenue": 1.0e9}]}

    def report(day: str, metrics: list, title: str = "Annual report") -> dict:
        return {"reportDate": day, "reportTitle": title, "confidence": 0.9, "metrics": metrics}

    def guide(text: str, period: str) -> dict:
        return {"metricType": "guidance", "sourceText": text, "attributes": {"period": period}}

    def built(reports: list) -> dict:
        hl = {"highlights": {"DRO": {"reports": reports}}}
        return build_dossier("DRO", api_for({"GetStockFundamentals": fund, "GetStockFinancialHighlights": hl}), TODAY)

    d = built([report("2026-02-20", [guide("null", "FY2026")]),
               report("2026-02-20", [guide("FY25 revenue was a record.", "FY2025"),
                                     guide("FY26 revenue guidance of A$1bn.", "FY2026")], "Investor presentation")])
    assert d["results"]["guidance"]["value"] == "FY26 revenue guidance of A$1bn."
    d = built([report("2024-08-20", [guide("FY26 revenue guidance of A$1bn.", "FY2026")])])
    assert d["results"]["guidance"]["trust"] == "missing"
    d = built([report("2026-02-20", [guide("We beat our own guidance last year.", "H1"),
                                     guide("2H25 revenue was a record.", "2H25")])])
    assert d["results"]["guidance"]["trust"] == "missing"
    d = built([report("2026-02-20", [guide("1H26 revenue is expected to grow.", "1H26")])])
    assert d["results"]["guidance"]["value"] == "1H26 revenue is expected to grow."


def test_price_change_needs_a_year_of_raw_closes():
    points = [{"date": "2026-01-02", "close": 10.0, "adjustedClose": 8.0},
              {"date": "2026-10-02", "close": 12.0, "adjustedClose": 12.0}]
    d = build_dossier("DRO", api_for({"GetStockPrices": {"points": points}}), TODAY)
    assert d["price"]["change_1y_pct"]["trust"] == "missing"
    points[0]["date"] = "2025-10-02"
    d = build_dossier("DRO", api_for({"GetStockPrices": {"points": points}}), TODAY)
    assert round(d["price"]["change_1y_pct"]["value"], 4) == 20.0  # the closes the chart draws, not adjusted


def test_trades_drop_unknown_names_and_repeated_dealings():
    trades = {"trades": [
        {"tradeDate": "2026-09-25", "directorName": "D Gill", "tradeType": "buy"},  # the notice's echo: initials, no amounts
        {"tradeDate": "2026-09-24", "directorName": "David Gill", "tradeType": "buy", "sharesTraded": "11800",
         "pricePerShare": 11.31, "totalValue": 133458.0},
        {"tradeDate": "2026-09-12", "directorName": "Oleg Vornik", "tradeType": "sell", "sharesTraded": "1000",
         "totalValue": 3341.0},
        {"tradeDate": "2026-09-12", "directorName": "Oleg Vornik", "tradeType": "sell", "sharesTraded": "1000",
         "totalValue": 3340.0},
        {"tradeDate": "2026-09-12", "directorName": "Oleg Vornik", "tradeType": "sell", "sharesTraded": "1000",
         "pricePerShare": 2.5, "totalValue": 2500.0},  # same day and shares, another price: a second sale
        {"tradeDate": "2026-09-11", "directorName": "Angus Gill", "tradeType": "buy"},  # another Gill, not an echo
        {"tradeDate": "2026-08-20", "directorName": "Kate Howitt", "tradeType": "buy"},  # echo of the 13 Aug buy
        {"tradeDate": "2026-08-13", "directorName": "Katherine Neisha Howitt", "tradeType": "buy", "sharesTraded": "61",
         "pricePerShare": 167.6, "totalValue": 10223.6},
        {"tradeDate": "2026-09-10", "directorName": "Unknown Director", "tradeType": "buy"}]}
    trades = build_dossier("DRO", api_for({"GetDirectorTrades": trades}), TODAY)["insiders"]["trades"]
    assert [(r["date"], r["director"], r["shares"]) for r in trades["value"]] == [
        ("2026-09-24", "David Gill", 11800), ("2026-09-12", "Oleg Vornik", 1000), ("2026-09-12", "Oleg Vornik", 1000),
        ("2026-09-11", "Angus Gill", None), ("2026-08-13", "Katherine Neisha Howitt", 61)]
    assert trades["note"].startswith("1 dealing with no director named")
    twice = {"trades": [{"tradeDate": "2026-09-10", "directorName": "Unknown Director", "tradeType": "buy"}] * 3}
    assert build_dossier("DRO", api_for({"GetDirectorTrades": twice}), TODAY)["insiders"]["trades"]["value"] is None


def test_events_use_announcement_headlines_and_drop_echoes():
    events = {"events": [
        {"date": "2026-10-02", "type": "announcement", "title": "other", "detail": "Contract win",
         "url": "https://www.asx.com.au/a"},
        {"date": "2026-10-01", "type": "news", "title": "Contract win", "detail": "other announcement",
         "url": "https://www.asx.com.au/a"},
        {"date": "2026-10-01", "type": "news", "title": "Example rises - The Bull", "url": "https://news.google.com/x"},
        {"date": "2026-09-30", "type": "news", "title": "Half-year results - presentation", "url": "https://www.asx.com.au/b"},
        {"date": "2026-09-29", "type": "director_trade", "title": "A Director buy", "detail": "$0.00"},
        {"date": "2026-09-28", "type": "announcement", "title": "other", "detail": "Appendix 3Y - A Director"},
        {"date": "2026-09-27", "type": "announcement", "title": "other", "detail": "Investor Presentation"},
        {"date": "2026-09-24", "type": "announcement", "title": "other", "detail": "Investor Presentation"},
        {"date": "2026-09-23", "type": "announcement", "title": "capital_change"},  # no headline: nothing to show
        {"date": "2026-09-22", "type": "news", "title": "What Sets DRO, EOS and Elsight Apart?"}]}
    items = build_dossier("DRO", api_for({"GetEventTimeline": events}), TODAY)["events"]["items"]
    assert [(r["date"], r["title"]) for r in items["value"]] == [
        ("2026-10-02", "Contract win"), ("2026-10-01", "Example rises"), ("2026-09-30", "Half-year results - presentation"),
        ("2026-09-27", "Investor Presentation"), ("2026-09-24", "Investor Presentation")]
    assert items["note"].startswith("2 ")


def test_news_dates_are_sydney_dates():
    news = {"articles": [{"headline": "Example wins contract", "publishedAt": "2026-10-05T23:41:07Z"}]}
    items = build_dossier("DRO", api_for({"GetStockNews": news}), TODAY)["news"]["items"]
    assert items["value"][0]["date"] == "2026-10-06"


def test_similar_peers_a_week_behind_are_left_out():
    graph = {"similarCompanies": [{"stockCode": c, "companyName": c, "similarity": 0.9}
                                  for c in ("EOS", "MOB", "AL3", "OLD")]}
    tops = {"timeSeries": [{"productCode": c, "points": [{"timestamp": f"2026-09-{day}T00:00:00Z", "shortPosition": 1.0}]}
                           for c, day in (("EOS", 30), ("MOB", 29), ("AL3", 28), ("OLD", 10))]}
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetStockGraph": graph, "GetTopShorts#peers": tops}), TODAY)
    assert d["peers"]["basis"]["value"] == "similar companies"
    assert "OLD" not in [r["code"] for r in d["peers"]["items"]["value"]]


def test_signals_keep_only_full_dates():
    signals = {"adverse": [{"headline": "Guidance cut", "eventDate": "2025-11"},
                           {"headline": "Capital raising", "eventDate": "2026-09-01"}]}
    adverse = build_dossier("DRO", api_for({"GetStockSignals": signals}), TODAY)["signals"]["adverse"]
    assert [r["date"] for r in adverse["value"]] == [None, "2026-09-01"] and adverse["as_at"] == "2026-09-01"


def test_a_malformed_section_is_recorded_not_raised():
    prices = {"points": [{"date": "2026-10-01", "close": "n/a"}]}
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetStockPrices": prices}), TODAY)
    assert d["price"] == {} and d["short"]["pct"]["value"] == 15.07
    assert any(c["label"] == "section:price" and not c["ok"] for c in d["calls"])
    assert d["coverage"]["bears"]["ok"] is False


def test_tool_fails_when_the_api_does_not_answer(tmp_path, monkeypatch):
    monkeypatch.setattr(dossier_module, "ShortedAPI", lambda: api_for({}))
    result = ShortedDossier().execute({"ticker": "DRO", "project_dir": str(tmp_path)})
    assert result.success is False and "did not answer" in result.error
    assert (tmp_path / "artifacts/dossier.json").exists()
    assert ShortedDossier().execute({"ticker": "not a code", "project_dir": str(tmp_path)}).success is False


@pytest.mark.parametrize("code", ["DRO", "BHP", "CBA", "TLX"])
def test_recorded_headlines_leave_out_advice_and_routine_notices(code):
    d = build_dossier(code, fixture_api(code), date(2026, 10, 7))
    texts = [r["headline"] for r in d["news"]["items"]["value"]] + [r["title"] for r in d["events"]["items"]["value"]]
    assert texts and d["news"]["items"]["note"] and d["events"]["items"]["note"]
    for bad in ("buy, hold, sell", "worth buying", "should i", "undervalued", "appendix 3y", "substantial hold",
                "application for quotation", "top buys"):
        assert not any(bad in x.lower() for x in texts), bad
    assert not any(r["type"] == "director_trade" or r["title"].lower() in ("other", "director_dealing")
                   for r in d["events"]["items"]["value"])


@pytest.mark.parametrize("code", ["DRO", "BHP", "CBA", "TLX"])
def test_recorded_trades_never_show_an_undisclosed_amount_as_zero(code):
    d = build_dossier(code, fixture_api(code), date(2026, 10, 7))
    rows = d["insiders"]["trades"]["value"]
    assert rows and not any(r["director"] == "Unknown Director" for r in rows)
    assert all(r[k] is None or r[k] > 0 for r in rows for k in ("shares", "price", "value"))
    assert not any("A$0.00" in str(x) for x in render(Value.from_json(d["insiders"]["trades"]), "rows5", "display"))
    assert "trailing_yield" not in d["dividends"]
    assert d["short"]["shares_on_issue"]["as_at"] == d["short"]["pct"]["as_at"]


def test_recorded_quality_ratios_match_the_result_period():
    dro = build_dossier("DRO", fixture_api("DRO"), date(2026, 10, 7))["results"]  # annual result, TTM quality
    assert dro["roe_pct"]["trust"] == "untrusted" and dro["net_margin_pct"]["note"].startswith("computed from")
    bhp = build_dossier("BHP", fixture_api("BHP"), date(2026, 10, 7))["results"]  # annual result, annual quality
    assert bhp["roe_pct"]["trust"] == "ok" and bhp["net_margin_pct"]["note"] is None
    cba = build_dossier("CBA", fixture_api("CBA"), date(2026, 10, 7))["results"]
    assert cba["fcf"]["trust"] == "withheld" and cba["cash"]["trust"] == "withheld"


def test_recorded_guidance_is_the_filing_outlook():
    code = alias("with_filing")
    guidance = build_dossier(code, fixture_api(code), date(2026, 10, 7))["results"]["guidance"]
    assert guidance["trust"] == "ok" and "FY 2026" in guidance["value"]


def test_a_bank_tells_its_balance_sheet():
    def period(end: str, nii: float) -> dict:
        return {"periodType": "annual", "periodEnd": end, "currency": "AUD", "hasRevenue": True, "revenue": 30.0e9,
                "hasNetIncome": True, "netIncome": 10.0e9, "hasNetInterestIncome": True, "netInterestIncome": nii,
                "hasTotalAssets": True, "totalAssets": 1.4e12, "hasTotalEquity": True, "totalEquity": 7.8e10}
    quality = {"isFinancial": True, "basisPeriodType": "annual", "basisPeriodEnd": "2026-06-30",
               "hasRoaPct": True, "roaPct": 0.77, "hasPayoutRatioPct": True, "payoutRatioPct": 76.0}
    fund = {"periods": [period("2026-06-30", 25.6e9), period("2025-06-30", 24.0e9)], "hasQuality": True, "quality": quality}
    d = build_dossier("CBA", api_for({"GetStockFundamentals": fund}), TODAY)
    r = d["results"]
    assert r["net_interest_income"]["value"] == 25.6e9 and r["net_interest_income_prior"]["value"] == 24.0e9
    assert round(r["net_interest_income_yoy_pct"]["value"], 2) == 6.67
    assert (r["roa_pct"]["value"], r["payout_ratio_pct"]["value"], r["total_equity"]["value"]) == (0.77, 76.0, 7.8e10)
    assert r["fcf"]["trust"] == "withheld" and d["coverage"]["cash"]["ok"] is True
    other = {**fund, "quality": {**quality, "isFinancial": False}}
    r = build_dossier("BHP", api_for({"GetStockFundamentals": other}), TODAY)["results"]
    assert r["net_interest_income"]["trust"] == "withheld" and r["net_interest_income_yoy_pct"]["trust"] == "missing"
    assert r["total_assets"]["value"] == 1.4e12


def test_recorded_bank_has_a_balance_sheet_chapter():
    d = build_dossier("CBA", fixture_api("CBA"), date(2026, 10, 7))
    r = d["results"]
    assert r["net_interest_income"]["value"] == 25586000000 and r["net_interest_income_prior"]["value"] == 24023000000
    assert r["roa_pct"]["trust"] == "ok" and r["total_equity"]["trust"] == "ok"
    assert d["coverage"]["cash"]["ok"] is True


@pytest.mark.parametrize("title, kept", [
    ("Appendix 4E and Annual Report", True), ("Appendix 4D - Half Year Report", True),
    ("Quarterly Activities/Appendix 4C Cash Flow Report", True), ("Appendix 5B", True),
    ("Appendix 3A.1 - Notification of dividend / distribution", True), ("Appendix 3C - Announcement of buy-back", True),
    ("Appendix 3Y - Jane McAloon", False), ("Appendix 3B - Proposed issue of securities", False),
    ("Appendix 3H - Notification of cessation", False), ("Appendix 3Z - Final Director's Interest Notice", False),
])
def test_results_announcements_are_never_routine(title, kept):
    events = {"events": [{"date": "2026-09-30", "type": "announcement", "title": "other", "detail": title}]}
    items = build_dossier("DRO", api_for({"GetEventTimeline": events}), TODAY)["events"]["items"]
    assert bool(items["value"]) is kept


def test_roundups_are_left_out_but_two_company_stories_stay():
    news = {"articles": [
        {"headline": "What Sets DRO, EOS and Elsight Apart?", "publishedAt": "2026-10-05T01:00:00Z"},
        {"headline": "DroneShield And 2 Other ASX Stocks", "publishedAt": "2026-10-04T01:00:00Z"},
        {"headline": "DroneShield vs EOS", "publishedAt": "2026-10-03T01:00:00Z"},
        {"headline": "DroneShield and EOS win army contract", "publishedAt": "2026-10-02T01:00:00Z"},
        {"headline": "Revenue, Profit And Orders Rise", "publishedAt": "2026-10-01T01:00:00Z"},
        {"headline": "DroneShield Full Year Results, Dividend And Investor Presentation",
         "publishedAt": "2026-09-30T01:00:00Z"},
        {"headline": "DroneShield, EOS And Elsight Win Orders", "publishedAt": "2026-09-29T01:00:00Z",
         "url": "https://www.asx.com.au/a"}]}
    items = build_dossier("DRO", api_for({"GetStockNews": news}), TODAY)["news"]["items"]
    assert [r["headline"] for r in items["value"]] == [
        "DroneShield and EOS win army contract", "Revenue, Profit And Orders Rise",
        "DroneShield Full Year Results, Dividend And Investor Presentation", "DroneShield, EOS And Elsight Win Orders"]


def test_events_news_rows_take_the_feeds_sydney_date():
    news = {"articles": [{"headline": "Example wins contract", "publishedAt": "2026-10-05T23:41:07Z"}]}
    events = {"events": [{"date": "2026-10-05", "type": "news", "title": "Example wins contract",
                          "url": "https://example.com/a"}]}
    d = build_dossier("DRO", api_for({"GetStockNews": news, "GetEventTimeline": events}), TODAY)
    assert d["events"]["items"]["value"][0]["date"] == d["news"]["items"]["value"][0]["date"] == "2026-10-06"


def test_net_debt_needs_only_the_balance_date():
    period = {"periodType": "half", "periodEnd": "2026-06-30", "currency": "AUD", "hasRevenue": True, "revenue": 100.0}
    quality = {"basisPeriodType": "ttm", "basisPeriodEnd": "2026-06-30", "balancePeriodEnd": "2026-06-30",
               "hasNetDebt": True, "netDebt": -50.0, "hasRoePct": True, "roePct": 9.0}
    r = build_dossier("DRO", api_for({"GetStockFundamentals": {"periods": [period], "hasQuality": True,
                                                               "quality": quality}}), TODAY)["results"]
    assert r["net_debt"]["value"] == -50.0 and r["roe_pct"]["trust"] == "untrusted"


def test_market_cap_is_dated_by_the_latest_price():
    prices = {"points": [{"date": "2026-09-30", "close": 1.0}, {"date": "2026-10-02", "close": 1.1}]}
    d = build_dossier("DRO", api_for({"GetStock": {"marketCap": 1.0e9}, "GetStockPrices": prices}), TODAY)
    assert d["company"]["market_cap"]["as_at"] == "2026-10-02"


def test_a_malformed_similarity_graph_is_recorded_not_raised():
    d = build_dossier("DRO", api_for({"GetStockData": SERIES, "GetStockGraph": {"similarCompanies": None}}), TODAY)
    assert d["short"]["pct"]["value"] == 15.07


DETAILS = {"companyName": "Droneshield", "summary": "DroneShield (ASX:DRO) builds counter-drone systems."}
RESULTS = "DroneShield Full Year Results, Dividend And Investor Presentation"
LIST3 = "DroneShield, EOS And Elsight Win Orders"


def named(responses: dict) -> ShortedAPI:  # the company's name is what lets the name-list rule fire
    return api_for({"GetStockDetails": DETAILS, **responses})


def test_a_results_headline_or_an_asx_hosted_list_is_not_a_roundup_but_a_third_party_list_is():
    news = {"articles": [
        {"headline": RESULTS, "publishedAt": "2026-09-30T01:00:00Z"},
        {"headline": LIST3, "publishedAt": "2026-09-29T01:00:00Z", "url": "https://www.asx.com.au/a"},
        {"headline": LIST3 + " Again", "publishedAt": "2026-09-28T01:00:00Z", "source": "asx"},
        {"headline": LIST3 + " Today", "publishedAt": "2026-09-27T01:00:00Z"}]}
    items = build_dossier("DRO", named({"GetStockNews": news}), TODAY)["news"]["items"]
    assert [r["headline"] for r in items["value"]] == [RESULTS, LIST3, LIST3 + " Again"]
    assert items["note"].startswith("1 ")


def test_a_company_announcement_or_an_asx_hosted_item_is_not_a_roundup():
    events = {"events": [
        {"date": "2026-09-30", "type": "announcement", "title": "other", "detail": RESULTS},
        {"date": "2026-09-29", "type": "announcement", "title": "other", "detail": LIST3},
        {"date": "2026-09-28", "type": "news", "title": LIST3 + " Again", "url": "https://www.asx.com.au/b"},
        {"date": "2026-09-27", "type": "news", "title": LIST3 + " Today", "url": "https://example.com/c"}]}
    items = build_dossier("DRO", named({"GetEventTimeline": events}), TODAY)["events"]["items"]
    assert [r["title"] for r in items["value"]] == [RESULTS, LIST3, LIST3 + " Again"]
    assert items["note"].startswith("1 ")


def test_the_trades_note_counts_dealings_not_rows():
    def note(rows: list) -> str:
        return build_dossier("DRO", api_for({"GetDirectorTrades": {"trades": rows}}), TODAY)["insiders"]["trades"]["note"]
    buy = {"directorName": "Unknown Director", "tradeType": "buy"}
    assert note([{"tradeDate": "2026-09-10", **buy}] * 3).startswith("1 dealing with no director named")
    rows = [{"tradeDate": "2026-09-10", **buy}] * 3 + [{"tradeDate": "2026-09-05", **buy}] * 2
    assert note(rows).startswith("2 dealings with no director named")


def test_own_announcements_and_results_headlines_are_never_roundups_or_advice():
    events = {"events": [
        {"date": "2026-09-30", "type": "announcement", "title": "other", "detail": "Results presentation FY25 vs FY24"},
        {"date": "2026-09-29", "type": "announcement", "title": "other", "detail": "Upgrade to Mineral Resource Estimate"},
        {"date": "2026-09-28", "type": "announcement", "title": "other", "detail": "Notification of buy-back"},
        {"date": "2026-09-27", "type": "announcement", "title": "other", "detail": "Daily share buy-back notice"},
        {"date": "2026-09-26", "type": "news", "title": "DroneShield FY25 results: revenue A$216m vs A$57m"},
        {"date": "2026-09-25", "type": "news", "title": "DroneShield Revenue Up 12% vs Consensus"},
        {"date": "2026-09-24", "type": "news", "title": "BHP Vs Codan: Two Miners"},
        {"date": "2026-09-23", "type": "news", "title": "DroneShield & 3 Other ASX Stocks"},
        {"date": "2026-09-22", "type": "news", "title": "DroneShield and Two Other Defence Stocks"},
        {"date": "2026-09-21", "type": "news", "title": "Analyst Upgrades To Outperform"}]}
    items = build_dossier("DRO", named({"GetEventTimeline": events}), TODAY)["events"]["items"]
    assert [r["title"] for r in items["value"]] == [
        "Results presentation FY25 vs FY24", "Upgrade to Mineral Resource Estimate", "Notification of buy-back",
        "DroneShield FY25 results: revenue A$216m vs A$57m", "DroneShield Revenue Up 12% vs Consensus"]
    assert items["note"].startswith("5 ")


def test_an_echo_of_any_type_is_dropped_but_a_value_without_shares_is_kept():
    trades = {"trades": [
        {"tradeDate": "2026-10-06", "directorName": "Jane McAloon", "tradeType": "buy"},  # the 3Y headline's seed
        {"tradeDate": "2026-09-29", "directorName": "Jane Frances McAloon", "tradeType": "exercise_options",
         "sharesTraded": "51", "pricePerShare": 156.45, "totalValue": 7978.95},
        {"tradeDate": "2026-09-27", "directorName": "Alistair Currie", "tradeType": "sell", "totalValue": 5000.0},
        {"tradeDate": "2026-09-25", "directorName": "Alistair Currie", "tradeType": "sell", "sharesTraded": "40",
         "pricePerShare": 125.0, "totalValue": 5000.0}]}
    rows = build_dossier("CBA", api_for({"GetDirectorTrades": trades}), TODAY)["insiders"]["trades"]["value"]
    assert [(r["date"], r["director"], r["type"]) for r in rows] == [
        ("2026-09-29", "Jane Frances McAloon", "exercise_options"), ("2026-09-27", "Alistair Currie", "sell"),
        ("2026-09-25", "Alistair Currie", "sell")]


@pytest.mark.parametrize("newest_first", [True, False])
def test_a_headline_repeated_in_the_feed_takes_its_newest_sydney_date(newest_first):
    copies = [{"headline": "Example wins contract", "publishedAt": "2026-10-05T23:00:00Z"},
              {"headline": "Example wins contract", "publishedAt": "2026-10-02T23:00:00Z"}]
    news = {"articles": copies if newest_first else copies[::-1]}
    events = {"events": [{"date": "2026-10-05", "type": "news", "title": "Example wins contract"}]}
    d = build_dossier("DRO", api_for({"GetStockNews": news, "GetEventTimeline": events}), TODAY)
    assert d["events"]["items"]["value"][0]["date"] == d["news"]["items"]["value"][0]["date"] == "2026-10-06"


def test_an_echo_is_keyed_on_its_announcement_and_a_truncated_window_is_not_summed():
    ann = "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=0313"
    trades = {"trades": [
        {"tradeDate": "2026-09-30", "directorName": "Unknown Director", "tradeType": "buy", "announcementUrl": ann + "9368"},
        {"tradeDate": "2026-09-11", "directorName": "Mark Vassella", "tradeType": "buy", "sharesTraded": "2675",
         "totalValue": 161845.72, "announcementUrl": ann + "9368"}]}
    d = build_dossier("BHP", api_for({"GetDirectorTrades": trades}), TODAY)["insiders"]
    assert [r["director"] for r in d["trades"]["value"]] == ["Mark Vassella"]  # 19 days later, but the same notice
    assert d["net_value_90d"]["value"] == 161845.72
    full = {"trades": [{"tradeDate": f"2026-09-{day:02d}", "directorName": f"Director {day}", "tradeType": "buy",
                        "sharesTraded": "100", "totalValue": 1000.0} for day in range(1, 21)]}
    net = build_dossier("BHP", api_for({"GetDirectorTrades": full}), TODAY)["insiders"]["net_value_90d"]
    assert net["trust"] == "missing" and "may hold more" in net["note"]


@pytest.mark.parametrize("headline, dropped", [
    ("DroneShield FY25 Revenue Vs FY24: Up 274%", False), ("Net Profit Vs Consensus", False),
    ("DroneShield raises A$120m and 10 million shares placed with institutions", False),
    ("DroneShield And Seven Other ASX Stocks", False), ("BHP Vs Coles: Two Retail Plays", True),
])
def test_results_comparisons_and_share_placements_are_not_roundups(headline, dropped):
    news = {"articles": [{"headline": headline, "publishedAt": "2026-10-01T01:00:00Z"}]}
    items = build_dossier("DRO", named({"GetStockNews": news}), TODAY)["news"]["items"]
    assert (items["value"] is None) is dropped
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_dossier.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.dossier'`.

- [ ] **Step 3: Implement `dossier.py`**

```python
"""The dossier: every figure a video may use, with unit, as-at date, trust and provenance.

Built from Shorted's public API (calls.py). Values the code refuses to trust are marked,
not dropped, so the storyboard gates and the reflection step can see them.
"""

from __future__ import annotations

import html
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolRuntime, ToolTier
from tools.shorted.api import ShortedAPI
from tools.shorted.calls import calls_for, normalise_ticker, similar_codes, similar_peers_call
from tools.shorted.values import Source, Value, missing

STALE_DAYS = {"short": 10, "price": 5, "results": 400}
MIN_CONFIDENCE = 0.7
MIN_RELEVANCE = 0.4      # below this an article only mentions the company in passing
MIN_SIMILAR_PEERS = 3    # fewer similar companies with short data than this: use the industry peers
STATES = {"NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"}
STREET = re.compile(r"(?<=\w )(?:street|st|road|rd|avenue|ave|terrace|tce|parade|pde|lane|ln|drive|dr|boulevard|blvd"
                    r"|highway|hwy|place|pl|way|circuit|cct|crescent|cres|close|court|ct|square|sq|esplanade|esp)\b\.?", re.I)
UNSUITABLE = re.compile(  # advice, ratings, valuation opinions and price calls, as headlines phrase them
    r"\b(should (i|you|we) (buy|sell|invest|hold)|buy,? hold,? (or )?sell|(stronger|better|best|top) buys?"
    r"|(shares?|stocks?) to (buy|sell|watch|own)|buy the dip|worth buying|i'?d (buy|invest)|forget .{1,40}? and buy"
    r"|sell alert|is it (time|too late) to (buy|sell)|(if|when) i invest|could .{0,40}?be worth"
    r"|which .{0,60}?(shares?|stocks?) (is|are) (the )?(better|best|stronger)|require action from"
    r"|could .{0,40}?\b(face|fall|rise|climb|drop|rally|soar|surge|rocket|double|rebound)"
    r"|undervalued|overvalued|valuation|expensive|cheap|bargains?|looks? (reasonable|attractive|stretched|rich)"
    r"|buying .{0,40}?shares(?=\?)|can .{0,40}?(shares?|stocks?) (recover|rebound|bounce back)|only way (is )?up"
    r"|bull case|bear case|bottomed|support (is )?forming|broker'?s view|price targets?|top picks?|buy now"
    r"|upgrades? to|downgrades? to|outperform|underperform|will (soar|surge|rally|crash|double))\b", re.I)
ROUTINE = re.compile(  # administrative ASX notices: real, but not news a viewer needs
    r"\b(appendix 3[bdefghxyz]\b|application for quotation|change of director'?s interest|cleansing notice"
    r"|notification (of|regarding) (cessation|unquoted|interest payment)|proposed issue of securities"
    r"|notice of (annual )?general meeting|(change in|becoming a|ceasing to be a) substantial hold(er|ing)"
    r"|personal trading policy|waivers? of listing rule|company secretary (appointment|resignation)"
    r"|daily share buy-back)\b", re.I)
SYDNEY = ZoneInfo("Australia/Sydney")
ECHO_DAYS = 7  # an Appendix 3Y can follow its dealing by five business days
GUIDANCE_YEAR = re.compile(r"(?:FY\s?|[12]H\s?|H[12]\s?(?:FY\s?)?)?(20\d\d)|(?:FY|[12]H|H[12])\s?(?:FY\s?)?(\d\d)\b",
                           re.I)
ROUNDUP = re.compile(r"(?:\band|&|\bthese)\s+(?:\d+|two|three|four|five|six)\s+(?:more\s+|other\s+)?"
                     r"(?:(?!(?:million|billion|thousand)\b)[a-z]+\s+){0,2}"
                     r"(?:stocks?|shares?|companies)\b", re.I)
VERSUS = re.compile(r"\b[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*\s+(?i:vs\.?|versus)\s+[A-Z]")  # "BHP vs Coles", not "vs consensus"
RESULTS_WORDS = re.compile(r"\b(results?|report|dividend|distribution|presentation|appendix|quarterly|guidance"
                           r"|half[- ]year|full[- ]year|annual|interim|earnings|revenue|profit|sales|consensus"
                           r"|FY\s?\d\d|[12]H\s?\d\d|H[12]|Q[1-4])\b", re.I)
NAME_LIST = re.compile(r"[A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*)*(?:, [A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*)*)+,? (?:and|And|&) [A-Z][\w&.'-]*")
MAX_GUIDANCE_AGE_DAYS = 400
PUBLISHER_SUFFIX = re.compile(r"\s+-\s+[^-]{2,60}$")  # Google News appends " - Publisher"
CHAPTERS: dict[str, tuple[list[str], list[str]]] = {
    "cold_open": ([], []),
    "company": (["company.name", "company.summary"], []),
    "result": (["results.period", "results.revenue", "results.net_income"], []),
    "cash": ([], ["results.fcf", "results.net_debt", "results.cash"]),
    "outlook": ([], ["results.guidance", "dividends.history"]),
    "bears": (["short.pct", "short.series_1y", "price.series_1y"], []),
    "news": ([], ["news.items", "insiders.trades"]),
    "watch": ([], ["events.items", "strategy.fits"]),
    "close": ([], []),
}
# a lender's cash flow, cash and debt mean something else: its cash chapter tells the balance sheet instead
BANK_CASH = ["results.net_interest_income", "results.roa_pct", "results.total_equity"]
RESULT_UNITS = {
    "period": "period", "revenue": "money", "revenue_prior": "money", "revenue_yoy_pct": "pct",
    "net_income": "money", "net_income_prior": "money", "eps": "eps", "eps_prior": "eps", "eps_yoy_pct": "pct",
    "gross_margin_pct": "pct", "operating_margin_pct": "pct", "net_margin_pct": "pct", "fcf": "money",
    "fcf_margin_pct": "pct", "fcf_conversion": "ratio", "cash": "money", "total_debt": "money",
    "net_debt": "money", "roe_pct": "pct", "is_financial": "bool", "filing": "filing", "guidance": "text",
    "net_interest_income": "money", "net_interest_income_prior": "money", "net_interest_income_yoy_pct": "pct",
    "total_assets": "money", "total_equity": "money", "roa_pct": "pct", "payout_ratio_pct": "pct",
    "history": "bars:history",
}


def _cc(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _d(s: Any) -> date | None:
    return date.fromisoformat(str(s)[:10]) if s else None


def _flag(obj: dict | None, value_field: str, has_field: str | None = None) -> float | None:
    """proto3 JSON omits zero values, so the has_* flag decides whether a missing number is 0 or unknown."""
    if not obj or not obj.get(_cc(has_field or f"has_{value_field}")):
        return None
    return float(obj.get(_cc(value_field), 0.0))


def _sentences(text: str | None, n: int) -> str | None:
    if not text:
        return None
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:n]).strip() or None


def display_name(name: str | None, summary: str | None) -> str | None:
    """ASIC names lose brand casing ("Droneshield") and can end in a full stop ("Commonwealth Bank Of
    Australia."); prefer the casing the company's own summary uses."""
    name = name.strip().rstrip(".").strip() if name else name
    if not name or not summary:
        return name
    for m in re.finditer(r"\b" + re.escape(name) + r"\b", summary, re.I):
        found = m.group(0)
        if found != name and found[:1].isupper() and not found.isupper():
            return found
    return name


def hq_city(address: str | None) -> str | None:
    """'Level 5, 126 Phillip Street, SYDNEY, NSW, AUSTRALIA, 2000' -> 'Sydney, NSW'. None when unclear."""
    if not address:
        return None
    parts = [p.strip(" .") for p in address.split(",")]
    for i, p in enumerate(parts):
        if p.upper() in STATES and i > 0 and not re.search(r"\d", parts[i - 1]):
            return f"{parts[i - 1].title()}, {p.upper()}"
    m = re.search(r"([A-Za-z' .-]+?)\s+(" + "|".join(STATES) + r")\s+\d{4}\b", address, re.I)
    if not m:
        return None
    city = STREET.split(m.group(1))[-1].strip(" .-")
    return f"{city.title()}, {m.group(2).upper()}" if city and len(city.split()) <= 3 else None


def _sydney_date(stamp: str) -> str:
    """ASX dates are Sydney dates; a UTC timestamp before 10:00 or 11:00 UTC is already the next day there."""
    if len(stamp) <= 10:
        return stamp
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(SYDNEY).date().isoformat()


def _drop_echoes(rows: list[dict], field: str, cross_type: bool = False) -> list[dict]:
    """Rows newest first. The same headline within ECHO_DAYS of one already kept is one item seen twice (an ASX
    announcement also arrives as a news item, dated a day apart). With cross_type, only a row of the other type is
    an echo, so two distinct announcements that share a title ("Investor Presentation") both stay."""
    kept: dict[str, tuple[str, Any]] = {}
    out = []
    for r in rows:
        k = r[field].casefold()
        if k in kept and (_d(kept[k][0]) - _d(r["date"])).days <= ECHO_DAYS and (
                not cross_type or kept[k][1] != r.get("type")):
            continue
        kept[k] = (r["date"], r.get("type"))
        out.append(r)
    return out


def _same_person(a: str | None, b: str | None) -> bool:
    """"D Gill", "David Gill" and "David John Gill" are one director, as are "Kate Howitt" and "Katherine Neisha
    Howitt"; "Angus James" and "Peter James" are two. Same surname, and first names that are equal, an initial
    of each other, or agree in their first three letters."""
    if not a or not b:
        return False
    fa, fb = a.casefold().replace(".", "").split(), b.casefold().replace(".", "").split()
    if fa[-1] != fb[-1]:
        return False
    x, y = fa[0], fb[0]
    return x == y or ((len(x) == 1 or len(y) == 1) and x[0] == y[0]) or (len(x) >= 3 and len(y) >= 3 and x[:3] == y[:3])


def _unit_price(r: dict) -> float | None:
    if r["price"] is not None:
        return r["price"]
    return r["value"] / r["shares"] if r["value"] is not None and r["shares"] else None


def _near(a: float | None, b: float | None) -> bool:
    return a is None or b is None or abs(a - b) <= 0.01 * max(abs(a), abs(b))


def _announcement(url: str | None) -> str | None:
    """The ASX announcement id behind a dealing (idsId=…), or the URL itself."""
    if not url:
        return None
    m = re.search(r"idsId=(\d+)", url)
    return m.group(1) if m else url


def _one_per_dealing(rows: list[dict]) -> list[dict]:
    """A dealing is often listed twice: once per announcement (the same shares, a price within 1%), or once with
    its amounts and again (up to ECHO_DAYS later, often initials only) without. Keep one row per dealing,
    preferring the row that discloses the amounts."""
    disclosed = [r for r in rows if r["shares"] is not None]
    out: list[dict] = []
    for r in rows:
        # an echo discloses nothing: the announcements crawler seeds one row per Appendix 3Y headline ("buy", no
        # amounts). It shares its announcement with the dealing it echoes; without one, the same person's disclosed
        # dealing of any type up to ECHO_DAYS before it counts
        if r["shares"] is None and r["value"] is None and any(
                (r["ann"] is not None and r["ann"] == o["ann"]) or (
                    _same_person(r["director"], o["director"]) and 0 <= (_d(r["date"]) - _d(o["date"])).days <= ECHO_DAYS)
                for o in disclosed):
            continue
        if r["shares"] is not None and any(o["date"] == r["date"] and o["type"] == r["type"]
                                           and o["shares"] == r["shares"] and _same_person(o["director"], r["director"])
                                           and _near(_unit_price(o), _unit_price(r)) for o in out):
            continue
        out.append(r)
    return out


def suitable_headline(headline: str) -> bool:
    """A third-party headline a results video may show: no advice bait, valuation call or price prediction."""
    return not UNSUITABLE.search(headline)


def roundup(headline: str, code: str, name: str | None, own: bool = False) -> bool:
    """The company is one of several: "and 2 other stocks", "X vs Y", or a list of three or more names with it in
    it. Never the company's own announcement (`own`); and the "vs" and list rules never apply to a headline about
    results ("FY25 results: revenue A$216m vs A$57m", "Telix Full Year Results, Dividend And Investor Presentation")."""
    if own:
        return False
    if ROUNDUP.search(headline):
        return True
    if RESULTS_WORDS.search(headline):
        return False
    if VERSUS.search(headline):
        return True
    first = (name or "").split()[0] if name else None
    return any(code in m.group(0) or (first and first in m.group(0)) for m in NAME_LIST.finditer(headline))


def _guidance_year(metric: dict) -> int | None:
    m = GUIDANCE_YEAR.search((metric.get("attributes") or {}).get("period") or "")
    if not m:
        return None
    return int(m.group(1)) if m.group(1) else 2000 + int(m.group(2))


def _full_date(s: Any) -> str | None:
    s = str(s or "")
    return s[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s[:10]) else None


class _Builder:
    def __init__(self, ticker: str, api: ShortedAPI, today: date):
        self.t, self.api, self.today = ticker, api, today
        self.raw: dict[str, Any] = {}
        self.sources: dict[str, Source] = {}
        self.calls: list[dict] = []
        self.short_latest: str | None = None
        self.short_value: float | None = None
        self.reporting_currency: str | None = None
        self.display_name: str | None = None

    def _call(self, label: str, service: str, body: dict) -> None:
        try:
            resp, src = self.api.call(label, service, body)
            self.raw[label], self.sources[label] = resp, src
            self.calls.append({"label": label, "ok": True})
        except Exception as err:  # a failed endpoint becomes missing values, never a crash
            self.raw[label] = None
            self.sources[label] = Source(label, body, self.api.clock().isoformat(timespec="seconds"))
            self.calls.append({"label": label, "ok": False, "status": getattr(err, "status", 0), "error": str(err)[:300]})

    def fetch(self) -> None:
        for label, service, body in calls_for(self.t):
            self._call(label, service, body)
        try:
            codes = similar_codes(self.raw.get("GetStockGraph") or {}, self.t)
        except (TypeError, ValueError, AttributeError) as err:  # a malformed graph: no similar peers, recorded
            codes = []
            self.calls.append({"label": "GetStockGraph#similar", "ok": False, "status": 0, "error": str(err)[:300]})
        if codes:  # the similarity graph names the real peers; one more call fetches their short positions
            self._call(*similar_peers_call(codes))

    def val(self, label: str, value: Any, unit: str, as_at: str | None = None, *, currency: str | None = None,
            stale: str | None = None, note: str | None = None, trust: str = "ok") -> dict:
        src = self.sources[label]
        if value is None or value == [] or value == {}:
            return missing(unit, src, note or "not reported").to_json()
        if stale and as_at and trust == "ok" and (self.today - _d(as_at)).days > STALE_DAYS[stale]:
            trust, note = "stale", note or f"as at {as_at}"
        return Value(value, unit, as_at, trust, src, currency, note).to_json()

    def company(self) -> dict:
        s, d = self.raw.get("GetStock") or {}, self.raw.get("GetStockDetails") or {}
        summary = d.get("enhancedSummary") or d.get("summary")
        hq = hq_city(d.get("address"))
        self.display_name = display_name(d.get("companyName") or s.get("name"), summary)
        return {
            "name": self.val("GetStockDetails", self.display_name, "text"),
            "ticker": self.val("GetStock", self.t, "text"),
            "industry": self.val("GetStockDetails", d.get("industry") or s.get("industry"), "text"),
            "summary": self.val("GetStockDetails", _sentences(summary, 2), "text"),
            "website": self.val("GetStockDetails", d.get("website"), "text"),
            "logo_url": self.val("GetStockDetails", d.get("logoGcsUrl") or s.get("logoUrl"), "text"),
            "headquarters": self.val("GetStockDetails", hq, "text", note=None if hq else "no city and state in the stored address"),
            "address": self.val("GetStockDetails", d.get("address"), "text"),
            "market_cap": self.val("GetStock", s.get("marketCap") or None, "money", self._last_price_date(),
                                   currency="AUD", stale="price"),
        }

    def _last_price_date(self) -> str | None:
        dates = [p["date"][:10] for p in (self.raw.get("GetStockPrices") or {}).get("points", []) if p.get("date")]
        return max(dates) if dates else None

    def _rank(self) -> tuple[int | None, str | None]:
        rows = (self.raw.get("GetTopShorts") or {}).get("timeSeries", [])
        for i, row in enumerate(rows, 1):
            if row.get("productCode") == self.t:
                return i, None
        return None, f"outside the top {len(rows)}"

    def short(self) -> dict:
        label = "GetStockData"
        ts = self.raw.get(label) or {}
        pts = sorted((p["timestamp"][:10], float(p.get("shortPosition", 0.0)), p.get("reportedShortPositions"))
                     for p in ts.get("points", []) if p.get("timestamp"))
        stock = self.raw.get("GetStock") or {}
        if not pts:
            keys = ["pct", "change_30d_pp", "change_90d_pp", "peak_1y", "reported_positions", "series_1y"]
            out = {k: missing("pct", self.sources[label], "no short series").to_json() for k in keys}
        else:
            trust = "untrusted" if ts.get("downsampled") else "ok"
            note = "series is downsampled; not usable for point values" if trust == "untrusted" else None
            last_d, last_v, last_n = pts[-1]
            self.short_latest, self.short_value = last_d, (last_v if trust == "ok" else None)

            def before(days: int):
                target = _d(last_d) - timedelta(days=days)
                earlier = [p for p in pts if _d(p[0]) <= target]
                return earlier[-1] if earlier else None

            p30, p90 = before(30), before(90)
            peak = max(pts, key=lambda p: p[1])
            out = {
                "pct": self.val(label, last_v, "pct", last_d, stale="short", trust=trust, note=note),
                "change_30d_pp": self.val(label, round(last_v - p30[1], 4) if p30 else None, "pp", last_d,
                                          stale="short", trust=trust, note=note),
                "change_90d_pp": self.val(label, round(last_v - p90[1], 4) if p90 else None, "pp", last_d,
                                          stale="short", trust=trust, note=note),
                "peak_1y": self.val(label, peak[1], "pct", peak[0], trust=trust, note=note),
                "reported_positions": self.val(label, float(last_n) if last_n is not None else None, "count",
                                               last_d, stale="short", trust=trust, note=note),
                "series_1y": self.val(label, [[d, v] for d, v, _ in pts], "series:pct", last_d),
            }
        out["shares_on_issue"] = self.val("GetStock", float(stock.get("totalProductInIssue") or 0) or None,
                                          "count", self.short_latest)
        out["days_to_cover"] = self.val("GetStock", stock.get("daysToCover") or None, "days", self.short_latest)
        if not (self.raw.get("GetTopShorts") or {}).get("timeSeries"):  # never "outside the top 0"
            out["rank"] = missing("rank", self.sources["GetTopShorts"], "the top-shorts list was unavailable or empty").to_json()
        else:
            rank, note = self._rank()
            out["rank"] = Value(rank, "rank", self.short_latest, "ok", self.sources["GetTopShorts"], note=note).to_json()
        return out

    def price(self) -> dict:
        label = "GetStockPrices"
        pr = self.raw.get(label) or {}
        pts = sorted((p["date"][:10], float(p.get("close", 0.0))) for p in pr.get("points", []) if p.get("date"))
        cur = pr.get("currency") or "AUD"
        if not pts:
            return {k: missing(u, self.sources[label], "no price history").to_json()
                    for k, u in (("close", "money"), ("change_1y_pct", "pct"), ("series_1y", "series:money"))}
        (first_d, first_close), (last_d, last_close) = pts[0], pts[-1]
        full_year = (_d(last_d) - _d(first_d)).days >= 330
        # the same raw closes the chart draws, so the stated move matches the line (not a total return)
        change = (last_close / first_close - 1.0) * 100.0 if first_close > 0 and full_year else None
        return {
            "close": self.val(label, last_close, "money", last_d, currency=cur, stale="price"),
            "change_1y_pct": self.val(label, round(change, 4) if change is not None else None, "pct", last_d,
                                      stale="price", note=None if full_year else "less than a year of prices"),
            "series_1y": self.val(label, [[d, c] for d, c in pts], "series:money", last_d, currency=cur),
        }

    def results(self) -> dict:
        label = "GetStockFundamentals"
        f = self.raw.get(label) or {}
        flow = [p for p in f.get("periods", []) if p.get("periodType") in ("annual", "half")]
        filing = f.get("latestFiling") if f.get("hasLatestFiling") else None
        latest = None
        if filing:
            latest = next((p for p in flow if p.get("periodEnd") == filing.get("periodEnd")
                           and p.get("periodType") == filing.get("periodType")), None)
        latest = latest or (flow[0] if flow else None)
        if latest is None:
            return {k: missing(u, self.sources[label], "no reported period").to_json() for k, u in RESULT_UNITS.items()}
        end, ptype = latest["periodEnd"], latest["periodType"]
        prior = next((p for p in flow if p is not latest and p.get("periodType") == ptype
                      and abs((_d(end) - _d(p["periodEnd"])).days - 365) <= 20), None)
        prior_end = prior["periodEnd"] if prior else None
        cur = latest.get("currency") or "AUD"
        self.reporting_currency = cur
        growth = f.get("growth") if f.get("hasGrowth") else {}
        q = f.get("quality") if f.get("hasQuality") else {}
        not_meaningful = set(q.get("notMeaningful", []))
        financial = bool(q.get("isFinancial"))
        rev, rev_p = _flag(latest, "revenue"), _flag(prior, "revenue")
        ni, fcf_l = _flag(latest, "net_income"), _flag(latest, "free_cash_flow")
        basis_ok = q.get("basisPeriodType") == ptype and q.get("basisPeriodEnd") == end
        balance_end = q.get("balancePeriodEnd") or q.get("basisPeriodEnd") or end

        def share(field: str) -> float | None:  # a line as a % of the result period's own revenue
            x = _flag(latest, field)
            return x / rev * 100.0 if x is not None and rev and rev > 0 else None

        own = {"gross_margin_pct": share("gross_profit"), "operating_margin_pct": share("operating_income"),
               "net_margin_pct": share("net_income"), "fcf_margin_pct": share("free_cash_flow"),
               "fcf_conversion": fcf_l / ni if fcf_l is not None and ni and ni > 0 else None,
               "net_debt": _flag(latest, "net_debt")}

        def yoy(kind: str, now: float | None, then: float | None) -> float | None:
            if ptype == "half" and growth.get("halfLatestPeriodEnd") == end and growth.get(_cc(f"has_{kind}_half_yoy")):
                return float(growth.get(_cc(f"{kind}_half_yoy_pct"), 0.0))
            basis = (growth.get("revenueBasisPeriodType") if kind == "revenue" else None) or growth.get("basisPeriodType")
            latest_end = (growth.get("revenueLatestPeriodEnd") if kind == "revenue" else None) or growth.get("latestPeriodEnd")
            if basis == ptype and latest_end == end and growth.get(_cc(f"has_{kind}_yoy")):
                return float(growth.get(_cc(f"{kind}_yoy_pct"), 0.0))
            if now is not None and then is not None and then > 0:
                return (now / then - 1.0) * 100.0
            return None

        def ratio(field: str, unit: str) -> dict:
            src = self.sources[label]
            if field in not_meaningful or _cc(field) in not_meaningful:
                return Value(None, unit, end, "withheld", src, note="not meaningful for this company").to_json()
            quality = _flag(q, field)
            same = q.get("balancePeriodEnd") == end if field == "net_debt" else basis_ok
            if same and quality is not None:
                return self.val(label, quality, unit, balance_end if field == "net_debt" else end,
                                currency=(q.get("balanceCurrency") or q.get("currency") or cur) if unit == "money" else None)
            if own.get(field) is not None:  # recomputed from the result period's own statements
                return self.val(label, own[field], unit, end, currency=cur if unit == "money" else None,
                                note="computed from the result period's own statements")
            if quality is not None:  # a ratio on another span would contradict the result card
                return Value(None, unit, q.get("basisPeriodEnd"), "untrusted", src,
                             note=f"{q.get('basisPeriodType') or 'another'} basis to {q.get('basisPeriodEnd')}, "
                                  f"not the result period").to_json()
            return missing(unit, src, "not reported").to_json()

        def money(p: dict | None, field: str, as_at: str | None, stale: str | None = "results") -> dict:
            if financial and field in ("free_cash_flow", "cash_and_equivalents", "total_debt"):
                return Value(None, "money", as_at, "withheld", self.sources[label],
                             note="not meaningful for a bank or insurer").to_json()
            return self.val(label, _flag(p, field), "money", as_at, currency=cur, stale=stale)

        def bank(p: dict | None, as_at: str | None, stale: str | None = "results") -> dict:
            if not financial:  # for anyone else "net interest income" is net finance cost, not a business line
                return Value(None, "money", as_at, "withheld", self.sources[label],
                             note="a bank measure: not meaningful for this company").to_json()
            return money(p, "net_interest_income", as_at, stale)

        nii, nii_p = _flag(latest, "net_interest_income"), _flag(prior, "net_interest_income")
        eps, eps_p = _flag(latest, "eps_basic"), _flag(prior, "eps_basic")
        out = {
            "period": self.val(label, {"end": end, "type": ptype}, "period", end, stale="results"),
            "revenue": money(latest, "revenue", end), "revenue_prior": money(prior, "revenue", prior_end, stale=None),
            "revenue_yoy_pct": self.val(label, yoy("revenue", rev, rev_p), "pct", end),
            "net_income": money(latest, "net_income", end),
            "net_income_prior": money(prior, "net_income", prior_end, stale=None),
            "eps": self.val(label, eps, "eps", end, currency=cur),
            "eps_prior": self.val(label, eps_p, "eps", prior_end, currency=cur),
            "eps_yoy_pct": self.val(label, yoy("eps", eps, eps_p), "pct", end),
            "gross_margin_pct": ratio("gross_margin_pct", "pct"),
            "operating_margin_pct": ratio("operating_margin_pct", "pct"),
            "net_margin_pct": ratio("net_margin_pct", "pct"), "fcf_margin_pct": ratio("fcf_margin_pct", "pct"),
            "fcf_conversion": ratio("fcf_conversion", "ratio"), "roe_pct": ratio("roe_pct", "pct"),
            "net_debt": ratio("net_debt", "money"),
            "fcf": money(latest, "free_cash_flow", end), "cash": money(latest, "cash_and_equivalents", end),
            "total_debt": money(latest, "total_debt", end),
            "is_financial": self.val(label, financial if q else None, "bool", end),
            "net_interest_income": bank(latest, end), "net_interest_income_prior": bank(prior, prior_end, stale=None),
            "net_interest_income_yoy_pct": self.val(label, (nii / nii_p - 1.0) * 100.0 if financial and nii is not None
                                                    and nii_p and nii_p > 0 else None, "pct", end),
            "total_assets": money(latest, "total_assets", end), "total_equity": money(latest, "total_equity", end),
            "roa_pct": ratio("roa_pct", "pct"), "payout_ratio_pct": ratio("payout_ratio_pct", "pct"),
        }
        if filing:
            conf = float(filing.get("digestConfidence", 0.0))
            digest = filing.get("digest") if conf >= MIN_CONFIDENCE else None
            out["filing"] = self.val(label, {"title": filing.get("reportTitle"), "date": filing.get("reportDate"),
                                             "url": filing.get("reportUrl"), "period_end": filing.get("periodEnd"),
                                             "period_type": filing.get("periodType"), "digest": digest},
                                     "filing", filing.get("reportDate"),
                                     note=None if digest else "digest withheld: low extraction confidence")
        else:
            out["filing"] = missing("filing", self.sources[label], "no parsed filing").to_json()
        out["guidance"] = self._guidance(filing, _d(end).year)
        same = [p for p in flow if p.get("periodType") == ptype][:4][::-1]
        hist = [{"end": p["periodEnd"], "type": ptype, "revenue": _flag(p, "revenue"),
                 "net_income": _flag(p, "net_income")} for p in same]
        out["history"] = self.val(label, hist if any(h["revenue"] is not None for h in hist) else None,
                                  "bars:history", end, currency=cur)
        return out

    def _guidance(self, filing: dict | None, result_year: int) -> dict:
        """A verbatim guidance quote for a period after the result, from the filing's own report when there is one."""
        label = "GetStockFinancialHighlights"
        hl = (((self.raw.get(label) or {}).get("highlights") or {}).get(self.t) or {})
        reports = sorted((r for r in hl.get("reports", []) if _full_date(r.get("reportDate"))),
                         key=lambda r: r["reportDate"], reverse=True)
        if filing:
            same_day = [r for r in reports if r.get("reportDate") == filing.get("reportDate")]
            same_day.sort(key=lambda r: r.get("reportTitle") != filing.get("reportTitle"))  # the filing's own report first
            reports = same_day or reports
        for rep in reports:
            if (self.today - _d(rep["reportDate"])).days > MAX_GUIDANCE_AGE_DAYS:
                continue
            quotes = [m for m in rep.get("metrics", []) if m.get("metricType") == "guidance"
                      and (m.get("sourceText") or "").strip().lower() not in ("", "null", "none")]
            ahead = [m for m in quotes if (_guidance_year(m) or 0) > result_year]  # an undated quote is refused
            pick = (ahead or [None])[0]
            if pick is None:
                continue
            conf = float(rep.get("confidence", 0.0))
            return self.val(label, pick["sourceText"].strip(), "text", rep["reportDate"],
                            trust="ok" if conf >= MIN_CONFIDENCE else "untrusted",
                            note=None if conf >= MIN_CONFIDENCE else f"digest confidence {conf:.2f}")
        return missing("text", self.sources[label], "no forward guidance quoted in a recent filing").to_json()

    def dividends(self) -> dict:
        label = "GetDividendHistory"
        dv = self.raw.get(label) or {}
        rows = sorted(({"ex_date": r["exDate"], "amount": float(r["amountPerShare"]),
                        "franking": float(r["frankingPercentage"]) if r.get("frankingPercentage") else None,
                        "type": r.get("dividendType") or "dividend"}
                       for r in dv.get("dividends", []) if r.get("exDate") and r.get("amountPerShare")),
                      key=lambda r: r["ex_date"], reverse=True)
        # dividend_history stores no currency; a company reporting in another currency may declare in it
        foreign = self.reporting_currency not in (None, "AUD")
        trust, note = ("untrusted", f"dividend currency unknown; the company reports in {self.reporting_currency}") \
            if foreign else ("ok", None)
        # no trailing yield: the API's trailingYield sums every amount in its window (five years) with no price
        return {"history": self.val(label, rows, "rows:dividends", rows[0]["ex_date"] if rows else None, currency="AUD",
                                    trust=trust, note=note)}

    def news(self) -> dict:
        label = "GetStockNews"
        rows, left_out = [], 0
        for a in (self.raw.get(label) or {}).get("articles", []):
            if not (a.get("headline") and a.get("publishedAt")):
                continue
            source = a.get("source")
            headline = html.unescape(a["headline"])
            headline = (PUBLISHER_SUFFIX.sub("", headline) if source == "googlenews" else headline).strip()
            relevance = a.get("relevanceScore")  # proto3 omits 0: absent means unknown, and is kept
            own = source == "asx" or "asx.com.au" in (a.get("url") or "")
            if (not own and not suitable_headline(headline)) or ROUTINE.search(headline) \
                    or roundup(headline, self.t, self.display_name, own) \
                    or (relevance is not None and float(relevance) < MIN_RELEVANCE):
                left_out += 1
                continue
            rows.append({"date": _sydney_date(a["publishedAt"]), "headline": headline, "source": source,
                         "sentiment": a.get("sentiment"), "url": a.get("url"),
                         "price_sensitive": bool(a.get("isPriceSensitive"))})
        rows.sort(key=lambda r: r["date"], reverse=True)
        rows = _drop_echoes(rows, "headline")
        note = f"{left_out} advice-bait, opinion, routine-notice, roundup or passing-mention headlines left out" \
            if left_out else None
        return {"items": self.val(label, rows, "rows:news", rows[0]["date"] if rows else None, note=note)}

    def _news_dates(self) -> dict[str, str]:
        """Headline -> Sydney date from the news feed's timestamps (the timeline's news rows carry the UTC date)."""
        out = {}
        for a in (self.raw.get("GetStockNews") or {}).get("articles", []):
            if a.get("headline") and a.get("publishedAt"):
                h = html.unescape(a["headline"])
                h = (PUBLISHER_SUFFIX.sub("", h) if a.get("source") == "googlenews" else h).strip()
                day = _sydney_date(a["publishedAt"])
                out[h.casefold()] = max(out.get(h.casefold(), day), day)  # the newest, as news.items keeps
        return out

    def events(self) -> dict:
        label = "GetEventTimeline"
        rows, left_out, sydney = [], 0, self._news_dates()
        for e in (self.raw.get(label) or {}).get("events", []):
            if e.get("type") == "director_trade":  # dealings live in insiders, where an undisclosed amount stays unknown
                continue
            # an announcement's title is its category ("other"); its headline is in detail, or there is none to show
            text = e.get("detail") if e.get("type") == "announcement" else e.get("title")
            if not (e.get("date") and text):
                continue
            text = html.unescape(text)
            if "news.google." in (e.get("url") or ""):
                text = PUBLISHER_SUFFIX.sub("", text)
            text = text.strip()
            own = e.get("type") == "announcement" or "asx.com.au" in (e.get("url") or "")
            if (not own and not suitable_headline(text)) or ROUTINE.search(text) or roundup(text, self.t, self.display_name, own):
                left_out += 1
                continue
            day = sydney.get(text.casefold()) if e.get("type") == "news" else None
            rows.append({"date": day or _sydney_date(e["date"]), "type": e.get("type"), "title": text,
                         "sentiment": e.get("sentiment"), "price_sensitive": bool(e.get("isPriceSensitive"))})
        rows.sort(key=lambda r: r["date"], reverse=True)
        rows = _drop_echoes(rows, "title", cross_type=True)
        note = f"{left_out} advice-bait, opinion, routine-notice or roundup headlines left out" if left_out else None
        return {"items": self.val(label, rows, "rows:events", rows[0]["date"] if rows else None, note=note)}

    def insiders(self) -> dict:
        label = "GetDirectorTrades"
        # proto3 omits zero, and a trade without shares, price or value has not disclosed it: unknown, never 0
        rows = []
        for t in (self.raw.get(label) or {}).get("trades", []):
            if not t.get("tradeDate"):
                continue
            director = (t.get("directorName") or "").strip()
            rows.append({"date": t["tradeDate"][:10],
                         "director": None if director.lower() in ("", "unknown", "unknown director") else director,
                         "type": (t.get("tradeType") or "").lower(),
                         "shares": int(t["sharesTraded"]) if t.get("sharesTraded") else None,
                         "price": float(t["pricePerShare"]) if t.get("pricePerShare") else None,
                         "value": float(t["totalValue"]) if t.get("totalValue") else None,
                         "ann": _announcement(t.get("announcementUrl"))})
        returned = len(rows)
        rows = _one_per_dealing(rows)
        for r in rows:
            del r["ann"]
        rows.sort(key=lambda r: r["date"], reverse=True)
        cutoff = self.today - timedelta(days=90)
        recent = [r for r in rows if _d(r["date"]) >= cutoff and r["type"] in ("buy", "sell")]
        limit = (self.sources[label].request or {}).get("limit")
        partial = bool(limit) and returned >= limit and bool(rows) and _d(rows[-1]["date"]) >= cutoff
        if partial:  # every row the API returned is inside the window: older dealings in it may be missing
            net, note = None, f"the {limit} most recent dealings all fall inside 90 days; the window may hold more"
        elif recent and all(r["value"] is not None for r in recent):
            net, note = sum(r["value"] if r["type"] == "buy" else -r["value"] for r in recent), None
        else:
            net, note = None, ("not every recent trade discloses its value" if recent else "no buys or sells in 90 days")
        shown = [r for r in rows if r["director"] or r["shares"] is not None or r["value"] is not None]
        hidden = len({(r["date"], r["type"]) for r in rows if r not in shown})  # dealings, not repeated rows
        return {"trades": self.val(label, shown, "rows:insiders", shown[0]["date"] if shown else None, currency="AUD",
                                   note=f"{hidden} dealing{'' if hidden == 1 else 's'} with no director named and no amounts left out" if hidden
                                   else None),
                "net_value_90d": self.val(label, net, "money", recent[0]["date"] if recent else None, currency="AUD",
                                          note=note)}

    def _similar_peers(self) -> list[dict]:
        graph = self.raw.get("GetStockGraph") or {}
        wanted = set(similar_codes(graph, self.t))
        names = {p.get("stockCode"): p.get("companyName") for p in graph.get("similarCompanies", [])}
        rows = []
        for r in (self.raw.get("GetTopShorts#peers") or {}).get("timeSeries", []):
            code = r.get("productCode")
            if code not in wanted:  # never trust the filter: anything not asked for is ignored
                continue
            points = sorted(r.get("points", []), key=lambda p: p.get("timestamp", ""))
            pct = r.get("latestShortPosition") or (points[-1].get("shortPosition") if points else None)
            last = points[-1]["timestamp"][:10] if points and points[-1].get("timestamp") else None
            if self.short_latest and last and (_d(self.short_latest) - _d(last)).days > 7:
                continue  # its last report is too old to stand beside the subject's
            if pct is not None:
                rows.append({"code": code, "name": names.get(code) or r.get("name") or code, "short_pct": float(pct),
                             "subject": False})
        return rows

    def peers(self) -> dict:
        """Similar companies (Shorted's similarity graph) when at least three have short data, else the industry."""
        pc = self.raw.get("GetPeerComparison") or {}
        similar = self._similar_peers()
        if len(similar) >= MIN_SIMILAR_PEERS:
            label, basis, rows = "GetTopShorts#peers", "similar companies", similar
        else:
            label, basis = "GetPeerComparison", (f"{pc['industry']} industry" if pc.get("industry") else None)
            rows = [{"code": p["stockCode"], "name": p.get("companyName") or p["stockCode"],
                     "short_pct": float(p.get("shortPositionPercent", 0.0)), "subject": False}
                    for p in pc.get("peers", []) if p.get("stockCode")]
        subject = pc.get("subject") or {}
        pct = self.short_value if self.short_value is not None else (
            float(subject.get("shortPositionPercent", 0.0)) if subject.get("stockCode") else None)
        if pct is not None:
            rows = rows + [{"code": self.t, "name": self.display_name or subject.get("companyName") or self.t,
                            "short_pct": pct, "subject": True}]
        rows.sort(key=lambda r: -r["short_pct"])
        rank = next((i for i, r in enumerate(rows, 1) if r["subject"]), None)
        return {"items": self.val(label, rows if len(rows) > 1 else None, "rows:peers", self.short_latest),
                "basis": self.val(label, basis, "text"),
                "industry": self.val("GetPeerComparison", pc.get("industry"), "text"),
                "subject_rank": self.val(label, rank, "rank", self.short_latest)}

    def strategy(self) -> dict:
        label = "GetStockStrategyFit"
        sf = self.raw.get(label) or {}
        rows = [{"name": x.get("strategyName"), "status": x.get("status"), "score": float(x.get("score", 0.0)),
                 "rank": int(x.get("rank", 0)), "total": int(x.get("totalCount", 0))} for x in sf.get("fits", [])]
        regime = sf.get("regime") or {}
        return {"fits": self.val(label, rows, "rows:strategy", sf.get("asOf")),
                "regime": self.val(label, regime.get("verdict"), "text", regime.get("asOf"))}

    def signals(self) -> dict:
        label = "GetStockSignals"
        sg = self.raw.get(label) or {}

        def rows(kind: str) -> list:  # event dates can be partial ("2025-11"): kept only when complete
            return [{"date": _full_date(s.get("eventDate")), "headline": s.get("headline"), "kind": s.get("kind"),
                     "polarity": s.get("polarity") or kind} for s in sg.get(kind, []) if s.get("headline")]

        def newest(items: list) -> str | None:
            dates = [r["date"] for r in items if r["date"]]
            return max(dates) if dates else None

        adverse, positive = rows("adverse"), rows("positive")
        return {"adverse": self.val(label, adverse, "rows:signals", newest(adverse)),
                "positive": self.val(label, positive, "rows:signals", newest(positive))}


def _usable(d: dict, path: str) -> bool:
    section, field = path.split(".")
    v = (d.get(section) or {}).get(field) or {}
    return v.get("trust") in ("ok", "stale") and v.get("value") not in (None, [], {})


def coverage(d: dict) -> dict:
    out = {}
    financial = ((d.get("results") or {}).get("is_financial") or {}).get("value") is True
    for chapter, (all_of, any_of) in CHAPTERS.items():
        if chapter == "cash" and financial:
            any_of = BANK_CASH
        miss = [p for p in all_of if not _usable(d, p)]
        if any_of and not any(_usable(d, p) for p in any_of):
            miss.append("any of: " + ", ".join(any_of))
        stale = [p for p in all_of + any_of
                 if ((d.get(p.split(".")[0]) or {}).get(p.split(".")[1]) or {}).get("trust") == "stale"]
        out[chapter] = {"ok": not miss, "missing": miss, "stale": stale}
    return out


def _section(b: _Builder, name: str, build) -> dict:
    try:
        return build()
    except Exception as err:  # a malformed field becomes an empty section and a recorded failure, never a crash
        b.calls.append({"label": f"section:{name}", "ok": False, "status": 0, "error": f"{type(err).__name__}: {err}"[:300]})
        return {}


def build_dossier(raw_ticker: str, api: ShortedAPI, today: date) -> dict:
    ticker = normalise_ticker(raw_ticker)
    b = _Builder(ticker, api, today)
    b.fetch()
    d = {"version": "1.0", "ticker": ticker, "built_at": today.isoformat()}
    # company first (peers use its display name), short before peers (they borrow its as-at), results before dividends
    for name in ("company", "short", "price", "results", "dividends", "news", "events", "insiders", "peers", "strategy",
                 "signals"):
        d[name] = _section(b, name, getattr(b, name))
    d.update({"calls": b.calls, "raw": b.raw})
    d["coverage"] = coverage(d)
    return d


class ShortedDossier(BaseTool):
    name = "shorted_dossier"
    version = "1.0.0"
    tier = ToolTier.SOURCE
    runtime = ToolRuntime.API
    capability = "data_research"
    provider = "shorted"
    resource_profile = ResourceProfile(network_required=True)
    input_schema = {"type": "object", "required": ["ticker", "project_dir"],
                    "properties": {"ticker": {"type": "string"}, "project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        try:
            dossier = build_dossier(inputs["ticker"], ShortedAPI(), date.today())
        except ValueError as err:  # not an ASX code
            return ToolResult(success=False, error=str(err))
        out = Path(inputs["project_dir"]) / "artifacts"
        out.mkdir(parents=True, exist_ok=True)
        (out / "dossier.json").write_text(json.dumps(dossier, indent=1))
        (out / "coverage.json").write_text(json.dumps(dossier["coverage"], indent=1))
        failed = [c for c in dossier["calls"] if not c["ok"]]
        down = {"GetStock", "GetStockData"} <= {c["label"] for c in failed}
        return ToolResult(success=not down, error="the Shorted API did not answer for this ticker" if down else None,
                          data={"coverage": dossier["coverage"], "failed_calls": failed},
                          artifacts=[str(out / "dossier.json"), str(out / "coverage.json")])
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_dossier.py -q`
Expected: PASS (72 tests).

If a recorded-fixture test fails, read the fixture JSON: the field name in the response is the source of truth. Fix the normaliser rather than the fixture.

- [ ] **Step 5: Commit**

```bash
git add tools/shorted/dossier.py tests/shorted/test_dossier.py
git commit -m "feat(shorted): dossier with provenance, trust, freshness and chapter coverage"
```

### Task 7: Bindings

**Files:**
- Create: `tools/shorted/bindings.py`
- Test: `tests/shorted/test_bindings.py`

**Interfaces:**
- Consumes: `render`, `FormatError`, `STRUCTURED_FORMATS` (Task 3); `Value`, `is_value`.
- Produces:
  - `get_path(dossier, path) -> Value`. Paths are `section.field`, `section.field.key`, `section.field[i]` or `section.field[i].key`.
  - `resolve_text(text, dossier, mode) -> (str, list[Binding])`.
  - `resolve_props(obj, dossier) -> (obj, list[Binding])`. A string that is exactly one structured placeholder becomes that structure; any other string is display-resolved.
  - `free_numerals(text) -> list[str]`; `placeholders(text) -> list[(path, fmt)]`; `BindingError`; `Binding(path, fmt, mode, trust, as_at, rendered)`.
  - Rules: number words and numeric characters are free numerals; typed numbers in props are refused (except `no`); a malformed placeholder is an error; a child value takes its unit from `CHILD_UNITS` and has no as-at of its own; every failure is a `BindingError`.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_bindings.py`:

```python
import pytest

from tools.shorted.bindings import BindingError, free_numerals, get_path, resolve_props, resolve_text
from tools.shorted.values import Source, Value

SRC = Source("GetStockFundamentals", {}, "2026-10-07T00:00:00+00:00")
D = {
    "results": {
        "revenue": Value(1.5e9, "money", "2026-06-30", "ok", SRC, "AUD").to_json(),
        "net_margin_pct": Value(None, "pct", "2026-06-30", "withheld", SRC, note="n/m").to_json(),
        "filing": Value({"title": "Half-year report", "date": "2026-08-27"}, "filing", "2026-08-27", "ok", SRC).to_json(),
    },
    "news": {"items": Value([{"date": "2026-09-28", "headline": "Contract win", "sentiment": "positive",
                              "source": "x"}], "rows:news", "2026-09-28", "ok", SRC).to_json()},
    "short": {"series_1y": Value([["2026-09-29", 15.0], ["2026-09-30", 15.07]], "series:pct",
                                 "2026-09-30", "ok", SRC).to_json()},
}


def test_resolve_text_display_and_spoken():
    shown, used = resolve_text("Revenue {{results.revenue|money}}", D, "display")
    spoken, _ = resolve_text("Revenue {{results.revenue|money}}", D, "spoken")
    assert shown == "Revenue A$1.5B" and spoken == "Revenue 1.5 billion dollars"
    assert used[0].path == "results.revenue" and used[0].trust == "ok"


def test_child_paths():
    assert get_path(D, "results.filing.title").value == "Half-year report"
    assert get_path(D, "news.items[0].headline").value == "Contract win"
    assert resolve_text("{{results.filing.date|date}}", D, "display")[0] == "27 Aug 2026"


def test_structured_whole_prop_becomes_structure():
    props, used = resolve_props({"points": "{{short.series_1y|series}}", "label": "Short interest"}, D)
    assert props["points"] == [["2026-09-29", 15.0], ["2026-09-30", 15.07]]
    assert props["label"] == "Short interest" and len(used) == 1


def test_structured_inline_is_error():
    with pytest.raises(BindingError):
        resolve_text("see {{short.series_1y|series}}", D, "display")


def test_missing_path_is_error():
    with pytest.raises(BindingError):
        resolve_text("{{results.ebitda|money}}", D, "display")


def test_withheld_value_is_na_on_screen_and_error_in_speech():
    assert resolve_text("{{results.net_margin_pct|pct}}", D, "display")[0] == "n/m"
    with pytest.raises(BindingError):
        resolve_text("{{results.net_margin_pct|pct}}", D, "spoken")


def test_free_numerals_ignore_bindings_and_allowed_literals():
    text = "In {{results.period|period}} revenue rose 4.5 per cent; ASX 200 and T+4 are fine; 2026 is not."
    assert free_numerals(text) == ["4.5", "2026"]

def test_number_words_and_numeric_characters_are_free_numerals():
    assert free_numerals("Revenue rose four point five per cent, almost double a year ago.") == ["four", "five", "double"]
    assert free_numerals("Revenue is a ¼ higher, up a third, x³.") == ["¼", "³", "third"]
    assert free_numerals("It is one of the most shorted stocks; the first half was quiet.") == []


def test_typed_numbers_in_props_are_refused():
    with pytest.raises(BindingError):
        resolve_props({"value": 1500000000}, D)
    with pytest.raises(BindingError):
        resolve_props({"items": [{"change": 4.5}]}, D)
    assert resolve_props({"no": 3, "highlight": True}, D)[0] == {"no": 3, "highlight": True}


def test_malformed_placeholders_are_errors():
    for text in ("{{results.revenue|Money}}", "{{results.revenue|money}", "{{{results.revenue|money}}}",
                 "{{ results.revenue | money | x }}"):
        with pytest.raises(BindingError):
            resolve_text(text, D, "display")
    with pytest.raises(BindingError):
        resolve_props({"points": "{{ short.series_1y | Series }}"}, D)


def test_bad_paths_are_binding_errors_not_crashes():
    with_ticker = {**D, "ticker": "DRO"}
    for text in ("{{ticker.code|text}}", "{{news.items[0]|text}}", "{{news.items[0].nope|text}}"):
        with pytest.raises(BindingError):
            resolve_text(text, with_ticker, "display")
    with pytest.raises(BindingError):
        resolve_props({"rows": "{{news.items[0]|rows}}"}, D)


def test_child_values_carry_their_own_unit():
    assert resolve_text("{{news.items[0].date|date}}", D, "display")[0] == "28 Sep 2026"
    with pytest.raises(BindingError):
        resolve_text("{{news.items[0].headline|date}}", D, "display")  # a headline is not a date
    with pytest.raises(BindingError):
        resolve_text("{{news.items[0].date|text}}", D, "spoken")  # a date is formatted, never read raw
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_bindings.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `bindings.py`**

```python
"""Bindings: {{path|format}} placeholders resolved against the dossier.

This is the only route from data to the screen or the voice. A number typed into a storyboard (in
digits, in words such as "four point five" or "double", or as a numeric character such as "1/4" in
one glyph) is a "free numeral" and the gates refuse it. Every failure here is a BindingError, so the
gates can report it against its scene instead of crashing.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from tools.shorted.formatters import STRUCTURED_FORMATS, FormatError, render
from tools.shorted.values import Value, is_value

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_.\[\]]+)\s*(?:\|\s*([a-z0-9_]+))?\s*\}\}")
WHOLE = re.compile(r"^\s*\{\{[^{}]+\}\}\s*$")
PATH = re.compile(r"([a-z_]+)\.([a-z0-9_]+)(?:\[(\d+)\])?(?:\.([a-z_]+))?")
DIGITS = re.compile(r"\d[\d,]*(?:\.\d+)?")
ALLOWED_LITERALS = [re.compile(p) for p in (r"\bT\+4\b", r"\bASX\s?(?:20|50|100|200|300)\b")]
NUMBER_WORDS = re.compile(  # "one of", "the first half" and "the quarter" stay idiomatic
    r"\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen"
    r"|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?"
    r"|billions?|trillions?|dozens?|doubled?|doubling|tripled?|tripling|twice|halved|halving|thirds?"
    r"|quarter of|half of)\b", re.I)
NUMERIC_PROPS = {"no"}  # chapter numbers are structure, not data
CHILD_UNITS = {  # the unit of each field inside a row-shaped or dict-shaped value
    "rows:news": {"date": "date", "headline": "text", "source": "text", "sentiment": "text", "url": "text"},
    "rows:events": {"date": "date", "type": "text", "title": "text", "sentiment": "text"},
    "rows:insiders": {"date": "date", "director": "text", "type": "text", "shares": "count", "price": "money",
                      "value": "money"},
    "rows:dividends": {"ex_date": "date", "amount": "eps", "franking": "pct", "type": "text"},
    "rows:peers": {"code": "text", "name": "text", "short_pct": "pct"},
    "rows:strategy": {"name": "text", "status": "text", "score": "number", "rank": "rank", "total": "int"},
    "rows:signals": {"date": "date", "headline": "text", "kind": "text", "polarity": "text"},
    "filing": {"title": "text", "date": "date", "url": "text", "period_end": "date", "period_type": "text",
               "digest": "text"},
    "period": {"end": "date", "type": "text"},
}


class BindingError(ValueError):
    pass


@dataclass(frozen=True)
class Binding:
    path: str
    fmt: str
    mode: str
    trust: str
    as_at: str | None
    rendered: Any


def placeholders(text: Any) -> list[tuple[str, str]]:
    if not isinstance(text, str):
        return []
    return [(m.group(1), m.group(2) or "text") for m in PLACEHOLDER.finditer(text)]


def get_path(dossier: dict, path: str) -> Value:
    m = PATH.fullmatch(path)
    if not m:
        raise BindingError(f"unsupported path {path!r} (use section.field, section.field.key or section.field[i].key)")
    section, field, idx, key = m.groups()
    sec = dossier.get(section)
    if not isinstance(sec, dict) or not is_value(sec.get(field)):
        raise BindingError(f"{path}: not in the dossier")
    v = Value.from_json(sec[field])
    if idx is None and key is None:
        return v
    if key is None:
        raise BindingError(f"{path}: bind one field of the row, e.g. {path}.date")
    unit = CHILD_UNITS.get(v.unit, {}).get(key)
    if unit is None:
        raise BindingError(f"{path}: no unit is known for field {key!r} of a {v.unit} value")
    if v.trust in ("missing", "withheld") or v.value in (None, [], {}):
        return Value(None, unit, None, "withheld" if v.trust == "withheld" else "missing", v.source, v.currency,
                     v.note or "not reported")
    payload: Any = v.value
    if idx is not None:
        if not isinstance(payload, list) or int(idx) >= len(payload):
            raise BindingError(f"{path}: no row {idx}")
        payload = payload[int(idx)]
    if not isinstance(payload, dict) or key not in payload:
        raise BindingError(f"{path}: no key {key!r}")
    child = payload[key]
    if isinstance(child, bool):
        raise BindingError(f"{path}: a yes/no field cannot be shown as a figure")
    if child is None:
        return Value(None, unit, None, "missing", v.source, v.currency, "not reported")
    return Value(child, unit, None, v.trust, v.source, v.currency, v.note)  # a child has no as-at of its own


def _render(v: Value, path: str, fmt: str, mode: str) -> Any:
    try:
        return render(v, fmt, mode)
    except FormatError as err:
        raise BindingError(f"{path}|{fmt}: {err}") from err
    except (KeyError, TypeError, AttributeError, ValueError, IndexError) as err:  # a value shaped wrongly for the format
        raise BindingError(f"{path}|{fmt}: cannot render ({type(err).__name__}: {err})") from err


def resolve_text(text: str, dossier: dict, mode: str) -> tuple[str, list[Binding]]:
    if not isinstance(text, str):
        raise BindingError(f"expected text, got {type(text).__name__} {text!r}")
    rest = PLACEHOLDER.sub("", text)
    if "{" in rest or "}" in rest:
        raise BindingError(f"malformed placeholder in {text!r} (the form is {{{{section.field|format}}}})")
    used: list[Binding] = []

    def sub(m: re.Match) -> str:
        path, fmt = m.group(1), m.group(2) or "text"
        if fmt in STRUCTURED_FORMATS:
            raise BindingError(f"{path}|{fmt} is structured; use it as a whole prop value")
        v = get_path(dossier, path)
        out = _render(v, path, fmt, mode)
        used.append(Binding(path, fmt, mode, v.trust, v.as_at, out))
        return str(out)

    return PLACEHOLDER.sub(sub, text), used


def resolve_props(obj: Any, dossier: dict) -> tuple[Any, list[Binding]]:
    used: list[Binding] = []

    def walk(o: Any, key: str | None = None) -> Any:
        if isinstance(o, str):
            if WHOLE.match(o):
                m = PLACEHOLDER.fullmatch(o.strip())
                if not m:
                    raise BindingError(f"malformed placeholder {o!r}")
                path, fmt = m.group(1), m.group(2) or "text"
                if fmt in STRUCTURED_FORMATS:
                    v = get_path(dossier, path)
                    out = _render(v, path, fmt, "display")
                    used.append(Binding(path, fmt, "display", v.trust, v.as_at, "<structured>"))
                    return out
            s, u = resolve_text(o, dossier, "display")
            used.extend(u)
            return s
        if isinstance(o, bool) or o is None:
            return o
        if isinstance(o, (int, float)):
            if key in NUMERIC_PROPS:
                return o
            raise BindingError(f"props.{key} holds a typed number {o!r}; bind it with {{{{section.field|format}}}}")
        if isinstance(o, list):
            return [walk(x, key) for x in o]
        if isinstance(o, dict):
            return {k: walk(x, k) for k, x in o.items()}
        return o

    return walk(obj), used


def free_numerals(text: Any) -> list[str]:
    """Numbers typed rather than bound: digits, numeric characters (fractions, superscripts, numerals) and number words."""
    if not isinstance(text, str):
        return []
    stripped = PLACEHOLDER.sub(" ", text)
    for rx in ALLOWED_LITERALS:
        stripped = rx.sub(" ", stripped)
    found = [n.rstrip(",.") for n in DIGITS.findall(stripped)]
    found += [ch for ch in stripped if not ch.isdecimal() and unicodedata.numeric(ch, None) is not None]
    found += [w.group(0) for w in NUMBER_WORDS.finditer(stripped)]
    return found
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_bindings.py -q`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/shorted/bindings.py tests/shorted/test_bindings.py
git commit -m "feat(shorted): dossier bindings and free-numeral detection"
```

### Task 8: Compliance lint and storyboard gates

**Files:**
- Create: `tools/shorted/lint.py`, `tools/shorted/gates.py`
- Test: `tests/shorted/test_lint.py`, `tests/shorted/test_gates.py`, `tests/shorted/lint_corpus.py` (the bad and good lines the lint is held to, in both directions)

**Interfaces:**
- Consumes: `resolve_text`, `resolve_props`, `free_numerals`, `BindingError` (Task 7).
- Produces:
  - `lint.Issue(code, message, where, severity="error")`, `lint_text(text, where, severity="error", before="") -> list[Issue]` (`before` is the line said just before, for back-references such as "That was because…"), `lint_storyboard(sb, dossier=None) -> list[Issue]` (with a dossier, each bound text value is linted on its own: Shorted's own text as errors, a third party's — news, events, signals, the filing, guidance — as warnings).
  - Issue codes: `advice`, `opinion`, `prediction`, `promise`, `identity`, `motive`, `causal`, `caveat` (warning) from the lint; `binding`, `numeral`, `shape`, `chapter`, `thumbnail`, `data_wishes`, `json`, `gate`, `fit` from the gates.
  - Constants `CAVEAT`, `CAVEAT_PATHS` (`("short.", "peers.")`, shared with Task 20's timeline), `ADVICE_LINE`, `STRUCTURAL_KEYS`.
  - `gates.END_CARD` (dict) and `gates.WORD_BUDGET`.
  - `gates.check_storyboard(sb, dossier, cut=None) -> GateReport(errors, warnings, words, bindings, lines, title, scenes, thumbnail, unavailable)`; each line is `{id, scene, chapter, spoken, display, style}` (`style` always a string). It validates shape first and never raises: a malformed storyboard is a list of issues.
  - `gates.REQUIRED_PROPS`: scene type → the prop names it must carry (`opening` needs `kicker`; `end_card` the five `END_CARD` keys). Task 12's `drawSceneAt` mirrors it, and a test compares the two.
  - `gates.TEXT_BUDGETS = {long: {...}, short: {...}}`: the characters each text shows whole, per cut, measured with the real scenes (Task 12's fit test renders each at its limit). Over a budget, text the director types and the quote are errors (code `fit`; `quote` for the quote) and bound data a warning on `review.md`. The quote's budget is editorial (long 320, short 240). `plate_caption` assumes Task 18 caps a capture's height at 1.7x its width (`MAX_ASPECT`): the narrowest plate, measured with a 1098 x 1866 capture. `caption_line` and `caption_lines` page the burned-in captions (Task 20). `thumb_rows`, `thumb_row` and `thumb_kicker` hold the thumbnail to the stricter of its two aspects.
  - `gates.month_ticks(first, last) -> list[str]`: the quarter starts a chart labels between two ISO dates (Task 20's `chart_axes` draws exactly these). A `line_chart` whose resolved series span fewer than two is an error that names the window and suggests a `number_card`.
  - `gates.write_review(project_dir, reports: dict[cut, GateReport], storyboards) -> Path`.
  - Tool `ShortedScriptGates` (name `shorted_script_gates`): inputs `{project_dir}`. It writes `artifacts/gates.json` (`{cut: {errors, warnings, words, bindings, lines, sha256, dossier_sha256}}`; `sha256` is of the exact bytes checked) and `artifacts/review.md` (titles, issues, every value shown as n/a or n/m, the thumbnail, the narration table with scene ids and types, each scene's resolved props, data wishes). A missing or malformed `dossier.json` is an error result, not an exception. `success` is true only when there are zero errors.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/lint_corpus.py`:

```python
"""Hand-written probes for the compliance lint, not a benchmark: lines an editor would reject, by the family that
must flag them, and factual lines that must pass. The first block of each list is the Task 8 review's corpus;
the rest are realistic slips and paraphrases added with the amendment. When a phrasing slips through, add it here."""

BAD = {
    "advice": [
        "Buy DRO now.", "Buy DRO on the dip.", "Sell DRO before the result.", "Investors should be cautious here.",
        "Shareholders should consider taking profits.", "Traders should watch the short position.",
        "I'd avoid DRO at this level.", "Avoid DRO.", "We rate DRO a buy.", "Analysts rate it a buy.",
        "The consensus rating is outperform.", "It's a buy.", "Consider buying before the result.",
        "Worth adding to your portfolio.", "This is one to watch, and one to own.", "Accumulate on weakness.",
        "Hold your shares through the result.", "Time to take profits.", "A good entry point for long-term holders.",
        "We recommend a long position.", "DRO is a top pick for the sector.", "Our best idea in defence tech.",
        "You may want to trim the position.", "You'd want to be careful here.", "Think about selling.",
        "It would be wise to wait for the result.", "Don't buy this stock.", "Do not sell yet.",
        # added
        "If you own DRO, now might be the time to sell.", "DRO looks like a buy here.",
        "{{company.name|text}} is a buy.", "Buy {{company.ticker|text}} now.",
    ],
    "opinion": [
        "The shares look overpriced.", "The stock is trading at a bargain.", "That is an attractive valuation.",
        "The shares look cheaper than peers.", "The shares trade at a fair value.", "It is priced for perfection.",
        "A stretched valuation.", "The stock offers good value.", "Great value at these levels.",
        "A steep discount to its peers.", "It looks pricey.", "The shares are dirt cheap.", "The stock is undervalued.",
        "Overvalued, in our view.",
        # added
        "Short interest is falling, a bullish sign.", "Short interest is rising, a bearish signal.",
        "A falling short position is good news for shareholders.", "We think the shares are worth more.",
    ],
    "prediction": [
        "The stock is going to rise.", "Shares are set to fall.", "The share price is likely to keep rising.",
        "The stock could squeeze higher from here.", "Shares will climb further.", "Shares will jump on the result.",
        "Shares will drop after the result.", "The price will keep falling.", "The stock will head higher.",
        "The stock should rise.", "More upside ahead.", "A short squeeze could be on the cards.",
        "This looks ripe for a squeeze.", "DRO is primed for a squeeze.", "It is poised to rally.",
        "The shares are about to take off.", "Expect the price to recover.", "The shares will tumble.",
        "It is heading for a crash.", "Short sellers will be forced to cover.", "The bears will lose.",
        "Short interest will keep rising.", "Short interest is bound to fall.", "Short interest is likely to keep climbing.",
        # added
        "Short sellers bet against it, but the shares will rise from here.", "The stock has room to run.",
        "Shorts are about to get squeezed.", "Expect a squeeze.",
    ],
    "promise": ["It can’t lose.", "Easy money.", "A sure bet.", "There is no way this goes wrong."],
    "identity": [
        "Hedge funds are shorting it.", "Big funds are piling in against it.", "Institutions are betting against DRO.",
        "Who’s shorting it? The big hedge funds.", "Who's short DRO?", "Who holds the short position?",
        "The largest short seller is a hedge fund.", "A large fund holds the biggest short position.",
        "Morgan Stanley is short.", "Here is who is shorting it.", "Smart money is short.",
        "The short sellers behind this are well known.",
    ],
    "motive": [
        "The bears are worried about the cash burn.", "Short sellers doubt the guidance.",
        "Short sellers are betting the contract will not materialise.", "The bears think the valuation is too rich.",
        "Short sellers expect a weak result.", "Bears are betting on a miss.",
        "Short interest is high, suggesting the bears are worried.", "Short sellers are clearly sceptical.",
    ],
    "causal": [
        "The share price fell on weak guidance.", "The stock fell because of the result.",
        "The stock sank after the profit warning, which spooked investors.", "Shares plunged because of the profit warning.",
        "Shares fell as investors digested the result.", "Short interest climbed as the company raised capital.",
        "Short interest rose. The move was driven by the capital raising.",
        "Short interest rose. That was because of the capital raising.",
        "Short interest rose following the profit downgrade.", "Short interest rose in response to the result.",
        "The bears piled in on news of the downgrade.", "Short interest rose, fuelled by the capital raising.",
        "Short interest jumped owing to the downgrade.", "Short interest dropped as the result beat expectations.",
        "Shares tumbled, a reaction to the downgrade.",
        "The short position was built up in the wake of the profit warning.",
        "Short interest rose off the back of the result.", "Short interest rose, which explains the share price fall.",
        "That’s why short interest rose.", "The sell-off was triggered by the result.",
        "The stock dropped because the result disappointed.", "The price slid, prompted by the capital raising.",
        "The move reflects the result.", "Short sellers piled in because they expected a weak result.",
        "Short interest fell as bears covered after the result.",
        # added
        "Revenue jumped, and the shares rose as a result.", "Revenue jumped, so the shares rose.",
        "The share price jumped, reflecting the strong result.", "The stock jumped on the result.",
        "Shares jumped on the result.", "Shares leapt after the result, thanks to a big contract win.",
        "The share price fell, which explains the short interest.", "The share price is up because revenue is up.",
        "The shares climbed because of strong demand.", "Short interest is falling, which should help the share price.",
        "The shares are up, vindicating the bulls.", "Short interest rose as the share price fell.",
        "The buy-back supported the share price.", "Strong demand drove the shares higher.",
        "The result sent the stock lower.", "Shares fell amid a broader sell-off.",
        "Short interest rose due to the downgrade.",
    ],
}

GOOD = [
    "Short interest sits at {{short.pct|pct}} of shares on issue.",
    "Short interest moved {{short.change_30d_pp|pp}} over the past month.",
    "It ranks {{short.rank|rank}} on the ASX for short interest.",
    "Short sellers borrow shares and sell them, hoping to buy them back later at a lower price.",
    "Short sellers must buy shares back to close the position.",
    "Short sellers must buy the shares back to close the position.",
    "Short sellers sell the stock first and buy it back later.",
    "Short sellers borrow shares because they expect the price to fall.",
    "A short position is a bet against a company.", "The bears are circling.",
    "Revenue came in at {{results.revenue|money}}, {{results.revenue_yoy_pct|change_pct}} on a year earlier.",
    "Revenue rose, driven by new contracts.",
    "Revenue rose {{results.revenue_yoy_pct|change_pct}}, driven by new contracts, while short interest fell "
    "{{short.change_30d_pp|pp}}.",
    "Management said it expects revenue to grow.", "The company said operating costs will rise next year.",
    "The dividend was fully covered by free cash flow.", "The dividend was well covered, thanks to strong cash flow.",
    "Net debt fell because the company repaid a loan.", "Directors bought shares in September.",
    "Directors hold the shares through a family trust.", "A director sold shares in August.",
    "Short interest has fallen since the capital raising.", "Short interest is up from a year ago.",
    "Short interest peaked in March.", "The share price is {{price.close|money}}.",
    "The shares rose {{price.change_1y_pct|change_pct}} over the year.", "Over the same year, short interest fell.",
    "Short interest and the share price moved in opposite directions.",
    "Here is what to watch: the next ASIC report on Friday.", "The next ASIC update lands on Friday.",
    "ASIC data shows the size of short positions, not who holds them or why.",
    "General information only. Not financial advice.", "Short positions are reported with a T+4 delay.",
    "Borrowing costs can be expensive for crowded shorts.", "Cash covered the debt with room to spare.",
    "It was a short year for the company's order book.", "In short, the result was a beat on revenue.",
    "Short interest rose after the result.", "The share price fell after the result.",
    "Shares in the company are down {{price.change_1y_pct|change_pct}} on the year.", "Free cash flow turned positive.",
    "The company has no debt.", "The company bought back shares.", "The company announced a buy-back of its shares.",
    "Net income was {{results.net_income|money}}.", "Peers with similar short interest include the names on screen.",
    "That is a bet that the price will fall.", "Margins are thinner than the year before.",
    "The company sells drones and counter-drone systems.", "Revenue is concentrated in a handful of customers.",
    "The stock is held by many retail investors.",
    # added: the mechanism, results narration, and business descriptions that share words with valuation talk
    "Short sellers borrow shares and sell them, betting the price will fall.",
    "Bears borrow shares, sell them, and bet the price will fall.",
    "If the price rises, short sellers will lose money.", "When the price falls, short sellers profit.",
    "Short sellers have to buy shares back eventually.", "Shorting means selling borrowed shares.",
    "Net profit was {{results.net_income|money}}.", "These figures cover {{results.period|period}}.",
    "Over the past month it moved {{short.change_30d_pp|pp}}.", "On the short list it ranks {{short.rank|rank}}.",
    "The latest ASIC figure is dated {{short.pct|as_at}}.", "It reads: {{news.items[0].headline|text}}.",
    "This is a field guide to {{company.name|text}} and the bears around it.",
    "It is listed on the ASX as {{company.ticker|text}}.",
    "The most recent director trade was a {{insiders.trades[0].type|text}} by {{insiders.trades[0].director|text}}.",
    "Directors hold {{insiders.trades[0].shares|count}} shares between them.",
    "Short sellers hold {{short.pct|pct}} of the company's shares.",
    "The share price has fallen {{price.change_1y_pct|change_pct}} over the year, while short interest climbed "
    "{{short.change_90d_pp|pp}}.",
    "Short interest rose over the same period as the shares fell.", "Short interest fell sharply after the capital raising.",
    "The shares fell on the day of the result.", "Revenue rose on higher contract volumes.",
    "Cash rose to {{results.cash|money}} as the company collected receivables.", "The stock ended the year lower.",
    "The company holds its annual meeting in November.", "Hold on to that figure.",
    "Investors will get the next update in February.", "Shareholders will vote on the deal in November.",
    "Short sellers are betting against the company.", "That makes it a crowded short.",
    "Short interest is a measure of crowding, not a forecast.", "ASIC data does not show who holds the positions.",
    "Nobody knows who is short.", "The company will recover costs through higher prices.",
    "Rising costs will squeeze margins.", "Interest rates will fall next year, the RBA says.",
    "Judo Capital is the most shorted of its peers.", "The bank is selling its life insurance business.",
    "The Reject Shop is a discount variety retailer offering bargain prices.",
    "It offers good value products to families.", "Gains on assets held at fair value lifted profit.",
    "The company provides cheap energy to households.", "It has a stretched balance sheet after the acquisition.",
    "This chart explains how short interest rose.", "Short interest rose, so did the share price.",
    "The next report is due to land on Friday, and short interest rose last week.",
]
```

`tests/shorted/test_lint.py`:

```python
import pytest

from tests.shorted.lint_corpus import BAD, GOOD
from tools.shorted.bindings import free_numerals
from tools.shorted.lint import ADVICE_LINE, CAVEAT, lint_text


def codes(issues):
    return {i.code for i in issues}


@pytest.mark.parametrize("text, code", [
    ("You should buy it now.", "advice"),
    ("This is a strong buy.", "advice"),
    ("Analysts set a price target of more.", "advice"),
    ("At these levels it looks cheap.", "opinion"),
    ("The shares will rally from here.", "prediction"),
    ("A squeeze is coming.", "prediction"),
    ("Short interest rose because of the capital raising.", "causal"),
    ("The share price fell on the back of the result.", "causal"),
    ("Here is who is shorting it.", "identity"),
])
def test_bad_lines_are_flagged(text, code):
    assert code in codes(lint_text(text, "L1"))


@pytest.mark.parametrize("text", [
    "Bears borrow shares, sell them, and bet the price will fall.",
    "Directors bought shares in September.",
    "Short interest has risen since the half-year result.",
    "Revenue came in ahead of the year before.",
])
def test_factual_lines_pass(text):
    assert lint_text(text, "L1") == []


@pytest.mark.parametrize("code, text", [(code, t) for code, lines in BAD.items() for t in lines])
def test_corpus_bad_lines_are_flagged_by_their_family(code, text):
    assert code in codes(lint_text(text, "L1"))


@pytest.mark.parametrize("text", GOOD)
def test_corpus_good_lines_pass(text):
    assert lint_text(text, "L1") == [] and free_numerals(text) == []


def test_the_fixed_lines_pass():
    assert lint_text(CAVEAT, "L1") == [] and lint_text(ADVICE_LINE, "L1") == []


def test_curly_quotes_read_as_straight_ones():
    assert "promise" in codes(lint_text("It can’t lose.", "L1"))
    assert "causal" in codes(lint_text("That’s why short interest rose.", "L1"))


def test_a_back_reference_reaches_the_line_before():
    line = "That was because of the capital raising."
    assert lint_text(line, "L2") == []
    assert "causal" in codes(lint_text(line, "L2", before="Short interest rose."))


def test_placeholders_read_as_stand_ins():
    assert "advice" in codes(lint_text("Hold {{company.ticker|text}} through the result.", "L1"))
    assert lint_text("Directors hold {{insiders.trades[0].shares|count}} shares between them.", "L1") == []


def test_severity_is_passed_through():
    assert {i.severity for i in lint_text("The stock will rally.", "L1", "warning")} == {"warning"}
```

`tests/shorted/test_gates.py`:

```python
import copy
import hashlib
import json

import pytest

from tools.shorted.gates import END_CARD, TEXT_BUDGETS, ShortedScriptGates, check_storyboard, write_review
from tools.shorted.values import Source, Value

SRC = Source("GetStockFundamentals", {}, "2026-10-07T00:00:00+00:00")
DOSSIER = {
    "results": {
        "revenue": Value(1.5e9, "money", "2026-06-30", "ok", SRC, "AUD").to_json(),
        "revenue_yoy_pct": Value(73.0, "pct", "2026-06-30", "ok", SRC).to_json(),
        "net_margin_pct": Value(None, "pct", "2026-06-30", "withheld", SRC, note="n/m").to_json(),
        "period": Value({"end": "2026-06-30", "type": "annual"}, "period", "2026-06-30", "ok", SRC).to_json(),
    },
    "short": {"pct": Value(15.07, "pct", "2026-08-01", "stale", Source("GetStockData", {}, "x"), note="as at 2026-08-01").to_json()},
}


def storyboard(lines, extra_scene_props=None):
    scene = {"id": "s1", "type": "number_card", "props": {
        "title": "The result", "items": [{"label": "Revenue", "value": "{{results.revenue|money}}"}],
        "as_at": "{{results.period|period}}", "source": "{{results.revenue|source}}", **(extra_scene_props or {})},
        "lines": [{"id": f"L{i}", "text": t, "style": "warm"} for i, t in enumerate(lines)]}
    end = {"id": "s9", "type": "end_card", "props": copy.deepcopy(END_CARD), "lines": []}
    return {"version": "1.0", "ticker": "DRO", "cut": "short",
            "chapters": [{"id": "result", "no": 1, "title": "The result", "scenes": [scene]},
                         {"id": "close", "no": 2, "title": "Close", "scenes": [end]}]}


def codes(issues):
    return {i.code for i in issues}


def test_clean_storyboard_passes():
    r = check_storyboard(storyboard(["Revenue was {{results.revenue|money}}."]), DOSSIER)
    assert r.errors == [] and r.bindings >= 4
    assert r.lines[0]["spoken"] == "Revenue was 1.5 billion dollars."


def test_free_numeral_in_narration_is_error():
    r = check_storyboard(storyboard(["Revenue rose 73 per cent."]), DOSSIER)
    assert "numeral" in codes(r.errors)


def test_free_numeral_in_props_is_error():
    r = check_storyboard(storyboard(["Hi."], {"title": "FY26 result"}), DOSSIER)
    assert "numeral" in codes(r.errors)


def test_binding_withheld_value_in_narration_is_error():
    r = check_storyboard(storyboard(["Margin {{results.net_margin_pct|pct}}."]), DOSSIER)
    assert "binding" in codes(r.errors)


def test_stale_value_is_a_warning():
    r = check_storyboard(storyboard(["Short interest is {{short.pct|pct}}."]), DOSSIER)
    assert "stale" in codes(r.warnings) and r.errors == []


def test_end_card_must_match_the_offer():
    sb = storyboard(["Hi."])
    sb["chapters"][1]["scenes"][0]["props"]["premium"] = "Premium is free"
    assert "end_card" in codes(check_storyboard(sb, DOSSIER).errors)


def test_lint_errors_surface():
    r = check_storyboard(storyboard(["You should buy it now."]), DOSSIER)
    assert "advice" in codes(r.errors)


def test_quote_card_length_limit():
    sb = storyboard(["Hi."])
    sb["chapters"][0]["scenes"].append({"id": "s2", "type": "quote_card", "lines": [],
                                        "props": {"title": "Outlook", "quote": "x" * 400, "attribution": "Company",
                                                  "as_at": "{{results.period|period}}"}})
    assert "quote" in codes(check_storyboard(sb, DOSSIER).errors)


def test_word_budget_warning():
    r = check_storyboard(storyboard(["Revenue was {{results.revenue|money}}."]), DOSSIER)
    assert "words" in codes(r.warnings)


def test_uncovered_chapter_is_error():
    dossier = {**DOSSIER, "coverage": {"result": {"ok": False, "missing": ["results.revenue"], "stale": []}}}
    r = check_storyboard(storyboard(["Revenue was {{results.revenue|money}}."]), dossier)
    assert "coverage" in codes(r.errors)


def test_thumbnail_numeral_is_error():
    sb = storyboard(["Hi."])
    sb["thumbnail"] = {"headline": ["Up 73%"], "kicker": "A field guide"}
    assert "numeral" in codes(check_storyboard(sb, DOSSIER).errors)


def test_chart_without_as_at_is_error():
    sb = storyboard(["Hi."])
    del sb["chapters"][0]["scenes"][0]["props"]["as_at"]
    assert "props" in codes(check_storyboard(sb, DOSSIER).errors)


def test_direction_must_match_the_change():
    item = {"label": "Revenue", "value": "{{results.revenue|money}}", "change": "{{results.revenue_yoy_pct|change_pct}}"}
    down = storyboard(["Hi."], {"items": [{**item, "direction": "down"}]})
    up = storyboard(["Hi."], {"items": [{**item, "direction": "up"}]})
    assert "direction" in codes(check_storyboard(down, DOSSIER).errors)
    assert "direction" not in codes(check_storyboard(up, DOSSIER).errors)
    tiny = copy.deepcopy(DOSSIER)
    tiny["results"]["revenue_yoy_pct"] = Value(0.04, "pct", "2026-06-30", "ok", SRC).to_json()  # shows as 0.0%
    assert "direction" in codes(check_storyboard(up, tiny).errors)
    flat = storyboard(["Hi."], {"items": [{**item, "direction": "flat"}]})
    assert "direction" not in codes(check_storyboard(flat, tiny).errors)


def with_values(**sections):
    """DOSSIER plus values, e.g. with_values(company={"summary": Value(...)})."""
    d = copy.deepcopy(DOSSIER)
    for section, fields in sections.items():
        d.setdefault(section, {}).update({k: v.to_json() for k, v in fields.items()})
    return d


def add_scene(sb, sid, kind, props, lines=()):
    sb["chapters"][0]["scenes"].append({"id": sid, "type": kind, "props": props,
                                        "lines": [{"id": f"{sid}L{i}", "text": t} for i, t in enumerate(lines)]})
    return sb


CARD = {"title": "Card", "as_at": "{{results.period|period}}", "source": "{{results.revenue|source}}"}
SERIES = {"label": "Short interest", "points": "{{short.series_1y|series}}", "unit": "pct", "axis": "left",
          "last": "{{short.pct|pct}}"}
CHARTS = with_values(short={"series_1y": Value([["2026-01-02", 9.5], ["2026-08-01", 15.07]], "series:pct", "2026-08-01",
                                               "ok", SRC)})


def test_titles_are_gated_like_narration():
    sb = storyboard(["Hi."])
    sb["title"] = "Why DRO is a screaming buy at 73 cents"
    sb["chapters"][0]["title"] = "The stock will rally forty per cent"
    found = {(i.code, i.where) for i in check_storyboard(sb, DOSSIER).errors}
    assert {("numeral", "title"), ("advice", "title"), ("numeral", "result/title"), ("prediction", "result/title")} <= found


def test_bound_text_is_linted_as_whose_words_it_is():
    d = with_values(company={"summary": Value("A bargain. You should buy it now.", "text", None, "ok", SRC)},
                    news={"items": Value([{"date": "2026-10-01", "headline": "DRO shares are a bargain after the sell-off"}],
                                         "rows:news", "2026-10-01", "ok", SRC)})
    sb = storyboard(["It reads: {{news.items[0].headline|text}}."])
    add_scene(sb, "s2", "company", {"name": "DroneShield", "ticker": "DRO", "summary": "{{company.summary|text}}"})
    add_scene(sb, "s3", "list_card", {**CARD, "rows": "{{news.items|rows3}}", "as_at": "{{news.items|as_at}}"})
    r = check_storyboard(sb, d)
    assert {"advice", "opinion"} <= codes(i for i in r.errors if "company.summary" in i.where)  # Shorted's words
    assert {"s1/L0 {{news.items[0].headline}}", "s3/props.rows {{news.items}}"} <= {
        i.where for i in r.warnings if i.code == "opinion"}  # a third party's, for the reviewer
    assert not any("news.items" in i.where for i in r.errors)


@pytest.mark.parametrize("place, text", [("narration", "Revenue rose seventy-three per cent."),
                                         ("narration", "Revenue was about half a billion dollars."),
                                         ("chapter title", "Shorts doubled"), ("props", "Twice the shorts"),
                                         ("thumbnail", "Up a third")])
def test_number_words_are_free_numerals(place, text):
    sb = storyboard([text] if place == "narration" else ["Hi."])
    if place == "chapter title":
        sb["chapters"][0]["title"] = text
    elif place == "props":
        sb["chapters"][0]["scenes"][0]["props"]["title"] = text
    elif place == "thumbnail":
        sb["thumbnail"] = {"headline": [text], "kicker": "A field guide"}
    assert "numeral" in codes(check_storyboard(sb, DOSSIER).errors)


def test_typed_numbers_are_binding_errors():
    item = {"label": "Revenue", "value": "{{results.revenue|money}}", "prior": 860000000}
    assert "binding" in codes(check_storyboard(storyboard(["Hi."], {"items": [item]}), DOSSIER).errors)


def test_a_bound_quote_is_measured_as_shown():
    d = with_values(results={"guidance": Value("We see demand holding up across every region. " * 10, "text",
                                               "2026-06-30", "ok", SRC)})
    sb = add_scene(storyboard(["Hi."]), "s2", "quote_card", {"title": "Outlook", "quote": "{{results.guidance|text}}",
                                                             "attribution": "Company", "as_at": "{{results.period|period}}"})
    assert "quote" in codes(check_storyboard(sb, d).errors)


def scene0(sb):
    return sb["chapters"][0]["scenes"][0]


MALFORMED = [
    ("scene without an id", lambda sb: scene0(sb).pop("id"), "shape"),
    ("scene without a type", lambda sb: scene0(sb).pop("type"), "scene"),
    ("line without text", lambda sb: scene0(sb)["lines"][0].pop("text"), "shape"),
    ("line without an id", lambda sb: scene0(sb)["lines"][0].pop("id"), "shape"),
    ("chapter without scenes", lambda sb: sb["chapters"][0].pop("scenes"), "shape"),
    ("chapters not a list", lambda sb: sb.__setitem__("chapters", {"result": []}), "shape"),
    ("props null", lambda sb: scene0(sb).__setitem__("props", None), "props"),
    ("lines not a list", lambda sb: scene0(sb).__setitem__("lines", "Hi."), "shape"),
    ("unknown cut", lambda sb: sb.__setitem__("cut", "medium"), "shape"),
    ("duplicate scene id", lambda sb: sb["chapters"][1]["scenes"][0].__setitem__("id", "s1"), "shape"),
    ("duplicate line id", lambda sb: sb["chapters"][1]["scenes"][0]["lines"].append({"id": "L0", "text": "Bye."}), "shape"),
    ("unknown chapter id", lambda sb: sb["chapters"][0].__setitem__("id", "results"), "chapter"),
    ("bound chapter title", lambda sb: sb["chapters"][0].__setitem__("title", "{{results.period|period}}"), "chapter"),
    ("wish without wanted", lambda sb: sb.__setitem__("data_wishes", [{"chapter": "outlook"}]), "data_wishes"),
    ("style not text", lambda sb: scene0(sb)["lines"][0].__setitem__("style", 3), "shape"),
    ("unknown transition", lambda sb: scene0(sb).__setitem__("transition", "wipe"), "shape"),
    ("min_seconds not a number", lambda sb: scene0(sb).__setitem__("min_seconds", "long"), "shape"),
    ("headline not a list", lambda sb: sb.__setitem__("thumbnail", {"headline": "Know where", "kicker": "A field guide"}),
     "thumbnail"),
    ("end card before the end", lambda sb: sb["chapters"].reverse(), "end_card"),
    ("cut is a list", lambda sb: sb.__setitem__("cut", ["short"]), "shape"),
    ("type is a list", lambda sb: scene0(sb).__setitem__("type", ["number_card"]), "scene"),
    ("headline with a null", lambda sb: sb.__setitem__("thumbnail", {"headline": [None], "kicker": "Hi"}), "thumbnail"),
]


@pytest.mark.parametrize("mutate, code", [m[1:] for m in MALFORMED], ids=[m[0] for m in MALFORMED])
def test_malformed_storyboards_are_reported_not_raised(mutate, code, tmp_path):
    sb = storyboard(["Hi."])
    mutate(sb)
    r = check_storyboard(sb, DOSSIER)
    assert code in codes(r.errors) and "gate" not in codes(r.errors)  # a precise issue, not the fail-closed backstop
    assert write_review(tmp_path, {"short": r}, {"short": sb}).exists()


def test_a_storyboard_that_is_not_an_object_is_reported():
    assert "shape" in codes(check_storyboard(["not", "a", "storyboard"], DOSSIER).errors)


def test_an_unknown_chapter_id_is_named():
    sb = storyboard(["Hi."])
    sb["chapters"][0]["id"] = "results"
    message = next(i.message for i in check_storyboard(sb, DOSSIER).errors if i.code == "chapter")
    assert "'results'" in message and "result," in message


@pytest.mark.parametrize("text", ["{{results.revenue|Money}}", "{{results.revenue|money|extra}}",
                                  "{{results.revenue money}}", "{results.revenue|money}"])
def test_malformed_placeholders_are_binding_errors(text):
    r = check_storyboard(storyboard([f"Revenue was {text}."]), DOSSIER)
    assert "binding" in codes(r.errors) and r.lines == []


def test_null_optional_props_are_absent():
    item = {"label": "Revenue", "value": "{{results.revenue|money}}", "prior": None, "change": None, "direction": None}
    assert check_storyboard(storyboard(["Hi."], {"items": [item]}), DOSSIER).errors == []


def test_the_cut_must_match_its_file():
    assert "shape" in codes(check_storyboard(storyboard(["Hi."]), DOSSIER, "long").errors)
    assert check_storyboard(storyboard(["Hi."]), DOSSIER, "short").errors == []


@pytest.mark.parametrize("kind, props", [
    ("opening", {"ticker": "DRO", "company": "DroneShield"}),
    ("number_card", {**CARD, "items": [{"label": "Revenue", "value": "{{results.revenue|money}}"}] * 4}),
    ("number_card", {**CARD, "items": [{"value": "{{results.revenue|money}}"}]}),
    ("line_chart", {**CARD, "series": [SERIES, {**SERIES, "axis": "right"}, SERIES]}),
    ("line_chart", {**CARD, "series": [SERIES, SERIES]}),
    ("line_chart", {**CARD, "series": [{**SERIES, "points": "{{results.revenue|money}}"}]}),
    ("line_chart", {**CARD, "series": [{**SERIES, "unit": "up 73% on last year"}]}),
    ("bar_compare", {**CARD, "items": [{"label": "DRO", "value": "{{short.pct|pct}}"}]}),
    ("list_card", {**CARD, "rows": [{"text": "Results day"}]}),
], ids=["opening without kicker", "four figures", "figure without label", "three series", "two series on one axis",
        "points not a series", "unit hiding text", "bars typed by hand", "rows typed by hand"])
def test_cards_have_the_shape_their_scene_draws(kind, props):
    sb = add_scene(storyboard(["Hi."]), "s2", kind, props)
    assert "props" in codes(check_storyboard(sb, CHARTS).errors)


def test_a_chart_with_the_shape_its_scene_draws_passes():
    sb = add_scene(storyboard(["Hi."]), "s2", "line_chart", {**CARD, "series": [SERIES]})
    assert check_storyboard(sb, CHARTS).errors == []


@pytest.mark.parametrize("key, value", [("as_at", "recently"), ("as_at", 20260630), ("as_at", "{{results.revenue|money}}"),
                                        ("source", "Shorted")])
def test_as_at_and_source_are_bindings_in_the_right_format(key, value):
    assert "props" in codes(check_storyboard(storyboard(["Hi."], {key: value}), DOSSIER).errors)


def test_direction_needs_a_usable_change_that_shows_its_sign():
    item = {"label": "Margin", "value": "{{results.revenue|money}}", "direction": "up"}
    withheld = storyboard(["Hi."], {"items": [{**item, "change": "{{results.net_margin_pct|change_pct}}"}]})
    assert "direction" in codes(check_storyboard(withheld, DOSSIER).errors)
    unsigned = check_storyboard(storyboard(["Hi."], {"items": [{**item, "change": "{{results.revenue_yoy_pct|pct}}"}]}),
                                DOSSIER)
    assert "change_pct" in next(i.message for i in unsigned.errors if i.code == "direction")
    alone = check_storyboard(storyboard(["Hi."], {"items": [item]}), DOSSIER)
    assert "direction" in codes(alone.warnings) and alone.errors == []


def test_short_talk_without_short_data_gets_a_caveat_warning():
    r = check_storyboard(storyboard(["Short interest has risen since the half-year result."]), DOSSIER)
    assert "caveat" in codes(r.warnings) and r.errors == []
    r = check_storyboard(storyboard(["Short interest has risen to {{short.pct|pct}}."]), DOSSIER)
    assert "caveat" not in codes(r.warnings)


def test_thumbnail_bindings_are_counted_and_aged():
    sb = storyboard(["Hi."])
    base = check_storyboard(sb, DOSSIER).bindings
    sb["thumbnail"] = {"headline": ["Shorts at", "{{short.pct|pct}}"], "kicker": "A field guide"}
    r = check_storyboard(sb, DOSSIER)
    assert r.bindings == base + 1 and ("stale", "thumbnail") in {(i.code, i.where) for i in r.warnings}
    assert r.thumbnail["headline"] == ["Shorts at", "15.07%"]


def test_review_sheet_shows_what_will_be_seen_and_heard(tmp_path):
    d = with_values(company={"name": Value("A | B Ltd", "text", None, "ok", SRC)})
    net_margin = {"label": "Net margin", "value": "{{results.net_margin_pct|pct}}"}
    sb = storyboard(["{{company.name|text}} reported revenue of {{results.revenue|money}}."],
                    {"items": [{"label": "Revenue", "value": "{{results.revenue|money}}"}, net_margin]})
    sb["title"] = "The {{company.name|text}} result"
    sb["thumbnail"] = {"headline": ["Know where", "the bears are."], "kicker": "A field guide"}
    text = write_review(tmp_path, {"short": check_storyboard(sb, d)}, {"short": sb}).read_text(encoding="utf-8")
    assert "## Short cut: The A | B Ltd result" in text
    assert "| L0 | result | s1 | number_card | A \\| B Ltd reported revenue of 1.5 billion dollars. |" in text
    assert "#### 1 · The result (`result`)" in text and "#### 2 · Close (`close`)" in text
    assert "- **s1** · `number_card`" in text and "items[1]: label Net margin · value n/m" in text
    assert "`results.net_margin_pct|pct` shows n/m" in text
    assert "Thumbnail: Know where / the bears are. · kicker: A field guide" in text


def project(tmp_path, dossier, **boards):
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "dossier.json").write_text(json.dumps(dossier), encoding="utf-8")
    for cut, sb in boards.items():
        (art / f"storyboard.{cut}.json").write_text(sb if isinstance(sb, str) else json.dumps(sb), encoding="utf-8")
    return tmp_path


def test_the_tool_writes_gates_json_with_both_digests(tmp_path):
    pd = project(tmp_path, DOSSIER, short=storyboard(["Revenue was {{results.revenue|money}}."]))
    assert ShortedScriptGates().execute({"project_dir": str(pd)}).success
    g = json.loads((pd / "artifacts/gates.json").read_text(encoding="utf-8"))["short"]
    assert set(g) == {"errors", "warnings", "words", "bindings", "lines", "sha256", "dossier_sha256"}
    assert g["sha256"] == hashlib.sha256((pd / "artifacts/storyboard.short.json").read_bytes()).hexdigest()
    assert g["dossier_sha256"] == hashlib.sha256((pd / "artifacts/dossier.json").read_bytes()).hexdigest()
    assert g["lines"] == [{"id": "L0", "scene": "s1", "chapter": "result", "spoken": "Revenue was 1.5 billion dollars.",
                           "display": "Revenue was A$1.5B.", "style": "warm"}]
    assert (pd / "artifacts/review.md").exists()


def test_the_tool_reports_failures_instead_of_raising(tmp_path):
    pd = project(tmp_path, DOSSIER, short=storyboard(["You should buy it now."]), long='{"cut": "long", ')
    res = ShortedScriptGates().execute({"project_dir": str(pd)})
    g = json.loads((pd / "artifacts/gates.json").read_text(encoding="utf-8"))
    assert not res.success and "advice" in {e["code"] for e in g["short"]["errors"]}
    assert [e["code"] for e in g["long"]["errors"]] == ["json"] and (pd / "artifacts/review.md").exists()
    (pd / "artifacts/dossier.json").unlink()
    res = ShortedScriptGates().execute({"project_dir": str(pd)})
    assert not res.success and "dossier" in res.error


def where(issues, code="fit"):
    return {i.where for i in issues if i.code == code}


def test_typed_text_over_its_cut_budget_is_an_error():
    """Three figures side by side on the 16:9 cut leave a label less room than a row on the 9:16 one."""
    label = "x" * (TEXT_BUDGETS["long"]["label_3"] + 1)
    items = [{"label": label, "value": "{{results.revenue|money}}"}] + [{"label": "Revenue", "value": "{{results.revenue|money}}"}] * 2
    sb = storyboard(["Hi."], {"items": items})
    assert "s1/props.items[0].label" not in where(check_storyboard(sb, DOSSIER).errors)  # the short cut
    sb["cut"] = "long"
    assert "s1/props.items[0].label" in where(check_storyboard(sb, DOSSIER).errors)
    sb["chapters"][0]["scenes"][0]["props"]["title"] = "y" * (TEXT_BUDGETS["long"]["title"] + 1)
    assert "s1/props.title" in where(check_storyboard(sb, DOSSIER).errors)


def test_bound_data_over_budget_is_a_warning_on_the_review_sheet(tmp_path):
    summary = ("Example Minerals mines lithium. " * 20)[: TEXT_BUDGETS["short"]["summary"] + 20]
    d = with_values(company={"summary": Value(summary, "text", None, "ok", SRC)})
    sb = add_scene(storyboard(["Hi."]), "s2", "company", {"name": "Example Minerals", "ticker": "EXM",
                                                         "summary": "{{company.summary|text}}"})
    r = check_storyboard(sb, d)
    assert "s2/props.summary" in where(r.warnings) and "s2/props.summary" not in where(r.errors)
    assert "`s2/props.summary` fit" in write_review(tmp_path, {"short": r}, {"short": sb}).read_text(encoding="utf-8")


def test_the_quote_budget_depends_on_the_cut_and_breaks_no_long_run():
    quote = ("Production was within the guided range for the year. " * 8)[:300]
    sb = add_scene(storyboard(["Hi."]), "s2", "quote_card", {"title": "Outlook", "quote": quote, "attribution": "Company",
                                                             "as_at": "{{results.period|period}}"})
    assert "s2/props.quote" in where(check_storyboard(sb, DOSSIER).errors, "quote")  # 240 on the short cut
    sb["cut"] = "long"
    assert "s2/props.quote" not in where(check_storyboard(sb, DOSSIER).errors, "quote")  # 320 on the long cut
    sb["chapters"][0]["scenes"][1]["props"]["quote"] = "See " + "x" * 29 + " for the detail."
    assert any("29-character run" in i.message for i in check_storyboard(sb, DOSSIER).errors if i.code == "quote")


def test_a_list_row_with_a_value_has_less_room():
    director = "Wombat " * 10  # with " · buy" the row's text is 76 characters: a news row's room, not a valued row's
    d = with_values(insiders={"trades": Value([{"date": "2026-09-01", "director": director.strip(), "type": "buy",
                                                "value": 1000.0}], "rows:insiders", "2026-09-01", "ok", SRC, "AUD")})
    sb = add_scene(storyboard(["Hi."]), "s2", "list_card", {**CARD, "rows": "{{insiders.trades|rows5}}",
                                                            "as_at": "{{insiders.trades|as_at}}"})
    assert "s2/props.rows[0].text" in where(check_storyboard(sb, d).warnings)


def test_the_thumbnail_headline_fits_both_aspects():
    sb = storyboard(["Hi."])
    sb["thumbnail"] = {"headline": ["Know where", "the bears are tonight", "and", "why"], "kicker": "A field guide"}
    found = [i.message for i in check_storyboard(sb, DOSSIER).errors if i.code == "fit" and i.where == "thumbnail"]
    assert any("4 rows" in m for m in found) and any("'the bears are tonight'" in m for m in found)


def test_a_chart_too_short_for_two_month_labels_is_an_error():
    d = with_values(short={"series_1y": Value([["2026-07-06", 9.5], ["2026-09-30", 15.07]], "series:pct", "2026-09-30",
                                              "ok", SRC)})
    sb = add_scene(storyboard(["Hi."]), "s2", "line_chart", {**CARD, "series": [SERIES]})
    message = next(i.message for i in check_storyboard(sb, d).errors if i.where == "s2/props.series")
    assert "2026-07-06 to 2026-09-30" in message and "number_card" in message
    assert check_storyboard(add_scene(storyboard(["Hi."]), "s2", "line_chart", {**CARD, "series": [SERIES]}),
                            CHARTS).errors == []  # January to August: April and July
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_lint.py tests/shorted/test_gates.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `lint.py`**

```python
"""Compliance lint: no advice, ratings or targets, no valuation opinions, no predictions or promises, nothing
about who is short or why, and no causal claims about price or short moves.

Shorted's own words (a template with its placeholders neutralised) are errors. A bound text value is also
linted on its own: a third party's words (a headline, the filing, a guidance quote) are warnings for the human
reviewer, and anything else (such as the company summary Shorted writes) is an error.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator

from tools.shorted.bindings import PLACEHOLDER, BindingError, get_path, placeholders
from tools.shorted.formatters import FormatError, render

CAVEAT = "ASIC data shows the size of short positions, not who holds them or why."
ADVICE_LINE = "General information only. Not financial advice."

THIRD_PARTY = ("news.", "events.", "signals.", "results.guidance", "results.filing")
CAVEAT_PATHS = ("short.", "peers.")  # the timeline puts the caveat on scenes binding these (timeline.SHORT_DATA)
STRUCTURAL_KEYS = {"id", "type", "image", "logo", "axis", "unit", "transition", "direction", "tone", "no"}  # not text

QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})
SENTENCE = re.compile(r"(?<=[.!?])\s+")
CLAUSE = re.compile(r";|,?\s+(?:while|whereas|although|though|but|meanwhile)\s+", re.I)

# The mechanism of shorting is not a prediction, a motive or a cause: "bet the price will fall", "expect the
# price to fall", "if the price rises, short sellers lose". Each span stays inside one clause.
MECHANISM = re.compile(
    r"\b(?:bet|bets|betting|wager|wagering|hope|hopes|hoping|expect|expects|expecting|think|thinks|believe|believes)"
    r"\s+(?:that\s+)?(?:the\s+)?(?:share\s+)?(?:price|shares?|stock)\s+(?:will|would|is going to|to)\s+"
    r"(?:fall|drop|decline|go down|rise|go up)\b"
    r"|\bif\s+the\s+(?:share\s+)?price\s+(?:rises|falls|goes up|goes down|drops|climbs)\b,?[^,.!?;]*", re.I)

ADDRESSEE = r"(?:investors?|shareholders?|holders|traders?|buyers|viewers?|readers|everyone|anyone)"
RULES: list[tuple[str, re.Pattern, str]] = [
    ("advice", re.compile(
        r"\byou(?:'d|'ll| would| will| might| may| could)?\s+(?:should|must|need to|ought to|have to|had better|better"
        r"|want to|wish to|be wise to|consider)\b"
        rf"|\b{ADDRESSEE}\s+(?:should|ought to|need to|might want to|may want to|could consider|would be wise to"
        r"|would do well to|had better)\b", re.I), "tells the viewer what to do"),
    ("advice", re.compile(r"\b(?i:buy|sell|hold|avoid|accumulate|dump|trim)\s+[A-Z]{2,4}\b(?!-)"), "a buy/sell call"),
    ("advice", re.compile(
        r"(?:^|[.!?:]\s+)(?:so,?\s+|now,?\s+|just\s+|simply\s+)?(?:buy|sell|hold|avoid|accumulate|dump|trim|exit"
        r"|get in|get out|load up|stay away|steer clear)(?![-\w])(?!\s+on\b)"
        r"|\b(?:buy|sell|hold|avoid|dump)\s+(?:it|this|these|them|the stock|the shares|this stock)"
        r"\s+(?:now|today|here|while|at these levels|on the dip|on weakness|ahead of)\b"
        r"|\b(?:hold|keep|sell|buy|trim)\s+your\s+(?:shares|stock|position|holding)\b"
        r"|\b(?:don't|do not|dont|never)\s+(?:buy|sell|hold|short|chase|panic)\b"
        r"|\b(?:consider|think about|time to|start|worth)\s+(?:buying|selling|owning|adding|accumulating|trimming"
        r"|taking profits?|shorting)\b|\btime to (?:buy|sell|get in|get out|take profits|load up)\b"
        r"|\btake profits?\b|\b(?:entry|exit|buying|selling) (?:point|opportunity)\b|\bone to (?:own|buy|sell|avoid)\b"
        r"|\bwe recommend\b|\bour (?:best|top) (?:idea|pick)\b|\bwise to (?:wait|buy|sell|hold)\b"
        r"|\b(?:to|in) your portfolio\b|\baccumulate on\b", re.I), "a call to act"),
    ("advice", re.compile(
        r"\b(?:rate[sd]?|rating|ratings)\b[^.!?]{0,20}?\b(?:buy|sell|hold|outperform|underperform|overweight"
        r"|underweight|accumulate)\b|\b(?:buy|sell|hold|outperform|overweight|underweight)['\x22]?\s+ratings?\b"
        r"|(?:\bis|'s|\bremains|\blooks like|\bstill|\bas)\s+an?\s+(?:\w+\s+)?(?:buy|sell)(?![-\w])"
        r"|\b(?:strong buy|strong sell|top (?:picks?|buys?|sells?)|best bet|conviction buy)\b"
        r"|\b(?:upgrade[sd]?|downgrade[sd]?)\b[^.!?]{0,20}?\bto (?:an? )?(?:buy|sell|hold|outperform|underperform"
        r"|overweight|underweight|neutral)\b", re.I), "a rating"),
    ("advice", re.compile(r"\b(?:price target|target price|price objective)\b", re.I), "a price target"),
    # Valuation words also describe businesses ("bargain prices", "good value products", "held at fair value"),
    # so each is matched only where it judges the shares.
    ("opinion", re.compile(
        r"\b(?:undervalued|overvalued|under-valued|over-valued|underpriced|overpriced|mispriced|value play|frothy"
        r"|priced for perfection|too rich|rich valuation|attractive(?:ly)? (?:valuation|valued|priced|entry)"
        r"|stretched valuation|(?:looks?|seems?|appears?|is) stretched"
        r"|bargain(?!\s+(?:prices?|retail\w*|stores?|shops?|hunt\w*|bins?|basement))"
        r"|(?:good|great|poor|better) value(?!\s+(?:products?|ranges?|for (?:money|customers|consumers|families)"
        r"|offering|meals?|brands?|items?|goods|retail\w*))"
        r"|(?<!held at )(?<!measured at )(?<!carried at )(?<!recognised at )(?<!recorded at )fair value"
        r"(?!\s+(?:of|gains?|losses?|adjustments?|movements?|changes?|through|hierarch\w*|accounting|measurement))"
        r"|(?:steep|deep|big|large|hefty) discount(?!\s+(?:retail\w*|stores?|chains?|variety|supermarkets?"
        r"|department|airline))"
        r"|(?:steep|big|hefty|rich) premium|(?:shares?|stock|valuation) (?:looks?|seems?) (?:reasonable|attractive"
        r"|full|rich)|(?:bullish|bearish) (?:sign|signal|indicator|setup|set-up|pattern)"
        r"|(?:good|bad|great|positive|negative) news for (?:shareholders|investors|holders|the (?:shares|stock"
        r"|share price|bears|bulls))|(?:shares?|stock) (?:is|are) worth (?:more|less|far more|much more)\b(?!\s+than)"
        r"|(?:looks?|looking|seems?|is|are|appears?|remains?|trades?|trading|got|getting|became|becomes)\s+(?:\w+\s+)?"
        r"(?:dirt[- ])?(?:cheap(?:er|est)?|expensive|pricey|pricy)|cheap(?:er|est)? (?:stock|shares|valuation|entry))\b",
        re.I), "a valuation opinion"),
    ("prediction", re.compile(
        r"\b(?:more|further|plenty of|lots of) (?:upside|downside)\b|\b(?:upside|downside) (?:ahead|from here)\b"
        r"|\b(?:higher|lower|further|up|down) from here\b|\b(?:on|in) the cards\b"
        r"|\broom to (?:run|rise|grow|climb|rally|fall)\b"
        r"|\b(?:ripe|primed|set up|ready|due|poised|teed up) for an? (?:short )?(?:squeeze|rally|rebound|bounce"
        r"|breakout|crash|fall|drop|sell-?off|re-?rating)\b"
        r"|\bhead(?:ing|ed|s)? (?:for|towards?) an? (?:crash|fall|squeeze|rally|collapse|rebound|drop|sell-?off"
        r"|recovery|breakout)\b"
        r"|\b(?:squeeze|rally|crash|rebound|recovery|sell-?off|correction|breakout) (?:is|looks|seems) (?:coming"
        r"|imminent|inevitable|likely|near|close|overdue|on the way)\b"
        r"|\bexpect(?:s|ed|ing)?\s+(?:the\s+)?(?:share\s+price|price|shares?|stock|short interest|[A-Z]{2,4})\s+to\b"
        r"|\bexpect(?:s|ed|ing)?\s+(?:an?|another|the)\s+(?:short\s+)?(?:squeeze|rally|rebound|bounce|sell-?off|crash"
        r"|recovery|re-?rating)\b"
        r"|\b(?:short sellers?|shorts|bears|bulls|longs|holders) (?:will|'ll|are going to|are set to) (?:win|lose"
        r"|be (?:right|wrong|vindicated|squeezed|burned|burnt))\b", re.I), "a prediction"),
    ("promise", re.compile(
        r"\b(?:can't lose|cannot lose|can not lose|can't go wrong|cannot go wrong|sure thing|sure bet|no-brainer"
        r"|no brainer|easy money|free money|surefire|sure-fire|one-way bet|money for jam"
        r"|risk-free (?:return|profit|bet|trade|investment|money)|guaranteed (?:returns?|profits?|gains?|win(?:ner)?"
        r"|money|income|upside|to\b)|no way (?:this|it|you) (?:goes|can go|could go) wrong)", re.I), "a promise"),
    ("identity", re.compile(
        r"\bwho(?:'s| is| are| was)\s+(?:short|shorting|betting against|behind)\b|\bwho holds?\b"
        r"|\bwhich (?:funds?|firms?|investors?|institutions?|hedge funds?) (?:is|are|were|was) (?:short|shorting)\b"
        r"|\b(?:hedge funds?|funds?|institutions?|institutional investors|asset managers?|brokers?|banks?)"
        r"\s+(?:are|is|have been|has been|were|was|hold|holds|own|owns)\s+(?:\w+\s+){0,2}(?:short|shorting"
        r"|betting against|piling|piled|loading up)\b"
        r"|\b(?:smart|big|dumb|hot) money\b|\b(?:largest|biggest|top|main|major|known|notable|prominent)"
        r" short (?:sellers?|holders?|players?|funds?)\b"
        r"|\b(?:[A-Z][a-z]+ )+(?:Stanley|Sachs|Capital|Partners|Management|Securities|Investments?|Advisors|Advisers"
        r"|Funds?)\s+(?:is|are|has|have|holds?)\s+(?:\w+\s+){0,3}?(?:short|shorting|a short position)\b"
        r"|\b(?:short sellers?|shorts|bears)\s+(?:behind|include|including|such as|are led by)\b", re.I),
     "claims to know who is short"),
    ("motive", re.compile(
        r"\b(?:short sellers?|short-sellers?|shorts|bears|the short side)\b(?:\s+\w+){0,2}?\s+(?:worried|worry|worries"
        r"|nervous|concerned|sceptical|skeptical|doubt(?:s|ed|ing)?|expect(?:s|ed|ing)?|think(?:s|ing)?|thought"
        r"|believe(?:s|d)?|fear(?:s|ed|ing)?|suspect(?:s|ed|ing)?|reckon(?:s|ed)?|question(?:s|ed|ing)?|unconvinced"
        r"|wary|see(?:s|ing)? (?:trouble|risk|weakness|problems?|downside)|bet(?:s|ting)?\s+(?:on|that|the)"
        r"|wager(?:s|ing)?\s+(?:on|that))\b", re.I), "claims to know why they are short"),
]

MODAL = (r"(?:will|'ll|won't|going to|gonna|set to|poised to|bound to|about to|likely to|expected to|sure to"
         r"|certain to|destined to|on track to|primed to|should)")
MOVE = (r"(?:rise|fall|rally|climb|jump|drop|crash|soar|plunge|recover|double|halve|bounce|squeeze|surge|slump|tumble"
        r"|rebound|spike|sink|slide|slip|tank|collapse|rocket|skyrocket|explode|break ?out|outperform|underperform"
        r"|(?:head|go|move|turn|trend) (?:higher|lower|up|down)|take off|(?:be|get) (?:forced|squeezed|wiped out|burned"
        r"|burnt|crushed)|rising|falling|rallying|climbing|jumping|dropping|crashing|soaring|plunging|recovering"
        r"|bouncing|surging|slumping|tumbling|rebounding|sinking|sliding|slipping|tanking|collapsing|going (?:up|down)"
        r"|heading (?:higher|lower))")
PREDICTION = re.compile(
    rf"\b{MODAL}\s+(?:(?:keep|continue|start|begin)\s+(?:to\s+)?)?{MOVE}\b"
    r"|\b(?:could|may|might|can)\s+(?:squeeze|rally|soar|crash|plunge|double|rocket|skyrocket|surge|collapse|tank"
    r"|explode|recover|rebound|bounce back|(?:rise|fall|climb|drop|move|head|go|squeeze|run) (?:higher|lower|further"
    r"|sharply|from here))\b", re.I)
NOT_MARKET = re.compile(  # a forecast about the business, not its price: "operating costs will rise"
    r"\b(?:costs?|expenses?|revenue|sales|earnings|profits?|margins?|dividends?|debt|cash|capex|spending|demand"
    r"|production|output|volumes?|guidance|rates?|inflation|growth|orders|backlog|deliveries|company|management"
    r"|board|business|group|government|regulator)\b", re.I)
MARKET_SUBJECT = re.compile(r"\b(?:stocks?|shares?|share price|price|short interest|short positions?|shorts"
                            r"|short sellers?|bears|bulls)\b", re.I)
NEGATION = re.compile(r"\b(?:not|never|no one|nobody|doesn't|does not|don't|do not|cannot|can't|isn't|aren't)\b", re.I)
BORROWING = re.compile(r"\b(?:borrow\w*|fees?|funding|to short|loans?)\b", re.I)

CAUSAL = re.compile(
    r"\b(?:because|caused by|causes|causing|owing to|driven by|drove|thanks to|on the back of|off the back of|amid(?:st)?"
    r"|due to(?!\s+(?:be|land|report|release|publish|pay|list|reach|end|expire|vest|settle|start|open|close|begin"
    r"|finish|complete|deliver|update|announce|hold)\b)"
    r"|as a result|which is why|that's why|that is why|this is why|the reason|reasons? (?:for|behind)|sparked|sparking"
    r"|triggered|triggering|prompted|prompting|spurred|fuell?ed|fuell?ing|in response to|responding to|reacting to"
    r"|a reaction to|in reaction to|reflects|reflecting|reflected|vindicat\w+"
    r"|explain(?:s|ed|ing)?(?!\s+(?:how|what|where|when|why))"
    r"|in the wake of|on news of|on the news|spooked|rattled|led to|leading to|resulted in|results in|sending|sent"
    r"|on (?:weak|strong|poor|solid|soft|disappointing|better|worse|upbeat|downbeat|bumper|record|lower|higher|weaker"
    r"|stronger|surprise|positive|negative)\b|on the (?:result|results|report|announcement|downgrade|upgrade|guidance"
    r"|update|warning|profit warning|raising|capital raising)\b"
    r"|(?<!period )(?<!time )(?<!month )(?<!year )(?<!week )(?<!day )as (?:investors|traders|bears|bulls|buyers"
    r"|sellers|shareholders|short interest|shares|the (?:market|company|result|results|report|news|bears|shorts"
    r"|shares|stock|share price))\b"
    r"|(?:after|following|upon) (?:the |a |an |its )?(?:\w+ ){0,2}(?:downgrade|upgrade|profit warning|warning|miss"
    r"|scandal|short report))\b|,\s*so\b(?!\s+(?:did|does|do|has|have|had|was|were|is|are|too|far|much))", re.I)
DRIVES = re.compile(  # a cause and a market move in one phrase: "helped the share price", "drove the shares higher"
    r"\b(?:help(?:s|ed|ing)?|hurt(?:s|ing)?|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|drag(?:s|ged|ging)?(?: down| on)?"
    r"|weigh(?:s|ed|ing)? on|support(?:s|ed|ing)?|pressured|dr(?:ive|ives|ove|iving|iven)|sen(?:d|ds|t|ding))"
    r"\s+(?:the\s+|its\s+)?(?:share price|shares|stock|short interest)\b", re.I)
SUBJECT = (r"(?:stocks?|shares?|share price|price|short interest|short positions?|shorts|short sellers?|short-sellers?"
           r"|bears|bulls|buyers|sellers|investors|traders|the market)")
MOVED = (r"(?:rose|risen|rises|rising|fell|fallen|falls|falling|jumped|jumps|jumping|dropped|drops|dropping|slid|slides"
         r"|sliding|surged|surges|surging|rallied|rallies|rallying|sank|sunk|sinks|sinking|tumbled|tumbles|tumbling"
         r"|plunged|plunges|plunging|climbed|climbs|climbing|gained|gains|gaining|lost|loses|losing|slumped|slumps"
         r"|slumping|soared|soars|soaring|tanked|tanks|tanking|leapt|leaped|leaps|leaping|slipped|slips|slipping"
         r"|dipped|dips|dipping|declined|declines|declining|rebounded|rebounds|rebounding|spiked|spikes|spiking|eased"
         r"|eases|easing|crashed|crashes|crashing|collapsed|collapses|collapsing|doubled|halved|recovered|recovers"
         r"|recovering|bounced|bounces|bouncing|increased|increases|increasing|decreased|decreases|decreasing|moved"
         r"|moves|moving|piled (?:in|on|out|into)|piling (?:in|on|out|into)|built up|builds? up|building up|covered"
         r"|covering|peaked|bottomed|went (?:up|down)|edged (?:up|down|higher|lower)"
         r"|(?:is|are|was|were|remains?) (?:up|down|higher|lower|high|elevated|heavy|crowded|low)"
         r"|hit (?:an? )?(?:new |fresh |record )?(?:high|low))")
MARKET = re.compile(
    rf"\b{SUBJECT}(?:\s+\w+){{0,2}}?\s+{MOVED}\b|\b(?:shares?|stock|share price|price|short interest)\s+(?:higher|lower)\b"
    r"|\b(?:the|that|this|its) (?:move|sell-?off|rally|squeeze|slump|plunge|slide|run-?up)\b|\bsell-?off\b"
    r"|\bshort (?:squeeze|covering)\b|\bshare price (?:fall|rise|drop|jump|gain|slump|decline|move)\b", re.I)
BACKREF = re.compile(r"^\s*(?:that|this|it|which)\s+(?:was|is|has been|came|happened)\b"
                     r"|^\s*(?:the|that|this)\s+(?:rise|fall|drop|jump|decline|climb|surge|increase|decrease|spike)\b",
                     re.I)
SHORT_TALK = re.compile(r"(?i:\bshort[- ](?:interest|positions?|sellers?|selling|squeeze|covering))|\bshort(?:ing|ed)\b")


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    where: str
    severity: str = "error"


def neutralise(text: str) -> str:
    """Placeholders become stand-ins (a name for text, a figure otherwise), so the lint reads Shorted's own words."""
    return PLACEHOLDER.sub(lambda m: "XYZ" if (m.group(2) or "text") == "text" else "N", text)


def _prediction(text: str) -> re.Match | None:
    for m in PREDICTION.finditer(text):
        clause = re.split(r"[,;:]", text[:m.start()])[-1]
        if not (NOT_MARKET.search(clause) and not MARKET_SUBJECT.search(clause)):
            return m
    return None


def _causal(sentence: str, previous: str) -> bool:
    for clause in CLAUSE.split(sentence):
        if DRIVES.search(clause):
            return True
        if CAUSAL.search(clause) and (MARKET.search(clause) or (BACKREF.search(clause) and MARKET.search(previous))):
            return True
    return False


def lint_text(text: str, where: str, severity: str = "error", before: str = "") -> list[Issue]:
    """Issues in one string. `before` is what is said just before it, for back-references ("That was because ...")."""
    text = neutralise(text.translate(QUOTES))
    plain = MECHANISM.sub(" ", text)
    issues = []
    for code, rx, msg in RULES:
        m = rx.search(plain if code in ("prediction", "motive") else text)
        if m and code == "identity" and m.group(0).lower().startswith("who"):
            if NEGATION.search(SENTENCE.split(text[:m.start()])[-1]):
                m = None  # "not who holds them or why" is the caveat itself
        if m and code == "opinion" and BORROWING.search(text) and re.search(r"cheap|expensive|pric", m.group(0), re.I):
            m = None  # "borrowing is expensive" is the cost of shorting, not a valuation
        if m:
            issues.append(Issue(code, f"{msg}: {m.group(0).strip()!r}", where, severity))
    m = _prediction(plain)
    if m:
        issues.append(Issue("prediction", f"a price prediction: {m.group(0)!r}", where, severity))
    previous = SENTENCE.split(neutralise(before.translate(QUOTES)).strip())[-1] if before.strip() else ""
    for s in SENTENCE.split(plain):
        if s.strip() and _causal(s, previous):
            issues.append(Issue("causal", f"causal claim about price or short moves: {s.strip()!r}", where, severity))
        previous = s
    return issues


def _scenes(sb: dict) -> list[dict]:
    chapters = sb.get("chapters") if isinstance(sb, dict) else None
    return [sc for ch in (chapters if isinstance(chapters, list) else []) if isinstance(ch, dict)
            and isinstance(ch.get("scenes"), list) for sc in ch["scenes"] if isinstance(sc, dict)]


def _strings(obj, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            yield from _strings(x, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for k, x in obj.items():
            if k not in STRUCTURAL_KEYS:
                yield from _strings(x, f"{path}.{k}" if path else str(k))


def scene_texts(sc: dict) -> Iterator[tuple[str, str, str]]:
    """(where, text, text said just before) for a scene's props (structural keys aside) and narration."""
    sid = sc.get("id")
    if sc.get("type") != "end_card" and isinstance(sc.get("props"), dict):
        for path, s in _strings(sc["props"], ""):
            yield f"{sid}/props.{path}", s, ""
    before = ""
    for ln in sc.get("lines") if isinstance(sc.get("lines"), list) else []:
        if isinstance(ln, dict) and isinstance(ln.get("text"), str):
            yield f"{sid}/{ln.get('id')}", ln["text"], before
            before = ln["text"]


def viewer_texts(sb: dict) -> Iterator[tuple[str, str, str]]:
    """Every string a viewer sees or hears: the title, chapter titles, scene props and narration (the end card's
    fixed offer aside) and the thumbnail."""
    if not isinstance(sb, dict):
        return
    if isinstance(sb.get("title"), str):
        yield "title", sb["title"], ""
    for ch in sb.get("chapters") if isinstance(sb.get("chapters"), list) else []:
        if isinstance(ch, dict) and isinstance(ch.get("title"), str):
            yield f"{ch.get('id')}/title", ch["title"], ""
    for sc in _scenes(sb):
        yield from scene_texts(sc)
    if isinstance(sb.get("thumbnail"), dict):
        for path, s in _strings(sb["thumbnail"], ""):
            yield f"thumbnail.{path}", s, ""


def bound_issues(text: str, dossier: dict, where: str) -> list[Issue]:
    """Each bound text value on its own. Rows are linted only from third-party sources (headlines): Shorted's own
    rows hold names and kinds such as "buy", not sentences."""
    issues: list[Issue] = []
    for path, fmt in placeholders(text):
        third = path.startswith(THIRD_PARTY)
        try:
            v = get_path(dossier, path)
            shown = render(v, fmt, "display") if v.usable else None
        except (BindingError, FormatError):
            continue  # the gates report it as a binding error
        if fmt == "text" and isinstance(shown, str):
            texts = [shown]
        elif third and isinstance(shown, list):
            texts = [r["text"] for r in shown if isinstance(r, dict) and isinstance(r.get("text"), str)]
        else:
            continue
        for s in texts:
            if len(s.split()) > 1:  # one word ("buy", "DroneShield") makes no claim
                issues += lint_text(s, f"{where} {{{{{path}}}}}", "warning" if third else "error")
    return issues


def binds(sc: dict, prefixes: tuple[str, ...]) -> bool:
    texts = [s for _, s in _strings(sc.get("props") if isinstance(sc.get("props"), dict) else {}, "")]
    lines = sc.get("lines") if isinstance(sc.get("lines"), list) else []
    texts += [ln.get("text") for ln in lines if isinstance(ln, dict)]
    return any(p.startswith(prefixes) for s in texts for p, _ in placeholders(s))


def caveat_issues(sb: dict) -> list[Issue]:
    """Only scenes that bind short.* or peers.* carry the caveat super, so a scene that talks about short positions
    without binding one would show none."""
    out = []
    for sc in _scenes(sb):
        talk = [s for _, s, _ in scene_texts(sc) if SHORT_TALK.search(neutralise(s))]
        if talk and not binds(sc, CAVEAT_PATHS):
            out.append(Issue("caveat", f"talks about short positions ({talk[0][:60]!r}) but binds no short.* or "
                                       "peers.* value, so it gets no ASIC caveat; bind one here or move the line",
                             str(sc.get("id")), "warning"))
    return out


def lint_storyboard(sb: dict, dossier: dict | None = None) -> list[Issue]:
    """Lint every string a viewer sees or hears and, given the dossier, every bound text value too."""
    issues: list[Issue] = []
    for where, text, before in viewer_texts(sb):
        issues += lint_text(text, where, before=before)
        if dossier is not None:
            issues += bound_issues(text, dossier, where)
    issues += caveat_issues(sb)
    scenes = _scenes(sb)
    if not scenes or scenes[-1].get("type") != "end_card":
        issues.append(Issue("end_card", "the storyboard must end with an end_card scene", "storyboard"))
    issues += [Issue("end_card", "an end_card can only be the last scene", str(sc.get("id")))
               for sc in scenes[:-1] if sc.get("type") == "end_card"]
    return issues
```

- [ ] **Step 4: Implement `gates.py`**

```python
"""Storyboard gates: shape, bindings, no free numerals, compliance lint, freshness and word budget, plus the review
sheet a human approves. A malformed storyboard is reported as issues, never raised."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolTier
from tools.shorted.bindings import (PLACEHOLDER, WHOLE, BindingError, free_numerals, get_path, placeholders,
                                    resolve_props, resolve_text)
from tools.shorted.dossier import CHAPTERS
from tools.shorted.formatters import MINUS, FormatError, render
from tools.shorted.lint import (ADVICE_LINE, CAVEAT_PATHS, STRUCTURAL_KEYS, Issue, binds, lint_storyboard,
                                viewer_texts)

END_CARD = {
    "url": "shorted.com.au",
    "free": "Free to explore",
    "premium": "Premium A$4/month: AI chat, alerts, dashboards",
    "provenance": "Data: ASIC short position reports (T+4 delay)",
    "advice": ADVICE_LINE,
}
WORD_BUDGET = {"long": (650, 750), "short": (150, 200)}
# Characters each text shows whole, as shown, per cut (long is 16:9, short 9:16): the longest worst case (wide words,
# every other text at its limit too) that the scene draws without cutting; tests/shorted/test_scene_fit.py renders
# each at its limit in its cut's aspect. The quote's is editorial, inside what fits (dense figures: 550 and 370).
# Over a budget, text the director types (or a verbatim quote) is an error; bound data the director cannot shorten is a
# warning for review.md: the scene shrinks it, and cuts it only as a last resort. A list row with a value has less
# room (headline_value). plate_caption is measured on the narrowest plate, a capture at Task 18's cap (MAX_ASPECT:
# height at most 1.7x width), because the gate runs before the capture exists; a 1.2x capture would hold 34 and 51.
# caption_line and caption_lines are the burned-in captions' line at full size and lines per page (the 16:9 cut has
# room under the page for one); timeline.py pages by them. thumb_* are the thumbnail's headline rows, characters per
# row and kicker: one headline is drawn in both aspects, so the gate holds it to the stricter.
TEXT_BUDGETS = {
    "long": {"title": 88, "chapter_title": 88, "chapter_sub": 108, "kicker": 68, "company": 88, "name": 88,
             "summary": 840, "label": 58, "label_3": 32, "prior": 140, "prior_3": 88, "headline": 175,
             "headline_value": 150, "quote": 320, "quote_token": 28, "attribution": 138, "plate_caption": 24,
             "series_label": 52, "bar_label": 58, "caption_line": 66, "caption_lines": 1, "thumb_rows": 3, "thumb_row": 26,
             "thumb_kicker": 88},
    "short": {"title": 46, "chapter_title": 46, "chapter_sub": 102, "kicker": 48, "company": 48, "name": 46,
              "summary": 460, "label": 54, "label_3": 54, "prior": 138, "prior_3": 138, "headline": 100,
              "headline_value": 60, "quote": 240, "quote_token": 28, "attribution": 94, "plate_caption": 37,
              "series_label": 50, "bar_label": 46, "caption_line": 29, "caption_lines": 2, "thumb_rows": 5, "thumb_row": 15,
              "thumb_kicker": 48},
}
REQUIRED_PROPS = {
    "opening": ["ticker", "company", "kicker"], "chapter": ["no", "title"], "company": ["name", "ticker", "summary"],
    "number_card": ["title", "items", "as_at", "source"], "bar_compare": ["title", "items", "as_at", "source"],
    "line_chart": ["title", "series", "as_at", "source"], "list_card": ["title", "rows", "as_at", "source"],
    "quote_card": ["title", "quote", "attribution", "as_at"], "plate": ["title", "image", "caption", "as_at"],
    "end_card": list(END_CARD),
}
VOCAB = {"unit": {"pct", "money"}, "axis": {"left", "right"}, "direction": {"up", "down", "flat"},
         "tone": {"pos", "neg", "neutral"}, "transition": {"page", "cut"}}
KEY = re.compile(r"[a-z][a-z0-9_]*")  # image and logo keys, ids
DATE_FORMATS = {"as_at", "period", "date", "month"}
SIGNED = {"change_pct", "pp"}  # the change formats that show a sign, so a colour can be checked against them
STRUCTURED_PROPS = {"bar_compare": ("items", {"bars_history", "bars_peers"}),
                    "list_card": ("rows", {"rows", "rows3", "rows5"})}


@dataclass
class GateReport:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    words: int = 0
    bindings: int = 0
    lines: list[dict] = field(default_factory=list)
    # for the review sheet: the resolved title, every scene as it will be drawn, the thumbnail, n/a and n/m values
    title: str = ""
    scenes: list[dict] = field(default_factory=list)
    thumbnail: dict = field(default_factory=dict)
    unavailable: list[dict] = field(default_factory=list)

    def add(self, code: str, message: str, where: str, severity: str = "error") -> None:
        (self.errors if severity == "error" else self.warnings).append(Issue(code, message, where, severity))


def _whole(value) -> tuple[str, str] | None:
    """(path, format) when the value is exactly one placeholder."""
    m = PLACEHOLDER.fullmatch(value.strip()) if isinstance(value, str) and WHOLE.match(value) else None
    return (m.group(1), m.group(2) or "text") if m else None


def _text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _absent(value) -> bool:
    return value is None or value in ("", [], {})


def _one_of(value, choices) -> bool:
    return isinstance(value, str) and value in choices


def _strings(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, list):
        return [s for x in obj for s in _strings(x)]
    if isinstance(obj, dict):
        return [s for x in obj.values() for s in _strings(x)]
    return []


def _structural(obj, where: str) -> list[Issue]:
    """Structural props are never shown as text, so each must be what it claims (and cannot hide a figure)."""
    out = []
    for k, v in obj.items() if isinstance(obj, dict) else enumerate(obj if isinstance(obj, list) else []):
        if isinstance(k, str) and k in STRUCTURAL_KEYS and v is not None:
            if k in VOCAB:
                ok, want = _one_of(v, VOCAB[k]), " or ".join(sorted(VOCAB[k]))
            elif k == "no":
                ok, want = isinstance(v, int) and not isinstance(v, bool) and v >= 0, "a whole number"
            else:
                ok, want = isinstance(v, str) and bool(KEY.fullmatch(v)), "a key such as plate_stock_chart"
            if not ok:
                out.append(Issue("props", f"{k} is {v!r}; it must be {want}", where))
        else:
            out += _structural(v, where)
    return out


def _shape(kind: str, props: dict, where: str) -> list[Issue]:
    """What each scene's code reads: card and chart shapes, structured bindings, as-at and source bindings."""
    out = []

    def bad(msg: str) -> None:
        out.append(Issue("props", msg, where))

    if kind == "number_card" and not _absent(props.get("items")):
        items = props["items"]
        if not isinstance(items, list) or not 1 <= len(items) <= 3:
            bad("number_card items must be a list of one to three figures")
        else:
            for i, it in enumerate(items):
                if not isinstance(it, dict) or not (_text(it.get("label")) and _text(it.get("value"))):
                    bad(f"items[{i}] needs a label and a value")
                elif any(it.get(k) is not None and not isinstance(it[k], str) for k in ("prior", "change")):
                    bad(f"items[{i}]: prior and change must be text")
    if kind == "line_chart" and not _absent(props.get("series")):
        series = props["series"]
        if not isinstance(series, list) or not 1 <= len(series) <= 2:
            bad("line_chart series must be a list of one or two lines")
        else:
            for i, s in enumerate(series):
                ref = _whole(s.get("points")) if isinstance(s, dict) else None
                if not ref or ref[1] != "series" or not (_text(s.get("label")) and _text(s.get("last"))) \
                        or not _one_of(s.get("unit"), VOCAB["unit"]):
                    bad(f"series[{i}] needs label, points ({{{{path|series}}}}), unit (pct or money) and last")
            axes = [s.get("axis") or "left" for s in series if isinstance(s, dict)]
            if len(axes) == 2 and axes[0] == axes[1]:
                bad("two series need their own axes: one left, one right")
    if kind in STRUCTURED_PROPS and not _absent(props.get(STRUCTURED_PROPS[kind][0])):
        key, formats = STRUCTURED_PROPS[kind]
        ref = _whole(props[key])
        if not ref or ref[1] not in formats:
            bad(f"{kind} {key} must be one binding formatted {' or '.join(sorted(formats))}")
    for key, formats, eg in (("as_at", DATE_FORMATS, "{{results.period|period}}"),
                             ("source", {"source"}, "{{results.revenue|source}}")):
        if not _absent(props.get(key)):
            ref = _whole(props[key])
            if not ref or ref[1] not in formats:
                bad(f"{key} must be one binding formatted {' or '.join(sorted(formats))}, e.g. {eg}")
    return out


def _direction_issues(props: dict, dossier: dict, where: str) -> list[Issue]:
    """Green and red mean direction, so an item's direction must be what its change shows."""
    out = []
    items = props.get("items")
    for i, it in enumerate(items if isinstance(items, list) else []):
        if not isinstance(it, dict) or it.get("direction") is None:
            continue
        label = it.get("label") or f"items[{i}]"
        refs = placeholders(it.get("change"))
        if not refs:
            out.append(Issue("direction", f"{label}: direction colours the change tag, but there is no bound change; "
                                          "drop direction", where, "warning"))
            continue
        path, fmt = refs[0]
        if fmt not in SIGNED:
            out.append(Issue("direction", f"{label}: a direction needs a change that shows its sign; bind it with "
                                          f"|change_pct or |pp, not |{fmt}", where))
            continue
        try:
            v = get_path(dossier, path)
            shown = render(v, fmt, "display")
        except (BindingError, FormatError):
            continue  # reported as a binding error
        if not v.usable:
            out.append(Issue("direction", f"{label}: the change is {v.trust} and shows {shown}, so it has no "
                                          "direction; drop direction", where))
            continue
        want = "down" if shown.startswith(MINUS) else "up" if shown.startswith("+") else "flat"
        if it["direction"] != want:
            out.append(Issue("direction", f"{label}: direction {it['direction']!r}, but the change shows {shown} "
                                          f"({want})", where))
    return out


def _fit_issues(kind: str, raw: dict, shown: dict, cut: str | None, sid: str) -> list[Issue]:
    """Text longer than its scene shows whole: an error when the director typed it or it must be verbatim, a warning
    when it is bound data the director cannot shorten. An unknown cut is checked against the stricter budget."""
    budget = TEXT_BUDGETS[cut] if cut in TEXT_BUDGETS else {
        k: min(v, TEXT_BUDGETS["short"][k]) for k, v in TEXT_BUDGETS["long"].items()}
    cut_name = f"the {cut} cut" if cut in TEXT_BUDGETS else "a cut"
    out: list[Issue] = []

    def check(key: str, raw_v, shown_v, path: str, verbatim: bool = False, code: str = "fit") -> None:
        if not isinstance(shown_v, str) or len(shown_v) <= budget[key]:
            return
        n, limit, where = len(shown_v), budget[key], f"{sid}/props.{path}"
        if verbatim or _whole(raw_v) is None:
            out.append(Issue(code, f"{path} is {n} characters as shown; {cut_name} shows at most {limit} whole: "
                                   f"{'choose a shorter verbatim passage' if verbatim else 'shorten it'}", where))
        else:
            out.append(Issue(code, f"{path} is {n} characters; {cut_name} shows {limit} whole, so the scene will shrink "
                                   "it and may cut it", where, "warning"))

    def items(key: str) -> list[tuple[dict, dict]]:
        r, s = raw.get(key), shown.get(key)
        if not isinstance(s, list):
            return []
        rs = r if isinstance(r, list) else [r] * len(s)  # a structured binding: every entry is bound
        return [(a if isinstance(a, dict) else {"_": a}, b) for a, b in zip(rs, s) if isinstance(b, dict)]

    if kind in ("number_card", "bar_compare", "line_chart", "list_card", "quote_card", "plate"):
        check("title", raw.get("title"), shown.get("title"), "title")
    if kind == "chapter":
        check("chapter_title", raw.get("title"), shown.get("title"), "title")
        check("chapter_sub", raw.get("sub"), shown.get("sub"), "sub")
    elif kind == "opening":
        check("company", raw.get("company"), shown.get("company"), "company")
        check("kicker", raw.get("kicker"), shown.get("kicker"), "kicker")
    elif kind == "company":
        check("name", raw.get("name"), shown.get("name"), "name")
        check("summary", raw.get("summary"), shown.get("summary"), "summary")
    elif kind == "number_card":
        pairs = items("items")
        for i, (a, b) in enumerate(pairs):
            three = "_3" if len(pairs) == 3 else ""
            check(f"label{three}", a.get("label", a.get("_")), b.get("label"), f"items[{i}].label")
            check(f"prior{three}", a.get("prior", a.get("_")), b.get("prior"), f"items[{i}].prior")
    elif kind == "bar_compare":
        for i, (a, b) in enumerate(items("items")):
            check("bar_label", a.get("label", a.get("_")), b.get("label"), f"items[{i}].label")
    elif kind == "line_chart":
        for i, (a, b) in enumerate(items("series")):
            check("series_label", a.get("label", a.get("_")), b.get("label"), f"series[{i}].label")
    elif kind == "list_card":
        for i, (a, b) in enumerate(items("rows")):
            check("headline_value" if b.get("value") else "headline", a.get("text", a.get("_")), b.get("text"),
                  f"rows[{i}].text")
    elif kind == "quote_card":
        check("quote", raw.get("quote"), shown.get("quote"), "quote", verbatim=True, code="quote")
        if isinstance(shown.get("quote"), str):
            for token in shown["quote"].split():
                if len(token) > budget["quote_token"]:
                    out.append(Issue("quote", f"the quote has a {len(token)}-character run without a space "
                                              f"({token[:24]}…); the card breaks no word longer than "
                                              f"{budget['quote_token']}: choose another passage", f"{sid}/props.quote"))
                    break
        check("attribution", raw.get("attribution"), shown.get("attribution"), "attribution")
    elif kind == "plate":
        check("plate_caption", raw.get("caption"), shown.get("caption"), "caption")
    return out


def month_ticks(first: str, last: str) -> list[str]:
    """The quarter starts (1 Jan, Apr, Jul, Oct) from first to last, ISO dates: the month labels a chart draws."""
    a, b = date.fromisoformat(first[:10]), date.fromisoformat(last[:10])
    m = a.year * 12 + a.month - 1 + (3 - (a.month - 1) % 3) % 3  # months since year 0: the quarter start in or after a's month
    if date(m // 12, m % 12 + 1, 1) < a:
        m += 3
    out = []
    while (tick := date(m // 12, m % 12 + 1, 1)) <= b:
        out.append(tick.isoformat())
        m += 3
    return out


def _window_issues(kind: str, shown: dict, sid: str) -> list[Issue]:
    """A line chart is read against its month labels, so its series must span at least two of them."""
    series = shown.get("series") if kind == "line_chart" else None
    days = sorted(str(p[0])[:10] for sr in (series if isinstance(series, list) else []) if isinstance(sr, dict)
                  for p in (sr.get("points") if isinstance(sr.get("points"), list) else []) if isinstance(p, list) and p)
    try:
        if not days or len(month_ticks(days[0], days[-1])) >= 2:
            return []
        span = (date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days
    except ValueError:
        return []  # a malformed date is the binding's problem, reported there
    return [Issue("props", f"the series span {days[0]} to {days[-1]} ({span} days): fewer than two month labels, so "
                           "the chart cannot be read; show these figures on a number_card instead", f"{sid}/props.series")]


def _thumb_issues(shown: dict) -> list[Issue]:
    """The thumbnail and the cover draw one headline: every row must fit the narrower 9:16 sheet, the rows the shorter
    16:9 one. The director types it, so over budget is an error."""
    most = {k: min(TEXT_BUDGETS["long"][k], TEXT_BUDGETS["short"][k]) for k in ("thumb_rows", "thumb_row", "thumb_kicker")}
    head, kicker, out = shown.get("headline"), shown.get("kicker"), []
    rows = [h for h in head if isinstance(h, str)] if isinstance(head, list) else []
    if len(rows) > most["thumb_rows"]:
        out.append(Issue("fit", f"the thumbnail headline has {len(rows)} rows; it fits {most['thumb_rows']}", "thumbnail"))
    out += [Issue("fit", f"headline row {row!r} is {len(row)} characters; a row fits {most['thumb_row']}: break it",
                  "thumbnail") for row in rows if len(row) > most["thumb_row"]]
    if isinstance(kicker, str) and len(kicker) > most["thumb_kicker"]:
        out.append(Issue("fit", f"the kicker is {len(kicker)} characters; it fits {most['thumb_kicker']}", "thumbnail"))
    return out


def _used(r: GateReport, used, dossier: dict, where: str, shown) -> None:
    """Count the bindings, flag stale ones, note n/a and n/m, and refuse braces left in the output."""
    r.bindings += len(used)
    for b in used:
        if b.trust == "stale":
            r.add("stale", f"{b.path} is stale (as at {b.as_at})", where, "warning")
        if b.rendered in ("n/a", "n/m"):
            try:
                why = get_path(dossier, b.path).note
            except BindingError:
                why = None
            r.unavailable.append({"where": where, "binding": f"{b.path}|{b.fmt}", "shows": b.rendered,
                                  "why": why or b.trust})
    if any("{" in s or "}" in s for s in _strings(shown)):
        r.add("binding", "a brace is left after the bindings resolved; the form is {{section.field|format}}", where)


def _scene(r: GateReport, sc, ch: dict, dossier: dict, seen: dict, where: str, cut: str | None = None) -> None:
    if not isinstance(sc, dict):
        r.add("shape", "a scene must be an object with id, type, props and lines", where)
        return
    sid, kind = sc.get("id"), sc.get("type")
    if not _text(sid):
        r.add("shape", "a scene needs an id", where)
        sid = where
    elif sid in seen["scenes"]:
        r.add("shape", f"scene id {sid!r} is used twice", sid)
    seen["scenes"].add(sid)
    if not _one_of(kind, REQUIRED_PROPS):
        r.add("scene", f"unknown scene type {kind!r}; use one of {', '.join(REQUIRED_PROPS)}", sid)
        return
    props, lines = sc.get("props"), sc.get("lines")
    if not isinstance(props, (dict, type(None))):
        r.add("shape", "props must be an object", sid)
    if not isinstance(lines, (list, type(None))):
        r.add("shape", "lines must be a list", sid)
    props = props if isinstance(props, dict) else {}
    lines = lines if isinstance(lines, list) else []
    if sc.get("transition") is not None and not _one_of(sc["transition"], VOCAB["transition"]):
        r.add("shape", f"transition must be page or cut, not {sc['transition']!r}", sid)
    ms = sc.get("min_seconds")
    if ms is not None and (isinstance(ms, bool) or not isinstance(ms, (int, float)) or ms < 0):
        r.add("shape", f"min_seconds must be a number of seconds, not {ms!r}", sid)
    absent = [k for k in REQUIRED_PROPS[kind] if _absent(props.get(k))]
    if absent:
        r.add("props", f"{kind} needs props {absent}", sid)
    entry = {"id": sid, "type": kind, "chapter": ch.get("id"), "chapter_no": ch.get("no"),
             "chapter_title": ch.get("title"), "props": None, "caveat": binds(sc, CAVEAT_PATHS)}
    r.scenes.append(entry)
    if kind == "end_card":
        if props != END_CARD:
            r.add("end_card", "end card props must equal gates.END_CARD exactly", sid)
        entry["props"] = props
    else:
        for issue in _structural(props, sid) + _shape(kind, props, sid) + _direction_issues(props, dossier, sid):
            r.add(issue.code, issue.message, issue.where, issue.severity)
        try:
            shown, used = resolve_props(props, dossier)
        except BindingError as err:
            r.add("binding", str(err), sid)
        else:
            entry["props"] = shown
            _used(r, used, dossier, sid, shown)
            for issue in _fit_issues(kind, props, shown, cut, sid) + _window_issues(kind, shown, sid):
                r.add(issue.code, issue.message, issue.where, issue.severity)
    for k, line in enumerate(lines):
        lw = f"{sid}/lines[{k}]"
        if not isinstance(line, dict) or not _text(line.get("id")) or not _text(line.get("text")):
            r.add("shape", "a line needs an id and text", lw)
            continue
        lid, style = line["id"], line.get("style")
        lw = f"{sid}/{lid}"
        if style is not None and not isinstance(style, str):
            r.add("shape", f"style must be text, not {style!r}", lw)
        if lid in seen["lines"]:
            r.add("shape", f"line id {lid!r} is used twice; narration is keyed by line id", lw)
            continue
        seen["lines"].add(lid)
        try:
            spoken, used = resolve_text(line["text"], dossier, "spoken")
            display, _ = resolve_text(line["text"], dossier, "display")
        except BindingError as err:
            r.add("binding", str(err), lw)
            continue
        _used(r, used, dossier, lw, [spoken, display])
        r.words += len(spoken.split())
        r.lines.append({"id": lid, "scene": sid, "chapter": ch.get("id"), "spoken": spoken, "display": display,
                        "style": style if isinstance(style, str) else ""})


def _check(r: GateReport, sb, dossier, cut: str | None) -> None:
    if not isinstance(sb, dict) or not isinstance(dossier, dict):
        r.add("shape", "the storyboard and the dossier must both be JSON objects", "storyboard")
        return
    if not _one_of(sb.get("cut"), WORD_BUDGET):
        r.add("shape", f"cut must be long or short, not {sb.get('cut')!r}", "storyboard")
    elif cut and sb["cut"] != cut:
        r.add("shape", f"cut is {sb['cut']!r} but the file is storyboard.{cut}.json", "storyboard")
    if sb.get("ticker") and dossier.get("ticker") and sb["ticker"] != dossier["ticker"]:
        r.add("shape", f"ticker {sb['ticker']!r} does not match the dossier's {dossier['ticker']!r}", "storyboard")
    title = sb.get("title")
    if title is not None and not isinstance(title, str):
        r.add("shape", "title must be text", "title")
    elif title:
        try:
            r.title, used = resolve_text(title, dossier, "display")
            _used(r, used, dossier, "title", r.title)
        except BindingError as err:
            r.add("binding", str(err), "title")
    coverage = dossier.get("coverage") if isinstance(dossier.get("coverage"), dict) else {}
    known = list(CHAPTERS) + [c for c in coverage if c not in CHAPTERS]
    chapters = sb.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        r.add("shape", "chapters must be a non-empty list", "storyboard")
        chapters = []
    seen: dict[str, set] = {"chapters": set(), "scenes": set(), "lines": set()}
    for i, ch in enumerate(chapters):
        if not isinstance(ch, dict):
            r.add("shape", "a chapter must be an object with id, no, title and scenes", f"chapters[{i}]")
            continue
        cid = ch.get("id")
        where = cid if isinstance(cid, str) and cid else f"chapters[{i}]"
        if cid not in known:
            r.add("chapter", f"unknown chapter id {cid!r}; use one of {', '.join(known)}", where)
        elif cid in seen["chapters"]:
            r.add("chapter", f"chapter {cid!r} appears twice; keep its scenes in one chapter", where)
        if isinstance(cid, str):
            seen["chapters"].add(cid)
        if not _text(ch.get("title")):
            r.add("chapter", "a chapter needs a title (it names the YouTube chapter)", where)
        elif "{" in ch["title"] or "}" in ch["title"]:
            r.add("chapter", "chapter titles are used as written (YouTube chapters, MP4 metadata); no bindings", where)
        if ch.get("no") is not None and (isinstance(ch["no"], bool) or not isinstance(ch["no"], int)):
            r.add("chapter", f"no must be a whole number, not {ch['no']!r}", where)
        cov = coverage.get(cid) if isinstance(cid, str) else None
        if isinstance(cov, dict) and cov.get("ok") is False:
            r.add("coverage", f"chapter {cid} lacks data ({'; '.join(map(str, cov.get('missing') or []))}); "
                              "leave it out and add a data_wishes entry", where)
        scenes = ch.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            r.add("shape", "a chapter needs a non-empty scenes list", where)
            continue
        for j, sc in enumerate(scenes):
            _scene(r, sc, ch, dossier, seen, f"{where}/scenes[{j}]", sb["cut"] if _one_of(sb.get("cut"), WORD_BUDGET) else None)
    thumb = sb.get("thumbnail")
    if thumb is not None and not isinstance(thumb, dict):
        r.add("thumbnail", "thumbnail must be an object with headline and kicker", "thumbnail")
    elif thumb:
        head = thumb.get("headline")
        if head is not None and not (isinstance(head, list) and head and all(_text(h) for h in head)):
            r.add("thumbnail", "thumbnail.headline must be a list of strings, one per line", "thumbnail")
        if thumb.get("kicker") is not None and not isinstance(thumb["kicker"], str):
            r.add("thumbnail", "thumbnail.kicker must be text", "thumbnail")
        try:
            r.thumbnail, used = resolve_props(thumb, dossier)
            _used(r, used, dossier, "thumbnail", r.thumbnail)
        except BindingError as err:
            r.add("binding", str(err), "thumbnail")
        for issue in _thumb_issues(r.thumbnail):
            r.add(issue.code, issue.message, issue.where, issue.severity)
    wishes = sb.get("data_wishes")
    if wishes is not None and not isinstance(wishes, list):
        r.add("data_wishes", "data_wishes must be a list", "data_wishes")
    for i, w in enumerate(wishes if isinstance(wishes, list) else []):
        if not isinstance(w, dict) or not _text(w.get("wanted")) or any(
                w.get(k) is not None and not isinstance(w[k], str) for k in ("chapter", "why")):
            r.add("data_wishes", "each wish needs wanted (and may name its chapter and why) as text",
                  f"data_wishes[{i}]")
    for where, text, _ in viewer_texts(sb):
        for num in free_numerals(text):
            r.add("numeral", f"free numeral {num!r}; bind it", where)
    for issue in lint_storyboard(sb, dossier):
        r.add(issue.code, issue.message, issue.where, issue.severity)
    if _one_of(sb.get("cut"), WORD_BUDGET):
        lo, hi = WORD_BUDGET[sb["cut"]]
        if not lo <= r.words <= hi:
            r.add("words", f"{r.words} spoken words; target {lo}-{hi}", sb["cut"], "warning")


def check_storyboard(sb: dict, dossier: dict, cut: str | None = None) -> GateReport:
    """Every gate over one storyboard. `cut`, when given, is the cut its file is named for."""
    r = GateReport()
    try:
        _check(r, sb, dossier, cut)
    except Exception as err:  # fail closed: a gate that cannot finish never passes
        r.add("gate", f"the gates could not finish ({type(err).__name__}: {err}); check the storyboard's shape",
              "storyboard")
    return r


def _cell(s) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


def _show(v) -> str:
    if isinstance(v, list) and v and all(isinstance(p, list) and len(p) == 2 for p in v):
        return f"{len(v)} points, {v[0][0]} to {v[-1][0]}"
    if isinstance(v, dict):
        keys = [k for k in v if k not in ("tone", "highlight") and not (k == "value" and "display" in v)]
        return " · ".join(f"{k} {_show(v[k])}" for k in keys if v[k] not in (None, "", []))
    if isinstance(v, list):
        return "; ".join(_show(x) for x in v)
    return str(v).replace("\n", " ")


def _scene_block(sc: dict) -> list[str]:
    head = f"- **{sc['id']}** · `{sc['type']}`" + (" · ASIC caveat shown" if sc["caveat"] else "")
    if sc["props"] is None:
        return [head + " · props did not resolve (see errors)"]
    out = [head]
    for k, v in sc["props"].items():
        if v in (None, "", []):
            continue
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            out += [f"  - {k}[{i}]: {_show(x)}" for i, x in enumerate(v)]
        else:
            out.append(f"  - {k}: {_show(v)}")
    return out


def write_review(project_dir: Path, reports: dict[str, GateReport], storyboards: dict[str, dict]) -> Path:
    """The sheet a human approves: issues, values shown as n/a or n/m, the thumbnail, the script and every scene."""
    out = ["# Storyboard review", ""]
    for cut, rep in reports.items():
        sb = storyboards.get(cut) if isinstance(storyboards.get(cut), dict) else {}
        title = rep.title or (sb.get("title") if isinstance(sb.get("title"), str) else "")
        out += [f"## {cut.title()} cut: {title}", "",
                f"{rep.words} spoken words · {rep.bindings} bindings · {len(rep.errors)} errors · "
                f"{len(rep.warnings)} warnings", ""]
        out += [f"- **ERROR** `{i.where}` {i.code}: {i.message}" for i in rep.errors]
        out += [f"- warning `{i.where}` {i.code}: {i.message}" for i in rep.warnings]
        if rep.unavailable:
            out += ["", "Shown as n/a or n/m (each must be acceptable on screen):"]
            out += [f"- `{u['where']}` `{u['binding']}` shows {u['shows']} ({u['why']})" for u in rep.unavailable]
        if rep.thumbnail:
            head = rep.thumbnail.get("headline")
            lines = " / ".join(_show(h) for h in head) if isinstance(head, list) else _show(head or "")
            out += ["", f"Thumbnail: {lines} · kicker: {_show(rep.thumbnail.get('kicker') or '')}"]
        types = {sc["id"]: sc["type"] for sc in rep.scenes}
        out += ["", "| line | chapter | scene | type | narration (as it will be spoken) |",
                "| --- | --- | --- | --- | --- |"]
        out += ["| " + " | ".join(_cell(x) for x in (ln["id"], ln["chapter"], ln["scene"], types.get(ln["scene"], ""),
                                                      ln["spoken"])) + " |" for ln in rep.lines]
        out += ["", "### On screen, scene by scene"]
        chapter = object()
        for sc in rep.scenes:
            if sc["chapter"] != chapter:
                chapter = sc["chapter"]
                no = f"{sc['chapter_no']} · " if sc["chapter_no"] is not None else ""
                out += ["", f"#### {no}{sc['chapter_title'] or ''} (`{chapter}`)", ""]
            out += _scene_block(sc)
        wishes = sb.get("data_wishes") if isinstance(sb.get("data_wishes"), list) else []
        wishes = [w for w in wishes if isinstance(w, dict)]
        if wishes:
            out += ["", "Data wishes:"]
            out += [f"- {w.get('chapter')}: {w.get('wanted')} ({w.get('why') or ''})" for w in wishes]
        out.append("")
    path = Path(project_dir) / "artifacts" / "review.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out), encoding="utf-8")
    return path


class ShortedScriptGates(BaseTool):
    name = "shorted_script_gates"
    version = "1.0.0"
    tier = ToolTier.CORE
    capability = "script_validation"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        art = Path(inputs["project_dir"]) / "artifacts"
        try:  # each file is read once: the bytes hashed are the bytes checked
            dossier_bytes = (art / "dossier.json").read_bytes()
            dossier = json.loads(dossier_bytes.decode("utf-8"))
        except FileNotFoundError:
            return ToolResult(success=False, error="no artifacts/dossier.json; run the dossier stage first")
        except ValueError as err:
            return ToolResult(success=False, error=f"artifacts/dossier.json is not valid JSON: {err}")
        raw = {cut: (art / f"storyboard.{cut}.json").read_bytes()
               for cut in WORD_BUDGET if (art / f"storyboard.{cut}.json").exists()}
        if not raw:
            return ToolResult(success=False, error="no storyboard.long.json or storyboard.short.json in artifacts/")
        storyboards, reports = {}, {}
        for cut, data in raw.items():
            try:
                storyboards[cut] = json.loads(data.decode("utf-8"))
            except ValueError as err:
                storyboards[cut] = {}
                reports[cut] = GateReport(errors=[Issue("json", f"storyboard.{cut}.json is not valid JSON: {err}",
                                                        cut)])
            else:
                reports[cut] = check_storyboard(storyboards[cut], dossier, cut)
        dossier_sha = hashlib.sha256(dossier_bytes).hexdigest()
        (art / "gates.json").write_text(json.dumps({cut: {"errors": [asdict(i) for i in r.errors],
                                                          "warnings": [asdict(i) for i in r.warnings],
                                                          "words": r.words, "bindings": r.bindings, "lines": r.lines,
                                                          "sha256": hashlib.sha256(raw[cut]).hexdigest(),
                                                          "dossier_sha256": dossier_sha}
                                                    for cut, r in reports.items()}, indent=1), encoding="utf-8")
        review = write_review(Path(inputs["project_dir"]), reports, storyboards)
        errors = sum(len(r.errors) for r in reports.values())
        return ToolResult(success=errors == 0, data={"errors": errors, "review": str(review)},
                          error=None if errors == 0 else f"{errors} gate errors; see {review}",
                          artifacts=[str(art / "gates.json"), str(review)])
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_lint.py tests/shorted/test_gates.py -q`
Expected: PASS (259 lint cases, 78 gate tests).

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/lint.py tools/shorted/gates.py tests/shorted/test_lint.py tests/shorted/test_gates.py
git commit -m "feat(shorted): compliance lint and storyboard gates with review sheet"
```

### Task 9: The Shorted MCP pass (client, parity, coverage)

Shorted's MCP server (`https://api.shorted.com.au/mcp`) is the product surface AI clients use. Reading the ticker through it as well as through the Connect API does three things for the video's data:
- checks the two surfaces agree (a disagreement is a Shorted defect);
- records which dossier sections an AI client on MCP could not get at all;
- keeps what MCP has that the dossier does not use yet.

The pass never blocks a run; Task 24 runs it inside `cli dossier` and classifies what it finds in `reflect`.

**Files:**
- Create: `tools/shorted/mcp.py`, `tools/shorted/mcp_pass.py`, `scripts/shorted/record_mcp_fixtures.py`, `tests/shorted/fixtures/<TICKER>/mcp/*.json`
- Modify: `tests/shorted/conftest.py` (append `fixture_mcp`)
- Test: `tests/shorted/test_mcp.py`

**Interfaces:**
- Consumes:
  - `Source` (Task 3) and `normalise_ticker` (Task 4);
  - the dossier JSON from `build_dossier` (Task 6), including `raw`;
  - `FIXTURES` and `fixture_api` (Task 5).
- Produces:
  - `ShortedMCP(url=None, token=None, transport=None, sleep=time.sleep, monotonic=time.monotonic, clock=None, min_interval=2.2, max_retries=3)`.
    - `.call(tool, arguments) -> (dict, Source)` returns the tool's `structuredContent`; `Source.endpoint` is `mcp:<tool>`.
    - Transport signature: `(url, headers, data) -> (status, headers, bytes)`, the same as `api.py`'s.
  - `McpError(tool, message, status)`, with `.status`; `read_reply(raw, content_type, want_id) -> dict`.
  - `mcp_calls(ticker) -> [(tool, arguments)]` (9 tools), `MCP_COVERAGE`, `parity(dossier, raw) -> [check]`, `coverage(calls) -> [entry]`, `extras(raw) -> dict`.
  - `run_mcp_pass(project_dir, mcp) -> report`, which writes `artifacts/mcp.json` with these keys:
    - `ticker`;
    - `calls: [{tool, ok, status?, error?}]`;
    - `parity: [{check, ok, dossier, mcp, detail}]`;
    - `coverage: [{section, tool, ok, note}]`;
    - `extras: {politicians}`;
    - `raw`.
  - Tool `shorted_mcp_pass`.
  - `fixture_mcp(ticker) -> ShortedMCP` replays `tests/shorted/fixtures/<T>/mcp/<tool>.json` (`{ok, arguments, result|error, fetched_at}`).

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_mcp.py`:

```python
import copy
import importlib.util
import json
import socket
from datetime import date
from pathlib import Path

import pytest

from tests.shorted.conftest import fixture_api, fixture_mcp
from tools.shorted import mcp as mcp_module
from tools.shorted import mcp_pass as mcp_pass_module
from tools.shorted.dossier import build_dossier
from tools.shorted.mcp import McpError, ShortedMCP, read_reply
from tools.shorted.mcp_pass import ShortedMcpPass, coverage, extras, mcp_calls, parity, run_mcp_pass
from tools.shorted.values import Source, Value


class Clock:
    def __init__(self):
        self.t, self.slept = 0.0, []

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.slept.append(round(s, 3))
        self.t += s


def reply(id_, data, sse=False):
    msg = json.dumps({"jsonrpc": "2.0", "id": id_,
                      "result": {"content": [{"type": "text", "text": "summary"}], "structuredContent": data}})
    if sse:
        return 200, {"Content-Type": "text/event-stream"}, f"event: message\ndata: {msg}\n\n".encode()
    return 200, {"Content-Type": "application/json"}, msg.encode()


def test_call_is_a_stateless_tools_call_and_reads_an_event_stream():
    sent = []

    def transport(url, headers, data):
        sent.append((url, headers, json.loads(data)))
        return reply(sent[-1][2]["id"], {"code": "DRO", "percent_shorted": 14.8991}, sse=True)

    clock = Clock()
    mcp = ShortedMCP(url="https://x/mcp", token="", transport=transport, sleep=clock.sleep, monotonic=clock.monotonic)
    data, src = mcp.call("get_stock", {"code": "DRO"})
    url, headers, body = sent[0]
    assert body["method"] == "tools/call" and body["params"] == {"name": "get_stock", "arguments": {"code": "DRO"}}
    assert "text/event-stream" in headers["Accept"]
    assert "MCP-Protocol-Version" not in headers and "Authorization" not in headers
    assert data["percent_shorted"] == 14.8991 and src.endpoint == "mcp:get_stock"


def test_token_is_sent_as_a_bearer():
    seen = []

    def transport(url, headers, data):
        seen.append(headers)
        return reply(json.loads(data)["id"], {})

    ShortedMCP(url="https://x/mcp", token="t0k", transport=transport, min_interval=0).call("get_stock", {"code": "DRO"})
    assert seen[0]["Authorization"] == "Bearer t0k"


def test_calls_are_paced_under_the_anonymous_limit():
    clock = Clock()
    mcp = ShortedMCP(url="https://x/mcp", token="", transport=lambda u, h, d: reply(json.loads(d)["id"], {}),
                     sleep=clock.sleep, monotonic=clock.monotonic, min_interval=2.2)
    for _ in range(3):
        mcp.call("get_stock", {"code": "DRO"})
    assert clock.slept == [2.2, 2.2]


def test_the_rate_limit_challenge_is_backed_off_and_retried():
    clock = Clock()
    replies = [(401, {"WWW-Authenticate": 'Bearer resource_metadata="x"'}, b""), None]

    def transport(url, headers, data):
        r = replies.pop(0)
        return r or reply(json.loads(data)["id"], {"ok": True})

    mcp = ShortedMCP(url="https://x/mcp", token="", transport=transport, sleep=clock.sleep, monotonic=clock.monotonic,
                     min_interval=0)
    data, _ = mcp.call("get_stock", {"code": "DRO"})
    assert data == {"ok": True} and clock.slept == [10.0]


def test_network_errors_are_retried():
    clock = Clock()
    replies = [(599, {}, b"timed out"), None]

    def transport(url, headers, data):
        r = replies.pop(0)
        return r or reply(json.loads(data)["id"], {"ok": True})

    mcp = ShortedMCP(url="https://x/mcp", token="", transport=transport, sleep=clock.sleep, monotonic=clock.monotonic,
                     min_interval=0)
    assert mcp.call("get_stock", {"code": "DRO"})[0] == {"ok": True} and clock.slept == [1.0]


def test_retry_after_is_clamped():
    clock = Clock()
    replies = [(429, {"Retry-After": "2678400"}, b""), None]

    def transport(url, headers, data):
        r = replies.pop(0)
        return r or reply(json.loads(data)["id"], {"ok": True})

    mcp = ShortedMCP(url="https://x/mcp", token=" t0k\n", transport=transport, sleep=clock.sleep,
                     monotonic=clock.monotonic, min_interval=0)
    assert mcp.call("get_stock", {"code": "DRO"})[0] == {"ok": True} and clock.slept == [120.0]
    assert mcp.headers()["Authorization"] == "Bearer t0k"


def test_tool_protocol_and_http_errors_raise():
    def tool_error(url, headers, data):
        msg = {"jsonrpc": "2.0", "id": json.loads(data)["id"],
               "result": {"isError": True, "content": [{"type": "text", "text": "unknown ticker"}]}}
        return 200, {"Content-Type": "application/json"}, json.dumps(msg).encode()

    def rpc_error(url, headers, data):
        msg = {"jsonrpc": "2.0", "id": json.loads(data)["id"], "error": {"code": -32602, "message": "bad params"}}
        return 200, {"Content-Type": "application/json"}, json.dumps(msg).encode()

    with pytest.raises(McpError, match="unknown ticker"):
        ShortedMCP(url="https://x/mcp", token="", transport=tool_error, min_interval=0).call("get_stock", {"code": "ZZZ"})
    with pytest.raises(McpError, match="bad params"):
        ShortedMCP(url="https://x/mcp", token="", transport=rpc_error, min_interval=0).call("get_stock", {})
    with pytest.raises(McpError) as err:
        ShortedMCP(url="https://x/mcp", token="", transport=lambda u, h, d: (404, {}, b"no"), min_interval=0).call("get_stock", {})
    assert err.value.status == 404


SRC = Source("GetStockData", {}, "2026-10-07T00:00:00+00:00")


def V(value, unit, as_at="2026-09-30"):
    return Value(value, unit, as_at, "ok", SRC).to_json()


DOSSIER = {
    "ticker": "DRO",
    "short": {"pct": V(14.8991, "pct")},
    "price": {"close": V(1.64, "money")},
    "results": {"period": V({"end": "2025-12-31", "type": "annual"}, "period", "2025-12-31"),
                "revenue": V(216.5e6, "money", "2025-12-31"), "net_income": V(3.5e6, "money", "2025-12-31")},
    "raw": {"GetPeerComparison": {"peers": [{"stockCode": "SGH"}, {"stockCode": "REH"}]},
            "GetDirectorTrades": {"trades": [{"tradeDate": "2026-09-01", "tradeType": "buy", "sharesTraded": "1000"}]},
            "GetStockNews": {"articles": [{"headline": "A"}]}},
}
RAW = {
    "get_stock": {"percent_shorted": 14.8991},
    "get_stock_history": {"points": [{"date": "2026-09-29", "short_percent": 14.7},
                                     {"date": "2026-09-30", "short_percent": 14.8991}]},
    "get_stock_prices": {"points": [{"date": "2026-09-30", "close": 1.64}]},
    "get_stock_fundamentals": {"periods": [{"period_type": "annual", "period_end": "2025-12-31",
                                            "revenue": 216.5e6, "net_income": 3.5e6}]},
    "get_peer_comparison": {"peers": [{"code": "REH"}, {"code": "SGH"}]},
    "get_director_trades": {"trades": [{"date": "2026-09-01", "trade_type": "buy", "shares_traded": 1000}]},
    "get_stock_news": {"articles": [{"headline": "A"}]},
}


def test_parity_agrees_when_the_surfaces_match():
    checks = parity(DOSSIER, RAW)
    assert {c["check"] for c in checks} == {"short.pct", "short.pct_latest", "price.close", "results.revenue",
                                            "results.net_income", "peers.industry_set", "insiders.trades", "news.headlines"}
    assert all(c["ok"] for c in checks), [c for c in checks if not c["ok"]]


def test_parity_flags_a_disagreement():
    raw = json.loads(json.dumps(RAW))
    raw["get_stock_history"]["points"][-1] = {"date": "2026-09-30", "short_percent": 14.91}
    raw["get_stock_fundamentals"]["periods"][0]["revenue"] = 210e6
    assert {c["check"] for c in parity(DOSSIER, raw) if not c["ok"]} == {"short.pct", "results.revenue"}


def test_coverage_names_what_mcp_cannot_serve():
    cov = {c["section"]: c for c in coverage([{"tool": "get_stock_news", "ok": False, "error": "HTTP 503"}])}
    assert {s for s, c in cov.items() if c["tool"] is None} == {"results.filing", "results.guidance", "dividends",
                                                               "events", "strategy", "signals"}
    assert cov["news"]["ok"] is False and "503" in cov["news"]["note"]
    assert cov["short"]["ok"] is True


RECORDED = ["DRO", "BHP", "CBA", "TLX"]
EIGHT_CHECKS = {"short.pct", "short.pct_latest", "price.close", "results.revenue", "results.net_income",
                "peers.industry_set", "insiders.trades", "news.headlines"}


def recorded_pass(tmp_path, ticker):
    """The pass over a recorded API + MCP pair, offline: (dossier, project dir, report)."""
    d = build_dossier(ticker, fixture_api(ticker), date(2026, 10, 7))
    pd = tmp_path / f"{ticker}-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    (pd / "artifacts/dossier.json").write_text(json.dumps(d))
    return d, pd, run_mcp_pass(pd, fixture_mcp(ticker))


@pytest.mark.parametrize("ticker", RECORDED)
def test_recorded_pass(tmp_path, ticker):
    # The MCP fixtures were recorded 63-81 minutes after the API ones: MCP's short series runs one ASIC day
    # further and its news window has moved. Compared by date, that is agreement, not a defect.
    d, pd, report = recorded_pass(tmp_path, ticker)
    assert json.loads((pd / "artifacts/mcp.json").read_text())["ticker"] == ticker
    ok = {c["tool"] for c in report["calls"] if c["ok"]}
    assert {"get_stock", "get_stock_history"} <= ok, report["calls"]
    assert {c["check"] for c in report["parity"]} == EIGHT_CHECKS
    assert all(c["ok"] for c in report["parity"]), [c for c in report["parity"] if not c["ok"]]


def test_a_newer_mcp_series_agrees_and_says_how_far_it_runs(tmp_path):
    d, _, report = recorded_pass(tmp_path, "DRO")
    by = {c["check"]: c for c in report["parity"]}
    as_at = d["short"]["pct"]["as_at"]
    assert by["short.pct"]["ok"] and "MCP's series runs to 2026-10-02" in by["short.pct"]["detail"]
    assert by["short.pct"]["mcp"]["date"] == as_at  # compared on the dossier's own date, not on MCP's newest
    assert by["short.pct_latest"]["ok"] and "MCP's own newest point" in by["short.pct_latest"]["detail"]


def _history(raw):
    return raw["get_stock_history"]["points"]


def _wrong_value_on_the_dossier_date(raw, d):
    for p in _history(raw):
        if p["date"] == d["short"]["pct"]["as_at"]:
            p["short_percent"] += 0.01


def _series_stops_before_the_dossier_date(raw, d):
    raw["get_stock_history"]["points"] = [p for p in _history(raw) if p["date"] < d["short"]["pct"]["as_at"]]


def _get_stock_far_from_both_series(raw, d):
    raw["get_stock"]["percent_shorted"] = 14.0


def _wrong_close_on_the_dossier_date(raw, d):
    for p in raw["get_stock_prices"]["points"]:
        if p["date"] == d["price"]["close"]["as_at"]:
            p["close"] += 0.01


def _headline_swapped_in_the_middle(raw, d):
    raw["get_stock_news"]["articles"][5]["headline"] = "A headline the API never served"


def _no_headline_in_common(raw, d):
    for i, article in enumerate(raw["get_stock_news"]["articles"]):
        article["headline"] = f"other {i}"


def _empty_mcp_news(raw, d):
    raw["get_stock_news"]["articles"] = []


ADVERSARIAL = [
    (_wrong_value_on_the_dossier_date, {"short.pct"}),
    (_series_stops_before_the_dossier_date, {"short.pct", "short.pct_latest"}),
    (_get_stock_far_from_both_series, {"short.pct_latest"}),
    (_wrong_close_on_the_dossier_date, {"price.close"}),
    (_headline_swapped_in_the_middle, {"news.headlines"}),
    (_no_headline_in_common, {"news.headlines"}),
    (_empty_mcp_news, {"news.headlines"}),
]


@pytest.mark.parametrize("mutate,expected", ADVERSARIAL, ids=[m.__name__.strip("_") for m, _ in ADVERSARIAL])
def test_a_real_disagreement_is_still_flagged_on_the_skewed_pair(tmp_path, mutate, expected):
    d, _, report = recorded_pass(tmp_path, "DRO")
    raw = copy.deepcopy(report["raw"])
    mutate(raw, d)
    assert {c["check"] for c in parity(d, raw) if not c["ok"]} == expected


def test_an_mcp_series_that_stops_before_the_dossier_date_is_behind_the_api(tmp_path):
    d, _, report = recorded_pass(tmp_path, "DRO")
    raw = copy.deepcopy(report["raw"])
    _series_stops_before_the_dossier_date(raw, d)
    c = next(c for c in parity(d, raw) if c["check"] == "short.pct")
    assert not c["ok"] and "MCP is behind the API" in c["detail"]


def test_no_point_on_the_dossier_date_fails_even_when_mcp_runs_past_it(tmp_path):
    d, _, report = recorded_pass(tmp_path, "DRO")
    raw = copy.deepcopy(report["raw"])
    as_at = d["short"]["pct"]["as_at"]
    raw["get_stock_history"]["points"] = [p for p in _history(raw) if p["date"] != as_at]
    c = next(c for c in parity(d, raw) if c["check"] == "short.pct")
    assert not c["ok"] and f"no point dated {as_at}" in c["detail"] and "behind" not in c["detail"]


def test_a_newer_mcp_price_session_still_agrees(tmp_path):
    d, _, report = recorded_pass(tmp_path, "DRO")
    raw = copy.deepcopy(report["raw"])
    last = raw["get_stock_prices"]["points"][-1]
    raw["get_stock_prices"]["points"].append({**last, "date": "2026-10-09", "close": round(last["close"] * 1.03, 4)})
    c = next(c for c in parity(d, raw) if c["check"] == "price.close")
    assert c["ok"] and "MCP's series runs to 2026-10-09" in c["detail"]


@pytest.mark.parametrize("tool,check", [("get_stock_history", "short.pct"), ("get_stock_prices", "price.close")])
def test_an_empty_mcp_series_is_a_failed_check_never_a_skip(tool, check):
    raw = copy.deepcopy(RAW)
    raw[tool] = {"points": []}
    c = {c["check"]: c for c in parity(DOSSIER, raw)}[check]
    assert c["ok"] is False and "empty" in c["detail"]


def test_get_stock_without_a_percent_is_a_failed_check():
    raw = copy.deepcopy(RAW)
    raw["get_stock"] = {"code": "DRO"}
    c = {c["check"]: c for c in parity(DOSSIER, raw)}["short.pct_latest"]
    assert c["ok"] is False and "percent_shorted" in c["detail"]


def test_a_failed_call_is_a_coverage_finding_not_a_parity_one():
    raw = copy.deepcopy(RAW)
    del raw["get_stock_history"]  # run_mcp_pass leaves a tool that raised out of raw; `calls` and `coverage` carry it
    assert "short.pct" not in {c["check"] for c in parity(DOSSIER, raw)}


H = [f"h{i}" for i in range(12)]


def news_check(api_headlines, mcp_headlines):
    d = copy.deepcopy(DOSSIER)
    d["raw"]["GetStockNews"] = {"articles": [{"headline": h} for h in api_headlines]}
    raw = copy.deepcopy(RAW)
    raw["get_stock_news"] = {"articles": [{"headline": h} for h in mcp_headlines]}
    return next(c for c in parity(d, raw) if c["check"] == "news.headlines")


@pytest.mark.parametrize("api,mcp,ok", [
    (H, H, True),                                  # identical
    (H, ["new"] + H[:-1], True),                   # one landed; the oldest dropped off MCP's top 12
    (H, ["n1", "n2", "n3"] + H[:-3], True),        # three landed
    (H, H[:5] + ["x"] + H[6:], False),             # a headline swapped in the middle is not a window move
    (H, ["new"] + H[1:], False),                   # the API holds a newer headline MCP lacks: MCP is behind
    (H, [f"o{i}" for i in range(12)], False),      # no headline in common
    (H, [], False),                                # MCP's list is empty
    ([], H, False),                                # the API's list is empty
    ([], [], False),                               # no headline is shared, so it fails (the controller's ruling)
])
def test_news_passes_only_when_the_lists_differ_at_their_window_edges(api, mcp, ok):
    assert news_check(api, mcp)["ok"] is ok


def test_a_moved_news_window_says_so():
    assert "window moved" in news_check(H, ["new"] + H[:-1])["detail"]


@pytest.mark.parametrize("api,mcp,said", [
    (H, [], "MCP's news list is empty (the API's has 12)"),
    ([], H, "the API's news list is empty (MCP's has 12)"),
    ([], [], "both news lists are empty"),
])
def test_an_empty_news_list_says_which_side_is_empty(api, mcp, said):
    check = news_check(api, mcp)
    assert check["ok"] is False and check["detail"] == said


def _last(raw, tool):
    return raw[tool]["points"][-1]


DRIFTED = [
    # (id, mutate(raw), the check that must fail, prefix of its exception detail or None when it fails without one)
    ("short_percent-null", lambda r: _last(r, "get_stock_history").update(short_percent=None), "short.pct", "TypeError"),
    ("short_percent-text", lambda r: _last(r, "get_stock_history").update(short_percent="n/a"), "short.pct", "ValueError"),
    ("history-point-without-a-date", lambda r: _last(r, "get_stock_history").pop("date"), "short.pct", None),
    ("close-text", lambda r: _last(r, "get_stock_prices").update(close="n/a"), "price.close", "ValueError"),
    ("shares_traded-with-a-comma",
     lambda r: r["get_director_trades"]["trades"][0].update(shares_traded="1,000"), "insiders.trades", "ValueError"),
]


@pytest.mark.parametrize("mutate,check,prefix", [d[1:] for d in DRIFTED], ids=[d[0] for d in DRIFTED])
def test_a_payload_a_check_cannot_read_fails_that_check_only(mutate, check, prefix):
    raw = copy.deepcopy(RAW)
    mutate(raw)
    checks = {c["check"]: c for c in parity(DOSSIER, raw)}  # must not raise
    assert checks[check]["ok"] is False
    if prefix:
        assert checks[check]["detail"].startswith(prefix + ":")
        assert checks[check]["dossier"] is None and checks[check]["mcp"] is None
    assert [c for n, c in checks.items() if n != check and not c["ok"]] == []  # one drifted field hides none of the rest


class FakeMCP:
    """A client whose every call succeeds, so only the payload can be wrong."""

    def __init__(self, raw):
        self.raw = raw

    def call(self, tool, arguments):
        return copy.deepcopy(self.raw.get(tool, {})), None


def project_with(tmp_path, dossier):
    pd = tmp_path / "DRO-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier))
    return pd


def test_a_drifted_reply_is_recorded_and_mcp_json_is_still_written(tmp_path):
    raw = copy.deepcopy(RAW)
    raw["get_stock_history"]["points"][-1] = {"date": "2026-09-30", "unit": "pct"}  # no short_percent
    pd = project_with(tmp_path, DOSSIER)
    run_mcp_pass(pd, FakeMCP(raw))
    written = json.loads((pd / "artifacts/mcp.json").read_text())
    assert set(written) == {"ticker", "calls", "parity", "coverage", "extras", "raw"}
    by = {c["check"]: c for c in written["parity"]}
    assert by["short.pct"]["ok"] is False and by["short.pct"]["detail"] == "KeyError: 'short_percent'"
    assert [n for n, c in by.items() if n != "short.pct" and not c["ok"]] == []


def test_a_call_that_raises_something_unexpected_is_a_failed_call_not_a_crash(tmp_path):
    class Broken:
        def call(self, tool, arguments):
            if tool == "get_stock_news":
                raise AttributeError("'list' object has no attribute 'get'")
            return copy.deepcopy(RAW.get(tool, {})), None

    pd = project_with(tmp_path, DOSSIER)
    report = run_mcp_pass(pd, Broken())
    failed = [c for c in report["calls"] if not c["ok"]]
    assert [c["tool"] for c in failed] == ["get_stock_news"] and failed[0]["error"].startswith("AttributeError:")
    assert (pd / "artifacts/mcp.json").exists()
    assert "news.headlines" not in {c["check"] for c in report["parity"]}


def test_extras_for_dro_counts_one_politician(tmp_path):
    _, _, report = recorded_pass(tmp_path, "DRO")
    pol = extras(report["raw"])["politicians"]
    assert pol["count"] == 1 and pol["declarations"][0]["name"] == "Warren Entsch"
    assert report["extras"] == extras(report["raw"])


def test_extras_without_politicians_or_with_a_payload_it_cannot_read():
    assert extras({}) == {"politicians": None}
    drifted = extras({"list_stock_politicians": ["not", "a", "dict"]})
    assert drifted["politicians"] is None and drifted["error"].startswith("AttributeError:")


def test_the_tool_runs_offline_on_a_recorded_pair(tmp_path, monkeypatch):
    d = build_dossier("DRO", fixture_api("DRO"), date(2026, 10, 7))
    pd = project_with(tmp_path, d)
    monkeypatch.setattr(mcp_pass_module, "ShortedMCP", lambda: fixture_mcp("DRO"))
    result = ShortedMcpPass().execute({"project_dir": str(pd)})
    assert result.success and result.data["mismatches"] == []
    assert set(result.data["not_served"]) == {"results.filing", "results.guidance", "dividends", "events",
                                              "strategy", "signals"}
    assert result.artifacts == [str(pd / "artifacts" / "mcp.json")]


def mcp_reply(id_, result):
    return 200, {"Content-Type": "application/json"}, json.dumps({"jsonrpc": "2.0", "id": id_, "result": result}).encode()


def test_a_reply_without_structured_content_falls_back_to_the_text():
    def transport(url, headers, data):
        return mcp_reply(json.loads(data)["id"], {"content": [{"type": "text", "text": '{"code": "DRO"}'}]})

    mcp = ShortedMCP(url="https://x/mcp", token="", transport=transport, min_interval=0)
    assert mcp.call("get_stock", {"code": "DRO"})[0] == {"code": "DRO"}


def test_a_reply_with_neither_structured_content_nor_json_text_raises():
    def transport(url, headers, data):
        return mcp_reply(json.loads(data)["id"], {"content": [{"type": "text", "text": "Stock DRO: 14.9% short"}]})

    mcp = ShortedMCP(url="https://x/mcp", token="", transport=transport, min_interval=0)
    with pytest.raises(McpError, match="no structured content"):
        mcp.call("get_stock", {"code": "DRO"})


def test_the_event_stream_reader_skips_messages_for_other_requests():
    stream = (b'event: message\ndata: {"jsonrpc": "2.0", "method": "notifications/message", "params": {}}\n\n'
              b'event: message\ndata: {"jsonrpc": "2.0", "id": 99, "result": {"x": 1}}\n\n'
              b'event: message\ndata: {"jsonrpc": "2.0", "id": 7, "result": {"x": 2}}\n\n')
    assert read_reply(stream, "text/event-stream", 7)["result"] == {"x": 2}
    with pytest.raises(ValueError, match="no JSON-RPC response"):
        read_reply(stream, "text/event-stream", 8)


CHALLENGE = {"WWW-Authenticate": 'Bearer error="invalid_token", resource_metadata="x"'}


@pytest.mark.parametrize("token,headers", [("expired-token", CHALLENGE), ("", {}), ("expired-token", {})],
                         ids=["token-with-challenge", "anonymous-without-challenge", "token-without-challenge"])
def test_a_401_that_is_not_an_anonymous_ceiling_is_not_retried(token, headers):
    clock, attempts = Clock(), []

    def transport(url, headers_, data):
        attempts.append(1)
        return 401, headers, b"unauthorized"

    mcp = ShortedMCP(url="https://x/mcp", token=token, transport=transport, sleep=clock.sleep,
                     monotonic=clock.monotonic, min_interval=0)
    with pytest.raises(McpError) as err:
        mcp.call("get_stock", {"code": "DRO"})
    assert err.value.status == 401 and len(attempts) == 1 and clock.slept == []


def test_the_transport_gives_up_after_30_seconds(monkeypatch):
    seen = {}

    class Opener:
        def open(self, req, timeout=None):
            seen["timeout"] = timeout
            raise socket.timeout("timed out")

    monkeypatch.setattr(mcp_module, "_OPENER", Opener())
    status, _, body = mcp_module._urllib_transport("https://x/mcp", {}, b"{}")
    assert seen["timeout"] == 30 and status == mcp_module.NETWORK_ERROR and b"timed out" in body


def test_replay_refuses_arguments_that_were_not_recorded():
    mcp = fixture_mcp("DRO")
    with pytest.raises(pytest.fail.Exception, match="re-record"):
        mcp.call("get_stock_history", {"code": "DRO", "period": "6M", "full_resolution": True})
    with pytest.raises(pytest.fail.Exception, match="re-record"):
        mcp.call("get_a_tool_nobody_recorded", {"code": "DRO"})
    data, _ = mcp.call(*mcp_calls("DRO")[0])  # the recorded arguments still replay
    assert data["code"] == "DRO"


def test_a_stale_fixture_fails_the_recorded_pass_loudly(tmp_path, monkeypatch):
    # run_mcp_pass records ordinary exceptions as failed calls, so a replay mismatch raised as one would pass quietly
    monkeypatch.setattr(mcp_pass_module, "mcp_calls", lambda t: [("get_stock", {"code": t, "limit": 99})])
    d = build_dossier("DRO", fixture_api("DRO"), date(2026, 10, 7))
    pd = project_with(tmp_path, d)
    with pytest.raises(pytest.fail.Exception, match="re-record"):
        run_mcp_pass(pd, fixture_mcp("DRO"))


def load_recorder():
    path = Path(__file__).resolve().parents[2] / "scripts/shorted/record_mcp_fixtures.py"
    spec = importlib.util.spec_from_file_location("record_mcp_fixtures", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeRecorderMCP:
    """Answers every tool, except the ones named in `failing` (a 503 each)."""

    def __init__(self, failing=()):
        self.failing = set(failing)

    def call(self, tool, arguments):
        if tool in self.failing:
            raise McpError(tool, "HTTP 503: down", 503)
        return {"tool": tool, "fresh": True}, Source(f"mcp:{tool}", arguments, "2026-10-08T00:00:00+00:00")


def test_the_recorder_records_every_alias(tmp_path, monkeypatch):
    rec = load_recorder()
    (tmp_path / "aliases.json").write_text(json.dumps({"no_filing": "DRO", "with_filing": "TLX"}))
    monkeypatch.setattr(rec, "OUT", tmp_path)
    seen = []
    monkeypatch.setattr(rec, "record", lambda mcp, ticker: seen.append(ticker))
    rec.main(["bhp", "DRO", "BHP"])
    assert seen == ["BHP", "DRO", "TLX"]  # what was asked for (once each), then every alias not already asked for


def test_a_failed_recording_never_replaces_an_ok_fixture(tmp_path, monkeypatch, capsys):
    rec = load_recorder()
    monkeypatch.setattr(rec, "OUT", tmp_path)
    d = tmp_path / "DRO" / "mcp"
    d.mkdir(parents=True)
    good = {"ok": True, "arguments": {"code": "DRO"}, "result": {"keep": "me"}, "fetched_at": "2026-10-07T00:00:00+00:00"}
    (d / "get_stock.json").write_text(json.dumps(good))
    old_failure = {"ok": False, "arguments": {}, "error": "old failure", "fetched_at": None}
    (d / "get_stock_details.json").write_text(json.dumps(old_failure))
    (d / "get_stock_prices.json").write_text(json.dumps(good))
    rec.record(FakeRecorderMCP(failing={"get_stock", "get_stock_details", "get_stock_history"}), "DRO")
    out = capsys.readouterr().out

    assert json.loads((d / "get_stock.json").read_text()) == good  # a transient 503 must not cost a good fixture
    assert "get_stock: kept" in out
    details = json.loads((d / "get_stock_details.json").read_text())
    assert details["ok"] is False and "503" in details["error"]  # an old failure is replaced by the new one
    assert json.loads((d / "get_stock_history.json").read_text())["ok"] is False  # a first failure is still recorded
    prices = json.loads((d / "get_stock_prices.json").read_text())
    assert prices["ok"] is True and prices["result"]["fresh"] is True  # a success replaces an old fixture
    assert len(list(d.glob("*.json"))) == len(mcp_calls("DRO"))
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_mcp.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.mcp'`.

- [ ] **Step 3: Implement `mcp.py`**

```python
"""Shorted's MCP server as a data source: JSON-RPC `tools/call` over streamable HTTP.

The server (https://api.shorted.com.au/mcp) is stateless, so no initialize handshake is needed, and
a reply arrives as JSON or as a server-sent-event stream; both are read. Anonymous access is the
default and allows 30 calls a minute per address, so calls are paced under that. An anonymous
caller at its ceiling gets a 401 with a WWW-Authenticate challenge (an authenticated one, a 429);
both are backed off and retried. A 401 to a caller that sent a token is a rejected credential, not a
ceiling, and is not retried. SHORTED_MCP_TOKEN, when set, is sent as a bearer token.
"""

from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Optional

from tools.shorted.values import Source

MAX_RETRY_AFTER = 120.0  # a monthly-quota 429 says "come back next month"; never sleep that long
TIMEOUT_SECONDS = 30  # healthy calls answer in 0.1-2 s; a stalled one is cut off and retried (reads are idempotent)
MCP_URL = "https://api.shorted.com.au/mcp"
USER_AGENT = "shorted-studio/1.0 (+https://shorted.com.au)"
NETWORK_ERROR = 599  # a timeout or a dropped connection, reported as a status so it can be retried
Transport = Callable[[str, dict, bytes], tuple[int, dict, bytes]]


class McpError(RuntimeError):
    def __init__(self, tool: str, message: str, status: int = 0):
        super().__init__(f"{tool}: {message}")
        self.tool, self.status = tool, status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a 3xx is an error here: never replay the request, or its token, elsewhere


_OPENER = urllib.request.build_opener(_NoRedirect)


def _urllib_transport(url: str, headers: dict, data: bytes) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        try:
            with _OPENER.open(req, timeout=TIMEOUT_SECONDS) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers or {}), err.read()
    except (OSError, http.client.HTTPException) as err:  # timeouts, resets, TLS errors, truncated bodies
        return NETWORK_ERROR, {}, str(err).encode()


def read_reply(raw: bytes, content_type: str, want_id: int) -> dict:
    """The JSON-RPC response with id want_id, from a JSON body or a server-sent-event stream."""
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" not in content_type:
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            msg = json.loads(line[5:].strip())
            if msg.get("id") == want_id:
                return msg
    raise ValueError("no JSON-RPC response in the event stream")


class ShortedMCP:
    def __init__(self, url: Optional[str] = None, token: Optional[str] = None, transport: Optional[Transport] = None,
                 sleep: Callable[[float], None] = time.sleep, monotonic: Callable[[], float] = time.monotonic,
                 clock: Optional[Callable[[], datetime]] = None, min_interval: float = 2.2, max_retries: int = 3):
        self.url = url or os.environ.get("SHORTED_MCP_URL") or MCP_URL
        self.token = (os.environ.get("SHORTED_MCP_TOKEN", "") if token is None else token).strip()
        self.transport = transport or _urllib_transport
        self.sleep, self.monotonic = sleep, monotonic
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.min_interval, self.max_retries = min_interval, max_retries
        self._id = 0
        self._last: Optional[float] = None

    def headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": USER_AGENT}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    @staticmethod
    def _delay(retry_after: Optional[str], attempt: int, limited: bool) -> float:
        try:
            delay = float(retry_after) if retry_after else None
        except ValueError:
            delay = None
        if delay is None or delay != delay:  # absent, unparseable or NaN
            delay = 10.0 * (attempt + 1) if limited else 2.0 ** attempt
        return min(max(delay, 0.0), MAX_RETRY_AFTER)

    def _pace(self) -> None:
        if self._last is not None:
            wait = self.min_interval - (self.monotonic() - self._last)
            if wait > 0:
                self.sleep(wait)

    def call(self, tool: str, arguments: dict) -> tuple[dict, Source]:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                           "params": {"name": tool, "arguments": arguments}}).encode()
        status, headers, raw = 0, {}, b""
        for attempt in range(self.max_retries + 1):
            self._pace()
            status, headers, raw = self.transport(self.url, self.headers(), body)
            self._last = self.monotonic()
            headers = {k.lower(): v for k, v in headers.items()}
            limited = status == 429 or (status == 401 and not self.token and "www-authenticate" in headers)
            if (limited or status in (502, 503, 504, NETWORK_ERROR)) and attempt < self.max_retries:
                self.sleep(self._delay(headers.get("retry-after"), attempt, limited))
                continue
            break
        if status != 200:
            raise McpError(tool, f"HTTP {status}: {raw.decode(errors='replace')[:300]}", status)
        reply = read_reply(raw, headers.get("content-type", ""), self._id)
        if "error" in reply:
            raise McpError(tool, reply["error"].get("message", "JSON-RPC error"), status)
        result = reply.get("result") or {}
        text = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise McpError(tool, text[:300] or "tool error", status)
        data = result.get("structuredContent")
        if data is None:
            try:
                data = json.loads(text)
            except ValueError:
                raise McpError(tool, "the tool returned no structured content", status) from None
        return data, Source(f"mcp:{tool}", arguments, self.clock().isoformat(timespec="seconds"))
```

- [ ] **Step 4: Implement `mcp_pass.py`**

```python
"""The MCP pass: read the ticker through Shorted's MCP server the way an AI client does, then check it
against the dossier.

1. Parity. The same figures through two product surfaces (the Connect API the dossier reads, and
   MCP) must agree; a disagreement is a Shorted defect and becomes a `surface_mismatch` gap.
   The two reads are minutes apart, so each figure is compared on the dossier's own date, not on
   each surface's newest point: a load that lands between the reads (a new ASIC day, a new price
   session, a new article) is not a defect. MCP running ahead passes, with the lead in `detail`;
   MCP behind the API, a missing date, a wrong value and an empty reply fail.
2. Coverage. Which dossier sections an MCP client can get at all. A section with no MCP tool is an
   `mcp_gap`: Claude or ChatGPT on the Shorted connector could not make this video.
3. Extras. What MCP offers that no scene uses yet (politicians' declared holdings).

Nothing here blocks a run. A failed call, a payload a check cannot read and an unexpected exception
are all recorded (the check or the call fails; nothing is raised), and artifacts/mcp.json is always
written; reflection reads it.
"""

from __future__ import annotations

import json
from functools import partial
from pathlib import Path

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolRuntime, ToolTier
from tools.shorted.mcp import McpError, ShortedMCP

MCP_COVERAGE = {  # dossier section -> (the MCP tool serving it, or None and why not)
    "company": ("get_stock_details", None),
    "short": ("get_stock_history", None),
    "price": ("get_stock_prices", None),
    "results": ("get_stock_fundamentals", None),
    "results.filing": (None, "get_stock_fundamentals has no latest filing (title, date, digest)"),
    "results.guidance": (None, "no MCP tool returns filing highlights or guidance"),
    "dividends": (None, "no MCP tool returns dividend history"),
    "news": ("get_stock_news", None),
    "events": (None, "no MCP tool returns the event timeline"),
    "insiders": ("get_director_trades", None),
    "peers": ("get_peer_comparison", None),
    "strategy": (None, "list_strategies and get_strategy_picks rank picks; no tool gives one stock's fit"),
    "signals": (None, "no MCP tool returns stock signals"),
}
PCT_TOL = 1e-4      # two surfaces over one table agree to float noise
PRICE_TOL = 0.0005  # dollars
MONEY_REL_TOL = 0.005


def mcp_calls(t: str) -> list[tuple[str, dict]]:
    return [
        ("get_stock", {"code": t}),
        ("get_stock_details", {"code": t}),
        ("get_stock_history", {"code": t, "period": "1Y", "full_resolution": True}),
        ("get_stock_prices", {"code": t, "period": "1Y", "max_points": 400}),
        ("get_stock_fundamentals", {"code": t, "limit": 12}),
        ("get_peer_comparison", {"code": t, "limit": 8}),
        ("get_director_trades", {"code": t, "limit": 20}),
        ("get_stock_news", {"code": t, "limit": 12}),
        ("list_stock_politicians", {"code": t, "current_only": True}),
    ]


def _val(d: dict, path: str) -> dict:
    section, field = path.split(".")
    return (d.get(section) or {}).get(field) or {}


def _ok(v: dict) -> bool:
    return v.get("trust") in ("ok", "stale") and v.get("value") not in (None, [], {})


def _record(check: str, ok: bool, dossier, mcp, detail: str = "") -> dict:
    return {"check": check, "ok": bool(ok), "dossier": dossier, "mcp": mcp, "detail": detail}


def _day(point) -> str:
    """The ISO date of a series point, or "" for a point without one."""
    return str(point.get("date") or "")[:10] if isinstance(point, dict) else ""


def _newest(points: list) -> str | None:
    return max((day for day in map(_day, points) if day), default=None)


def _point_at(points: list, day: str):
    return next((p for p in points if _day(p) == day), None)


def _by_date(check: str, value, as_at: str, points: list, field: str, tol: float, what: str) -> list[dict]:
    """One dossier figure against the MCP series point dated at the dossier's own date.

    The surfaces are read minutes apart, so a load landing between the two reads (a new ASIC day, a new
    price session) must not look like a defect: MCP running ahead passes, with the lead in `detail`. MCP
    behind the API, no point on that date, an empty series and a wrong value all fail."""
    mine = {"value": value, "as_at": as_at}
    if not points:
        return [_record(check, False, mine, None, f"MCP returned an empty {what} series")]
    newest = _newest(points)
    at = _point_at(points, as_at)
    if at is None:
        if newest is None:
            why = "its points carry no date"
        elif newest < as_at:
            why = f"its newest is {newest}: MCP is behind the API"
        else:
            why = f"it has points up to {newest} but not that day"
        return [_record(check, False, mine, {"newest": newest}, f"MCP has no point dated {as_at} in its {what} series; {why}")]
    lead = f"MCP's series runs to {newest}, after the dossier's {as_at}" if newest > as_at else ""
    return [_record(check, abs(float(at[field]) - float(value)) <= tol, mine, {"value": at[field], "date": at["date"]}, lead)]


def _check_short_pct(d: dict, raw: dict) -> list[dict]:
    pct = _val(d, "short.pct")
    if not _ok(pct) or "get_stock_history" not in raw:  # a call that failed is in `calls` and `coverage`, not here
        return []
    points = (raw["get_stock_history"] or {}).get("points") or []
    return _by_date("short.pct", pct["value"], pct["as_at"], points, "short_percent", PCT_TOL, "short")


def _check_short_latest(d: dict, raw: dict) -> list[dict]:
    pct = _val(d, "short.pct")
    if not _ok(pct) or "get_stock" not in raw:
        return []
    shown = (raw["get_stock"] or {}).get("percent_shorted")
    if shown is None:
        return [_record("short.pct_latest", False, pct["value"], None, "get_stock returned no percent_shorted")]
    points = (raw.get("get_stock_history") or {}).get("points") or []
    newest = _newest(points)
    if newest is not None and newest > pct["as_at"]:
        # get_stock carries no date. MCP's series runs ahead of the dossier, so its own newest point is the
        # like-for-like figure; with both series ending on the same day it is the dossier's value
        ref = _point_at(points, newest)["short_percent"]
        against = f"MCP's own newest point ({newest}: {ref}); MCP's series runs ahead of the dossier's {pct['as_at']}"
    else:
        ref, against = pct["value"], f"the dossier's value ({pct['as_at']})"
    return [_record("short.pct_latest", abs(float(shown) - float(ref)) <= PCT_TOL, pct["value"], shown,
                    f"get_stock's current percent against {against}")]


def _check_price_close(d: dict, raw: dict) -> list[dict]:
    close = _val(d, "price.close")
    if not _ok(close) or "get_stock_prices" not in raw:
        return []
    points = (raw["get_stock_prices"] or {}).get("points") or []
    return _by_date("price.close", close["value"], close["as_at"], points, "close", PRICE_TOL, "price")


def _period_row(d: dict, raw: dict):
    """(the dossier's period value, MCP's row for it or None), or None when there is nothing to compare."""
    period = _val(d, "results.period")
    fund = raw.get("get_stock_fundamentals") or {}
    if not _ok(period) or not fund:
        return None
    end, ptype = period["value"]["end"], period["value"]["type"]
    row = next((r for r in fund.get("periods", []) if r.get("period_end") == end and r.get("period_type") == ptype), None)
    return period, row


def _check_results_period(d: dict, raw: dict) -> list[dict]:
    found = _period_row(d, raw)
    if found is None or found[1] is not None:
        return []
    return [_record("results.period", False, found[0]["value"], None, "MCP returns no row for the dossier's period")]


def _check_money(field: str, d: dict, raw: dict) -> list[dict]:
    found = _period_row(d, raw)
    if found is None or found[1] is None:
        return []
    dv, mv = _val(d, f"results.{field}"), found[1].get(field)
    if not _ok(dv) and mv is None:
        return []
    same = _ok(dv) and mv is not None and \
        abs(float(mv) - float(dv["value"])) <= MONEY_REL_TOL * max(1.0, abs(float(dv["value"])))
    return [_record(f"results.{field}", same, dv.get("value"), mv)]


def _check_peers(d: dict, raw: dict) -> list[dict]:
    api = d.get("raw") or {}
    if not (api.get("GetPeerComparison") and raw.get("get_peer_comparison")):
        return []
    a = sorted(p["stockCode"] for p in api["GetPeerComparison"].get("peers", []) if p.get("stockCode"))
    b = sorted(p["code"] for p in raw["get_peer_comparison"].get("peers", []) if p.get("code"))
    return [_record("peers.industry_set", a == b, a, b)]


def _check_insiders(d: dict, raw: dict) -> list[dict]:
    api = d.get("raw") or {}
    if api.get("GetDirectorTrades") is None or raw.get("get_director_trades") is None:
        return []
    a = sorted((t.get("tradeDate"), (t.get("tradeType") or "").lower(), int(t.get("sharesTraded") or 0))
               for t in api["GetDirectorTrades"].get("trades", []))
    b = sorted((t.get("date"), (t.get("trade_type") or "").lower(), int(t.get("shares_traded") or 0))
               for t in raw["get_director_trades"].get("trades", []))
    first = next(((x, y) for x, y in zip(a, b) if x != y), None)
    return [_record("insiders.trades", a == b, len(a), len(b), f"first difference: {first}" if first else "")]


def _window_moved(api: list[str], mcp: list[str], shared: set[str]) -> bool:
    """Both lists run newest first. Their top-N windows moved against each other when every API-only headline
    sits after every shared one on the API list and every MCP-only headline sits before every shared one on
    MCP's: new articles entered MCP's window, the oldest left it."""
    last_shared_api = max(i for i, h in enumerate(api) if h in shared)
    first_shared_mcp = min(i for i, h in enumerate(mcp) if h in shared)
    return (all(i > last_shared_api for i, h in enumerate(api) if h not in shared)
            and all(i < first_shared_mcp for i, h in enumerate(mcp) if h not in shared))


def _check_news(d: dict, raw: dict) -> list[dict]:
    api = d.get("raw") or {}
    if api.get("GetStockNews") is None or "get_stock_news" not in raw:
        return []
    la = [h for h in (x.get("headline") for x in api["GetStockNews"].get("articles", [])) if h]
    lb = [h for h in (x.get("headline") for x in (raw["get_stock_news"] or {}).get("articles", [])) if h]
    if not la or not lb:
        who = "both news lists are empty" if not la and not lb else \
            f"MCP's news list is empty (the API's has {len(la)})" if not lb else \
            f"the API's news list is empty (MCP's has {len(lb)})"
        return [_record("news.headlines", False, len(la), len(lb), who)]
    shared = set(la) & set(lb)
    if not shared:
        return [_record("news.headlines", False, len(la), len(lb), f"no headline in common ({len(la)} API, {len(lb)} MCP)")]
    api_only, mcp_only = [h for h in la if h not in shared], [h for h in lb if h not in shared]
    if not api_only and not mcp_only:
        return [_record("news.headlines", True, len(la), len(lb))]
    if _window_moved(la, lb, shared):
        return [_record("news.headlines", True, len(la), len(lb),
                        f"the top-{len(la)} window moved between the reads: {len(api_only)} only on the API list, at its end; "
                        f"{len(mcp_only)} only on MCP's, at its start")]
    first = (f"; first API-only: {api_only[0][:80]!r}" if api_only else "") + \
        (f"; first MCP-only: {mcp_only[0][:80]!r}" if mcp_only else "")
    return [_record("news.headlines", False, len(la), len(lb),
                    f"{len(api_only)} API-only and {len(mcp_only)} MCP-only headlines, and not only at the window edges{first}")]


_CHECKS = (
    ("short.pct", _check_short_pct),
    ("short.pct_latest", _check_short_latest),
    ("price.close", _check_price_close),
    ("results.period", _check_results_period),
    ("results.revenue", partial(_check_money, "revenue")),
    ("results.net_income", partial(_check_money, "net_income")),
    ("peers.industry_set", _check_peers),
    ("insiders.trades", _check_insiders),
    ("news.headlines", _check_news),
)


def parity(d: dict, raw: dict) -> list[dict]:
    """Every dossier figure MCP can serve, checked against MCP's reply. One guard per check: a payload a check
    cannot read (a drifted field, a wrong type) is a finding about MCP, so it fails that check and is recorded
    with the exception, and the other checks still run."""
    out: list[dict] = []
    for name, check in _CHECKS:
        try:
            out.extend(check(d, raw))
        except Exception as err:
            out.append(_record(name, False, None, None, f"{type(err).__name__}: {err}"))
    return out


def coverage(calls: list[dict]) -> list[dict]:
    failed = {c["tool"]: c.get("error") for c in calls if not c["ok"]}
    return [{"section": section, "tool": tool, "ok": tool is not None and tool not in failed,
             "note": note if tool is None else failed.get(tool)}
            for section, (tool, note) in MCP_COVERAGE.items()]


def extras(raw: dict) -> dict:
    try:
        pol = raw.get("list_stock_politicians")
        if pol is None:
            return {"politicians": None}
        keep = ("name", "chamber", "party", "holder", "declared_from")
        return {"politicians": {"count": pol.get("politician_count", 0), "party_counts": pol.get("party_counts", []),
                                "declarations": [{k: r.get(k) for k in keep} for r in pol.get("declarations", [])][:20],
                                "source": pol.get("source"), "note": pol.get("note")}}
    except Exception as err:  # a payload it cannot read is recorded, never raised
        return {"politicians": None, "error": f"{type(err).__name__}: {err}"}


def run_mcp_pass(project_dir: Path, mcp: ShortedMCP) -> dict:
    art = Path(project_dir) / "artifacts"
    d = json.loads((art / "dossier.json").read_text())
    raw, calls = {}, []
    for tool, args in mcp_calls(d["ticker"]):
        try:
            raw[tool], _ = mcp.call(tool, args)
            calls.append({"tool": tool, "ok": True})
        except Exception as err:  # recorded: a failed tool is a coverage finding, whichever way it failed
            message = str(err) if isinstance(err, McpError) else f"{type(err).__name__}: {err}"
            calls.append({"tool": tool, "ok": False, "status": getattr(err, "status", 0), "error": message[:300]})
    report = {"ticker": d["ticker"], "calls": calls, "parity": parity(d, raw), "coverage": coverage(calls),
              "extras": extras(raw), "raw": raw}
    (art / "mcp.json").write_text(json.dumps(report, indent=1))
    return report


class ShortedMcpPass(BaseTool):
    name = "shorted_mcp_pass"
    version = "1.0.0"
    tier = ToolTier.SOURCE
    runtime = ToolRuntime.API
    capability = "data_research"
    provider = "shorted"
    resource_profile = ResourceProfile(network_required=True)
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        report = run_mcp_pass(Path(inputs["project_dir"]), ShortedMCP())
        mismatches = [c["check"] for c in report["parity"] if not c["ok"]]
        return ToolResult(success=True, data={"mismatches": mismatches,
                                              "not_served": [c["section"] for c in report["coverage"] if c["tool"] is None]},
                          artifacts=[str(Path(inputs["project_dir"]) / "artifacts" / "mcp.json")])
```

- [ ] **Step 5: Record the MCP fixtures (live, outside pytest)**

`scripts/shorted/record_mcp_fixtures.py`:

```python
"""Record Shorted MCP tool responses as test fixtures. Needs the network, so run it OUTSIDE pytest:

    .venv/bin/python scripts/shorted/record_mcp_fixtures.py DRO BHP CBA

Every ticker named in tests/shorted/fixtures/aliases.json (the no-filing and with-filing stocks) is
recorded too, so one command refreshes the whole set. A failed call never replaces a fixture that
recorded OK: the old file is kept and the run says so.

Anonymous calls are paced at one per 2.2 s, so each ticker takes about 20 s.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.shorted.calls import normalise_ticker  # noqa: E402
from tools.shorted.mcp import ShortedMCP  # noqa: E402
from tools.shorted.mcp_pass import mcp_calls  # noqa: E402

OUT = ROOT / "tests/shorted/fixtures"


def recorded_ok(path: Path) -> bool:
    """True when path holds a fixture that recorded OK."""
    try:
        return json.loads(path.read_text()).get("ok") is True
    except (OSError, ValueError, AttributeError):
        return False


def record(mcp: ShortedMCP, ticker: str) -> None:
    t = normalise_ticker(ticker)
    d = OUT / t / "mcp"
    d.mkdir(parents=True, exist_ok=True)
    for tool, args in mcp_calls(t):
        path = d / f"{tool}.json"
        try:
            data, src = mcp.call(tool, args)
            rec = {"ok": True, "arguments": args, "result": data, "fetched_at": src.fetched_at}
        except Exception as err:  # recorded as-is: the pass must cope with failed tools
            if recorded_ok(path):  # a transient failure must not cost a good fixture
                print(f"{t} {tool}: kept the existing ok fixture; the new call failed ({str(err)[:120]})")
                continue
            rec = {"ok": False, "arguments": args, "error": str(err)[:300], "fetched_at": None}
        path.write_text(json.dumps(rec, indent=1))
    print(t, "mcp:", sorted((p.stem, json.loads(p.read_text())["ok"]) for p in d.glob("*.json")))


def main(argv: list[str]) -> None:
    mcp = ShortedMCP()
    tickers = list(dict.fromkeys(normalise_ticker(a) for a in argv))
    aliases = OUT / "aliases.json"
    if aliases.exists():
        for code in json.loads(aliases.read_text()).values():
            if isinstance(code, str) and code.strip() and normalise_ticker(code) not in tickers:
                tickers.append(normalise_ticker(code))
    for t in tickers:
        record(mcp, t)


if __name__ == "__main__":
    main(sys.argv[1:])
```

Run: `.venv/bin/python scripts/shorted/record_mcp_fixtures.py DRO BHP CBA`
Expected: one line per ticker (and the no-filing alias, if it is not already one of them), each listing 9 tools with `True`. A `False` is a finding, not a failure. Record the tool and its error in your report, because it feeds the data-collection notes.

- [ ] **Step 6: Replay the fixtures in tests**

Append to `tests/shorted/conftest.py`:

```python
def fixture_mcp(ticker: str):
    from datetime import datetime, timezone

    from tools.shorted.mcp import ShortedMCP

    d = FIXTURES / ticker / "mcp"
    if not d.exists():
        pytest.skip(f"no recorded MCP fixtures for {ticker}; run scripts/shorted/record_mcp_fixtures.py")

    def transport(url, headers, data):
        req = json.loads(data)
        tool, asked = req["params"]["name"], req["params"]["arguments"]
        path = d / f"{tool}.json"
        # pytest.fail, not an exception: run_mcp_pass records ordinary exceptions as failed calls, which would hide this
        if not path.exists():
            pytest.fail(f"no recorded {tool} fixture for {ticker}; re-record with scripts/shorted/record_mcp_fixtures.py")
        rec = json.loads(path.read_text())
        if rec.get("arguments") != asked:
            pytest.fail(f"{ticker}/{tool} was recorded with {rec.get('arguments')} but is now asked for {asked}; "
                        "re-record with scripts/shorted/record_mcp_fixtures.py")
        if rec["ok"]:
            msg = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [], "structuredContent": rec["result"]}}
        else:
            msg = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": rec["error"]}}
        return 200, {"Content-Type": "application/json"}, json.dumps(msg).encode()

    return ShortedMCP(url="https://fixtures.invalid/mcp", token="", transport=transport, sleep=lambda s: None,
                      min_interval=0, clock=lambda: datetime(2026, 10, 7, tzinfo=timezone.utc))
```

- [ ] **Step 7: Run the tests and read the live parity**

Run: `.venv/bin/python -m pytest tests/shorted/test_mcp.py -q`
Expected: PASS (63 tests). `test_recorded_pass` runs the pass over all four recorded pairs and requires every parity check to hold: parity compares the two surfaces on the dossier's own as-at date, so a pair recorded minutes apart agrees. A check that fails on recorded data is a real Shorted finding: name it, with both values from `artifacts/mcp.json`, in your report.

- [ ] **Step 8: Commit**

```bash
git add tools/shorted/mcp.py tools/shorted/mcp_pass.py scripts/shorted/record_mcp_fixtures.py tests/shorted/fixtures tests/shorted/conftest.py tests/shorted/test_mcp.py
git commit -m "feat(shorted): MCP pass: stateless MCP client, API/MCP parity and MCP coverage"
```

---

## Part C: the kit and the signature score

### Task 10: Kit index, seeded from the film

**Files:**
- Create: `tools/shorted/kit.py`
- Test: `tests/shorted/test_kit.py`

**Interfaces:**
- Consumes: OpenMontage `schemas.artifacts.validate_artifact("asset_manifest", data)`.
- Produces:
  - `kit/index.json` in `asset_manifest` format. Each asset has `id`, `type`, `path` (relative to `kit/`), `source_tool`, `scene_id: "kit"`, `subtype` (the kit type), `provider`, `license`. Tags live in `metadata.tags[id]` and content hashes in `metadata.sha256[id]`, because the schema allows no extra asset fields.
  - Kit types: `font, texture, logo, sfx, music-stem, soundfont`.
  - `kit_dir()`, `public_dir()` (overridable with `SHORTED_KIT_DIR` and `SHORTED_PUBLIC_DIR`).
  - `register(src, rel, kit_type, tags, *, license, provider, summary=None, original_url=None, root=None) -> id`. It dedupes by sha256.
  - `resolve(kit_type, root=None, **tags) -> list[dict]`; each dict is the asset plus `tags` and an absolute `file`.
  - `seed_from_film(film_dir, root=None, public=None) -> list[id]`, `load_index(root=None)`, `SEED`, `LICENCES`.
  - Public mirror for Remotion: `remotion-composer/public/shorted/{fonts,textures,brand}/…`. Font names: `Newsreader-Variable.ttf`, `Newsreader-Italic-Variable.ttf`, `IBMPlexMono-{Regular,Medium,SemiBold,Bold}.ttf`, `Caveat-Variable.ttf`. Textures: `grain-{watercolor,recycled,crumple,kraft,smooth,card}.jpg`. Logo: `brand/shorted-icon-512.png`.
  - SFX tags `sfx`: `page-flip` (×3), `book-open`, `book-close`, `book-place`, `coins`.
  - Tool `ShortedKit` (`shorted_kit`), with operations `seed`, `resolve` and `list`.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_kit.py`:

```python
import json
from pathlib import Path

from schemas.artifacts import validate_artifact
from tools.shorted.kit import LICENCES, SEED, load_index, register, resolve, seed_from_film


def make_film(tmp_path: Path) -> Path:
    film = tmp_path / "film"
    for src, *_ in SEED:
        p = film / src
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(src.encode())  # distinct bytes per file, so nothing dedupes
    for src, _ in LICENCES:
        (film / src).parent.mkdir(parents=True, exist_ok=True)
        (film / src).write_text("licence")
    return film


def test_seed_registers_everything_and_validates(tmp_path):
    kit, pub = tmp_path / "kit", tmp_path / "pub"
    ids = seed_from_film(make_film(tmp_path), root=kit, public=pub)
    assert len(ids) == len(SEED) == 22
    index = json.loads((kit / "index.json").read_text())
    validate_artifact("asset_manifest", index)
    assert (pub / "fonts/Newsreader-Variable.ttf").exists()
    assert (pub / "textures/grain-watercolor.jpg").exists()
    assert (pub / "brand/shorted-icon-512.png").exists()
    assert (kit / "sfx/kenney-License.txt").exists()


def test_register_dedupes_by_content(tmp_path):
    a, b = tmp_path / "a.ogg", tmp_path / "b.ogg"
    a.write_bytes(b"same")
    b.write_bytes(b"same")
    kit = tmp_path / "kit"
    first = register(a, "sfx/a.ogg", "sfx", {"sfx": "x"}, license="CC0", provider="t", root=kit)
    second = register(b, "sfx/b.ogg", "sfx", {"sfx": "y"}, license="CC0", provider="t", root=kit)
    assert first == second and len(load_index(kit)["assets"]) == 1


def test_resolve_by_tags(tmp_path):
    kit = tmp_path / "kit"
    seed_from_film(make_film(tmp_path), root=kit, public=tmp_path / "pub")
    flips = resolve("sfx", root=kit, sfx="page-flip")
    assert len(flips) == 3 and all(Path(f["file"]).exists() for f in flips)
    assert resolve("font", root=kit, family="Caveat")[0]["path"] == "fonts/Caveat-Variable.ttf"
    assert resolve("sfx", root=kit, sfx="nope") == []
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_kit.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.kit'`.

- [ ] **Step 3: Implement `kit.py`**

```python
"""The Shorted kit: a growing, tagged library of reusable assets (fonts, textures, the logo,
sound effects, the SoundFont, score stems), indexed in OpenMontage's asset_manifest format.

kit/ is gitignored; kit/index.json records provenance and licence for every file. Tags and
content hashes live in index["metadata"] because the schema allows no extra asset fields.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolTier

REPO = Path(__file__).resolve().parents[2]
KIT_TYPES = {"font": "font", "texture": "image", "logo": "image", "sfx": "sfx", "music-stem": "music",
             "soundfont": "audio"}
OFL = "SIL Open Font License 1.1 ({})"
_FILM = "seeded from A Field Guide to the Bears"
_KENNEY = "assets/sfx-source/kenney/rpg-audio/"
SEED: list[tuple[str, str, str, dict, str, str]] = [
    # (film path, kit path, kit type, tags, licence, provider). Variable fonts lose their brackets.
    ("assets/fonts/Newsreader[opsz,wght].ttf", "fonts/Newsreader-Variable.ttf", "font",
     {"family": "Newsreader", "style": "normal"}, OFL.format("fonts/OFL-newsreader.txt"), "Production Type"),
    ("assets/fonts/Newsreader-Italic[opsz,wght].ttf", "fonts/Newsreader-Italic-Variable.ttf", "font",
     {"family": "Newsreader", "style": "italic"}, OFL.format("fonts/OFL-newsreader.txt"), "Production Type"),
    *[(f"assets/fonts/IBMPlexMono-{w}.ttf", f"fonts/IBMPlexMono-{w}.ttf", "font",
       {"family": "IBM Plex Mono", "weight": wt}, OFL.format("fonts/OFL-ibmplexmono.txt"), "IBM")
      for w, wt in (("Regular", "400"), ("Medium", "500"), ("SemiBold", "600"), ("Bold", "700"))],
    ("assets/fonts/Caveat[wght].ttf", "fonts/Caveat-Variable.ttf", "font", {"family": "Caveat"},
     OFL.format("fonts/OFL-caveat.txt"), "Impallari Type"),
    *[(f"assets/textures/grain-{g}.jpg", f"textures/grain-{g}.jpg", "texture", {"grain": g},
       "original (Shorted)", "shorted") for g in ("watercolor", "recycled", "crumple", "kraft", "smooth", "card")],
    ("assets/brand/icon-512.png", "brand/shorted-icon-512.png", "logo", {"brand": "shorted"}, "Shorted", "shorted"),
    ("assets/music/GeneralUser-GS.sf2", "music/GeneralUser-GS.sf2", "soundfont", {"name": "GeneralUser GS"},
     "GeneralUser GS licence (music/GeneralUser-GS-LICENSE.txt)", "S. Christian Collins"),
    *[(f"{_KENNEY}{src}.ogg", f"sfx/{dst}.ogg", "sfx", {"sfx": tag}, "CC0 1.0 (sfx/kenney-License.txt)", "Kenney")
      for src, dst, tag in (("bookFlip1", "page-flip-1", "page-flip"), ("bookFlip2", "page-flip-2", "page-flip"),
                            ("bookFlip3", "page-flip-3", "page-flip"), ("bookOpen", "book-open", "book-open"),
                            ("bookClose", "book-close", "book-close"), ("bookPlace1", "book-place", "book-place"),
                            ("handleCoins", "coins", "coins"))],
]
LICENCES = [
    ("assets/fonts/OFL-newsreader.txt", "fonts/OFL-newsreader.txt"),
    ("assets/fonts/OFL-ibmplexmono.txt", "fonts/OFL-ibmplexmono.txt"),
    ("assets/fonts/OFL-caveat.txt", "fonts/OFL-caveat.txt"),
    ("assets/music/GeneralUser-GS-LICENSE.txt", "music/GeneralUser-GS-LICENSE.txt"),
    (f"{_KENNEY}License.txt", "sfx/kenney-License.txt"),
]


def kit_dir() -> Path:
    return Path(os.environ.get("SHORTED_KIT_DIR") or REPO / "kit")


def public_dir() -> Path:
    return Path(os.environ.get("SHORTED_PUBLIC_DIR") or REPO / "remotion-composer/public/shorted")


def load_index(root: Path | None = None) -> dict:
    path = (root or kit_dir()) / "index.json"
    if path.exists():
        return json.loads(path.read_text())
    return {"version": "1.0", "assets": [], "metadata": {"tags": {}, "sha256": {}}}


def _save(index: dict, root: Path) -> None:
    from schemas.artifacts import validate_artifact

    validate_artifact("asset_manifest", index)
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps(index, indent=1))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def register(src: Path, rel: str, kit_type: str, tags: dict, *, license: str, provider: str,
             summary: str | None = None, original_url: str | None = None, root: Path | None = None) -> str:
    """Copy src into the kit at rel and index it. The same bytes already indexed return the existing id."""
    root = root or kit_dir()
    index = load_index(root)
    digest = _sha256(src)
    for aid, sha in index["metadata"]["sha256"].items():
        if sha == digest:
            return aid
    dest = root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if Path(src).resolve() != dest.resolve():
        shutil.copy2(src, dest)
    aid = rel.rsplit(".", 1)[0].replace("/", ":")
    entry = {"id": aid, "type": KIT_TYPES[kit_type], "path": rel, "source_tool": "shorted_kit", "scene_id": "kit",
             "subtype": kit_type, "provider": provider, "license": license, "format": dest.suffix.lstrip(".")}
    if summary:
        entry["generation_summary"] = summary
    if original_url:
        entry["original_url"] = original_url
    index["assets"] = [a for a in index["assets"] if a["id"] != aid] + [entry]
    index["metadata"]["tags"][aid] = {"type": kit_type, **tags}
    index["metadata"]["sha256"][aid] = digest
    index["metadata"]["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _save(index, root)
    return aid


def resolve(kit_type: str, root: Path | None = None, **tags) -> list[dict]:
    root = root or kit_dir()
    index = load_index(root)
    out = []
    for a in index["assets"]:
        t = index["metadata"]["tags"].get(a["id"], {})
        if t.get("type") == kit_type and all(str(t.get(k)) == str(v) for k, v in tags.items()):
            out.append({**a, "tags": t, "file": str(root / a["path"])})
    return out


def seed_from_film(film_dir: Path, root: Path | None = None, public: Path | None = None) -> list[str]:
    root, public = root or kit_dir(), public or public_dir()
    ids = [register(Path(film_dir) / src, rel, kt, tags, license=lic, provider=prov, summary=_FILM, root=root)
           for src, rel, kt, tags, lic, prov in SEED]
    for src, rel in LICENCES:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(film_dir) / src, root / rel)
    for a in resolve("font", root) + resolve("texture", root) + resolve("logo", root, brand="shorted"):
        dest = public / a["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(a["file"], dest)
    return ids


class ShortedKit(BaseTool):
    name = "shorted_kit"
    version = "1.0.0"
    tier = ToolTier.CORE
    capability = "asset_library"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["operation"], "properties": {
        "operation": {"enum": ["seed", "resolve", "list"]}, "film_dir": {"type": "string"},
        "kit_type": {"type": "string"}, "tags": {"type": "object"}}}

    def execute(self, inputs: dict) -> ToolResult:
        op = inputs["operation"]
        if op == "seed":
            ids = seed_from_film(Path(inputs.get("film_dir") or os.environ["SHORTED_FILM_DIR"]))
            return ToolResult(success=True, data={"registered": ids}, artifacts=[str(kit_dir() / "index.json")])
        if op == "resolve":
            return ToolResult(success=True, data={"assets": resolve(inputs["kit_type"], **inputs.get("tags", {}))})
        index = load_index()
        return ToolResult(success=True, data={"count": len(index["assets"]),
                                              "types": sorted({t["type"] for t in index["metadata"]["tags"].values()})})
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_kit.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Seed the real kit**

```bash
cd /Users/benebsworth/projects/shorted-studio
set -a; . ./.env; set +a
.venv/bin/python -c "from pathlib import Path; import os; from tools.shorted.kit import seed_from_film; print(len(seed_from_film(Path(os.environ['SHORTED_FILM_DIR']))))"
ls remotion-composer/public/shorted/fonts remotion-composer/public/shorted/textures
```
Expected: `22`, then 7 font files and 6 textures. `kit/` and `remotion-composer/public/shorted/` are gitignored (Task 1), so this step commits nothing.

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/kit.py tests/shorted/test_kit.py
git commit -m "feat(shorted): kit index in asset_manifest format, seeded from the film"
```

### Task 11: Signature-score stems

**Files:**
- Create: `tools/shorted/music_theme.py`
- Test: `tests/shorted/test_music_theme.py`

**Interfaces:**
- Consumes: `register`, `resolve`, `kit_dir` (Task 10); the kit SoundFont (`resolve("soundfont")`).
- Produces:
  - Constants: `BPM = 96`, `BEAT = 0.625`, `BAR = 2.5`, `TAIL = 2.5`, `SR = 48000`.
  - `STEMS = {name: (bars, target_lufs)}` and `LOOPS`. Stems: `sting_open` (2 bars), `card_sting` (1), `bed_groove` (8, loops), `bed_calm` (8, loops), `bed_tension` (8, loops), `button_end` (2).
  - `compose(name) -> dict[str, Part]`; each `Part.notes` is a list of `(t, key, vel, dur)`.
  - `write_stems(sf2, out_dir, register_in_kit=True)`, which writes `<name>.flac` and `<name>.json`. The JSON is `{name, bars, bpm, bar_seconds, tail_seconds, loop_seconds|null, lufs, target_lufs}`.
  - `ensure_stems(root=None) -> dict[name, Path]`, which renders into `kit/music/stems/` only when a stem is missing.
  - Every stem is `bars × BAR + TAIL` seconds long. The tail is reverb ring, and `score.py` overlaps it onto whatever follows.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_music_theme.py`:

```python
import json
import os
from pathlib import Path

import numpy as np
import pytest

from tools.shorted.music_theme import BAR, STEMS, TAIL, compose, write_stems

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def test_groove_bass_follows_the_chord_loop():
    bass = sorted(compose("bed_groove")["bass"].notes)
    downbeats = [k for t, k, _, _ in bass if min((t / BAR) % 1, 1 - (t / BAR) % 1) < 0.01]
    assert [NAMES[k % 12] for k in downbeats] == ["D", "B", "G", "A"] * 2


def test_every_stem_fits_its_length():
    for name, (bars, _) in STEMS.items():
        notes = [nt for p in compose(name).values() for nt in p.notes]
        assert notes, name
        assert max(t for t, *_ in notes) < bars * BAR, name
        assert max(t + d for t, _, _, d in notes) <= bars * BAR + TAIL, name


def test_composition_is_deterministic():
    a, b = compose("bed_tension"), compose("bed_tension")
    assert {k: p.notes for k, p in a.items()} == {k: p.notes for k, p in b.items()}


@pytest.mark.slow
def test_render_stems(tmp_path):
    import pyloudnorm as pyln
    import soundfile as sf

    sf2 = Path(os.environ.get("SHORTED_FILM_DIR", "/Users/benebsworth/projects/shorted-promo-film")) / "assets/music/GeneralUser-GS.sf2"
    if not sf2.exists():
        pytest.skip("SoundFont not available")
    write_stems(sf2, tmp_path, register_in_kit=False)
    for name, (bars, target) in STEMS.items():
        y, sr = sf.read(tmp_path / f"{name}.flac")
        meta = json.loads((tmp_path / f"{name}.json").read_text())
        assert sr == 48000 and abs(len(y) / sr - (bars * BAR + TAIL)) < 0.01
        measured = pyln.Meter(sr).integrated_loudness(y)
        assert abs(measured - meta["lufs"]) < 0.5 and target - 6 <= measured <= target + 0.5
        assert np.abs(y).max() < 0.9
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_music_theme.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.music_theme'`.

- [ ] **Step 3: Implement `music_theme.py`**

```python
"""The signature score as reusable stems, composed in code and rendered with the kit SoundFont.

96 BPM: a beat is 0.625 s and a bar 2.5 s. Beds are 8 bars (20 s) and loop; every stem is
rendered with TAIL seconds of reverb ring past its end, which score.py overlaps onto what
follows. The key is the film's: D major (D, Bm, G, A) and its D-minor "tiptoe" for the bears.
Instruments are GeneralUser GS programs (General MIDI numbering).
"""

from __future__ import annotations

import json
import random
import zlib
from pathlib import Path

import numpy as np

BPM = 96
BEAT = 60.0 / BPM
BAR = 4 * BEAT
TAIL = 2.5
SR = 48000
NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
        "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
CHORDS8 = ["D", "B", "G", "A", "D", "B", "G", "A"]      # B is B minor
TENSION8 = ["D", "D", "G", "A", "D", "D", "G", "A"]     # D minor and G minor; A major
SCALE_D = [0, 2, 4, 5, 7, 9, 11]
LILT = 0.028
STEMS = {"sting_open": (2, -18.0), "card_sting": (1, -18.0), "bed_groove": (8, -20.0),
         "bed_calm": (8, -22.0), "bed_tension": (8, -21.0), "button_end": (2, -18.0)}
LOOPS = {"bed_groove", "bed_calm", "bed_tension"}
PROGRAMS = {"harp": 46, "pizz": 45, "marimba": 12, "celesta": 8, "strings": 48, "bass": 32,
            "bassoon": 70, "clarinet": 71, "kit": 0}
REVERB = {"harp": 0.45, "pizz": 0.35, "marimba": 0.3, "celesta": 0.5, "strings": 0.5, "bass": 0.12,
          "bassoon": 0.3, "clarinet": 0.35, "kit": 0.2}
PAN = {"harp": -0.35, "pizz": -0.15, "marimba": -0.2, "celesta": 0.3, "strings": 0.0, "bass": 0.0,
       "bassoon": 0.05, "clarinet": 0.3, "kit": 0.0}


def n(name: str) -> int:
    """'D3' -> 50 (middle C = C4 = 60)."""
    return 12 * (int(name[-1]) + 1) + NOTE[name[:-1]]


def T(bar: float, beat: float = 1.0) -> float:
    return bar * BAR + (beat - 1) * BEAT


class Part:
    """One instrument: one MIDI channel, rendered on its own synth."""

    def __init__(self, name: str, rng: random.Random):
        self.name, self.rng, self.drums = name, rng, name == "kit"
        self.notes: list[tuple[float, int, int, float]] = []

    def note(self, t: float, key, vel: float, dur: float, human: bool = True) -> None:
        key = n(key) if isinstance(key, str) else key
        if human:
            t += self.rng.gauss(0, 0.009)
            vel += self.rng.randint(-7, 7)
        self.notes.append((max(0.0, t), key, int(max(1, min(127, vel))), dur))

    def chord(self, t: float, keys, vel: float, dur: float, roll: float = 0.0) -> None:
        for i, k in enumerate(keys):
            self.note(t + i * roll, k, vel, dur)

    def render(self, sf2: Path, seconds: float) -> np.ndarray:
        import tinysoundfont

        synth = tinysoundfont.Synth(samplerate=SR, gain=0)
        sfid = synth.sfload(str(sf2))
        ch = 9 if self.drums else 0
        synth.program_select(ch, sfid, 128 if self.drums else 0, PROGRAMS[self.name], is_drums=self.drums)
        synth.control_change(ch, 10, int(64 + PAN[self.name] * 63))
        events = sorted([(t, 1, "on", k, v) for t, k, v, _ in self.notes] +
                        [(t + d, 0, "off", k, 0) for t, k, _, d in self.notes])
        total = int(seconds * SR)
        out = np.zeros((total, 2), dtype=np.float32)
        pos = 0
        for t, _, kind, key, vel in events:
            target = min(total, int(t * SR))
            if target > pos:
                out[pos:target] = np.frombuffer(synth.generate(target - pos), dtype=np.float32).reshape(-1, 2)
                pos = target
            if kind == "on":
                synth.noteon(ch, key, vel)
            else:
                synth.noteoff(ch, key)
        if pos < total:
            out[pos:] = np.frombuffer(synth.generate(total - pos), dtype=np.float32).reshape(-1, 2)
        return out


def _tones(root: str, minor: bool) -> tuple[int, int, int]:
    r = n(f"{root}4") if NOTE[root] <= NOTE["A"] else n(f"{root}3")
    return r, r + (3 if minor else 4), r + 7


def _bass_root(root: str) -> int:
    return n(f"{root}2") if NOTE[root] >= NOTE["D"] else n(f"{root}3")


def _groove(P: dict, bars: list[str]) -> None:
    for bar, root in enumerate(bars):
        r, third, fifth = _tones(root, minor=root == "B")
        pattern = ([r, fifth, r + 12, fifth, third + 12, fifth, r + 12, fifth] if bar < 4 else
                   [r, third + 12, fifth, r + 12, fifth, third + 12, r + 12, fifth + 12])
        for i, (k, v) in enumerate(zip(pattern, [78, 52, 64, 50, 70, 52, 62, 50])):
            P["marimba"].note(T(bar, 1 + i / 2), k, v, 0.3)
        rb, nxt = _bass_root(root), _bass_root(bars[(bar + 1) % len(bars)])
        P["bass"].note(T(bar, 1), rb, 92, BEAT * 0.9)
        P["bass"].note(T(bar, 2.5), rb + 7, 70, BEAT * 0.45)
        P["bass"].note(T(bar, 3), rb, 84, BEAT * 0.9)
        P["bass"].note(T(bar, 4.5), nxt - 1 if nxt - 1 != rb else nxt + 2, 66, BEAT * 0.45)
        for beat, key, vel in ((1, 36, 78), (3, 36, 66), (2, 37, 66), (4, 37, 68)):
            P["kit"].note(T(bar, beat), key, vel, 0.2)
        for i in range(8):
            P["kit"].note(T(bar, 1 + i / 2), 70, 48 if i % 2 else 36, 0.1)
        for beat in (2.5, 4.5):
            P["pizz"].chord(T(bar, beat), [third, fifth], 50, 0.18)


def _calm(P: dict, bars: list[str]) -> None:
    for bar, root in enumerate(bars):
        r, third, fifth = _tones(root, minor=root == "B")
        for i, k in enumerate([r - 12, fifth - 12, r, third, fifth, r + 12, fifth, third]):
            P["harp"].note(T(bar, 1 + i / 2), k, 52 if i == 0 else 44, 1.2)
        P["strings"].chord(T(bar), [r - 12, third - 12, fifth - 12], 40, BAR - 0.05)
        if bar % 2 == 0:
            P["celesta"].note(T(bar, 3), fifth + 12, 44, 1.0)


def _tension(P: dict, bars: list[str]) -> None:
    motif = [("D3", 1, 0.5), ("F3", 1.5, 0.5), ("E3", 2, 0.5), ("D3", 2.5, 0.5), ("C#3", 3, 1.0)]
    for bar, root in enumerate(bars):
        r, third, fifth = _tones(root, minor=root in ("D", "G"))
        lo = _bass_root(root)
        for i, beat in enumerate((1, 2, 3, 4)):
            lean = LILT if beat % 2 == 0 else 0.0
            P["pizz"].note(T(bar, beat) + lean, lo + (12 if i % 2 == 0 else 7), 70 if i % 2 == 0 else 56, 0.22)
        P["kit"].note(T(bar, 2) + LILT, 76, 40, 0.1)  # hi wood block
        P["kit"].note(T(bar, 4) + LILT, 77, 36, 0.1)  # low wood block
        if bar % 2 == 0:
            shift = NOTE[root] - NOTE["D"]
            for name, beat, dur in motif:
                P["bassoon"].note(T(bar, beat), n(name) + shift, 64, dur * BEAT)
        elif bar in (3, 7):
            P["clarinet"].chord(T(bar, 2), [third, fifth], 48, BEAT * 1.5)


def _sting_open(P: dict) -> None:
    for i, k in enumerate(["A3", "D4", "F#4", "A4", "D5"]):
        P["harp"].note(0.08 + i * 0.15, k, 48 + i * 6, 2.2, human=False)
    P["celesta"].note(T(0, 3), "D6", 52, 1.2)
    P["marimba"].chord(T(1), [n("D4"), n("A4"), n("D5")], 74, 0.6)
    P["pizz"].chord(T(1), [n("D3"), n("F#3"), n("A3"), n("D4")], 72, 0.3)
    P["bass"].note(T(1), "D2", 90, BEAT)
    P["strings"].chord(T(1), [n("D3"), n("F#3"), n("A3")], 46, BAR * 0.9)


def _card_sting(P: dict) -> None:
    base = n("D4")
    for i in range(10):
        P["harp"].note(0.02 + i * BEAT / 10, base + 12 * (i // 7) + SCALE_D[i % 7], 40 + i * 3, 1.0, human=False)
    P["celesta"].note(T(0, 2), "A5", 46, 1.0)
    P["pizz"].chord(T(0, 2), [n("D4"), n("F#4"), n("A4")], 52, 0.25)


def _button_end(P: dict) -> None:
    P["pizz"].chord(0.0, [n("D3"), n("F#3"), n("A3"), n("D4")], 84, 0.25)
    P["marimba"].chord(0.0, [n("D4"), n("A4")], 80, 0.5)
    P["bass"].note(0.0, "D2", 96, 0.4)
    P["kit"].note(0.0, 36, 84, 0.2)
    P["kit"].note(0.0, 49, 40, 2.0)  # a soft crash
    P["bassoon"].note(T(0, 2.5), "A2", 70, 0.18)
    P["bassoon"].note(T(0, 3), "D3", 76, 0.3)
    P["harp"].note(T(0, 3), "D5", 50, 2.5)


def compose(name: str) -> dict[str, Part]:
    rng = random.Random(zlib.crc32(name.encode()))
    P = {k: Part(k, rng) for k in PROGRAMS}
    if name == "bed_groove":
        _groove(P, CHORDS8)
    elif name == "bed_calm":
        _calm(P, CHORDS8)
    elif name == "bed_tension":
        _tension(P, TENSION8)
    elif name == "sting_open":
        _sting_open(P)
    elif name == "card_sting":
        _card_sting(P)
    elif name == "button_end":
        _button_end(P)
    else:
        raise ValueError(f"unknown stem {name!r}")
    return {k: p for k, p in P.items() if p.notes}


def _hall_ir(seconds: float = 2.4, predelay: float = 0.018) -> np.ndarray:
    """Synthetic stereo hall: early reflections plus decorrelated, darkening, decaying noise."""
    from scipy import signal

    length = int(seconds * SR)
    t = np.arange(length) / SR
    ir = np.zeros((length, 2))
    r = np.random.default_rng(3)
    b, a = signal.butter(1, 5200, fs=SR)
    for ch in range(2):
        ir[:, ch] = signal.lfilter(b, a, r.standard_normal(length)) * np.exp(-t / (seconds / 6.9))
        for _ in range(10):
            ir[int((predelay + r.uniform(0.004, 0.06)) * SR), ch] += r.uniform(0.2, 0.55) * (1 if r.random() > 0.5 else -1)
    return ir / np.sqrt((ir ** 2).sum(axis=0, keepdims=True))


def render_stem(name: str, sf2: Path) -> np.ndarray:
    from scipy import signal

    bars, _ = STEMS[name]
    seconds = bars * BAR + TAIL
    ir = _hall_ir()
    mix = np.zeros((int(seconds * SR), 2))
    for part_name, part in compose(name).items():
        dry = part.render(sf2, seconds).astype(np.float64)
        wet = np.stack([signal.fftconvolve(dry[:, c], ir[:, c])[: len(dry)] for c in range(2)], axis=1)
        mix += dry + REVERB[part_name] * wet
    return mix


def write_stems(sf2: Path, out_dir: Path, register_in_kit: bool = True) -> list[Path]:
    import pyloudnorm as pyln
    import soundfile as sf

    out_dir.mkdir(parents=True, exist_ok=True)
    meter = pyln.Meter(SR)
    paths = []
    for name, (bars, target) in STEMS.items():
        y = render_stem(name, sf2)
        y *= 10 ** ((target - meter.integrated_loudness(y)) / 20)
        peak = float(np.abs(y).max())
        if peak > 0.89:  # keep 1 dB of headroom; the mix limiter does the rest
            y *= 0.89 / peak
        path = out_dir / f"{name}.flac"
        sf.write(path, y.astype(np.float32), SR, subtype="PCM_24")
        y_written, _ = sf.read(path)
        meta = {"name": name, "bars": bars, "bpm": BPM, "bar_seconds": BAR, "tail_seconds": TAIL,
                "loop_seconds": bars * BAR if name in LOOPS else None,
                "lufs": round(float(meter.integrated_loudness(y_written)), 2), "target_lufs": target}
        (out_dir / f"{name}.json").write_text(json.dumps(meta, indent=1))
        if register_in_kit:
            from tools.shorted.kit import register

            register(path, f"music/stems/{name}.flac", "music-stem",
                     {"stem": name, "bpm": BPM, "loop": name in LOOPS}, license="original (Shorted)",
                     provider="shorted", summary="composed in code (music_theme.py), rendered with GeneralUser GS")
        paths.append(path)
    return paths


def ensure_stems(root: Path | None = None) -> dict[str, Path]:
    from tools.shorted.kit import kit_dir, resolve

    out_dir = (root or kit_dir()) / "music" / "stems"
    want = {name: out_dir / f"{name}.flac" for name in STEMS}
    if not all(p.exists() and p.with_suffix(".json").exists() for p in want.values()):
        sf2 = resolve("soundfont", root)
        if not sf2:
            raise RuntimeError("no SoundFont in the kit; run the kit seed (Task 10)")
        write_stems(Path(sf2[0]["file"]), out_dir)
    return want


if __name__ == "__main__":
    for stem, path in ensure_stems().items():
        print(stem, path)
```

- [ ] **Step 4: Run the tests (fast, then slow)**

Run: `.venv/bin/python -m pytest tests/shorted/test_music_theme.py -q && .venv/bin/python -m pytest tests/shorted/test_music_theme.py -q -m slow`
Expected: PASS: 3 fast tests, then the slow render test (about 20 s).

- [ ] **Step 5: Render into the kit and listen**

```bash
cd /Users/benebsworth/projects/shorted-studio && .venv/bin/python -m tools.shorted.music_theme
afplay kit/music/stems/sting_open.flac; afplay kit/music/stems/bed_tension.flac
```
Expected: six lines, one per stem. The sting is a bright harp rise into a D-major hit; the tension bed is a pizzicato tiptoe with a bassoon. If a stem sounds wrong, change `compose()` rather than the mix.

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/music_theme.py tests/shorted/test_music_theme.py
git commit -m "feat(shorted): signature-score stems composed in code, rendered into the kit"
```

---

## Part D: the Remotion scenes

The film's engine draws everything onto one canvas as a pure function of time. Here it runs inside Remotion: one `<canvas>` per composition is redrawn from scratch every frame, so any frame renders identically in any browser tab. Python (Task 20) resolves every string before Remotion sees it; the TypeScript never formats a number.

### Task 12: Engine port, canvas, page and the chapter card

**Files:**
- Create: `remotion-composer/src/shorted/engine/{core,paper,type,bear,props}.js` (copied from the film)
- Create: `remotion-composer/src/shorted/engine/index.ts`, `remotion-composer/src/shorted/engine/load.ts`
- Create: `remotion-composer/src/shorted/{types.ts,theme.ts,page.ts,PaperCanvas.tsx,ScenePreview.tsx,Root.tsx,index.tsx,sample-timeline.json}`
- Create: `remotion-composer/src/shorted/scenes/{common.ts,chapter.ts,index.ts}`
- Test: `tests/shorted/test_remotion.py`, `tests/shorted/test_scene_fit.py` (every scene at the gates' text budgets), `tests/shorted/fit_lines.test.mjs` (`fitLines` without a browser, run by `test_remotion.py`)

**Interfaces:**
- Consumes: the public mirror from Task 10 (`public/shorted/fonts`, `textures`, `brand`).
- Produces:
  - `FG` (the engine global, typed `any`) and `loadEngine(images: Record<string, string>)`, where image paths are relative to `public/`.
  - `PaperCanvas({draw, images, time?})`, where `draw(ctx, t, W, H)` is a pure function of time.
  - `layoutFor(W, H) -> Layout {W, H, portrait, k, page, body, superY, footY, captionY}`. The body starts below a two-line page title (16:9: 240 px below the page top) and ends above the ASIC caveat label.
  - Helpers: `C` (palette), `F` (font makers), `wrap`, `text`, `once`, `pop`, `fade`.
  - `fitLines(text, {font, width, max, min, lines?, oneLine?, box?, balance?, ellipsis?, spacing?}) -> Fit {lines, size, cut}` (`scenes/common.ts`): one line down to `oneLine`, then the largest size at which the text wraps into the lines allowed (balanced), or with `box` into as many lines as fit its height. A word wider than a line shrinks the size first and is hard-broken only at `min`. A cut takes an ellipsis only when allowed. `width` may be a function of the size.
  - `reportCut(s, prop, fit)` logs `[shorted-fit] <id> (<type>): <prop> was cut to fit` once. `verbatim(s, prop, fit)` throws instead, naming the scene and the prop. `fitSize` clamps at its floor. `badgeSpot(L)` gives the logo badge's place and the rectangle text keeps clear of. `tag()` is memoised with its seed; `badge()` throws on an image that is not loaded.
  - `drawDesk(ctx, L)`, `drawPage(ctx, L, t, key, {no?, title, sub?, avoid?}) -> slide` (px below its resting place). The page is memoised by its content; `key` names the scene in the log. `pageTitle(L, o) -> Fit`: up to two lines, kept clear of `avoid`.
  - `Ctx = {t, dur, L, props, images, id, no, type}` and `SceneDraw = (ctx, s: Ctx) => void`.
  - `SCENES: Record<type, SceneDraw>` and `drawSceneAt(ctx, scene, local, W, H, images)`. It runs `checkProps` first, which throws, naming the scene id, type and prop, on:
    - a missing required prop (`REQUIRED`, a mirror of `gates.REQUIRED_PROPS`);
    - a value outside `VOCAB` (a mirror of `gates.VOCAB`);
    - a list outside its size;
    - a negative bar;
    - a chart that cannot be read: no axis for a side in use, two series on one side, `max <= min`, fewer than two plottable points in date order, or fewer than two month labels.
  - Composition `ShortedSceneSheet`: props `{width, height, at, images, scenes}`; frame *i* draws `scenes[i]` at local time `at`.
  - Types (`types.ts`): `Scene = {id, type, chapter, no, start, end, transition: "page"|"cut", super: string|null, props}`; `VideoProps`, `SheetProps`, `ThumbProps`, `CaptionPage = {start, end, text, words: [{w, s, e}]}`. All times are in seconds.
  - `sample-timeline.json` with keys `sheet`, `long`, `short` and `thumb`, using a fictional company (EXM, Example Minerals). It is the default props and the test input. The sheet's plate carries the ASIC caveat, as a real plate does.

- [ ] **Step 1: Copy the engine**

```bash
cd /Users/benebsworth/projects/shorted-studio
mkdir -p remotion-composer/src/shorted/engine remotion-composer/src/shorted/scenes
for f in core paper type bear props; do cp "$SHORTED_FILM_DIR/src/js/$f.js" remotion-composer/src/shorted/engine/; done
```
(`SHORTED_FILM_DIR` comes from `.env`: run `set -a; . ./.env; set +a` first.) The film's `assets.js` is not copied; `engine/index.ts` and `load.ts` replace it with Remotion's `staticFile`.

- [ ] **Step 2: Write the failing test**

`tests/shorted/test_remotion.py`:

```python
"""Remotion renders of the Shorted scenes. Slow: every call bundles the project."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

STUDIO = Path(__file__).resolve().parents[2]
RC = STUDIO / "remotion-composer"
SAMPLE = json.loads((RC / "src/shorted/sample-timeline.json").read_text())
OUT = STUDIO / "tests/shorted/_out"
SCENE_TYPES = ["chapter"]
ASPECTS = {"landscape": (1920, 1080), "portrait": (1080, 1920)}
BODY = {"landscape": (200, 300, 1740, 845), "portrait": (130, 420, 920, 1240)}  # layoutFor's body: x0, y0, x1, y1


def remotion(*args: str) -> None:
    res = subprocess.run(["npx", "remotion", *args], cwd=RC, capture_output=True, text=True, timeout=900)
    assert res.returncode == 0, (res.stderr or res.stdout)[-3000:]


def not_blank(path: Path) -> bool:
    return float(np.asarray(Image.open(path).convert("L"), dtype=np.float32).std()) > 12


def body_drawn(path: Path, aspect: str) -> float:
    """Luminance spread inside the page's body: about 1 on an empty page, 15 or more on a drawn card. The whole frame
    cannot tell them apart, because the desk against the paper alone scores over 80."""
    return float(np.asarray(Image.open(path).convert("L").crop(BODY[aspect]), dtype=np.float32).std())


def frames_in(folder: Path) -> list[Path]:
    return sorted(folder.glob("*.png"), key=lambda p: int(re.findall(r"\d+", p.stem)[-1]))


def contact_sheet(frames: list[Path], labels: list[str], cols: int = 4, w: int = 480) -> Image.Image:
    ims = [Image.open(f).convert("RGB") for f in frames]
    h = int(w * ims[0].height / ims[0].width)
    sheet = Image.new("RGB", (cols * w, ((len(ims) + cols - 1) // cols) * (h + 28)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (im, label) in enumerate(zip(ims, labels)):
        x, y = (i % cols) * w, (i // cols) * (h + 28)
        sheet.paste(im.resize((w, h)), (x, y))
        d.text((x + 6, y + h + 6), label, fill="black")
    return sheet


@pytest.mark.slow
@pytest.mark.parametrize("aspect", list(ASPECTS))
def test_scene_sheet_renders_every_type(aspect):
    W, H = ASPECTS[aspect]
    scenes = [s for s in SAMPLE["sheet"]["scenes"] if s["type"] in SCENE_TYPES]
    assert {s["type"] for s in scenes} == set(SCENE_TYPES)
    out = OUT / f"sheet-{aspect}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    props = out / "props.json"
    props.write_text(json.dumps({**SAMPLE["sheet"], "width": W, "height": H, "scenes": scenes}))
    remotion("render", "src/shorted/index.tsx", "ShortedSceneSheet", str(out / "frames"), f"--props={props}",
             "--sequence", "--image-format=png")
    frames = frames_in(out / "frames")
    assert len(frames) == len(scenes)
    for f, s in zip(frames, scenes):
        assert Image.open(f).size == (W, H)
        assert not_blank(f), s["type"]
        assert body_drawn(f, aspect) > 10, s["type"]
    contact_sheet(frames, [s["type"] for s in scenes]).save(OUT / f"scenes-{aspect}.jpg", quality=88)


def ts_map(name: str) -> dict[str, list[str]]:
    """A `Record<string, string[]>` constant from scenes/index.ts, read as text."""
    src = (RC / "src/shorted/scenes/index.ts").read_text()
    body = re.search(rf"export const {name}: Record<string, string\[\]> = \{{(.*?)\n\}};", src, re.S).group(1)
    return {k: re.findall(r'"([^"]+)"', v) for k, v in re.findall(r"(\w+): \[([^\]]*)\]", body)}


def test_scene_prop_checks_mirror_the_gates():
    """drawSceneAt refuses what the gates refuse: the same required props and the same closed vocabularies."""
    from tools.shorted.gates import REQUIRED_PROPS, VOCAB

    assert ts_map("REQUIRED") == REQUIRED_PROPS
    assert {k: set(v) for k, v in ts_map("VOCAB").items()} == {k: v for k, v in VOCAB.items() if k != "transition"}


@pytest.mark.skipif(not shutil.which("node") or not (RC / "node_modules/esbuild").exists(),
                    reason="needs node and remotion-composer/node_modules")
def test_fit_lines_without_a_browser():
    res = subprocess.run(["node", str(STUDIO / "tests/shorted/fit_lines.test.mjs")], cwd=RC, capture_output=True, text=True,
                         timeout=120)
    assert res.returncode == 0, (res.stdout + res.stderr)[-3000:]


@pytest.mark.slow
@pytest.mark.parametrize("change, message", [
    (lambda p: p.pop("title"), "x02 (chapter): missing prop title"),
    (lambda p: p.__setitem__("no", None), "x02 (chapter): missing prop no"),
    (lambda p: p.__setitem__("tone", "sideways"), 'x02 (chapter): tone is "sideways"'),
], ids=["missing", "null", "unknown tone"])
def test_bad_props_fail_the_render_naming_the_scene(change, message):
    scene = json.loads(json.dumps(next(s for s in SAMPLE["sheet"]["scenes"] if s["id"] == "x02")))
    change(scene["props"])
    out = OUT / "bad-props"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    props = out / "props.json"
    props.write_text(json.dumps({**SAMPLE["sheet"], "scenes": [scene]}))
    res = subprocess.run(["npx", "remotion", "render", "src/shorted/index.tsx", "ShortedSceneSheet", str(out / "frames"),
                          f"--props={props}", "--sequence", "--image-format=png"], cwd=RC, capture_output=True, text=True,
                         timeout=900)
    assert res.returncode != 0 and message in res.stdout + res.stderr
```

- [ ] **Step 3: Run it to see it fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: FAIL. Either `sample-timeline.json` is missing (a `FileNotFoundError` at import) or the composition is missing.

- [ ] **Step 4: Engine entry and loader**

`remotion-composer/src/shorted/engine/index.ts`:

```ts
// The paper-collage engine from "A Field Guide to the Bears", loaded in dependency order.
// Each file is an IIFE that extends window.FG; this module supplies what the film's assets.js did.
import "./core.js";
import "./paper.js";
import "./type.js";
import "./bear.js";
import "./props.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FG: any = (window as any).FG;
FG.img = FG.img || {};
FG.pattern = FG.pattern || {};
FG.canvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};
```

`remotion-composer/src/shorted/engine/load.ts`:

```ts
import { staticFile } from "remotion";
import { FG } from "./index";

const GRAINS = ["watercolor", "recycled", "crumple", "kraft", "smooth", "card"];
const FONTS: { family: string; file: string; descriptors: FontFaceDescriptors }[] = [
  { family: "Newsreader", file: "Newsreader-Variable.ttf", descriptors: { weight: "200 800", style: "normal" } },
  { family: "Newsreader", file: "Newsreader-Italic-Variable.ttf", descriptors: { weight: "200 800", style: "italic" } },
  { family: "IBM Plex Mono", file: "IBMPlexMono-Regular.ttf", descriptors: { weight: "400" } },
  { family: "IBM Plex Mono", file: "IBMPlexMono-Medium.ttf", descriptors: { weight: "500" } },
  { family: "IBM Plex Mono", file: "IBMPlexMono-SemiBold.ttf", descriptors: { weight: "600" } },
  { family: "IBM Plex Mono", file: "IBMPlexMono-Bold.ttf", descriptors: { weight: "700" } },
  { family: "Caveat", file: "Caveat-Variable.ttf", descriptors: { weight: "400 700" } },
];
export const BASE_IMAGES: Record<string, string> = {
  ...Object.fromEntries(GRAINS.map((g) => [`grain-${g}`, `shorted/textures/grain-${g}.jpg`])),
  shorted_icon: "shorted/brand/shorted-icon-512.png",
};

const jobs = new Map<string, Promise<void>>();
const once = (key: string, job: () => Promise<void>) => {
  if (!jobs.has(key)) jobs.set(key, job());
  return jobs.get(key)!;
};

const image = (key: string, path: string) =>
  once(`img:${key}:${path}`, () =>
    new Promise<void>((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        FG.img[key] = im;
        resolve();
      };
      im.onerror = () => reject(new Error(`image failed to load: ${path}`));
      im.src = staticFile(path);
    }),
  );

const font = (f: (typeof FONTS)[number]) =>
  once(`font:${f.file}`, async () => {
    const face = new FontFace(f.family, `url("${staticFile(`shorted/fonts/${f.file}`)}")`, f.descriptors);
    await face.load();
    document.fonts.add(face);
  });

/** Load the fonts, grain textures and the run's images, then build the grain patterns the engine uses. */
export async function loadEngine(images: Record<string, string>): Promise<void> {
  const all = { ...BASE_IMAGES, ...images };
  await Promise.all([...FONTS.map(font), ...Object.entries(all).map(([k, p]) => image(k, p))]);
  await document.fonts.ready;
  const scratch = document.createElement("canvas").getContext("2d")!;
  for (const g of GRAINS) {
    if (!FG.pattern[g]) FG.pattern[g] = scratch.createPattern(FG.img[`grain-${g}`], "repeat");
  }
}
```

- [ ] **Step 5: Types, theme and page**

`remotion-composer/src/shorted/types.ts`:

```ts
export type Images = Record<string, string>;
export type Word = { w: string; s: number; e: number };
export type CaptionPage = { start: number; end: number; text: string; words: Word[] };
export type SceneType =
  | "opening" | "chapter" | "company" | "number_card" | "bar_compare"
  | "line_chart" | "list_card" | "quote_card" | "plate" | "end_card";
export type Scene = {
  id: string; type: SceneType; chapter: string; no: number; start: number; end: number;
  transition: "page" | "cut"; super: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any;
};
export type VideoProps = {
  cut: "long" | "short"; width: number; height: number; fps: number; durationInFrames: number; ticker: string;
  images: Images; scenes: Scene[]; captions: CaptionPage[]; showCaptions: boolean; wordCaptions: boolean;
};
export type SheetProps = { width: number; height: number; at: number; images: Images; scenes: Scene[] };
export type ThumbProps = { headline: string[]; kicker: string; ticker: string; company: string; logo: string | null; images: Images };
```

`remotion-composer/src/shorted/theme.ts`:

```ts
import { FG } from "./engine";

export const C = {
  desk: "#1F3B33", page: "#F6EFDF", paper: "#F7F1E5", cream: "#EADAB8", ink: "#3A2E28", charcoal: "#2B2622",
  muted: "#72625A", amber: "#D9842A", burnt: "#9E5210", rust: "#B4532A", sage: "#87A86B", mineral: "#2F5470",
  // true green and red, only ever for direction of movement
  up: "#2E7D32", down: "#C0392B",
};

export type Rect = { x: number; y: number; w: number; h: number };
export type Layout = {
  W: number; H: number; portrait: boolean; k: number; page: Rect; body: Rect;
  superY: number; footY: number; captionY: number;
};

/**
 * Portrait keeps key content clear of the feed UI: nothing below 1420 but captions, nothing right of 920.
 * The body starts below a two-line page title and ends above the ASIC caveat label, so content inside it clears both.
 */
export function layoutFor(W: number, H: number): Layout {
  if (H > W) {
    const page = { x: 60, y: 170, w: W - 170, h: 1250 };
    const body = { x: page.x + 70, y: page.y + 250, w: page.w - 120, h: page.h - 430 };
    return { W, H, portrait: true, k: 1.1, page, body, superY: page.y + page.h - 136, footY: page.y + page.h - 70, captionY: 1500 };
  }
  const page = { x: 110, y: 60, w: W - 220, h: H - 150 };
  const body = { x: page.x + 90, y: page.y + 240, w: page.w - 160, h: page.h - 385 };
  return { W, H, portrait: false, k: 1, page, body, superY: page.y + page.h - 112, footY: page.y + page.h - 70, captionY: H - 48 };
}

export const F = {
  title: (L: Layout) => FG.font.serif(Math.round(62 * L.k), 700),
  big: (L: Layout, size = 88) => FG.font.serif(Math.round(size * L.k), 700),
  body: (L: Layout, size = 32) => FG.font.serif(Math.round(size * L.k), 500),
  mono: (L: Layout, size = 24, weight = 500) => FG.font.mono(Math.round(size * L.k), weight),
};

/** Greedy word wrap to a pixel width; an overflowing last line ends with an ellipsis. */
export function wrap(str: string, font: string, maxW: number, maxLines = 99): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of str.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (line && FG.measure(next, font).w > maxW) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s*\S*$/, "")}…`;
  return kept;
}

/** Text drawn straight onto the frame (for text that animates). */
export function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, font: string,
                     color = C.ink, align: CanvasTextAlign = "left", alpha = 1): void {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha *= Math.min(1, alpha);
  ctx.fillText(str, x, y);
  ctx.restore();
}

const memo = new Map<string, unknown>();
/** Build once per key: paper pieces are slow to build and fast to draw. */
export function once<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}

/** 0 → 1 with a small overshoot, starting at t0 (the film's "settle"). */
export const pop = (t: number, t0: number, dur = 0.5): number => FG.settle(t, t0, dur);
/** 0 → 1 linear fade over dur seconds from t0. */
export const fade = (t: number, t0: number, dur = 0.35): number => FG.math.clamp((t - t0) / dur);
```

`remotion-composer/src/shorted/page.ts`:

```ts
import { FG } from "./engine";
import { type Fit, fitLines } from "./scenes/common";
import { C, F, Layout, Rect, once } from "./theme";

export function drawDesk(ctx: CanvasRenderingContext2D, L: Layout): void {
  ctx.fillStyle = C.desk;
  ctx.fillRect(0, 0, L.W, L.H);
  const pat = FG.pattern.recycled;
  if (pat) {
    pat.setTransform(new DOMMatrix().scale(0.8));
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, L.W, L.H);
    ctx.restore();
  }
  const g = ctx.createRadialGradient(L.W / 2, L.H / 2, Math.min(L.W, L.H) * 0.3, L.W / 2, L.H / 2, Math.max(L.W, L.H) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, L.W, L.H);
}

/** `avoid`: a rectangle (in frame coordinates) the title stops short of, such as the company card's logo badge. */
export type PageText = { no?: number | null; title: string; sub?: string | null; avoid?: Rect | null };

const contentKey = (L: Layout, o: PageText): string => {
  const a = o.avoid ? [o.avoid.x, o.avoid.y, o.avoid.w, o.avoid.h].map(Math.round).join(",") : "";
  return `${o.no ?? ""}:${o.title}:${o.sub ?? ""}:${a}:${L.W}x${L.H}`;
};

/** The page title: up to two lines, shrunk to 52 px on one line before it wraps, and never reaching `avoid`. */
export function pageTitle(L: Layout, o: PageText): Fit {
  return once(`page-title:${contentKey(L, o)}`, () => {
    if (!o.title) return { lines: [], size: Math.round(62 * L.k), cut: false };
    const x = L.page.x + 78, max = Math.round(62 * L.k);
    const band = { top: L.page.y + 142 - max, bottom: L.page.y + 142 + 1.45 * max }; // two lines and their descenders
    const a = o.avoid;
    const full = L.page.w - 160;
    const width = a && a.y < band.bottom && a.y + a.h > band.top && a.x > x ? Math.min(full, a.x - 14 - x) : full;
    return fitLines(o.title, { font: (z) => FG.font.serif(z, 700), width, max, min: Math.round(44 * L.k),
                               oneLine: Math.round(52 * L.k), lines: 2, ellipsis: true });
  });
}

/** A field-guide page: margin rule, "FIELD NOTES · NO. n", the title, an optional italic sub, the folio. Built once per content. */
export function pagePiece(L: Layout, o: PageText) {
  return once(`page:${contentKey(L, o)}`, () => {
    const { w, h } = L.page;
    const title = pageTitle(L, o);
    const pitch = title.size * 1.1;
    return FG.piece({
      poly: FG.shape.rect(-w / 2, -h / 2, w, h), color: C.page, grain: "watercolor", grainAmt: 0.5,
      seed: 130 + (o.no ?? 0), light: 0.06, res: 1, edge: "cut", wobble: 0.6,
      details: (g: CanvasRenderingContext2D) => {
        const x0 = -w / 2, y0 = -h / 2;
        g.strokeStyle = "rgba(180,83,42,0.35)";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x0 + 46, y0 + 30);
        g.lineTo(x0 + 46, y0 + h - 30);
        g.stroke();
        g.fillStyle = C.ink;
        g.textAlign = "left";
        g.font = F.mono(L, 17, 600);
        g.letterSpacing = "5px";
        g.globalAlpha = 0.7;
        g.fillText(o.no ? `FIELD NOTES  ·  NO. ${o.no}` : "FIELD NOTES", x0 + 80, y0 + 74);
        g.globalAlpha = 1;
        g.letterSpacing = "0px";
        g.font = FG.font.serif(title.size, 700);
        title.lines.forEach((line, i) => g.fillText(line, x0 + 78, y0 + 142 + i * pitch));
        if (o.sub) {
          g.font = FG.font.serif(Math.round(28 * L.k), 600, true);
          g.fillStyle = "#83361A";
          g.fillText(o.sub, x0 + 80, y0 + 142 + Math.max(1, title.lines.length) * pitch);
        }
        if (o.no) {
          g.fillStyle = C.ink;
          g.globalAlpha = 0.5;
          g.font = F.mono(L, 17);
          g.textAlign = "center";
          g.fillText(`— ${o.no} —`, 0, y0 + h - 26);
        }
      },
    });
  });
}

/**
 * The page, with a stop-motion boil; it slides up and settles over the first half-second. `key` names the scene in the
 * render log when its title had to be cut. Returns how far below its resting place the page is drawn (0 once settled).
 */
export function drawPage(ctx: CanvasRenderingContext2D, L: Layout, t: number, key: string, o: PageText): number {
  const pc = pagePiece(L, o);
  if (pageTitle(L, o).cut) once(`cut:${key}:title:${L.W}x${L.H}`, () => console.warn(`[shorted-fit] ${key} (page): title was cut to fit`));
  const k = Math.min(1, FG.settle(t, 0, 0.6));
  const b = FG.boilXYR(t, 7, 0.6, 0.0015);
  const slide = (1 - k) * 60;
  FG.draw(ctx, pc, L.page.x + L.page.w / 2 + b.x, L.page.y + L.page.h / 2 + b.y + slide, { rot: b.r - 0.004, elev: 1.6 });
  return slide;
}
```

- [ ] **Step 6: The canvas component**

`remotion-composer/src/shorted/PaperCanvas.tsx`:

```tsx
import React, { useLayoutEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { FG } from "./engine";
import { loadEngine } from "./engine/load";
import type { Images } from "./types";

export type Draw = (ctx: CanvasRenderingContext2D, t: number, W: number, H: number) => void;

/** One canvas, redrawn from scratch every frame by a pure function of time. */
export const PaperCanvas: React.FC<{ draw: Draw; images: Images; time?: number }> = ({ draw, images, time }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const [handle] = useState(() => delayRender("loading the paper engine"));
  const [ready, setReady] = useState(false);
  const released = useRef(false);

  useLayoutEffect(() => {
    loadEngine(images).then(() => setReady(true), (err) => cancelRender(err));
  }, [images]);

  useLayoutEffect(() => {
    if (!ready || !ref.current) return;
    const ctx = ref.current.getContext("2d")!;
    FG.W = width;
    FG.H = height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    draw(ctx, time ?? frame / fps, width, height);
    if (!released.current) {
      released.current = true;
      continueRender(handle);
    }
  }, [ready, frame, width, height, fps, draw, time, handle]);

  return <canvas ref={ref} width={width} height={height} style={{ width, height, display: "block" }} />;
};
```

- [ ] **Step 7: Scene plumbing and the chapter card**

`remotion-composer/src/shorted/scenes/common.ts`:

```ts
import { FG } from "../engine";
import { C, F, Layout, Rect, fade, once, text } from "../theme";
import type { Images } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctx = { t: number; dur: number; L: Layout; props: any; images: Images; id: string; no: number; type: string };
export type SceneDraw = (ctx: CanvasRenderingContext2D, s: Ctx) => void;

/** As-at date and source, bottom left of the page: every figure shows when and where it is from. */
export function footer(ctx: CanvasRenderingContext2D, s: Ctx, parts: Array<string | null | undefined>): void {
  const line = parts.filter(Boolean).join("  ·  ");
  if (!line) return;
  const fit = fitLines(line, { font: (z) => FG.font.mono(z, 500), width: s.L.body.w, max: Math.round(19 * s.L.k),
                               min: Math.round(15 * s.L.k), ellipsis: true });
  reportCut(s, "as_at and source", fit);
  text(ctx, fit.lines[0], s.L.body.x, s.L.footY, FG.font.mono(fit.size, 500), C.muted, "left", fade(s.t, 0.8));
}

/** A torn paper roundel holding an image: fill crops it to the circle, otherwise it fits inside. */
export function badge(imgKey: string, r: number, fill: boolean) {
  const im = FG.img[imgKey];
  if (!im) throw new Error(`badge: no image loaded for key ${imgKey}`); // never memoise an empty roundel
  return once(`badge:${imgKey}:${r}:${fill}`, () =>
    FG.piece({
      poly: FG.shape.circle(0, 0, r + 22, 120), color: C.paper, grain: "watercolor", grainAmt: 0.45, seed: 180,
      light: 0.08, res: 1.3, edge: "torn", tear: 2.4,
      details: (g: CanvasRenderingContext2D) => {
        const s = ((fill ? 2.24 : 1.5) * r) / Math.max(im.width, im.height);
        g.save();
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.clip();
        g.drawImage(im, (-im.width * s) / 2, (-im.height * s) / 2, im.width * s, im.height * s);
        g.restore();
      },
    }),
  );
}

/**
 * Where the company card's logo badge sits, and the rectangle text keeps clear of (torn edge and pop included).
 * Landscape: top right of the page, beside the title. Portrait: top right of the body, below the title and inside 920.
 */
export function badgeSpot(L: Layout): { x: number; y: number; r: number; avoid: Rect } {
  const r = 72 * L.k, R = r + 22 + 6;
  const x = L.portrait ? L.body.x + L.body.w - R : L.page.x + L.page.w - 170 * L.k;
  const y = L.portrait ? L.body.y + R : L.page.y + 120 * L.k;
  return { x, y, r, avoid: { x: x - R, y: y - R, w: 2 * R, h: 2 * R } };
}

/** The largest size (in 4 px steps, down to min) at which str fits maxW. */
export function fitSize(str: string, make: (size: number) => string, maxW: number, base: number, min: number): number {
  let size = base;
  while (size > min && FG.measure(str, make(size)).w > maxW) size = Math.max(min, size - 4);
  return size;
}

/** What fitLines chose: the lines to draw, their font size, and whether text had to be cut to fit. */
export type Fit = { lines: string[]; size: number; cut: boolean };

export type FitOptions = {
  /** The font at a size in px. */
  font: (size: number) => string;
  /** No line is ever wider; a function of the size when a label's padding or a fixed suffix scales with it. */
  width: number | ((size: number) => number);
  /** The largest and smallest sizes tried, in steps of `step` (default 2) px. */
  max: number;
  min: number;
  /** Most lines (default 1). With a box, the box decides, capped by this when both are given. */
  lines?: number;
  /** Stay on one line down to this size before wrapping: default min, or max with a box (paragraphs wrap first). */
  oneLine?: number;
  /** Height-driven: as many lines as fit `height` at `leading` x size each, so lines grow as the size shrinks. */
  box?: { height: number; leading: number };
  /** Split so the longest line is shortest (titles, names); default true without a box. */
  balance?: boolean;
  /** Allow a "…" as the last resort; without it a cut is only reported (verbatim callers throw on it). */
  ellipsis?: boolean;
  /** Letter spacing in px, as the label draws it. */
  spacing?: number;
  step?: number;
  /** For tests: the width of text in a font. */
  measure?: (text: string, font: string, spacing: number) => number;
};

const widths = new Map<string, number>();
const measured = (str: string, font: string, spacing: number): number => {
  const key = `${font}|${spacing}|${str}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  const w: number = FG.measure(str, font, spacing).w;
  widths.set(key, w);
  return w;
};

/**
 * Fit text into lines no wider than `width`: one line down to `oneLine`, then the largest size from `max` to `min` at
 * which it wraps into the lines allowed (a word wider than a line shrinks the size first, and is hard-broken only at
 * `min`). When nothing fits at `min` the text is cut: with a "…" if the caller allows it, and always with cut: true.
 */
export function fitLines(str: string, o: FitOptions): Fit {
  const words = String(str ?? "").split(/\s+/).filter(Boolean);
  const spacing = o.spacing ?? 0, step = o.step ?? 2, min = o.min, max = Math.max(o.min, o.max);
  const measure = o.measure ?? measured;
  const w = (s: string, z: number) => measure(s, o.font(z), spacing);
  const room = (z: number) => (typeof o.width === "function" ? o.width(z) : o.width);
  const most = (z: number) => Math.min(o.lines ?? (o.box ? Infinity : 1),
                                        o.box ? Math.max(1, Math.floor(o.box.height / (z * o.box.leading) + 1e-6)) : Infinity);
  const sizes: number[] = [];
  for (let z = max; z > min; z -= step) sizes.push(z);
  sizes.push(min);
  if (!words.length) return { lines: [], size: max, cut: false };

  const greedy = (z: number, R: number, hard = false): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (w(next, z) <= R) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (hard && w(line, z) > R) {
        const chars = Array.from(line);
        let lo = 1, hi = chars.length - 1; // the longest head that fits, at least one character
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (w(chars.slice(0, mid).join(""), z) <= R) lo = mid;
          else hi = mid - 1;
        }
        out.push(chars.slice(0, lo).join(""));
        line = chars.slice(lo).join("");
      }
    }
    if (line) out.push(line);
    return out;
  };
  // the narrowest width that still wraps into n lines: the longest line as short as it can be
  const balanced = (z: number, R: number, n: number): string[] => {
    let lo = Math.max(...words.map((x) => w(x, z))), hi = R;
    for (let i = 0; i < 18 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      if (greedy(z, mid).length <= n) hi = mid;
      else lo = mid;
    }
    return greedy(z, hi);
  };

  const whole = words.join(" ");
  const oneLine = o.oneLine ?? (o.box ? max : min);
  for (const z of sizes) if (z >= oneLine && w(whole, z) <= room(z)) return { lines: [whole], size: z, cut: false };
  const balance = o.balance ?? !o.box;
  for (const z of sizes) {
    const R = room(z), n = most(z);
    if (words.some((x) => w(x, z) > R)) continue; // shrink for the widest word before anything breaks it
    const lines = greedy(z, R);
    if (lines.length <= n) return { lines: balance && lines.length > 1 ? balanced(z, R, lines.length) : lines, size: z, cut: false };
  }
  const R = room(min), n = most(min);
  const lines = greedy(min, R, true);
  if (lines.length <= n) return { lines, size: min, cut: false };
  const kept = lines.slice(0, n);
  if (o.ellipsis) {
    let last = kept[n - 1];
    while (last && w(`${last}…`, min) > R) last = last.includes(" ") ? last.replace(/\s+\S*$/, "") : Array.from(last).slice(0, -1).join("");
    kept[n - 1] = `${last}…`;
  }
  return { lines: kept, size: min, cut: true };
}

/** A cut is the last resort: say so in the render log (once per scene and prop), so it is never silent. */
export function reportCut(s: Pick<Ctx, "id" | "type" | "L">, prop: string, fit: Fit): Fit {
  if (fit.cut) once(`cut:${s.id}:${prop}:${s.L.W}x${s.L.H}`, () => console.warn(`[shorted-fit] ${s.id} (${s.type}): ${prop} was cut to fit`));
  return fit;
}

/** Verbatim text (a quote, its citation, a figure) is shown whole or the render fails, naming the scene and the prop. */
export function verbatim(s: Pick<Ctx, "id" | "type">, prop: string, fit: Fit): Fit {
  if (fit.cut) throw new Error(`${s.id} (${s.type}): ${prop} does not fit at the smallest size; it is shown whole or not at all`);
  return fit;
}

/** Green or red only for a direction: up and pos are green, down and neg red, anything else cream. */
export function toneOf(tone: string | null | undefined): "up" | "down" | "flat" {
  return tone === "up" || tone === "pos" ? "up" : tone === "down" || tone === "neg" ? "down" : "flat";
}

/** A small coloured tag. Green and red are reserved for direction (up/down, positive/negative). */
export function tag(str: string, tone: string, L: Layout, seed: number) {
  const dir = toneOf(tone);
  const bg = dir === "up" ? C.up : dir === "down" ? C.down : C.cream;
  return once(`tag:${str}:${dir}:${seed}:${L.W}x${L.H}`, () =>
    FG.label({ text: str, font: F.mono(L, 22, 600), bg, color: bg === C.cream ? C.ink : "#FFFFFF", padX: 12, padY: 6, seed, res: 2 }),
  );
}

/** The ASIC caveat on a cream label above the footer; two lines in portrait. The body ends above it. */
export function drawSuper(ctx: CanvasRenderingContext2D, L: Layout, str: string, t: number): void {
  const lines = L.portrait ? str.split(/(?<=,)\s+/) : [str];
  const pc = once(`super:${str}:${L.W}x${L.H}`, () =>
    FG.label({ text: lines, font: F.mono(L, 19, 500), bg: C.cream, color: C.ink, align: "left", padX: 16, padY: 9, seed: 211, res: 2 }),
  );
  FG.draw(ctx, pc, L.body.x + pc.bbox.w / 2, L.superY, { alpha: fade(t, 0.6, 0.4), elev: 0.6, rot: -0.003 });
}
```

`remotion-composer/src/shorted/scenes/chapter.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, fade, pop, text } from "../theme";
import { Ctx, fitLines, reportCut } from "./common";

/** A chapter card: "No. n" in burnt italic, the title, an optional sub, and paw prints crossing the page. */
export function chapter(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: "" });
  const cx = L.page.x + L.page.w / 2, cy = L.page.y + L.page.h * 0.46;
  const k = pop(t, 0.15, 0.6);
  ctx.save();
  ctx.translate(cx, cy - 40 * L.k);
  ctx.scale(0.7 + 0.3 * k, 0.7 + 0.3 * k);
  text(ctx, `No. ${props.no}`, 0, 0, FG.font.serif(Math.round(150 * L.k), 700, true), C.burnt, "center", k * 2);
  ctx.restore();
  const width = L.page.w - 200;
  const title = reportCut(s, "title", fitLines(props.title, {
    font: (z) => FG.font.serif(z, 700), width, max: Math.round(92 * L.k), oneLine: Math.round(60 * L.k),
    min: Math.round(44 * L.k), lines: 2, ellipsis: true }));
  const pitch = title.size * 1.1;
  title.lines.forEach((ln, i) =>
    text(ctx, ln, cx, cy + 90 * L.k + i * pitch, FG.font.serif(title.size, 700), C.ink, "center", fade(t, 0.45)));
  if (props.sub) {
    const sub = reportCut(s, "sub", fitLines(String(props.sub), {
      font: (z) => FG.font.serif(z, 500, true), width, max: Math.round(34 * L.k), min: Math.round(26 * L.k), lines: 2, ellipsis: true }));
    const y = cy + 90 * L.k + (title.lines.length - 1) * pitch + 60 * L.k;
    sub.lines.forEach((ln, i) =>
      text(ctx, ln, cx, y + i * sub.size * 1.25, FG.font.serif(sub.size, 500, true), "#83361A", "center", fade(t, 0.7)));
  }
  const y0 = L.page.y + L.page.h - 120 * L.k;
  for (let i = 0; i < 4; i++) {
    if (t < 0.5 + i * 0.22) continue;
    const x = cx - 150 * L.k + i * 100 * L.k;
    FG.draw(ctx, FG.props.paw(i), x, y0 + (i % 2 ? -18 : 18) * L.k, { rot: 1.5, s: L.k, elev: 0.3, alpha: 0.85 });
  }
}
```

`remotion-composer/src/shorted/scenes/index.ts`:

```ts
import { layoutFor } from "../theme";
import type { Images, Scene } from "../types";
import { chapter } from "./chapter";
import { drawSuper, type SceneDraw } from "./common";

export const SCENES: Record<string, SceneDraw> = { chapter };

/** The props each scene needs: a mirror of gates.REQUIRED_PROPS (a test compares the two). */
export const REQUIRED: Record<string, string[]> = {
  opening: ["ticker", "company", "kicker"], chapter: ["no", "title"], company: ["name", "ticker", "summary"],
  number_card: ["title", "items", "as_at", "source"], bar_compare: ["title", "items", "as_at", "source"],
  line_chart: ["title", "series", "as_at", "source"], list_card: ["title", "rows", "as_at", "source"],
  quote_card: ["title", "quote", "attribution", "as_at"], plate: ["title", "image", "caption", "as_at"],
  end_card: ["url", "free", "premium", "provenance", "advice"],
};

/** Closed vocabularies, wherever they appear in the props: a mirror of gates.VOCAB (a test compares them). */
export const VOCAB: Record<string, string[]> = {
  unit: ["money", "pct"], axis: ["left", "right"], direction: ["down", "flat", "up"], tone: ["neg", "neutral", "pos"],
};

/** The parts a scene draws from its lists: [list prop, fewest, most, fields each entry needs]. Resolved props only. */
const PARTS: Record<string, [string, number, number, string[]]> = {
  number_card: ["items", 1, 3, ["label", "value"]], bar_compare: ["items", 1, Infinity, ["label", "value", "display"]],
  line_chart: ["series", 1, 2, ["label", "points", "last"]], list_card: ["rows", 1, Infinity, ["text"]],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const absent = (v: any): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** A chart needs an axis per side used, two or more plottable points per series in date order, and a window two months
 * labels wide: anything less draws a chart that cannot be read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkChart(props: any, fail: (msg: string) => never): void {
  if (absent(props.axes)) fail("missing prop axes (the timeline computes it)");
  const sides = props.series.map((sr: { axis?: string }) => (sr.axis === "right" ? "right" : "left"));
  if (sides.length === 2 && sides[0] === sides[1]) fail("two series need their own axes: one left, one right");
  const dates: string[] = [];
  props.series.forEach((sr: { points: unknown }, i: number) => {
    const ax = props.axes[sides[i]];
    if (!ax) fail(`axes.${sides[i]} is missing; series[${i}] is drawn against it`);
    if (!(Number.isFinite(ax.min) && Number.isFinite(ax.max) && ax.max > ax.min)) fail(`axes.${sides[i]} needs max > min`);
    const pts = (Array.isArray(sr.points) ? sr.points : []).filter(
      (pt: unknown) => Array.isArray(pt) && Number.isFinite(pt[1]) && Number.isFinite(Date.parse(pt[0])));
    const window = pts.length ? `${pts[0][0]} to ${pts[pts.length - 1][0]}` : "no dated points";
    if (pts.length < 2) fail(`series[${i}] has ${pts.length} point(s) to plot (${window}); a chart needs two or more`);
    if (pts.some((pt: string[], j: number) => j > 0 && !(pt[0] > pts[j - 1][0]))) fail(`series[${i}] points are not in date order (${window})`);
    dates.push(pts[0][0], pts[pts.length - 1][0]);
  });
  const labels = Array.isArray(props.axes.x) ? props.axes.x.length : 0;
  if (labels < 2) {
    fail(`axes.x has ${labels} month label(s) for ${dates.sort()[0]} to ${dates.sort().slice(-1)[0]}; a chart's window needs two or more`);
  }
}

/** Missing or malformed props fail the render, naming the scene, its type and the prop, rather than drawing "undefined". */
export function checkProps(sc: Scene): void {
  const fail = (msg: string): never => {
    throw new Error(`${sc.id} (${sc.type}): ${msg}`);
  };
  const props = sc.props ?? {};
  for (const key of REQUIRED[sc.type] ?? []) if (absent(props[key])) fail(`missing prop ${key}`);
  const part = PARTS[sc.type];
  if (part) {
    const [key, fewest, most, fields] = part;
    const list = props[key];
    if (!Array.isArray(list) || list.length < fewest || list.length > most) {
      fail(`${key} must be a list of ${fewest}${most === Infinity ? " or more" : ` to ${most}`}`);
    }
    list.forEach((entry: Record<string, unknown>, i: number) => {
      for (const f of fields) if (!entry || absent(entry[f])) fail(`missing prop ${key}[${i}].${f}`);
    });
  }
  if (sc.type === "bar_compare") {
    props.items.forEach((it: { value: unknown }, i: number) => {
      if (typeof it.value !== "number" || !Number.isFinite(it.value) || it.value < 0) {
        fail(`items[${i}].value is ${JSON.stringify(it.value)}; bars show values of zero or more`);
      }
    });
  }
  if (sc.type === "line_chart") checkChart(props, fail);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (v: any, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k in VOCAB && x !== null && x !== undefined && !VOCAB[k].includes(x as string)) {
          fail(`${path ? `${path}.` : ""}${k} is ${JSON.stringify(x)}; it must be one of ${VOCAB[k].join(", ")}`);
        }
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(props, "");
}

/** Draw one scene at a local time (seconds from its start), plus the ASIC caveat when it carries one. */
export function drawSceneAt(ctx: CanvasRenderingContext2D, sc: Scene, local: number, W: number, H: number, images: Images): void {
  const L = layoutFor(W, H);
  const draw = SCENES[sc.type];
  if (!draw) throw new Error(`no renderer for scene type ${sc.type}`);
  checkProps(sc);
  draw(ctx, { t: local, dur: sc.end - sc.start, L, props: sc.props, images, id: sc.id, no: sc.no, type: sc.type });
  if (sc.super) drawSuper(ctx, L, sc.super, local);
}
```

- [ ] **Step 8: The scene sheet, the root and the sample**

`remotion-composer/src/shorted/ScenePreview.tsx`:

```tsx
import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import { PaperCanvas } from "./PaperCanvas";
import { drawSceneAt } from "./scenes";
import type { SheetProps } from "./types";

/** Frame i shows scenes[i] at local time `at`: one bundle renders a still of every scene. */
export const ShortedSceneSheet: React.FC<SheetProps> = (p) => {
  const frame = useCurrentFrame();
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, _t: number, W: number, H: number) =>
      drawSceneAt(ctx, p.scenes[Math.min(frame, p.scenes.length - 1)], p.at, W, H, p.images),
    [p, frame],
  );
  return <PaperCanvas draw={draw} images={p.images} />;
};
```

`remotion-composer/src/shorted/Root.tsx`:

```tsx
import React from "react";
import { Composition } from "remotion";
import sample from "./sample-timeline.json";
import { ShortedSceneSheet } from "./ScenePreview";
import type { SheetProps } from "./types";

const sheet = sample.sheet as unknown as SheetProps;

export const ShortedRoot: React.FC = () => (
  <>
    <Composition
      id="ShortedSceneSheet" component={ShortedSceneSheet} width={sheet.width} height={sheet.height} fps={30}
      durationInFrames={sheet.scenes.length} defaultProps={sheet}
      calculateMetadata={({ props }) => ({ width: props.width, height: props.height, durationInFrames: props.scenes.length })}
    />
  </>
);
```

`remotion-composer/src/shorted/index.tsx`:

```tsx
import { registerRoot } from "remotion";
import { ShortedRoot } from "./Root";

registerRoot(ShortedRoot);
```

`remotion-composer/src/shorted/sample-timeline.json` (fictional data, for the Studio and the tests):

```json
{
  "sheet": {
    "width": 1920, "height": 1080, "at": 2.8,
    "images": {"logo": "shorted/brand/shorted-icon-512.png", "plate_stock_chart": "shorted/textures/grain-card.jpg"},
    "scenes": [
      {"id": "x01", "type": "opening", "chapter": "cold_open", "no": 0, "start": 0, "end": 6, "transition": "cut", "super": null,
       "props": {"ticker": "EXM", "company": "Example Minerals", "kicker": "A field guide to the bears"}},
      {"id": "x02", "type": "chapter", "chapter": "result", "no": 3, "start": 0, "end": 2.5, "transition": "page", "super": null,
       "props": {"no": 3, "title": "The result", "sub": "12 months to 30 Jun 2026"}},
      {"id": "x03", "type": "company", "chapter": "company", "no": 2, "start": 0, "end": 8, "transition": "page", "super": null,
       "props": {"no": 2, "name": "Example Minerals", "ticker": "EXM", "industry": "Metals & Mining", "logo": "logo", "hq": "Perth, WA",
                 "summary": "Example Minerals mines and processes lithium concentrate at two sites in Western Australia and sells it to battery makers in Asia."}},
      {"id": "x04", "type": "number_card", "chapter": "result", "no": 3, "start": 0, "end": 8, "transition": "page", "super": null,
       "props": {"no": 3, "title": "The result",
                 "items": [{"label": "Revenue", "value": "A$216.5M", "prior": "vs A$125.1M a year earlier", "change": "+73.0%", "direction": "up"},
                           {"label": "Net profit", "value": "A$30.8M", "prior": "vs −A$10.4M a year earlier", "change": "", "direction": "up"},
                           {"label": "EPS", "value": "3.5c", "prior": "vs −1.2c a year earlier", "change": "", "direction": "up"}],
                 "as_at": "12 months to 30 Jun 2026", "source": "Company accounts via Shorted"}},
      {"id": "x05", "type": "bar_compare", "chapter": "bears", "no": 6, "start": 0, "end": 7, "transition": "page",
       "super": "ASIC data shows the size of short positions, not who holds them or why.",
       "props": {"no": 6, "title": "Crowding against peers",
                 "items": [{"label": "EXM", "value": 15.07, "display": "15.07%", "highlight": true},
                           {"label": "AAA", "value": 9.1, "display": "9.10%", "highlight": false},
                           {"label": "BBB", "value": 6.4, "display": "6.40%", "highlight": false},
                           {"label": "CCC", "value": 2.2, "display": "2.20%", "highlight": false}],
                 "as_at": "30 Sep 2026", "source": "ASIC via Shorted"}},
      {"id": "x06", "type": "line_chart", "chapter": "bears", "no": 6, "start": 0, "end": 9, "transition": "page",
       "super": "ASIC data shows the size of short positions, not who holds them or why.",
       "props": {"no": 6, "title": "Short interest and price",
                 "series": [
                   {"label": "Short interest", "unit": "pct", "axis": "left", "last": "15.07%",
                    "points": [["2025-10-01", 8.2], ["2025-11-03", 8.9], ["2025-12-01", 9.4], ["2026-01-05", 10.1], ["2026-02-02", 11.6],
                               ["2026-03-02", 12.2], ["2026-04-01", 11.8], ["2026-05-01", 12.9], ["2026-06-01", 13.4], ["2026-07-01", 14.1],
                               ["2026-08-03", 14.6], ["2026-09-01", 14.9], ["2026-09-30", 15.07]]},
                   {"label": "Share price", "unit": "money", "axis": "right", "last": "A$2.41",
                    "points": [["2025-10-01", 1.62], ["2025-11-03", 1.75], ["2025-12-01", 1.9], ["2026-01-05", 2.05], ["2026-02-02", 1.98],
                               ["2026-03-02", 2.2], ["2026-04-01", 2.35], ["2026-05-01", 2.28], ["2026-06-01", 2.5], ["2026-07-01", 2.62],
                               ["2026-08-03", 2.48], ["2026-09-01", 2.39], ["2026-09-30", 2.41]]}],
                 "axes": {"left": {"min": 0, "max": 16, "ticks": [{"v": 0, "label": "0.0%"}, {"v": 4, "label": "4.0%"}, {"v": 8, "label": "8.0%"}, {"v": 12, "label": "12.0%"}, {"v": 16, "label": "16.0%"}]},
                          "right": {"min": 0, "max": 3, "ticks": [{"v": 0, "label": "A$0.00"}, {"v": 1, "label": "A$1.00"}, {"v": 2, "label": "A$2.00"}, {"v": 3, "label": "A$3.00"}]},
                          "x": [{"t": "2025-10-01", "label": "Oct 2025"}, {"t": "2026-01-01", "label": "Jan 2026"}, {"t": "2026-04-01", "label": "Apr 2026"}, {"t": "2026-07-01", "label": "Jul 2026"}]},
                 "as_at": "30 Sep 2026", "source": "ASIC short position reports via Shorted"}},
      {"id": "x07", "type": "list_card", "chapter": "news", "no": 7, "start": 0, "end": 8, "transition": "page", "super": null,
       "props": {"no": 7, "title": "In the news",
                 "rows": [{"date": "28 Sep", "text": "Example Minerals signs an offtake agreement with a battery maker", "tag": "positive", "tone": "pos"},
                          {"date": "15 Sep", "text": "Quarterly activities report", "tag": "neutral", "tone": "neutral"},
                          {"date": "2 Sep", "text": "A director sells shares on market", "value": "A$1.2M", "tone": "neg"}],
                 "as_at": "28 Sep 2026", "source": "Shorted news"}},
      {"id": "x08", "type": "quote_card", "chapter": "outlook", "no": 5, "start": 0, "end": 8, "transition": "page", "super": null,
       "props": {"no": 5, "title": "The outlook", "attribution": "Example Minerals annual report", "as_at": "27 Aug 2026",
                 "quote": "We expect production to remain within the guided range, subject to weather and the timing of the processing upgrade."}},
      {"id": "x09", "type": "plate", "chapter": "bears", "no": 6, "start": 0, "end": 6, "transition": "page", "super": "ASIC data shows the size of short positions, not who holds them or why.",
       "props": {"no": 6, "title": "On Shorted", "image": "plate_stock_chart", "caption": "the stock page, live", "as_at": "7 Oct 2026"}},
      {"id": "x10", "type": "end_card", "chapter": "close", "no": 9, "start": 0, "end": 6, "transition": "page", "super": null,
       "props": {"url": "shorted.com.au", "free": "Free to explore", "premium": "Premium A$4/month: AI chat, alerts, dashboards",
                 "provenance": "Data: ASIC short position reports (T+4 delay)", "advice": "General information only. Not financial advice."}}
    ]
  },
  "long": {
    "cut": "long", "width": 1920, "height": 1080, "fps": 30, "durationInFrames": 540, "ticker": "EXM",
    "images": {"logo": "shorted/brand/shorted-icon-512.png"},
    "scenes": [
      {"id": "l01", "type": "opening", "chapter": "cold_open", "no": 0, "start": 0, "end": 5, "transition": "cut", "super": null,
       "props": {"ticker": "EXM", "company": "Example Minerals", "kicker": "A field guide to the bears"}},
      {"id": "l02", "type": "chapter", "chapter": "result", "no": 3, "start": 5, "end": 7.5, "transition": "page", "super": null,
       "props": {"no": 3, "title": "The result", "sub": "12 months to 30 Jun 2026"}},
      {"id": "l03", "type": "number_card", "chapter": "result", "no": 3, "start": 7.5, "end": 13, "transition": "page", "super": null,
       "props": {"no": 3, "title": "The result",
                 "items": [{"label": "Revenue", "value": "A$216.5M", "prior": "vs A$125.1M a year earlier", "change": "+73.0%", "direction": "up"}],
                 "as_at": "12 months to 30 Jun 2026", "source": "Company accounts via Shorted"}},
      {"id": "l04", "type": "end_card", "chapter": "close", "no": 9, "start": 13, "end": 18, "transition": "page", "super": null,
       "props": {"url": "shorted.com.au", "free": "Free to explore", "premium": "Premium A$4/month: AI chat, alerts, dashboards",
                 "provenance": "Data: ASIC short position reports (T+4 delay)", "advice": "General information only. Not financial advice."}}
    ],
    "captions": [{"start": 0.6, "end": 3.2, "text": "Example Minerals, and the bears.", "words": []},
                 {"start": 7.8, "end": 11.4, "text": "Revenue came in at 216.5 million dollars.", "words": []}],
    "showCaptions": true, "wordCaptions": false
  },
  "short": {
    "cut": "short", "width": 1080, "height": 1920, "fps": 30, "durationInFrames": 450, "ticker": "EXM",
    "images": {"logo": "shorted/brand/shorted-icon-512.png"},
    "scenes": [
      {"id": "t01", "type": "opening", "chapter": "cold_open", "no": 0, "start": 0, "end": 4.5, "transition": "cut", "super": null,
       "props": {"ticker": "EXM", "company": "Example Minerals", "kicker": "A field guide to the bears"}},
      {"id": "t02", "type": "number_card", "chapter": "result", "no": 3, "start": 4.5, "end": 10, "transition": "page", "super": null,
       "props": {"no": 3, "title": "The result",
                 "items": [{"label": "Revenue", "value": "A$216.5M", "prior": "vs A$125.1M a year earlier", "change": "+73.0%", "direction": "up"}],
                 "as_at": "12 months to 30 Jun 2026", "source": "Company accounts via Shorted"}},
      {"id": "t03", "type": "end_card", "chapter": "close", "no": 9, "start": 10, "end": 15, "transition": "page", "super": null,
       "props": {"url": "shorted.com.au", "free": "Free to explore", "premium": "Premium A$4/month: AI chat, alerts, dashboards",
                 "provenance": "Data: ASIC short position reports (T+4 delay)", "advice": "General information only. Not financial advice."}}
    ],
    "captions": [
      {"start": 0.6, "end": 1.6, "text": "Example Minerals, and", "words": [{"w": "Example", "s": 0.6, "e": 0.95}, {"w": "Minerals,", "s": 0.95, "e": 1.4}, {"w": "and", "s": 1.4, "e": 1.6}]},
      {"start": 1.6, "end": 2.6, "text": "the bears.", "words": [{"w": "the", "s": 1.6, "e": 1.8}, {"w": "bears.", "s": 1.8, "e": 2.6}]},
      {"start": 4.8, "end": 6.2, "text": "Revenue came in at", "words": [{"w": "Revenue", "s": 4.8, "e": 5.3}, {"w": "came", "s": 5.3, "e": 5.6}, {"w": "in", "s": 5.6, "e": 5.75}, {"w": "at", "s": 5.75, "e": 6.2}]}
    ],
    "showCaptions": true, "wordCaptions": true
  },
  "thumb": {"headline": ["Know where", "the bears are."], "kicker": "A field guide to the bears", "ticker": "EXM",
            "company": "Example Minerals", "logo": "logo", "images": {"logo": "shorted/brand/shorted-icon-512.png"}}
}
```

- [ ] **Step 9: The fit tests**

`fitLines` is tested without a browser, and every scene is rendered with the longest text the gates admit. The fit test
reads the registered types from `scenes/index.ts`, so each later scene task is covered as it registers its scenes; the
chart, timeline and thumbnail cases skip until Tasks 15, 17 and 20 exist.

`tests/shorted/fit_lines.test.mjs` (run by `test_fit_lines_without_a_browser`):

```js
// fitLines and fitSize without a browser: scenes/common.ts bundled with esbuild, the paper engine stubbed by a
// measurer that gives every character 0.6 em (so widths are exact). Run from remotion-composer: node <this file>.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rc = resolve(process.cwd());
const esbuild = createRequire(join(rc, "package.json"))("esbuild");
const dir = mkdtempSync(join(tmpdir(), "fitlines-"));
const stub = join(dir, "engine.js");
writeFileSync(stub, `
const size = (font) => Number(/(\\d+(?:\\.\\d+)?)px/.exec(font)[1]);
export const FG = {
  font: { serif: (z, w = 600) => w + " " + z + "px serif", mono: (z, w = 500) => w + " " + z + "px mono" },
  measure: (text, font, spacing = 0) => ({ w: Array.from(text).length * (0.6 * size(font) + spacing) }),
  img: {},
};`);
const out = join(dir, "common.mjs");
await esbuild.build({
  entryPoints: [join(rc, "src/shorted/scenes/common.ts")], bundle: true, format: "esm", platform: "node", outfile: out,
  logLevel: "error",
  plugins: [{ name: "stub-engine", setup: (b) => b.onResolve({ filter: /(^|\/)engine$/ }, () => ({ path: stub })) }],
});
const { fitLines, fitSize } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const font = (z) => `500 ${z}px mono`;
const width = (line, z) => Array.from(line).length * 0.6 * z;
const check = (name, fn) => {
  fn();
  console.log(`ok - ${name}`);
};

check("fits on one line at the largest size", () => {
  assert.deepEqual(fitLines("Short title", { font, width: 600, max: 40, min: 20 }), { lines: ["Short title"], size: 40, cut: false });
});

check("shrinks to fit one line before it wraps", () => {
  const f = fitLines("a".repeat(30), { font, width: 600, max: 40, min: 20, lines: 2 }); // 30 chars x 0.6 x 40 = 720
  assert.deepEqual([f.lines.length, f.cut], [1, false]);
  assert.ok(f.size < 40 && width(f.lines[0], f.size) <= 600);
});

check("wraps into the lines allowed, splitting so the longest line is shortest", () => {
  const f = fitLines("aaa bbb ccc ddd", { font, width: 11 * 6, max: 10, min: 10, lines: 2 }); // 11 characters a line
  assert.deepEqual(f.lines, ["aaa bbb", "ccc ddd"]); // greedy would leave "aaa bbb ccc" over "ddd"
});

check("height-driven: lines grow as the size shrinks", () => {
  const text = Array.from({ length: 40 }, () => "word").join(" ");
  const f = fitLines(text, { font, width: 300, max: 30, min: 10, box: { height: 200, leading: 1.25 } });
  assert.equal(f.cut, false);
  assert.ok(f.lines.length <= Math.floor(200 / (f.size * 1.25)));
  assert.ok(f.lines.length > Math.floor(200 / (30 * 1.25))); // more lines than fit at the largest size
  assert.equal(f.lines.join(" "), text); // a paragraph wraps greedily, every word kept in order
});

check("a word wider than a line shrinks the size first, then is hard-broken only at the floor", () => {
  const url = "https://example.com/" + "x".repeat(60);
  const f = fitLines(`see ${url} now`, { font, width: 400, max: 20, min: 12, lines: 6 });
  assert.equal(f.size, 12);
  assert.equal(f.cut, false);
  assert.ok(f.lines.every((l) => width(l, f.size) <= 400), JSON.stringify(f.lines));
  assert.equal(f.lines.join("").replace(/\s/g, ""), `see${url}now`); // nothing lost
});

check("an ellipsis only as a last resort, only when allowed, and inside the width", () => {
  const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const o = { font, width: 200, max: 20, min: 16, lines: 2 };
  const plain = fitLines(text, o);
  assert.equal(plain.cut, true);
  assert.ok(!plain.lines.join(" ").includes("…"));
  const cut = fitLines(text, { ...o, ellipsis: true });
  assert.equal(cut.cut, true);
  assert.equal(cut.lines.length, 2);
  assert.ok(cut.lines[1].endsWith("…") && width(cut.lines[1], cut.size) <= 200);
});

check("width may depend on the size (a label's padding)", () => {
  const f = fitLines("a".repeat(20), { font, width: (z) => 300 - 1.1 * z, max: 30, min: 10 });
  assert.ok(width(f.lines[0], f.size) <= 300 - 1.1 * f.size);
});

check("no line is ever wider than the width (random text, random boxes)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => "m".repeat(1 + Math.floor(rnd() * 30)));
    const o = { font, width: 80 + rnd() * 600, max: 40, min: 12, lines: 1 + Math.floor(rnd() * 5), ellipsis: rnd() < 0.5 };
    const f = fitLines(words.join(" "), o);
    assert.ok(f.lines.every((l) => width(l, f.size) <= o.width + 1e-6), JSON.stringify({ o, f }));
    assert.ok(f.lines.length <= o.lines && f.size >= o.min && f.size <= o.max);
    if (!f.cut) assert.equal(f.lines.join("").replace(/\s/g, ""), words.join(""));
  }
});

check("fitSize clamps at its floor", () => {
  assert.equal(fitSize("x".repeat(100), font, 10, 92, 40), 40); // the walk 92, 88, ... would otherwise end at 36
});
```

`tests/shorted/test_scene_fit.py`:

```python
"""Every scene type drawn with the longest text the gates admit (gates.TEXT_BUDGETS, in its cut's aspect), plus the chart,
bar and plate edge cases: the render does not throw, nothing is cut, no ink passes the safe line, and no chart label
touches a line. Slow: it renders one sheet per cut."""
import importlib.util
import json
import math
import re
import shutil
import subprocess
from datetime import date, timedelta
from functools import cache
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tests.shorted.conftest import fixture_api
from tools.shorted.bindings import get_path, placeholders, resolve_props
from tools.shorted.dossier import build_dossier
from tools.shorted.formatters import render
from tools.shorted.gates import END_CARD, TEXT_BUDGETS
from tools.shorted.lint import CAVEAT
from tools.shorted.values import Source, Value

STUDIO = Path(__file__).resolve().parents[2]
RC = STUDIO / "remotion-composer"
OUT = STUDIO / "tests/shorted/_out/fit"
ASPECT = {"long": (1920, 1080), "short": (1080, 1920)}
# Wide but real words (capitals, m and w): budgets hold for text at least this wide, not just for typical text.
WIDE = ("Woolworths Wesfarmers Commonwealth Westpac Mammoth Network Macmillan Woodside Momentum Holdings Management "
        "Mowbray Hawthorn Warrnambool Wollongong Wodonga Mandurah Monadelphous Northwest Wellington Woomera Wombat")
# Numeric-dense guidance, the narrowest-fitting kind of quote, with a run as long as the gates allow (28 characters).
DENSE = ("FY27 CAPEX of US$1,250M-US$1,400M; EBITDA US$3,100M-US$3,400M; NPAT A$412.6M-A$455.9M; FCF/NPAT >85%; "
         "NIM 1.98%-2.04%; CET1 ≥11.5%; DPS 25.5c-28.0c fully franked; US$1,250.5M-US$1,400.5M(FY27); AISC "
         "A$1,845-A$1,960/oz; production 310,000-335,000oz; capex A$180-200m; payout 60-70% of NPAT; gearing 15-20%;")
INDUSTRY = "Pharmaceuticals, Biotechnology & Life Sciences"  # the longest of the 25 GICS industry groups
PLATE = "shorted-runs/fit-test/plate.png"  # the tallest capture Task 18 makes (MAX_ASPECT): 1098 wide, 1.7x as tall
SRC = Source("GetStockData", {}, "2026-10-07T00:00:00+00:00")
SHORT = {"label": "Short interest", "points": "{{short.series_1y|series}}", "unit": "pct", "axis": "left",
         "last": "{{short.pct|pct}}"}
PRICE = {"label": "Share price", "points": "{{price.series_1y|series}}", "unit": "money", "axis": "right",
         "last": "{{price.close|money}}"}
TIMELINE = importlib.util.find_spec("tools.shorted.timeline") is not None  # the chart cases use its axis code


def text_of(n: int, corpus: str = WIDE) -> str:
    """Exactly n characters of corpus, repeated as needed, never ending in a space."""
    out = ((corpus + " ") * (n // (len(corpus) + 1) + 2))[:n]
    return out[:-1] + "m" if out.endswith(" ") else out


def scene(kind: str, sid: str, props: dict, sup: str | None = None, end: float = 8) -> dict:
    return {"id": f"{kind}-{sid}", "type": kind, "chapter": "x", "no": 5, "start": 0, "end": end, "transition": "page",
            "super": sup, "props": props}


def budget_scenes(kind: str, cut: str) -> list[dict]:
    """The worst case each budget admits for one scene type: every text at its limit at once."""
    b = TEXT_BUDGETS[cut]
    card = {"no": 5, "as_at": "12 months to 30 Jun 2026", "source": "ASIC short position reports via Shorted"}
    if kind == "opening":
        return [scene(kind, "a", {"ticker": "WWW", "company": text_of(b["company"]), "kicker": text_of(b["kicker"])}, end=6)]
    if kind == "chapter":
        return [scene(kind, "a", {"no": 9, "title": text_of(b["chapter_title"]), "sub": text_of(b["chapter_sub"])}, end=2.5)]
    if kind == "company":
        return [scene(kind, "a", {"no": 2, "name": text_of(b["name"]), "ticker": "WWW", "industry": INDUSTRY, "logo": "logo",
                                  "hq": "North Melbourne, VIC", "summary": text_of(b["summary"], WIDE.lower())})]
    if kind == "number_card":
        def items(n: int, three: str) -> list[dict]:
            return [{"label": text_of(b[f"label{three}"]), "value": "−US$131.7B", "change": "+1234.5%", "direction": "up",
                     "prior": text_of(b[f"prior{three}"])} for _ in range(n)]
        return [scene(kind, "three", {**card, "title": text_of(b["title"]), "items": items(3, "_3")}, CAVEAT),
                scene(kind, "two", {**card, "title": text_of(b["title"]), "items": items(2, "")}, CAVEAT),
                scene(kind, "one", {**card, "title": text_of(b["title"]), "items": items(1, "")})]
    if kind == "bar_compare":
        bars = [{"label": text_of(b["bar_label"]), "value": 131.7e9 - i * 9e9, "display": "−US$131.7B", "highlight": i == 2}
                for i in range(6)]
        return [scene(kind, "a", {**card, "title": text_of(b["title"]), "items": bars}, CAVEAT)]
    if kind == "line_chart":
        days = [f"2025-{m:02d}-01" for m in range(10, 13)] + [f"2026-{m:02d}-01" for m in range(1, 10)]
        ticks = lambda vals, fmt: [{"v": v, "label": fmt(v)} for v in vals]  # noqa: E731
        series = [{"label": text_of(b["series_label"]), "unit": "pct", "axis": "left", "last": "15.07%",
                   "points": [[d, 8 + i * 0.6] for i, d in enumerate(days)]},
                  {"label": text_of(b["series_label"]), "unit": "money", "axis": "right", "last": "US$131.7B",
                   "points": [[d, 120e9 + i * 1e9] for i, d in enumerate(days)]}]
        axes = {"left": {"min": 0, "max": 16, "ticks": ticks([0, 4, 8, 12, 16], lambda v: f"{v:.1f}%")},
                "right": {"min": 0, "max": 140e9, "ticks": ticks([0, 35e9, 70e9, 105e9, 140e9], lambda v: f"US${v / 1e9:.1f}B")},
                "x": [{"t": d, "label": f"{m} {y}"} for d, m, y in (("2025-10-01", "Oct", 2025), ("2026-01-01", "Jan", 2026),
                                                                     ("2026-04-01", "Apr", 2026), ("2026-07-01", "Jul", 2026))]}
        return [scene(kind, "a", {**card, "title": text_of(b["title"]), "series": series, "axes": axes}, CAVEAT)]
    if kind == "list_card":
        rows = [{"date": "30 Sep", "text": text_of(b["headline"]), "tag": "announcement", "tone": "neutral"} for _ in range(4)]
        rows.append({"date": "30 Sep", "text": text_of(b["headline_value"]), "value": "−A$161.8K", "tag": "100% franked",
                     "tone": "neg"})
        return [scene(kind, "a", {**card, "title": text_of(b["title"]), "rows": rows}, CAVEAT)]
    if kind == "quote_card":
        return [scene(kind, "a", {"no": 5, "title": text_of(b["title"]), "quote": text_of(b["quote"], DENSE),
                                  "attribution": text_of(b["attribution"]), "as_at": "26 Feb 2026"})]
    if kind == "plate":
        return [scene(kind, "a", {"no": 6, "title": text_of(b["title"]), "image": "plate",
                                  "caption": text_of(b["plate_caption"]), "as_at": "30 Sep 2026"}, CAVEAT)]
    if kind == "end_card":
        return [scene(kind, "a", dict(END_CARD), end=6)]
    raise KeyError(f"no budget worst case for scene type {kind}; add one here")


def daily(start: str, days: int, f) -> list[list]:
    d0 = date.fromisoformat(start)
    return [[(d0 + timedelta(days=i)).isoformat(), f(i / days)] for i in range(days) if (d0 + timedelta(days=i)).weekday() < 5]


def chart(sid: str, d: dict, raw_series: list[dict]) -> dict:
    """A line chart built the way the timeline builds it: bound props resolved, axes from chart_axes."""
    from tools.shorted.timeline import chart_axes

    first = placeholders(raw_series[0]["points"])[0][0]
    raw = {"no": 6, "title": "Short interest and price", "series": raw_series, "as_at": f"{{{{{first}|as_at}}}}",
           "source": f"{{{{{first}|source}}}}"}
    props, _ = resolve_props(raw, d)
    props["axes"] = chart_axes(raw, props, d)
    return scene("line_chart", sid, props, CAVEAT, end=9)


def synthetic(short: list | None = None, price: list | None = None) -> dict:
    d: dict = {"short": {}, "price": {}}
    if short:
        d["short"] = {"series_1y": Value(short, "series:pct", short[-1][0], "ok", SRC).to_json(),
                      "pct": Value(short[-1][1], "pct", short[-1][0], "ok", SRC).to_json()}
    if price:
        d["price"] = {"series_1y": Value(price, "series:money", price[-1][0], "ok", SRC, currency="AUD").to_json(),
                      "close": Value(price[-1][1], "money", price[-1][0], "ok", SRC, currency="AUD").to_json()}
    return d


@cache
def real(ticker: str) -> dict:
    return build_dossier(ticker, fixture_api(ticker), date(2026, 10, 7))


def flat(sc: dict) -> dict:
    """The same chart with every point on its axis minimum: its labels, ticks and legend are unchanged."""
    out = json.loads(json.dumps(sc))
    out["id"] += "-flat"
    for sr in out["props"]["series"]:
        low = out["props"]["axes"][sr.get("axis") or "left"]["min"]
        sr["points"] = [[t, low] for t, _ in sr["points"]]
    return out


def edge_scenes(kind: str, cut: str) -> list[dict]:
    """The Task 15 review's layout cases (real series where they exist): each must draw without overflow."""
    if kind == "line_chart" and TIMELINE:
        short = daily("2025-10-01", 365, lambda k: round(6 + 9 * k + 0.6 * math.sin(k * 40), 2))
        price = daily("2025-10-01", 365, lambda k: round(2.2 + 0.4 * math.sin(k * 9), 3))
        collapse = daily("2025-10-01", 365, lambda k: round(1.8 * (1 - k) ** 3 + 0.05, 3))
        late = [p for p in price if p[0] >= "2026-02-01"]
        crossing = daily("2025-10-01", 365, lambda k: round(-6 + 14 * math.sin(k * 3), 2))
        out = [chart(f"real-{t.lower()}", real(t), [SHORT, PRICE]) for t in ("BHP", "CBA")]
        out += [flat(sc) for sc in out]
        return out + [chart("price-first", synthetic(short, price), [PRICE, SHORT]),
                      chart("lone-right", synthetic(None, price), [PRICE]),
                      chart("collapse", synthetic(short, collapse), [SHORT, PRICE]),
                      chart("late-price", synthetic(short, late), [SHORT, PRICE]),
                      chart("crossing-zero", synthetic(crossing, None), [SHORT])]
    if kind == "bar_compare":
        card = {"no": 6, "title": "Crowding against peers", "as_at": "30 Sep 2026", "source": "ASIC via Shorted"}
        bars = [("EXM", 15.0, "15.00%"), ("AAA", 0.015, "0.02%"), ("BBB", 0.0, "0.00%"), ("CCC", 0.0, "0.00%")]
        return [scene(kind, "zero", {**card, "items": [{"label": c, "value": v, "display": s, "highlight": i == 0}
                                                       for i, (c, v, s) in enumerate(bars)]}, CAVEAT)]
    if kind == "plate":
        props = {"no": 6, "title": "On Shorted", "image": "plate", "caption": "the stock page, live", "as_at": "30 Sep 2026"}
        return [scene(kind, "caveat", props, CAVEAT), scene(kind, "wide", {**props, "image": "plate_wide"}, CAVEAT)]
    return []


def registered_types() -> list[str]:
    src = (RC / "src/shorted/scenes/index.ts").read_text()
    body = re.search(r"export const SCENES[^{]*\{([^}]*)\}", src).group(1)
    return re.findall(r"\b(\w+)\b", body)


TYPES = registered_types()


def sheet(cut: str, scenes: list[dict], tag: str) -> tuple[subprocess.CompletedProcess, Path]:
    """Render scenes into frames (frame i is scenes[i], at 4 s: everything settled)."""
    W, H = ASPECT[cut]
    out = OUT / f"{tag}-{cut}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    staged = RC / "public" / PLATE
    staged.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (1098, 1866), (250, 247, 240)).save(staged)
    Image.new("RGB", (1440, 900), (250, 247, 240)).save(staged.with_name("wide.png"))
    props = out / "props.json"
    props.write_text(json.dumps({"width": W, "height": H, "at": 4.0, "scenes": scenes, "images": {
        "logo": "shorted/brand/shorted-icon-512.png", "plate": PLATE, "plate_wide": PLATE.replace("plate.png", "wide.png")}},
        ensure_ascii=False))
    try:
        res = subprocess.run(["npx", "remotion", "render", "src/shorted/index.tsx", "ShortedSceneSheet", str(out / "frames"),
                              f"--props={props}", "--sequence", "--image-format=png"], cwd=RC, capture_output=True,
                             text=True, timeout=900)
    finally:
        shutil.rmtree(staged.parent, ignore_errors=True)
    return res, out / "frames"


@cache
def rendered(cut: str) -> tuple[list[np.ndarray], list[dict], str]:
    scenes = [s for kind in TYPES for s in budget_scenes(kind, cut) + edge_scenes(kind, cut)]
    res, folder = sheet(cut, scenes, "sheet")
    log = res.stdout + res.stderr
    assert res.returncode == 0, log[-3000:]
    frames = sorted(folder.glob("*.png"), key=lambda p: int(re.findall(r"\d+", p.stem)[-1]))
    assert len(frames) == len(scenes)
    return [np.asarray(Image.open(f).convert("RGB"), dtype=np.int16) for f in frames], scenes, log


def ink(a: np.ndarray) -> np.ndarray:
    """Text and line ink: warm and dark (the inks are R > G; paper is light)."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r - g >= 5) & ((r + g + b) / 3 < 135) & (r > 55)


def desk_ink(a: np.ndarray) -> np.ndarray:
    """Anything warm on the green desk (R < G), so even dark text that spills off the page is found."""
    return (a[..., 0] - a[..., 1] >= 3) & (a[..., 0] > 62)


def overflow(frame: np.ndarray, cut: str, kind: str) -> list[str]:
    """Where ink passes the safe line: off the page, between the body's right edge and the page's, or out of the
    opening's safe width (calibrated: 0 hits on clean frames, and every overflow the Task 14 and 15 stress found)."""
    W, H = ASPECT[cut]
    found = []
    if kind == "opening":
        lo, hi = (160, 920) if cut == "short" else (160, W - 160)
        ty = int(H * (0.24 if cut == "short" else 0.2))
        band = frame[ty - 120: ty + 160]
        dark = (band[..., 0] < 90) & (band[..., 1] < 80) & (band[..., 2] < 75)  # the labels' text colour
        cols = np.where(dark.sum(axis=0) > 2)[0]
        if len(cols) and (cols.min() < lo or cols.max() > hi):
            found.append(f"label text spans x {cols.min()}..{cols.max()}, outside {lo}..{hi}")
        return found
    page_r, body_r, page_b = (970, 920, 1420) if cut == "short" else (1810, 1740, 990)
    if (n := int(desk_ink(frame[:, page_r + 6:]).sum())) > 40:
        found.append(f"{n} px of ink right of the page")
    if (n := int(desk_ink(frame[page_b + 6:, :]).sum())) > 40:
        found.append(f"{n} px of ink below the page")
    if (n := int(ink(frame[:, body_r + 6: page_r - 4]).sum())) > 40:
        found.append(f"{n} px of ink between the body's edge (x {body_r}) and the page's")
    return found


def test_every_registered_type_has_a_budget_worst_case():
    for cut in ASPECT:
        for kind in TYPES:
            assert budget_scenes(kind, cut), kind


@pytest.mark.skipif(not TIMELINE, reason="the timeline is not built yet")
@pytest.mark.parametrize("ticker", ["BHP", "CBA", "DRO", "TLX"])
def test_a_charts_latest_value_is_where_its_line_ends(ticker):
    """The legend shows each series' latest value: it is the dossier's own last point, as formatted."""
    d = real(ticker)
    props = chart("x", d, [SHORT, PRICE])["props"]
    for raw, sr in zip((SHORT, PRICE), props["series"]):
        series = get_path(d, placeholders(raw["points"])[0][0])
        path, fmt = placeholders(raw["last"])[0]
        unit = series.unit.split(":", 1)[1]
        shown = render(Value(sr["points"][-1][1], unit, series.as_at, "ok", series.source, currency=series.currency),
                       fmt, "display")
        assert sr["last"] == shown, (ticker, raw["label"], sr["last"], shown)


@pytest.mark.slow
@pytest.mark.parametrize("cut", list(ASPECT))
@pytest.mark.parametrize("kind", TYPES)
def test_budget_worst_cases_and_edge_cases_fit(kind, cut):
    frames, scenes, log = rendered(cut)
    cuts = [ln for ln in log.splitlines() if "[shorted-fit]" in ln and f"] {kind}-" in ln]
    assert not cuts, cuts  # at its budget nothing is cut; a verbatim cut would have failed the render
    for frame, sc in zip(frames, scenes):
        if sc["type"] == kind:
            assert not overflow(frame, cut, kind), (sc["id"], overflow(frame, cut, kind))


@pytest.mark.slow
@pytest.mark.skipif("line_chart" not in TYPES or not TIMELINE, reason="needs line_chart and the timeline")
@pytest.mark.parametrize("ticker", ["BHP", "CBA"])
def test_chart_labels_never_touch_a_line(ticker):
    """Real series on the phone cut: the label row (legend and latest values) is identical when every line is laid flat
    on its axis, so no line or end marker reaches a label."""
    frames, scenes, _ = rendered("short")
    by_id = {sc["id"]: f for sc, f in zip(scenes, frames)}
    a, b = by_id[f"line_chart-real-{ticker.lower()}"], by_id[f"line_chart-real-{ticker.lower()}-flat"]
    top, area_top = 420 - 6, 420 + int((48 + 40) * 1.1)  # the body's top, and the plot's below two legend rows
    diff = np.abs(a[top:area_top] - b[top:area_top]).max(axis=2)
    assert int((diff > 24).sum()) == 0, int((diff > 24).sum())


@pytest.mark.slow
@pytest.mark.skipif("line_chart" not in TYPES or not TIMELINE, reason="needs line_chart and the timeline")
@pytest.mark.parametrize("change, message", [
    (lambda p: p["series"][0].__setitem__("points", p["series"][0]["points"][-1:]), "series[0] has 1 point(s) to plot"),
    (lambda p: p["axes"].__setitem__("x", p["axes"]["x"][:1]), "axes.x has 1 month label(s) for"),
    (lambda p: p["series"][1].__setitem__("axis", "left"), "two series need their own axes"),
    (lambda p: p["axes"]["left"].__setitem__("max", 0), "axes.left needs max > min"),
], ids=["one point", "one month label", "one side", "flat axis"])
def test_unreadable_charts_fail_the_render_naming_the_window(change, message):
    sc = chart("bad", real("CBA"), [SHORT, PRICE])
    change(sc["props"])
    res, _ = sheet("short", [sc], "bad-chart")
    assert res.returncode != 0 and message in res.stdout + res.stderr, (res.stdout + res.stderr)[-2000:]


@pytest.mark.slow
@pytest.mark.skipif("bar_compare" not in TYPES, reason="bar_compare is not registered yet")
def test_a_negative_bar_fails_the_render_naming_it():
    card = {"no": 6, "title": "Revenue history", "as_at": "30 Jun 2026", "source": "Company accounts via Shorted"}
    items = [{"label": "FY25", "value": -100.0, "display": "−A$100.0M", "highlight": False},
             {"label": "FY26", "value": 30.0, "display": "A$30.0M", "highlight": True}]
    res, _ = sheet("long", [scene("bar_compare", "neg", {**card, "items": items})], "bad-bars")
    assert res.returncode != 0 and "bar_compare-neg (bar_compare): items[0].value is -100" in res.stdout + res.stderr


@pytest.mark.slow
@pytest.mark.skipif(not (RC / "src/shorted/ShortedThumb.tsx").exists(), reason="the thumbnail is not built yet")
@pytest.mark.parametrize("comp, cut", [("ShortedThumb", "long"), ("ShortedCover", "short")])
def test_thumbnail_headline_at_its_budget_fits(comp, cut):
    """The longest headline the gates admit (the stricter of the two aspects, since one headline draws both): it renders,
    stays on the sheet, and on the cover keeps left of layoutFor's safe line (x 920)."""
    most = {k: min(TEXT_BUDGETS["long"][k], TEXT_BUDGETS["short"][k]) for k in ("thumb_rows", "thumb_row", "thumb_kicker")}
    W, H = ASPECT[cut]
    out = OUT / f"thumb-{cut}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    props = out / "thumb.json"
    props.write_text(json.dumps({"headline": [text_of(most["thumb_row"])] * most["thumb_rows"], "ticker": "WWWWW",
                                 "kicker": text_of(most["thumb_kicker"]), "company": text_of(88), "logo": "logo",
                                 "images": {"logo": "shorted/brand/shorted-icon-512.png"}}))
    res = subprocess.run(["npx", "remotion", "still", "src/shorted/index.tsx", comp, str(out / "still.png"), f"--props={props}"],
                         cwd=RC, capture_output=True, text=True, timeout=900)
    assert res.returncode == 0 and "[shorted-fit]" not in res.stdout + res.stderr, (res.stdout + res.stderr)[-2000:]
    a = np.asarray(Image.open(out / "still.png").convert("RGB"), dtype=np.int16)
    rows = slice(int(H * (0.3 if cut == "short" else 0.32)) - 110, int(H * (0.62 if cut == "short" else 0.62)))
    sheet_l, sheet_r = W * 0.08, W * 0.92
    off = lambda part: int(desk_ink(part).sum())  # noqa: E731 (the torn rim reaches about 12 px past the nominal edge)
    assert off(a[rows, : int(sheet_l) - 20]) <= 40 and off(a[rows, int(sheet_r) + 20:]) <= 40
    if cut == "short":
        assert int(ink(a[rows, 926:]).sum()) <= 40, int(ink(a[rows, 926:]).sum())
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q`
Expected: 3 passed, 20 skipped (the next step runs the slow tests; the rest wait for Tasks 15, 17 and 20, and each skip says what it needs).

- [ ] **Step 10: Run the test and look at the sheet**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q -m slow`
Expected: PASS (7 tests; 9 skipped until Tasks 15, 17 and 20). Open `tests/shorted/_out/scenes-landscape.jpg` and `scenes-portrait.jpg`. Each should show a paper page on the green desk with "No. 3", "The result" and the sub. If the page is blank, check the browser console with `npx remotion studio src/shorted/index.tsx`. A missing font or texture under `public/shorted/` is the usual cause (re-run Task 10 Step 5).

- [ ] **Step 11: Commit**

```bash
git add remotion-composer/src/shorted tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py tests/shorted/fit_lines.test.mjs
git commit -m "feat(shorted): paper engine in Remotion; page, chapter card and scene sheet"
```

### Task 13: Opening sting and end card

**Files:**
- Create: `remotion-composer/src/shorted/scenes/opening.ts`, `remotion-composer/src/shorted/scenes/end_card.ts`
- Modify: `remotion-composer/src/shorted/scenes/index.ts` (register both), `tests/shorted/test_remotion.py` (`SCENE_TYPES`, and three tests appended)

**Interfaces:**
- Consumes: `Ctx`, `badge`, `fitLines`, `reportCut`, `drawDesk`, `drawPage`, `once`, `pop`, `fade`, `text`, `wrap`, `C`, `F` (Task 12); engine props `sun`, `cloud`, `ridge`, `tuft`, `signpost`; `FG.drawBear`, `FG.tiptoe`.
- Produces:
  - `opening` with props `{ticker, company, kicker}`. Binoculars sweep a paper landscape and find the ticker on a signpost (0.2–1.8 s), the view opens (2.0–2.6 s), the name and kicker pop (2.7 s, 3.0 s), and the bear host tiptoes in (from 3.0 s, arriving 0.3 s before the cut). The name is fitted inside the safe width: one line down to 60 px (portrait, 64 landscape), then two lines down to 44 px. The kicker is fitted too.
  - `end_card` with props equal to `gates.END_CARD`; the badge uses the image key `shorted_icon`. The premium line breaks after its colon when it wraps, and the bear rides the page's entrance slide.

- [ ] **Step 1: Extend the failing test**

In `tests/shorted/test_remotion.py` change `SCENE_TYPES = ["chapter"]` to:

```python
SCENE_TYPES = ["opening", "chapter", "end_card"]
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: FAIL with `no renderer for scene type opening` in the Remotion error output.

- [ ] **Step 2: Tests the sheet cannot see**

The sheet samples every scene at 2.8 s, after the lens has gone and before the bear walks in, and with one short
name. These render the lens at 0.2 s against the open view at 3 s, three long real names at 4 s, and pin the sample
end cards to the gate's wording.

Append to `tests/shorted/test_remotion.py`:

```python
def render_sheet(aspect: str, at: float, scenes: list[dict], tag: str) -> list[np.ndarray]:
    """Render `scenes` at local time `at` (the sheet draws scenes[i] in frame i); return the frames as RGB arrays."""
    W, H = ASPECTS[aspect]
    out = OUT / f"{tag}-{aspect}-{at}".replace(".", "_")
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    props = out / "props.json"
    props.write_text(json.dumps({**SAMPLE["sheet"], "width": W, "height": H, "at": at, "scenes": scenes}))
    remotion("render", "src/shorted/index.tsx", "ShortedSceneSheet", str(out / "frames"), f"--props={props}",
             "--sequence", "--image-format=png")
    return [np.asarray(Image.open(f).convert("RGB")).astype(int) for f in frames_in(out / "frames")]


def opening_scene(company: str) -> dict:
    return {"id": "o", "type": "opening", "chapter": "cold_open", "no": 0, "start": 0, "end": 6, "transition": "cut",
            "super": None, "props": {"ticker": "XYZ", "company": company, "kicker": "A field guide to the bears"}}


@pytest.mark.slow
@pytest.mark.parametrize("aspect", list(ASPECTS))
def test_opening_lens_shows_the_landscape_unveiled(aspect):
    """Inside the binoculars the scene is shown as it is once the view opens: the veil is cut out, not thinned."""
    scene = opening_scene("Example Minerals")
    early = render_sheet(aspect, 0.2, [scene], "lens")[0]
    clear = render_sheet(aspect, 3.0, [scene], "lens")[0]
    window = early.mean(axis=2) > 120  # the lens window; everything else is under the dark veil
    assert window.sum() > 20_000
    assert np.median(np.abs(early - clear).max(axis=2)[window]) <= 4


@pytest.mark.slow
@pytest.mark.parametrize("aspect", list(ASPECTS))
def test_opening_long_names_stay_inside_the_safe_width(aspect):
    W, H = ASPECTS[aspect]
    names = ["Commonwealth Bank of Australia", "Woodside Energy Group", "Australia and New Zealand Banking Group"]
    lo, hi = (160, 920) if aspect == "portrait" else (160, W - 160)
    ty = H * (0.24 if aspect == "portrait" else 0.2)
    for name, frame in zip(names, render_sheet(aspect, 4.0, [opening_scene(n) for n in names], "names")):
        band = frame[int(ty - 70): int(ty + 70)]
        ink = (band[..., 0] < 90) & (band[..., 1] < 80) & (band[..., 2] < 75)  # the label's text colour
        cols = np.where(ink.sum(axis=0) > 2)[0]
        assert lo <= cols.min() and cols.max() <= hi, (name, cols.min(), cols.max())


def test_sample_end_cards_equal_the_gate_constant():
    """The sheet and both cuts show the wording the gate enforces, so the review sheet is what ships."""
    from tools.shorted.gates import END_CARD

    cards = [s for cut in ("sheet", "long", "short") for s in SAMPLE[cut]["scenes"] if s["type"] == "end_card"]
    assert len(cards) == 3 and all(s["props"] == END_CARD for s in cards)
```

- [ ] **Step 3: The opening sting**

`remotion-composer/src/shorted/scenes/opening.ts`:

```ts
import { FG } from "../engine";
import { C, Layout, once, pop } from "../theme";
import { Ctx, fitLines, reportCut } from "./common";

const ridgeYs = (n: number, base: number, amp: number, seed: number): number[] =>
  Array.from({ length: n }, (_, i) => base + Math.sin(i * 1.3 + seed) * amp + (FG.hash(i, seed) - 0.5) * amp);

/** Binoculars: a dark field with two overlapping lenses, rimmed, cut out on a scratch canvas. */
function drawLens(ctx: CanvasRenderingContext2D, L: Layout, cx: number, cy: number, r: number): void {
  const m: HTMLCanvasElement = once(`lens:${L.W}x${L.H}`, () => FG.canvas(L.W, L.H));
  const g = m.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, L.W, L.H);
  g.fillStyle = "rgba(12,24,20,0.9)";
  g.fillRect(0, 0, L.W, L.H);
  const dx = r * 0.62;
  g.strokeStyle = "#0B0F0D";
  g.lineWidth = 16;
  for (const x of [cx - dx, cx + dx]) {
    g.beginPath();
    g.arc(x, cy, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "#000"; // an opaque fill: destination-out erases by the fill's alpha, and the veil's 0.9 would leave 10% of it
  for (const x of [cx - dx, cx + dx]) {
    g.beginPath();
    g.arc(x, cy, r - 8, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  ctx.drawImage(m, 0, 0);
}

/** The cold open: binoculars find the ticker on a signpost in a paper landscape, then the view opens. */
export function opening(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const { W, H } = L;
  const P = FG.props;
  const ground = H * (L.portrait ? 0.7 : 0.74);
  ctx.fillStyle = "#EFE2C8";
  ctx.fillRect(0, 0, W, H);
  FG.draw(ctx, P.sun(), W * (L.portrait ? 0.7 : 0.8), H * (L.portrait ? 0.1 : 0.2), { rot: t * 0.02, elev: 0.4 });
  FG.draw(ctx, P.cloud(5), W * 0.22 + t * 6, H * 0.17, { elev: 0.5 });
  FG.draw(ctx, P.cloud(9), W * (L.portrait ? 0.62 : 0.78) - t * 4, H * (L.portrait ? 0.4 : 0.46), { elev: 0.5, s: 0.8 });
  const span = { w: W + 160, x0: -80, bottom: H + 40 };
  FG.draw(ctx, P.ridge(`back:${W}x${H}`, ridgeYs(12, ground - H * 0.12, H * 0.05, 3), { ...span, color: C.sage, seed: 3 }), 0, 0, { elev: 0.6 });
  FG.draw(ctx, P.ridge(`front:${W}x${H}`, ridgeYs(9, ground, H * 0.03, 7), { ...span, color: "#4F7A5A", seed: 4 }), 0, 0, { elev: 0.8 });
  const sx = W * (L.portrait ? 0.46 : 0.62), sy = ground + 6;
  const sign = P.signpost(props.ticker);
  FG.draw(ctx, sign.post, sx, sy, { elev: 0.8 });
  FG.draw(ctx, sign.board, sx + 30, sy - 170, { rot: -0.03, elev: 1 });
  for (let i = 0; i < 7; i++) FG.draw(ctx, P.tuft(20 + i), (W / 7) * (i + 0.5) + ((i * 37) % 50), ground + 40 + (i % 3) * 30, { elev: 0.4 });

  const sweep = FG.ease.inOutSine(FG.math.seg(t, 0.2, 1.8));
  const cx = FG.math.lerp(W * 0.12, sx + 30, sweep);
  const cy = FG.math.lerp(H * 0.45, sy - 150, sweep) + Math.sin(t * 3) * 6 * (1 - sweep);
  const open = FG.ease.inCubic(FG.math.seg(t, 2.0, 2.6));
  if (open < 1) drawLens(ctx, L, cx, cy, FG.math.lerp(Math.min(W, H) * 0.24, Math.max(W, H) * 1.2, open));

  // The labels sit centred on W/2, so their paper must end on the safe line: x = 920 in portrait, a 160 px margin in
  // landscape. A label's padding is 0.55 x its font size on each side.
  const half = L.portrait ? 920 - W / 2 : W / 2 - 160;
  const fit = reportCut(s, "company", fitLines(props.company, {
    font: (z) => FG.font.serif(z, 700), width: (z) => 2 * half - 12 - 1.1 * z, max: Math.round((L.portrait ? 72 : 84) * L.k),
    oneLine: Math.round((L.portrait ? 60 : 64) * L.k), min: 44, lines: 2, ellipsis: true }));
  const name = once(`open-name:${fit.lines.join("\n")}:${fit.size}:${W}x${H}`, () =>
    FG.label({ text: fit.lines, font: FG.font.serif(fit.size, 700), bg: C.paper, edge: "torn", rim: 3, seed: 51, res: 1.5 }));
  const kicker = String(props.kicker).toUpperCase();
  const kf = reportCut(s, "kicker", fitLines(kicker, {
    font: (z) => FG.font.mono(z, 600), width: (z) => 2 * half - 12 - 1.1 * z, spacing: 3, max: Math.round(24 * L.k),
    min: Math.round(18 * L.k), ellipsis: true }));
  const kick = once(`open-kick:${kf.lines[0]}:${kf.size}:${W}x${H}`, () =>
    FG.label({ text: kf.lines[0], font: FG.font.mono(kf.size, 600), bg: C.amber, color: C.charcoal, spacing: 3, seed: 52, res: 2 }));
  const ty = H * (L.portrait ? 0.24 : 0.2);
  const k1 = pop(t, 2.7), k2 = pop(t, 3.0);
  FG.draw(ctx, name, W / 2, ty, { s: 0.6 + 0.4 * k1, alpha: Math.min(1, k1 * 3), rot: -0.012, elev: 1.4 });
  FG.draw(ctx, kick, W / 2, ty + name.bbox.h / 2 + kick.bbox.h / 2 + 18, { s: 0.6 + 0.4 * k2, alpha: Math.min(1, k2 * 3), rot: 0.01, elev: 1 });

  if (t > 3.0) {
    // The walk takes 2.2 s, or less when the opening is short, but always ends 0.3 s before the cut: the host arrives.
    const span = Math.min(2.2, Math.max(1.2, s.dur - 3.3));
    const walk = Math.min(t - 3.0, span);
    const stop = sx + (L.portrait ? 300 : 330);
    const x = W + 160 - walk * ((W + 160 - stop) / span);
    const pose = walk < span ? FG.tiptoe(walk * 1.6 * (2.2 / span)) : { look: -0.3 };
    FG.drawBear(ctx, { x, y: ground + 70, s: 0.55 * L.k, flip: -1, ...pose }, t);
  }
}
```

- [ ] **Step 4: The end card**

`remotion-composer/src/shorted/scenes/end_card.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, F, fade, pop, text, wrap } from "../theme";
import { badge, Ctx } from "./common";

/** The end card: badge, URL, the free line, the premium offer, provenance and the advice line; the host waves. */
export function end_card(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  drawDesk(ctx, L);
  const slide = drawPage(ctx, L, t, s.id, { title: "" });
  const cx = L.page.x + L.page.w / 2;
  let y = L.page.y + L.page.h * (L.portrait ? 0.2 : 0.22);
  const kb = pop(t, 0.2);
  FG.draw(ctx, badge("shorted_icon", 86 * L.k, true), cx, y, { s: 0.5 + 0.5 * kb, alpha: Math.min(1, kb * 3), elev: 1.2 });
  y += 190 * L.k;
  text(ctx, props.url, cx, y, FG.font.serif(Math.round(84 * L.k), 700), C.ink, "center", fade(t, 0.5));
  y += 70 * L.k;
  text(ctx, props.free, cx, y, FG.font.serif(Math.round(40 * L.k), 500, true), C.burnt, "center", fade(t, 0.8));
  y += 64 * L.k;
  const premFont = F.mono(L, 26, 600), premW = L.page.w - 200;
  let premium = wrap(props.premium, premFont, premW, 2);
  if (premium.length > 1) {
    // two lines: break after the colon, so the plan and price stay together and the features read as one list
    const parts = String(props.premium).split(/(?<=:)\s+/);
    if (parts.length === 2 && parts.every((p) => FG.measure(p, premFont).w <= premW)) premium = parts;
  }
  premium.forEach((ln, i) => text(ctx, ln, cx, y + i * 36 * L.k, premFont, C.ink, "center", fade(t, 1.0)));
  y += (premium.length * 36 + 40) * L.k;
  text(ctx, props.provenance, cx, y, F.mono(L, 21), C.muted, "center", fade(t, 1.2));
  y += 34 * L.k;
  text(ctx, props.advice, cx, y, F.mono(L, 21, 600), C.ink, "center", fade(t, 1.3));
  const wave = Math.sin(t * 6) * 0.25;
  FG.drawBear(ctx, {
    x: L.page.x + L.page.w - (L.portrait ? 150 : 210), y: L.page.y + L.page.h - 30 + slide, s: 0.5 * L.k, flip: -1,
    armR: -2.5 + wave, elbowR: -0.5, look: -0.2,
  }, t);
}
```

- [ ] **Step 5: Register them**

`remotion-composer/src/shorted/scenes/index.ts` becomes:

```ts
import { layoutFor } from "../theme";
import type { Images, Scene } from "../types";
import { chapter } from "./chapter";
import { drawSuper, type SceneDraw } from "./common";
import { end_card } from "./end_card";
import { opening } from "./opening";

export const SCENES: Record<string, SceneDraw> = { opening, chapter, end_card };

/** The props each scene needs: a mirror of gates.REQUIRED_PROPS (a test compares the two). */
export const REQUIRED: Record<string, string[]> = {
  opening: ["ticker", "company", "kicker"], chapter: ["no", "title"], company: ["name", "ticker", "summary"],
  number_card: ["title", "items", "as_at", "source"], bar_compare: ["title", "items", "as_at", "source"],
  line_chart: ["title", "series", "as_at", "source"], list_card: ["title", "rows", "as_at", "source"],
  quote_card: ["title", "quote", "attribution", "as_at"], plate: ["title", "image", "caption", "as_at"],
  end_card: ["url", "free", "premium", "provenance", "advice"],
};

/** Closed vocabularies, wherever they appear in the props: a mirror of gates.VOCAB (a test compares them). */
export const VOCAB: Record<string, string[]> = {
  unit: ["money", "pct"], axis: ["left", "right"], direction: ["down", "flat", "up"], tone: ["neg", "neutral", "pos"],
};

/** The parts a scene draws from its lists: [list prop, fewest, most, fields each entry needs]. Resolved props only. */
const PARTS: Record<string, [string, number, number, string[]]> = {
  number_card: ["items", 1, 3, ["label", "value"]], bar_compare: ["items", 1, Infinity, ["label", "value", "display"]],
  line_chart: ["series", 1, 2, ["label", "points", "last"]], list_card: ["rows", 1, Infinity, ["text"]],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const absent = (v: any): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** A chart needs an axis per side used, two or more plottable points per series in date order, and a window two months
 * labels wide: anything less draws a chart that cannot be read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkChart(props: any, fail: (msg: string) => never): void {
  if (absent(props.axes)) fail("missing prop axes (the timeline computes it)");
  const sides = props.series.map((sr: { axis?: string }) => (sr.axis === "right" ? "right" : "left"));
  if (sides.length === 2 && sides[0] === sides[1]) fail("two series need their own axes: one left, one right");
  const dates: string[] = [];
  props.series.forEach((sr: { points: unknown }, i: number) => {
    const ax = props.axes[sides[i]];
    if (!ax) fail(`axes.${sides[i]} is missing; series[${i}] is drawn against it`);
    if (!(Number.isFinite(ax.min) && Number.isFinite(ax.max) && ax.max > ax.min)) fail(`axes.${sides[i]} needs max > min`);
    const pts = (Array.isArray(sr.points) ? sr.points : []).filter(
      (pt: unknown) => Array.isArray(pt) && Number.isFinite(pt[1]) && Number.isFinite(Date.parse(pt[0])));
    const window = pts.length ? `${pts[0][0]} to ${pts[pts.length - 1][0]}` : "no dated points";
    if (pts.length < 2) fail(`series[${i}] has ${pts.length} point(s) to plot (${window}); a chart needs two or more`);
    if (pts.some((pt: string[], j: number) => j > 0 && !(pt[0] > pts[j - 1][0]))) fail(`series[${i}] points are not in date order (${window})`);
    dates.push(pts[0][0], pts[pts.length - 1][0]);
  });
  const labels = Array.isArray(props.axes.x) ? props.axes.x.length : 0;
  if (labels < 2) {
    fail(`axes.x has ${labels} month label(s) for ${dates.sort()[0]} to ${dates.sort().slice(-1)[0]}; a chart's window needs two or more`);
  }
}

/** Missing or malformed props fail the render, naming the scene, its type and the prop, rather than drawing "undefined". */
export function checkProps(sc: Scene): void {
  const fail = (msg: string): never => {
    throw new Error(`${sc.id} (${sc.type}): ${msg}`);
  };
  const props = sc.props ?? {};
  for (const key of REQUIRED[sc.type] ?? []) if (absent(props[key])) fail(`missing prop ${key}`);
  const part = PARTS[sc.type];
  if (part) {
    const [key, fewest, most, fields] = part;
    const list = props[key];
    if (!Array.isArray(list) || list.length < fewest || list.length > most) {
      fail(`${key} must be a list of ${fewest}${most === Infinity ? " or more" : ` to ${most}`}`);
    }
    list.forEach((entry: Record<string, unknown>, i: number) => {
      for (const f of fields) if (!entry || absent(entry[f])) fail(`missing prop ${key}[${i}].${f}`);
    });
  }
  if (sc.type === "bar_compare") {
    props.items.forEach((it: { value: unknown }, i: number) => {
      if (typeof it.value !== "number" || !Number.isFinite(it.value) || it.value < 0) {
        fail(`items[${i}].value is ${JSON.stringify(it.value)}; bars show values of zero or more`);
      }
    });
  }
  if (sc.type === "line_chart") checkChart(props, fail);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (v: any, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k in VOCAB && x !== null && x !== undefined && !VOCAB[k].includes(x as string)) {
          fail(`${path ? `${path}.` : ""}${k} is ${JSON.stringify(x)}; it must be one of ${VOCAB[k].join(", ")}`);
        }
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(props, "");
}

/** Draw one scene at a local time (seconds from its start), plus the ASIC caveat when it carries one. */
export function drawSceneAt(ctx: CanvasRenderingContext2D, sc: Scene, local: number, W: number, H: number, images: Images): void {
  const L = layoutFor(W, H);
  const draw = SCENES[sc.type];
  if (!draw) throw new Error(`no renderer for scene type ${sc.type}`);
  checkProps(sc);
  draw(ctx, { t: local, dur: sc.end - sc.start, L, props: sc.props, images, id: sc.id, no: sc.no, type: sc.type });
  if (sc.super) drawSuper(ctx, L, sc.super, local);
}
```

- [ ] **Step 6: Run the test and look**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q && .venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q -m slow`
Expected: 4 passed, 28 skipped, then PASS (15 tests; the same 9 skipped). In the contact sheets, the opening (at 2.8 s) shows the landscape with the view open, the signpost reading EXM, and "Example Minerals" popping in. The end card shows the badge, `shorted.com.au`, the offer lines and the bear. Check that nothing in the portrait sheet sits right of x = 920 except the bear.

- [ ] **Step 7: Commit**

```bash
git add remotion-composer/src/shorted/scenes tests/shorted/test_remotion.py
git commit -m "feat(shorted): opening sting (binoculars find the ticker) and end card"
```

### Task 14: Company and data cards

**Files:**
- Create: `remotion-composer/src/shorted/scenes/{company,number_card,list_card,quote_card}.ts`
- Modify: `remotion-composer/src/shorted/scenes/index.ts`, `tests/shorted/test_remotion.py` (`SCENE_TYPES`)

**Interfaces:**
- Consumes: Task 12 helpers (`Ctx`, `footer`, `badge`, `badgeSpot`, `fitLines`, `reportCut`, `verbatim`, `tag`, `drawDesk`, `drawPage`, `text`, `once`, `pop`, `fade`, `C`, `F`).
- Produces scene renderers for the catalogue props in the storyboard-director skill (Task 2):
  - `company`: the logo image key is optional. The logo badge's rectangle is kept clear by the title (16:9) and by the tags, which stack beside it on 9:16. The summary takes the height above the HQ line. The name strip fits the name only, so ` · ASX:TICKER` is never cut.
  - `number_card`: 1–3 items; columns in 16:9 with a pencil rule between them, rows in 9:16. Every figure shares one size and baseline, and is verbatim. The direction tag sits beside each label, coloured from the change's sign when `direction` is absent. Priors take up to two lines.
  - `list_card`: rows `{date?, text, value?, tag?, tone?}`. Text takes up to 2 lines in 16:9 and 3 in 9:16, where the tag sits under the date.
  - `quote_card`: up to the cut's quote budget (`gates.TEXT_BUDGETS`), verbatim, with the attribution and as-at date. The quote is fitted by height and never cut: a quote or attribution that cannot fit fails the render.

- [ ] **Step 1: Extend the failing test**

In `tests/shorted/test_remotion.py` change `SCENE_TYPES` to:

```python
SCENE_TYPES = ["opening", "chapter", "company", "number_card", "list_card", "quote_card", "end_card"]
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: FAIL with `no renderer for scene type company`.

- [ ] **Step 2: Company**

`remotion-composer/src/shorted/scenes/company.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, fade, once, pop, text } from "../theme";
import { badge, badgeSpot, Ctx, fitLines, reportCut } from "./common";

/**
 * The company in 30 seconds: name, ticker and industry tags, the summary, HQ, a lower-third name strip.
 * The logo badge's rectangle is kept clear by the title (landscape) and the tags (portrait, where they stack).
 */
export function company(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  const logo = props.logo && FG.img[props.logo] ? String(props.logo) : null;
  const spot = badgeSpot(L);
  const avoid = logo ? spot.avoid : null;
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.name, avoid });
  if (logo) {
    const kb = pop(t, 0.3);
    FG.draw(ctx, badge(logo, spot.r, false), spot.x, spot.y, { s: 0.6 + 0.4 * kb, alpha: Math.min(1, kb * 3), elev: 1.2, rot: 0.02 });
  }

  const padX = 14 * k, padY = 8 * k, gap = 18 * k;
  const tagPiece = (lines: string[], size: number, bg: string, seed: number) =>
    once(`co-tag:${lines.join("\n")}:${size}:${bg}:${L.W}x${L.H}`, () =>
      FG.label({ text: lines, font: FG.font.mono(size, 600), bg, color: C.charcoal, padX, padY, seed, res: 2 }));
  const ticker = tagPiece([`ASX: ${props.ticker}`], Math.round(24 * k), C.amber, 60);
  const tags: Array<{ pc: ReturnType<typeof tagPiece>; x: number; y: number }> = [{ pc: ticker, x: b.x, y: b.y + 22 * k }];
  if (props.industry) {
    // portrait stacks the industry tag under the ticker, beside the badge; landscape keeps one row
    const x = L.portrait ? b.x : b.x + ticker.bbox.w + gap;
    const top = L.portrait ? b.y + 22 * k + ticker.bbox.h / 2 + 12 * k : b.y;
    const right = avoid && avoid.y < top + 90 * k && avoid.y + avoid.h > top ? avoid.x - gap : b.x + b.w;
    const fit = reportCut(s, "industry", fitLines(props.industry, {
      font: (z) => FG.font.mono(z, 600), width: right - x - 2 * padX, max: Math.round(24 * k), min: Math.round(18 * k),
      lines: L.portrait ? 2 : 1, ellipsis: true }));
    const pc = tagPiece(fit.lines, fit.size, C.cream, 61);
    tags.push({ pc, x, y: L.portrait ? top + pc.bbox.h / 2 : b.y + 22 * k });
  }
  tags.forEach(({ pc, x, y }, i) => {
    const kt = pop(t, 0.35 + i * 0.15);
    FG.draw(ctx, pc, x + pc.bbox.w / 2, y, { s: 0.7 + 0.3 * kt, alpha: Math.min(1, kt * 3), elev: 0.8 });
  });

  // the name strip (the lower third) fits the name only: " · ASX:TICKER" is never cut
  const suffix = `  ·  ASX:${props.ticker}`;
  const sfont = (z: number) => FG.font.mono(z, 600);
  const sPad = 18 * k, sPadY = 10 * k;
  const nameFit = reportCut(s, "name (strip)", fitLines(props.name, {
    font: sfont, width: (z) => b.w - 2 * sPad - FG.measure(suffix, sfont(z)).w, max: Math.round(24 * k), min: Math.round(18 * k),
    ellipsis: true }));
  const strip = once(`co-strip:${nameFit.lines[0]}${suffix}:${nameFit.size}:${L.W}x${L.H}`, () =>
    FG.label({ text: `${nameFit.lines[0]}${suffix}`, font: sfont(nameFit.size), bg: C.paper, color: C.ink,
               edge: "torn", rim: 3, padX: sPad, padY: sPadY, seed: 64, res: 2 }));
  const stripY = b.y + b.h - 10 * k;

  // the summary takes the height between the tags and the HQ line above the strip; lines grow as the size shrinks
  const y0 = b.y + (L.portrait ? 240 : 110) * k;
  const leading = 1.4, hqGap = 30 * k;
  const bottom = stripY - strip.bbox.h / 2 - 18 * k - (props.hq ? hqGap : 0);
  const sum = reportCut(s, "summary", fitLines(props.summary, {
    font: (z) => FG.font.serif(z, 500), width: b.w, max: Math.round((L.portrait ? 34 : 36) * k), min: Math.round(28 * k),
    box: { height: bottom - y0, leading }, ellipsis: true }));
  const pitch = sum.size * leading;
  sum.lines.forEach((ln, i) => text(ctx, ln, b.x, y0 + i * pitch, FG.font.serif(sum.size, 500), C.ink, "left", fade(t, 0.7 + i * 0.06)));
  if (props.hq) {
    const hq = reportCut(s, "hq", fitLines(props.hq, { font: (z) => FG.font.mono(z, 500), width: b.w, max: Math.round(22 * k),
                                                       min: Math.round(18 * k), ellipsis: true }));
    text(ctx, hq.lines[0], b.x, y0 + sum.lines.length * pitch + hqGap, FG.font.mono(hq.size, 500), C.muted, "left", fade(t, 1.1));
  }
  const ks = pop(t, 1.3);
  FG.draw(ctx, strip, b.x + strip.bbox.w / 2, stripY, { alpha: Math.min(1, ks * 3), s: 0.8 + 0.2 * ks, elev: 1 });
}
```

- [ ] **Step 3: Number card**

`remotion-composer/src/shorted/scenes/number_card.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, pop, text } from "../theme";
import { Ctx, fitLines, footer, reportCut, tag, verbatim } from "./common";

type Item = { label: string; value: string; prior?: string; change?: string; direction?: string };

/** The direction a change shows by its sign, for an item that gives none: the colour never contradicts the sign. */
const signOf = (change: string): string => (change.startsWith("+") ? "up" : /^[−-]/.test(change) ? "down" : "flat");

/** One to three headline figures, each with a direction tag beside its label and its comparison below. */
export function number_card(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const items = props.items as Item[];
  const n = items.length;
  const gutter = L.portrait ? 0 : 56 * k; // landscape columns, with a pencil rule in each gutter
  const colW = L.portrait ? b.w : (b.w - (n - 1) * gutter) / n;
  const serif = (z: number) => FG.font.serif(z, 700);
  // one size for every figure, so they share a baseline and read as a set; it lands from 1.15x, hence the width
  const size = Math.min(...items.map((it, i) => verbatim(s, `items[${i}].value`, fitLines(it.value, {
    font: serif, width: colW / 1.15, max: Math.round((n === 1 ? 140 : L.portrait ? 96 : 104) * k), min: Math.round(44 * k) })).size));
  const tags = items.map((it, i) => (it.change ? tag(it.change, it.direction || signOf(it.change), L, 70 + i) : null));
  const labels = items.map((it, i) => reportCut(s, `items[${i}].label`, fitLines(String(it.label).toUpperCase(), {
    font: (z) => FG.font.mono(z, 600), width: colW - (tags[i] ? tags[i].bbox.w + 18 * k : 0), max: Math.round(22 * k),
    min: Math.round(17 * k), ellipsis: true })));
  const priors = items.map((it, i) => (it.prior ? reportCut(s, `items[${i}].prior`, fitLines(it.prior, {
    font: (z) => FG.font.mono(z, 500), width: colW, max: Math.round(22 * k), min: Math.round(17 * k), lines: 2, ellipsis: true })) : null));
  const priorH = Math.max(0, ...priors.map((p) => (p ? (p.lines.length - 1) * p.size * 1.3 : 0)));
  const blockH = 30 * k + size + 46 * k + priorH + 12 * k;
  const rowH = L.portrait ? b.h / n : b.h;
  const top = L.portrait ? Math.max(0, (rowH - blockH) / 2) : Math.max(0, (b.h - blockH) / 2 - 40 * k);
  items.forEach((it, i) => {
    const x = b.x + (L.portrait ? 0 : i * (colW + gutter));
    const y = b.y + top + (L.portrait ? i * rowH : 0);
    const kk = pop(t, 0.35 + i * 0.55, 0.55);
    if (kk <= 0) return;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, kk * 2.5);
    if (i > 0 && !L.portrait) {
      const rx = x - gutter / 2;
      FG.inkLine(ctx, [[rx, y], [rx, y + blockH]], { width: 1.6, color: C.ink, alpha: 0.22, seed: 80 + i });
    }
    const label = labels[i];
    text(ctx, label.lines[0], x, y + 30 * k, FG.font.mono(label.size, 600), C.muted);
    const pc = tags[i];
    if (pc) FG.draw(ctx, pc, x + FG.measure(label.lines[0], FG.font.mono(label.size, 600)).w + 18 * k + pc.bbox.w / 2, y + 22 * k,
                    { elev: 0.7, rot: -0.01 });
    const baseY = y + 30 * k + size;
    ctx.save();
    ctx.translate(x, baseY);
    const sc = 1.15 - 0.15 * Math.min(1, kk);
    ctx.scale(sc, sc);
    text(ctx, it.value, 0, 0, serif(size), C.charcoal);
    ctx.restore();
    const prior = priors[i];
    prior?.lines.forEach((ln, j) => text(ctx, ln, x, baseY + 46 * k + j * prior.size * 1.3, FG.font.mono(prior.size, 500), C.muted));
    ctx.restore();
  });
  footer(ctx, s, [props.as_at, props.source]);
}
```

- [ ] **Step 4: List card**

`remotion-composer/src/shorted/scenes/list_card.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, F, once, pop, text } from "../theme";
import { Ctx, fitLines, footer, reportCut, tag } from "./common";

type Row = { date?: string; text: string; value?: string; tag?: string; tone?: string };

/**
 * Rows on paper strips (news, insiders, events, strategies, dividends): date, text, value and a tone tag.
 * Portrait stacks the tag under the date, so the text gets the width and up to three lines.
 */
export function list_card(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const rows = props.rows as Row[];
  const rh = Math.min(b.h / Math.max(rows.length, 3), 150 * k);
  const pad = 22 * k, gap = 20 * k;
  const dateFont = F.mono(L, 22, 600), valFont = F.mono(L, 26, 600);
  const tags = rows.map((r, i) => (r.tag ? tag(r.tag, r.tone || "neutral", L, 400 + i) : null));
  const dateW = Math.max(0, ...rows.map((r) => (r.date ? FG.measure(r.date, dateFont).w : 0)));
  const leftW = L.portrait ? Math.max(dateW, ...tags.map((pc) => (pc ? pc.bbox.w : 0))) : dateW;
  rows.forEach((r, i) => {
    const y = b.y + i * rh, cy = y + rh / 2;
    const kk = pop(t, 0.3 + i * 0.32, 0.5);
    if (kk <= 0) return;
    const dx = (1 - Math.min(1, kk)) * -40 * k;
    const strip = once(`row:${Math.round(b.w)}x${Math.round(rh - 14)}:${i}`, () =>
      FG.piece({ poly: FG.shape.rect(-b.w / 2, -(rh - 14) / 2, b.w, rh - 14), color: i % 2 ? C.paper : "#F1E6CF",
                 grain: "recycled", grainAmt: 0.35, seed: 300 + i, light: 0.05, edge: "cut", wobble: 0.6 }));
    ctx.save();
    ctx.globalAlpha *= Math.min(1, kk * 2.5);
    FG.draw(ctx, strip, b.x + b.w / 2 + dx, cy, { elev: 0.5, rot: (i % 2 ? 1 : -1) * 0.002 });
    const x0 = b.x + pad + dx, xr = b.x + b.w - pad + dx;
    const pc = tags[i];
    const valueW = r.value ? FG.measure(r.value, valFont).w + gap : 0;
    const textX = x0 + (leftW ? leftW + gap : 0);
    const right = xr - valueW - (!L.portrait && pc ? pc.bbox.w + gap : 0);
    const fit = reportCut(s, `rows[${i}].text`, fitLines(r.text, {
      font: (z) => FG.font.serif(z, 500), width: right - textX, max: Math.round(30 * k), min: Math.round(26 * k),
      oneLine: Math.round(30 * k), lines: L.portrait ? 3 : 2, ellipsis: true }));
    const lh = fit.size * 1.18;
    const ty = cy + fit.size * 0.35 - ((fit.lines.length - 1) * lh) / 2;
    fit.lines.forEach((ln, li) => text(ctx, ln, textX, ty + li * lh, FG.font.serif(fit.size, 500), C.ink));
    const stacked = L.portrait && pc && r.date;
    if (r.date) text(ctx, r.date, x0, cy + (stacked ? -15 * k : 8 * k), dateFont, C.muted);
    if (r.value) {
      const color = r.tone === "pos" ? C.up : r.tone === "neg" ? C.down : C.charcoal;
      text(ctx, r.value, xr, cy + 9 * k, valFont, color, "right");
    }
    if (pc) {
      if (L.portrait) FG.draw(ctx, pc, x0 + pc.bbox.w / 2, cy + (stacked ? 15 * k : 0), { elev: 0.5 });
      else FG.draw(ctx, pc, xr - valueW - pc.bbox.w / 2, cy, { elev: 0.5 });
    }
    ctx.restore();
  });
  footer(ctx, s, [props.as_at, props.source]);
}
```

- [ ] **Step 5: Quote card**

`remotion-composer/src/shorted/scenes/quote_card.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, fade, once, pop, text } from "../theme";
import { Ctx, fitLines, verbatim } from "./common";

/**
 * A verbatim passage from the filing on a torn clipping, with its attribution and date. Both are shown whole or the
 * render fails: the quote takes the clipping's height (more, smaller lines as it grows) and is never cut.
 */
export function quote_card(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const tx = b.x + 90;
  const cite = verbatim(s, "attribution", fitLines(`— ${props.attribution}, ${props.as_at}`, {
    font: (z) => FG.font.mono(z, 600), width: b.w - 130, max: Math.round(22 * k), min: Math.round(17 * k), lines: 2 }));
  const citeH = (cite.lines.length - 1) * cite.size * 1.3;
  const quote = verbatim(s, "quote", fitLines(props.quote, {
    font: (z) => FG.font.serif(z, 500, true), width: b.w - 160, max: Math.round((L.portrait ? 40 : 42) * k),
    min: Math.round(33 * k), box: { height: b.h - 150 * k - citeH, leading: 1.32 } }));
  const lh = quote.size * 1.32;
  const font = FG.font.serif(quote.size, 500, true);
  const n = quote.lines.length;
  const ch = Math.min(b.h, 180 * k + n * lh + citeH);
  const clip = once(`clip:${Math.round(b.w)}x${Math.round(ch)}`, () =>
    FG.piece({ poly: FG.shape.rect(-b.w / 2, -ch / 2, b.w, ch), color: "#FBF6EA", grain: "recycled", grainAmt: 0.45,
               edge: "torn", rim: 4, tear: 3, seed: 501, light: 0.06 }));
  const kk = pop(t, 0.25, 0.6);
  FG.draw(ctx, clip, b.x + b.w / 2, b.y + ch / 2, { s: 0.92 + 0.08 * Math.min(1, kk), alpha: Math.min(1, kk * 2.5), rot: -0.008, elev: 1.1 });
  text(ctx, "“", b.x + 30, b.y + 120 * k, FG.font.serif(Math.round(160 * k), 700), C.amber, "left", fade(t, 0.4) * 0.6);
  quote.lines.forEach((ln, i) => text(ctx, ln, tx, b.y + 100 * k + i * lh, font, C.ink, "left", fade(t, 0.5 + i * 0.12)));
  const ay = b.y + 100 * k + n * lh + 30 * k;
  cite.lines.forEach((ln, i) =>
    text(ctx, ln, tx, ay + i * cite.size * 1.3, FG.font.mono(cite.size, 600), C.muted, "left", fade(t, 0.6 + n * 0.12)));
}
```

- [ ] **Step 6: Register them**

`remotion-composer/src/shorted/scenes/index.ts` becomes:

```ts
import { layoutFor } from "../theme";
import type { Images, Scene } from "../types";
import { chapter } from "./chapter";
import { drawSuper, type SceneDraw } from "./common";
import { company } from "./company";
import { end_card } from "./end_card";
import { list_card } from "./list_card";
import { number_card } from "./number_card";
import { opening } from "./opening";
import { quote_card } from "./quote_card";

export const SCENES: Record<string, SceneDraw> = { opening, chapter, company, number_card, list_card, quote_card, end_card };

/** The props each scene needs: a mirror of gates.REQUIRED_PROPS (a test compares the two). */
export const REQUIRED: Record<string, string[]> = {
  opening: ["ticker", "company", "kicker"], chapter: ["no", "title"], company: ["name", "ticker", "summary"],
  number_card: ["title", "items", "as_at", "source"], bar_compare: ["title", "items", "as_at", "source"],
  line_chart: ["title", "series", "as_at", "source"], list_card: ["title", "rows", "as_at", "source"],
  quote_card: ["title", "quote", "attribution", "as_at"], plate: ["title", "image", "caption", "as_at"],
  end_card: ["url", "free", "premium", "provenance", "advice"],
};

/** Closed vocabularies, wherever they appear in the props: a mirror of gates.VOCAB (a test compares them). */
export const VOCAB: Record<string, string[]> = {
  unit: ["money", "pct"], axis: ["left", "right"], direction: ["down", "flat", "up"], tone: ["neg", "neutral", "pos"],
};

/** The parts a scene draws from its lists: [list prop, fewest, most, fields each entry needs]. Resolved props only. */
const PARTS: Record<string, [string, number, number, string[]]> = {
  number_card: ["items", 1, 3, ["label", "value"]], bar_compare: ["items", 1, Infinity, ["label", "value", "display"]],
  line_chart: ["series", 1, 2, ["label", "points", "last"]], list_card: ["rows", 1, Infinity, ["text"]],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const absent = (v: any): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** A chart needs an axis per side used, two or more plottable points per series in date order, and a window two months
 * labels wide: anything less draws a chart that cannot be read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkChart(props: any, fail: (msg: string) => never): void {
  if (absent(props.axes)) fail("missing prop axes (the timeline computes it)");
  const sides = props.series.map((sr: { axis?: string }) => (sr.axis === "right" ? "right" : "left"));
  if (sides.length === 2 && sides[0] === sides[1]) fail("two series need their own axes: one left, one right");
  const dates: string[] = [];
  props.series.forEach((sr: { points: unknown }, i: number) => {
    const ax = props.axes[sides[i]];
    if (!ax) fail(`axes.${sides[i]} is missing; series[${i}] is drawn against it`);
    if (!(Number.isFinite(ax.min) && Number.isFinite(ax.max) && ax.max > ax.min)) fail(`axes.${sides[i]} needs max > min`);
    const pts = (Array.isArray(sr.points) ? sr.points : []).filter(
      (pt: unknown) => Array.isArray(pt) && Number.isFinite(pt[1]) && Number.isFinite(Date.parse(pt[0])));
    const window = pts.length ? `${pts[0][0]} to ${pts[pts.length - 1][0]}` : "no dated points";
    if (pts.length < 2) fail(`series[${i}] has ${pts.length} point(s) to plot (${window}); a chart needs two or more`);
    if (pts.some((pt: string[], j: number) => j > 0 && !(pt[0] > pts[j - 1][0]))) fail(`series[${i}] points are not in date order (${window})`);
    dates.push(pts[0][0], pts[pts.length - 1][0]);
  });
  const labels = Array.isArray(props.axes.x) ? props.axes.x.length : 0;
  if (labels < 2) {
    fail(`axes.x has ${labels} month label(s) for ${dates.sort()[0]} to ${dates.sort().slice(-1)[0]}; a chart's window needs two or more`);
  }
}

/** Missing or malformed props fail the render, naming the scene, its type and the prop, rather than drawing "undefined". */
export function checkProps(sc: Scene): void {
  const fail = (msg: string): never => {
    throw new Error(`${sc.id} (${sc.type}): ${msg}`);
  };
  const props = sc.props ?? {};
  for (const key of REQUIRED[sc.type] ?? []) if (absent(props[key])) fail(`missing prop ${key}`);
  const part = PARTS[sc.type];
  if (part) {
    const [key, fewest, most, fields] = part;
    const list = props[key];
    if (!Array.isArray(list) || list.length < fewest || list.length > most) {
      fail(`${key} must be a list of ${fewest}${most === Infinity ? " or more" : ` to ${most}`}`);
    }
    list.forEach((entry: Record<string, unknown>, i: number) => {
      for (const f of fields) if (!entry || absent(entry[f])) fail(`missing prop ${key}[${i}].${f}`);
    });
  }
  if (sc.type === "bar_compare") {
    props.items.forEach((it: { value: unknown }, i: number) => {
      if (typeof it.value !== "number" || !Number.isFinite(it.value) || it.value < 0) {
        fail(`items[${i}].value is ${JSON.stringify(it.value)}; bars show values of zero or more`);
      }
    });
  }
  if (sc.type === "line_chart") checkChart(props, fail);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (v: any, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k in VOCAB && x !== null && x !== undefined && !VOCAB[k].includes(x as string)) {
          fail(`${path ? `${path}.` : ""}${k} is ${JSON.stringify(x)}; it must be one of ${VOCAB[k].join(", ")}`);
        }
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(props, "");
}

/** Draw one scene at a local time (seconds from its start), plus the ASIC caveat when it carries one. */
export function drawSceneAt(ctx: CanvasRenderingContext2D, sc: Scene, local: number, W: number, H: number, images: Images): void {
  const L = layoutFor(W, H);
  const draw = SCENES[sc.type];
  if (!draw) throw new Error(`no renderer for scene type ${sc.type}`);
  checkProps(sc);
  draw(ctx, { t: local, dur: sc.end - sc.start, L, props: sc.props, images, id: sc.id, no: sc.no, type: sc.type });
  if (sc.super) drawSuper(ctx, L, sc.super, local);
}
```

- [ ] **Step 7: Run the test and look**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q && .venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q -m slow`
Expected: 4 passed, 36 skipped, then PASS (23 tests; the same 9 skipped). In both contact sheets, check that:
- every figure and line is legible at thumbnail size;
- no text overruns the page or touches the logo badge;
- the `+73.0%` tag is green and beside REVENUE;
- the as-at/source footer sits above the folio.

- [ ] **Step 8: Commit**

```bash
git add remotion-composer/src/shorted/scenes tests/shorted/test_remotion.py
git commit -m "feat(shorted): company, number, list and quote cards"
```

### Task 15: Charts and plates

**Files:**
- Create: `remotion-composer/src/shorted/scenes/{bar_compare,line_chart,plate}.ts`
- Modify: `remotion-composer/src/shorted/scenes/index.ts`, `tests/shorted/test_remotion.py` (`SCENE_TYPES`)

**Interfaces:**
- Consumes: Task 12 helpers (`fitLines`, `reportCut`, `footer`, `pageTitle`); engine `paperStroke`, `inkLine`, `partial`, `props.plate`, `props.tape`.
- Produces:
  - `bar_compare` with `items: [{label, value, display, highlight}]`. Bars grow from a common baseline, scaled to the longest drawn bar. A true zero is a hairline and a negative value is refused (`drawSceneAt`). The highlighted bar is amber. The label and value columns are as wide as their widest text.
  - `line_chart` with `series[1..2]` and `axes: {left?, right?, x}` (computed in Python, Task 20; the TypeScript only places the labels). Series 0 is an amber paper strip and series 1 a mineral ink line; both draw on over 0.4–2.5 s.
    - Each axis's labels take the colour of the series drawn against it.
    - The latest values sit in the legend row, with an end dot on each line; on 9:16 the legend stacks one series per row.
    - The axis gutters fit the widest tick label, crowded month labels are thinned, and a null is never plotted.
  - `plate` with `image` (an image key), `caption` and `as_at`. The capture is taped to the page. The paper spans the body, so it clears the caveat label. The fitted caption is drawn by the scene (the engine's plate memo ignores captions). The footer reads `data as at <as_at> · captured from shorted.com.au`.

- [ ] **Step 1: Extend the failing test**

In `tests/shorted/test_remotion.py` change `SCENE_TYPES` to every type:

```python
SCENE_TYPES = ["opening", "chapter", "company", "number_card", "bar_compare", "line_chart", "list_card",
               "quote_card", "plate", "end_card"]
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: FAIL with `no renderer for scene type bar_compare`.

- [ ] **Step 2: Bars**

`remotion-composer/src/shorted/scenes/bar_compare.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, F, fade, once, pop, text } from "../theme";
import { Ctx, fitLines, footer, reportCut } from "./common";

type Bar = { label: string; value: number; display: string; highlight: boolean };

/**
 * Horizontal paper bars (peers by short %, revenue history), growing from a common baseline and scaled to the longest
 * drawn bar (values are never negative: drawSceneAt refuses them). A true zero is a hairline. The label column is as
 * wide as the longest label (up to 40% of the body) and the value column as the widest value, so neither is overrun.
 */
export function bar_compare(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const items = props.items as Bar[];
  const max = Math.max(...items.map((it) => it.value), 1e-9);
  const rh = Math.min(b.h / items.length, 110 * k);
  const bh = Math.min(rh * 0.62, 64 * k);
  const lfont = (it: Bar) => (z: number) => FG.font.mono(z, it.highlight ? 700 : 500);
  const lsize = Math.round(26 * k), lmin = Math.round(18 * k), gap = 18 * k;
  const widest = Math.max(...items.map((it) => FG.measure(it.label, lfont(it)(lsize)).w));
  const labelW = Math.min(Math.max(170 * k, widest + gap), b.w * 0.4);
  const labels = items.map((it, i) => reportCut(s, `items[${i}].label`, fitLines(String(it.label), {
    font: lfont(it), width: labelW - gap, max: lsize, min: lmin, lines: rh >= 2.6 * lmin ? 2 : 1, ellipsis: true })));
  const vfont = F.mono(L, 26, 600);
  const valueW = Math.max(...items.map((it) => FG.measure(it.display, vfont).w)) + 16 + 6 * k;
  const barMax = Math.max(6, b.w - labelW - valueW);
  items.forEach((it, i) => {
    const y = b.y + i * rh + rh / 2;
    const kk = pop(t, 0.3 + i * 0.18, 0.7);
    const lab = labels[i], llh = lab.size * 1.15;
    lab.lines.forEach((ln, j) => text(ctx, ln, b.x, y + 9 * k + (j - (lab.lines.length - 1) / 2) * llh, lfont(it)(lab.size),
                                      it.highlight ? C.burnt : C.ink, "left", fade(t, 0.2 + i * 0.1)));
    const w = it.value > 0 ? Math.max(6, (barMax * it.value) / max) : 2;
    const pc = once(`bar:${Math.round(w)}x${Math.round(bh)}:${it.highlight}:${i}`, () =>
      FG.piece({ poly: FG.shape.rect(-w / 2, -bh / 2, w, bh), color: it.highlight ? C.amber : C.sage, grain: "watercolor",
                 grainAmt: 0.55, seed: 600 + i, light: 0.1, edge: "cut", wobble: 0.7 }));
    if (kk > 0) FG.draw(ctx, pc, b.x + labelW, y, { sx: Math.max(0.001, Math.min(1.04, kk)), ax: -w / 2, elev: 0.8 });
    text(ctx, it.display, b.x + labelW + w * Math.min(1, kk) + 16, y + 9 * k, vfont, C.charcoal, "left", fade(t, 0.6 + i * 0.18));
  });
  footer(ctx, s, [props.as_at, props.source]);
}
```

- [ ] **Step 3: Line chart**

`remotion-composer/src/shorted/scenes/line_chart.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage } from "../page";
import { C, F, fade, once, pop, text } from "../theme";
import { Ctx, fitLines, footer, reportCut } from "./common";

type Axis = { min: number; max: number; ticks: { v: number; label: string }[] };
type Series = { label: string; points: [string, number | null][]; unit: string; axis?: "left" | "right"; last: string };

/**
 * One or two series against time: series 0 an amber paper strip, series 1 a mineral ink line, each read against the axis
 * on its side, whose labels take that series' colour. The legend row carries each series' latest value and a dot marks
 * each line's end, so no label sits on the data. Axis gutters fit the widest tick label; crowded month labels thin out.
 */
export function line_chart(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const series = props.series as Series[];
  const axes = props.axes as { left?: Axis; right?: Axis; x: { t: string; label: string }[] };
  const side = (sr: Series) => (sr.axis === "right" ? "right" : "left");
  const colour = (i: number) => (i === 0 ? C.amber : C.mineral);
  const axisTone = (sd: "left" | "right") => (series.findIndex((sr) => side(sr) === sd) === 0 ? C.burnt : C.mineral);
  const tickFont = F.mono(L, 19);
  const widest = (ax?: Axis) => Math.max(0, ...(ax ? ax.ticks.map((tk) => FG.measure(tk.label, tickFont).w) : []));
  const hasRight = series.some((sr) => side(sr) === "right");
  const stack = L.portrait && series.length > 1; // the phone cut gives each series its own legend row
  const rowH = 40 * k, legendH = 48 * k + (stack ? (series.length - 1) * rowH : 0);
  const left = Math.max(96 * k, widest(axes.left) + 14 + 6 * k);
  const right = hasRight ? Math.max(110 * k, widest(axes.right) + 14 + 6 * k) : 20;
  const area = { x: b.x + left, y: b.y + legendH, w: b.w - left - right, h: b.h - legendH - 50 * k };
  const finite = (sr: Series) => sr.points.filter((p): p is [string, number] => Number.isFinite(p[1])); // never plot a null
  const times = series.flatMap((sr) => finite(sr).map((p) => Date.parse(p[0])));
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const X = (iso: string) => area.x + ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * area.w;
  const Y = (v: number, ax: Axis) => area.y + area.h - ((v - ax.min) / (ax.max - ax.min)) * area.h;
  const ga = fade(t, 0.2);
  if (axes.left) {
    for (const tk of axes.left.ticks) {
      const y = Y(tk.v, axes.left);
      ctx.save();
      ctx.globalAlpha *= ga * 0.35;
      ctx.strokeStyle = C.ink;
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
      ctx.restore();
      text(ctx, tk.label, area.x - 14, y + 7, tickFont, axisTone("left"), "right", ga);
    }
  }
  if (axes.right) {
    for (const tk of axes.right.ticks) {
      const y = Y(tk.v, axes.right);
      ctx.save();
      ctx.globalAlpha *= ga * 0.8;
      ctx.strokeStyle = axisTone("right");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(area.x + area.w, y);
      ctx.lineTo(area.x + area.w + 8 * k, y);
      ctx.stroke();
      ctx.restore();
      text(ctx, tk.label, area.x + area.w + 14, y + 7, tickFont, axisTone("right"), "left", ga);
    }
  }
  let lastRight = -Infinity; // month labels stay inside the body, and one is skipped rather than overprinted
  for (const tk of axes.x) {
    const x = X(tk.t), w = FG.measure(tk.label, tickFont).w;
    if (x < area.x - 1 || x > area.x + area.w + 1) continue;
    const cx = Math.min(b.x + b.w - w / 2, Math.max(b.x + w / 2, x));
    if (cx - w / 2 < lastRight + 16 * k) continue;
    lastRight = cx + w / 2;
    text(ctx, tk.label, cx, area.y + area.h + 36 * k, tickFont, C.muted, "center", ga);
  }
  FG.inkLine(ctx, [[area.x, area.y + area.h], [area.x + area.w, area.y + area.h]], { width: 2, color: C.ink, alpha: 0.6 * ga, seed: 5 });

  // both lines first, then the end dots and the legend, so nothing is painted over a label
  const drawn = series.map((sr, i) => {
    const ax = axes[side(sr)] as Axis;
    const pts = finite(sr).map(([d, v]) => [X(d), Y(v, ax)] as [number, number]);
    const kk = FG.math.smooth(FG.math.seg(t, 0.4 + i * 0.3, 2.2 + i * 0.3));
    const shown = FG.partial(pts, kk);
    if (shown.length > 1) {
      if (i === 0) FG.paperStroke(ctx, shown, { color: colour(i), width: 9 * k });
      else FG.inkLine(ctx, shown, { color: colour(i), width: 3.2 * k, seed: 11, t });
    }
    return { end: pts[pts.length - 1], done: kk >= 0.999 };
  });
  drawn.forEach(({ end, done }, i) => {
    if (!done) return;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, pop(t, 2.3 + i * 0.3) * 3);
    ctx.fillStyle = colour(i);
    ctx.strokeStyle = C.paper;
    ctx.lineWidth = 2.5 * k;
    ctx.beginPath();
    ctx.arc(end[0], end[1], 7 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
  // the legend: swatch, label and the latest value per series, laid out by their measured widths
  const gap = 40 * k, swatch = 46 * k;
  const pills = series.map((sr, i) => once(`last:${sr.last}:${i}:${L.W}x${L.H}`, () =>
    FG.label({ text: sr.last, font: F.mono(L, 22, 700), bg: colour(i), color: i === 0 ? C.charcoal : "#FFFFFF",
               padX: 10, padY: 6, seed: 700 + i, res: 2 })));
  const per = stack ? 1 : series.length;
  const room = (b.w - per * swatch - (per - 1) * gap) / per;
  let lx = b.x;
  series.forEach((sr, i) => {
    const cy = b.y + 16 * k + (stack ? i * rowH : 0);
    if (stack) lx = b.x;
    const pill = pills[i];
    const lab = reportCut(s, `series[${i}].label`, fitLines(sr.label, {
      font: (z) => FG.font.mono(z, 600), width: room - pill.bbox.w - 14 * k, max: Math.round(22 * k), min: Math.round(17 * k),
      ellipsis: true }));
    const lf = FG.font.mono(lab.size, 600);
    const fa = fade(t, 0.3 + i * 0.2);
    ctx.save();
    ctx.globalAlpha *= fa;
    ctx.fillStyle = colour(i);
    ctx.fillRect(lx, cy - 5 * k, 34 * k, 10 * k);
    ctx.restore();
    text(ctx, lab.lines[0], lx + swatch, cy + 7 * k, lf, C.ink, "left", fa);
    const px = lx + swatch + FG.measure(lab.lines[0], lf).w + 14 * k + pill.bbox.w / 2;
    if (drawn[i].done) {
      const kp = pop(t, 2.3 + i * 0.3);
      FG.draw(ctx, pill, px, cy, { s: 0.6 + 0.4 * kp, alpha: Math.min(1, kp * 3), elev: 0.8 });
    }
    lx = px + pill.bbox.w / 2 + gap;
  });
  footer(ctx, s, [props.as_at, props.source]);
}
```

- [ ] **Step 4: Plate**

`remotion-composer/src/shorted/scenes/plate.ts`:

```ts
import { FG } from "../engine";
import { drawDesk, drawPage, pageTitle } from "../page";
import { pop, text } from "../theme";
import { Ctx, fitLines, footer, reportCut } from "./common";

/**
 * A live capture of shorted.com.au on photo paper, taped to the page, with a pencilled caption. The paper (caption strip
 * included) spans the body, so it clears the ASIC caveat label below it; the tapes reach above the body, unless the title
 * runs to two lines, when the plate makes room for them.
 */
export function plate(ctx: CanvasRenderingContext2D, s: Ctx): void {
  const { L, t, props } = s;
  const k = L.k, b = L.body;
  drawDesk(ctx, L);
  drawPage(ctx, L, t, s.id, { no: props.no, title: props.title });
  const im = FG.img[props.image];
  if (!im) throw new Error(`${s.id} (plate): no image loaded for key ${props.image}`);
  const bottom = Math.round(64 * k);
  const tapes = pageTitle(L, { no: props.no, title: props.title }).lines.length > 1 ? 50 : 0;
  const w = Math.round(Math.min(b.w * 0.86, ((b.h - tapes - bottom - 40) * im.width) / im.height));
  const h = (w * im.height) / im.width;
  // no note: the engine memoises a plate by image and width, so the caption is drawn here
  const pc = FG.props.plate(props.image, w, { bottom });
  const cx = b.x + b.w / 2, cy = b.y + tapes + (b.h - tapes - bottom) / 2;
  const kk = pop(t, 0.25, 0.6);
  const sc = 0.94 + 0.06 * Math.min(1, kk), alpha = Math.min(1, kk * 2.5);
  FG.draw(ctx, pc, cx, cy, { s: sc, alpha, rot: -0.012, elev: 1.6 });
  const cap = reportCut(s, "caption", fitLines(props.caption, { font: (z) => FG.font.hand(z, 600), width: w + 36 - 32,
                                                               max: Math.round(34 * k), min: Math.round(24 * k), ellipsis: true }));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.012);
  ctx.scale(sc, sc);
  text(ctx, cap.lines[0] ?? "", 0, h / 2 + 18 + bottom * 0.62, FG.font.hand(cap.size, 600), FG.C.ink, "center", alpha);
  ctx.restore();
  if (kk > 0.5) {
    const top = cy - h / 2 - 18;
    if (w + 36 >= 300) {
      FG.draw(ctx, FG.props.tape(1), cx - w / 2 + 10, top, { rot: -0.6, elev: 0.3 });
      FG.draw(ctx, FG.props.tape(2), cx + w / 2 - 10, top, { rot: 0.55, elev: 0.3 });
    } else FG.draw(ctx, FG.props.tape(1), cx, top, { rot: -0.05, elev: 0.3 }); // a narrow plate takes one tape
  }
  footer(ctx, s, [`data as at ${props.as_at}`, "captured from shorted.com.au"]);
}
```

- [ ] **Step 5: Register them**

`remotion-composer/src/shorted/scenes/index.ts` becomes:

```ts
import { layoutFor } from "../theme";
import type { Images, Scene } from "../types";
import { bar_compare } from "./bar_compare";
import { chapter } from "./chapter";
import { drawSuper, type SceneDraw } from "./common";
import { company } from "./company";
import { end_card } from "./end_card";
import { line_chart } from "./line_chart";
import { list_card } from "./list_card";
import { number_card } from "./number_card";
import { opening } from "./opening";
import { plate } from "./plate";
import { quote_card } from "./quote_card";

export const SCENES: Record<string, SceneDraw> = {
  opening, chapter, company, number_card, bar_compare, line_chart, list_card, quote_card, plate, end_card,
};

/** The props each scene needs: a mirror of gates.REQUIRED_PROPS (a test compares the two). */
export const REQUIRED: Record<string, string[]> = {
  opening: ["ticker", "company", "kicker"], chapter: ["no", "title"], company: ["name", "ticker", "summary"],
  number_card: ["title", "items", "as_at", "source"], bar_compare: ["title", "items", "as_at", "source"],
  line_chart: ["title", "series", "as_at", "source"], list_card: ["title", "rows", "as_at", "source"],
  quote_card: ["title", "quote", "attribution", "as_at"], plate: ["title", "image", "caption", "as_at"],
  end_card: ["url", "free", "premium", "provenance", "advice"],
};

/** Closed vocabularies, wherever they appear in the props: a mirror of gates.VOCAB (a test compares them). */
export const VOCAB: Record<string, string[]> = {
  unit: ["money", "pct"], axis: ["left", "right"], direction: ["down", "flat", "up"], tone: ["neg", "neutral", "pos"],
};

/** The parts a scene draws from its lists: [list prop, fewest, most, fields each entry needs]. Resolved props only. */
const PARTS: Record<string, [string, number, number, string[]]> = {
  number_card: ["items", 1, 3, ["label", "value"]], bar_compare: ["items", 1, Infinity, ["label", "value", "display"]],
  line_chart: ["series", 1, 2, ["label", "points", "last"]], list_card: ["rows", 1, Infinity, ["text"]],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const absent = (v: any): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** A chart needs an axis per side used, two or more plottable points per series in date order, and a window two months
 * labels wide: anything less draws a chart that cannot be read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkChart(props: any, fail: (msg: string) => never): void {
  if (absent(props.axes)) fail("missing prop axes (the timeline computes it)");
  const sides = props.series.map((sr: { axis?: string }) => (sr.axis === "right" ? "right" : "left"));
  if (sides.length === 2 && sides[0] === sides[1]) fail("two series need their own axes: one left, one right");
  const dates: string[] = [];
  props.series.forEach((sr: { points: unknown }, i: number) => {
    const ax = props.axes[sides[i]];
    if (!ax) fail(`axes.${sides[i]} is missing; series[${i}] is drawn against it`);
    if (!(Number.isFinite(ax.min) && Number.isFinite(ax.max) && ax.max > ax.min)) fail(`axes.${sides[i]} needs max > min`);
    const pts = (Array.isArray(sr.points) ? sr.points : []).filter(
      (pt: unknown) => Array.isArray(pt) && Number.isFinite(pt[1]) && Number.isFinite(Date.parse(pt[0])));
    const window = pts.length ? `${pts[0][0]} to ${pts[pts.length - 1][0]}` : "no dated points";
    if (pts.length < 2) fail(`series[${i}] has ${pts.length} point(s) to plot (${window}); a chart needs two or more`);
    if (pts.some((pt: string[], j: number) => j > 0 && !(pt[0] > pts[j - 1][0]))) fail(`series[${i}] points are not in date order (${window})`);
    dates.push(pts[0][0], pts[pts.length - 1][0]);
  });
  const labels = Array.isArray(props.axes.x) ? props.axes.x.length : 0;
  if (labels < 2) {
    fail(`axes.x has ${labels} month label(s) for ${dates.sort()[0]} to ${dates.sort().slice(-1)[0]}; a chart's window needs two or more`);
  }
}

/** Missing or malformed props fail the render, naming the scene, its type and the prop, rather than drawing "undefined". */
export function checkProps(sc: Scene): void {
  const fail = (msg: string): never => {
    throw new Error(`${sc.id} (${sc.type}): ${msg}`);
  };
  const props = sc.props ?? {};
  for (const key of REQUIRED[sc.type] ?? []) if (absent(props[key])) fail(`missing prop ${key}`);
  const part = PARTS[sc.type];
  if (part) {
    const [key, fewest, most, fields] = part;
    const list = props[key];
    if (!Array.isArray(list) || list.length < fewest || list.length > most) {
      fail(`${key} must be a list of ${fewest}${most === Infinity ? " or more" : ` to ${most}`}`);
    }
    list.forEach((entry: Record<string, unknown>, i: number) => {
      for (const f of fields) if (!entry || absent(entry[f])) fail(`missing prop ${key}[${i}].${f}`);
    });
  }
  if (sc.type === "bar_compare") {
    props.items.forEach((it: { value: unknown }, i: number) => {
      if (typeof it.value !== "number" || !Number.isFinite(it.value) || it.value < 0) {
        fail(`items[${i}].value is ${JSON.stringify(it.value)}; bars show values of zero or more`);
      }
    });
  }
  if (sc.type === "line_chart") checkChart(props, fail);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (v: any, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k in VOCAB && x !== null && x !== undefined && !VOCAB[k].includes(x as string)) {
          fail(`${path ? `${path}.` : ""}${k} is ${JSON.stringify(x)}; it must be one of ${VOCAB[k].join(", ")}`);
        }
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(props, "");
}

/** Draw one scene at a local time (seconds from its start), plus the ASIC caveat when it carries one. */
export function drawSceneAt(ctx: CanvasRenderingContext2D, sc: Scene, local: number, W: number, H: number, images: Images): void {
  const L = layoutFor(W, H);
  const draw = SCENES[sc.type];
  if (!draw) throw new Error(`no renderer for scene type ${sc.type}`);
  checkProps(sc);
  draw(ctx, { t: local, dur: sc.end - sc.start, L, props: sc.props, images, id: sc.id, no: sc.no, type: sc.type });
  if (sc.super) drawSuper(ctx, L, sc.super, local);
}
```

- [ ] **Step 6: Run the test and look**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q && .venv/bin/python -m pytest tests/shorted/test_remotion.py tests/shorted/test_scene_fit.py -q -m slow`
Expected: 4 passed, 42 skipped, then PASS (30 tests: all 10 types in both aspects; 8 skipped until Tasks 17 and 20). In the sheets, check:
- the line chart's axis labels sit outside the plot;
- each latest value is readable in the legend, and an end dot marks each line;
- the bars start from one baseline;
- the ASIC caveat label shows on the bars and line-chart scenes, above the footer;
- the plate is taped and captioned.

- [ ] **Step 7: Commit**

```bash
git add remotion-composer/src/shorted/scenes tests/shorted/test_remotion.py
git commit -m "feat(shorted): bar, line-chart and plate scenes"
```

### Task 16: The video compositions

**Files:**
- Create: `remotion-composer/src/shorted/overlays.ts`, `remotion-composer/src/shorted/ShortedVideo.tsx`
- Modify: `remotion-composer/src/shorted/Root.tsx` (add `ShortedLong`, `ShortedShort`)
- Test: `tests/shorted/test_remotion.py` (append)

**Interfaces:**
- Consumes: `drawSceneAt` (Task 15), `PaperCanvas`, `layoutFor`, `fitLines`, `C` (Task 12); `VideoProps` (`types.ts`).
- Produces:
  - Compositions `ShortedLong` (1920 × 1080) and `ShortedShort` (1080 × 1920). `calculateMetadata` takes `durationInFrames`, `width`, `height` and `fps` from the props.
  - A page turn (`TURN = 0.45` s) into every scene whose `transition` is `"page"`.
  - Captions from `captions` when `showCaptions` is set, with word-level highlighting when `wordCaptions` is set.
    - The page on screen is the latest-started one containing `t`.
    - It is fitted inside `captionBand(L)`: two lines under the page on 9:16; one line on 16:9, over the page's bottom margin, with the ink about 40 px inside the frame.
    - The budgets are `gates.TEXT_BUDGETS` `caption_line` and `caption_lines`, and Task 20 pages by them.
    - A page that cannot fit fails the render, naming it; a word is never dropped.
  - The props shape is exactly `VideoProps`; Task 20 writes it as `artifacts/timeline.<cut>.json`.

- [ ] **Step 1: Write the failing test**

Append to `tests/shorted/test_remotion.py`:

```python
def probe(path: Path) -> dict:
    res = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                          "stream=width,height,nb_read_frames", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)["streams"][0]


@pytest.mark.slow
def test_short_renders_with_page_turns_and_captions():
    out = OUT / "video"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    short = SAMPLE["short"]
    props = out / "short.json"
    props.write_text(json.dumps(short))
    remotion("render", "src/shorted/index.tsx", "ShortedShort", str(out / "short.mp4"), f"--props={props}", "--muted")
    info = probe(out / "short.mp4")
    assert (info["width"], info["height"]) == (1080, 1920)
    assert int(info["nb_read_frames"]) == short["durationInFrames"]
    # mid page-turn into the second scene, and a captioned moment, both as stills
    turn = int((short["scenes"][1]["start"] + 0.2) * 30)
    remotion("still", "src/shorted/index.tsx", "ShortedShort", str(out / "turn.png"), f"--props={props}", f"--frame={turn}")
    assert not_blank(out / "turn.png")
    clean = out / "clean.json"
    clean.write_text(json.dumps({**short, "showCaptions": False}))
    for name, p in (("cap", props), ("nocap", clean)):
        remotion("still", "src/shorted/index.tsx", "ShortedShort", str(out / f"{name}.png"), f"--props={p}", "--frame=30")
    band = (0, 1440, 1080, 1560)
    a = np.asarray(Image.open(out / "cap.png").convert("L").crop(band), dtype=np.float32)
    b = np.asarray(Image.open(out / "nocap.png").convert("L").crop(band), dtype=np.float32)
    assert np.abs(a - b).mean() > 5, "captions did not draw in the caption band"


def lum(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def still(comp: str, video: dict, frame: int, out: Path, name: str) -> np.ndarray:
    props = out / f"{name}.json"
    props.write_text(json.dumps(video))
    remotion("still", "src/shorted/index.tsx", comp, str(out / f"{name}.png"), f"--props={props}", f"--frame={frame}")
    return lum(out / f"{name}.png")


@pytest.mark.slow
def test_the_page_turn_follows_its_fold_and_captions_end_clean():
    """The turn is drawn (not a cut), its fold edge sits where the easing puts it, and after the last caption page the
    frame is the clean frame."""
    out = OUT / "turn"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    short = SAMPLE["short"]
    start = short["scenes"][1]["start"]
    first = round(start * 30)
    props = out / "short.json"
    props.write_text(json.dumps(short))
    remotion("render", "src/shorted/index.tsx", "ShortedShort", str(out / "frames"), f"--props={props}", "--sequence",
             "--image-format=png", f"--frames={first}-{first + 13}")
    turn = {first + i: lum(f) for i, f in enumerate(frames_in(out / "frames"))}
    cut = json.loads(json.dumps(short))
    cut["scenes"][1]["transition"] = "cut"
    assert np.abs(turn[first + 2] - still("ShortedShort", cut, first + 2, out, "cut"))[:, :1000].mean() > 10
    ease = lambda k: 4 * k ** 3 if k < 0.5 else 1 - (-2 * k + 2) ** 3 / 2  # noqa: E731 (inOutCubic, as ShortedVideo)
    for f in range(first + 2, first + 13):
        edge = 1080 * (1 - ease((f / 30 - start) / 0.45))
        cols = turn[f].mean(axis=0)
        xs = range(max(4, int(edge) - 25), min(1076, int(edge) + 25))
        found = max(xs, key=lambda x: cols[x - 3:x].mean() - cols[x:x + 3].mean())  # the lit edge ends at the fold
        assert abs(found - edge) <= 3, (f, found, edge)
    end = int(np.ceil(max(p["end"] for p in short["captions"]) * 30))
    a, b = still("ShortedShort", short, end, out, "after"), still("ShortedShort", {**short, "showCaptions": False}, end, out, "clean")
    band = (170 + 1250 + 8, 1920 - 300)
    assert np.abs(a - b)[np.r_[0:band[0], band[1]:1920]].max() == 0


@pytest.mark.slow
@pytest.mark.parametrize("cut", ["long", "short"])
def test_captions_at_their_budget_fit_their_band_and_clear_the_caveat(cut):
    """The longest page the timeline makes (gates.TEXT_BUDGETS: one line of 66 on the long cut, two of 29 on the short),
    on a scene carrying the ASIC caveat: every word drawn, the box in its band below the footer and caveat, and the
    long cut's ink 40 px or more inside the frame."""
    from tools.shorted.gates import TEXT_BUDGETS
    from tools.shorted.lint import CAVEAT

    H = 1080 if cut == "long" else 1920
    video = json.loads(json.dumps(SAMPLE[cut]))
    sc = next(s for s in video["scenes"] if s["type"] == "number_card")
    sc["super"] = CAVEAT
    n, lines = TEXT_BUDGETS[cut]["caption_line"], TEXT_BUDGETS[cut]["caption_lines"]
    text = f"{'m' * 32} {'g' * (n - 33)}" if lines == 1 else f"{'m' * (n - 1)} {'g' * (n - 1)}"  # full lines, descenders
    video["captions"] = [{"start": sc["start"], "end": sc["end"], "text": text,
                          "words": [{"w": w, "s": sc["start"], "e": sc["end"]} for w in text.split()]}]
    out = OUT / f"caption-band-{cut}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    frame = int((sc["start"] + 2.5) * video["fps"])
    comp = "ShortedLong" if cut == "long" else "ShortedShort"
    cap = still(comp, {**video, "showCaptions": True}, frame, out, "cap")
    clean = still(comp, {**video, "showCaptions": False}, frame, out, "nocap")
    drawn = np.abs(cap - clean) > 24
    rows, cols = np.where(drawn.any(axis=1))[0], np.where(drawn.any(axis=0))[0]
    assert len(rows), "the caption did not draw"
    top, bottom = (60 + 930 - 20, H - 30) if cut == "long" else (170 + 1250 + 8, H - 300)  # overlays.captionBand
    assert top <= rows.min() and rows.max() <= bottom, (rows.min(), rows.max())
    inside = cap[rows.min() + 6: rows.max() - 6, cols.min() + 8: cols.max() - 8]  # the box, less its edges
    text_rows = rows.min() + 6 + np.where((inside < 90).any(axis=1))[0]
    assert text_rows.size and (cut != "long" or text_rows.max() <= H - 40), text_rows.max()
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow -k short_renders`
Expected: FAIL with a Remotion error that no composition `ShortedShort` exists.

- [ ] **Step 2: Captions**

`remotion-composer/src/shorted/overlays.ts`:

```ts
import { FG } from "./engine";
import { fitLines } from "./scenes/common";
import { C, Layout } from "./theme";
import type { CaptionPage } from "./types";

/**
 * Where a caption box may sit, and how many lines it holds (gates.TEXT_BUDGETS caption_lines). Portrait: two lines under
 * the page. Landscape: one line (only 90 px of desk lie under the page), over the page's margin below the folio and
 * 30 px clear of the frame's edge, so the ink sits about 40 px inside it.
 */
export const captionBand = (L: Layout): { top: number; bottom: number; lines: number } =>
  L.portrait ? { top: L.page.y + L.page.h + 8, bottom: L.H - 300, lines: 2 }
    : { top: L.page.y + L.page.h - 20, bottom: L.H - 30, lines: 1 };

/**
 * Captions on a paper band. Word-level pages underline the word being spoken in amber. The page on screen is the
 * latest-started one containing t. It is fitted to the band's lines (shrinking if it must) and never loses a word: a
 * page that cannot fit fails the render, naming it. timeline.py pages by the same budget (gates.TEXT_BUDGETS).
 */
export function drawCaptions(ctx: CanvasRenderingContext2D, L: Layout, pages: CaptionPage[], t: number, wordLevel: boolean): void {
  const page = pages.reduce<CaptionPage | null>((on, p) => (t >= p.start && t < p.end && (!on || p.start >= on.start) ? p : on), null);
  if (!page) return;
  const band = captionBand(L);
  const fit = fitLines(page.text, { font: (z) => FG.font.mono(z, 600), width: L.portrait ? L.W - 260 : L.W - 400,
                                    max: L.portrait ? 46 : 38, min: L.portrait ? 38 : 30, lines: band.lines });
  if (fit.cut) throw new Error(`caption page ${page.start}-${page.end} s does not fit ${band.lines} line(s): "${page.text}"`);
  const { lines, size } = fit;
  const font = FG.font.mono(size, 600);
  const lh = size * 1.3;
  const widths = lines.map((l) => FG.measure(l, font).w);
  const boxW = Math.max(...widths) + size * 1.2, boxH = lines.length * lh + size * 0.5;
  const cx = L.portrait ? (L.W - 110) / 2 : L.W / 2;
  const top = Math.max(band.top, Math.min(band.bottom - boxH, L.captionY - boxH / 2));
  const space = FG.measure(" ", font).w;
  ctx.save();
  ctx.fillStyle = "rgba(247,241,229,0.94)";
  ctx.beginPath();
  ctx.roundRect(cx - boxW / 2, top, boxW, boxH, 10);
  ctx.fill();
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  let wi = 0;
  lines.forEach((line, li) => {
    let x = cx - widths[li] / 2;
    const y = top + size * 0.25 + (li + 1) * lh - size * 0.3;
    for (const token of line.split(" ")) {
      const w = page.words[wi];
      const ww = FG.measure(token, font).w;
      ctx.fillStyle = C.charcoal;
      ctx.fillText(token, x, y);
      if (wordLevel && w && t >= w.s && t < w.e) {
        ctx.fillStyle = C.amber;
        ctx.fillRect(x, y + 8, ww, 5);
      }
      x += ww + space;
      wi++;
    }
  });
  ctx.restore();
}
```

- [ ] **Step 3: The video**

`remotion-composer/src/shorted/ShortedVideo.tsx`:

```tsx
import React, { useMemo } from "react";
import { FG } from "./engine";
import { drawCaptions } from "./overlays";
import { PaperCanvas } from "./PaperCanvas";
import { drawSceneAt } from "./scenes";
import { layoutFor } from "./theme";
import type { VideoProps } from "./types";

export const TURN = 0.45;
let off: HTMLCanvasElement | null = null;

/** The previous page lifts away to the left: clip it to what has not turned yet, shade the fold. */
function pageTurn(ctx: CanvasRenderingContext2D, prev: HTMLCanvasElement, k: number, W: number, H: number): void {
  const edge = W * (1 - k);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, edge, H);
  ctx.clip();
  ctx.drawImage(prev, 0, 0);
  ctx.restore();
  const g = ctx.createLinearGradient(edge - 60, 0, edge + 30, 0);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.7, "rgba(20,12,6,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(edge - 60, 0, 90, H);
  ctx.fillStyle = "rgba(255,250,240,0.55)";
  ctx.fillRect(edge - 3, 0, 3, H);
}

export function drawVideo(p: VideoProps) {
  return (ctx: CanvasRenderingContext2D, t: number, W: number, H: number): void => {
    let idx = p.scenes.findIndex((sc) => t < sc.end);
    if (idx < 0) idx = p.scenes.length - 1;
    const sc = p.scenes[idx];
    const local = t - sc.start;
    drawSceneAt(ctx, sc, local, W, H, p.images);
    if (idx > 0 && sc.transition === "page" && local < TURN) {
      const prev = p.scenes[idx - 1];
      off = off && off.width === W && off.height === H ? off : FG.canvas(W, H);
      const g = off!.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, W, H);
      drawSceneAt(g, prev, prev.end - prev.start - 1 / p.fps, W, H, p.images);
      pageTurn(ctx, off!, FG.ease.inOutCubic(local / TURN), W, H);
    }
    if (p.showCaptions) drawCaptions(ctx, layoutFor(W, H), p.captions, t, p.wordCaptions);
  };
}

export const ShortedVideo: React.FC<VideoProps> = (p) => {
  const draw = useMemo(() => drawVideo(p), [p]);
  return <PaperCanvas draw={draw} images={p.images} />;
};
```

- [ ] **Step 4: Register the compositions**

`remotion-composer/src/shorted/Root.tsx` becomes:

```tsx
import React from "react";
import { CalculateMetadataFunction, Composition } from "remotion";
import sample from "./sample-timeline.json";
import { ShortedSceneSheet } from "./ScenePreview";
import { ShortedVideo } from "./ShortedVideo";
import type { SheetProps, VideoProps } from "./types";

const sheet = sample.sheet as unknown as SheetProps;
const long = sample.long as unknown as VideoProps;
const short = sample.short as unknown as VideoProps;
const videoMeta: CalculateMetadataFunction<VideoProps> = ({ props }) => ({
  durationInFrames: props.durationInFrames, width: props.width, height: props.height, fps: props.fps,
});

export const ShortedRoot: React.FC = () => (
  <>
    <Composition id="ShortedLong" component={ShortedVideo} width={1920} height={1080} fps={30}
                 durationInFrames={long.durationInFrames} defaultProps={long} calculateMetadata={videoMeta} />
    <Composition id="ShortedShort" component={ShortedVideo} width={1080} height={1920} fps={30}
                 durationInFrames={short.durationInFrames} defaultProps={short} calculateMetadata={videoMeta} />
    <Composition
      id="ShortedSceneSheet" component={ShortedSceneSheet} width={sheet.width} height={sheet.height} fps={30}
      durationInFrames={sheet.scenes.length} defaultProps={sheet}
      calculateMetadata={({ props }) => ({ width: props.width, height: props.height, durationInFrames: props.scenes.length })}
    />
  </>
);
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: PASS (13 tests). Play `tests/shorted/_out/video/short.mp4`: the opening sweeps, the page turns at 4.5 s and 10 s, and the caption word underline moves with the words.

- [ ] **Step 6: Commit**

```bash
git add remotion-composer/src/shorted tests/shorted/test_remotion.py
git commit -m "feat(shorted): long and short compositions with page turns and captions"
```

### Task 17: Thumbnail and cover

**Files:**
- Create: `remotion-composer/src/shorted/ShortedThumb.tsx`
- Modify: `remotion-composer/src/shorted/Root.tsx` (add the stills)
- Test: `tests/shorted/test_remotion.py` (append)

**Interfaces:**
- Consumes: `ThumbProps` (`types.ts`); `badge`, `fitLines`, `reportCut` (Task 12); `PaperCanvas`.
- Produces:
  - Stills `ShortedThumb` (1920 × 1080) and `ShortedCover` (1080 × 1920), sharing one component. It draws:
    - the headline lines as torn word strips. All rows share one size and sit inside the sheet: on the cover, left of x = 920 (`layoutFor`'s safe line). They also sit above the stamp and logo. Rows are 1.55 sizes apart, so no row covers the descenders of the one above. A row that cannot fit fails the render; the gates cap the rows (Task 8);
    - the kicker;
    - the company logo badge (the `logo` image key; when null, the ticker stamp stands alone);
    - an `ASX:<ticker>` stamp, 104 px (96 on the cover), in `C.burnt`, sized to a maximum width so a longer ticker shrinks. The logo roundel follows the stamp's measured width;
    - the bear;
    - Shorted's badge and URL, 25 px clear of the frame's edge.
  - `drawThumb(p)`, the draw function, is exported.
  - No figures appear unless the storyboard binds them into `headline` (gates, Task 8).

- [ ] **Step 1: Write the failing test**

Append to `tests/shorted/test_remotion.py`:

```python
@pytest.mark.slow
@pytest.mark.parametrize("comp, size", [("ShortedThumb", (1920, 1080)), ("ShortedCover", (1080, 1920))])
def test_thumbnail_and_cover(comp, size):
    out = OUT / "thumbs"
    out.mkdir(parents=True, exist_ok=True)
    props = out / "thumb.json"
    props.write_text(json.dumps(SAMPLE["thumb"]))
    remotion("still", "src/shorted/index.tsx", comp, str(out / f"{comp}.png"), f"--props={props}")
    assert Image.open(out / f"{comp}.png").size == size
    assert not_blank(out / f"{comp}.png")


THUMB = {"ShortedThumb": dict(W=1920, H=1080, sx=576, sy=810, stamp=104, r=106, x=(194, 1726)),
         "ShortedCover": dict(W=1080, H=1920, sx=388.8, sy=1305.6, stamp=96, r=114, x=(118, 920))}  # ShortedThumb's geometry


def thumb(comp: str, out: Path, name: str, **change) -> np.ndarray:
    props = out / f"{name}.json"
    props.write_text(json.dumps({**SAMPLE["thumb"], **change}))
    remotion("still", "src/shorted/index.tsx", comp, str(out / f"{name}.png"), f"--props={props}")
    return lum(out / f"{name}.png")


def changed(a: np.ndarray, b: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(np.abs(a - b) > 24)
    return None if not len(xs) else (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


@pytest.mark.slow
@pytest.mark.parametrize("comp", list(THUMB))
def test_each_thumbnail_prop_draws_only_its_own_element(comp):
    """The ticker changes only the stamp, a missing logo only the roundel, the headline only the headline box; the same
    props give the same pixels; and the cover's headline stays inside layoutFor's safe lines (x 920, y 1420)."""
    g = THUMB[comp]
    out = OUT / f"thumb-variants-{comp}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    base = thumb(comp, out, "base")
    assert changed(base, thumb(comp, out, "again")) is None
    w = 7 * (0.6 * g["stamp"] + 6) + 0.9 * g["stamp"] + 20  # "ASX:EXM" in the engine's stamp, 6 px letter spacing
    stamp = (g["sx"] - w / 2 - 30, g["sy"] - 0.725 * g["stamp"] - 60, g["sx"] + w / 2 + 30, g["sy"] + 0.725 * g["stamp"] + 60)
    box = changed(base, thumb(comp, out, "ticker", ticker="A2M"))
    assert box and stamp[0] <= box[0] and box[2] <= stamp[2] and stamp[1] <= box[1] and box[3] <= stamp[3], (box, stamp)
    lx = g["sx"] + w / 2 + g["r"] + 16
    box = changed(base, thumb(comp, out, "nologo", logo=None))
    assert box and lx - g["r"] - 20 <= box[0] and box[2] <= lx + g["r"] + 20 and g["sy"] - g["r"] - 20 <= box[1], (box, lx)
    empty = thumb(comp, out, "nohead", headline=[])
    box = changed(base, empty)
    top_of_stamp = g["sy"] - max(0.725 * g["stamp"] + 10, g["r"])
    assert box and g["x"][0] - 30 <= box[0] and box[2] <= g["x"][1] + 30 and box[3] < top_of_stamp, (box, top_of_stamp)
    assert np.abs(base - empty)[box[1]:box[3], box[0]:box[2]].mean() > 10
    if comp == "ShortedCover":
        ys, xs = np.nonzero((base < 90) & (empty > 120))  # the headline's ink: dark where the empty sheet is light
        assert xs.max() <= 920 and ys.max() <= 1420, (xs.max(), ys.max())
```

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow -k thumbnail`
Expected: FAIL with a Remotion error that no composition `ShortedThumb` exists.

- [ ] **Step 2: The thumbnail component**

`remotion-composer/src/shorted/ShortedThumb.tsx`:

```tsx
import React, { useMemo } from "react";
import { FG } from "./engine";
import { PaperCanvas } from "./PaperCanvas";
import { drawDesk } from "./page";
import { badge, fitLines, reportCut } from "./scenes/common";
import { C, layoutFor, once } from "./theme";
import type { ThumbProps } from "./types";

const PITCH = 1.55; // row pitch in font sizes: a strip is 1.8 tall, so the next row covers paper, never a descender

/**
 * 16:9 thumbnail and 9:16 cover: headline strips on a torn sheet, logo, ticker stamp, the bear, Shorted's badge.
 * The stamp is the still's identifier, so it is large and sized to a maximum width; the logo follows it. The headline
 * rows share one size, fitted inside the sheet (on the cover, left of x 920: layoutFor's safe line) and above the stamp
 * and the logo; a headline that cannot fit at the smallest size fails the render.
 */
export function drawThumb(p: ThumbProps) {
  return (ctx: CanvasRenderingContext2D, _t: number, W: number, H: number): void => {
    const L = layoutFor(W, H);
    const t = 1.5; // a fixed boil frame
    drawDesk(ctx, L);
    const sheet = once(`thumb-sheet:${W}x${H}`, () =>
      FG.piece({ poly: FG.shape.rect(-W * 0.42, -H * (L.portrait ? 0.4 : 0.38), W * 0.84, H * (L.portrait ? 0.8 : 0.76)), color: C.page, grain: "watercolor", grainAmt: 0.55,
                 edge: "torn", rim: 5, tear: 4, seed: 801, light: 0.08 }));
    FG.draw(ctx, sheet, W / 2, H / 2 - (L.portrait ? 0 : 28), { rot: -0.015, elev: 2 }); // raised: room for Shorted's mark
    const x0 = L.portrait ? 118 : 194, x1 = L.portrait ? 920 : 1726; // the sheet less a margin, and the cover's safe line
    const mid = (x0 + x1) / 2;
    // the stamp, then the logo from the stamp's measured width: their tops bound the headline
    const sx = L.portrait ? W * 0.36 : W * 0.3, sy = H * (L.portrait ? 0.68 : 0.75);
    const R = (L.portrait ? 92 : 84) + 22; // the logo roundel with its torn paper
    const stampText = `ASX:${p.ticker}`;
    const stampMax = Math.min(2 * (sx - (L.portrait ? 100 : 170)), 2 * (x1 - 2 * R - 16 - sx)); // on the sheet, room for the logo
    const stampSize = fitLines(stampText, { font: (z) => FG.font.mono(z, 700), spacing: 6, width: (z) => stampMax - 0.9 * z - 20,
                                            max: L.portrait ? 96 : 104, min: 48 }).size;
    const stamp = FG.props.stamp(stampText, C.burnt, stampSize);
    const logo = p.logo && FG.img[p.logo] ? p.logo : null;
    const lx = sx + stamp.w / 2 + R + 16;
    const floor = Math.min(sy - stamp.h / 2, logo ? sy - R : Infinity) - 24;
    const max = L.portrait ? 104 : 118, min = L.portrait ? 72 : 80;
    const serif = (z: number) => FG.font.serif(z, 700);
    const rows = p.headline.map((line) => line.split(/\s+/).filter(Boolean)).filter((words) => words.length);
    const sizes = rows.map((words) => {
      const n = words.length; // each word is a strip: 0.55 em of paper each side, 14 px apart
      const fit = fitLines(words.join(" "), { font: serif, width: (z) => x1 - x0 - n * 1.1 * z - 14 * (n - 1) + (n - 1) * FG.measure(" ", serif(z)).w,
                                              max, min });
      if (fit.cut) throw new Error(`thumbnail: headline row "${words.join(" ")}" does not fit the ${W}x${H} sheet at ${min} px`);
      return fit.size;
    });
    let y = H * (L.portrait ? 0.3 : 0.32);
    if (rows.length) {
      const size = Math.min(...sizes, (floor - y) / ((rows.length - 1) * PITCH + 0.9));
      if (size < min - 0.5) throw new Error(`thumbnail: ${rows.length} headline rows do not fit above the stamp at ${min} px`);
      rows.forEach((words, li) => {
        const strips = once(`thumb-words:${words.join(" ")}:${li}:${Math.round(size)}:${W}x${H}`, () =>
          FG.wordStrips(words, { font: serif(Math.round(size)), bg: li % 2 ? [C.amber, C.paper] : [C.paper, C.cream], seed: 40 + li * 9 }));
        const widths = strips.map((pc: { bbox: { w: number } }) => pc.bbox.w);
        let x = mid - (widths.reduce((a: number, b: number) => a + b, 0) + 14 * (strips.length - 1)) / 2;
        strips.forEach((pc: { bbox: { w: number } }, i: number) => {
          FG.draw(ctx, pc, x + widths[i] / 2, y, { rot: (FG.hash(i, li) - 0.5) * 0.06, elev: 1.4 });
          x += widths[i] + 14;
        });
        y += size * PITCH;
      });
    }
    const kicker = String(p.kicker).toUpperCase();
    const kf = reportCut({ id: "thumbnail", type: "thumbnail", L }, "kicker", fitLines(kicker, {
      font: (z) => FG.font.mono(z, 600), spacing: 3, width: (z) => x1 - x0 - 1.1 * z, max: L.portrait ? 30 : 32, min: 22, ellipsis: true }));
    const kick = once(`thumb-kick:${kf.lines[0]}:${kf.size}:${W}x${H}`, () =>
      FG.label({ text: kf.lines[0], font: FG.font.mono(kf.size, 600), bg: C.charcoal, color: C.paper, spacing: 3, seed: 61, res: 2 }));
    FG.draw(ctx, kick, mid, H * (L.portrait ? 0.2 : 0.17), { rot: 0.01, elev: 1 });
    FG.draw(ctx, stamp, sx, sy, { rot: -0.08, elev: 0 });
    if (logo) FG.draw(ctx, badge(logo, R - 22, false), lx, sy, { rot: 0.04, elev: 1.4 });
    FG.drawBear(ctx, { x: W * (L.portrait ? 0.8 : 0.86), y: H * (L.portrait ? 0.9 : 0.97), s: L.portrait ? 0.75 : 0.8, flip: -1, look: -0.4, armR: -1.2, elbowR: -1.4 }, t);
    const bx = 120, by = L.portrait ? 120 : H - 83; // on the desk, clear of the sheet and 25 px clear of the frame's edge
    FG.draw(ctx, badge("shorted_icon", 36, true), bx, by, { elev: 1 });
    ctx.save();
    ctx.font = FG.font.mono(30, 600);
    ctx.fillStyle = C.paper;
    ctx.fillText("shorted.com.au", bx + 66, by + 11);
    ctx.restore();
  };
}

export const ShortedThumb: React.FC<ThumbProps> = (p) => {
  const draw = useMemo(() => drawThumb(p), [p]);
  return <PaperCanvas draw={draw} images={p.images} time={1.5} />;
};
```

- [ ] **Step 3: Register the stills**

`remotion-composer/src/shorted/Root.tsx` becomes:

```tsx
import React from "react";
import { CalculateMetadataFunction, Composition, Still } from "remotion";
import sample from "./sample-timeline.json";
import { ShortedSceneSheet } from "./ScenePreview";
import { ShortedThumb } from "./ShortedThumb";
import { ShortedVideo } from "./ShortedVideo";
import type { SheetProps, ThumbProps, VideoProps } from "./types";

const sheet = sample.sheet as unknown as SheetProps;
const long = sample.long as unknown as VideoProps;
const short = sample.short as unknown as VideoProps;
const thumb = sample.thumb as unknown as ThumbProps;
const videoMeta: CalculateMetadataFunction<VideoProps> = ({ props }) => ({
  durationInFrames: props.durationInFrames, width: props.width, height: props.height, fps: props.fps,
});

export const ShortedRoot: React.FC = () => (
  <>
    <Composition id="ShortedLong" component={ShortedVideo} width={1920} height={1080} fps={30}
                 durationInFrames={long.durationInFrames} defaultProps={long} calculateMetadata={videoMeta} />
    <Composition id="ShortedShort" component={ShortedVideo} width={1080} height={1920} fps={30}
                 durationInFrames={short.durationInFrames} defaultProps={short} calculateMetadata={videoMeta} />
    <Composition
      id="ShortedSceneSheet" component={ShortedSceneSheet} width={sheet.width} height={sheet.height} fps={30}
      durationInFrames={sheet.scenes.length} defaultProps={sheet}
      calculateMetadata={({ props }) => ({ width: props.width, height: props.height, durationInFrames: props.scenes.length })}
    />
    <Still id="ShortedThumb" component={ShortedThumb} width={1920} height={1080} defaultProps={thumb} />
    <Still id="ShortedCover" component={ShortedThumb} width={1080} height={1920} defaultProps={thumb} />
  </>
);
```

- [ ] **Step 4: Run the tests and look**

Run: `.venv/bin/python -m pytest tests/shorted/test_remotion.py -q -m slow`
Expected: PASS (17 tests). The thumbnail cases in `tests/shorted/test_scene_fit.py` now run as well: `.venv/bin/python -m pytest tests/shorted/test_scene_fit.py -q -m slow -k thumbnail`, PASS (2 tests). Look at `tests/shorted/_out/thumbs/*.png` at full size and at 160 × 90. The headline must be the first thing you read at small size, and nothing important may sit right of x = 920 or below y = 1420 on the cover (`layoutFor`'s safe lines).

- [ ] **Step 5: Commit**

```bash
git add remotion-composer/src/shorted tests/shorted/test_remotion.py
git commit -m "feat(shorted): thumbnail and cover stills"
```

---

## Part E: production stages

These stages run after the user approves the storyboard. Each reads files from the project folder, so a stage can be re-run alone.

### Task 18: Brand and assets (logo, live plates, asset manifest)

**Files:**
- Create: `tools/shorted/brand.py`, `tools/shorted/assets.py`, `tools/shorted/capture_plates.mjs`
- Test: `tests/shorted/test_brand_assets.py`

**Interfaces:**
- Consumes: `artifacts/dossier.json` (Task 6); `artifacts/storyboard.<cut>.json`; OpenMontage `validate_artifact`.
- Produces:
  - `build_brand(dossier, project_dir, fetch=_get) -> dict`. It writes `assets/images/logo.png` and `artifacts/brand.json`: `{ticker, name, website, industry, logo: {file, source_url, width, height} | null, accent: "#RRGGBB" | null, note, source, crawl: null, built_at}`.
  - `accent_from_logo(path) -> str | None`.
  - `image_keys(storyboards) -> {key: first scene id}`.
  - `PLATES = {key: (path template, heading text)}`. Keys: `plate_stock_chart` (`/shorts/<T>`, "Price & short interest"), `plate_topshorts` (`/`, "Top Shorts"), `plate_treemap` (`/`, "Industry Tree Map").
  - `run_assets(project_dir, capture=node_capture, public_root=None) -> {images, missing, asset_manifest}`.
  - `artifacts/images.json`: `{key: {file, src, w, h, source, captured_at, subtype, license}}`, where `src` is relative to `remotion-composer/public/` (`shorted-runs/<project_id>/<file>`).
  - `artifacts/asset_manifest.json`, which is a valid OpenMontage `asset_manifest`.
  - Tools `shorted_brand` and `shorted_assets`. A failed capture is listed in `missing`; it is not fatal, because the timeline drops that plate (Task 20).
  - `capture_plates.mjs <jobs.json>` prints a JSON list `[{key, ok, out?, error?}]` as its last stdout line.
  - Capture rules: a normal Chrome user agent (the headless default meets Cloudflare's managed challenge); fail fast with `cloudflare challenge` on a 403, a "Just a moment" title or `cf-mitigated`; wait (bounded) for a visible, whitespace-normalised heading (a heading element beats a link) and for the card to be ready (a chart-sized svg/canvas or a card over 300 px, no visible `animate-pulse`/`animate-spin`); settle, hide fixed and sticky elements outside the card, then measure and screenshot; the clip is at most 1.7x the card's width tall (`MAX_ASPECT`, which `gates.TEXT_BUDGETS`' plate caption assumes).

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_brand_assets.py`:

```python
import io
import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image

from schemas.artifacts import validate_artifact
from tools.shorted import assets
from tools.shorted.assets import PLATES, ShortedAssets, image_keys, node_capture, run_assets
from tools.shorted.brand import ShortedBrand, accent_from_logo, build_brand
from tools.shorted.values import Source, Value


def png_bytes(color=(217, 132, 42), size=(200, 200)) -> bytes:
    im = Image.new("RGBA", size, (255, 255, 255, 255))
    im.paste(Image.new("RGBA", (size[0], size[1] // 2), color + (255,)), (0, 0))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def dossier(logo_url="https://example.invalid/logo.png") -> dict:
    src = Source("GetStockDetails", {}, "2026-10-07T00:00:00+00:00")
    v = lambda x: Value(x, "text", None, "ok", src).to_json()
    company = {"name": v("Example Minerals"), "website": v("https://example.invalid"), "industry": v("Metals & Mining")}
    company["logo_url"] = v(logo_url) if logo_url else Value(None, "text", None, "missing", src, note="none").to_json()
    return {"ticker": "EXM", "company": company}


def project(tmp_path: Path) -> Path:
    pd = tmp_path / "EXM-2026-10-07"
    for sub in ("artifacts", "assets/images"):
        (pd / sub).mkdir(parents=True)
    return pd


def test_accent_is_the_logo_colour(tmp_path):
    p = tmp_path / "logo.png"
    p.write_bytes(png_bytes())
    r, g, b = (int(accent_from_logo(p)[i:i + 2], 16) for i in (1, 3, 5))
    assert r > g > b  # orange


def test_brand_with_a_logo(tmp_path):
    pd = project(tmp_path)
    brand = build_brand(dossier(), pd, fetch=lambda url: png_bytes())
    assert brand["logo"]["file"] == "assets/images/logo.png" and (pd / "assets/images/logo.png").exists()
    assert brand["accent"] and brand["crawl"] is None
    assert json.loads((pd / "artifacts/brand.json").read_text())["name"] == "Example Minerals"


def test_brand_without_a_logo_records_why(tmp_path):
    brand = build_brand(dossier(logo_url=None), project(tmp_path), fetch=lambda url: b"")
    assert brand["logo"] is None and "no stored logo" in brand["note"]


def storyboard(cut: str) -> dict:
    return {"cut": cut, "chapters": [{"id": "bears", "scenes": [
        {"id": "s05", "type": "plate", "props": {"image": "plate_stock_chart"}, "lines": []},
        {"id": "s06", "type": "company", "props": {"logo": "logo"}, "lines": []}]}]}


def fake_capture(jobs):
    for j in jobs:
        Image.new("RGB", (1290, 1600), (240, 235, 220)).save(j["out"])
    return [{"key": j["key"], "ok": True, "out": j["out"]} for j in jobs]


def test_assets_stage_and_validate(tmp_path):
    pd = project(tmp_path)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier()))
    build_brand(dossier(), pd, fetch=lambda url: png_bytes())
    (pd / "artifacts/storyboard.long.json").write_text(json.dumps(storyboard("long")))
    assert image_keys([storyboard("long")]) == {"plate_stock_chart": "s05", "logo": "s06"}
    out = run_assets(pd, capture=fake_capture, public_root=tmp_path / "public")
    assert set(out["images"]) == {"logo", "plate_stock_chart"} and out["missing"] == []
    assert out["images"]["plate_stock_chart"]["src"] == "shorted-runs/EXM-2026-10-07/plate_stock_chart.png"
    assert (tmp_path / "public/shorted-runs/EXM-2026-10-07/plate_stock_chart.png").exists()
    validate_artifact("asset_manifest", json.loads((pd / "artifacts/asset_manifest.json").read_text()))
    assert out["images"]["plate_stock_chart"]["source"] == "https://shorted.com.au" + PLATES["plate_stock_chart"][0].format(ticker="EXM")


def test_failed_capture_is_reported_not_fatal(tmp_path):
    pd = project(tmp_path)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier()))
    (pd / "artifacts/storyboard.long.json").write_text(json.dumps(storyboard("long")))
    out = run_assets(pd, capture=lambda jobs: [{"key": j["key"], "ok": False, "error": "heading not found"} for j in jobs],
                     public_root=tmp_path / "public")
    assert out["missing"] == [{"key": "plate_stock_chart", "error": "heading not found"}]
    assert "plate_stock_chart" not in out["images"]


# ---- fix round 1: pin every rule (review I1) and the minor hardening (M2, M3, M6, M8, M9, M10) ----

TRANSPARENT = (0, 0, 0, 0)


def rgba_png(canvas, block=None, size=(160, 160)) -> bytes:
    """A logo fixture: a canvas colour (RGBA) and, optionally, (RGB colour, share of the height) painted from the top."""
    im = Image.new("RGBA", size, canvas)
    if block:
        colour, share = block
        im.paste(Image.new("RGBA", (size[0], int(size[1] * share)), colour + (255,)), (0, 0))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def accent_of(tmp_path, data):
    p = tmp_path / "logo.png"
    p.write_bytes(data)
    return accent_from_logo(p)


def channels(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


@pytest.mark.parametrize("colour", [(217, 132, 42), (30, 90, 200), (40, 160, 80)])
def test_accent_is_the_logo_colour_within_a_tolerance(tmp_path, colour):
    accent = accent_of(tmp_path, rgba_png(TRANSPARENT, (colour, 0.6)))
    assert all(abs(a - b) <= 12 for a, b in zip(channels(accent), colour)), accent


def test_the_accent_is_the_dominant_saturated_colour(tmp_path):
    im = Image.new("RGBA", (160, 160), TRANSPARENT)
    im.paste(Image.new("RGBA", (160, 80), (200, 30, 30, 255)), (0, 0))  # half the logo is red
    im.paste(Image.new("RGBA", (160, 16), (30, 30, 200, 255)), (0, 100))  # a tenth is blue
    buf = io.BytesIO()
    im.save(buf, "PNG")
    assert all(abs(a - b) <= 12 for a, b in zip(channels(accent_of(tmp_path, buf.getvalue())), (200, 30, 30)))


def test_a_sliver_of_colour_is_not_an_accent(tmp_path):
    assert accent_of(tmp_path, rgba_png((255, 255, 255, 255), ((200, 30, 30), 0.03))) is None  # 3% red on white


@pytest.mark.parametrize("data", [
    pytest.param(rgba_png(TRANSPARENT), id="fully-transparent"),
    pytest.param(rgba_png(TRANSPARENT, ((255, 255, 255), 0.6)), id="white-on-transparent"),
    pytest.param(rgba_png(TRANSPARENT, ((128, 128, 128), 0.6)), id="grey"),
    pytest.param(rgba_png(TRANSPARENT, ((20, 20, 20), 0.6)), id="near-black"),
    pytest.param(rgba_png(TRANSPARENT, ((255, 200, 200), 0.6)), id="pastel-too-light-for-an-accent"),
    pytest.param(rgba_png(TRANSPARENT, ((40, 0, 0), 0.6)), id="dark-red-too-dark-for-an-accent"),
])
def test_accent_is_none_when_the_logo_has_no_usable_colour(tmp_path, data):
    assert accent_of(tmp_path, data) is None


def raises(exc):
    def fetch(url):
        raise exc
    return fetch


def test_brand_json_records_the_logo_and_the_company(tmp_path):
    pd, url, seen = project(tmp_path), "https://example.invalid/logo.png", []
    brand = build_brand(dossier(url), pd, fetch=lambda u: seen.append(u) or png_bytes())
    assert seen == [url]
    assert brand["logo"] == {"file": "assets/images/logo.png", "source_url": url, "width": 200, "height": 200}
    assert (brand["ticker"], brand["name"], brand["website"], brand["industry"]) == (
        "EXM", "Example Minerals", "https://example.invalid", "Metals & Mining")
    assert brand["source"] == "GetStockDetails.logo_gcs_url" and brand["note"] is None and brand["crawl"] is None
    datetime.fromisoformat(brand["built_at"])
    assert json.loads((pd / "artifacts/brand.json").read_text()) == brand


@pytest.mark.parametrize("fetch, expected", [
    pytest.param(raises(OSError("connection reset")), ("connection reset",), id="raises"),
    pytest.param(raises(TimeoutError()), ("TimeoutError",), id="times-out"),
    pytest.param(raises(OSError("<Conn object at 0x10b264540> refused")), ("refused",), id="message-with-a-memory-address"),
    pytest.param(lambda url: b"", ("not an image", "empty response"), id="empty-body"),
    pytest.param(lambda url: b"<svg xmlns='http://www.w3.org/2000/svg'/>", ("not an image", "<svg"), id="svg-bytes"),
    pytest.param(lambda url: b"<!doctype html><title>404</title>", ("not an image", "<!doctype"), id="html-error-page"),
])
def test_a_failed_download_is_a_kit_miss_not_a_failed_run(tmp_path, fetch, expected):
    pd = project(tmp_path)
    brand = build_brand(dossier(), pd, fetch=fetch)
    assert brand["logo"] is None and brand["accent"] is None
    assert "logo download failed" in brand["note"] and all(part in brand["note"] for part in expected), brand["note"]
    assert "0x" not in brand["note"] and "BytesIO" not in brand["note"]  # no memory addresses
    assert not (pd / "assets/images/logo.png").exists()
    saved = json.loads((pd / "artifacts/brand.json").read_text())
    assert saved["logo"] is None and saved["name"] == "Example Minerals"


def test_a_failed_rerun_removes_the_stale_logo(tmp_path):
    pd = project(tmp_path)
    assert build_brand(dossier(), pd, fetch=lambda url: png_bytes())["logo"]
    assert (pd / "assets/images/logo.png").exists()
    assert build_brand(dossier(), pd, fetch=raises(OSError("gone")))["logo"] is None
    assert not (pd / "assets/images/logo.png").exists()
    assert json.loads((pd / "artifacts/brand.json").read_text())["logo"] is None
    assert build_brand(dossier(), pd, fetch=lambda url: png_bytes())["logo"]  # and a good rerun brings it back
    assert build_brand(dossier(logo_url=None), pd, fetch=raises(AssertionError()))["logo"] is None
    assert not (pd / "assets/images/logo.png").exists()


@pytest.mark.parametrize("data, expected", [
    pytest.param(rgba_png(TRANSPARENT), "no visible", id="fully-transparent"),
    pytest.param(rgba_png(TRANSPARENT, ((255, 255, 255), 0.6)), "near-white", id="white-on-transparent"),
    pytest.param(rgba_png(TRANSPARENT, ((250, 250, 250), 0.6)), "near-white", id="off-white-on-transparent"),
])
def test_a_logo_nobody_could_see_is_refused(tmp_path, data, expected):
    pd = project(tmp_path)
    brand = build_brand(dossier(), pd, fetch=lambda url: data)
    assert brand["logo"] is None and brand["accent"] is None and expected in brand["note"]
    assert not (pd / "assets/images/logo.png").exists()
    assert json.loads((pd / "artifacts/brand.json").read_text())["logo"] is None


@pytest.mark.parametrize("data", [
    pytest.param(png_bytes(), id="orange-on-a-white-background"),
    pytest.param(rgba_png((255, 255, 255, 255), ((30, 60, 150), 0.25)), id="small-mark-on-a-white-background"),
    pytest.param(rgba_png(TRANSPARENT, ((128, 128, 128), 0.6)), id="grey-logo"),
])
def test_a_visible_logo_is_kept(tmp_path, data):
    brand = build_brand(dossier(), project(tmp_path), fetch=lambda url: data)
    assert brand["logo"] is not None and brand["note"] is None


def board(*scenes, cut="long") -> dict:
    return {"cut": cut, "chapters": [{"id": "c1", "scenes": [
        {"id": sid, "type": "plate", "props": props, "lines": []} for sid, props in scenes]}]}


STOCK = ("s05", {"image": "plate_stock_chart"})
LOGO = ("s06", {"logo": "logo"})
TOP = ("s07", {"image": "plate_topshorts"})
TREE = ("s08", {"image": "plate_treemap"})


def staged(tmp_path, *scenes, logo=True) -> Path:
    pd = project(tmp_path)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier()))
    if logo:
        build_brand(dossier(), pd, fetch=lambda url: png_bytes())
    (pd / "artifacts/storyboard.long.json").write_text(json.dumps(board(*scenes)))
    return pd


def ok_results(jobs):
    return [{"key": j["key"], "ok": True, "out": j["out"]} for j in jobs]


def test_the_plate_catalogue_is_pinned():
    assert PLATES == {
        "plate_stock_chart": ("/shorts/{ticker}", "Price & short interest"),
        "plate_topshorts": ("/", "Top Shorts"),
        "plate_treemap": ("/", "Industry Tree Map"),
    }


def test_capture_is_handed_the_url_heading_and_path_of_every_plate(tmp_path):
    pd, seen = staged(tmp_path, STOCK, LOGO, TOP, TREE), []

    def capture(jobs):
        seen.extend(jobs)
        return fake_capture(jobs)

    run_assets(pd, capture=capture, public_root=tmp_path / "public")
    assert [(j["key"], j["url"], j["heading"]) for j in seen] == [
        ("plate_stock_chart", "https://shorted.com.au/shorts/EXM", "Price & short interest"),
        ("plate_topshorts", "https://shorted.com.au/", "Top Shorts"),
        ("plate_treemap", "https://shorted.com.au/", "Industry Tree Map")]
    for job in seen:
        assert set(job) == {"key", "url", "heading", "out"}  # the contract with capture_plates.mjs
        assert Path(job["out"]) == pd.resolve() / "assets" / "images" / f"{job['key']}.png"


def test_a_logo_only_storyboard_never_starts_a_capture(tmp_path):
    def no_capture(jobs):
        raise AssertionError("capture must not run when there is no plate to capture")

    out = run_assets(staged(tmp_path, LOGO), capture=no_capture, public_root=tmp_path / "public")
    assert set(out["images"]) == {"logo"} and out["missing"] == []


def test_one_plate_fails_and_the_other_is_staged(tmp_path):
    pd, public = staged(tmp_path, STOCK, LOGO, TOP), tmp_path / "public"

    def capture(jobs):
        results = []
        for j in jobs:
            if j["key"] == "plate_stock_chart":
                Image.new("RGB", (1290, 1500), (240, 235, 220)).save(j["out"])
                results.append({"key": j["key"], "ok": True, "out": j["out"]})
            else:
                results.append({"key": j["key"], "ok": False, "error": "cloudflare challenge"})
        return results

    out = run_assets(pd, capture=capture, public_root=public)
    assert set(out["images"]) == {"logo", "plate_stock_chart"}
    assert out["missing"] == [{"key": "plate_topshorts", "error": "cloudflare challenge"}]
    staged_dir = public / "shorted-runs" / "EXM-2026-10-07"
    assert (staged_dir / "plate_stock_chart.png").exists() and (staged_dir / "logo.png").exists()
    assert not (staged_dir / "plate_topshorts.png").exists()
    assert set(json.loads((pd / "artifacts/images.json").read_text())) == {"logo", "plate_stock_chart"}
    manifest = json.loads((pd / "artifacts/asset_manifest.json").read_text())
    validate_artifact("asset_manifest", manifest)
    assert sorted(a["id"] for a in manifest["assets"]) == ["logo", "plate_stock_chart"]
    assert manifest["metadata"]["missing"] == out["missing"]


def test_provenance_fields_and_manifest_metadata(tmp_path):
    pd = staged(tmp_path, STOCK, LOGO)
    out = run_assets(pd, capture=fake_capture, public_root=tmp_path / "public")
    plate, logo = out["images"]["plate_stock_chart"], out["images"]["logo"]
    assert plate["file"] == "assets/images/plate_stock_chart.png"
    assert plate["source"] == "https://shorted.com.au/shorts/EXM"
    assert plate["subtype"] == "plate" and plate["license"] == "Shorted (a capture of shorted.com.au)"
    assert (plate["w"], plate["h"]) == (1290, 1600)
    assert plate["src"] == "shorted-runs/EXM-2026-10-07/plate_stock_chart.png"
    datetime.fromisoformat(plate["captured_at"])
    assert logo["file"] == "assets/images/logo.png" and logo["source"] == "https://example.invalid/logo.png"
    assert logo["captured_at"] is None and logo["subtype"] == "logo"
    assert logo["license"] == "company logo, shown for identification only"
    assert logo["src"] == "shorted-runs/EXM-2026-10-07/logo.png"
    assets_by_id = {a["id"]: a for a in out["asset_manifest"]["assets"]}
    stock, mark = assets_by_id["plate_stock_chart"], assets_by_id["logo"]
    assert (stock["scene_id"], mark["scene_id"]) == ("s05", "s06")
    assert (stock["provider"], mark["provider"]) == ("shorted.com.au", "company")
    assert (stock["type"], stock["format"], stock["source_tool"]) == ("image", "png", "shorted_assets")
    assert stock["path"] == plate["file"] and stock["original_url"] == plate["source"] and stock["resolution"] == "1290x1600"
    assert stock["license"] == plate["license"] and stock["subtype"] == "plate" and mark["subtype"] == "logo"
    assert out["asset_manifest"]["metadata"] == {"ticker": "EXM", "staged_to": "shorted-runs/EXM-2026-10-07", "missing": []}
    assert json.loads((pd / "artifacts/images.json").read_text()) == out["images"]


def test_an_ok_result_without_a_file_is_missing_not_a_crash(tmp_path):
    out = run_assets(staged(tmp_path, STOCK, LOGO), capture=ok_results, public_root=tmp_path / "public")
    assert "plate_stock_chart" not in out["images"]
    assert [m["key"] for m in out["missing"]] == ["plate_stock_chart"] and "no file" in out["missing"][0]["error"]


def test_an_ok_result_that_is_not_an_image_is_missing(tmp_path):
    def capture(jobs):
        for j in jobs:
            Path(j["out"]).write_bytes(b"<html>blocked</html>")
        return ok_results(jobs)

    out = run_assets(staged(tmp_path, STOCK, LOGO), capture=capture, public_root=tmp_path / "public")
    assert "plate_stock_chart" not in out["images"] and set(out["images"]) == {"logo"}
    assert [m["key"] for m in out["missing"]] == ["plate_stock_chart"] and "not an image" in out["missing"][0]["error"]


def test_a_capture_that_returns_fewer_results_than_jobs_lists_the_rest(tmp_path):
    out = run_assets(staged(tmp_path, STOCK, TOP, TREE), capture=lambda jobs: fake_capture(jobs[:1]),
                     public_root=tmp_path / "public")
    assert set(out["images"]) == {"logo", "plate_stock_chart"}
    assert [m["key"] for m in out["missing"]] == ["plate_topshorts", "plate_treemap"]
    assert all("no result" in m["error"] for m in out["missing"])


def test_a_stale_plate_cannot_stand_in_for_a_capture_that_wrote_nothing(tmp_path):
    pd = staged(tmp_path, STOCK, LOGO)
    Image.new("RGB", (1290, 1600), (1, 2, 3)).save(pd / "assets/images/plate_stock_chart.png")  # last run's plate
    out = run_assets(pd, capture=ok_results, public_root=tmp_path / "public")
    assert "plate_stock_chart" not in out["images"] and out["missing"][0]["key"] == "plate_stock_chart"


def test_a_relative_project_dir_still_names_the_run_folder(tmp_path, monkeypatch):
    pd = staged(tmp_path, STOCK, LOGO)
    monkeypatch.chdir(pd)
    out = run_assets(Path("."), capture=fake_capture, public_root=tmp_path / "public")
    assert out["images"]["plate_stock_chart"]["src"] == "shorted-runs/EXM-2026-10-07/plate_stock_chart.png"
    assert out["asset_manifest"]["metadata"]["staged_to"] == "shorted-runs/EXM-2026-10-07"
    assert (tmp_path / "public/shorted-runs/EXM-2026-10-07/plate_stock_chart.png").exists()


def node_jobs(tmp_path):
    images = tmp_path / "assets" / "images"
    images.mkdir(parents=True)
    return [{"key": "plate_stock_chart", "url": "https://shorted.com.au/shorts/EXM", "heading": "Price & short interest",
             "out": str(images / "plate_stock_chart.png")}], images


def node_run(jobs, stdout="", stderr="", code=0, raises=None, seen=None):
    def run(cmd, **kwargs):
        if seen is not None:
            seen.append((cmd, kwargs))
        job_file = Path(cmd[2])
        assert json.loads(job_file.read_text()) == {"jobs": jobs}  # the file exists while the script runs
        if raises:
            raise raises
        return subprocess.CompletedProcess(cmd, code, stdout, stderr)
    return run


def test_node_capture_returns_the_last_stdout_line_and_removes_its_jobs_file(tmp_path, monkeypatch):
    jobs, images = node_jobs(tmp_path)
    results, seen = [{"key": "plate_stock_chart", "ok": True, "out": jobs[0]["out"]}], []
    monkeypatch.setattr(assets.subprocess, "run", node_run(jobs, stdout=f"a warning\n{json.dumps(results)}\n", seen=seen))
    assert node_capture(jobs) == results
    cmd, kwargs = seen[0]
    assert cmd[0] == "node" and Path(cmd[1]).name == "capture_plates.mjs" and kwargs["timeout"] == 600
    assert not (images / "capture-jobs.json").exists()


@pytest.mark.parametrize("run_kwargs, message", [
    pytest.param({"code": 1, "stdout": "[]\n", "stderr": "Error: browserType.launch: boom"}, r"(?s)failed \(exit 1\).*boom",
                 id="non-zero-exit-despite-a-result-line"),
    pytest.param({"stdout": ""}, "printed nothing", id="empty-stdout"),
    pytest.param({"stdout": "Chromium crashed\n"}, "not JSON", id="non-json-last-line"),
    pytest.param({"stdout": '{"key": "plate_stock_chart"}\n'}, "not a list", id="json-but-not-a-list"),
    pytest.param({"raises": subprocess.TimeoutExpired(["node"], 600)}, "timed out", id="timeout"),
    pytest.param({"raises": FileNotFoundError(2, "No such file or directory", "node")}, "not installed", id="node-missing"),
])
def test_node_capture_failures_are_runtime_errors_with_a_clear_message(tmp_path, monkeypatch, run_kwargs, message):
    jobs, images = node_jobs(tmp_path)
    monkeypatch.setattr(assets.subprocess, "run", node_run(jobs, **run_kwargs))
    with pytest.raises(RuntimeError, match=message):
        node_capture(jobs)
    assert not (images / "capture-jobs.json").exists()  # cleaned up on failure too


def test_node_capture_with_no_jobs_never_starts_node(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("node must not start")

    monkeypatch.setattr(assets.subprocess, "run", boom)
    assert node_capture([]) == []


@pytest.mark.parametrize("tool", [ShortedBrand, ShortedAssets])
def test_tools_report_a_missing_prerequisite_instead_of_raising(tmp_path, tool):
    pd = project(tmp_path)
    missing_input = tool().execute({})
    assert missing_input.success is False and "project_dir" in missing_input.error
    no_dossier = tool().execute({"project_dir": str(pd)})
    assert no_dossier.success is False and "artifacts/dossier.json" in no_dossier.error
    (pd / "artifacts/dossier.json").write_text("{not json")
    broken = tool().execute({"project_dir": str(pd)})
    assert broken.success is False and "not valid JSON" in broken.error


def test_the_assets_tool_needs_a_storyboard(tmp_path):
    pd = project(tmp_path)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier()))
    result = ShortedAssets().execute({"project_dir": str(pd)})
    assert result.success is False and "storyboard" in result.error


def test_the_brand_tool_reports_a_run_without_a_logo(tmp_path):
    pd = project(tmp_path)
    (pd / "artifacts/dossier.json").write_text(json.dumps(dossier(logo_url=None)))
    result = ShortedBrand().execute({"project_dir": str(pd)})
    assert result.success and result.data["logo"] is False and "no stored logo" in result.data["note"]
    assert result.artifacts == [str(pd / "artifacts" / "brand.json")]


def test_the_assets_tool_stages_into_the_composer_public_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "REPO", tmp_path / "studio")
    pd = staged(tmp_path, LOGO)
    result = ShortedAssets().execute({"project_dir": str(pd)})
    assert result.success and result.data["missing"] == []
    assert (tmp_path / "studio/remotion-composer/public/shorted-runs/EXM-2026-10-07/logo.png").exists()
    assert result.artifacts == [str(pd / "artifacts/images.json"), str(pd / "artifacts/asset_manifest.json")]


def test_the_assets_tool_turns_an_unknown_plate_and_a_dead_capture_into_failures(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "REPO", tmp_path / "studio")
    unknown = ShortedAssets().execute({"project_dir": str(staged(tmp_path / "a", ("s05", {"image": "plate_mystery"})))})
    assert unknown.success is False and "plate_mystery" in unknown.error

    def hangs(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 600)

    monkeypatch.setattr(assets.subprocess, "run", hangs)
    dead = ShortedAssets().execute({"project_dir": str(staged(tmp_path / "b", STOCK))})
    assert dead.success is False and "timed out" in dead.error


# ---- capture_plates.mjs against local fixtures: real headless Chromium, loopback only (run with -m slow) ----
#
# Needs node and the studio's SHORTED_PLAYWRIGHT_MODULE (source ./.env first); skipped otherwise. SHORTED_CAPTURE_SCRIPT
# points the same tests at a mutated copy of the script (that is how each rule below was shown to be pinned).

SCRIPT = Path(os.environ.get("SHORTED_CAPTURE_SCRIPT") or Path(assets.__file__).with_name("capture_plates.mjs"))
MAGENTA, ORANGE, YELLOW, RED = (255, 0, 255), (255, 136, 0), (255, 204, 0), (255, 0, 0)
GREEN, BLUE, TEAL, PAPER = (0, 204, 0), (0, 0, 255), (0, 170, 170), (245, 245, 220)
CHART = '<svg width="300" height="300"><rect width="300" height="300" fill="#0000ff"/></svg>'
ICON = '<svg width="16" height="16"><rect width="16" height="16" fill="#444444"/></svg>'
SKELETON = '<div class="animate-pulse" style="height:{h}px;background:#00aaaa"></div>'


def html(body, css=""):
    return ("<!doctype html><html><head><meta charset=utf-8><title>fixture</title><style>"
            "body{margin:0;font-family:sans-serif;background:#fff} section,.card{background:#f5f5dc;margin:0 32px}"
            "h2,h3{margin:0;padding:12px 0;font-size:18px}" + css + "</style></head><body>" + body + "</body></html>")


STICKY_BAR = '<header style="position:sticky;top:0;z-index:50;height:64px;background:#ff00ff"></header>'
PAGES = {
    "header": html(STICKY_BAR + f'<div style="height:600px"></div><section><h2>Price &amp; short interest</h2>{CHART}</section>'
                   '<div style="height:2000px"></div>'),
    "fixed": html('<div style="position:fixed;top:0;left:0;right:0;height:64px;background:#ff00ff"></div>'
                  '<div style="position:fixed;top:200px;left:0;right:0;height:60px;background:#ff8800"></div>'
                  '<div style="height:300px"></div><div style="position:sticky;top:0"><section style="height:420px">'
                  '<h2>Price &amp; short interest</h2>'
                  f'<div style="position:sticky;top:0;height:30px;background:#00cc00"></div>{CHART}</section></div>'
                  '<div style="height:2000px"></div>'),
    # the card mounts after 0.6 s under a skeleton that carries the same title and a small icon, and loads at 3 s
    "late": html('<div id="root"></div><script>'
                 f'setTimeout(() => {{ root.innerHTML = \'<section><h3>Top Shorts</h3>{ICON}{SKELETON.format(h=420)}</section>\'; }}, 600);'
                 f'setTimeout(() => {{ root.innerHTML = \'<section><h3>Top Shorts</h3>{ICON}{CHART}</section>\'; }}, 3000);'
                 '</script><div style="height:2000px"></div>'),
    "never-ready": html('<section><h3>Top Shorts</h3>' + ICON + SKELETON.format(h=420) + '</section><div style="height:2000px"></div>'),
    # a chart is already there but a placeholder inside the photographed area is still pulsing until 3 s
    "partial": html(f'<section><h3>Top Shorts</h3>{CHART}<div id="p">{SKELETON.format(h=120)}</div></section>'
                    '<script>setTimeout(() => document.getElementById("p").remove(), 3000);</script>'
                    '<div style="height:2000px"></div>'),
    # ... and one that never stops pulsing far below the photographed area must not hold the capture up
    "pulse-below": html(f'<section><h3>Top Shorts</h3>{CHART}<div style="height:500px"></div>{SKELETON.format(h=100)}</section>'
                        '<div style="height:2000px"></div>'),
    "hidden-first": html('<nav style="display:none"><a href="#">Top Shorts</a></nav>'
                         '<div style="height:24px;background:#ffcc00"><a href="#">Top Shorts</a></div>'
                         f'<div style="height:100px"></div><div class="card" style="margin:8px;height:500px"><div><h3>Top Shorts</h3></div>{CHART}</div>'
                         '<div style="height:2000px"></div>'),
    "whitespace": html(f'<section style="height:400px"><h2>Price &amp;\n   short&nbsp;interest</h2>{CHART}</section>'),
    "uppercase": html(f'<section style="height:400px"><h2>PRICE &amp; SHORT INTEREST</h2>{CHART}</section>'),
    "split-span": html(f'<section style="height:400px"><h2>Price <span>&amp;</span> short interest</h2>{CHART}</section>'),
    "suffix": html(f'<section style="height:400px"><h2>Price &amp; short interest · 1Y</h2>{CHART}</section>'),
    "tall": html(f'<section style="height:1200px"><h2>Price &amp; short interest</h2>{CHART}</section>'),
    "short": html(f'<section style="height:300px;overflow:hidden"><h2>Price &amp; short interest</h2>{CHART}</section>'
                  '<div style="height:2000px"></div>'),
    # something shifts the card down 200 px one second in: the box must be measured after the settle
    "shift": html(f'<section id="card" style="height:400px"><h2>Price &amp; short interest</h2>{CHART}</section>'
                  '<div style="height:2000px"></div><script>setTimeout(() => { const b = document.createElement("div");'
                  'b.style.cssText = "height:200px;background:#ff0000"; document.body.insertBefore(b, card); }, 1000);</script>'),
    "wrapper": html('<section><div style="height:700px;background:#f5f5dc"><h3>Top Shorts</h3>' + CHART + '</div>'
                    '<div style="height:700px;background:#e6f0ff"><h3>Industry Tree Map</h3>' + CHART + '</div></section>'),
    "bare": html('<h2>Top Shorts</h2>'),
    # a short card whose only svg is a small icon and whose loading state does not pulse: an icon is not a chart
    "icon-only": html(f'<section style="height:280px"><h3>Top Shorts</h3>{ICON}<p>Loading…</p></section><div style="height:2000px"></div>'),
    "script-only": html(f'<script type="text/plain">Top Shorts</script><section style="height:400px"><h3>Nothing here</h3>{CHART}</section>'),
}
CHALLENGE_BODY = html(f'<section style="height:400px"><h2>Price &amp; short interest</h2>{CHART}</section>')
ROUTES = {f"/{name}": (200, {}, body) for name, body in PAGES.items()}
ROUTES |= {
    "/challenge-403": (403, {}, CHALLENGE_BODY),  # only the status gives it away
    "/challenge-title": (200, {}, CHALLENGE_BODY.replace("<title>fixture", "<title>Just a moment...")),  # only the title
    "/challenge-header": (200, {"cf-mitigated": "challenge"}, CHALLENGE_BODY),  # only the header
}
HEADING = "Price & short interest"
FIXTURE_JOBS = [  # key, page, heading
    ("header", "header", HEADING), ("fixed", "fixed", HEADING), ("late", "late", "Top Shorts"),
    ("never_ready", "never-ready", "Top Shorts"), ("partial", "partial", "Top Shorts"),
    ("pulse_below", "pulse-below", "Top Shorts"), ("hidden_first", "hidden-first", "Top Shorts"),
    ("whitespace", "whitespace", HEADING), ("uppercase", "uppercase", HEADING),
    ("split_span", "split-span", HEADING), ("suffix", "suffix", HEADING), ("tall", "tall", HEADING),
    ("short", "short", HEADING), ("shift", "shift", HEADING), ("wrapper_first", "wrapper", "Top Shorts"),
    ("wrapper_second", "wrapper", "Industry Tree Map"), ("bare", "bare", "Top Shorts"),
    ("script_only", "script-only", "Top Shorts"), ("icon_only", "icon-only", "Top Shorts"),
]


@pytest.fixture(scope="module")
def site():
    if not os.environ.get("SHORTED_PLAYWRIGHT_MODULE") or not shutil.which("node"):
        pytest.skip("needs node and SHORTED_PLAYWRIGHT_MODULE (source the studio .env first)")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status, headers, body = ROUTES.get(self.path.split("?")[0], (404, {}, "not found"))
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def run_script(jobs, workdir, heading_wait="4000", content_wait="4000"):
    job_file = workdir / "jobs.json"
    job_file.write_text(json.dumps({"jobs": jobs}))
    env = {**os.environ, "PLATE_HEADING_WAIT_MS": heading_wait, "PLATE_CONTENT_WAIT_MS": content_wait}
    started = time.monotonic()
    res = subprocess.run(["node", str(SCRIPT), str(job_file)], capture_output=True, text=True, timeout=300, env=env)
    assert res.returncode == 0, res.stderr[-2000:]
    return {r["key"]: r for r in json.loads(res.stdout.strip().splitlines()[-1])}, time.monotonic() - started


@pytest.fixture(scope="module")
def captured(site, tmp_path_factory):
    workdir = tmp_path_factory.mktemp("plates")
    jobs = [{"key": key, "url": f"{site}/{page}", "heading": heading, "out": str(workdir / f"{key}.png")}
            for key, page, heading in FIXTURE_JOBS]
    jobs.append({"key": "refused", "url": "http://127.0.0.1:1/", "heading": HEADING, "out": str(workdir / "refused.png")})
    results, _ = run_script(jobs, workdir)
    return results, workdir


def near(path, rgb, tol=48):
    """How many pixels of the PNG are within `tol` per channel of rgb."""
    import numpy as np

    with Image.open(path) as im:
        pixels = np.asarray(im.convert("RGB")).astype(int)
    return int((np.abs(pixels - np.array(rgb)).max(axis=2) <= tol).sum())


def plate(captured, key):
    results, workdir = captured
    assert results[key]["ok"], results[key]
    return workdir / f"{key}.png"


def failure(captured, key):
    result = captured[0][key]
    assert result["ok"] is False and "out" not in result, result
    return result["error"]


@pytest.mark.slow
def test_the_sticky_site_header_is_not_photographed_over_the_card(captured):
    path = plate(captured, "header")
    assert near(path, MAGENTA) == 0 and near(path, BLUE) > 1000
    with Image.open(path) as im:
        assert im.size[0] == 1098 and max(abs(a - b) for a, b in zip(im.convert("RGB").getpixel((2, 2)), PAPER)) < 12


@pytest.mark.slow
def test_fixed_chrome_is_hidden_but_the_cards_own_sticky_bar_stays(captured):
    path = plate(captured, "fixed")
    assert near(path, MAGENTA) == 0 and near(path, ORANGE) == 0
    assert near(path, GREEN) > 500 and near(path, BLUE) > 1000


@pytest.mark.slow
def test_a_card_that_mounts_late_and_loads_later_is_photographed_loaded(captured):
    path = plate(captured, "late")  # the icon svg and the same-title skeleton must not pass for a loaded card
    assert near(path, TEAL) == 0 and near(path, BLUE) > 1000


@pytest.mark.slow
def test_a_card_that_never_loads_is_reported_not_photographed(captured):
    assert "card not ready" in failure(captured, "never_ready")
    assert not (captured[1] / "never_ready.png").exists()


@pytest.mark.slow
def test_a_small_icon_is_not_a_chart(captured):
    error = failure(captured, "icon_only")
    assert "card not ready" in error and "no chart-sized svg" in error


@pytest.mark.slow
def test_a_pulsing_placeholder_inside_the_photographed_area_is_waited_out(captured):
    path = plate(captured, "partial")
    assert near(path, TEAL) == 0 and near(path, BLUE) > 1000


@pytest.mark.slow
def test_a_pulsing_placeholder_below_the_photographed_area_does_not_hold_the_capture(captured):
    path = plate(captured, "pulse_below")
    assert near(path, TEAL) == 0 and near(path, BLUE) > 1000


@pytest.mark.slow
def test_hidden_copies_are_ignored_and_a_heading_beats_a_link(captured):
    path = plate(captured, "hidden_first")
    with Image.open(path) as im:
        assert im.size[0] == 1242  # the 414 px card, not the page
    assert near(path, YELLOW) == 0 and near(path, BLUE) > 1000


@pytest.mark.slow
@pytest.mark.parametrize("key", ["whitespace", "uppercase"])
def test_whitespace_is_normalised_and_case_is_ignored(captured, key):
    plate(captured, key)


@pytest.mark.slow
@pytest.mark.parametrize("key", ["split_span", "suffix"])
def test_a_heading_split_by_markup_or_with_a_suffix_still_fails_loudly(captured, key):
    assert failure(captured, key).startswith("heading not found: Price & short interest")


@pytest.mark.slow
def test_the_clip_is_capped_at_1_7_times_the_cards_width(captured):
    with Image.open(plate(captured, "tall")) as im:
        w, h = im.size
    assert w == 1098 and abs(h - 1.7 * w) <= 4
    with Image.open(plate(captured, "short")) as im:
        assert im.size == (1098, 900)  # a card shorter than the cap keeps its own height


@pytest.mark.slow
def test_the_box_is_measured_after_the_settle(captured):
    assert near(plate(captured, "shift"), RED) == 0


@pytest.mark.slow
def test_a_heading_that_falls_outside_the_capture_region_is_an_error_not_a_wrong_plate(captured):
    plate(captured, "wrapper_first")
    assert "outside the capture region" in failure(captured, "wrapper_second")


@pytest.mark.slow
def test_a_heading_with_no_card_around_it_is_an_error(captured):
    assert "no card" in failure(captured, "bare")


@pytest.mark.slow
def test_text_that_only_exists_inside_a_script_is_not_a_heading(captured):
    assert failure(captured, "script_only").startswith("heading not found: Top Shorts")


@pytest.mark.slow
def test_error_strings_carry_no_ansi_escapes(captured):
    error = failure(captured, "refused")
    assert error and "\x1b" not in error and "[2m" not in error


@pytest.mark.slow
@pytest.mark.parametrize("page", ["challenge-403", "challenge-title", "challenge-header"])
def test_a_cloudflare_challenge_fails_fast_with_its_own_error(site, tmp_path, page):
    job = {"key": page, "url": f"{site}/{page}", "heading": HEADING, "out": str(tmp_path / "p.png")}
    results, elapsed = run_script([job], tmp_path, heading_wait="15000", content_wait="15000")
    assert results[page]["ok"] is False and results[page]["error"].startswith("cloudflare challenge"), results
    assert elapsed < 10  # it did not sit out the heading wait
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_brand_assets.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.assets'`.

- [ ] **Step 3: Implement `brand.py`**

```python
"""brand.json for the run: the company's name, website, logo and one accent colour.

Phase 1 uses the logo Shorted already stores (GetStockDetails logo_gcs_url); the brandbrain crawl
(`bb discover`) is phase 2 and will fill `crawl`. Shorted's frame always dominates: the company
brand is identification plus one accent, never an endorsement.
"""

from __future__ import annotations

import colorsys
import io
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolRuntime, ToolTier

OPAQUE = 200  # a pixel with more alpha than this is part of the logo
NEAR_WHITE = 245  # opaque pixels averaging this bright vanish on the paper badge the logo is drawn on


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Shorted-E2E/1.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def _value(dossier: dict, section: str, field: str):
    v = (dossier.get(section) or {}).get(field) or {}
    return v.get("value") if v.get("trust") in ("ok", "stale") else None


def read_dossier(project_dir: Path) -> tuple[dict | None, str | None]:
    """artifacts/dossier.json as (dossier, None), or (None, why not): the prerequisite check of the brand and assets tools."""
    try:
        dossier = json.loads((Path(project_dir) / "artifacts" / "dossier.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "no artifacts/dossier.json; run the dossier stage first"
    except ValueError as err:
        return None, f"artifacts/dossier.json is not valid JSON: {err}"
    if not isinstance(dossier, dict) or not dossier.get("ticker"):
        return None, "artifacts/dossier.json has no ticker"
    return dossier, None


def _opaque_rgb(im):
    """The RGB of the logo's opaque pixels (alpha above OPAQUE), read from a 128 px thumbnail, as an (N, 3) array."""
    import numpy as np

    im = im.convert("RGBA")
    im.thumbnail((128, 128))
    px = np.asarray(im).reshape(-1, 4)
    return px[px[:, 3] > OPAQUE][:, :3]


def accent_from_logo(path: Path) -> str | None:
    """The most saturated colour that covers a fair share of the logo, as #RRGGBB; None if it is grey."""
    import numpy as np
    from PIL import Image

    px = _opaque_rgb(Image.open(path))
    if not len(px):
        return None
    pal = Image.fromarray(px.reshape(1, -1, 3).astype(np.uint8)).quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    palette = pal.getpalette()
    best = None
    for count, idx in pal.getcolors():
        r, g, b = palette[idx * 3: idx * 3 + 3]
        _, light, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if count < 0.05 * len(px) or sat < 0.35 or not 0.15 <= light <= 0.85:
            continue
        score = sat * min(1.0, count / (0.2 * len(px)))
        if best is None or score > best[0]:
            best = (score, f"#{r:02X}{g:02X}{b:02X}")
    return best[1] if best else None


def _describe(err: BaseException) -> str:
    """One reproducible line for a failed download: the exception type and message, without memory addresses."""
    detail = re.sub(r"\s+", " ", re.sub(r" at 0x[0-9a-fA-F]+", "", str(err))).strip()[:200]
    return f"{type(err).__name__}: {detail}" if detail else type(err).__name__


def _decode(data: bytes):
    """Bytes -> a loaded PIL image; ValueError saying why not (with the first bytes, never a memory address)."""
    from PIL import Image, UnidentifiedImageError

    if not data:
        raise ValueError("not an image (empty response)")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except UnidentifiedImageError:
        raise ValueError(f"not an image (first bytes {data[:16]!r})") from None
    except Exception as err:  # a truncated or corrupt image
        raise ValueError(f"image would not decode ({_describe(err)})") from None
    return im


def _unusable(rgba) -> str | None:
    """Why this logo would show as nothing on the paper badge, or None when it is fine."""
    px = _opaque_rgb(rgba)
    if not len(px):
        return "no visible opaque pixels"
    if px.mean() >= NEAR_WHITE:
        return "near-white, it would vanish on the paper badge"
    return None


def build_brand(dossier: dict, project_dir: Path, fetch: Callable[[str], bytes] = _get) -> dict:
    pd = Path(project_dir)
    out = pd / "assets" / "images" / "logo.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    url = _value(dossier, "company", "logo_url")
    logo, note, rgba = None, None, None
    if url:
        try:
            data = fetch(url)
        except Exception as err:  # a missing logo is a kit miss, never a failed run
            note = f"logo download failed: {_describe(err)}"
        else:
            try:
                im = _decode(data)
            except ValueError as err:
                note = f"logo download failed: {err}"
            else:
                rgba = im.convert("RGBA")
                problem = _unusable(rgba)
                if problem:
                    note, rgba = f"logo is not usable: {problem}", None
                else:
                    logo = {"file": "assets/images/logo.png", "source_url": url, "width": im.width, "height": im.height}
    else:
        note = "Shorted has no stored logo for this company"
    if rgba is not None:
        rgba.save(out)
    else:
        out.unlink(missing_ok=True)  # a rerun must not leave last run's logo beside a brand.json that has none
    brand = {
        "ticker": dossier["ticker"], "name": _value(dossier, "company", "name"),
        "website": _value(dossier, "company", "website"), "industry": _value(dossier, "company", "industry"),
        "logo": logo, "accent": accent_from_logo(out) if logo else None, "note": note,
        "source": "GetStockDetails.logo_gcs_url", "crawl": None,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (pd / "artifacts").mkdir(parents=True, exist_ok=True)
    (pd / "artifacts" / "brand.json").write_text(json.dumps(brand, indent=1))
    return brand


class ShortedBrand(BaseTool):
    name = "shorted_brand"
    version = "1.0.0"
    tier = ToolTier.SOURCE
    runtime = ToolRuntime.API
    capability = "brand_identity"
    provider = "shorted"
    resource_profile = ResourceProfile(network_required=True)
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        if not inputs.get("project_dir"):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(inputs["project_dir"])
        dossier, error = read_dossier(pd)
        if error:
            return ToolResult(success=False, error=error)
        brand = build_brand(dossier, pd)
        return ToolResult(success=True, data={"logo": bool(brand["logo"]), "accent": brand["accent"], "note": brand["note"]},
                          artifacts=[str(pd / "artifacts" / "brand.json")])
```

- [ ] **Step 4: Implement `assets.py`**

```python
"""The assets stage: capture the live plates the storyboards use, stage every image for Remotion,
and write images.json plus the run's asset_manifest (OpenMontage's canonical artifact here)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolRuntime, ToolTier
from tools.shorted.brand import read_dossier

REPO = Path(__file__).resolve().parents[2]
SITE = "https://shorted.com.au"
PLATES = {
    "plate_stock_chart": ("/shorts/{ticker}", "Price & short interest"),
    "plate_topshorts": ("/", "Top Shorts"),
    "plate_treemap": ("/", "Industry Tree Map"),
}
CAPTURE_TIMEOUT_S = 600
Capture = Callable[[list[dict]], list[dict]]


def image_keys(storyboards: list[dict]) -> dict[str, str]:
    """Every image key the storyboards show (plates and the company logo) -> the first scene showing it."""
    keys: dict[str, str] = {}
    for sb in storyboards:
        for ch in sb["chapters"]:
            for sc in ch["scenes"]:
                props = sc.get("props", {})
                for key in (props.get("image"), props.get("logo")):
                    if isinstance(key, str) and key:
                        keys.setdefault(key, sc["id"])
    return keys


def node_capture(jobs: list[dict]) -> list[dict]:
    """Run capture_plates.mjs: headless Chromium, because the apex blocks curl."""
    if not jobs:
        return []
    job_file = Path(jobs[0]["out"]).parent / "capture-jobs.json"
    job_file.write_text(json.dumps({"jobs": jobs}))
    try:
        res = subprocess.run(["node", str(Path(__file__).with_name("capture_plates.mjs")), str(job_file)],
                             capture_output=True, text=True, timeout=CAPTURE_TIMEOUT_S, env=dict(os.environ))
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"capture_plates.mjs timed out after {CAPTURE_TIMEOUT_S} s") from None
    except FileNotFoundError:
        raise RuntimeError("node is not installed or not on PATH; capture_plates.mjs needs it") from None
    finally:
        job_file.unlink(missing_ok=True)
    if res.returncode != 0:
        raise RuntimeError(f"capture_plates.mjs failed (exit {res.returncode}): {res.stderr[-1500:]}")
    lines = res.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError(f"capture_plates.mjs printed nothing (exit 0); stderr: {res.stderr[-500:]}")
    try:
        results = json.loads(lines[-1])
    except ValueError:
        raise RuntimeError(f"capture_plates.mjs last stdout line is not JSON: {lines[-1][:200]!r}") from None
    if not isinstance(results, list):
        raise RuntimeError(f"capture_plates.mjs last stdout line is not a list of results: {lines[-1][:200]!r}")
    return results


def _capture_problem(job: dict, result: dict | None) -> str | None:
    """Why this job produced no usable plate, or None when it did. An ok result must be backed by an image on disk."""
    from PIL import Image

    if not isinstance(result, dict):
        return "capture returned no result for this plate"
    if not result.get("ok"):
        return result.get("error") or "capture failed"
    out = Path(job["out"])
    if not out.is_file():
        return "capture reported ok but wrote no file"
    try:
        with Image.open(out) as im:
            im.verify()
    except Exception:
        return "capture reported ok but the file is not an image"
    return None


def run_assets(project_dir: Path, capture: Capture = node_capture, public_root: Path | None = None) -> dict:
    from PIL import Image

    from schemas.artifacts import validate_artifact

    pd = Path(project_dir).resolve()
    art = pd / "artifacts"
    ticker = json.loads((art / "dossier.json").read_text())["ticker"]
    keys = image_keys([json.loads(p.read_text()) for p in sorted(art.glob("storyboard.*.json"))])
    plates = [k for k in keys if k != "logo"]
    unknown = sorted(set(plates) - set(PLATES))
    if unknown:
        raise ValueError(f"unknown plate keys {unknown}; use one of {sorted(PLATES)}")
    (pd / "assets" / "images").mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    found: dict[str, dict] = {}
    brand = json.loads((art / "brand.json").read_text()) if (art / "brand.json").exists() else {}
    if brand.get("logo"):
        found["logo"] = {"file": brand["logo"]["file"], "source": brand["logo"]["source_url"], "captured_at": None,
                         "subtype": "logo", "license": "company logo, shown for identification only"}
    jobs = [{"key": k, "url": SITE + PLATES[k][0].format(ticker=ticker), "heading": PLATES[k][1],
             "out": str(pd / "assets" / "images" / f"{k}.png")} for k in plates]
    for job in jobs:  # last run's plate must not stand in for a capture that wrote nothing this time
        Path(job["out"]).unlink(missing_ok=True)
    results = {r["key"]: r for r in (capture(jobs) if jobs else []) if isinstance(r, dict) and "key" in r}
    missing = []
    for job in jobs:
        problem = _capture_problem(job, results.get(job["key"]))
        if problem is None:
            found[job["key"]] = {"file": f"assets/images/{job['key']}.png", "source": job["url"], "captured_at": now,
                                 "subtype": "plate", "license": "Shorted (a capture of shorted.com.au)"}
        else:
            missing.append({"key": job["key"], "error": problem})
    public = Path(public_root or REPO / "remotion-composer" / "public") / "shorted-runs" / pd.name
    public.mkdir(parents=True, exist_ok=True)
    images = {}
    for key, entry in found.items():
        src = pd / entry["file"]
        with Image.open(src) as im:
            w, h = im.size
        shutil.copy2(src, public / src.name)
        images[key] = {**entry, "src": f"shorted-runs/{pd.name}/{src.name}", "w": w, "h": h}
    (art / "images.json").write_text(json.dumps(images, indent=1))
    manifest = {"version": "1.0", "assets": [
        {"id": key, "type": "image", "path": e["file"], "source_tool": "shorted_assets", "scene_id": keys.get(key, "global"),
         "subtype": e["subtype"], "provider": "shorted.com.au" if e["subtype"] == "plate" else "company",
         "license": e["license"], "original_url": e["source"], "format": "png", "resolution": f"{e['w']}x{e['h']}"}
        for key, e in images.items()], "metadata": {"ticker": ticker, "staged_to": f"shorted-runs/{pd.name}", "missing": missing}}
    validate_artifact("asset_manifest", manifest)
    (art / "asset_manifest.json").write_text(json.dumps(manifest, indent=1))
    return {"images": images, "missing": missing, "asset_manifest": manifest}


class ShortedAssets(BaseTool):
    name = "shorted_assets"
    version = "1.0.0"
    tier = ToolTier.SOURCE
    runtime = ToolRuntime.HYBRID
    capability = "asset_capture"
    provider = "shorted"
    resource_profile = ResourceProfile(network_required=True)
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        if not inputs.get("project_dir"):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(inputs["project_dir"])
        art = pd / "artifacts"
        _, error = read_dossier(pd)
        if error:
            return ToolResult(success=False, error=error)
        if not list(art.glob("storyboard.*.json")):
            return ToolResult(success=False, error="no storyboard.long.json or storyboard.short.json in artifacts/; "
                                                   "run the storyboard stage first")
        try:
            out = run_assets(pd)
        except (ValueError, RuntimeError) as err:  # an unknown plate key, a malformed artifact, or a dead capture script
            return ToolResult(success=False, error=str(err))
        return ToolResult(success=True, data={"asset_manifest": out["asset_manifest"], "missing": out["missing"]},
                          artifacts=[str(art / "images.json"), str(art / "asset_manifest.json")])
```

- [ ] **Step 5: The capture script**

`tools/shorted/capture_plates.mjs`:

```js
// Capture sections of shorted.com.au as plates for the videos. Headless Chromium, because the
// apex blocks curl. Each job finds a heading by its text, takes the nearest <section> (or the
// first ancestor at least 260 px tall), and screenshots it at phone width.
//   node capture_plates.mjs jobs.json   ->  last stdout line: [{key, ok, out?, error?}]
//
// A job runs these steps; a step that fails is that job's error, and the other jobs still run.
//   1. Open the page and stop at DOMContentLoaded. A Cloudflare challenge (HTTP 403, the title
//      "Just a moment...", or a cf-mitigated header) is "cloudflare challenge" at once: behind one the
//      network never goes idle, and waiting for it used to cost 90 s per job.
//   2. Wait for a VISIBLE text node that reads the heading, ignoring case and normalising whitespace.
//      Hidden copies are skipped, and a heading element beats a link. Else "heading not found".
//   3. Scroll the card into view and wait until it has loaded: no pulsing skeleton or spinner in the area
//      that will be photographed, and a chart-sized svg/canvas (or a tall card). Else "card not ready".
//   4. Let charts finish animating, hide the site's fixed and sticky chrome outside the card, MEASURE the
//      card, screenshot it. The clip is at most 1.7 x the card's width tall.
// PLATE_HEADING_WAIT_MS and PLATE_CONTENT_WAIT_MS shorten the two waits (the tests use them).
import fs from "node:fs/promises";

const { chromium } = await import(process.env.SHORTED_PLAYWRIGHT_MODULE || "playwright");
const { jobs } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));

const NAV_TIMEOUT_MS = 60000;
const HEADING_WAIT_MS = Number(process.env.PLATE_HEADING_WAIT_MS) || 20000;
const CONTENT_WAIT_MS = Number(process.env.PLATE_CONTENT_WAIT_MS) || 20000;
const IDLE_WAIT_MS = 5000; // best effort, for late images and fetches: some pages never go idle
const SETTLE_MS = 1500; // charts animate in
const MAX_ASPECT = 1.7; // a whole stock card (366 x 592 CSS px) fits; gates.TEXT_BUDGETS' plate caption is measured at 1.7
const MIN_CHART_PX = 100; // an svg or canvas this big both ways is a chart; the icons are 16 to 24
const TALL_CARD_PX = 300; // a card this tall has content beyond its title even without a chart
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

class PlateError extends Error {}

// Runs in every page (addInitScript) and installs window.__plate.
const helpers = ({ maxAspect, minChart, tall }) => {
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const shown = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8 && r.right > 0 && r.bottom + window.scrollY > 0;
  };
  // The first VISIBLE text node that reads the heading, as its element; an h1-h6 beats a link or a label.
  const findHeading = (text) => {
    const want = norm(text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let first = null;
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || norm(walker.currentNode.textContent) !== want || !shown(el)) continue;
      if (/^H[1-6]$/.test(el.tagName) || el.getAttribute("role") === "heading") return el;
      first = first || el;
    }
    return first;
  };
  // The nearest <section>, else the first ancestor at least 260 px tall; never the page itself.
  const cardOf = (heading) => {
    let el = heading.closest("section") || heading;
    while (el.parentElement && el.getBoundingClientRect().height < 260) el = el.parentElement;
    return el === document.body || el === document.documentElement ? null : el;
  };
  // Loaded means: no skeleton or spinner showing where the photograph will be taken, and a chart (or a tall card).
  const ready = (text) => {
    const heading = findHeading(text);
    if (!heading) return { ok: false, why: "no visible heading" };
    const card = cardOf(heading);
    if (!card) return { ok: false, why: "no card around the heading" };
    const r = card.getBoundingClientRect();
    const bottom = r.top + Math.min(r.height, maxAspect * r.width);
    for (const n of card.querySelectorAll(".animate-pulse, .animate-spin")) {
      const b = n.getBoundingClientRect();
      if (shown(n) && b.bottom > r.top && b.top < bottom && b.right > r.left && b.left < r.right) {
        return { ok: false, why: "a loading skeleton or spinner is showing" };
      }
    }
    const chart = [...card.querySelectorAll("svg, canvas")].some((n) => {
      const b = n.getBoundingClientRect();
      return b.width >= minChart && b.height >= minChart && shown(n);
    });
    return chart || r.height > tall ? { ok: true, why: "" } : { ok: false, why: "no chart-sized svg or canvas, and the card is short" };
  };
  const reveal = (text) => {
    const heading = findHeading(text);
    if (!heading) return false;
    (cardOf(heading) || heading).scrollIntoView({ block: "start", behavior: "instant" });
    return true;
  };
  const measure = (text) => {
    const heading = findHeading(text);
    const card = heading && cardOf(heading);
    if (!card) return { error: `no card around the heading: ${text}` };
    // Site chrome (the sticky header, a cookie bar, a chat button) would be photographed over the card.
    for (const n of document.body.querySelectorAll("*")) {
      const pos = getComputedStyle(n).position;
      if ((pos === "fixed" || pos === "sticky") && !card.contains(n) && !n.contains(card)) n.style.visibility = "hidden";
    }
    card.scrollIntoView({ block: "start", behavior: "instant" });
    const r = card.getBoundingClientRect();
    const height = Math.min(r.height, maxAspect * r.width);
    if (heading.getBoundingClientRect().bottom > r.top + height) return { error: `the heading falls outside the capture region: ${text}` };
    return { box: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height } };
  };
  window.__plate = { findHeading, ready, reveal, measure };
};

const clean = (err) => (err instanceof PlateError ? err.message : String(err)).replace(ANSI, "").replace(/\s+/g, " ").trim().slice(0, 300);

async function rejectChallenge(page, response) {
  const title = (await page.title().catch(() => "")).trim();
  const status = response ? response.status() : null;
  const mitigated = response ? response.headers()["cf-mitigated"] : undefined;
  if (status === 403 || /^just a moment/i.test(title) || mitigated) {
    const facts = [status ? `HTTP ${status}` : null, title ? `title "${title.slice(0, 60)}"` : null, mitigated ? `cf-mitigated: ${mitigated}` : null];
    throw new PlateError(`cloudflare challenge (${facts.filter(Boolean).join(", ")}); the site's bot rule is blocking this client`);
  }
}

async function capture(context, job) {
  const page = await context.newPage();
  try {
    const response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await rejectChallenge(page, response);
    try {
      await page.waitForFunction((h) => window.__plate.findHeading(h) !== null, job.heading, { timeout: HEADING_WAIT_MS, polling: 250 });
    } catch (err) {
      if (err.name !== "TimeoutError") throw err;
      await rejectChallenge(page, null); // a challenge that only shows up after the first response
      const title = (await page.title().catch(() => "")).slice(0, 60);
      throw new PlateError(`heading not found: ${job.heading} (no visible match within ${HEADING_WAIT_MS / 1000}s; page title "${title}")`);
    }
    await page.evaluate((h) => window.__plate.reveal(h), job.heading);
    try {
      await page.waitForFunction((h) => window.__plate.ready(h).ok, job.heading, { timeout: CONTENT_WAIT_MS, polling: 250 });
    } catch (err) {
      if (err.name !== "TimeoutError") throw err;
      const { why } = await page.evaluate((h) => window.__plate.ready(h), job.heading);
      throw new PlateError(`card not ready: ${job.heading} (${why}; still so after ${CONTENT_WAIT_MS / 1000}s)`);
    }
    await page.waitForLoadState("networkidle", { timeout: IDLE_WAIT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const { box, error } = await page.evaluate((h) => window.__plate.measure(h), job.heading); // after the settle: layout shifts
    if (error) throw new PlateError(error);
    await page.screenshot({ path: job.out, clip: box, fullPage: true });
    return { key: job.key, ok: true, out: job.out };
  } finally {
    await page.close().catch(() => {});
  }
}

const results = [];
let browser;
try {
  browser = await chromium.launch();
  // Cloudflare's bot rule answers the default "HeadlessChrome" user agent with a managed challenge on every
  // apex page (HTTP 403, "Just a moment..."), so the same Chromium presents itself as an ordinary Chrome.
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Safari/537.36`;
  const context = await browser.newContext({ userAgent, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, colorScheme: "light" });
  await context.addInitScript(helpers, { maxAspect: MAX_ASPECT, minChart: MIN_CHART_PX, tall: TALL_CARD_PX });
  for (const job of jobs) {
    const started = Date.now();
    try {
      results.push(await capture(context, job));
      console.error(`[plates] ${job.key}: ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      const error = clean(err);
      results.push({ key: job.key, ok: false, error });
      console.error(`[plates] ${job.key}: failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error}`);
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}
console.log(JSON.stringify(results));
```

- [ ] **Step 6: Run the tests, then one live capture**

Run: `.venv/bin/python -m pytest tests/shorted/test_brand_assets.py -q`, then the Chromium fixture tests with `SHORTED_PLAYWRIGHT_MODULE` set (from `.env`): `.venv/bin/python -m pytest tests/shorted/test_brand_assets.py -q -m slow`
Expected: PASS (54 tests), then the 21 slow fixture tests (about a minute; they skip without `SHORTED_PLAYWRIGHT_MODULE`).

Live check (it uses the network, so it runs outside pytest):

```bash
cd /Users/benebsworth/projects/shorted-studio && set -a; . ./.env; set +a
mkdir -p /tmp/plates && printf '{"jobs":[{"key":"plate_stock_chart","url":"https://shorted.com.au/shorts/DRO","heading":"Price & short interest","out":"/tmp/plates/p.png"}]}' > /tmp/plates/jobs.json
node tools/shorted/capture_plates.mjs /tmp/plates/jobs.json && open /tmp/plates/p.png
```
Expected: `[{"key":"plate_stock_chart","ok":true,...}]`, and the image shows the price-and-short chart card. If Playwright reports a missing browser, run `npx --prefix $SHORTED_REPO/web playwright install chromium`.

- [ ] **Step 7: Commit**

```bash
git add tools/shorted/brand.py tools/shorted/assets.py tools/shorted/capture_plates.mjs tests/shorted/test_brand_assets.py
git commit -m "feat(shorted): brand.json, live plate captures and the run's asset manifest"
```

### Task 19: Voice (TTS takes, recognition check, alignment)

**Files:**
- Create: `tools/shorted/asr.py`, `tools/shorted/voice.py`, `tools/shorted/narration.py`
- Test: `tests/shorted/test_narration.py`, `tests/shorted/test_voice.py`

**Interfaces:**
- Consumes:
  - `artifacts/gates.json` (Task 8): per cut, `lines` `{id, scene, chapter, spoken, display, style}`.
  - `artifacts/dossier.json`, for the tickers to spell out.
  - `GEMINI_API_KEY` (the studio's `.env`). OpenMontage's `GeminiTTS` adapter is NOT used: it closes its SDK client before it sends, so the pack carries the promo film's stdlib client as `voice.py`.
- Produces:
  - `asr.transcribe_words(path, prompt=None) -> [{w, s, e}]` (faster-whisper `small.en`, int8, on the CPU). `prompt` is the text the audio should say, but only `asr.vocabulary(prompt)` reaches the model: its acronyms and tickers, at most 20, never a figure or the words. A prompt holding the script made Whisper write the script whether or not the voice said it.
  - `asr.normalize(text) -> list[str]` (currencies spoken as words, % as per cent, one to ten as digits, both apostrophes and edge quotes folded), `asr.wer(ref, hyp) -> float`, `asr.numbers(text) -> list[str]`.
  - `asr.figures(text) -> [(sign, digits, scale)]`: sign from minus/negative/up/down, scale from thousand to trillion. A take must carry the script's figures exactly (a Counter, so a repeated figure counts twice).
  - `asr.ending_heard(script, heard) -> bool`: the script's last word is among the last 3 heard words and the word before it comes first, within the last 4. A take cut off before its ending can score a low WER on a long line.
  - `voice.synthesize(text, voice, style='', model=MODEL, retries=4, ...) -> bytes` (WAV) and `voice.VoiceError`: the key in a header only, never echoed; Retry-After honoured up to 60 s; a 200 without usable audio retried; the RIFF data length checked; a 180 s deadline per take.
  - `asr.align(script, words) -> [{w, s, e}]`: one entry per whitespace token of the script.
  - `narration.tts_text(spoken, tickers)`. Tickers are spelled out letter by letter for the voice only; WER is scored against the unspelled text.
  - `narration.narrate(project_dir, tts=gemini_tts, asr=whisper_asr) -> dict`, which writes `artifacts/narration.json`: `{cut: {line_id: {key, file, duration, wer, takes, words, tts_text, style, spoken}}}`. Here `file` is relative to the project (`assets/audio/lines/<key>.wav`: mono, 48 kHz, −18 LUFS, silence trimmed), and `words` are the script tokens, timed relative to the file start.
  - A take passes when its figures are exact, its ending is heard and its WER is at most 0.10 (`MAX_LINE_WER`); a good take (WER at most 0.05) stops the retakes; at most `MAX_TAKES` = 3. The best take sorts by (not complete, WER). A passing take is kept when a retake fails or is unreadable.
  - The line cache is keyed by the respelled voice text, style, voice and model; only passing lines are cached, written atomically.
  - `narrate` checks the gates first, removes a stale `narration.json`, writes it for the lines that passed, then raises one `NarrationError` listing `cut/line (reason): spoken` for the rest.
  - Identical lines across the cuts share one take.
  - Tool `shorted_narration`.
  - Fakes for tests: `TTS = (text, style, out_wav) -> None` and `ASR = (wav, prompt) -> words`.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_narration.py`:

```python
import base64
import json
import os
import re
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from tools.shorted import asr, narration, voice
from tools.shorted.asr import align, figures, normalize, numbers, wer
from tools.shorted.narration import (MAX_TAKES, MODEL, STYLE, VOICE, NarrationError, ShortedNarration, gemini_tts,
                                     narrate, tts_text)

WORD = 0.38


def fake_tts(calls):
    def tts(text, style, out):
        calls.append(text)
        sr, parts = 24000, [np.zeros(2880)]
        for i, _ in enumerate(text.split()):
            t = np.arange(int((WORD - 0.06) * sr)) / sr
            parts += [0.2 * np.sin(2 * np.pi * (180 + 20 * (i % 5)) * t) * np.hanning(len(t)), np.zeros(1440)]
        parts.append(np.zeros(2880))
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, np.concatenate(parts).astype(np.float32), sr)
    return tts


def perfect_asr(path, prompt):
    return [{"w": w, "s": 0.12 + i * WORD, "e": 0.12 + (i + 1) * WORD - 0.06} for i, w in enumerate(prompt.split())]


def project(tmp_path, lines_by_cut):
    pd = tmp_path / "EXM-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    (pd / "artifacts/dossier.json").write_text(json.dumps({"ticker": "EXM", "peers": {}}))
    gates = {cut: {"errors": [], "lines": [{"id": f"L{i}", "scene": "s1", "chapter": "result", "spoken": s,
                                           "display": s, "style": "warm"} for i, s in enumerate(lines)]}
             for cut, lines in lines_by_cut.items()}
    (pd / "artifacts/gates.json").write_text(json.dumps(gates))
    return pd


def test_tts_text_spells_tickers_only():
    assert tts_text("EXM is on the ASX.", {"EXM", "ASX"}) == "E X M is on the A S X."


def test_normalize_and_wer_forgive_formatting():
    assert normalize("A$1.5 billion, up 73%") == ["1.5", "billion", "dollars", "up", "73", "per", "cent"]
    assert normalize("E X M") == ["exm"]
    assert wer("Revenue was 1.5 billion dollars, up 73 per cent.", "revenue was $1.5 billion, up 73%") == 0.0
    assert wer("one two three four", "one two four") == 0.25
    assert numbers("Revenue of 1.5 billion dollars in 2026") == ["1.5", "2026"]
    assert normalize("A$12.50 and 2.00") == ["12.5", "dollars", "and", "2"]


def test_align_times_every_script_token():
    words = [{"w": "Revenue", "s": 0.0, "e": 0.4}, {"w": "was", "s": 0.4, "e": 0.6},
             {"w": "$1.5", "s": 0.6, "e": 1.0}, {"w": "billion.", "s": 1.0, "e": 1.4}]
    out = align("Revenue was 1.5 billion dollars.", words)
    assert [w["w"] for w in out] == ["Revenue", "was", "1.5", "billion", "dollars."]
    assert all(a["s"] <= b["s"] for a, b in zip(out, out[1:]))
    assert out[3]["s"] == 1.0


def test_narrate_writes_lines_and_shares_identical_takes(tmp_path):
    line = "Revenue came in at 216.5 million dollars."
    pd = project(tmp_path, {"long": [line, "Short interest is 15.07 per cent."], "short": [line]})
    calls = []
    out = narrate(pd, tts=fake_tts(calls), asr=perfect_asr)
    assert len(calls) == 2  # the shared line was synthesised once
    meta = out["long"]["L0"]
    assert meta["wer"] == 0.0 and meta["file"].startswith("assets/audio/lines/")
    y, sr = sf.read(pd / meta["file"])
    assert sr == 48000 and abs(len(y) / sr - meta["duration"]) < 0.01
    assert [w["w"] for w in meta["words"]] == line.split()
    assert json.loads((pd / "artifacts/narration.json").read_text())["short"]["L0"]["key"] == meta["key"]


def test_bad_take_is_retried_then_best_kept(tmp_path):
    pd = project(tmp_path, {"long": ["Net profit was 30.8 million dollars."]})
    seen = []

    def flaky_asr(path, prompt):
        seen.append(path)
        return perfect_asr(path, "Net loss was 13 thousand." if len(seen) == 1 else prompt)

    out = narrate(pd, tts=fake_tts([]), asr=flaky_asr)
    assert out["long"]["L0"]["takes"] == 2 and out["long"]["L0"]["wer"] == 0.0


def test_every_take_bad_fails_the_stage(tmp_path):
    pd = project(tmp_path, {"long": ["Net profit was 30.8 million dollars."]})
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts([]), asr=lambda p, prompt: perfect_asr(p, "completely different words here"))
    assert "L0" in str(err.value)


def test_numbers_the_recogniser_splits_are_rejoined():
    """faster-whisper returns 15.07 as the words '15' and '.07', and 12,345 as '12' and ',345'."""
    heard = [("at", 0.0, 0.2), ("15", 0.2, 0.5), (".07", 0.5, 0.9), ("per", 0.9, 1.0), ("cent", 1.0, 1.2),
             ("of", 1.2, 1.3), ("12", 1.3, 1.6), (",345", 1.6, 2.0), ("holders,", 2.0, 2.4),
             ("1", 2.4, 2.5), (",234", 2.5, 2.8), (".5", 2.8, 3.0), ("in", 3.0, 3.1), ("all.", 3.1, 3.3)]
    out = asr._join_numbers([{"w": w, "s": s, "e": e} for w, s, e in heard])
    assert [w["w"] for w in out] == ["at", "15.07", "per", "cent", "of", "12,345", "holders,", "1,234.5", "in", "all."]
    assert (out[1]["s"], out[1]["e"]) == (0.2, 0.9)  # a joined word spans both halves
    assert (out[5]["s"], out[5]["e"]) == (1.3, 2.0)
    assert (out[7]["s"], out[7]["e"]) == (2.4, 3.0)
    assert asr.wer("at 15.07 per cent of 12,345", " ".join(w["w"] for w in out[:6])) == 0.0


def test_punctuation_that_is_not_a_number_is_left_alone():
    words = [{"w": w, "s": float(i), "e": i + 0.5} for i, w in enumerate(["up", "5.", ".Then", ",", "profit", "7"])]
    assert [w["w"] for w in asr._join_numbers(words)] == ["up", "5.", ".Then", ",", "profit", "7"]


def test_transcribe_words_hands_the_model_samples_not_a_path(monkeypatch, tmp_path):
    """faster-whisper's own decoder calls av.open(metadata_errors=...), which PyAV 19 rejects."""
    seen = {}

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            seen["audio"] = audio
            return iter([]), None

    monkeypatch.setattr(asr, "_model", lambda: FakeModel())
    sf.write(tmp_path / "x.wav", np.zeros((48000, 2), np.float32), 48000, subtype="PCM_24")  # 1 s, stereo, 24-bit
    asr.transcribe_words(tmp_path / "x.wav", "prompt")
    assert isinstance(seen["audio"], np.ndarray) and seen["audio"].dtype == np.float32 and seen["audio"].ndim == 1
    assert len(seen["audio"]) == 16000  # 1 s at 16 kHz


def test_gemini_tts_speaks_through_the_packs_client_and_writes_the_wav(tmp_path, monkeypatch):
    calls = []

    def synthesize(*args, **kwargs):
        calls.append((args, kwargs))
        return b"RIFFxxxxWAVEfake"

    monkeypatch.setattr(voice, "synthesize", synthesize)
    out = tmp_path / "takes" / "x.wav"  # the folder does not exist yet
    gemini_tts("Short interest in D R O.", "warm, curious", out)
    assert calls == [(("Short interest in D R O.", VOICE, STYLE + "warm, curious", MODEL), {})]
    assert out.read_bytes() == b"RIFFxxxxWAVEfake"


def test_a_failed_tts_call_fails_the_stage_with_its_reason_and_writes_nothing(tmp_path, monkeypatch):
    def synthesize(*args, **kwargs):
        raise voice.VoiceError("HTTP 400 on attempt 1 of 4: voice not found", 400)

    monkeypatch.setattr(voice, "synthesize", synthesize)
    with pytest.raises(NarrationError, match="Gemini TTS failed: HTTP 400.*voice not found"):
        gemini_tts("Hello.", "warm", tmp_path / "x.wav")
    assert not (tmp_path / "x.wav").exists()


def test_the_stage_speaks_through_the_packs_client_when_given_no_tts(tmp_path, monkeypatch):
    """narrate() with its default TTS: only the HTTP layer is faked, so the request is built by voice.synthesize."""
    pd = project(tmp_path, {"long": ["Revenue came in at 216.5 million dollars."]})
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    sent = []

    def transport(url, headers, data, timeout=None):
        body = json.loads(data)
        text = body["input"][0]["content"][0]["text"]
        sent.append((url, headers["x-goog-api-key"], text, body["generation_config"], body["model"]))
        spoken = tmp_path / "reply.wav"
        fake_tts([])(text, "", spoken)
        block = {"type": "audio", "data": base64.b64encode(spoken.read_bytes()).decode()}
        return 200, {}, json.dumps({"steps": [{"type": "model_output", "content": [block]}]}).encode()

    monkeypatch.setattr(voice, "_urllib_transport", transport)
    meta = narrate(pd, asr=perfect_asr)["long"]["L0"]
    assert sent == [(voice.ENDPOINT, "test-key", "Revenue came in at 216.5 million dollars.",
                     {"speech_config": [{"voice": VOICE}]}, MODEL)]
    assert meta["wer"] == 0.0 and meta["takes"] == 1 and sf.info(pd / meta["file"]).samplerate == 48000


# ---- helpers for the checks below --------------------------------------------------------------------------

PLAIN = ("company reported steady profit growth across every region while costs stayed flat and cash balances rose "
         "through autumn trading despite weaker demand abroad and softer commodity prices management said order book "
         "looks healthy heading into second half financial year with strong pipeline projects several regional markets "
         "margins remain under pressure from higher freight labour").split()


def plain(n):
    """A line of n words with no figure in it."""
    return " ".join(PLAIN[:n]) + "."


def garble(text, k):
    """text with its first k words replaced by words nobody says."""
    words = text.split()
    words[:k] = ["zzz"] * k
    return " ".join(words)


def says(text):
    """The words a recogniser returns when the voice says text."""
    return perfect_asr(None, text)


class Hearing:
    """An ASR fake. In take n it hears heard[n - 1] (the last one after that); None is the script itself."""

    def __init__(self, *heard):
        self.heard, self.prompts = heard or (None,), []

    def __call__(self, path, prompt):
        self.prompts.append(prompt)
        text = self.heard[min(len(self.prompts), len(self.heard)) - 1]
        return says(prompt if text is None else text)


def hearing_by_script(wrong):
    """An ASR fake that hears every script perfectly except those in `wrong` (script -> what it hears instead)."""
    prompts = []

    def asr_fake(path, prompt):
        prompts.append(prompt)
        return says(wrong.get(prompt, prompt))

    asr_fake.prompts = prompts
    return asr_fake


def tone_tts(calls, seconds=(2.0,), silent=(), stereo=False):
    """A TTS fake whose nth call lasts seconds[n - 1] (the last length after that); calls in `silent` are silence."""
    def tts(text, style, out):
        calls.append(text)
        n = len(calls)
        t = np.arange(int(seconds[min(n, len(seconds)) - 1] * 24000)) / 24000
        tone = np.zeros_like(t) if n in silent else 0.2 * np.sin(2 * np.pi * 200 * t)
        y = np.concatenate([np.zeros(2880), tone, np.zeros(2880)])
        if stereo:
            y = np.stack([y, 0.5 * y], axis=1)
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, y.astype(np.float32), 24000)
    return tts


# ---- the take budget, best take and WER thresholds ---------------------------------------------------------

def test_a_line_whose_every_take_is_bad_costs_exactly_three_takes_and_is_named_with_its_text(tmp_path):
    line = "Net profit was 30.8 million dollars."
    pd = project(tmp_path, {"long": [line]})
    calls, heard = [], Hearing("completely different words here")
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts(calls), asr=heard)
    assert MAX_TAKES == 3 and len(calls) == 3 and len(heard.prompts) == 3
    assert f"long/L0 (" in str(err.value) and f"): {line}" in str(err.value) and "WER" in str(err.value)


def test_the_best_take_is_kept_even_when_it_is_not_the_last(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=tone_tts(calls, seconds=(2.0, 3.0, 4.0)),
                   asr=Hearing(garble(line, 4), garble(line, 2), garble(line, 3)))["long"]["L0"]  # WER .20, .10, .15
    assert len(calls) == 3 and meta["takes"] == 3 and meta["wer"] == 0.1
    assert meta["duration"] == pytest.approx(3.0 + 0.08, abs=0.02)  # the second take's audio, not the last (4.08 s)
    assert meta["words"][0]["w"] == line.split()[0] and meta["words"][0]["s"] == pytest.approx(0.04, abs=0.01)


@pytest.mark.parametrize("n, k, takes, passes", [
    (20, 1, 1, True),   # 1/20 = 0.05, at the target: the first take is kept
    (19, 1, 3, True),   # 1/19 = 0.0526, over the target: taken again, and a take within the limit is kept
    (20, 2, 3, True),   # 2/20 = 0.10, at the limit
    (21, 2, 3, True),   # 0.095
    (20, 3, 3, False),  # 0.15
    (9, 1, 3, False),   # 1/9 = 0.111
], ids=["0.05-at-target", "0.0526-over-target", "0.10-at-limit", "0.095", "0.15-over-limit", "0.111-short-line"])
def test_the_wer_target_and_limit_are_inclusive_at_their_boundaries(tmp_path, n, k, takes, passes):
    line = plain(n)
    pd = project(tmp_path, {"long": [line]})
    calls = []
    run = lambda: narrate(pd, tts=fake_tts(calls), asr=Hearing(garble(line, k)))
    if passes:
        meta = run()["long"]["L0"]
        assert meta["takes"] == takes and meta["wer"] == round(k / n, 4)
    else:
        with pytest.raises(NarrationError, match=r"WER 0\.\d\d over the 0\.10 limit"):
            run()
    assert len(calls) == takes


# ---- figures: sign, direction, scale ----------------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("Short interest was 15.07 per cent.", [("", "15.07", "")]),
    ("Revenue was up 73 per cent.", [("up", "73", "")]),
    ("Revenue was down 73 per cent.", [("down", "73", "")]),
    ("The change was minus 3.2 per cent.", [("-", "3.2", "")]),
    ("The change was negative 3.2 per cent.", [("-", "3.2", "")]),
    ("The change was -3.2% and then −4.5%.", [("-", "3.2", ""), ("-", "4.5", "")]),
    ("Net profit was minus A$3.2 million.", [("-", "3.2", "million")]),
    ("Net profit was -$3.2 million.", [("-", "3.2", "million")]),
    ("Revenue came in at 216.5 million dollars.", [("", "216.5", "million")]),
    ("Revenue came in at 216.5 billion dollars.", [("", "216.5", "billion")]),
    ("Revenue came in at A$1.5 trillion.", [("", "1.5", "trillion")]),
    ("About 12 thousand holders.", [("", "12", "thousand")]),
    ("In the 12 months to 30 June 2026.", [("", "12", ""), ("", "30", ""), ("", "2026", "")]),
    ("Up from 12.5 to 15.07 per cent, a rise of 2.57 percentage points.", [("", "12.5", ""), ("", "15.07", ""), ("", "2.57", "")]),
    ("There were seven director trades and 12 announcements.", [("", "7", ""), ("", "12", "")]),
    ("It ranks number three, up two places.", [("", "3", ""), ("up", "2", "")]),
    ("A 2020-21 comparison of year-on-year growth.", [("", "2020", ""), ("", "21", "")]),  # a hyphen is not a minus
    ("No figures here at all.", []),
], ids=lambda v: v[:28] if isinstance(v, str) else "")
def test_figures_read_sign_digits_and_scale(text, expected):
    assert figures(text) == expected


def test_numbers_still_reads_digits_only_as_the_brief_pins_it():
    assert numbers("Revenue of 1.5 billion dollars in 2026") == ["1.5", "2026"]
    assert numbers("Revenue was minus 3.2 million dollars, up 73 per cent") == ["3.2", "73"]  # no sign, no scale


@pytest.mark.parametrize("script, heard", [
    ("Revenue was 1.5 billion dollars.", "Revenue was $1.5 billion."),
    ("Revenue was up 73 per cent.", "Revenue was up 73%."),
    ("The change was minus 3.2 per cent.", "The change was -3.2%."),
    ("Debt was 12.5 billion US dollars.", "Debt was US$12.5 billion."),
    ("Debt was 1.5 million pounds.", "Debt was £1.5 million."),
    ("Debt was 2 billion euros.", "Debt was €2 billion."),
    ("Debt was 5 million New Zealand dollars.", "Debt was NZ$5 million."),
    ("Debt was 5 million Canadian dollars.", "Debt was C$5 million."),
    ("There were 7 director trades.", "There were seven director trades."),
    ("It ranks number 3 on the list.", "It ranks number three on the list."),
    ("The dividend was 0 cents.", "The dividend was zero cents."),
    ("There are 12,345 holders.", "There are 12345 holders."),
    ("There are 1,234,567 shares.", "There are 1,234,567 shares."),
    ("The price was 12.50 dollars.", "The price was 12.5 dollars."),
    ("On the 7th of October.", "On the 7 of October."),
    ("The company’s shares rose.", "The company's shares rose."),
    ("The company's shares rose.", "The company’s shares rose."),
], ids=lambda v: v[:30])
def test_forms_the_recogniser_writes_differently_are_the_same_words_and_figures(script, heard):
    assert wer(script, heard) == 0.0 and Counter_(figures(script)) == Counter_(figures(heard))


def Counter_(items):
    from collections import Counter
    return Counter(items)


FIGURE_CASES = [
    ("digits swapped", "stands at 15.07 per cent", "stands at 15.70 per cent", "15.07", "15.7"),
    ("minus dropped", "fell minus 3.2 per cent", "fell 3.2 per cent", "-3.2", "3.2"),
    ("up said for down", "was down 73 per cent", "was up 73 per cent", "down 73", "up 73"),
    ("down said for up", "was up 73 per cent", "was down 73 per cent", "up 73", "down 73"),
    ("million said for billion", "came in at 216.5 million dollars", "came in at 216.5 billion dollars",
     "216.5 million", "216.5 billion"),
    ("scale left out", "came in at 216.5 million dollars", "came in at 216.5 dollars", "216.5 million", "216.5"),
    ("figure left out", "in the year to June 2026", "in the year to June", "2026", "none"),
    ("figure added", "in the year to June", "in the year to June 2026", "none", "2026"),
    ("one figure of two", "rose 12 per cent from 15.07 per cent", "rose 12 per cent from 15 per cent", "12, 15.07", "12, 15"),
]


@pytest.mark.parametrize("label, said, heard, expected, got", FIGURE_CASES, ids=[c[0] for c in FIGURE_CASES])
def test_a_wrong_figure_fails_the_line_however_good_its_wer_and_the_error_names_both_figures(tmp_path, label, said, heard,
                                                                                            expected, got):
    script = f"Results {said} " + plain(22)  # long enough that one wrong word is well inside the 0.10 WER limit
    spoken = script.replace(said, heard)
    assert wer(script, spoken) <= 0.05, "the premise: WER alone would accept this take"
    pd = project(tmp_path, {"long": [script]})
    calls = []
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts(calls), asr=Hearing(spoken))
    assert f"figures: expected {expected}, heard {got}" in str(err.value)
    assert "long/L0" in str(err.value) and len(calls) == 3


def test_a_take_with_every_figure_right_beats_a_take_with_fewer_errors_but_a_wrong_figure(tmp_path):
    line = "Short interest stands at 15.07 per cent of shares on issue " + plain(15)  # 26 words
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=tone_tts(calls, seconds=(2.0, 3.0, 4.0)),
                   asr=Hearing(line.replace("15.07", "15.70"), "uh " + line + " uh", "uh " + line + " uh"))["long"]["L0"]
    assert meta["takes"] == 3 and meta["wer"] == round(2 / 26, 4)  # not the 1/26 take: its figure is wrong
    assert meta["duration"] == pytest.approx(3.08, abs=0.02)  # the second take, the first of the two right ones


def test_a_right_figure_with_a_slightly_wrong_word_still_passes_on_its_figures(tmp_path):
    line = "Of its 5 peers, 2 are shorted more heavily, up 8 per cent on the month, " + plain(12)
    pd = project(tmp_path, {"long": [line]})
    heard = "of its five peers, two are shorted more heavily, up 8% on the month, " + plain(12)
    meta = narrate(pd, tts=fake_tts([]), asr=Hearing(heard))["long"]["L0"]
    assert meta["takes"] == 1 and meta["wer"] == 0.0  # the recogniser's own style: one to nine as words, % for per cent


# ---- what the recogniser is told ---------------------------------------------------------------------------

class SpyModel:
    def __init__(self):
        self.kwargs = []

    def transcribe(self, audio, **kwargs):
        self.kwargs.append(kwargs)
        return iter([]), None


def test_the_recogniser_is_given_acronyms_only_never_a_figure_or_the_scripts_words(monkeypatch, tmp_path):
    spy = SpyModel()
    monkeypatch.setattr(asr, "_model", lambda: spy)
    sf.write(tmp_path / "x.wav", np.zeros(16000, np.float32), 16000)
    line = "Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC."
    asr.transcribe_words(tmp_path / "x.wav", line)
    prompt = spy.kwargs[0]["initial_prompt"]
    assert prompt == "DRO, ASIC."
    assert not any(ch.isdigit() for ch in prompt)
    assert not {"short", "interest", "stands", "per", "cent", "shares", "according"} & set(re.findall(r"[a-z]+", prompt.lower()))
    assert asr.numbers(prompt) == [] and "15.07" not in prompt


@pytest.mark.parametrize("script, expected", [
    ("Short interest in DRO stands at 15.07 per cent, according to ASIC and the ASX, then DRO again.", "DRO, ASIC, ASX."),
    ("A2M, 3PL and 88E sit beside AL3 and BHP.", "A2M, 3PL, 88E, AL3, BHP."),
    ("Revenue was 216.5 million dollars in 2026, up 73 per cent.", None),
    ("EXM is on the ASX.", "EXM, ASX."),
    ("", None),
    (None, None),
], ids=["deduplicated-in-order", "tickers-with-digits", "no-acronyms", "short", "empty", "none"])
def test_the_vocabulary_is_a_scripts_acronyms_in_order_without_repeats(script, expected):
    assert asr.vocabulary(script) == expected


def test_the_vocabulary_never_holds_a_bare_number_or_a_plain_word_whatever_the_script():
    script = "In 2026 the 12 months to 30 June saw 15.07 per cent, 1H26 and FY26 aside, from Revenue and Net Profit."
    prompt = asr.vocabulary(script)
    assert prompt == "1H26, FY26."  # labels with letters are vocabulary; 2026, 12, 30 and 15.07 are figures
    assert not set(re.findall(r"\b\d+(?:\.\d+)?\b", prompt))


def test_a_script_with_no_acronym_gives_the_recogniser_no_prompt_at_all(monkeypatch, tmp_path):
    spy = SpyModel()
    monkeypatch.setattr(asr, "_model", lambda: spy)
    sf.write(tmp_path / "x.wav", np.zeros(16000, np.float32), 16000)
    asr.transcribe_words(tmp_path / "x.wav", "Revenue came in at 216.5 million dollars.")
    asr.transcribe_words(tmp_path / "x.wav")
    assert [k["initial_prompt"] for k in spy.kwargs] == [None, None]


# ---- resume, re-render, caching ----------------------------------------------------------------------------

def test_a_second_run_over_a_finished_project_adds_no_takes_and_no_recognition(tmp_path):
    pd = project(tmp_path, {"long": ["Revenue came in at 216.5 million dollars.", plain(12)], "short": [plain(12)]})
    calls, heard = [], Hearing()
    first = narrate(pd, tts=fake_tts(calls), asr=heard)
    n_calls, n_heard = len(calls), len(heard.prompts)
    again = narrate(pd, tts=fake_tts(calls), asr=heard)
    assert n_calls == 2 and len(calls) == 2 and len(heard.prompts) == n_heard  # the shared line was one take, then nothing
    assert again == first


@pytest.mark.parametrize("change", ["voice", "model", "global style", "line style"])
def test_a_changed_voice_model_or_style_takes_the_line_again_and_an_unchanged_one_does_not(tmp_path, monkeypatch, change):
    pd = project(tmp_path, {"long": ["Revenue came in at 216.5 million dollars."]})
    calls = []
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 1
    if change == "voice":
        monkeypatch.setattr(narration, "VOICE", "en-au-other-1")
    elif change == "model":
        monkeypatch.setattr(narration, "MODEL", "gemini-other-tts")
    elif change == "global style":
        monkeypatch.setattr(narration, "STYLE", "A different narrator altogether. ")
    else:
        gates = json.loads((pd / "artifacts/gates.json").read_text())
        gates["long"]["lines"][0]["style"] = "dry, amused"
        (pd / "artifacts/gates.json").write_text(json.dumps(gates))
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 2
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 2


def test_a_failed_line_is_not_cached_so_the_next_run_takes_it_afresh(tmp_path):
    line = "Net profit was 30.8 million dollars."
    pd = project(tmp_path, {"long": [line]})
    calls = []
    with pytest.raises(NarrationError):
        narrate(pd, tts=fake_tts(calls), asr=Hearing("completely different words here"))
    assert len(calls) == 3 and not list((pd / "assets/audio/lines").glob("*"))  # no line file, no JSON
    out = narrate(pd, tts=fake_tts(calls), asr=Hearing())  # the recogniser is right this time
    assert len(calls) == 4 and out["long"]["L0"]["wer"] == 0.0


def test_a_cache_entry_that_is_torn_or_from_an_older_layout_is_taken_again_not_trusted(tmp_path):
    line = "Revenue came in at 216.5 million dollars."
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=fake_tts(calls), asr=Hearing())["long"]["L0"]
    cache = (pd / meta["file"]).with_suffix(".json")
    cache.write_text('{"key": "x", "wer": ')  # torn
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 2
    old = json.loads(cache.read_text())
    del old["lufs"]  # a layout from before the loudness was recorded
    cache.write_text(json.dumps(old))
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 3
    old["wer"] = 0.5  # a failing line somebody cached
    cache.write_text(json.dumps({**old, "lufs": -18.0}))
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 4


def test_the_cache_json_is_written_whole_or_not_at_all(tmp_path, monkeypatch):
    line = "Revenue came in at 216.5 million dollars."
    pd = project(tmp_path, {"long": [line]})
    calls = []

    def torn(src, dst):
        raise OSError("the disk went away")

    with monkeypatch.context() as m:
        m.setattr(os, "replace", torn)
        with pytest.raises(OSError):
            narrate(pd, tts=fake_tts(calls), asr=Hearing())
    lines = pd / "assets/audio/lines"
    assert not [f for f in lines.glob("*.json")]  # the finished WAV is there, but no entry claims it
    narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert len(calls) == 2 and not list(lines.glob("*.tmp"))


# ---- every line is tried, one error lists the bad ones -----------------------------------------------------

def test_every_line_is_tried_the_good_ones_kept_and_one_error_lists_the_bad_ones(tmp_path):
    good1, bad, good2 = "Revenue came in at 216.5 million dollars.", "Net profit was 30.8 million dollars.", \
        "Short interest is 15.07 per cent."
    pd = project(tmp_path, {"long": [good1, bad, good2], "short": [good1]})
    calls = []
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts(calls), asr=hearing_by_script({bad: "Net loss was 13 thousand."}))
    msg = str(err.value)
    assert len(calls) == 1 + 3 + 1  # the first line once (its short-cut twin is cached), the bad one three times, the last once
    assert msg.count("long/L1 (") == 1 and f"): {bad}" in msg
    assert "long/L0" not in msg and "long/L2" not in msg and "short/" not in msg and "figures: expected 30.8" in msg
    done = json.loads((pd / "artifacts/narration.json").read_text())
    assert sorted(done["long"]) == ["L0", "L2"] and sorted(done["short"]) == ["L0"]


def test_a_tts_failure_on_one_line_is_reported_and_the_other_lines_still_get_their_takes(tmp_path):
    lines = ["Revenue came in at 216.5 million dollars.", "Net profit was 30.8 million dollars.", "Short interest is 15.07 per cent."]
    pd = project(tmp_path, {"long": lines})
    spoken = []

    def tts(text, style, out):
        spoken.append(text)
        if text.startswith("Net profit"):
            raise NarrationError("Gemini TTS failed: HTTP 503 on attempt 4 of 4: busy")
        fake_tts([])(text, style, out)

    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=tts, asr=Hearing())
    assert len(spoken) == 3
    assert "long/L1 (Gemini TTS failed: HTTP 503 on attempt 4 of 4: busy): Net profit was 30.8 million dollars." in str(err.value)
    assert sorted(json.loads((pd / "artifacts/narration.json").read_text())["long"]) == ["L0", "L2"]


def test_a_failing_line_shared_by_two_cuts_is_taken_once_and_reported_for_both(tmp_path):
    line = "Net profit was 30.8 million dollars."
    pd = project(tmp_path, {"long": [line], "short": [line]})
    calls = []
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts(calls), asr=Hearing("completely different words here"))
    assert len(calls) == 3 and "long/L0 (" in str(err.value) and "short/L0 (" in str(err.value)


@pytest.mark.parametrize("bad_cuts", [["short"], ["long", "short"]], ids=["second-cut", "both-cuts"])
def test_gate_errors_in_any_cut_stop_the_stage_before_a_single_take_and_remove_a_stale_file(tmp_path, bad_cuts):
    pd = project(tmp_path, {"long": [plain(8)], "short": [plain(8)]})
    gates = json.loads((pd / "artifacts/gates.json").read_text())
    for cut in bad_cuts:
        gates[cut]["errors"] = ["a gate error"]
    (pd / "artifacts/gates.json").write_text(json.dumps(gates))
    stale = pd / "artifacts/narration.json"
    stale.write_text('{"stale": true}')
    calls = []
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts(calls), asr=Hearing())
    assert calls == [] and not stale.exists()
    assert all(f"{cut} storyboard has gate errors" in str(err.value) for cut in bad_cuts)


def test_a_stale_narration_file_does_not_survive_a_run_that_cannot_finish(tmp_path):
    pd = project(tmp_path, {"long": [plain(8)]})
    (pd / "artifacts/narration.json").write_text('{"long": {"L0": "from an earlier run"}}')

    def explodes(path, prompt):
        raise RuntimeError("the recogniser model is missing")  # not a bad line: the environment is broken

    with pytest.raises(RuntimeError):
        narrate(pd, tts=fake_tts([]), asr=explodes)
    assert not (pd / "artifacts/narration.json").exists()


def test_a_broken_recogniser_stops_the_stage_at_once_instead_of_paying_for_every_line(tmp_path):
    pd = project(tmp_path, {"long": [plain(8), plain(9), plain(10)]})
    calls = []

    def explodes(path, prompt):
        raise RuntimeError("the recogniser model is missing")

    with pytest.raises(RuntimeError):
        narrate(pd, tts=fake_tts(calls), asr=explodes)
    assert len(calls) == 1


# ---- silence ----------------------------------------------------------------------------------------------

def test_a_silent_take_counts_as_nothing_heard_and_is_taken_again(tmp_path):
    pd = project(tmp_path, {"long": ["Net profit was 30.8 million dollars."]})
    calls, heard = [], Hearing()
    meta = narrate(pd, tts=tone_tts(calls, silent={1, 2}), asr=heard)["long"]["L0"]
    assert len(calls) == 3 and meta["takes"] == 3 and meta["wer"] == 0.0
    assert len(heard.prompts) == 1  # the recogniser was not asked to imagine words for silence


def test_a_line_that_is_silent_every_time_fails_by_name_and_the_stage_goes_on(tmp_path):
    pd = project(tmp_path, {"long": ["Net profit was 30.8 million dollars.", "Short interest is 15.07 per cent."]})
    calls = []
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=tone_tts(calls, silent={1, 2, 3}), asr=Hearing())
    assert "long/L0 (silent audio; best of 3 takes): Net profit was 30.8 million dollars." in str(err.value)
    assert len(calls) == 4 and sorted(json.loads((pd / "artifacts/narration.json").read_text())["long"]) == ["L1"]


def test_a_silent_take_never_outranks_an_audible_one_so_the_error_gives_the_useful_reason(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    with pytest.raises(NarrationError) as err:  # take 1 is audible and 30% wrong; takes 2 and 3 are silent
        narrate(pd, tts=tone_tts([], silent={2, 3}), asr=Hearing(garble(line, 6)))
    assert "WER 0.30 over the 0.10 limit; best of 3 takes" in str(err.value) and "silent" not in str(err.value)


def test_a_silent_take_never_outranks_one_with_a_wrong_figure_either(tmp_path):
    line = "Short interest stands at 15.07 per cent of shares on issue " + plain(15)
    pd = project(tmp_path, {"long": [line]})
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=tone_tts([], silent={2, 3}), asr=Hearing(line.replace("15.07", "15.70")))
    assert "figures: expected 15.07, heard 15.7" in str(err.value) and "silent" not in str(err.value)


def test_a_reply_that_is_not_audio_fails_its_line_by_name(tmp_path):
    pd = project(tmp_path, {"long": ["Net profit was 30.8 million dollars."]})

    def tts(text, style, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"this is not a wav file at all")

    with pytest.raises(NarrationError, match=r"long/L0 \(.* is not readable audio"):
        narrate(pd, tts=tts, asr=Hearing())


# ---- a retake that cannot be had ---------------------------------------------------------------------------

def test_a_retake_that_cannot_be_had_keeps_the_take_already_in_hand_when_it_is_good_enough(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    calls = []

    def tts(text, style, out):
        calls.append(text)
        if len(calls) == 2:
            raise NarrationError("Gemini TTS failed: HTTP 503 on attempt 4 of 4: busy")
        fake_tts([])(text, style, out)

    meta = narrate(pd, tts=tts, asr=Hearing(garble(line, 2)))["long"]["L0"]  # WER 0.10: within the limit, over the target
    assert len(calls) == 2 and meta["takes"] == 1 and meta["wer"] == 0.1


def test_a_retake_that_cannot_be_had_fails_the_line_when_nothing_in_hand_is_good_enough(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    calls = []

    def tts(text, style, out):
        calls.append(text)
        if len(calls) == 2:
            raise NarrationError("Gemini TTS failed: HTTP 503 on attempt 4 of 4: busy")
        fake_tts([])(text, style, out)

    with pytest.raises(NarrationError, match=r"long/L0 \(Gemini TTS failed: HTTP 503"):
        narrate(pd, tts=tts, asr=Hearing(garble(line, 4)))


# ---- the finished line file --------------------------------------------------------------------------------

def test_the_line_file_is_mono_48k_trimmed_to_40_ms_pads_and_at_minus_18_lufs_and_meta_says_so(tmp_path):
    import pyloudnorm as pyln

    pd = project(tmp_path, {"long": ["Revenue came in at 216.5 million dollars."]})
    meta = narrate(pd, tts=tone_tts([], seconds=(3.0,), stereo=True), asr=Hearing())["long"]["L0"]  # a stereo take in
    info = sf.info(pd / meta["file"])
    assert info.channels == 1 and info.samplerate == 48000 and info.subtype == "PCM_24"
    y, sr = sf.read(pd / meta["file"])
    loud = np.flatnonzero(np.abs(y) > 10 ** (-45 / 20))
    assert 0.03 <= loud[0] / sr <= 0.05 and 0.03 <= (len(y) - 1 - loud[-1]) / sr <= 0.06  # the 120 ms of silence are gone
    lufs = pyln.Meter(sr).integrated_loudness(y)
    assert abs(lufs - (-18.0)) <= 1.0 and meta["lufs"] == pytest.approx(lufs, abs=0.01)
    assert meta["duration"] == pytest.approx(len(y) / sr, abs=0.001) and meta["duration"] == pytest.approx(3.08, abs=0.02)


def test_a_line_under_half_a_second_records_no_loudness(tmp_path):
    pd = project(tmp_path, {"long": ["Yes."]})
    meta = narrate(pd, tts=tone_tts([], seconds=(0.3,)), asr=Hearing())["long"]["L0"]
    assert meta["lufs"] is None and sf.info(pd / meta["file"]).channels == 1


def test_word_times_are_plain_floats_relative_to_the_trimmed_file_so_the_json_is_safe(tmp_path):
    pd = project(tmp_path, {"long": ["Revenue came in at 216.5 million dollars."]})
    meta = narrate(pd, tts=tone_tts([], seconds=(3.0,)), asr=Hearing())["long"]["L0"]
    assert all(type(w["s"]) is float and type(w["e"]) is float for w in meta["words"])
    assert type(meta["duration"]) is float and meta["words"][0]["s"] < 0.2


# ---- the tool --------------------------------------------------------------------------------------------

def test_the_tool_reports_the_lines_and_takes_and_the_artifact_on_success(tmp_path, monkeypatch):
    a, b = "Revenue came in at 216.5 million dollars.", "Short interest is 15.07 per cent."
    pd = project(tmp_path, {"long": [a, b], "short": [a]})
    sample = tmp_path / "sample.wav"
    fake_tts([])("x y z", "", sample)
    monkeypatch.setattr(voice, "synthesize", lambda *args, **kwargs: sample.read_bytes())
    monkeypatch.setattr(asr, "transcribe_words", lambda path, prompt=None: says(prompt))
    result = ShortedNarration().execute({"project_dir": str(pd)})
    assert result.success and result.data == {"lines": {"long": 2, "short": 1}, "takes": 3}
    assert result.artifacts == [str(pd / "artifacts" / "narration.json")]


def test_the_tool_returns_the_error_text_and_no_exception_when_a_line_fails(tmp_path, monkeypatch):
    a, b = "Revenue came in at 216.5 million dollars.", "Short interest is 15.07 per cent."
    pd = project(tmp_path, {"long": [a, b]})
    sample = tmp_path / "sample.wav"
    fake_tts([])("x y z", "", sample)
    monkeypatch.setattr(voice, "synthesize", lambda *args, **kwargs: sample.read_bytes())
    monkeypatch.setattr(asr, "transcribe_words", lambda path, prompt=None: says(prompt.replace("15.07", "51.07")))
    result = ShortedNarration().execute({"project_dir": str(pd)})  # the first line is heard right, the second is not
    assert not result.success and "long/L1 (figures: expected 15.07, heard 51.07" in result.error
    assert "long/L0" not in result.error and f"): {b}" in result.error
    assert sorted(json.loads((pd / "artifacts/narration.json").read_text())["long"]) == ["L0"]  # the good line is kept


def test_the_tool_returns_the_gate_error_and_makes_no_take(tmp_path, monkeypatch):
    pd = project(tmp_path, {"long": [plain(8)]})
    gates = json.loads((pd / "artifacts/gates.json").read_text())
    gates["long"]["errors"] = ["a gate error"]
    (pd / "artifacts/gates.json").write_text(json.dumps(gates))
    monkeypatch.setattr(voice, "synthesize", lambda *args, **kwargs: pytest.fail("a take was made"))
    result = ShortedNarration().execute({"project_dir": str(pd)})
    assert not result.success and "long storyboard has gate errors" in result.error


# ---- what the voice is asked to say ------------------------------------------------------------------------

def test_the_respelling_is_applied_to_the_voice_and_never_to_the_script(tmp_path):
    line = "NPAT was 30.8 million dollars."
    assert tts_text(line, {"EXM"}) == "N-PAT was 30.8 million dollars."
    pd = project(tmp_path, {"long": [line]})
    calls, heard = [], Hearing()
    meta = narrate(pd, tts=fake_tts(calls), asr=heard)["long"]["L0"]
    assert calls == ["N-PAT was 30.8 million dollars."] and heard.prompts == [line]  # the check reads the unrespelled line
    assert meta["tts_text"] == calls[0] and meta["spoken"] == line and [w["w"] for w in meta["words"]] == line.split()


def test_tickers_are_spelled_letter_by_letter_including_those_that_start_with_a_digit():
    tickers = {"DRO", "3PL", "88E", "A2M", "AL3"}
    assert tts_text("3PL and 88E, A2M and AL3 beat DRO in 2026 by 15.07 per cent.", tickers) == \
        "3 P L and 8 8 E, A 2 M and A L 3 beat D R O in 2026 by 15.07 per cent."
    assert tts_text("The 3PL report: 3 PL and 88 E are not tickers.", {"3PL"}) == "The 3 P L report: 3 PL and 88 E are not tickers."


# ---- the smaller fixes -------------------------------------------------------------------------------------

def test_aligned_starts_never_run_backwards_when_the_recognised_words_overlap():
    words = [{"w": "one", "s": 0.0, "e": 1.0}, {"w": "three", "s": 0.8, "e": 1.5}, {"w": "four", "s": 1.5, "e": 2.0}]
    out = align("one two three four", words)
    assert [w["w"] for w in out] == ["one", "two", "three", "four"]
    assert [w["s"] for w in out] == [0.0, 1.0, 1.0, 1.5]
    assert all(w["e"] >= w["s"] + 0.02 for w in out)


@pytest.mark.parametrize("pieces, joined", [
    (["was", "30", ".8.", "then"], ["was", "30.8.", "then"]),
    (["at", "15", ".07,", "of"], ["at", "15.07,", "of"]),
    (["were", "12", ",345."], ["were", "12,345."]),
    (["of", "12", ",345;", "and"], ["of", "12,345;", "and"]),
    (["about", "1", ",234", ".5!"], ["about", "1,234.5!"]),
    (["up", "5.", ".5"], ["up", "5.", ".5"]),  # a full stop ends the first word, so the next is not its fraction
    (["a", ".5", "b"], ["a", ".5", "b"]),
    (["x", "7", ".Then"], ["x", "7", ".Then"]),
], ids=["decimal-then-stop", "decimal-then-comma", "thousands-then-stop", "semicolon", "chain-with-bang", "stop-first",
        "nothing-before", "a-word"])
def test_a_number_the_recogniser_splits_is_rejoined_even_with_punctuation_stuck_to_the_fragment(pieces, joined):
    words = [{"w": w, "s": float(i), "e": i + 0.5} for i, w in enumerate(pieces)]
    assert [w["w"] for w in asr._join_numbers(words)] == joined


def test_the_joined_number_is_scored_as_the_script_writes_it():
    heard = [{"w": w, "s": float(i), "e": i + 0.5} for i, w in enumerate(["Net", "profit", "was", "30", ".8."])]
    assert wer("Net profit was 30.8.", " ".join(w["w"] for w in asr._join_numbers(heard))) == 0.0


@pytest.mark.parametrize("text, tokens", [
    ("A$1.5 billion", ["1.5", "billion", "dollars"]),
    ("US$12.5 billion", ["12.5", "billion", "us", "dollars"]),
    ("NZ$5 million", ["5", "million", "new", "zealand", "dollars"]),
    ("C$5 million", ["5", "million", "canadian", "dollars"]),
    ("£1.5 million", ["1.5", "million", "pounds"]),
    ("€2 billion", ["2", "billion", "euros"]),
    ("$3", ["3", "dollars"]),
    ("1.5 billion US dollars", ["1.5", "billion", "us", "dollars"]),
    ("1.5 million pounds", ["1.5", "million", "pounds"]),
    ("2 billion euros", ["2", "billion", "euros"]),
    ("-3.2%", ["minus", "3.2", "per", "cent"]),
    ("−3.2 million", ["minus", "3.2", "million"]),
    ("minus 3.2 per cent", ["minus", "3.2", "per", "cent"]),
    ("2020-21 and year-on-year", ["2020", "21", "and", "year", "on", "year"]),
    ("2020\u201321, 5\u20136 and a dash \u2014 here", ["2020", "21", "5", "6", "and", "a", "dash", "here"]),
    ("seven of nine, ten, zero", ["7", "of", "9", "10", "0"]),
    ("the company’s, the companyʼs, the company‘s, the company's", ["the", "company's"] * 4),
    ("1,234,567 and 12,345 and 1,234.50 and 12,3456", ["1234567", "and", "12345", "and", "1234.5", "and", "12", "3456"]),
], ids=lambda v: v[:24] if isinstance(v, str) else "")
def test_normalize_writes_symbols_signs_and_number_words_the_way_they_are_spoken(text, tokens):
    assert normalize(text) == tokens


# ---- a take must be heard to its end -----------------------------------------------------------------------

LIVE_LINE = "Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC."
YEAR_LINE = "The board expects to pay the same dividend as in the year ended last year."


def drop_tail(text, k):
    """text without its last k words: what a voice that stopped early would have said."""
    return " ".join(text.split()[:-k])


@pytest.mark.parametrize("script, heard", [
    (LIVE_LINE, LIVE_LINE),
    (LIVE_LINE, "Short interest in DRO stands at 15.07 % of its shares according to ASIC."),
    (LIVE_LINE, LIVE_LINE + " Thank you."),  # two words of the recogniser's own are tolerated
    ("That ranks DRO second among its peers, behind EOS and ELS.", "That ranks DRO second among its peers behind E O S and E L S."),
    ("It ranks number 3.", "It ranks number three."),
    ("The next catalyst is the full-year result on 25 February 2027.", "The next catalyst is the full year result on the 25th of February, 2027."),
    ("Short interest is now 15.07 per cent.", "Short interest is now 15.07%."),
    ("Debt is 3.2 times earnings.", "debt is 3.2 times earnings"),
    (YEAR_LINE, YEAR_LINE),
    ("Yes.", "yes"),
    ("Yes.", "Yes. Thank you."),
    ("", "anything at all"),
], ids=["whole", "percent-sign", "two-word-hallucination", "spelled-tickers", "number-word", "date", "percent-at-the-end",
        "no-punctuation", "repeated-word-whole", "one-word", "one-word-two-after", "empty-script"])
def test_a_take_that_reaches_the_scripts_last_words_in_order_hears_its_ending(script, heard):
    assert asr.ending_heard(script, heard)


@pytest.mark.parametrize("script, heard", [
    (LIVE_LINE, "Short interest in DRO stands at 15.07 per cent of its shares, according to"),
    (LIVE_LINE, "Short interest in DRO stands at 15.07 per cent of its shares, according"),
    (LIVE_LINE, "Short interest in DRO stands at"),
    (YEAR_LINE, "The board expects to pay the same dividend as in the year ended last"),  # 'last year' heard as 'last'
    (LIVE_LINE, "Short interest in DRO stands at 15.07 per cent of its shares, according ASIC."),  # the word before it dropped
    (LIVE_LINE, LIVE_LINE + " Thanks for watching."),  # three words of the recogniser's own push the end out of reach
    (LIVE_LINE, "according to ASIC. Short interest in DRO stands at 15.07 per cent of its shares"),  # the right words, wrong order
    ("Costs rose over the quarter.", "the costs rose sharply in late quarter"),  # the word before it is not among the last four
    (LIVE_LINE, ""),
    ("Net profit was 30.8 million dollars.", "Net profit was 30.8"),
    ("Yes.", ""),
    ("Yes.", "Thanks for watching, everyone."),
    ("Yes.", "Yes, thanks for watching."),  # the one word is there, but three words later: outside the last three
], ids=["last-word-missing", "two-missing", "half-the-line", "repeated-word", "word-before-dropped", "three-word-hallucination",
        "wrong-order", "word-before-out-of-window", "nothing-heard", "end-of-a-figure", "one-word-nothing", "one-word-elsewhere",
        "one-word-three-after"])
def test_a_take_that_stops_short_or_misorders_its_end_does_not_hear_its_ending(script, heard):
    assert not asr.ending_heard(script, heard)


@pytest.mark.parametrize("n, k", [(10, 1), (15, 1), (20, 1), (30, 1), (30, 2), (40, 2), (45, 2)],
                         ids=["10w-1", "15w-1", "20w-1", "30w-1", "30w-2", "40w-2", "45w-2"])
def test_a_take_missing_its_last_words_fails_the_line_however_low_its_wer(tmp_path, n, k):
    line = plain(n)
    assert wer(line, drop_tail(line, k)) <= narration.MAX_LINE_WER, "the premise: WER alone would accept this take"
    pd = project(tmp_path, {"long": [line]})
    calls = []
    with pytest.raises(NarrationError, match=r"long/L0 \(ending: expected '"):
        narrate(pd, tts=fake_tts(calls), asr=Hearing(drop_tail(line, k)))
    assert len(calls) == 3 and not list((pd / "assets/audio/lines").glob("*"))  # never good, so every take was used; none kept


def test_the_error_names_what_the_ending_should_have_been_and_what_was_heard(tmp_path):
    pd = project(tmp_path, {"long": [LIVE_LINE]})
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts([]), asr=Hearing(drop_tail(LIVE_LINE, 1)))
    assert f"long/L0 (ending: expected '... to ASIC', heard '... according to'; best of 3 takes): {LIVE_LINE}" in str(err.value)


def test_the_error_reads_figures_then_ending_then_wer_and_says_when_nothing_was_heard(tmp_path):
    pd = project(tmp_path, {"long": [LIVE_LINE, "Yes."]})
    with pytest.raises(NarrationError) as err:
        narrate(pd, tts=fake_tts([]), asr=hearing_by_script({LIVE_LINE: "Short interest in DRO stands at 15.70", "Yes.": ""}))
    msg = str(err.value)
    assert "long/L0 (figures: expected 15.07, heard 15.7; ending: expected '... to ASIC', heard '... at 15.70'; WER 0.60 over the" in msg
    assert "long/L1 (ending: expected 'Yes', heard nothing; WER 1.00 over the" in msg


def test_the_year_that_ended_last_year_heard_as_ended_last_is_not_a_complete_take(tmp_path):
    line = YEAR_LINE
    assert wer(line, drop_tail(line, 1)) < 0.10  # one word in fourteen
    pd = project(tmp_path, {"long": [line]})
    with pytest.raises(NarrationError, match=r"ending: expected '... last year', heard '... ended last'"):
        narrate(pd, tts=fake_tts([]), asr=Hearing(drop_tail(line, 1)))


def test_a_take_that_is_not_heard_to_its_end_is_not_good_enough_to_stop_on(tmp_path):
    line = plain(40)
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=tone_tts(calls, seconds=(2.0, 3.0, 4.0)), asr=Hearing(drop_tail(line, 2), None))["long"]["L0"]
    assert wer(line, drop_tail(line, 2)) <= narration.GOOD_WER  # take 1 had the target WER and was missing its ending
    assert len(calls) == 2 and meta["takes"] == 2 and meta["wer"] == 0.0
    assert meta["duration"] == pytest.approx(3.08, abs=0.02)  # the second take


def test_a_truncated_take_with_a_lower_wer_does_not_outrank_a_complete_one(tmp_path):
    line = plain(30)
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=tone_tts(calls, seconds=(2.0, 3.0, 4.0)),
                   asr=Hearing(drop_tail(line, 1), garble(line, 2), garble(line, 2)))["long"]["L0"]  # WER .033 cut off; .067 whole
    assert len(calls) == 3 and meta["takes"] == 3 and meta["wer"] == round(2 / 30, 4)
    assert meta["duration"] == pytest.approx(3.08, abs=0.02)  # the second take, the first of the two complete ones


def test_two_words_of_the_recognisers_own_after_a_complete_take_do_not_fail_it(tmp_path):
    line = plain(30)
    pd = project(tmp_path, {"long": [line]})
    meta = narrate(pd, tts=fake_tts([]), asr=Hearing(line + " Thank you."))["long"]["L0"]
    assert meta["wer"] == round(2 / 30, 4)


# ---- a decimal percent the recogniser fuses ----------------------------------------------------------------

FUSED = [
    ("Weekly change was down 0.4 per cent, while the ASX slipped 0.9 per cent.",
     ["Weekly", "change", "was", "down", "0", ".4%,", "while", "the", "ASX", "slipped", "0", ".9%."],
     ["Weekly", "change", "was", "down", "0.4%,", "while", "the", "ASX", "slipped", "0.9%."]),
    ("Short interest peaked at 18.25 per cent.", ["Short", "interest", "peaked", "at", "18", ".25%."],
     ["Short", "interest", "peaked", "at", "18.25%."]),
    ("Short interest is now 15.07 per cent.", ["Short", "interest", "is", "now", "15", ".07%."],
     ["Short", "interest", "is", "now", "15.07%."]),
]


@pytest.mark.parametrize("script, raw, joined", FUSED, ids=["two-decimals", "18.25", "15.07"])
def test_a_decimal_percent_the_recogniser_fuses_is_rejoined_and_scores_zero(script, raw, joined):
    words = asr._join_numbers([{"w": w, "s": float(i), "e": i + 0.5} for i, w in enumerate(raw)])
    assert [w["w"] for w in words] == joined
    heard = " ".join(w["w"] for w in words)
    assert wer(script, heard) == 0.0 and figures(script) == figures(heard) and asr.ending_heard(script, heard)


@pytest.mark.parametrize("pieces, joined", [
    (["at", "15", ".07%."], ["at", "15.07%."]),
    (["down", "0", ".4%,", "while"], ["down", "0.4%,", "while"]),
    (["of", "12", ",5%;", "and"], ["of", "12,5%;", "and"]),
    (["up", "5.", ".5%"], ["up", "5.", ".5%"]),  # a full stop ends the first word, so the fragment is not its fraction
    (["a", ".5%"], ["a", ".5%"]),
    (["up", "5", "%"], ["up", "5", "%"]),  # a percent sign on its own is already its own word
    (["up", "5", ".5%%"], ["up", "5", ".5%%"]),
], ids=["fused-stop", "fused-comma", "fused-semicolon", "stop-first", "nothing-before", "bare-percent", "two-signs"])
def test_the_fused_percent_join_takes_one_percent_sign_and_only_after_a_digit(pieces, joined):
    words = [{"w": w, "s": float(i), "e": i + 0.5} for i, w in enumerate(pieces)]
    assert [w["w"] for w in asr._join_numbers(words)] == joined


class WhisperWords:
    """A stand-in for the model that returns the given strings as word-level segments, with faster-whisper's leading spaces."""

    def __init__(self, raw):
        self.raw, self.kwargs = raw, []

    def transcribe(self, audio, **kwargs):
        from types import SimpleNamespace
        self.kwargs.append(kwargs)
        words = [SimpleNamespace(word=" " + w, start=0.3 * i, end=0.3 * i + 0.25) for i, w in enumerate(self.raw)]
        return iter([SimpleNamespace(words=words)]), None


@pytest.mark.parametrize("script, raw, joined", FUSED, ids=["two-decimals", "18.25", "15.07"])
def test_transcribe_words_returns_a_fused_percent_as_one_timed_word(monkeypatch, tmp_path, script, raw, joined):
    monkeypatch.setattr(asr, "_model", lambda: WhisperWords(raw))
    sf.write(tmp_path / "x.wav", np.zeros(16000, np.float32), 16000)
    words = asr.transcribe_words(tmp_path / "x.wav", script)
    assert [w["w"] for w in words] == joined
    fused = words[-1]  # the last word is a joined one in each case: it spans both pieces
    assert fused["e"] == pytest.approx(0.3 * (len(raw) - 1) + 0.25) and fused["s"] == pytest.approx(0.3 * (len(raw) - 2))


@pytest.mark.parametrize("script, raw, joined", FUSED, ids=["two-decimals", "18.25", "15.07"])
def test_a_line_ending_in_a_fused_percent_passes_the_stage_with_wer_zero(monkeypatch, tmp_path, script, raw, joined):
    monkeypatch.setattr(asr, "_model", lambda: WhisperWords(raw))
    pd = project(tmp_path, {"long": [script]})
    meta = narrate(pd, tts=tone_tts([]))["long"]["L0"]  # the default recogniser: transcribe_words over the stand-in model
    assert meta["wer"] == 0.0 and meta["takes"] == 1


# ---- single quotes -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("script, heard", [
    ("The ‘big’ short is on.", "The big short is on."),
    ("The 'big' short is on.", "The big short is on."),
    ("He said ‘no’ twice.", "He said no twice."),
    ("He said 'no' twice.", "He said no twice."),
    ("It’s a ‘hold’, not a ‘sell’.", "It's a hold, not a sell."),
    ("Investors’ losses grew.", "Investors' losses grew."),
    ("The company’s shares rose.", "The company's shares rose."),
    ("The company's shares rose.", "The company’s shares rose."),
], ids=["curly-scare-quotes", "straight-scare-quotes", "curly-said-no", "straight-said-no", "mixed", "plural-possessive",
        "possessive", "possessive-reversed"])
def test_single_quotes_at_a_words_edge_are_not_part_of_it_and_possessives_stay_fixed(script, heard):
    assert wer(script, heard) == 0.0


def test_only_the_edges_lose_their_quotes():
    assert normalize("The ‘big’ short") == ["the", "big", "short"]
    assert normalize("don't, o’clock, the company’s, rock'n'roll") == ["don't", "o'clock", "the", "company's", "rock'n'roll"]
    assert normalize("investors’ and 'tis") == ["investors", "and", "tis"]
    assert normalize("' ’ x ''") == ["x"]  # a lone quote is no word
    assert normalize("E ' X M") == ["exm"]  # and it does not cut a run of spelled letters in two
    assert normalize("the letters ‘E’ ‘X’ ‘M’") == ["the", "letters", "exm"]  # spelled letters still join


# ---- a retake that comes back unreadable -------------------------------------------------------------------

def unreadable_second_take(calls):
    def tts(text, style, out):
        calls.append(text)
        if len(calls) == 2:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"this is not a wav file at all")
        else:
            fake_tts([])(text, style, out)
    return tts


def test_an_unreadable_retake_keeps_the_take_already_in_hand_when_it_is_good_enough(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    calls = []
    meta = narrate(pd, tts=unreadable_second_take(calls), asr=Hearing(garble(line, 2)))["long"]["L0"]  # WER 0.10: within the limit
    assert len(calls) == 2 and meta["takes"] == 1 and meta["wer"] == 0.1
    assert list((pd / "assets/audio/takes").glob("*-2.wav"))  # the unreadable reply is left on disk for a look


def test_an_unreadable_retake_fails_the_line_when_nothing_in_hand_is_good_enough(tmp_path):
    line = plain(20)
    pd = project(tmp_path, {"long": [line]})
    with pytest.raises(NarrationError, match=r"long/L0 \(.*-2\.wav is not readable audio"):
        narrate(pd, tts=unreadable_second_take([]), asr=Hearing(garble(line, 4)))  # WER 0.20 in take 1


# ---- a figure said twice must be heard twice ----------------------------------------------------------------

@pytest.mark.parametrize("script, heard", [
    ("12 and 12", "12"),
    ("It had 12 holders and 12 directors on the board last year.", "It had 12 holders and directors on the board last year."),
    ("It had 12 holders and directors on the board last year.", "It had 12 holders and 12 directors on the board last year."),
    ("Up 5 per cent, then up 5 per cent, then 5 again.", "Up 5 per cent, then up 5 per cent, then again."),
], ids=["bare", "one-heard-of-two", "one-extra", "three-of-three-to-two"])
def test_a_figure_is_counted_each_time_it_is_said_not_just_once(script, heard):
    verdict = narration.judge(script, says(heard))
    assert verdict["figures_ok"] is False
    assert not narration.passes({**verdict, "wer": 0.0})


def test_the_same_figure_said_twice_and_heard_twice_is_fine_and_the_error_lists_both_copies(tmp_path):
    line = "It had 12 holders and 12 directors on the board last year, " + plain(20)
    assert narration.judge(line, says(line))["figures_ok"]
    pd = project(tmp_path, {"long": [line]})
    with pytest.raises(NarrationError, match=r"figures: expected 12, 12, heard 12;"):
        narrate(pd, tts=fake_tts([]), asr=Hearing(line.replace("and 12 directors", "and directors")))


# ---- the hint is capped ----------------------------------------------------------------------------------

def test_the_hint_holds_twenty_acronyms_at_most_the_first_twenty_in_order():
    tickers = [f"AB{chr(65 + i)}" for i in range(25)]  # ABA .. ABY
    prompt = asr.vocabulary("Peers: " + ", ".join(tickers) + ".")
    assert prompt == ", ".join(tickers[:20]) + "." and tickers[20] not in prompt and len(prompt.split(", ")) == 20


# ---- the cache key is the voice text, not the script --------------------------------------------------------

def test_a_changed_ticker_set_takes_the_line_again_because_the_voice_text_changed(tmp_path):
    line = "DRO sits second behind EOS, and the margin is 4.1 per cent."
    pd = project(tmp_path, {"long": [line]})
    spoken = []

    def tts(text, style, out):
        spoken.append(text)
        fake_tts([])(text, style, out)

    narrate(pd, tts=tts, asr=Hearing())
    assert spoken == ["DRO sits second behind EOS, and the margin is 4.1 per cent."]  # EXM is the subject: DRO and EOS are not tickers yet
    (pd / "artifacts/dossier.json").write_text(json.dumps(
        {"ticker": "EXM", "peers": {"items": {"value": [{"code": "DRO"}, {"code": "EOS"}]}}}))
    narrate(pd, tts=tts, asr=Hearing())
    assert spoken[1] == "D R O sits second behind E O S, and the margin is 4.1 per cent." and len(spoken) == 2
    narrate(pd, tts=tts, asr=Hearing())
    assert len(spoken) == 2


def test_a_changed_respelling_takes_the_line_again_because_the_voice_text_changed(tmp_path, monkeypatch):
    line = "EBITDA rose 4.1 per cent on the year."
    pd = project(tmp_path, {"long": [line]})
    spoken = []

    def tts(text, style, out):
        spoken.append(text)
        fake_tts([])(text, style, out)

    narrate(pd, tts=tts, asr=Hearing())
    monkeypatch.setattr(narration, "PRONOUNCE", {**narration.PRONOUNCE, "EBITDA": "ee-bit-dah"})
    narrate(pd, tts=tts, asr=Hearing())
    assert spoken == [line, "ee-bit-dah rose 4.1 per cent on the year."]
    narrate(pd, tts=tts, asr=Hearing())
    assert len(spoken) == 2


# ---- the ending rule over real recogniser output ------------------------------------------------------------

# Real small.en transcripts from the round-2 re-review (a macOS en_AU voice stands in for Gemini; the recogniser is the real
# one). WHOLE_TAKES are lines read to the end: the ending rule must never fail one. CUT_OFF_TAKES are lines whose audio was cut
# off before the end, grouped by script: it must never pass one. Cut points that gave the same text appear once.
WHOLE_TAKES = [
    ("Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC.",
     "Short interest in DRO stands at 15.07 % of its shares, according to ASIC."),
    ("Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC.",
     "Short interest in DRO stands at 15.07 % of its shares according to ASIC."),
    ("The company reported steady profit growth across every region while costs stayed flat last "
     "year.",
     "The company reported steady profit growth across every region while costs stayed flat last "
     "year."),
    ("The company reported steady profit growth across every region while costs stayed flat and "
     "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
     "prices over the whole quarter.",
     "The company reported steady profit growth across every region while costs stayed flat and "
     "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
     "prices over the whole quarter."),
    ("The company reported steady profit growth across every region while costs stayed flat and "
     "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
     "prices over the whole quarter, and management said the order book looks healthy heading into"
     " the second half of the financial year.",
     "The company reported steady profit growth across every region while costs stayed flat and "
     "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
     "prices over the whole quarter, and management said the order book looks healthy heading into"
     " the second half of the financial year."),
    ("Revenue came in at 216.5 million dollars, up 73 per cent.",
     "Revenue came in at $216.5 million, up 73%."),
    ("Net profit was minus 30.8 million dollars.",
     "Net profit was minus $30.8 million."),
    ("Debt is 3.2 times earnings.",
     "Debt is 3.2 times earnings."),
    ("Days to cover sits at 1 day, which is quick.",
     "days to cover six at one day, which is quick."),
    ("Short interest has been climbing for 1 day.",
     "Short interest has been climbing for one day."),
    ("That ranks DRO second among its peers, behind EOS and ELS.",
     "That ranks DRO second among its peers, behind EOS and ELS."),
    ("The next catalyst is the full-year result on 25 February 2027.",
     "The next catalyst is the full year result on the 25th of February, 2027."),
    ("Directors bought 2 times and sold 7 times in the last 12 months.",
     "Directors bought two times and sold seven times in the last 12 months."),
    ("ASIC data shows 3 funds hold short positions above 1 per cent.",
     "ASIC data shows 3 funds hold short positions above 1%."),
    ("Weekly change was down 0.4 per cent, while the ASX slipped 0.9 per cent.",
     "Weekly change was down 0 .4%, while the ASX slipped 0 .9%."),
    ("Price to earnings sits at 18.4.",
     "price to earnings sits at 18.4."),
    ("Its closest peer by market value is A2M.",
     "Its closest peer -by -market value is A2M."),
    ("The gap to BHP and RIO has widened.",
     "The gap to BHP and RIO has widened."),
    ("Guidance is for growth in FY26.",
     "Guidances for growth in FY26."),
    ("Revenue grew 12 per cent year-on-year.",
     "Revenue grew 12 % year on year."),
    ("The dividend is 14 cents a share, fully franked.",
     "The dividend is $0.14 a share, fully franked."),
    ("Short interest peaked at 18.25 per cent.",
     "Short interest peaked at 18 .25%."),
    ("It is one of the most shorted stocks on the ASX.",
     "It is one of the most shorted stocks on the ASX."),
    ("The metric to watch is NPAT.",
     "The metric to watch is NPAT."),
    ("Short sellers hold 4.5 million shares, worth about 38 million dollars.",
     "Short sellers hold 4.5 million shares, worth about $38 million."),
    ("The company has raised capital twice in 3 years.",
     "The company has raised capital twice in three years."),
    ("That is up 2.5 per cent on the month.",
     "that is up 2.5 % on the month."),
    ("The shares fell to 2.31 dollars.",
     "the shares fell to $2.31."),
    ("Over the same period the sector rose 6 per cent.",
     "Over the same period the sector rose 6%."),
    ("Three of the five brokers rate it a hold.",
     "Three of the five brokers raided a hold."),
    ("Only 3PL and 88E are shorted more heavily.",
     "Only 3PL and 88E are shorted more heavily."),
    ("Net debt is 0.4 times earnings, down from 1.2 times.",
     "Net debt is 0.4 times earnings, down from 1.2 times."),
    ("Short interest is now 15.07 per cent.",
     "Short interest is now 15 .07%."),
    ("Sales were flat, and costs fell 10 per cent.",
     "Sales were flat, and costs fell 10%."),
    ("Revenue rose 12 per cent compared with the same period last year.",
     "Revenue rose 12 % compared with the same period last year."),
    ("Short interest has now risen for the third week in a row.",
     "Short interest has now risen for the third week in a row."),
    ("That is the highest level since records began.",
     "That is the highest level since records began."),
    ("The board expects to pay the same dividend as in the year ended last year.",
     "The board expects to pay the same dividend as in the year ended last year."),
]

CUT_OFF_TAKES = {
    "Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC.": [
        "Short interest.",
        "Short interest in DRO.",
        "Short interest in DRO stands...",
        "Short interest in DRO stands at...",
        "Short interest in DRO stands at 15...",
        "Short interest in DRO stands at 15.0...",
        "Short interest in DRO stands at 15 .07%.",
        "Short interest in DRO stands at 15.07 % of its...",
        "Short interest in DRO stands at 15.07 % of its shares.",
        "A short interest in DRO stands at 15.07 % of its shares according to...",
        "A short interest in DRO stands at 15.07 % of its shares, according to...",
    ],
    "The company reported steady profit growth across every region while costs stayed flat last "
    "year.": [
        "The company reported steady profit growth across every region while costs stayed flat.",
        "The company reported steady profit growth across every region while Kost state",
    ],
    "The company reported steady profit growth across every region while costs stayed flat and "
    "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
    "prices over the whole quarter.": [
        "The company reported steady profit growth across every region while costs stayed flat and "
        "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
        "prices over the whole",
        "The company reported steady profit growth across every region while costs stayed flat and "
        "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
        "prices over the past year.",
    ],
    "The company reported steady profit growth across every region while costs stayed flat and "
    "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
    "prices over the whole quarter, and management said the order book looks healthy heading into"
    " the second half of the financial year.": [
        "The company reported steady profit growth across every region while costs stayed flat and "
        "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
        "prices over the whole quarter. And management said the order book looks healthy heading into"
        " the second half of the financial",
        "The company reported steady profit growth across every region while costs stayed flat and "
        "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
        "prices over the whole quarter. And management said the order book looks healthy heading into"
        " the second half of the",
        "The company reported steady profit growth across every region while costs stayed flat and "
        "cash balances rose through autumn trading despite weaker demand abroad and softer commodity "
        "prices over the whole quarter, and management said the order book looks healthy heading into"
        " the second half of the year.",
    ],
    "Its closest peer by market value is A2M.": [
        "Its closest peer -by -market value is...",
        "It's closest peer -by -market value.",
    ],
    "The gap to BHP and RIO has widened.": [
        "The gap to BHP and -",
        "The gap to BHP.",
    ],
    "That ranks DRO second among its peers, behind EOS and ELS.": [
        "That ranks DRO second among its peers, behind EOS.",
    ],
    "Only 3PL and 88E are shorted more heavily.": [
        "Only 3PL and 88E.",
        "Only 3PL.",
    ],
    "The metric to watch is NPAT.": [
        "The metric to watch is...",
        "The metric to watch.",
    ],
    "It is one of the most shorted stocks on the ASX.": [
        "It is one of the most shorted stocks on the -",
        "It is one of the most shorted stocks on -",
    ],
    "Guidance is for growth in FY26.": [
        "Guidances for growth in -",
        "Guidances for growth.",
    ],
    "Revenue rose 12 per cent compared with the same period last year.": [
        "revenue rose 12 % compared with the same period.",
    ],
    "Short interest has now risen for the third week in a row.": [
        "Short interest has now risen for the third week.",
    ],
    "That is the highest level since records began.": [
        "That is the highest level since",
        "That is the highest level c -",
    ],
    "The board expects to pay the same dividend as in the year ended last year.": [
        "The board expects to pay the same dividend as in the year end.",
    ],
}


def test_the_ending_rule_over_real_recogniser_output_has_no_false_fail_and_no_miss():
    false_fails = [(s, h) for s, h in WHOLE_TAKES if not asr.ending_heard(s, h)]
    misses = [(s, h) for s, heard in CUT_OFF_TAKES.items() for h in heard if asr.ending_heard(s, h)]
    assert false_fails == [] and misses == []
    assert len(WHOLE_TAKES) == 38 and sum(len(heard) for heard in CUT_OFF_TAKES.values()) == 36  # nothing was dropped from the data


def test_the_stage_rule_accepts_no_cut_off_take_in_the_corpus_where_the_old_rule_accepted_seven():
    accepted = [h for s, heard in CUT_OFF_TAKES.items() for h in heard if narration.passes(narration.judge(s, says(h)))]
    assert accepted == []


# ---- the cut copies: the take whose ending is missing must not pass -----------------------------------------

# A real Gemini take of REAL_LINE is not committed: point SHORTED_VOICE_CHECK_WAV at one. With it unset these tests skip,
# and so they do when the small.en model is not in the local Hugging Face cache.
REAL_TAKE = Path(os.environ["SHORTED_VOICE_CHECK_WAV"]) if os.environ.get("SHORTED_VOICE_CHECK_WAV") else None
REAL_LINE = LIVE_LINE


@pytest.fixture(scope="module")
def local_recogniser():
    """The real small.en model, offline: skip unless the take and the cached model are both here."""
    if REAL_TAKE is None:
        pytest.skip("SHORTED_VOICE_CHECK_WAV is not set (point it at a real take of the DRO line)")
    if not REAL_TAKE.exists():
        pytest.skip(f"no real take at {REAL_TAKE} (SHORTED_VOICE_CHECK_WAV)")
    try:
        from huggingface_hub import try_to_load_from_cache
        cached = try_to_load_from_cache("Systran/faster-whisper-small.en", "model.bin")
    except Exception:
        cached = None
    if not isinstance(cached, str):
        pytest.skip("the faster-whisper small.en model is not in the local cache")
    with pytest.MonkeyPatch.context() as mp:  # never reach for the hub: use the cache, then put the setting back
        mp.setenv("HF_HUB_OFFLINE", "1")
        try:
            import huggingface_hub.constants as hub_constants
            mp.setattr(hub_constants, "HF_HUB_OFFLINE", True)
        except (ImportError, AttributeError):
            pass
        yield asr.transcribe_words


def _cut(tmp_path, name, keep):
    y, sr = sf.read(REAL_TAKE, dtype="float32")
    path = tmp_path / f"{name}.wav"
    sf.write(path, np.concatenate([y[int(a * sr):int(b * sr)] for a, b in keep]), sr, subtype="PCM_16")
    return path


@pytest.mark.slow
def test_the_full_real_take_passes_with_wer_zero_and_is_heard_to_its_end(local_recogniser, tmp_path):
    verdict = narration.judge(REAL_LINE, local_recogniser(REAL_TAKE, REAL_LINE))
    assert verdict["wer"] == 0.0 and verdict["figures_ok"] and verdict["tail_ok"] and narration.good(verdict)


@pytest.mark.slow
@pytest.mark.parametrize("name, keep, ending", [
    ("ends-at-3.2s-before-the-figure", [(0, 3.2)], False),
    ("ends-at-5.2s-right-after-the-figure", [(0, 5.2)], False),
    ("ends-at-7.0s-before-to-ASIC", [(0, 7.0)], False),
    ("figure-removed", [(0, 3.1), (5.2, 99)], True),  # the figure is gone but the line still ends on "to ASIC"
], ids=["3.2s", "5.2s", "7.0s", "figure-removed"])
def test_a_real_take_with_its_ending_or_its_figure_missing_no_longer_passes(local_recogniser, tmp_path, name, keep, ending):
    verdict = narration.judge(REAL_LINE, local_recogniser(_cut(tmp_path, name, keep), REAL_LINE))
    assert not narration.passes(verdict), verdict  # by WER over 0.10, a figure missing or wrong, or an ending not heard
    assert verdict["wer"] > narration.MAX_LINE_WER or not verdict["figures_ok"] or not verdict["tail_ok"]
    assert verdict["tail_ok"] is ending


@pytest.mark.slow
def test_the_stage_fails_a_cut_take_in_three_takes_and_passes_the_full_one_in_one(local_recogniser, tmp_path):
    def project_for(name):
        pd = tmp_path / name / "DRO-2026-10-08"
        (pd / "artifacts").mkdir(parents=True)
        (pd / "artifacts/dossier.json").write_text(json.dumps({"ticker": "DRO", "peers": {}}))
        (pd / "artifacts/gates.json").write_text(json.dumps({"long": {"errors": [], "lines": [
            {"id": "L0", "scene": "s", "chapter": "c", "spoken": REAL_LINE, "display": REAL_LINE, "style": "warm"}]}}))
        return pd

    def tts_for(path):
        def tts(text, style, out):
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(path.read_bytes())
        return tts

    cut = _cut(tmp_path, "cut", [(0, 7.0)])
    with pytest.raises(NarrationError, match=r"long/L0 \(.*ending: expected '... to ASIC', heard '.*best of 3 takes\)") as err:
        narrate(project_for("cut"), tts=tts_for(cut))
    assert "figures:" not in str(err.value)  # the figure was said; what is missing is the end
    meta = narrate(project_for("full"), tts=tts_for(REAL_TAKE))["long"]["L0"]
    assert meta["takes"] == 1 and meta["wer"] == 0.0 and abs(meta["lufs"] - (-18.0)) <= 1.0
    assert [w["w"] for w in meta["words"]] == REAL_LINE.split() and meta["words"][6]["w"] == "15.07"
```

`tests/shorted/test_voice.py`:

```python
import base64
import http.client
import io
import json
import urllib.error
import wave

import pytest

from tools.shorted import voice

KEY = "SENTINEL-KEY-must-never-leak-7f3a9c"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)


def pcm(frames=2400, channels=1):
    return b"\x01\x02" * frames * channels


def wav(rate=24000, channels=1, frames=2400):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm(frames, channels))
    return out.getvalue()


def opened(data):
    """(rate, channels, sample width, frames) of WAV bytes, read with the stdlib's wave module."""
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()


def audio_reply(data, **fields):
    block = {"type": "audio", "data": base64.b64encode(data).decode(), **fields}
    return 200, {}, json.dumps({"steps": [{"type": "model_output", "content": [block]}]}).encode()


class Transport:
    """Plays a script of replies back, one per request, and records what was sent."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.sent = []

    def __call__(self, url, headers, data):
        self.sent.append((url, dict(headers), json.loads(data)))
        return self.replies.pop(0)  # an unexpected extra request runs out of replies and fails the test


def test_request_names_the_endpoint_model_voice_and_style():
    t = Transport(audio_reply(wav()))
    voice.synthesize("Short interest in D R O is 15.07 per cent.", "en-au-tutor-5", "warm, curious",
                     "gemini-3.8-flash-tts", transport=t)
    url, headers, body = t.sent[0]
    assert url == ENDPOINT
    assert body == {
        "model": "gemini-3.8-flash-tts",
        "input": [{"type": "user_input", "content": [{
            "type": "text", "text": "Short interest in D R O is 15.07 per cent.",
            "annotations": [{"type": "speech_metadata", "style": "warm, curious"}]}]}],
        "generation_config": {"speech_config": [{"voice": "en-au-tutor-5"}]},
    }
    assert headers["Content-Type"] == "application/json"


def test_the_model_defaults_to_flash_tts_and_no_style_sends_no_annotation():
    t = Transport(audio_reply(wav()))
    voice.synthesize("Hello.", "en-au-tutor-5", transport=t)
    body = t.sent[0][2]
    assert body["model"] == voice.MODEL == "gemini-3.8-flash-tts"
    assert body["input"][0]["content"] == [{"type": "text", "text": "Hello."}]


@pytest.mark.parametrize("failure", [(503, {}, b'{"error": {"message": "overloaded"}}'), (500, {}, b"internal error"),
                                     (429, {}, b'{"error": {"message": "slow down"}}'), (599, {}, b"timed out")],
                         ids=["503", "500", "429", "network-error"])
def test_a_transient_failure_is_retried_after_a_backoff_and_the_wav_returned(failure):
    t, slept = Transport(failure, audio_reply(wav())), []
    out = voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert len(t.sent) == 2 and slept == [voice.BACKOFF]
    assert opened(out) == (24000, 1, 2, 2400)


@pytest.mark.parametrize("retries, slept_for", [(4, [4, 8, 12]), (2, [4]), (1, [])])
def test_the_retry_budget_is_the_most_requests_sent_and_the_backoff_grows(retries, slept_for):
    t, slept = Transport(*[(503, {}, b"busy")] * retries), []
    with pytest.raises(voice.VoiceError) as err:
        voice.synthesize("Hello.", "v", retries=retries, transport=t, sleep=slept.append)
    assert err.value.status == 503 and "HTTP 503" in str(err.value) and "busy" in str(err.value)
    assert len(t.sent) == retries and slept == slept_for


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_client_error_raises_at_once_without_a_retry(status):
    t, slept = Transport((status, {}, b'{"error": {"message": "voice not found"}}')), []
    with pytest.raises(voice.VoiceError, match=f"HTTP {status}.*voice not found") as err:
        voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert err.value.status == status and len(t.sent) == 1 and slept == []


def test_a_wav_reply_is_returned_untouched_and_opens_with_wave():
    data = wav(rate=24000, channels=1, frames=4800)
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(data)))
    assert out == data and opened(out) == (24000, 1, 2, 4800)


@pytest.mark.parametrize("fields, rate, channels", [
    ({"sample_rate": 22050}, 22050, 1),
    ({"mime_type": "audio/L16;codec=pcm;rate=16000"}, 16000, 1),
    ({"mime_type": "audio/L16;codec=pcm;rate=16000", "sample_rate": 44100, "channels": 2}, 44100, 2),
    ({}, 24000, 1),
], ids=["stated-rate", "rate-in-the-mime-type", "the-field-beats-the-mime-type", "none-stated-means-the-films-24-kHz"])
def test_raw_pcm_is_wrapped_as_wav_with_the_stated_rate(fields, rate, channels):
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(pcm(1000, channels), **fields)))
    assert opened(out) == (rate, channels, 2, 1000)
    with wave.open(io.BytesIO(out)) as w:
        assert w.readframes(1000) == pcm(1000, channels)  # the samples are carried over unchanged


def test_a_cut_off_final_sample_is_dropped_so_the_wav_stays_valid():
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(pcm(1000) + b"\x07")))
    assert opened(out) == (24000, 1, 2, 1000)
    assert int.from_bytes(out[40:44], "little") == 2000  # the data chunk holds whole frames only, no stray byte


def test_compressed_audio_is_refused_rather_than_written_as_wav():
    reply = audio_reply(b"ID3\x03\x00 this is not a wav", mime_type="audio/mpeg")
    with pytest.raises(voice.VoiceError, match="audio/mpeg"):
        voice.synthesize("Hello.", "v", transport=Transport(reply))


def test_the_last_audio_block_is_the_one_used():
    first, last = wav(frames=100), wav(frames=200)
    blocks = [{"type": "audio", "data": base64.b64encode(d).decode()} for d in (first, last)]
    body = json.dumps({"steps": [{"type": "thought"}, {"type": "model_output", "content": blocks}]}).encode()
    out = voice.synthesize("Hello.", "v", transport=Transport((200, {}, body)))
    assert out == last


BAD_REPLIES = [
    b'{"steps": []}',
    b'{"steps": [{"type": "model_output", "content": [{"type": "text", "text": "no audio here"}]}]}',
    b"this is not json",
    b"[1, 2, 3]",
]


@pytest.mark.parametrize("raw", BAD_REPLIES, ids=["no-steps", "text-only", "not-json", "not-an-object"])
def test_a_200_without_usable_audio_is_asked_for_again_within_the_budget(raw):
    t, slept = Transport((200, {}, raw), audio_reply(wav())), []
    out = voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert opened(out) == (24000, 1, 2, 2400) and len(t.sent) == 2 and slept == [voice.BACKOFF]


@pytest.mark.parametrize("raw", BAD_REPLIES, ids=["no-steps", "text-only", "not-json", "not-an-object"])
def test_a_200_that_stays_unusable_raises_when_the_budget_is_spent(raw):
    t, slept = Transport(*[(200, {}, raw)] * 4), []
    with pytest.raises(voice.VoiceError, match="attempt 4 of 4") as err:
        voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert err.value.status == 200 and len(t.sent) == 4 and slept == [4, 8, 12]


@pytest.mark.parametrize("value", [None, "", "   "], ids=["unset", "empty", "blank"])
def test_a_missing_key_makes_no_request(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("GEMINI_API_KEY")
    else:
        monkeypatch.setenv("GEMINI_API_KEY", value)
    t = Transport()
    with pytest.raises(voice.VoiceError, match="GEMINI_API_KEY is not set"):
        voice.synthesize("Hello.", "v", transport=t)
    assert t.sent == []


def test_the_key_goes_in_a_header_and_nowhere_else():
    t = Transport(audio_reply(wav()))
    voice.synthesize("Hello.", "v", "calm", transport=t)
    url, headers, body = t.sent[0]
    assert headers["x-goog-api-key"] == KEY
    assert KEY not in url and KEY not in json.dumps(body)
    assert [name for name, value in headers.items() if KEY in value] == ["x-goog-api-key"]


ECHO = f'{{"error": {{"message": "API key {KEY} is not valid"}}}}'.encode()


@pytest.mark.parametrize("replies", [
    [(400, {}, ECHO)],
    [(401, {}, ECHO)],
    [(503, {}, ECHO)] * 4,
    [(599, {}, KEY.encode())] * 4,
    [(200, {}, ECHO)] * 4,
    [(200, {}, KEY.encode())] * 4,
], ids=["400", "401", "503-then-gave-up", "network-then-gave-up", "no-audio", "not-json"])
def test_the_key_never_reaches_an_exception_or_a_log_even_when_the_server_echoes_it(replies, capsys, caplog):
    with pytest.raises(voice.VoiceError) as err:
        voice.synthesize("Hello.", "v", transport=Transport(*replies), sleep=lambda seconds: None)
    assert KEY not in str(err.value) and KEY not in repr(err.value) and KEY not in repr(err.value.args)
    assert err.value.__cause__ is None and err.value.__context__ is None  # nothing chained that could print it
    shown = capsys.readouterr()
    assert KEY not in shown.out + shown.err + caplog.text


class Reply:
    """What opener.open() returns: a context manager with status, headers and read()."""

    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.body


def test_the_real_transport_posts_json_with_the_key_in_a_header_and_a_timeout(monkeypatch):
    seen = {}

    class Opener:
        def open(self, req, timeout=None):
            seen.update(url=req.full_url, method=req.get_method(), data=req.data, timeout=timeout,
                        headers={name.lower(): value for name, value in req.header_items()})
            return Reply(200, {"Content-Type": "application/json"}, b'{"ok": true}')

    monkeypatch.setattr(voice, "_OPENER", Opener())
    headers = {"Content-Type": "application/json", "x-goog-api-key": KEY}
    status, reply_headers, body = voice._urllib_transport(ENDPOINT, headers, b'{"a": 1}')
    assert (status, body) == (200, b'{"ok": true}') and reply_headers["Content-Type"] == "application/json"
    assert seen["url"] == ENDPOINT and KEY not in seen["url"]
    assert seen["method"] == "POST" and seen["data"] == b'{"a": 1}' and seen["timeout"] == voice.TIMEOUT
    assert seen["headers"]["x-goog-api-key"] == KEY


def test_the_real_transport_uses_the_timeout_it_is_given(monkeypatch):
    seen = []

    class Opener:
        def open(self, req, timeout=None):
            seen.append(timeout)
            return Reply(200, {}, b"{}")

    monkeypatch.setattr(voice, "_OPENER", Opener())
    voice._urllib_transport(ENDPOINT, {}, b"{}", timeout=12.5)
    voice._urllib_transport(ENDPOINT, {}, b"{}")
    assert seen == [12.5, voice.TIMEOUT]


@pytest.mark.parametrize("failure, status", [
    (urllib.error.HTTPError(ENDPOINT, 503, "Service Unavailable", {"Retry-After": "2"}, io.BytesIO(b"busy")), 503),
    (urllib.error.URLError("connection refused"), voice.NETWORK_ERROR),
    (TimeoutError("timed out"), voice.NETWORK_ERROR),
    (ConnectionResetError("reset by peer"), voice.NETWORK_ERROR),
    (http.client.IncompleteRead(b"RIFF"), voice.NETWORK_ERROR),
], ids=["http-error", "url-error", "timeout", "reset", "truncated-body"])
def test_the_real_transport_reports_a_failure_as_a_status_so_it_can_be_retried(monkeypatch, failure, status):
    class Opener:
        def open(self, req, timeout=None):
            raise failure

    monkeypatch.setattr(voice, "_OPENER", Opener())
    got, headers, body = voice._urllib_transport(ENDPOINT, {}, b"{}")
    assert got == status and body
    assert (headers == {}) == (status == voice.NETWORK_ERROR)  # a network failure has no reply headers to honour


class Socket:
    """Just enough of a socket for http.client.HTTPResponse to parse canned bytes from."""

    def __init__(self, raw):
        self.raw = raw

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.raw)


def test_a_redirect_is_never_followed_so_the_key_cannot_be_replayed_elsewhere(monkeypatch):
    """The module's own opener and urllib's real handler chain, over an in-memory stand-in for the HTTPS
    connection (no socket): a 302 to another host must end the request, with the key sent to one host only."""
    connections = []

    class Connection:
        def __init__(self, host, **kwargs):
            self.host, self.sock, self.headers = host, None, {}
            connections.append(self)

        def set_debuglevel(self, level):
            pass

        def request(self, method, selector, body=None, headers=None, **kwargs):
            self.headers = {name.lower(): value for name, value in (headers or {}).items()}

        def getresponse(self):
            response = http.client.HTTPResponse(Socket(
                b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere.invalid/collect\r\nContent-Length: 5\r\n\r\nmoved"))
            response.begin()
            return response

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    status, _, body = voice._urllib_transport(ENDPOINT, {"x-goog-api-key": KEY}, b"{}")
    assert (status, body) == (302, b"moved")
    assert [c.host for c in connections] == ["generativelanguage.googleapis.com"]
    assert connections[0].headers["x-goog-api-key"] == KEY
    with pytest.raises(voice.VoiceError, match="HTTP 302") as err:  # through synthesize: a 3xx fails, it is not retried
        voice.synthesize("Hello.", "v")
    assert [c.host for c in connections] == ["generativelanguage.googleapis.com"] * 2 and KEY not in str(err.value)


# ---- the key must be something a header can carry ----------------------------------------------------------

@pytest.mark.parametrize("key", ["SENTINEL-K-one\nSENTINEL-K-two", "SENTINEL-K has a space", "SENTINEL-K\ttab",
                                 "SENTINEL-K’s", "SENTINEL-K-café", "SENTINEL-K\x7f", "SENTINEL-K\rcr"],
                         ids=["newline", "space", "tab", "curly-apostrophe", "non-ascii", "delete", "carriage-return"])
def test_a_key_that_cannot_be_a_header_value_is_refused_before_anything_is_sent_and_never_quoted(monkeypatch, key):
    monkeypatch.setenv("GEMINI_API_KEY", key)
    t = Transport()
    with pytest.raises(voice.VoiceError) as err:
        voice.synthesize("Hello.", "v", transport=t)
    shown = str(err.value) + repr(err.value) + repr(err.value.args)
    assert "SENTINEL-K" not in shown and "GEMINI_API_KEY" in str(err.value)
    assert t.sent == []


def test_a_malformed_key_is_refused_by_the_real_transport_path_too(monkeypatch):
    """No transport given: the refusal still comes before http.client, whose ValueError would quote the whole key."""
    monkeypatch.setenv("GEMINI_API_KEY", "SENTINEL-K-one\nSENTINEL-K-two")

    class Opener:
        def open(self, req, timeout=None):
            raise AssertionError("a request was built for a malformed key")

    monkeypatch.setattr(voice, "_OPENER", Opener())
    with pytest.raises(voice.VoiceError) as err:
        voice.synthesize("Hello.", "v")
    assert "SENTINEL-K" not in str(err.value)


@pytest.mark.parametrize("key", ["GOOD-KEY\n", "GOOD-KEY\r\n", "  GOOD-KEY  "], ids=["lf", "crlf", "spaces"])
def test_whitespace_around_a_key_is_trimmed_not_refused(monkeypatch, key):
    monkeypatch.setenv("GEMINI_API_KEY", key)
    t = Transport(audio_reply(wav()))
    voice.synthesize("Hello.", "v", transport=t)
    assert t.sent[0][1]["x-goog-api-key"] == "GOOD-KEY"


# ---- Retry-After ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("status", [429, 503])
@pytest.mark.parametrize("header, waited", [
    ({"Retry-After": "30"}, 30.0),
    ({"retry-after": "2"}, 2.0),
    ({"RETRY-AFTER": "1.5"}, 1.5),
    ({"Retry-After": "3600"}, 60.0),
    ({"Retry-After": "0"}, 0.0),
    ({"Retry-After": "-5"}, 0.0),
    ({"Retry-After": "soon"}, voice.BACKOFF),
    ({"Retry-After": "nan"}, voice.BACKOFF),
    ({"Retry-After": "inf"}, voice.BACKOFF),
    ({}, voice.BACKOFF),
], ids=["30s", "lowercase-name", "uppercase-name", "capped-at-a-minute", "zero", "negative", "words", "nan", "inf", "none"])
def test_retry_after_is_honoured_up_to_a_minute_else_the_backoff_applies(status, header, waited):
    t, slept = Transport((status, header, b"slow down"), audio_reply(wav())), []
    voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert slept == [waited]


def test_retry_after_shapes_every_wait_not_just_the_first():
    t, slept = Transport(*[(429, {"Retry-After": str(10 * n)}, b"x") for n in (1, 2, 3)], audio_reply(wav())), []
    voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert slept == [10.0, 20.0, 30.0]


def test_a_network_error_waits_the_backoff():
    t, slept = Transport((voice.NETWORK_ERROR, {}, b"timed out"), audio_reply(wav())), []
    voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert slept == [voice.BACKOFF]


# ---- a WAV is only accepted whole --------------------------------------------------------------------------

def riff(*chunks):
    body = b"WAVE" + b"".join(cid + len(data).to_bytes(4, "little") + data + (b"\0" if len(data) % 2 else b"")
                              for cid, data in chunks)
    return b"RIFF" + len(body).to_bytes(4, "little") + body


FMT = (b"fmt ", (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + (24000).to_bytes(4, "little")
       + (48000).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little"))


def test_a_wav_whose_data_chunk_claims_more_than_arrived_is_asked_for_again():
    good = wav(frames=2400)
    clipped = good[:-2000]  # the header still claims all of it
    t, slept = Transport(audio_reply(clipped), audio_reply(good)), []
    out = voice.synthesize("Hello.", "v", transport=t, sleep=slept.append)
    assert out == good and len(t.sent) == 2 and slept == [voice.BACKOFF]


def test_a_wav_that_stays_clipped_raises_naming_what_was_claimed_and_what_came():
    clipped = wav(frames=2400)[:-2000]
    with pytest.raises(voice.VoiceError, match=r"damaged.*claims 4800 bytes and 2800 arrived.*attempt 2 of 2") as err:
        voice.synthesize("Hello.", "v", retries=2, transport=Transport(*[audio_reply(clipped)] * 2), sleep=lambda s: None)
    assert err.value.status == 200


@pytest.mark.parametrize("data, why", [
    (riff(FMT), "no data chunk"),
    (riff((b"data", b"\x01\x02" * 100), FMT), "before any fmt"),
    (riff(FMT, (b"data", b"\x01\x02" * 100))[:30], "no data chunk"),
], ids=["no-data", "data-before-fmt", "cut-inside-the-fmt-chunk"])
def test_a_wav_without_a_usable_fmt_and_data_pair_is_damaged(data, why):
    with pytest.raises(voice.VoiceError, match=why):
        voice.synthesize("Hello.", "v", retries=1, transport=Transport(audio_reply(data)))


def test_chunks_after_the_data_are_fine_as_in_googles_c2pa_provenance_chunk():
    good = wav(frames=2400) + b"C2PA" + (6062).to_bytes(4, "little") + b"\x00" * 6062
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(good)))
    assert out == good and opened(out) == (24000, 1, 2, 2400)


def test_an_odd_length_chunk_before_the_data_is_skipped_together_with_its_pad_byte():
    data = riff(FMT, (b"LIST", b"abc"), (b"data", b"\x01\x02" * 100))  # three bytes of chunk and one of padding
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(data)))
    assert out == data


def test_an_odd_length_data_chunk_at_the_very_end_needs_no_pad_byte():
    data = riff(FMT, (b"data", b"\x01\x02" * 50 + b"\x03"))[:-1]  # the final pad byte is missing
    out = voice.synthesize("Hello.", "v", transport=Transport(audio_reply(data)))
    assert out == data


# ---- smaller replies: aliases, bad numbers, bad base64 -----------------------------------------------------

def test_the_camel_case_aliases_for_rate_and_mime_type_are_read():
    assert opened(voice.synthesize("Hi.", "v", transport=Transport(audio_reply(pcm(1000), sampleRate=16000)))) \
        == (16000, 1, 2, 1000)
    assert opened(voice.synthesize("Hi.", "v", transport=Transport(
        audio_reply(pcm(1000), mimeType="audio/L16;codec=pcm;rate=22050")))) == (22050, 1, 2, 1000)
    with pytest.raises(voice.VoiceError, match="audio/mpeg"):
        voice.synthesize("Hi.", "v", transport=Transport(audio_reply(b"ID3junk", mimeType="audio/mpeg")))


@pytest.mark.parametrize("fields, what", [({"sample_rate": "fast"}, "sample rate"), ({"sample_rate": -1}, "sample rate"),
                                          ({"channels": "two"}, "channel count"), ({"channels": -2}, "channel count")],
                         ids=["rate-words", "rate-negative", "channels-words", "channels-negative"])
def test_a_rate_or_channel_count_that_is_no_number_raises_a_voice_error_at_once(fields, what):
    t = Transport(audio_reply(pcm(1000), **fields))
    with pytest.raises(voice.VoiceError, match=f"{what} is not a positive number"):
        voice.synthesize("Hi.", "v", transport=t)
    assert len(t.sent) == 1


def test_audio_that_is_not_valid_base64_is_a_flaky_reply_and_asked_for_again():
    body = json.dumps({"steps": [{"type": "model_output", "content": [{"type": "audio", "data": "abc"}]}]}).encode()
    t = Transport((200, {}, body), audio_reply(wav()))
    assert opened(voice.synthesize("Hi.", "v", transport=t, sleep=lambda s: None)) == (24000, 1, 2, 2400)
    with pytest.raises(voice.VoiceError, match="not valid base64"):
        voice.synthesize("Hi.", "v", retries=1, transport=Transport((200, {}, body)))


# ---- one deadline for the whole take -----------------------------------------------------------------------

class Clock:
    """A clock that only moves when something sleeps or a request takes time."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def test_a_wait_that_would_cross_the_deadline_ends_the_take_instead():
    clock = Clock()
    t = Transport(*[(503, {"Retry-After": "60"}, b"busy")] * 4)
    with pytest.raises(voice.VoiceError, match=r"HTTP 503 on attempt 3 of 4; gave up at the 180 s deadline") as err:
        voice.synthesize("Hello.", "v", transport=t, sleep=clock.sleep, clock=clock)
    assert len(t.sent) == 3 and clock.t == 120.0 and err.value.status == 503  # 60 + 60 waited, the third wait would end at 180


def test_requests_that_take_time_use_up_the_deadline():
    clock, calls = Clock(), []

    def slow(url, headers, data):
        calls.append(clock.t)
        clock.t += 100  # every request takes 100 s and then fails
        return 503, {}, b"busy"

    with pytest.raises(voice.VoiceError, match="deadline"):
        voice.synthesize("Hello.", "v", transport=slow, sleep=clock.sleep, clock=clock)
    assert calls == [0.0, 104.0]  # a second request, then no third: 204 s are gone


def test_the_deadline_is_a_parameter_and_a_generous_one_changes_nothing():
    clock = Clock()
    t = Transport(*[(503, {}, b"busy")] * 4)
    with pytest.raises(voice.VoiceError, match=r"attempt 4 of 4: busy"):
        voice.synthesize("Hello.", "v", transport=t, sleep=clock.sleep, clock=clock, deadline=10_000)
    assert len(t.sent) == 4 and clock.t == 24.0


def test_the_real_transport_is_never_allowed_longer_than_what_is_left_of_the_deadline(monkeypatch):
    clock, timeouts = Clock(), []

    def real(url, headers, data, timeout):
        timeouts.append(timeout)
        clock.t += 100
        return 503, {}, b"busy"

    monkeypatch.setattr(voice, "_urllib_transport", real)
    with pytest.raises(voice.VoiceError):
        voice.synthesize("Hello.", "v", sleep=clock.sleep, clock=clock)
    assert timeouts == [180.0, 76.0]  # the second request had 180 - 100 - 4 s


def test_an_injected_transport_is_called_with_exactly_url_headers_and_data():
    seen = []

    def plain(url, headers, data):  # three arguments, as every fake in this suite takes
        seen.append(len((url, headers, data)))
        return audio_reply(wav())

    voice.synthesize("Hello.", "v", transport=plain)
    assert seen == [3]
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_narration.py tests/shorted/test_voice.py -q`
Expected: FAIL with `ModuleNotFoundError` (no `tools.shorted.asr`, no `tools.shorted.voice`).

- [ ] **Step 3: Implement `asr.py`**

```python
"""Speech recognition with faster-whisper (local), normalisation for scoring, word error rate, and
the alignment of script tokens to recognised words: captions show the script, timed by the voice.

The recogniser is told which acronyms and tickers the script uses, and nothing else. A prompt that holds the
script itself makes Whisper write what the script says whether or not the voice said it (a take cut off before
its figure scored WER 0.0), so what it hears is the audio's own."""

from __future__ import annotations

import difflib
import re
from functools import lru_cache
from pathlib import Path

MODEL = "small.en"
RATE = 16000  # the sampling rate faster-whisper expects
VOCABULARY_LIMIT = 20
ACRONYM = re.compile(r"\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,6}\b")  # DRO, ASIC, A2M, 3PL: never a figure like 15 or 2026
SCALES = {"thousand", "million", "billion", "trillion"}
# The recogniser writes one to nine as words ("seven director trades") and 10 upwards as digits, whatever the script says.
NUMBER_WORDS = {"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
                "eight": "8", "nine": "9", "ten": "10"}
# How formatters.py speaks a currency written with a symbol: A$ and a bare $ are dollars, the rest are named.
SPOKEN_CURRENCY = {"": "dollars", "a": "dollars", "us": "us dollars", "nz": "new zealand dollars",
                   "c": "canadian dollars", "£": "pounds", "€": "euros"}


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel

    return WhisperModel(MODEL, device="cpu", compute_type="int8")


def _samples(path: Path):
    """16 kHz mono float32 samples of a WAV. Decoded here, not by faster-whisper: its decoder calls
    av.open(metadata_errors=...), which PyAV 19 rejects with a TypeError, so no file path can be passed."""
    import math

    import numpy as np
    import soundfile as sf
    from scipy import signal

    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != RATE:
        g = math.gcd(int(sr), RATE)
        y = signal.resample_poly(y, RATE // g, int(sr) // g)
    return np.ascontiguousarray(y, dtype=np.float32)


def _join_numbers(words: list[dict]) -> list[dict]:
    """Whisper returns 15.07 as the words '15' and '.07', and 12,345 as '12' and ',345'; before a comma or a full
    stop the fragment arrives as '.07,' or '.8.', and at the end of a clause a percent fuses on as '.07%.' or '.4%,'.
    A number is one word, or WER counts a substitution and an insertion for every decimal and the number audit
    reads two numbers."""
    out: list[dict] = []
    for w in words:
        if out and re.fullmatch(r"[.,]\d+%?[.,;:!?]*", w["w"]) and out[-1]["w"][-1:].isdigit():
            out[-1] = {"w": out[-1]["w"] + w["w"], "s": out[-1]["s"], "e": w["e"]}
        else:
            out.append(w)
    return out


def vocabulary(text: str | None) -> str | None:
    """The only hint the recogniser gets for a script: its acronyms and tickers, "DRO, ASIC." Never a figure and
    never the words, in order or not, so a take that lacks them is heard to lack them."""
    found = list(dict.fromkeys(ACRONYM.findall(text or "")))[:VOCABULARY_LIMIT]
    return ", ".join(found) + "." if found else None


def transcribe_words(path: Path, prompt: str | None = None) -> list[dict]:
    """The words in the audio, timed. `prompt` is the text the audio should say; only its vocabulary reaches the model."""
    segments, _ = _model().transcribe(_samples(path), word_timestamps=True, language="en", beam_size=5,
                                      initial_prompt=vocabulary(prompt), vad_filter=False)
    return _join_numbers([{"w": w.word.strip(), "s": float(w.start), "e": float(w.end)}
                          for seg in segments for w in seg.words if w.word.strip()])


def _money(m: re.Match) -> str:
    symbol = "£" if m.group(2) else "€" if m.group(3) else m.group(1) or ""
    return f" {m.group(4)}{m.group(5) or ''} {SPOKEN_CURRENCY[symbol]} "


def normalize(text: str) -> list[str]:
    """Lowercase tokens: '$1.5 billion' -> 1.5 billion dollars (£ pounds, € euros, US$ US dollars, as spoken), '%' ->
    per cent, a minus sign -> minus, spelled letters joined, one to ten as digits, both apostrophes as ' and a quote
    mark at a word's edge dropped ('big' and big are one word, company's keeps its apostrophe)."""
    t = text.lower().replace("−", "-").replace("–", " ").replace("—", " ")
    t = re.sub(r"[\u2018\u2019\u02bc]", "'", t)
    t = re.sub(r"(?<![\w.])-(?=(?:us|a|nz|c)?[$£€]?\d)", " minus ", t)  # a sign, not the hyphen of 2020-21
    t = re.sub(r"(?:(us|a|nz|c)?\$|(£)|(€))\s?([\d.,]*\d)(\s?(?:thousand|million|billion|trillion))?", _money, t)
    t = t.replace("%", " per cent ").replace("percent", "per cent")
    t = re.sub(r"(\d),(?=\d{3}\b)", r"\1", t)  # 1,234,567 loses every separator, not every other one
    t = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", t)
    t = re.sub(r"[^a-z0-9.\s']", " ", t)
    t = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", t)  # keep only decimal points
    out: list[str] = []
    run: list[str] = []
    edges = [tok for tok in (x.strip("'") for x in t.split()) if tok]  # 'big' is big; company's and o'clock keep theirs
    for tok in edges + [""]:
        if len(tok) == 1 and tok.isalpha():
            run.append(tok)
            continue
        out.extend(["".join(run)] if len(run) >= 2 else run)
        run = []
        if tok:
            out.append(tok)
    return [NUMBER_WORDS.get(tok) or (tok.rstrip("0").rstrip(".") if re.fullmatch(r"\d+\.\d+", tok) else tok)
            for tok in out]  # 12.50 == 12.5


def wer(ref: str, hyp: str) -> float:
    r, h = normalize(ref), normalize(hyp)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rt in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, ht in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rt != ht))
        prev = cur
    return prev[-1] / len(r)


def numbers(text: str) -> list[str]:
    return [t for t in normalize(text) if re.fullmatch(r"\d+(?:\.\d+)?", t)]


def figures(text: str) -> list[tuple[str, str, str]]:
    """Every figure as (sign, digits, scale): sign is "-" after minus or negative, "up" or "down" after that word,
    else ""; scale is the thousand, million, billion or trillion that follows, else "". numbers() cannot see sign
    or scale, so "down 73 per cent" and "216.5 billion" passed as "up 73 per cent" and "216.5 million"."""
    tokens = normalize(text)
    out = []
    for i, tok in enumerate(tokens):
        if not re.fullmatch(r"\d+(?:\.\d+)?", tok):
            continue
        before = tokens[i - 1] if i else ""
        sign = "-" if before in ("minus", "negative") else before if before in ("up", "down") else ""
        after = tokens[i + 1] if i + 1 < len(tokens) else ""
        out.append((sign, tok, after if after in SCALES else ""))
    return out


def ending_heard(script: str, heard: str) -> bool:
    """Has the take been heard to its end? True when the script's last word is among the last 3 heard words and the
    one before it comes first, within the 4 heard words that end there. A take cut off before its ending can still
    score a low WER on a long line (two words of thirty is 0.067, and the recogniser sometimes finishes the sentence
    in its own words), so WER cannot say. Order matters: "ended last year" heard as "ended last" has both words in
    the last four. Two words of the recogniser's own after the ending are tolerated; three are not (WER fails those)."""
    wanted, got = normalize(script)[-2:], normalize(heard)[-4:]
    if not wanted:
        return True
    return any(got[j] == wanted[-1] and (len(wanted) == 1 or wanted[0] in got[:j])
               for j in range(max(0, len(got) - 3), len(got)))


def align(script: str, words: list[dict]) -> list[dict]:
    """Time each whitespace token of the script: matched tokens take the recognised timing, the rest
    are spread evenly between their matched neighbours."""
    tokens = script.split()
    sm = difflib.SequenceMatcher(a=[" ".join(normalize(t)) for t in tokens],
                                 b=[" ".join(normalize(w["w"])) for w in words], autojunk=False)
    times: list[tuple[float, float] | None] = [None] * len(tokens)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            times[blk.a + k] = (words[blk.b + k]["s"], words[blk.b + k]["e"])
    start, end = (words[0]["s"], words[-1]["e"]) if words else (0.0, 0.0)
    i = 0
    while i < len(tokens):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(tokens) and times[j] is None:
            j += 1
        lo = times[i - 1][1] if i > 0 else start
        hi = times[j][0] if j < len(tokens) else end
        span = max(0.0, hi - lo) / (j - i)
        for k in range(i, j):
            times[k] = (lo + span * (k - i), lo + span * (k - i + 1))
        i = j
    out: list[dict] = []
    for tok, (s, e) in zip(tokens, times):
        s = max(s, out[-1]["s"]) if out else s  # overlapping recognised words must not send a start backwards
        out.append({"w": tok, "s": round(s, 3), "e": round(max(e, s + 0.02), 3)})
    return out
```

- [ ] **Step 4: Implement `voice.py`**

```python
"""Gemini TTS for the narration stage: the promo film's stdlib client (tools/tts.py), ported into the pack.

POST /v1beta/interactions with the key in the x-goog-api-key header. The audio comes back base64 in
steps[].content[] and is returned as WAV bytes: the API's own WAV as it is (once its data chunk is checked against
the bytes that arrived), or raw PCM wrapped with the rate the reply states (else the film's 24 kHz). 429, 5xx,
network errors and a 200 whose body is unusable (no audio, not JSON, a clipped WAV) are retried within one budget:
at most `retries` requests, a Retry-After honoured up to a minute (else a growing back-off), and a take deadline
that bounds the whole call. Any other failure raises at once. The key is read from GEMINI_API_KEY, sent in a header
only, and kept out of every URL, log and exception message; a key that cannot be a header value is refused before
anything is sent. A redirect is never followed, so the key cannot be replayed elsewhere.
"""

from __future__ import annotations

import base64
import binascii
import http.client
import io
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
import wave
from typing import Callable, Optional

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
MODEL = "gemini-3.8-flash-tts"
KEY_VAR = "GEMINI_API_KEY"
KEY_HEADER = "x-goog-api-key"
KEY_SHAPE = re.compile(r"[\x21-\x7e]+")  # printable ASCII, no space: what an HTTP header value can safely carry
RATE = 24000  # what the film's client assumes of the API's own audio: 24 kHz, mono, 16-bit
TIMEOUT = 180  # per request, and never more than what is left of the take's deadline
DEADLINE = 180.0  # seconds for one take, retries and waits included
BACKOFF = 4  # seconds, times the number of the attempt that just failed: 4, 8, 12
MAX_RETRY_AFTER = 60.0  # a server may ask for longer; a take does not wait that long
NETWORK_ERROR = 599  # a timeout or a dropped connection, reported as a status so it can be retried
Transport = Callable[[str, dict, bytes], tuple[int, dict, bytes]]


class VoiceError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class _BadReply(VoiceError):
    """A 200 whose body cannot be used (no audio, not JSON, clipped): a flaky reply, worth asking for again."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a 3xx is an error here: never replay the request, or its key, elsewhere


_OPENER = urllib.request.build_opener(_NoRedirect)


def _urllib_transport(url: str, headers: dict, data: bytes, timeout: float = TIMEOUT) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        try:
            with _OPENER.open(req, timeout=timeout) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers or {}), err.read()
    except (OSError, http.client.HTTPException) as err:  # timeouts, resets, TLS errors, truncated bodies
        return NETWORK_ERROR, {}, str(err).encode()


def _detail(raw: bytes, key: str) -> str:
    """The start of a reply body for an error message, with the key masked in case the server echoes it."""
    return raw.decode("utf-8", errors="replace").replace(key, "<key>")[:400]


def _retry_after(headers: dict) -> Optional[float]:
    """Seconds the server asked us to wait, at most a minute; None when it did not ask or the value is no number."""
    for name, value in (headers or {}).items():
        if str(name).lower() == "retry-after":
            try:
                seconds = float(str(value).strip())
            except ValueError:
                return None
            return min(MAX_RETRY_AFTER, max(0.0, seconds)) if math.isfinite(seconds) else None
    return None


def _rate_in(mime: str) -> int:
    found = re.search(r"rate=(\d+)", mime)
    return int(found.group(1)) if found else 0


def _number(value, what: str, default: int) -> int:
    if value in (None, "", 0):
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        raise VoiceError(f"the reply's {what} is not a positive number")
    return n


def _riff_problem(audio: bytes) -> Optional[str]:
    """Why a RIFF/WAVE cannot be trusted: no fmt or data chunk, or a data chunk longer than the bytes that arrived.
    Chunks after the data (Google appends a C2PA provenance chunk) are fine."""
    pos, fmt = 12, False
    while pos + 8 <= len(audio):
        chunk, size = audio[pos:pos + 4], int.from_bytes(audio[pos + 4:pos + 8], "little")
        if chunk == b"fmt ":
            fmt = True
        elif chunk == b"data":
            if not fmt:
                return "its data comes before any fmt chunk"
            have = len(audio) - pos - 8
            return None if size <= have else f"its data chunk claims {size} bytes and {have} arrived"
        pos += 8 + size + (size & 1)
    return "it has no data chunk"


def _wav(raw: bytes, key: str) -> bytes:
    """WAV bytes from a 200 reply: the last audio block of the model's output."""
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise _BadReply(f"the reply was not a JSON object: {_detail(raw, key)}", 200)
    blocks = [c for step in payload.get("steps") or [] if isinstance(step, dict) and step.get("type") == "model_output"
              for c in step.get("content") or [] if isinstance(c, dict) and c.get("type") == "audio" and c.get("data")]
    if not blocks:
        raise _BadReply(f"the reply held no audio: {_detail(raw, key)}", 200)
    block = blocks[-1]
    try:
        audio = base64.b64decode(block["data"])
    except (binascii.Error, TypeError, ValueError):
        audio = None
    if audio is None:
        raise _BadReply("the audio in the reply was not valid base64", 200)
    if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        problem = _riff_problem(audio)
        if problem:
            raise _BadReply(f"the WAV in the reply is damaged: {problem}", 200)
        return audio
    mime = str(block.get("mime_type") or block.get("mimeType") or "").lower()
    if mime and "l16" not in mime and "pcm" not in mime:
        raise VoiceError(f"the reply's audio is {mime}, which is neither WAV nor raw PCM")
    rate = _number(block.get("sample_rate") or block.get("sampleRate") or _rate_in(mime), "sample rate", RATE)
    channels = _number(block.get("channels"), "channel count", 1)
    audio = audio[: len(audio) - len(audio) % (2 * channels)]  # whole 16-bit frames only
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(audio)
    return out.getvalue()


def synthesize(text: str, voice: str, style: str = "", model: str = MODEL, retries: int = 4,
               transport: Optional[Transport] = None, sleep: Callable[[float], None] = time.sleep,
               clock: Callable[[], float] = time.monotonic, deadline: float = DEADLINE) -> bytes:
    """WAV bytes of `text` spoken in `voice`. `retries` is the most requests sent, as in the film's client;
    `deadline` is the seconds the whole take may last, requests and waits together."""
    key = os.environ.get(KEY_VAR, "").strip()
    if not key:
        raise VoiceError(f"{KEY_VAR} is not set (source the studio's .env)")
    if not KEY_SHAPE.fullmatch(key):  # http.client would raise a ValueError that quotes the whole key
        raise VoiceError(f"{KEY_VAR} is not a usable key: it must be printable ASCII with no spaces or line breaks")
    part: dict = {"type": "text", "text": text}
    if style:
        part["annotations"] = [{"type": "speech_metadata", "style": style}]
    body = json.dumps({"model": model, "input": [{"type": "user_input", "content": [part]}],
                       "generation_config": {"speech_config": [{"voice": voice}]}}).encode()
    headers = {"Content-Type": "application/json", KEY_HEADER: key}
    started = clock()

    def left() -> float:
        return deadline - (clock() - started)

    send = transport or (lambda url, hdrs, data: _urllib_transport(url, hdrs, data, timeout=max(1.0, min(TIMEOUT, left()))))
    tries, problem, why = max(1, retries), "", ""
    for attempt in range(1, tries + 1):
        status, reply_headers, raw = send(ENDPOINT, headers, body)
        if status == 200:
            try:
                return _wav(raw, key)
            except _BadReply as bad:
                problem = str(bad)
        elif not (status == 429 or status >= 500):
            break
        wait = (None if status == 200 else _retry_after(reply_headers))
        wait = BACKOFF * attempt if wait is None else wait
        if attempt == tries:
            break
        if left() <= wait:
            why = f"; gave up at the {deadline:.0f} s deadline for a take"
            break
        sleep(wait)
    if status == 200:
        raise VoiceError(f"{problem} (attempt {attempt} of {tries}{why})", 200)
    what = "network error" if status == NETWORK_ERROR else f"HTTP {status}"
    raise VoiceError(f"{what} on attempt {attempt} of {tries}{why}: {_detail(raw, key)}", status)
```

- [ ] **Step 5: Implement `narration.py`**

```python
"""Voice stage: Gemini TTS takes for every narration line, each checked by speech recognition, then
cleaned (mono 48 kHz, trimmed, -18 LUFS) and aligned. A line keeps the best of up to three takes. A take is only
as good as what the recogniser hears in it: its WER, whether every figure matches in sign, digits and scale (a million
said for a billion costs one word of WER and is a 1000x error), and whether it is heard to its end (a voice that stops
two words early on a long line still scores a low WER). A best take with WER above 0.10, a figure wrong or its ending
missing fails its line. Every line is tried, the lines that passed are kept, and one error then lists the ones that
did not; the usual fix is to rephrase them."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections import Counter
from pathlib import Path
from typing import Callable

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolRuntime, ToolTier
from tools.shorted import voice
from tools.shorted.asr import align, ending_heard, figures, wer

VOICE = "en-au-tutor-5"
MODEL = "gemini-3.8-flash-tts"
STYLE = "Warm Australian nature-documentary narrator; conversational, dry humour, never hype. "
MAX_TAKES = 3
GOOD_WER = 0.05
MAX_LINE_WER = 0.10
SR = 48000
LINE_LUFS = -18.0
GATE = 10 ** (-45 / 20)  # a sample quieter than this is silence
PRONOUNCE: dict[str, str] = {"NPAT": "N-PAT"}
TTS = Callable[[str, str, Path], None]
ASR = Callable[[Path, str], list[dict]]
META_KEYS = {"key", "file", "duration", "wer", "takes", "words", "tts_text", "style", "spoken", "lufs"}


class NarrationError(RuntimeError):
    pass


def gemini_tts(text: str, style: str, out: Path) -> None:
    """One take through the pack's own Gemini client (OpenMontage's GeminiTTS adapter closes its SDK client
    before it can send, so it cannot be used): WAV bytes written to `out`."""
    try:
        wav = voice.synthesize(text, VOICE, STYLE + style, MODEL)
    except voice.VoiceError as err:
        raise NarrationError(f"Gemini TTS failed: {err}") from err
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(wav)


def whisper_asr(path: Path, prompt: str) -> list[dict]:
    """The words in the audio. `prompt` is what the audio should say: the recogniser sees only its acronyms."""
    from tools.shorted.asr import transcribe_words

    return transcribe_words(path, prompt)


def tts_text(spoken: str, tickers: set[str]) -> str:
    """What the voice is asked to say: tickers spelled out letter by letter, respellings applied."""
    def sub(m: re.Match) -> str:
        w = m.group(0)
        return " ".join(w) if w in tickers else PRONOUNCE.get(w, w)
    return re.sub(r"\b[A-Za-z0-9]+\b", sub, spoken)


def clean_take(src: Path, dst: Path) -> tuple[float, float, float | None]:
    """Mono 48 kHz, silence trimmed to 40 ms pads, loudness -18 LUFS (the 0.97 peak ceiling can leave a peaky line
    a little under). Returns (trimmed start s, duration s, achieved LUFS, or None for a line under half a second)."""
    import numpy as np
    import pyloudnorm as pyln
    import soundfile as sf
    from scipy import signal

    y, sr = sf.read(src, always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        g = math.gcd(int(sr), SR)
        y = signal.resample_poly(y, SR // g, int(sr) // g)
    loud = np.flatnonzero(np.abs(y) > GATE)
    if not len(loud):
        raise NarrationError(f"{src.name} is silent")
    pad = int(0.04 * SR)
    a, b = max(0, int(loud[0]) - pad), min(len(y), int(loud[-1]) + pad)
    y = y[a:b]
    measurable = len(y) > 0.5 * SR
    if measurable:
        y = y * 10 ** ((LINE_LUFS - pyln.Meter(SR).integrated_loudness(y)) / 20)
    peak = float(np.abs(y).max())
    if peak > 0.97:
        y *= 0.97 / peak
    lufs = round(float(pyln.Meter(SR).integrated_loudness(y)), 2) if measurable else None
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(dst, y.astype(np.float32), SR, subtype="PCM_24")
    return a / SR, len(y) / SR, lufs


def _write_json(path: Path, data: dict) -> None:
    """Write the whole file or none of it, so a half-written JSON can never be mistaken for a finished render."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


def _silent(path: Path) -> bool:
    import soundfile as sf

    try:
        y, _ = sf.read(path, always_2d=True)
    except (RuntimeError, ValueError) as err:  # libsndfile's errors: the reply was not audio at all
        raise NarrationError(f"{path.name} is not readable audio: {str(err)[:120]}") from err
    return not bool((abs(y) > GATE).any())


def judge(spoken: str, words: list[dict]) -> dict:
    """What the recognised words say about the script: WER, whether every figure matches (each one as often as it is
    said), and whether the take is heard to its end."""
    heard = " ".join(w["w"] for w in words)
    want, got = figures(spoken), figures(heard)
    return {"wer": wer(spoken, heard), "figures_ok": Counter(want) == Counter(got), "want": want, "got": got,
            "tail_ok": ending_heard(spoken, heard)}


def complete(take: dict) -> bool:
    """Every figure right and the ending heard: what a take needs before its WER is worth comparing."""
    return take["figures_ok"] and take["tail_ok"]


def passes(take: dict) -> bool:
    """Good enough to keep: complete, and WER within the stage limit."""
    return complete(take) and take["wer"] <= MAX_LINE_WER


def good(take: dict) -> bool:
    """Good enough to stop taking: complete, and WER within the target."""
    return complete(take) and take["wer"] <= GOOD_WER


def _listen(raw: Path, spoken: str, asr: ASR) -> dict:
    if _silent(raw):  # silence counts as nothing heard (WER 1.0), and the recogniser is not asked to imagine words
        return {"file": raw, "words": [], "silent": True, "wer": 1.0, "figures_ok": False, "tail_ok": False,
                "want": figures(spoken), "got": []}
    words = asr(raw, spoken)
    return {"file": raw, "words": words, "silent": False, **judge(spoken, words)}


def _figure(f: tuple[str, str, str]) -> str:
    sign, digits, scale = f
    return " ".join(part for part in (f"{sign}{digits}" if sign == "-" else f"{sign} {digits}".strip(), scale) if part)


def _end(words: list[str]) -> str:
    """The last two words of a line as written, for an error: '... to ASIC'."""
    return ("... " if len(words) > 2 else "") + " ".join(words[-2:]).rstrip(".,;:!?")


def _why(take: dict, takes: int, spoken: str) -> str:
    parts = []
    if take["silent"]:
        parts.append("silent audio")
    else:
        if not take["figures_ok"]:
            expected = ", ".join(_figure(f) for f in take["want"]) or "none"
            heard = ", ".join(_figure(f) for f in take["got"]) or "none"
            parts.append(f"figures: expected {expected}, heard {heard}")
        if not take["tail_ok"]:
            heard_words = [w["w"] for w in take["words"]]
            heard = f"'{_end(heard_words)}'" if heard_words else "nothing"
            parts.append(f"ending: expected '{_end(spoken.split())}', heard {heard}")
        if take["wer"] > MAX_LINE_WER:
            parts.append(f"WER {take['wer']:.2f} over the {MAX_LINE_WER:.2f} limit")
    return "; ".join(parts + [f"best of {takes} take{'' if takes == 1 else 's'}"])


def _cached(final: Path, cache: Path) -> dict | None:
    """A finished, passing line from an earlier run. The WAV is written first and the JSON last, so an unreadable
    or incomplete entry is simply a miss and the line is taken again."""
    if not (final.exists() and cache.exists()):
        return None
    try:
        meta = json.loads(cache.read_text())
    except ValueError:
        return None
    ok = isinstance(meta, dict) and META_KEYS <= set(meta) and isinstance(meta["wer"], (int, float)) \
        and meta["wer"] <= MAX_LINE_WER
    return meta if ok else None


def narrate_line(pd: Path, spoken: str, style: str, tickers: set[str], tts: TTS, asr: ASR) -> dict:
    """The line's finished meta, or a NarrationError saying why no take was good enough. Only a passing line is
    cached, so a failed one is taken afresh next time."""
    text = tts_text(spoken, tickers)
    key = hashlib.sha1(f"{VOICE}|{MODEL}|{STYLE + style}|{text}".encode()).hexdigest()[:16]
    final = pd / "assets" / "audio" / "lines" / f"{key}.wav"
    cache = final.with_suffix(".json")
    hit = _cached(final, cache)
    if hit:
        return hit
    takes: list[dict] = []
    for n in range(1, MAX_TAKES + 1):
        raw = pd / "assets" / "audio" / "takes" / f"{key}-{n}.wav"
        raw.parent.mkdir(parents=True, exist_ok=True)
        try:
            tts(text, style, raw)
            take = _listen(raw, spoken, asr)
        except NarrationError:
            if any(passes(t) for t in takes):  # a retake that cannot be had or read does not cost the take in hand
                break
            raise
        takes.append(take)
        if good(take):
            break
    best = min(takes, key=lambda t: (not complete(t), t["wer"]))  # right figures and the ending first, then the fewest errors
    if not passes(best):
        raise NarrationError(_why(best, len(takes), spoken))
    trim, duration, lufs = clean_take(best["file"], final)
    shifted = [{"w": w["w"], "s": max(0.0, w["s"] - trim), "e": max(0.0, w["e"] - trim)} for w in best["words"]]
    meta = {"key": key, "file": str(final.relative_to(pd)), "duration": round(duration, 3), "wer": round(best["wer"], 4),
            "takes": len(takes), "words": align(spoken, shifted), "tts_text": text, "style": style, "spoken": spoken,
            "lufs": lufs}
    _write_json(cache, meta)
    return meta


def narrate(project_dir: Path, tts: TTS = gemini_tts, asr: ASR = whisper_asr) -> dict:
    pd = Path(project_dir)
    done = pd / "artifacts" / "narration.json"
    done.unlink(missing_ok=True)  # a file from an earlier run must not outlive a run that cannot finish
    gates = json.loads((pd / "artifacts" / "gates.json").read_text())
    blocked = [f"{cut} storyboard has gate errors; fix and re-run the storyboard stage"
               for cut, report in gates.items() if report["errors"]]
    if blocked:  # every cut is checked before a single paid take is made
        raise NarrationError("\n".join(blocked))
    dossier = json.loads((pd / "artifacts" / "dossier.json").read_text())
    peers = ((dossier.get("peers") or {}).get("items") or {}).get("value") or []
    tickers = {dossier["ticker"], "ASX"} | {p["code"] for p in peers}
    out: dict = {cut: {} for cut in gates}
    failures: list[str] = []
    failed: dict[tuple[str, str], str] = {}  # a line shared by two cuts that failed once is not paid for again
    for cut, report in gates.items():
        for ln in report["lines"]:
            reason = failed.get((ln["spoken"], ln["style"]))
            if reason is None:
                try:
                    out[cut][ln["id"]] = narrate_line(pd, ln["spoken"], ln["style"], tickers, tts, asr)
                    continue
                except NarrationError as err:
                    reason = failed[(ln["spoken"], ln["style"])] = str(err)
            failures.append(f"{cut}/{ln['id']} ({reason}): {ln['spoken']}")
    _write_json(done, out)  # the lines that passed
    if failures:
        raise NarrationError("lines failed the voice check; rephrase them, or run again to take them afresh:\n"
                             + "\n".join(failures))
    return out


class ShortedNarration(BaseTool):
    name = "shorted_narration"
    version = "1.0.0"
    tier = ToolTier.VOICE
    runtime = ToolRuntime.API
    capability = "narration"
    provider = "shorted"
    resource_profile = ResourceProfile(network_required=True, ram_mb=4096)
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        try:
            out = narrate(Path(inputs["project_dir"]))
        except NarrationError as err:
            return ToolResult(success=False, error=str(err))
        takes = sum(m["takes"] for lines in out.values() for m in lines.values())
        return ToolResult(success=True, data={"lines": {cut: len(v) for cut, v in out.items()}, "takes": takes},
                          artifacts=[str(Path(inputs["project_dir"]) / "artifacts" / "narration.json")])
```

- [ ] **Step 6: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_narration.py tests/shorted/test_voice.py -q`
Expected: PASS (308 tests; the 6 slow ones skip). With `SHORTED_VOICE_CHECK_WAV` naming a real take of the DRO line (Step 7 writes one), `-m slow` runs them against real speech.

- [ ] **Step 7: Check the voice once, live (paid: about one cent)**

```bash
cd /Users/benebsworth/projects/shorted-studio && set -a; . ./.env; set +a
.venv/bin/python - <<'EOF'
from pathlib import Path
from tools.shorted.asr import transcribe_words, wer
from tools.shorted.narration import gemini_tts, tts_text
line = "Short interest in DRO stands at 15.07 per cent of its shares, according to ASIC."
out = Path("/tmp/voice-check.wav")
gemini_tts(tts_text(line, {"DRO", "ASX"}), "warm, curious", out)
heard = " ".join(w["w"] for w in transcribe_words(out, line))
print(heard, "| WER", round(wer(line, heard), 3))
EOF
afplay /tmp/voice-check.wav
```
Expected: an Australian voice says "D R O" and "AY-sick", and the transcript matches with WER ≤ 0.10. Keep the take for the slow tests: `SHORTED_VOICE_CHECK_WAV=/tmp/voice-check.wav .venv/bin/python -m pytest tests/shorted/test_narration.py -q -m slow`. Do not switch voices without asking the user.

- [ ] **Step 8: Commit**

```bash
git add tools/shorted/asr.py tools/shorted/voice.py tools/shorted/narration.py tests/shorted/test_narration.py tests/shorted/test_voice.py
git commit -m "feat(shorted): narration takes with recognition check, cleaning and alignment"
```

### Task 20: Timeline (timings, props, captions, chapters)

**Files:**
- Create: `tools/shorted/timeline.py`, `tests/shorted/sample.py`
- Test: `tests/shorted/test_timeline.py`

**Interfaces:**
- Consumes:
  - `storyboard.<cut>.json`, `dossier.json`, `narration.json` (Task 19), `images.json` (Task 18).
  - `resolve_props`, `placeholders`, `get_path` (Task 7); `axis_label`, `month_label` (Task 3); `CAVEAT`, `TEXT_BUDGETS`, `month_ticks` (Task 8).
- Produces:
  - `artifacts/timeline.<cut>.json`: the Remotion `VideoProps` (Task 12 `types.ts`) exactly.
  - `artifacts/timeline.<cut>.meta.json`: `{cut, duration, bounds, scenes: [{id, start, end}], lines: [{id, scene, chapter, start, end, file, words}], cues, chapters: [{id, title, start}], warnings}`, with times in seconds.
  - Captions: `renders/<T>_<cut>.srt` and `.vtt`.
  - Long cut only: `renders/<T>_long_chapters.txt` (YouTube) and `artifacts/chapters.long.ffmeta` (MP4 chapter metadata).
  - `artifacts/thumb.json` (the Remotion `ThumbProps`).
  - Constants: `LEAD = 0.25`, `GAP = 0.3`, `TAIL = 0.5`, `DEFAULT_MIN = {opening: 4.5, chapter: 2.5, end_card: 6.0}` (otherwise 3.0), `MAX_HOLD = 14`, `BOUNDS = {long: (270, 330), short: (60, 90)}`.
  - Functions:
    - `build_cut(cut, project_dir) -> (props, meta)` and `write_cut(...)`;
    - `word_pages(words, max_words=4, line_chars=0, max_lines=2, *, pause=0.35)` and `cues(words, max_chars=84, line_chars=0, max_lines=2, *, pause=0.5)` (`pause` is keyword-only, so a positional call cannot turn fitting off). A sidecar cue also fits two lines of 42. With `line_chars`, a page ends before a word that would wrap it past `max_lines` lines of that many characters (`fits_lines(text, line_chars, max_lines)`);
    - `srt(cues)`, `vtt(cues)` (cue text escapes `&` and `<`), `ffmeta(chapters, duration)` (titles escape `\ = ; #` and newlines; times in whole milliseconds, rounded), `youtube_chapters(chapters, duration) -> str` ("" when YouTube would ignore the list: the first chapter at 0:00, each at least 10 s — a short first chapter swallows the next — and at least three; times rounded to the nearest second), `nice_axis(lo, hi)` (a zero-width range is widened).
    - Tool `shorted_timeline`: an invalid `project_dir`, a missing storyboard and any `OSError`, `KeyError` or `ValueError` return `success=False` with the message; success data carries `{cut: {duration, in_bounds}}`. `build_cut` raises `ValueError("no narration for <cut> line <id>; run the voice stage")` for a line the voice stage did not write. Text files are UTF-8.
  - Behaviour:
    - A plate whose image was not captured is dropped, with a warning. Its lines move to the nearest kept scene before it in the same chapter that is not a chapter card, else the nearest kept scene after it in that chapter, else the chapter card; lines are never lost (no taker raises `ValueError`).
    - Fewer than three YouTube-valid chapters: no `renders/<T>_long_chapters.txt` (a stale one is removed) and a warning; the `.ffmeta` keeps every chapter.
    - A company logo key that is not staged is removed from the props.
    - Burned-in captions are paged by `gates.TEXT_BUDGETS[cut]` (`caption_line`, `caption_lines`): two lines of 29 characters on the short cut, one line of 66 on the long. The long cut gets its own cue list; the SRT/VTT sidecar keeps 84-character cues. A word longer than a caption line fails the stage.
    - Chart month labels come from `gates.month_ticks`, so the gate counts what the chart draws.
  - `tests/shorted/sample.py`: `dossier()`, `storyboard(cut, dossier)`, `fake_tts`, `fake_asr`, `fake_capture` and `make_run(root, dossier=None, public_root=None) -> project_dir`. The run has been through dossier, brand, storyboard (gated) and assets. These are reused by Tasks 21–24.

- [ ] **Step 1: The shared sample run**

`tests/shorted/sample.py`:

```python
"""A synthetic run for the pipeline tests: a fictional company (EXM), storyboards that use every
scene family at a realistic length, and fakes for the voice, recognition and plate capture."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np

from tools.shorted.bindings import BindingError, get_path, placeholders, resolve_text
from tools.shorted.formatters import MINUS, render
from tools.shorted.gates import END_CARD, check_storyboard
from tools.shorted.values import Source, Value

WORD = 0.38  # seconds per word in the fake voice; real narration runs about 2.6 words a second


def _v(value, unit, ep="GetStockFundamentals", as_at="2026-06-30", **kw) -> dict:
    return Value(value, unit, as_at, kw.pop("trust", "ok"), Source(ep, {}, "2026-10-07T00:00:00+00:00"), **kw).to_json()


def dossier() -> dict:
    days = ["2025-10-01", "2025-11-03", "2025-12-01", "2026-01-05", "2026-02-02", "2026-03-02", "2026-04-01",
            "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01", "2026-09-30"]
    shorts = [8.2, 8.9, 9.4, 10.1, 11.6, 12.2, 11.8, 12.9, 13.4, 14.1, 14.6, 14.9, 15.07]
    prices = [1.62, 1.75, 1.9, 2.05, 1.98, 2.2, 2.35, 2.28, 2.5, 2.62, 2.48, 2.39, 2.41]
    d = {
        "version": "1.0", "ticker": "EXM", "built_at": "2026-10-07",
        "company": {"name": _v("Example Minerals", "text", "GetStockDetails"), "ticker": _v("EXM", "text", "GetStock"),
                    "industry": _v("Metals & Mining", "text", "GetStockDetails"),
                    "summary": _v("Example Minerals mines lithium at two sites in Western Australia.", "text", "GetStockDetails"),
                    "headquarters": _v("Perth, WA", "text", "GetStockDetails"),
                    "logo_url": _v("https://example.invalid/logo.png", "text", "GetStockDetails")},
        "short": {"pct": _v(15.07, "pct", "GetStockData", "2026-09-30"),
                  "change_30d_pp": _v(0.17, "pp", "GetStockData", "2026-09-30"),
                  "rank": _v(7, "rank", "GetTopShorts", "2026-09-30"),
                  "series_1y": _v([list(p) for p in zip(days, shorts)], "series:pct", "GetStockData", "2026-09-30")},
        "price": {"close": _v(2.41, "money", "GetStockPrices", "2026-09-30", currency="AUD"),
                  "series_1y": _v([list(p) for p in zip(days, prices)], "series:money", "GetStockPrices", "2026-09-30", currency="AUD")},
        "results": {"period": _v({"end": "2026-06-30", "type": "annual"}, "period"),
                    "revenue": _v(216.5e6, "money", currency="AUD"),
                    "revenue_prior": _v(125.1e6, "money", as_at="2025-06-30", currency="AUD"),
                    "revenue_yoy_pct": _v(73.06, "pct"), "net_income": _v(30.8e6, "money", currency="AUD")},
        "peers": {"items": _v([{"code": "EXM", "name": "Example Minerals", "short_pct": 15.07, "subject": True},
                               {"code": "AAA", "name": "Alpha Resources", "short_pct": 9.1, "subject": False},
                               {"code": "BBB", "name": "Beta Mining", "short_pct": 6.4, "subject": False}],
                              "rows:peers", "GetPeerComparison", "2026-09-30")},
        "news": {"items": _v([{"date": "2026-09-28", "headline": "Example Minerals signs an offtake agreement", "source": "x", "sentiment": "positive"},
                              {"date": "2026-09-15", "headline": "Quarterly activities report", "source": "x", "sentiment": "neutral"}],
                             "rows:news", "GetStockNews", "2026-09-28")},
    }
    d["coverage"] = {ch: {"ok": True, "missing": [], "stale": []} for ch in
                     ("cold_open", "company", "result", "cash", "outlook", "bears", "news", "watch", "close")}
    return d


POOL = {
    "cold_open": ["This is a field guide to {{company.name|text}} and the bears around it.",
                  "Short interest stands at {{short.pct|pct}} of its shares."],
    "company": ["{{company.name|text}} sits in {{company.industry|text}}.", "Its head office is in {{company.headquarters|text}}.",
                "It is listed on the ASX as {{company.ticker|text}}."],
    "result": ["Revenue came in at {{results.revenue|money}}.", "A year earlier it was {{results.revenue_prior|money}}.",
               "That is {{results.revenue_yoy_pct|change_pct}} on the year before.", "Net profit was {{results.net_income|money}}.",
               "These figures cover {{results.period|period}}."],
    "bears": ["Short interest is {{short.pct|pct}} of shares on issue.", "Over the past month it moved {{short.change_30d_pp|pp}}.",
              "On the short list it ranks {{short.rank|rank}}.", "The latest ASIC figure is dated {{short.pct|as_at}}.",
              "The share price last closed at {{price.close|money}}."],
    "news": ["The latest headline is dated {{news.items[0].date|date}}.", "It reads: {{news.items[0].headline|text}}."],
    "close": ["That is the field guide to {{company.name|text}} for this report."],
}

def _scenes(cut: str) -> list[tuple]:
    """(chapter, no, title, type, props, target spoken words)."""
    opening = {"ticker": "{{company.ticker|text}}", "company": "{{company.name|text}}", "kicker": "A field guide to the bears"}
    result = {"no": 3, "title": "The result", "as_at": "{{results.period|period}}", "source": "{{results.revenue|source}}",
              "items": [{"label": "Revenue", "value": "{{results.revenue|money}}", "prior": "vs {{results.revenue_prior|money}} a year earlier",
                         "change": "{{results.revenue_yoy_pct|change_pct}}", "direction": "?"},
                        {"label": "Net profit", "value": "{{results.net_income|money}}"}]}
    chart = {"no": 6, "title": "Short interest and price", "as_at": "{{short.pct|as_at}}", "source": "{{short.series_1y|source}}",
             "series": [{"label": "Short interest", "points": "{{short.series_1y|series}}", "unit": "pct", "axis": "left", "last": "{{short.pct|pct}}"},
                        {"label": "Share price", "points": "{{price.series_1y|series}}", "unit": "money", "axis": "right", "last": "{{price.close|money}}"}]}
    news = {"no": 7, "title": "In the news", "rows": "{{news.items|rows3}}", "as_at": "{{news.items|as_at}}", "source": "{{news.items|source}}"}
    if cut == "short":
        return [("cold_open", 1, "Cold open", "opening", opening, 25), ("result", 3, "The result", "number_card", result, 45),
                ("bears", 6, "The bears", "line_chart", chart, 45), ("news", 7, "News", "list_card", news, 25),
                ("close", 9, "Close", "end_card", copy.deepcopy(END_CARD), 12)]
    company = {"no": 2, "name": "{{company.name|text}}", "ticker": "{{company.ticker|text}}", "industry": "{{company.industry|text}}",
               "summary": "{{company.summary|text}}", "logo": "logo", "hq": "{{company.headquarters|text}}"}
    peers = {"no": 6, "title": "Crowding against peers", "items": "{{peers.items|bars_peers}}", "as_at": "{{short.pct|as_at}}",
             "source": "{{peers.items|source}}"}
    plate = {"no": 6, "title": "On Shorted", "image": "plate_stock_chart", "caption": "the stock page, live", "as_at": "{{short.pct|as_at}}"}
    return [("cold_open", 1, "Cold open", "opening", opening, 35),
            ("company", 2, "The company", "chapter", {"no": 2, "title": "The company"}, 0),
            ("company", 2, "The company", "company", company, 60),
            ("result", 3, "The result", "chapter", {"no": 3, "title": "The result", "sub": "{{results.period|period}}"}, 0),
            ("result", 3, "The result", "number_card", result, 150),
            ("bears", 6, "The bears", "chapter", {"no": 6, "title": "The bears"}, 0),
            ("bears", 6, "The bears", "line_chart", chart, 140), ("bears", 6, "The bears", "bar_compare", peers, 90),
            ("bears", 6, "The bears", "plate", plate, 50),
            ("news", 7, "News and insiders", "chapter", {"no": 7, "title": "News and insiders"}, 0),
            ("news", 7, "News and insiders", "list_card", news, 75),
            ("close", 9, "Close", "end_card", copy.deepcopy(END_CARD), 20)]


OPTIONAL = {"hq", "industry", "logo", "sub", "prior", "change", "direction"}
BUDGET = {"long": 620, "short": 150}  # spoken words: inside both cuts' duration bounds at WORD seconds a word


def _usable(d: dict, value) -> bool:
    try:
        return all(get_path(d, p).usable for p, _ in placeholders(json.dumps(value)))
    except BindingError:
        return False


def _clean(d: dict, props: dict) -> dict | None:
    """Drop optional props this dossier cannot support; None when a required one is unsupported."""
    out = {}
    for k, v in props.items():
        if k == "items" and isinstance(v, list):
            items = []
            for it in v:
                kept = {ik: iv for ik, iv in it.items() if ik not in OPTIONAL or _usable(d, iv)}
                if "change" not in kept:
                    kept.pop("direction", None)
                elif kept.get("direction") == "?":
                    path, fmt = placeholders(kept["change"])[0]
                    shown = render(get_path(d, path), fmt, "display")
                    kept["direction"] = "down" if shown.startswith(MINUS) else "up" if shown.startswith("+") else "flat"
                if _usable(d, kept):
                    items.append(kept)
            if not items:
                return None
            out[k] = items
        elif _usable(d, v):
            out[k] = v
        elif k not in OPTIONAL:
            return None
    return out


def storyboard(cut: str, d: dict) -> dict:
    """A gate-clean storyboard from whatever this dossier supports, scaled to the cut's word budget."""
    plan = []
    for ch_id, no, title, kind, props, target in _scenes(cut):
        cleaned = _clean(d, props) if d["coverage"].get(ch_id, {}).get("ok", False) else None
        if cleaned is not None:
            plan.append((ch_id, no, title, kind, cleaned, target))
    with_data = {p[0] for p in plan if p[3] != "chapter"}
    plan = [p for p in plan if p[0] in with_data]  # a chapter card alone is dropped
    scale = BUDGET[cut] / max(1, sum(p[5] for p in plan))
    chapters: dict[str, dict] = {}
    n = 0
    for ch_id, no, title, kind, props, target in plan:
        pool = [s for s in POOL.get(ch_id, []) if _usable(d, s)]
        lines, words, i = [], 0, 0
        while pool and words < target * scale:
            text = pool[i % len(pool)]
            words += len(resolve_text(text, d, "spoken")[0].split())
            lines.append({"id": f"L{n:03d}", "text": text, "style": "warm, curious"})
            n += 1
            i += 1
        chapters.setdefault(ch_id, {"id": ch_id, "no": no, "title": title, "scenes": []})["scenes"].append(
            {"id": f"s{n:03d}{kind[:2]}", "type": kind, "props": props, "lines": lines})
        n += 1
    return {"version": "1.0", "ticker": d["ticker"], "cut": cut, "title": f"{d['ticker']} results",
            "thumbnail": {"headline": ["Know where", "the bears are."], "kicker": "A field guide to the bears"},
            "chapters": list(chapters.values()), "data_wishes": [{"chapter": "outlook", "wanted": "guidance quote", "why": "test"}]}


def fake_tts(text: str, style: str, out: Path) -> None:
    import soundfile as sf

    sr, parts = 24000, [np.zeros(2880)]
    for i, _ in enumerate(text.split()):
        t = np.arange(int((WORD - 0.06) * sr)) / sr
        parts += [0.2 * np.sin(2 * np.pi * (180 + 20 * (i % 5)) * t) * np.hanning(len(t)), np.zeros(1440)]
    parts.append(np.zeros(2880))
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, np.concatenate(parts).astype(np.float32), sr)


def fake_asr(path: Path, prompt: str) -> list[dict]:
    return [{"w": w, "s": 0.12 + i * WORD, "e": 0.12 + (i + 1) * WORD - 0.06} for i, w in enumerate(prompt.split())]


def fake_capture(jobs: list[dict]) -> list[dict]:
    from PIL import Image, ImageDraw

    for j in jobs:
        im = Image.new("RGB", (1290, 1500), (250, 247, 240))
        ImageDraw.Draw(im).line([(60, 1300), (500, 900), (900, 1000), (1230, 400)], fill=(217, 132, 42), width=14)
        im.save(j["out"])
    return [{"key": j["key"], "ok": True, "out": j["out"]} for j in jobs]


def make_run(root: Path, d: dict | None = None, public_root: Path | None = None) -> Path:
    """A project after dossier, brand, storyboard (gated) and assets, with narration from the fakes.
    Images are staged under public_root (default root/public; a real render needs remotion-composer/public)."""
    from PIL import Image

    from tools.shorted.assets import run_assets
    from tools.shorted.gates import ShortedScriptGates
    from tools.shorted.narration import narrate

    d = d or dossier()
    pd = Path(root) / f"{d['ticker']}-2026-10-07"
    for sub in ("artifacts", "assets/images", "assets/audio", "assets/music", "renders"):
        (pd / sub).mkdir(parents=True, exist_ok=True)
    (pd / "artifacts/dossier.json").write_text(json.dumps(d))
    Image.new("RGBA", (256, 256), (217, 132, 42, 255)).save(pd / "assets/images/logo.png")
    (pd / "artifacts/brand.json").write_text(json.dumps({"ticker": d["ticker"], "logo": {
        "file": "assets/images/logo.png", "source_url": "https://example.invalid/logo.png", "width": 256, "height": 256}}))
    for cut in ("long", "short"):
        sb = storyboard(cut, d)
        assert check_storyboard(sb, d).errors == [], check_storyboard(sb, d).errors
        (pd / f"artifacts/storyboard.{cut}.json").write_text(json.dumps(sb, indent=1))
    assert ShortedScriptGates().execute({"project_dir": str(pd)}).success
    run_assets(pd, capture=fake_capture, public_root=public_root or Path(root) / "public")
    narrate(pd, tts=fake_tts, asr=fake_asr)
    return pd
```

- [ ] **Step 2: Write the failing tests**

`tests/shorted/test_timeline.py`:

```python
"""Timeline tests. The constants here are literals on purpose: a test that imports LEAD or BOUNDS from the module under
test agrees with whatever a change makes of them. Fixtures are copies of the sample run's artefacts (the timeline reads
JSON, never audio) or, where the sample gets in the way, a minimal project built by project()."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.shorted.sample import dossier, make_run
from tools.shorted.bindings import resolve_props
from tools.shorted.gates import TEXT_BUDGETS
from tools.shorted.timeline import (ShortedTimeline, build_cut, chart_axes, cues, ffmeta, fits_lines, nice_axis, srt, vtt,
                                    word_pages, write_cut, youtube_chapters)
from tools.shorted.values import Source, Value

STUDIO = Path(__file__).resolve().parents[2]
CAVEAT = "ASIC data shows the size of short positions, not who holds them or why."
NO_CHAPTERS = "fewer than three chapters of 10 s or more; YouTube chapters not written"
MIN_HOLD = {"opening": 4.5, "chapter": 2.5, "end_card": 6.0}  # every other scene holds 3.0 s at least


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    return make_run(tmp_path_factory.mktemp("run"))


def load(pd, name):
    return json.loads((Path(pd) / "artifacts" / name).read_text(encoding="utf-8"))


def save(pd, name, data):
    (Path(pd) / "artifacts" / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def clone(run, tmp_path):
    """A copy of the sample run's artefacts to edit."""
    pd = tmp_path / "EXM-2026-10-07"
    shutil.copytree(run / "artifacts", pd / "artifacts")
    return pd


def wrap(text, width):
    """Greedy wrap, as the monospaced overlay breaks a caption: written here, not taken from the module under test."""
    lines, line = [], ""
    for w in text.split():
        if line and len(line) + 1 + len(w) > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    return lines + ([line] if line else [])


def scene(sid, kind, *line_ids, **props):
    return {"id": sid, "type": kind, "props": props, "lines": [{"id": i, "text": "text", "style": ""} for i in line_ids]}


def chapter(cid, *scenes):
    return {"id": cid, "no": 1, "title": cid.upper(), "scenes": list(scenes)}


def entry(text, step=0.4, start=0.1):
    """A narration entry for text: the timeline reads only the words and the duration, never the audio."""
    words = [{"w": w, "s": round(start + i * step, 3), "e": round(start + i * step + 0.3, 3)} for i, w in enumerate(text.split())]
    return {"file": "assets/audio/lines/x.wav", "duration": round(start + len(words) * step, 3), "words": words}


def placed(meta):
    """(line id, scene id) for every spoken line, in the order they are spoken."""
    return [(ln["id"], ln["scene"]) for ln in meta["lines"]]


def chapters_at(*starts, titles="ABCDEFG"):
    """Chapters named A, B, C... starting at the given seconds."""
    return [{"id": t.lower(), "title": t, "start": s} for t, s in zip(titles, starts)]


def project(tmp_path, chapters, images=("plate_x",), speech=None, cut="long"):
    """A minimal project: the storyboard, a dossier, narration for every line (four words unless speech says otherwise)
    and the images that were captured."""
    pd = tmp_path / "EXM-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    ids = [ln["id"] for ch in chapters for sc in ch["scenes"] for ln in sc["lines"]]
    save(pd, f"storyboard.{cut}.json", {"version": "1.0", "ticker": "EXM", "cut": cut, "title": "EXM", "chapters": chapters})
    save(pd, "dossier.json", {"ticker": "EXM", "company": {"name": {"value": "Example Minerals"}}})
    save(pd, "narration.json", {cut: {i: entry((speech or {}).get(i, "alpha beta gamma delta")) for i in ids}})
    save(pd, "images.json", {k: {"src": f"shorted-runs/x/{k}.png"} for k in images})
    return pd


# ---- timing ----------------------------------------------------------------------------------------------------------

def test_scene_timing_follows_the_narration(run):
    props, meta = build_cut("long", run)
    scenes = props["scenes"]
    assert scenes[0]["start"] == 0 and all(a["end"] == b["start"] for a, b in zip(scenes, scenes[1:]))
    for sc in scenes:
        lines = [ln for ln in meta["lines"] if ln["scene"] == sc["id"]]
        spoken = 0.0
        if lines:
            assert lines[0]["start"] == pytest.approx(sc["start"] + 0.25, abs=1e-3)
            assert all(b["start"] == pytest.approx(a["end"] + 0.3, abs=1e-3) for a, b in zip(lines, lines[1:]))
            spoken = lines[-1]["end"] + 0.5 - sc["start"]
        assert sc["end"] - sc["start"] == pytest.approx(max(spoken, MIN_HOLD.get(sc["type"], 3.0)), abs=2e-3), sc["id"]
    assert props["durationInFrames"] == 8571


def test_the_frame_count_is_the_ceiling_of_the_duration(run):
    long_props, long_meta = build_cut("long", run)
    short_props, short_meta = build_cut("short", run)
    assert (long_meta["duration"], long_props["durationInFrames"]) == (285.7, 8571)
    assert (short_meta["duration"], short_props["durationInFrames"]) == (77.47, 2325)  # 2324.1 frames: floor and round say 2324
    assert [long_props[k] for k in ("width", "height", "fps")] == [1920, 1080, 30]
    assert [short_props[k] for k in ("width", "height", "fps")] == [1080, 1920, 30]


@pytest.mark.parametrize("cut, lo, hi", [("long", 270, 330), ("short", 60, 90)])
def test_both_cuts_land_inside_their_bounds(run, cut, lo, hi):
    _, meta = build_cut(cut, run)
    assert lo <= meta["duration"] <= hi and meta["bounds"] == [lo, hi]
    assert not any("target" in w for w in meta["warnings"])


@pytest.mark.parametrize("cut, factor, lo, hi", [("short", 0.4, 60, 90), ("long", 1.5, 270, 330)])
def test_a_cut_outside_its_bounds_warns_and_the_tool_says_so(run, tmp_path, cut, factor, lo, hi):
    pd = clone(run, tmp_path)
    nar = load(pd, "narration.json")
    for e in nar[cut].values():
        e["duration"] = round(e["duration"] * factor, 3)
    save(pd, "narration.json", nar)
    _, meta = build_cut(cut, pd)
    assert not lo <= meta["duration"] <= hi
    assert f"{cut} runs {meta['duration']:.1f} s; target {lo}-{hi} s" in meta["warnings"]
    res = ShortedTimeline().execute({"project_dir": str(pd)})
    other = "short" if cut == "long" else "long"
    assert res.success and res.data[cut]["in_bounds"] is False and res.data[other]["in_bounds"] is True  # a warning, not a stop


def test_a_scene_held_over_fourteen_seconds_is_flagged(run):
    props, meta = build_cut("long", run)
    held = [s["id"] for s in props["scenes"] if s["end"] - s["start"] > 14]
    assert len(held) >= 3 and [w.split(":")[0] for w in meta["warnings"] if "holds" in w] == held
    assert "s035nu: holds 64.4 s (over 14); split it into two scenes" in meta["warnings"]


def test_the_hold_limit_is_fourteen_seconds_exactly(tmp_path):
    a1, a2 = scene("a1", "number_card"), scene("a2", "number_card")
    a1["min_seconds"], a2["min_seconds"] = 14.0, 14.5
    _, meta = build_cut("long", project(tmp_path, [chapter("c1", a1, a2)]))
    assert [w for w in meta["warnings"] if "holds" in w] == ["a2: holds 14.5 s (over 14); split it into two scenes"]


def test_scenes_without_narration_hold_their_minimum_and_min_seconds_raises_it(run, tmp_path):
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    for ch in sb["chapters"]:
        for sc in ch["scenes"]:
            sc["lines"] = []
    by_type = {sc["type"]: sc for ch in sb["chapters"] for sc in ch["scenes"]}
    by_type["company"]["min_seconds"] = 7.5      # longer than its 3.0 s default: it holds that long
    by_type["number_card"]["min_seconds"] = 1.0  # shorter: it cannot cut the default
    save(pd, "storyboard.long.json", sb)
    props, _ = build_cut("long", pd)
    held = {s["type"]: round(s["end"] - s["start"], 3) for s in props["scenes"]}
    assert held == {"opening": 4.5, "chapter": 2.5, "company": 7.5, "number_card": 3.0, "line_chart": 3.0,
                    "bar_compare": 3.0, "plate": 3.0, "list_card": 3.0, "end_card": 6.0}


def test_the_first_scene_cuts_in_and_the_rest_turn_the_page(run, tmp_path):
    props, _ = build_cut("long", run)
    assert [s["transition"] for s in props["scenes"]] == ["cut"] + ["page"] * (len(props["scenes"]) - 1)
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    next(sc for ch in sb["chapters"] for sc in ch["scenes"] if sc["type"] == "number_card")["transition"] = "cut"
    save(pd, "storyboard.long.json", sb)
    props, _ = build_cut("long", pd)
    assert [s["type"] for s in props["scenes"] if s["transition"] == "cut"] == ["opening", "number_card"]


# ---- the Remotion props ----------------------------------------------------------------------------------------------

def test_the_props_and_meta_have_exactly_the_documented_shape(run):
    props, meta = build_cut("short", run)
    assert set(props) == {"cut", "width", "height", "fps", "durationInFrames", "ticker", "images", "scenes", "captions",
                          "showCaptions", "wordCaptions"}
    assert all(set(s) == {"id", "type", "chapter", "no", "start", "end", "transition", "super", "props"} for s in props["scenes"])
    assert props["images"] == {"logo": "shorted-runs/EXM-2026-10-07/logo.png",
                               "plate_stock_chart": "shorted-runs/EXM-2026-10-07/plate_stock_chart.png"}
    assert (props["ticker"], props["showCaptions"], props["wordCaptions"]) == ("EXM", True, True)
    assert set(meta) == {"cut", "duration", "bounds", "scenes", "lines", "cues", "chapters", "warnings"}
    assert all(set(ln) == {"id", "scene", "chapter", "start", "end", "file", "words"} for ln in meta["lines"])
    assert [(s["id"], s["start"], s["end"]) for s in meta["scenes"]] == [(s["id"], s["start"], s["end"]) for s in props["scenes"]]


def test_short_data_scenes_carry_the_caveat(run):
    props, _ = build_cut("long", run)
    by_type = {s["type"]: s for s in props["scenes"]}
    assert by_type["line_chart"]["super"] == CAVEAT and by_type["bar_compare"]["super"] == CAVEAT
    assert by_type["opening"]["super"] == CAVEAT  # its props bind nothing about shorts; its narration does
    assert [by_type[t]["super"] for t in ("company", "number_card", "list_card", "chapter", "end_card")] == [None] * 5


def test_the_caveat_follows_each_kind_of_binding(run, tmp_path):
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    by_type = {sc["type"]: sc for ch in sb["chapters"] for sc in ch["scenes"]}
    chart, bars, card = by_type["line_chart"], by_type["bar_compare"], by_type["number_card"]
    chart["lines"] = []                                       # short.* in its props alone
    bars["lines"] = []
    bars["props"]["as_at"] = "{{peers.items|as_at}}"          # peers.* in its props alone
    card["lines"] = [{"id": "L016", "text": "Short interest is {{short.pct|pct}} of shares on issue.", "style": ""}]  # short.* in a line alone
    save(pd, "storyboard.long.json", sb)
    props, _ = build_cut("long", pd)
    got = {s["type"]: s["super"] for s in props["scenes"]}
    assert got["line_chart"] == CAVEAT and got["bar_compare"] == CAVEAT and got["number_card"] == CAVEAT
    assert json.dumps(chart["props"]).count("peers.") == 0 and json.dumps(bars["props"]).count("short.") == 0
    assert got["company"] is None


def test_line_chart_axes_are_zero_based_and_formatted(run):
    props, _ = build_cut("long", run)
    axes = next(s for s in props["scenes"] if s["type"] == "line_chart")["props"]["axes"]
    assert axes["left"]["min"] == 0 and axes["left"]["ticks"][-1]["label"].endswith("%")
    assert axes["right"]["ticks"][1]["label"].startswith("A$")
    assert [x["label"] for x in axes["x"]] == ["Oct 2025", "Jan 2026", "Apr 2026", "Jul 2026"]


def test_props_are_resolved_strings(run):
    props, _ = build_cut("long", run)
    blob = json.dumps(props)
    assert "{{" not in blob and "A$216.5M" in blob


def test_an_unstaged_logo_is_left_out_of_the_company_card(run, tmp_path):
    props, _ = build_cut("long", run)
    assert next(s for s in props["scenes"] if s["type"] == "company")["props"]["logo"] == "logo"
    pd = clone(run, tmp_path)
    images = load(pd, "images.json")
    images.pop("logo")
    save(pd, "images.json", images)
    props, meta = build_cut("long", pd)
    company = next(s for s in props["scenes"] if s["type"] == "company")
    assert "logo" not in company["props"] and company["props"]["name"] == "Example Minerals"
    assert "s014co: logo not staged; shown without it" in meta["warnings"]
    assert "logo" not in props["images"]
    write_cut("long", pd)
    thumb = load(pd, "thumb.json")
    assert thumb["logo"] is None and "logo" not in thumb["images"]


# ---- dropped scenes --------------------------------------------------------------------------------------------------

def test_dropped_chapter_has_no_scenes(tmp_path):
    d = dossier()
    d["coverage"]["result"] = {"ok": False, "missing": ["results.revenue"], "stale": []}
    pd = make_run(tmp_path, d)
    props, meta = build_cut("long", pd)
    assert "result" not in {s["chapter"] for s in props["scenes"]}
    assert "result" not in {c["id"] for c in meta["chapters"]}
    assert all(a["end"] == b["start"] for a, b in zip(props["scenes"], props["scenes"][1:]))


def test_missing_plate_moves_its_lines_to_the_scene_before(tmp_path):
    pd = make_run(tmp_path)
    images = load(pd, "images.json")
    images.pop("plate_stock_chart")
    save(pd, "images.json", images)
    props, meta = build_cut("long", pd)
    assert "plate" not in {s["type"] for s in props["scenes"]}
    sb = load(pd, "storyboard.long.json")
    plate_lines = [ln["id"] for ch in sb["chapters"] for sc in ch["scenes"] if sc["type"] == "plate" for ln in sc["lines"]]
    assert len(plate_lines) == 6 and {ln["id"] for ln in meta["lines"]} >= set(plate_lines)
    assert {ln["scene"] for ln in meta["lines"] if ln["id"] in plate_lines} == {"s064ba"}  # the bar chart before it
    assert ("s071pl: plate plate_stock_chart was not captured; scene dropped, "
            "its 6 lines went to the scene before it (s064ba)") in meta["warnings"]


def test_a_dropped_plate_keeps_its_lines_in_the_scene_before_it_within_its_chapter(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("k1", "chapter"), scene("a1", "number_card", "A1"),
                                    scene("p1", "plate", "P1", "P2", image="plate_x"), scene("z1", "number_card", "Z1"))],
                 images=())
    props, meta = build_cut("long", pd)
    assert [s["id"] for s in props["scenes"]] == ["k1", "a1", "z1"]
    assert placed(meta) == [("A1", "a1"), ("P1", "a1"), ("P2", "a1"), ("Z1", "z1")]
    assert [w for w in meta["warnings"] if "plate" in w] == [
        "p1: plate plate_x was not captured; scene dropped, its 2 lines went to the scene before it (a1)"]


def test_a_dropped_plate_straight_after_the_chapter_card_goes_to_the_scene_after_it(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("k1", "chapter"), scene("p1", "plate", "P1", image="plate_x"),
                                    scene("a1", "number_card", "A1"), scene("a2", "number_card", "A2"))], images=())
    props, meta = build_cut("long", pd)
    assert placed(meta) == [("P1", "a1"), ("A1", "a1"), ("A2", "a2")]  # the nearest one, ahead of its own lines
    assert "p1: plate plate_x was not captured; scene dropped, its 1 line went to the scene after it (a1)" in meta["warnings"]
    card = props["scenes"][0]
    assert card["id"] == "k1" and card["end"] - card["start"] == 2.5  # the card is not stretched by the narration


def test_a_plate_that_opens_the_film_does_not_lose_its_lines(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("p1", "plate", "P1", image="plate_x"), scene("a1", "opening", "A1"))], images=())
    props, meta = build_cut("long", pd)
    assert [s["id"] for s in props["scenes"]] == ["a1"] and props["scenes"][0]["transition"] == "cut"
    assert placed(meta) == [("P1", "a1"), ("A1", "a1")]


def test_a_dropped_plate_with_only_a_card_in_its_chapter_goes_to_the_card_and_never_to_another_chapter(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("a0", "number_card", "A0")),
                            chapter("c2", scene("k2", "chapter"), scene("p2", "plate", "P1", "P2", image="plate_x")),
                            chapter("c3", scene("a3", "number_card", "A3"))], images=())
    props, meta = build_cut("long", pd)
    assert placed(meta) == [("A0", "a0"), ("P1", "k2"), ("P2", "k2"), ("A3", "a3")]
    assert "p2: plate plate_x was not captured; scene dropped, its 2 lines went to the chapter card (k2)" in meta["warnings"]
    card = next(s for s in props["scenes"] if s["id"] == "k2")
    assert next(ln for ln in meta["lines"] if ln["id"] == "P1")["start"] == pytest.approx(card["start"] + 0.25, abs=1e-3)


@pytest.mark.parametrize("scenes, expect", [
    ([scene("k1", "chapter"), scene("p1", "plate", "P1", image="plate_x"), scene("p2", "plate", "P2", image="plate_x"),
      scene("a1", "number_card", "A1")], [("P1", "a1"), ("P2", "a1"), ("A1", "a1")]),
    ([scene("k1", "chapter"), scene("a1", "number_card", "A1"), scene("p1", "plate", "P1", image="plate_x"),
      scene("p2", "plate", "P2", image="plate_x")], [("A1", "a1"), ("P1", "a1"), ("P2", "a1")]),
], ids=["two ahead of a scene", "two behind a scene"])
def test_consecutive_dropped_plates_keep_the_order_they_were_spoken_in(tmp_path, scenes, expect):
    _, meta = build_cut("long", project(tmp_path, [chapter("c1", *scenes)], images=()))
    assert placed(meta) == expect


def test_a_plate_that_was_captured_is_untouched(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("a1", "number_card", "A1"), scene("p1", "plate", "P1", image="plate_x"))])
    props, meta = build_cut("long", pd)
    assert [s["id"] for s in props["scenes"]] == ["a1", "p1"] and placed(meta) == [("A1", "a1"), ("P1", "p1")]
    assert not any("plate" in w for w in meta["warnings"])


def test_a_lineless_dropped_plate_is_just_dropped_and_lines_are_never_lost_otherwise(tmp_path):
    _, meta = build_cut("long", project(tmp_path / "a", [chapter("c1", scene("a1", "number_card", "A1"),
                                                                  scene("p1", "plate", image="plate_x"))], images=()))
    assert placed(meta) == [("A1", "a1")] and "p1: plate plate_x was not captured; scene dropped" in meta["warnings"]
    alone = project(tmp_path / "b", [chapter("c1", scene("p1", "plate", "P1", "P2", image="plate_x"))], images=())
    with pytest.raises(ValueError, match=r"plate plate_x \(p1\) was not captured.*chapter c1.*P1, P2"):
        build_cut("long", alone)


# ---- narration the voice stage did not make --------------------------------------------------------------------------

def test_a_line_without_narration_is_one_clear_error(run, tmp_path):
    pd = clone(run, tmp_path)
    nar = load(pd, "narration.json")
    nar["long"].pop("L012")
    save(pd, "narration.json", nar)
    with pytest.raises(ValueError, match="^no narration for long line L012; run the voice stage$"):
        build_cut("long", pd)
    build_cut("short", pd)  # the other cut is whole


def test_a_cut_missing_from_the_narration_is_the_same_error(run, tmp_path):
    pd = clone(run, tmp_path)
    nar = load(pd, "narration.json")
    nar.pop("short")
    save(pd, "narration.json", nar)
    with pytest.raises(ValueError, match="^no narration for short line L000; run the voice stage$"):
        build_cut("short", pd)


# ---- captions --------------------------------------------------------------------------------------------------------

def test_word_pages_and_cues():
    words = [{"w": w, "s": i * 0.4, "e": i * 0.4 + 0.35} for i, w in enumerate("One two three four five. Six seven".split())]
    pages = word_pages(words)
    assert [p["text"] for p in pages] == ["One two three four", "five.", "Six seven"]
    long_words = [{"w": "word", "s": i * 0.3, "e": i * 0.3 + 0.25} for i in range(40)]
    assert all(len(c["text"]) <= 84 for c in cues(long_words))
    text = srt(cues(words))
    assert text.startswith("1\n00:00:00,000 --> ") and "five." in text


def test_caption_pages_hold_what_the_overlay_draws_whole():
    """A burned-in page never wraps past its lines (two of 29 characters on the short cut, one of 66 on the long), so the
    overlay never has to drop a word; the sidecar cues keep their two lines of 42."""
    words = [{"w": w, "s": i * 0.3, "e": i * 0.3 + 0.25}
             for i, w in enumerate("radiopharmaceuticals commercialisation telecommunications infrastructure".split())]
    pages = word_pages(words, line_chars=29, max_lines=2)
    assert len(pages) > 1 and all(fits_lines(p["text"], 29, 2) for p in pages)
    many = [{"w": "word" if i % 5 else "extraordinarily", "s": i * 0.3, "e": i * 0.3 + 0.25} for i in range(60)]
    assert all(fits_lines(c["text"], 66, 1) for c in cues(many, line_chars=66, max_lines=1))
    assert any(len(c["text"]) > 66 for c in cues(many))
    assert not fits_lines("x" * 30, 29) and fits_lines("aaa bbb", 3, 2) and not fits_lines("aaa bbb", 3, 1)


@pytest.mark.parametrize("cut, width, rows", [("long", 66, 1), ("short", 29, 2)])
def test_every_burned_in_page_fits_its_budget_and_no_word_is_lost(run, cut, width, rows):
    assert (TEXT_BUDGETS[cut]["caption_line"], TEXT_BUDGETS[cut]["caption_lines"]) == (width, rows)
    props, meta = build_cut(cut, run)
    pages = props["captions"]
    for p in pages:  # the module's own fits_lines and an independent wrap must both say it fits
        assert fits_lines(p["text"], width, rows), p["text"]
        assert len(wrap(p["text"], width)) <= rows and all(len(x) <= width for x in wrap(p["text"], width)), p["text"]
    assert [t for p in pages for t in p["text"].split()] == [w["w"] for ln in meta["lines"] for w in ln["words"]]
    if cut == "short":
        assert all([w["w"] for w in p["words"]] == p["text"].split() and len(p["words"]) <= 4 for p in pages)
    else:
        assert all(p["words"] == [] for p in pages)
    assert all(a["end"] <= b["start"] + 0.3 for a, b in zip(pages, pages[1:]))


LONG_SENTENCE = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron."  # 81 characters, one sentence


def test_the_long_cut_burns_one_line_while_the_sidecar_keeps_two(tmp_path):
    assert 66 < len(LONG_SENTENCE) <= 84
    pd = project(tmp_path, [chapter("c1", scene("a1", "number_card", "L1", "L2"))],
                 speech={"L1": LONG_SENTENCE, "L2": "One short sentence. And a second one follows it."})
    props, meta = build_cut("long", pd)
    burned, sidecar = [p["text"] for p in props["captions"]], [c["text"] for c in meta["cues"]]
    assert sidecar == [LONG_SENTENCE, "One short sentence.", "And a second one follows it."]
    assert burned == ["alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", "nu xi omicron.",
                      "One short sentence.", "And a second one follows it."]


def test_the_short_cut_breaks_a_page_before_a_word_that_will_not_fit(tmp_path):
    pd = project(tmp_path, [chapter("c1", scene("a1", "number_card", "L1"))], cut="short",
                 speech={"L1": "radiopharmaceuticals commercialisation telecommunications infrastructure"})
    props, _ = build_cut("short", pd)
    assert [p["text"] for p in props["captions"]] == ["radiopharmaceuticals commercialisation",
                                                      "telecommunications infrastructure"]


@pytest.mark.parametrize("cut, limit", [("short", 29), ("long", 66)])
def test_a_caption_word_wider_than_the_line_fails_the_cut(tmp_path, cut, limit):
    fits = project(tmp_path / "fits", [chapter("c1", scene("a1", "number_card", "L1"))], cut=cut, speech={"L1": "a" * limit})
    assert build_cut(cut, fits)[0]["captions"][0]["text"] == "a" * limit  # exactly a line wide is fine
    wide = project(tmp_path / "wide", [chapter("c1", scene("a1", "number_card", "L1"))], cut=cut, speech={"L1": "a" * (limit + 1)})
    with pytest.raises(ValueError, match=rf"{cut}: a caption word is longer than a caption line \({limit} characters\)"):
        build_cut(cut, wide)


def test_the_sidecar_never_needs_a_third_line(run):
    word = "abcdefghijklmnopqrstuvwxy"  # 25 characters: three of them are 77, inside 84, but wrap to three lines of 42
    words = [{"w": word, "s": i * 0.5, "e": i * 0.5 + 0.4} for i in range(3)]
    assert [c["text"] for c in cues(words)] == [f"{word} {word}", word]
    for cut in ("long", "short"):
        _, meta = build_cut(cut, run)
        assert all(len(wrap(c["text"], 42)) <= 2 and len(c["text"]) <= 84 for c in meta["cues"])
        assert all(len(block.split("\n")) <= 4 for block in srt(meta["cues"]).strip("\n").split("\n\n"))  # number, time, 2 lines


def test_pause_is_keyword_only_and_the_slots_before_it_are_the_page_limits():
    words = [{"w": "aa", "s": 0.0, "e": 0.2}, {"w": "bb", "s": 0.9, "e": 1.1}, {"w": "cc", "s": 1.2, "e": 1.4}]
    assert [p["text"] for p in word_pages(words)] == ["aa", "bb cc"]
    assert [p["text"] for p in word_pages(words, pause=1.0)] == ["aa bb cc"]
    assert [c["text"] for c in cues(words)] == ["aa", "bb cc"]
    assert [c["text"] for c in cues(words, pause=1.0)] == ["aa bb cc"]
    with pytest.raises(TypeError):
        word_pages(words, 4, 0, 2, 1.0)
    with pytest.raises(TypeError):
        cues(words, 84, 0, 2, 1.0)
    long_words = [{"w": w, "s": i * 0.3, "e": i * 0.3 + 0.25} for i, w in enumerate(
        "radiopharmaceuticals commercialisation telecommunications infrastructure".split())]
    assert [len(p["text"].split()) for p in word_pages(long_words, 4, 29, 2)] == [2, 2]       # (max_words, line_chars, max_lines)
    assert [c["text"] for c in cues(long_words, 84, 29, 1)] == [w["w"] for w in long_words]    # (max_chars, line_chars, max_lines)


# ---- SRT and VTT -----------------------------------------------------------------------------------------------------

def test_srt_and_vtt_are_exact_and_only_the_vtt_is_escaped():
    cs = [{"start": 0.0, "end": 1.5, "text": "Metals & Mining <5%"}, {"start": 3661.25, "end": 3662.0, "text": "Done."}]
    assert vtt(cs) == ("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nMetals &amp; Mining &lt;5%\n\n"
                       "01:01:01.250 --> 01:01:02.000\nDone.\n")
    assert srt(cs) == ("1\n00:00:00,000 --> 00:00:01,500\nMetals & Mining <5%\n\n"
                       "2\n01:01:01,250 --> 01:01:02,000\nDone.\n")
    # the lines break on the text as spoken (39 characters here), and are escaped after: only & and < change
    long = vtt([{"start": 1.0, "end": 2.0, "text": "AT&T said Tom & Jerry <b> were late for the meeting about it"}])
    assert long.splitlines()[3:5] == ["AT&amp;T said Tom &amp; Jerry &lt;b> were late for", "the meeting about it"]


# ---- chapters --------------------------------------------------------------------------------------------------------

def test_youtube_chapters_start_at_zero_and_merge_short_ones():
    chapters = [{"id": "a", "title": "Cold open", "start": 0.0}, {"id": "b", "title": "Tiny", "start": 12.0},
                {"id": "c", "title": "The result", "start": 15.0}, {"id": "d", "title": "Close", "start": 80.0}]
    text = youtube_chapters(chapters, 100.0)
    assert text.splitlines()[0] == "0:00 Cold open" and "Tiny" not in text and "1:20 Close" in text


def test_a_first_chapter_under_ten_seconds_swallows_the_next():
    assert youtube_chapters(chapters_at(0.0, 4.5, 30.0, 90.0), 200.0) == "0:00 A\n0:30 C\n1:30 D\n"
    assert youtube_chapters(chapters_at(0.0, 4.0, 8.0, 40.0, 80.0), 200.0) == "0:00 A\n0:40 D\n1:20 E\n"
    assert youtube_chapters(chapters_at(0.0, 10.0, 25.0, 60.0), 100.0) == "0:00 A\n0:10 B\n0:25 C\n1:00 D\n"  # ten seconds is long enough
    assert youtube_chapters(chapters_at(0.0, 9.5, 30.0, 60.0), 100.0) == "0:00 A\n0:30 C\n1:00 D\n"            # nine and a half is not


def test_a_chapter_of_ten_seconds_stands_and_one_of_nine_and_a_half_merges_back():
    assert youtube_chapters(chapters_at(0.0, 30.0, 39.5, 70.0), 100.0) == "0:00 A\n0:40 C\n1:10 D\n"
    assert youtube_chapters(chapters_at(0.0, 30.0, 40.0, 70.0), 100.0) == "0:00 A\n0:30 B\n0:40 C\n1:10 D\n"


def test_youtube_wants_three_chapters_or_none():
    assert youtube_chapters(chapters_at(0.0, 40.0), 90.0) == "" and youtube_chapters(chapters_at(0.0), 90.0) == "" and youtube_chapters([], 90.0) == ""
    assert youtube_chapters(chapters_at(0.0, 30.0, 60.0), 100.0) == "0:00 A\n0:30 B\n1:00 C\n"
    assert youtube_chapters(chapters_at(0.0, 5.0, 40.0), 50.0) == ""            # the short first one swallows B, leaving two
    assert youtube_chapters(chapters_at(0.0, 30.0, 60.0, 95.0), 100.0) == "0:00 A\n0:30 B\n1:00 C\n"  # a last one under ten merges back


def test_youtube_chapter_times_are_rounded_to_the_nearest_second():
    sample = chapters_at(0.0, 14.982, 50.128, 116.994, 276.322, titles="ABCDE")
    assert youtube_chapters(sample, 300.0) == "0:00 A\n0:15 B\n0:50 C\n1:57 D\n4:36 E\n"
    assert youtube_chapters(chapters_at(0.6, 20.5, 60.4), 100.0) == "0:00 A\n0:21 B\n1:00 C\n"  # 0:00 stays first; a half rounds up


def test_ffmeta_body_is_exact():
    chapters = [{"id": "a", "title": "Cold open", "start": 0.0}, {"id": "b", "title": "Quick", "start": 1.001},
                {"id": "c", "title": "Close", "start": 14.982}]
    assert ffmeta(chapters, 20.0) == (
        ";FFMETADATA1\n"
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1001\ntitle=Cold open\n"
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=1001\nEND=14982\ntitle=Quick\n"  # int(1.001 * 1000) is 1000: the mark is rounded
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=14982\nEND=20000\ntitle=Close\n")


def test_ffmeta_escapes_what_ffmpeg_reads_as_syntax():
    out = ffmeta([{"id": "a", "title": "Cash; capex = #1 \\ and\nmore", "start": 0.0}], 10.0)
    assert "title=Cash\\; capex \\= \\#1 \\\\ and\\\nmore\n" in out
    assert "title=Debt: 100% of it?\n" in ffmeta([{"id": "a", "title": "Debt: 100% of it?", "start": 0.0}], 10.0)


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs ffmpeg")
def test_ffmpeg_reads_the_chapter_titles_back_as_written(tmp_path):
    titles = ["Cold open", "Cash; capex", "Debt = risk? #1", "Back\\slash", "Two\nlines", "Close"]
    (tmp_path / "ch.ffmeta").write_text(ffmeta([{"id": f"c{i}", "title": t, "start": i * 3.0} for i, t in enumerate(titles)], 18.0),
                                        encoding="utf-8")
    silent, out = tmp_path / "a.m4a", tmp_path / "out.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "18", "-c:a", "aac", str(silent)],
                   check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(silent), "-i", str(tmp_path / "ch.ffmeta"), "-map", "0", "-map_metadata", "1",
                    "-map_chapters", "1", "-c", "copy", str(out)], check=True)
    got = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-of", "json", str(out)],
                                    capture_output=True, text=True, check=True).stdout)["chapters"]
    assert [c["tags"]["title"] for c in got] == titles
    assert [float(c["start_time"]) for c in got] == [0.0, 3.0, 6.0, 9.0, 12.0, 15.0]


# ---- axes ------------------------------------------------------------------------------------------------------------

def test_nice_axis():
    assert nice_axis(8.2, 15.07) == (0.0, 20.0, [0.0, 5.0, 10.0, 15.0, 20.0])


def test_an_axis_always_has_a_range():
    assert nice_axis(0, 0) == (0.0, 1.0, [0.0, 0.25, 0.5, 0.75, 1.0])
    assert nice_axis(5, 5) == (0.0, 6.0, [0.0, 2.0, 4.0, 6.0])  # a constant sits inside a zero-based axis, with room above
    lo, hi, ticks = nice_axis(-3, -3)
    assert lo <= -3 <= hi and hi > lo and len(ticks) >= 2


def test_a_chart_of_zeros_still_has_a_drawable_axis():
    pts = [[d, 0.0] for d in ("2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01")]
    d = {"short": {"series_1y": Value(pts, "series:pct", "2026-07-01", "ok", Source("GetStockData", {}, "2026-10-07T00:00:00+00:00")).to_json()}}
    raw = {"series": [{"label": "Short interest", "points": "{{short.series_1y|series}}", "unit": "pct", "axis": "left", "last": "0.00%"}]}
    props, _ = resolve_props(raw, d)
    axes = chart_axes(raw, props, d)
    assert (axes["left"]["min"], axes["left"]["max"]) == (0.0, 1.0)
    assert [t["label"] for t in axes["left"]["ticks"]] == ["0.0%", "0.25%", "0.5%", "0.75%", "1.0%"]


# ---- the files and the tool ------------------------------------------------------------------------------------------

def test_write_cut_files(run, tmp_path):
    pd = clone(run, tmp_path)
    write_cut("long", pd)
    assert json.loads((pd / "artifacts/timeline.long.json").read_text())["cut"] == "long"
    assert (pd / "renders/EXM_long.srt").exists() and (pd / "renders/EXM_long.vtt").read_text().startswith("WEBVTT")
    assert (pd / "renders/EXM_long_chapters.txt").read_text().startswith("0:00 ")
    assert (pd / "artifacts/chapters.long.ffmeta").read_text().startswith(";FFMETADATA1")
    thumb = json.loads((pd / "artifacts/thumb.json").read_text())
    assert thumb["ticker"] == "EXM" and thumb["logo"] == "logo"


def test_the_long_cuts_chapter_files_for_the_sample_are_exact(run, tmp_path):
    pd = clone(run, tmp_path)
    write_cut("long", pd)
    # the 9.4 s close merges back; times round to the nearest second
    assert (pd / "renders/EXM_long_chapters.txt").read_text() == (
        "0:00 Cold open\n0:15 The company\n0:50 The result\n1:57 The bears\n4:00 News and insiders\n")
    marks = [(0, 14982, "Cold open"), (14982, 50128, "The company"), (50128, 116994, "The result"),
             (116994, 240132, "The bears"), (240132, 276322, "News and insiders"), (276322, 285700, "Close")]
    assert (pd / "artifacts/chapters.long.ffmeta").read_text() == ";FFMETADATA1\n" + "".join(
        f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={a}\nEND={b}\ntitle={t}\n" for a, b, t in marks)
    assert "sits in Metals & Mining." in (pd / "renders/EXM_long.srt").read_text()  # the SRT keeps the ampersand,
    assert "sits in Metals &amp; Mining." in (pd / "renders/EXM_long.vtt").read_text()  # the VTT escapes it
    assert json.loads((pd / "artifacts/thumb.json").read_text()) == {
        "headline": ["Know where", "the bears are."], "kicker": "A field guide to the bears", "ticker": "EXM",
        "company": "Example Minerals", "logo": "logo",
        "images": {"logo": "shorted-runs/EXM-2026-10-07/logo.png", "plate_stock_chart": "shorted-runs/EXM-2026-10-07/plate_stock_chart.png"}}


def test_the_short_cut_writes_captions_but_no_chapters(run, tmp_path):
    pd = clone(run, tmp_path)
    meta = write_cut("short", pd)
    assert sorted(p.name for p in (pd / "renders").iterdir()) == ["EXM_short.srt", "EXM_short.vtt"]
    assert not (pd / "artifacts/chapters.long.ffmeta").exists() and NO_CHAPTERS not in meta["warnings"]


def two_chapter_run(run, tmp_path):
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    sb["chapters"] = [ch for ch in sb["chapters"] if ch["id"] in ("cold_open", "close")]
    save(pd, "storyboard.long.json", sb)
    return pd


def test_a_long_cut_with_fewer_than_three_chapters_writes_no_youtube_list(run, tmp_path):
    pd = two_chapter_run(run, tmp_path)
    (pd / "renders").mkdir()
    (pd / "renders/EXM_long_chapters.txt").write_text("0:00 A stale list\n", encoding="utf-8")  # an earlier run's
    meta = write_cut("long", pd)
    assert not (pd / "renders/EXM_long_chapters.txt").exists()
    assert NO_CHAPTERS in meta["warnings"] and NO_CHAPTERS in load(pd, "timeline.long.meta.json")["warnings"]
    assert (pd / "artifacts/chapters.long.ffmeta").read_text().count("[CHAPTER]") == 2  # the MP4's own chapters are unaffected


def test_the_tool_reports_each_cut_and_whether_it_is_in_bounds(run, tmp_path):
    pd = clone(run, tmp_path)
    res = ShortedTimeline().execute({"project_dir": pd})  # a Path works as well as a string
    assert res.success and res.error is None
    assert res.data["long"]["duration"] == 285.7 and res.data["short"]["duration"] == 77.47
    assert res.data["long"]["in_bounds"] is True and res.data["short"]["in_bounds"] is True
    assert "s035nu: holds 64.4 s (over 14); split it into two scenes" in res.data["long"]["warnings"]
    assert [Path(a).name for a in res.artifacts] == ["timeline.long.json", "timeline.short.json"]
    assert all(Path(a).exists() for a in res.artifacts)
    assert NO_CHAPTERS not in res.data["long"]["warnings"]


@pytest.mark.parametrize("inputs, why", [({}, "project_dir is required"), ({"project_dir": ""}, "project_dir is required"),
                                         ({"project_dir": 7}, "project_dir is required")])
def test_the_tool_needs_a_project_folder(inputs, why):
    res = ShortedTimeline().execute(inputs)
    assert not res.success and res.error == why and res.artifacts == []


def test_the_tool_refuses_a_folder_that_does_not_exist_or_has_no_storyboard(tmp_path):
    res = ShortedTimeline().execute({"project_dir": str(tmp_path / "nowhere")})
    assert not res.success and "does not exist" in res.error and str(tmp_path / "nowhere") in res.error
    assert not (tmp_path / "nowhere").exists()
    (tmp_path / "empty" / "artifacts").mkdir(parents=True)
    res = ShortedTimeline().execute({"project_dir": str(tmp_path / "empty")})
    assert not res.success and res.error == ("no storyboard.long.json or storyboard.short.json in artifacts/; "
                                             "run the storyboard stage first")
    assert not (tmp_path / "empty" / "renders").exists() and res.data == {} and res.artifacts == []


def damage_narration_line(pd):
    nar = load(pd, "narration.json")
    nar["long"].pop("L012")
    save(pd, "narration.json", nar)


def damage_missing_cut(pd):
    nar = load(pd, "narration.json")
    nar.pop("short")
    save(pd, "narration.json", nar)


def damage_no_narration(pd):
    (pd / "artifacts/narration.json").unlink()


def damage_no_dossier(pd):
    (pd / "artifacts/dossier.json").unlink()


def damage_torn_json(pd):
    (pd / "artifacts/narration.json").write_text('{"long": {"L000": {"duration": ', encoding="utf-8")


def damage_not_an_object(pd):
    (pd / "artifacts/narration.json").write_text("[1, 2]", encoding="utf-8")


def damage_entry_without_duration(pd):
    nar = load(pd, "narration.json")
    nar["long"]["L000"].pop("duration")
    save(pd, "narration.json", nar)


def damage_wide_word(pd):
    nar = load(pd, "narration.json")
    nar["short"]["L000"]["words"][1]["w"] = "x" * 30
    save(pd, "narration.json", nar)


def damage_renders_is_a_file(pd):
    (pd / "renders").write_text("not a folder", encoding="utf-8")


@pytest.mark.parametrize("damage, cut, why", [
    (damage_narration_line, "long", "no narration for long line L012; run the voice stage"),
    (damage_missing_cut, "short", "no narration for short line L000; run the voice stage"),
    (damage_no_narration, "long", "no artifacts/narration.json; run the voice stage first"),
    (damage_no_dossier, "long", "no artifacts/dossier.json; run the dossier stage first"),
    (damage_torn_json, "long", "artifacts/narration.json is not valid JSON"),
    (damage_not_an_object, "long", "artifacts/narration.json is not a JSON object"),
    (damage_entry_without_duration, "long", "an artifact lacks the entry 'duration'; re-run the stage that wrote it"),
    (damage_wide_word, "short", "short: a caption word is longer than a caption line (29 characters)"),
    (damage_renders_is_a_file, "long", "renders"),
])
def test_the_tool_turns_every_failure_into_a_result(run, tmp_path, damage, cut, why):
    pd = clone(run, tmp_path)
    damage(pd)
    res = ShortedTimeline().execute({"project_dir": str(pd)})  # never raises
    assert res.success is False and isinstance(res.error, str), res
    assert res.error.startswith(f"{cut} timeline failed: ") and why in res.error, res.error


def test_nothing_is_written_when_the_thumbnail_cannot_be_built(run, tmp_path):
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    sb["thumbnail"] = {"headline": ["{{nope.field|text}}"], "kicker": "k"}  # the timeline builds fine; the thumbnail does not
    save(pd, "storyboard.long.json", sb)
    res = ShortedTimeline().execute({"project_dir": str(pd)})
    assert not res.success and "nope.field" in res.error
    assert not (pd / "artifacts/timeline.long.json").exists() and not (pd / "renders").exists()  # built first, written after


# ---- text encoding ---------------------------------------------------------------------------------------------------

def test_every_text_file_is_read_and_written_as_utf8(run, tmp_path, monkeypatch):
    pd = clone(run, tmp_path)
    seen = []
    real_read, real_write = Path.read_text, Path.write_text

    def read(self, *a, **kw):
        seen.append(("read", self.name, kw.get("encoding")))
        return real_read(self, *a, **kw)

    def write(self, data, *a, **kw):
        seen.append(("write", self.name, kw.get("encoding")))
        return real_write(self, data, *a, **kw)

    monkeypatch.setattr(Path, "read_text", read)
    monkeypatch.setattr(Path, "write_text", write)
    write_cut("long", pd)
    assert sum(s[0] == "write" for s in seen) == 7 and sum(s[0] == "read" for s in seen) >= 4  # timeline, meta, srt, vtt, chapters, ffmeta, thumb
    assert [s for s in seen if s[2] != "utf-8"] == []


def test_the_files_survive_a_locale_that_is_not_utf8(run, tmp_path):
    pd = clone(run, tmp_path)
    sb = load(pd, "storyboard.long.json")
    sb["chapters"][1]["title"] = "Café & Crème – the company"
    save(pd, "storyboard.long.json", sb)  # written as UTF-8 with the characters as they are
    nar = load(pd, "narration.json")
    nar["long"]["L005"]["words"][0]["w"] = "Café"
    save(pd, "narration.json", nar)
    env = {**os.environ, "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C", "LANG": "C"}
    done = subprocess.run([sys.executable, "-c", "import sys; from tools.shorted.timeline import write_cut; write_cut('long', sys.argv[1])",
                           str(pd)], cwd=STUDIO, env=env, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr[-600:]
    for name in ("renders/EXM_long_chapters.txt", "artifacts/chapters.long.ffmeta"):
        assert "Café & Crème – the company" in (pd / name).read_text(encoding="utf-8")
    assert "Café" in (pd / "renders/EXM_long.srt").read_text(encoding="utf-8")
    assert "Café" in (pd / "renders/EXM_long.vtt").read_text(encoding="utf-8")
```

- [ ] **Step 3: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_timeline.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.timeline'`.

- [ ] **Step 4: Implement `timeline.py`**

```python
"""Timeline: scene timings from the narration, resolved props, the ASIC caveat, captions, SRT/VTT,
YouTube chapters, and the Remotion props for each cut (artifacts/timeline.<cut>.json)."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolTier
from tools.shorted.bindings import get_path, placeholders, resolve_props
from tools.shorted.formatters import axis_label, month_label
from tools.shorted.gates import TEXT_BUDGETS, month_ticks
from tools.shorted.lint import CAVEAT, CAVEAT_PATHS

FPS = 30
SIZE = {"long": (1920, 1080), "short": (1080, 1920)}
BOUNDS = {"long": (270.0, 330.0), "short": (60.0, 90.0)}
LEAD, GAP, TAIL = 0.25, 0.3, 0.5
DEFAULT_MIN = {"opening": 4.5, "chapter": 2.5, "end_card": 6.0}
MAX_HOLD = 14.0
SHORT_DATA = CAVEAT_PATHS  # scenes binding these carry the ASIC caveat; the lint warns about the rest
SIDECAR_LINE = 42  # characters in a line of the SRT/VTT sidecar, which holds two
YT_MIN_CHAPTER, YT_MIN_CHAPTERS = 10, 3  # YouTube ignores a chapter list unless each chapter lasts 10 s and there are three
NO_CHAPTERS = "fewer than three chapters of 10 s or more; YouTube chapters not written"


def _load(path: Path, stage: str) -> dict:
    """An artefact as a dict, or a ValueError saying which stage makes it (the tool reports it, so it must say what to do)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"no artifacts/{path.name}; run the {stage} stage first") from None
    except ValueError as err:  # a JSONDecodeError, or a UnicodeDecodeError from a file that is not UTF-8
        raise ValueError(f"artifacts/{path.name} is not valid JSON: {err}") from None
    if not isinstance(data, dict):
        raise ValueError(f"artifacts/{path.name} is not a JSON object")
    return data


def _strings(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, list):
        return [s for x in obj for s in _strings(x)]
    if isinstance(obj, dict):
        return [s for x in obj.values() for s in _strings(x)]
    return []


def binds_short_data(scene: dict) -> bool:
    texts = _strings(scene.get("props", {})) + [ln["text"] for ln in scene.get("lines", [])]
    return any(path.startswith(SHORT_DATA) for s in texts for path, _ in placeholders(s))


def nice_axis(lo_v: float, hi_v: float, n: int = 4) -> tuple[float, float, list[float]]:
    """A zero-based axis (it widens to include 0) with about n intervals of 1, 2, 2.5 or 5 x 10^k. It always has a range:
    when every value is 0 it opens to n steps above zero (0 to 1 for n = 4), as the composer refuses max <= min."""
    lo_v, hi_v = min(0.0, lo_v), max(0.0, hi_v)
    raw = ((hi_v - lo_v) or 1.0) / n
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw - 1e-12)
    lo = step * math.floor(lo_v / step)
    hi = step * math.ceil(hi_v * 1.04 / step)
    if hi <= lo:  # nothing above or below zero
        hi = lo + step * n
    return float(lo), float(hi), [round(lo + i * step, 10) for i in range(int(round((hi - lo) / step)) + 1)]


def chart_axes(raw_props: dict, props: dict, dossier: dict) -> dict:
    axes, times = {}, []
    for raw, series in zip(raw_props["series"], props["series"]):
        values = [v for _, v in series["points"]]
        times += [d for d, _ in series["points"]]
        currency = get_path(dossier, placeholders(raw["points"])[0][0]).currency
        lo, hi, ticks = nice_axis(min(values), max(values))
        axes[series.get("axis", "left")] = {"min": lo, "max": hi, "ticks": [
            {"v": v, "label": axis_label(v, series["unit"], currency)} for v in ticks]}
    axes["x"] = [{"t": t, "label": month_label(t)} for t in month_ticks(min(times), max(times))]  # the gate counts these
    return axes


def fits_lines(text: str, line_chars: int, max_lines: int = 2) -> bool:
    """Whether text wraps into max_lines lines of line_chars characters, as the monospaced burned-in captions do."""
    lines = split_lines(text, line_chars)
    return len(lines) <= max_lines and all(len(ln) <= line_chars for ln in lines)


def word_pages(words: list[dict], max_words: int = 4, line_chars: int = 0, max_lines: int = 2, *,
               pause: float = 0.35) -> list[dict]:
    """Short-cut captions: pages of up to four words, broken at sentence ends and pauses, and (with line_chars) before
    a word that would push the page past max_lines lines of line_chars characters. pause is keyword-only: given
    positionally it was once mistaken for line_chars, which silently turned the fitting off."""
    groups, cur = [], []
    for w in words:
        if cur and (len(cur) >= max_words or w["s"] - cur[-1]["e"] > pause or cur[-1]["w"].endswith((".", "!", "?"))
                    or (line_chars and not fits_lines(" ".join(x["w"] for x in cur + [w]), line_chars, max_lines))):
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    pages = []
    for i, g in enumerate(groups):
        end = g[-1]["e"] + 0.25
        if i + 1 < len(groups):
            end = min(end, groups[i + 1][0]["s"])
        pages.append({"start": round(g[0]["s"], 3), "end": round(max(end, g[0]["s"] + 0.3), 3),
                      "text": " ".join(w["w"] for w in g), "words": [{"w": w["w"], "s": w["s"], "e": w["e"]} for w in g]})
    return pages


def cues(words: list[dict], max_chars: int = 84, line_chars: int = 0, max_lines: int = 2, *, pause: float = 0.5) -> list[dict]:
    """Sidecar captions: up to two lines of 42 characters (84 in all), broken at sentences and pauses, and before a word
    that would push the cue past max_lines lines, so srt() and vtt() never wrap one onto a third. With line_chars (the
    long cut's burned-in captions) the line is that wide instead. pause is keyword-only, as in word_pages."""
    fit = line_chars or SIDECAR_LINE
    groups, cur = [], []
    for w in words:
        text = " ".join(x["w"] for x in cur + [w])
        if cur and (len(text) > max_chars or w["s"] - cur[-1]["e"] > pause or cur[-1]["w"].endswith((".", "!", "?"))
                    or not fits_lines(text, fit, max_lines)):
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    out = []
    for i, g in enumerate(groups):
        start = g[0]["s"]
        end = max(g[-1]["e"] + 0.2, start + 1.0)
        if i + 1 < len(groups):
            end = min(end, groups[i + 1][0]["s"])
        out.append({"start": round(start, 3), "end": round(end, 3), "text": " ".join(w["w"] for w in g)})
    return out


def split_lines(text: str, width: int = 42) -> list[str]:
    lines, line = [], ""
    for w in text.split():
        if line and len(line) + 1 + len(w) > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    return lines + ([line] if line else [])


def _ts(t: float, sep: str) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}{sep}{ms % 1000:03d}"


def srt(cs: list[dict]) -> str:
    return "\n".join(f"{i}\n{_ts(c['start'], ',')} --> {_ts(c['end'], ',')}\n" + "\n".join(split_lines(c["text"])) + "\n"
                     for i, c in enumerate(cs, 1))


def _vtt_text(line: str) -> str:
    """Cue text is markup in WebVTT: & and < must be escaped (after the lines are broken, on the text as spoken)."""
    return line.replace("&", "&amp;").replace("<", "&lt;")


def vtt(cs: list[dict]) -> str:
    return "WEBVTT\n\n" + "\n".join(f"{_ts(c['start'], '.')} --> {_ts(c['end'], '.')}\n"
                                    + "\n".join(_vtt_text(ln) for ln in split_lines(c["text"])) + "\n" for c in cs)


def youtube_chapters(chapters: list[dict], duration: float) -> str:
    """The list YouTube accepts, or "" when there is none to give. Its rules, or it ignores the whole list: the first
    chapter starts at 0:00, each lasts at least 10 s and there are at least three. A short chapter merges into the one
    before it; a short first chapter swallows the next. Times round to the nearest second (halves up)."""
    kept: list[dict] = []
    for i, ch in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration
        if kept and end - ch["start"] < YT_MIN_CHAPTER:
            continue
        kept.append(ch)
    while len(kept) > 1 and kept[1]["start"] - kept[0]["start"] < YT_MIN_CHAPTER:
        del kept[1]
    if len(kept) < YT_MIN_CHAPTERS:
        return ""
    marks = [0] + [math.floor(c["start"] + 0.5) for c in kept[1:]]
    return "\n".join(f"{m // 60}:{m % 60:02d} {c['title']}" for m, c in zip(marks, kept)) + "\n"


def _ffmeta_value(text: str) -> str:
    """ffmpeg's metadata syntax: \\, =, ;, # and a newline in a value are escaped with a backslash."""
    return re.sub(r"([\\=;#\n])", r"\\\1", text)


def ffmeta(chapters: list[dict], duration: float) -> str:
    out = [";FFMETADATA1"]
    for i, ch in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration
        out += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(ch['start'] * 1000)}", f"END={round(end * 1000)}",
                f"title={_ffmeta_value(ch['title'])}"]  # round, not int: int(1.001 * 1000) is 1000
    return "\n".join(out) + "\n"


def _keep_scenes(cut: str, sb: dict, images: dict, warnings: list[str]) -> list[tuple[dict, dict]]:
    """Every (chapter, scene) to show, in order. A plate whose image was not captured is dropped and its lines, which
    are never lost, go to a scene of its own chapter: the nearest one before it that is not the chapter card, else the
    nearest after it, else the card. A chapter with nowhere to put them is an error."""
    flat: list[tuple[dict, dict]] = []
    for ch in sb["chapters"]:
        scenes = ch["scenes"]
        dropped = {i for i, sc in enumerate(scenes) if sc["type"] == "plate" and sc.get("props", {}).get("image") not in images}
        first: dict[int, list] = {}  # lines a kept scene speaks before its own
        last: dict[int, list] = {}  # and after them
        for i in sorted(dropped):
            sc = scenes[i]
            key, lines = sc.get("props", {}).get("image"), sc.get("lines", [])
            if not lines:
                warnings.append(f"{sc['id']}: plate {key} was not captured; scene dropped")
                continue
            kept = [j for j in range(len(scenes)) if j not in dropped]
            body = [j for j in kept if scenes[j]["type"] != "chapter"]
            before, after = [j for j in body if j < i], [j for j in body if j > i]
            cards = [j for j in kept if scenes[j]["type"] == "chapter"]
            if before:
                to, where = before[-1], "the scene before it"
            elif after:
                to, where = after[0], "the scene after it"
            elif cards:
                to, where = cards[0], "the chapter card"
            else:
                raise ValueError(f"{cut}: plate {key} ({sc['id']}) was not captured and chapter {ch['id']} has no other scene "
                                 f"to take its lines ({', '.join(ln['id'] for ln in lines)}); capture the plate or add a scene")
            (last if to < i else first).setdefault(to, []).extend(lines)
            warnings.append(f"{sc['id']}: plate {key} was not captured; scene dropped, its {len(lines)} "
                            f"line{'s' if len(lines) != 1 else ''} went to {where} ({scenes[to]['id']})")
        for i, sc in enumerate(scenes):
            if i in dropped:
                continue
            if i in first or i in last:
                sc = {**sc, "lines": first.get(i, []) + sc.get("lines", []) + last.get(i, [])}
            flat.append((ch, sc))
    return flat


def build_cut(cut: str, project_dir: Path) -> tuple[dict, dict]:
    pd = Path(project_dir)
    art = pd / "artifacts"
    sb = _load(art / f"storyboard.{cut}.json", "storyboard")
    dossier = _load(art / "dossier.json", "dossier")
    narration = _load(art / "narration.json", "voice").get(cut, {})  # a cut that is not there has no lines yet
    images = _load(art / "images.json", "assets") if (art / "images.json").exists() else {}
    warnings: list[str] = []
    flat = _keep_scenes(cut, sb, images, warnings)
    t = 0.0
    scenes, lines = [], []
    for i, (ch, sc) in enumerate(flat):
        cursor = t + LEAD
        for ln in sc.get("lines", []):
            nar = narration.get(ln["id"])
            if nar is None:
                raise ValueError(f"no narration for {cut} line {ln['id']}; run the voice stage")
            lines.append({"id": ln["id"], "scene": sc["id"], "chapter": ch["id"], "start": round(cursor, 3),
                          "end": round(cursor + nar["duration"], 3), "file": nar["file"], "words": nar["words"]})
            cursor += nar["duration"] + GAP
        spoken = cursor - GAP + TAIL - t if sc.get("lines") else 0.0
        dur = max(spoken, sc.get("min_seconds") or 0.0, DEFAULT_MIN.get(sc["type"], 3.0))
        if dur > MAX_HOLD:
            warnings.append(f"{sc['id']}: holds {dur:.1f} s (over {MAX_HOLD:.0f}); split it into two scenes")
        raw = sc.get("props", {})
        props, _ = resolve_props(raw, dossier)
        if sc["type"] == "line_chart":
            props["axes"] = chart_axes(raw, props, dossier)
        if sc["type"] == "company" and props.get("logo") and props["logo"] not in images:
            warnings.append(f"{sc['id']}: logo not staged; shown without it")
            props.pop("logo")
        end = round(t + dur, 3)
        scenes.append({"id": sc["id"], "type": sc["type"], "chapter": ch["id"], "no": ch.get("no", 0),
                       "start": round(t, 3), "end": end, "transition": "cut" if i == 0 else sc.get("transition", "page"),
                       "super": CAVEAT if binds_short_data(sc) else None, "props": props})
        t = end
    words = [{"w": w["w"], "s": round(ln["start"] + w["s"], 3), "e": round(ln["start"] + w["e"], 3)}
             for ln in lines for w in ln["words"]]
    sidecar = cues(words)
    # the burned-in pages hold what the overlay draws whole: never a word lost to a wrap (the long cut gets one line)
    line, n = TEXT_BUDGETS[cut]["caption_line"], TEXT_BUDGETS[cut]["caption_lines"]
    burned = (word_pages(words, line_chars=line, max_lines=n) if cut == "short"
              else [{**c, "words": []} for c in cues(words, line_chars=line, max_lines=n)])
    wide = [p["text"] for p in burned if not fits_lines(p["text"], line, n)]
    if wide:
        raise ValueError(f"{cut}: a caption word is longer than a caption line ({line} characters): {wide[0]!r}")
    W, H = SIZE[cut]
    props = {"cut": cut, "width": W, "height": H, "fps": FPS, "durationInFrames": math.ceil(t * FPS),
             "ticker": dossier["ticker"], "images": {k: v["src"] for k, v in images.items()}, "scenes": scenes,
             "captions": burned,
             "showCaptions": True, "wordCaptions": cut == "short"}
    titles = {ch["id"]: ch.get("title", ch["id"]) for ch in sb["chapters"]}
    chapters = []
    for sc in scenes:
        if not chapters or chapters[-1]["id"] != sc["chapter"]:
            chapters.append({"id": sc["chapter"], "title": titles[sc["chapter"]], "start": sc["start"]})
    lo, hi = BOUNDS[cut]
    if not lo <= t <= hi:
        warnings.append(f"{cut} runs {t:.1f} s; target {lo:.0f}-{hi:.0f} s")
    meta = {"cut": cut, "duration": round(t, 3), "bounds": [lo, hi], "scenes": [{"id": s["id"], "start": s["start"], "end": s["end"]} for s in scenes],
            "lines": lines, "cues": sidecar, "chapters": chapters, "warnings": warnings}
    return props, meta


def thumb_props(project_dir: Path) -> dict:
    art = Path(project_dir) / "artifacts"
    dossier = _load(art / "dossier.json", "dossier")
    images = _load(art / "images.json", "assets") if (art / "images.json").exists() else {}
    for cut in ("long", "short"):
        if (art / f"storyboard.{cut}.json").exists():
            thumb, _ = resolve_props(_load(art / f"storyboard.{cut}.json", "storyboard").get("thumbnail", {}), dossier)
            break
    return {"headline": thumb.get("headline") or [dossier["ticker"]], "kicker": thumb.get("kicker") or "A field guide to the bears",
            "ticker": dossier["ticker"], "company": dossier["company"]["name"]["value"],
            "logo": "logo" if "logo" in images else None, "images": {k: v["src"] for k, v in images.items()}}


def write_cut(cut: str, project_dir: Path) -> dict:
    pd = Path(project_dir)
    props, meta = build_cut(cut, pd)
    t = props["ticker"]
    listing = youtube_chapters(meta["chapters"], meta["duration"]) if cut == "long" else ""
    if cut == "long" and not listing:
        meta["warnings"].append(NO_CHAPTERS)  # before the meta is written
    thumb = thumb_props(pd)  # everything is built before anything is written
    art, renders = pd / "artifacts", pd / "renders"
    renders.mkdir(exist_ok=True)
    art.joinpath(f"timeline.{cut}.json").write_text(json.dumps(props), encoding="utf-8")
    art.joinpath(f"timeline.{cut}.meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    renders.joinpath(f"{t}_{cut}.srt").write_text(srt(meta["cues"]), encoding="utf-8")
    renders.joinpath(f"{t}_{cut}.vtt").write_text(vtt(meta["cues"]), encoding="utf-8")
    if cut == "long":
        if listing:
            renders.joinpath(f"{t}_long_chapters.txt").write_text(listing, encoding="utf-8")
        else:  # an earlier run's list must not outlive a cut that has none
            renders.joinpath(f"{t}_long_chapters.txt").unlink(missing_ok=True)
        art.joinpath("chapters.long.ffmeta").write_text(ffmeta(meta["chapters"], meta["duration"]), encoding="utf-8")
    art.joinpath("thumb.json").write_text(json.dumps(thumb), encoding="utf-8")
    return meta


class ShortedTimeline(BaseTool):
    name = "shorted_timeline"
    version = "1.0.0"
    tier = ToolTier.CORE
    capability = "timeline"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        project_dir = inputs.get("project_dir")
        if not project_dir or not isinstance(project_dir, (str, Path)):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(project_dir)
        if not pd.is_dir():
            return ToolResult(success=False, error=f"project folder {pd} does not exist")
        cuts = [c for c in ("long", "short") if (pd / "artifacts" / f"storyboard.{c}.json").exists()]
        if not cuts:
            return ToolResult(success=False, error="no storyboard.long.json or storyboard.short.json in artifacts/; "
                                                   "run the storyboard stage first")
        metas = {}
        for cut in cuts:
            try:
                metas[cut] = write_cut(cut, pd)
            except (OSError, KeyError, ValueError) as err:  # a JSONDecodeError is a ValueError
                why = f"an artifact lacks the entry {err}; re-run the stage that wrote it" if isinstance(err, KeyError) else str(err)
                return ToolResult(success=False, error=f"{cut} timeline failed: {why}")
        return ToolResult(success=True, data={cut: {"duration": m["duration"], "in_bounds": BOUNDS[cut][0] <= m["duration"] <= BOUNDS[cut][1],
                                                    "warnings": m["warnings"]} for cut, m in metas.items()},
                          artifacts=[str(pd / "artifacts" / f"timeline.{c}.json") for c in cuts])
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_timeline.py -q`
Expected: PASS (71 tests). The chart cases in `tests/shorted/test_scene_fit.py` now run as well: `.venv/bin/python -m pytest tests/shorted/test_scene_fit.py -q && .venv/bin/python -m pytest tests/shorted/test_scene_fit.py -q -m slow`, 5 passed and 29 skipped, then PASS (29 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/timeline.py tests/shorted/sample.py tests/shorted/test_timeline.py
git commit -m "feat(shorted): timeline, captions, SRT/VTT, YouTube chapters and Remotion props"
```

### Task 21: Score and mix

**Files:**
- Create: `tools/shorted/score.py`, `tools/shorted/mixdown.py`
- Test: `tests/shorted/test_score_mix.py`

**Interfaces:**
- Consumes:
  - `timeline.<cut>.json` and `.meta.json` (Task 20);
  - `ensure_stems`, `BAR` (Task 11); `resolve("sfx", sfx=...)` (Task 10);
  - the narration line files.
- Produces:
  - `CHAPTER_BEDS`, `chapter_segments(scenes)`.
  - `build_score(scenes, duration, stems, sfx) -> (music, sfx, cues)`: arrays are 48 kHz stereo float64.
  - `score_cut(project_dir, cut, stems=None, sfx=None)`, which writes `assets/music/<cut>/music.wav`, `assets/music/<cut>/sfx.wav` (32-bit float, so nothing over full scale is clipped) and `artifacts/score.<cut>.json` (cues sorted by time, each at its real placement).
  - Page flips follow the fold (`TURN` 0.45 s, inOutCubic): a sample whose loudest 10 ms falls after 0.4 s (a landing thud) lands it at the scene start + 0.45 s, any other lands its energy centroid at + 0.225 s; every flip is scaled so its loudest 10 ms is `FLIP_EVENT_DBFS` (−26.61, stereo mean square).
  - A stem or line at a rate other than 48 kHz raises `ValueError` naming the file.
  - `mixdown(project_dir, cut) -> report`, which writes `assets/audio/mix.<cut>.wav` (24-bit stereo) and `artifacts/mix.<cut>.json`: `{integrated_lufs, true_peak_dbtp, max_limiter_reduction_db, vo_lufs_during_speech, music_lufs_during_speech, music_lufs_without_speech, duck_depth_db, speech_to_music_db, duration}`. The limiter's ceiling is `CEILING_DBTP` −1.6 by a 4x true-peak meter, so the spec's −1.5 dBTP holds at 8x. `duck_depth_db` (un-ducked against ducked music under speech) is always numeric when there is more than 1 s of speech; `music_lufs_without_speech` is null when the voice is never silent for about 1.4 s (a cut without chapter cards).
  - Tool `shorted_score` runs both for each cut. It fails if a mix lands outside −14 ± 1 LUFS or above −1.4 dBTP. An invalid `project_dir`, no timeline ("run the timeline stage first"), a missing kit and any `RuntimeError`, `OSError`, `KeyError` or `ValueError` return `success=False` with the message.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_score_mix.py`:

```python
import json
import re
import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf
from scipy import signal

from tools.shorted import mixdown as mix
from tools.shorted import score
from tools.shorted.mixdown import SR, mixdown, true_peak_db
from tools.shorted.score import CHAPTER_BEDS, build_score, chapter_segments, score_cut

SCENES = [
    {"id": "a", "type": "opening", "chapter": "cold_open", "start": 0.0, "end": 6.0, "transition": "cut"},
    {"id": "b", "type": "chapter", "chapter": "result", "start": 6.0, "end": 8.5, "transition": "page"},
    {"id": "c", "type": "number_card", "chapter": "result", "start": 8.5, "end": 20.0, "transition": "page"},
    {"id": "d", "type": "line_chart", "chapter": "bears", "start": 20.0, "end": 32.0, "transition": "page"},
    {"id": "e", "type": "end_card", "chapter": "close", "start": 32.0, "end": 38.0, "transition": "page"},
]


def fake_stems(tmp_path):
    out = {}
    rng = np.random.default_rng(1)
    for name, bars in {"sting_open": 2, "card_sting": 1, "bed_groove": 8, "bed_calm": 8, "bed_tension": 8, "button_end": 2}.items():
        n = int((bars * 2.5 + 2.5) * SR)
        y = 0.05 * rng.standard_normal((n, 2))
        p = tmp_path / f"{name}.flac"
        sf.write(p, y.astype(np.float32), SR, subtype="PCM_24")
        p.with_suffix(".json").write_text(json.dumps({"bars": bars, "lufs": -20.0, "target_lufs": -20.0,
                                                      "loop_seconds": bars * 2.5 if name.startswith("bed") else None}))
        out[name] = p
    return out


def fake_sfx(tmp_path):
    p = tmp_path / "flip.wav"
    sf.write(p, (0.3 * np.hanning(4800)).astype(np.float32), SR)
    return {"page-flip": [p], "book-open": [p], "book-close": [p]}


def test_beds_follow_the_chapters():
    segs = chapter_segments(SCENES)
    assert [s["bed"] for s in segs] == [CHAPTER_BEDS["cold_open"], CHAPTER_BEDS["result"], CHAPTER_BEDS["bears"], CHAPTER_BEDS["close"]]
    assert segs[1]["start"] == 6.0 and segs[1]["end"] == 20.0


def test_score_lengths_and_cues(tmp_path):
    music, sfx, cues = build_score(SCENES, 38.0, fake_stems(tmp_path), fake_sfx(tmp_path))
    assert music.shape == sfx.shape == (38 * SR, 2)
    kinds = [c["name"] for c in cues]
    assert kinds.count("card_sting") == 1 and "button_end" in kinds and kinds.count("page-flip") == 4
    # the flip for the page turning in at 8.5 s now plays inside that turn (the brief looked 100 ms either side of the scene start)
    assert np.abs(sfx[int(8.5 * SR): int((8.5 + score.TURN) * SR)]).max() > 0.01


def write_cut(pd, cut, duration, starts, rng):
    """One cut of a fixture project: five-second noise lines at `starts`, a noise music bus, a silent effects bus."""
    (pd / "assets/music" / cut).mkdir(parents=True)
    lines = []
    for i, start in enumerate(starts):
        t = np.arange(int(5.0 * SR)) / SR
        voice = 0.3 * rng.standard_normal(len(t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) ** 2
        f = f"assets/audio/lines/{cut[0]}{i}.wav"
        sf.write(pd / f, voice.astype(np.float32), SR)
        lines.append({"id": f"L{i}", "start": start, "end": start + 5.0, "file": f})
    (pd / f"artifacts/timeline.{cut}.meta.json").write_text(json.dumps({"duration": duration, "lines": lines}))
    music = 0.1 * rng.standard_normal((int(duration * SR), 2))
    sf.write(pd / f"assets/music/{cut}/music.wav", music.astype(np.float32), SR)
    sf.write(pd / f"assets/music/{cut}/sfx.wav", np.zeros((int(duration * SR), 2), np.float32), SR)


def write_project(tmp_path, duration=24.0, short=False):
    """The long cut speaks at 1-6, 9-14 and 16-21 s, so it has real silences. With short=True there is also a short cut whose
    voice never stops for more than the timeline's 0.3 s GAP, like a cut without chapter cards."""
    pd = tmp_path / "EXM-2026-10-07"
    for sub in ("artifacts", "assets/audio/lines"):
        (pd / sub).mkdir(parents=True)
    rng = np.random.default_rng(2)
    write_cut(pd, "long", duration, (1.0, 9.0, 16.0), rng)
    if short:
        write_cut(pd, "short", 22.0, (0.5, 5.8, 11.1, 16.4), rng)
    return pd


def test_mix_hits_loudness_and_peak(tmp_path):
    rep = mixdown(write_project(tmp_path), "long")
    assert rep["integrated_lufs"] == pytest.approx(-14.0, abs=0.5)
    assert rep["true_peak_dbtp"] <= -1.4
    y, sr = sf.read(tmp_path / "EXM-2026-10-07/assets/audio/mix.long.wav")
    assert sr == SR and len(y) == 24 * SR and true_peak_db(y) <= -1.4


def test_music_ducks_under_the_voice(tmp_path):
    pd = write_project(tmp_path, short=True)
    long, short = mixdown(pd, "long"), mixdown(pd, "short")
    assert long["music_lufs_during_speech"] < long["music_lufs_without_speech"] - 4  # the brief's check, where the voice does stop
    # the depth is measured on every cut, under the same speech, so it reads where there is no quiet gap to compare with:
    # the short cut's voice is never silent for 1.4 s, so its music_lufs_without_speech is null
    assert short["music_lufs_without_speech"] is None
    for rep in (long, short):
        assert 4 <= rep["duck_depth_db"] <= 8  # the bands are ducked by 4, 8 and 5 dB


def test_zero_ducking_measures_zero_depth(tmp_path, monkeypatch):
    for band in ("low", "mid", "high"):
        monkeypatch.setitem(mix.DUCK, band, 0.0)
    assert mixdown(write_project(tmp_path), "long")["duck_depth_db"] == pytest.approx(0.0, abs=0.01)


def test_duck_depth_is_null_only_without_a_second_of_speech(tmp_path):
    pd = project(tmp_path, 6.0, [(1.0, 0.3 * np.random.default_rng(8).standard_normal(int(0.2 * SR)))], music=noise_music(6.0))
    rep = mix.mixdown(pd, "long")
    assert rep["duck_depth_db"] is None and rep["vo_lufs_during_speech"] is None and "speech_to_music_db" not in rep


def test_score_cut_writes_files(tmp_path):
    pd = tmp_path / "EXM-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    (pd / "artifacts/timeline.long.json").write_text(json.dumps({"scenes": SCENES}))
    (pd / "artifacts/timeline.long.meta.json").write_text(json.dumps({"duration": 38.0}))
    score_cut(pd, "long", stems=fake_stems(tmp_path), sfx=fake_sfx(tmp_path))
    assert sf.info(pd / "assets/music/long/music.wav").duration == pytest.approx(38.0)
    assert json.loads((pd / "artifacts/score.long.json").read_text())["cues"]
    for bus in ("music", "sfx"):
        assert sf.info(pd / f"assets/music/long/{bus}.wav").subtype == "FLOAT"  # 16-bit would clip whatever sums past full scale


# ------------------------------------------------------------------------------------------------ helpers (Task 21 review)
def project(tmp_path, duration, lines, music=None, sfx=None, name="EXM-2026-10-07"):
    """lines: [(start_s, mono ndarray)]; music/sfx: (n, 2) arrays or None for silence."""
    pd = tmp_path / name
    for sub in ("artifacts", "assets/audio/lines", "assets/music/long"):
        (pd / sub).mkdir(parents=True, exist_ok=True)
    meta_lines = []
    for i, (start, y) in enumerate(lines):
        f = f"assets/audio/lines/l{i}.wav"
        sf.write(pd / f, y.astype(np.float32), SR)
        meta_lines.append({"id": f"L{i}", "start": start, "end": start + len(y) / SR, "file": f})
    (pd / "artifacts/timeline.long.meta.json").write_text(json.dumps({"duration": duration, "lines": meta_lines}))
    n = int(duration * SR)
    sf.write(pd / "assets/music/long/music.wav", (np.zeros((n, 2)) if music is None else music).astype(np.float32), SR, subtype="FLOAT")
    sf.write(pd / "assets/music/long/sfx.wav", (np.zeros((n, 2)) if sfx is None else sfx).astype(np.float32), SR, subtype="FLOAT")
    return pd


def db(v):
    return 20 * np.log10(v + 1e-12)


def rms_db(y, a, b):
    return db(float(np.sqrt((y[int(a * SR):int(b * SR)] ** 2).mean())))


def oversampled_peak_db(y, up=8):
    best, n, ch = 0.0, len(y), SR * 10
    for a in range(0, n, ch):
        lo, hi = max(0, a - 512), min(n, a + ch + 512)
        u = signal.resample_poly(y[lo:hi], up, 1, axis=0)
        best = max(best, np.abs(u[(a - lo) * up:(min(n, a + ch) - lo) * up]).max())
    return db(best)


def ffmpeg_integrated(path):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    out = subprocess.run(["ffmpeg", "-nostats", "-hide_banner", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    tail = out[out.rindex("Summary:"):]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1)), float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", tail).group(1))


def peaky_voice(seconds=5.0, click=0.9, seed=2):
    """Modulated noise at about -24 dBFS RMS with a single-sample click every 250 ms: the click is the mix's peak."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    x = 0.06 * rng.standard_normal(len(t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) ** 2
    x[int(0.125 * SR)::int(0.25 * SR)] += click
    return x


def noise_music(duration, level=0.05, seed=3):
    return level * np.random.default_rng(seed).standard_normal((int(duration * SR), 2))


# ------------------------------------------------------------------------------------------------ the limiter
def test_limiter_engages_and_holds_the_ceiling(tmp_path):
    """The brief's mix test never gets here: its fixture peaks at -2.85 dBTP before and after. This one cannot pass unless the limiter works."""
    pd = project(tmp_path, 24.0, [(1.0, peaky_voice()), (9.0, peaky_voice(seed=5)), (16.0, peaky_voice(seed=6))], music=noise_music(24.0))
    rep = mix.mixdown(pd, "long")
    out = pd / "assets/audio/mix.long.wav"
    y, sr = sf.read(out)
    # it had to work, and said so
    assert rep["max_limiter_reduction_db"] < -1.0
    # the tool's gate holds by the module's own meter and by ffmpeg's
    assert rep["true_peak_dbtp"] <= -1.4 and mix.true_peak_db(y) <= -1.4
    lufs, tp = ffmpeg_integrated(out)
    assert tp <= -1.4
    # the spec's -1.5 dBTP holds at 8x oversampling: the 4x meter under-reads clicks by about 0.1 dB, so it limits to -1.6
    assert oversampled_peak_db(y) <= -1.5 + 0.02
    # loudness survives the limiting, by the module's meter and the independent one
    assert rep["integrated_lufs"] == pytest.approx(-14.0, abs=0.3)
    assert lufs == pytest.approx(rep["integrated_lufs"], abs=0.15)
    assert sr == SR and y.shape == (24 * SR, 2)


def test_the_spec_ceiling_holds_at_8x_where_the_4x_meter_under_reads(tmp_path):
    """Milder clicks than the test above: the limiter still works (several dB) but the clicks' true peaks fall between the 4x
    meter's points, so it reads about 0.1 dB under an 8x estimate. The ceiling is set for that: -1.6 by the 4x meter, so the
    spec's -1.5 dBTP holds at 8x. (A -1.5 ceiling reads -1.42 at 8x on this material.)"""
    voices = [(1.0, peaky_voice(click=0.5, seed=41)), (9.0, peaky_voice(click=0.5, seed=42)), (16.0, peaky_voice(click=0.5, seed=43))]
    pd = project(tmp_path, 24.0, voices, music=noise_music(24.0))
    rep = mix.mixdown(pd, "long")
    y, _ = sf.read(pd / "assets/audio/mix.long.wav")
    assert rep["max_limiter_reduction_db"] < -1.0
    assert oversampled_peak_db(y) - rep["true_peak_dbtp"] > 0.04   # the 4x meter does under-read this material, so the next line means something
    assert oversampled_peak_db(y) <= -1.5 + 0.02


def test_limiter_looks_ahead_catches_the_peak_and_recovers_without_pumping():
    """One +1.6 dBFS click in a quiet program. Before the click's look-ahead the program is untouched, the
    click lands at the ceiling, and the gain is back within 0.1 dB by 300 ms after (80 ms release)."""
    rng = np.random.default_rng(1)
    x = 0.03 * rng.standard_normal((4 * SR, 2))
    x[2 * SR, :] = 1.2
    y, red = mix.limit(x)
    g = lambda a, b: rms_db(y, a, b) - rms_db(x, a, b)
    assert red < -2.5                                       # it had to work
    assert abs(g(0.5, 1.9)) < 0.01                          # the program well before the click is untouched
    assert g(1.9965, 1.9995) < -2.0                         # the look-ahead: down before the click arrives
    assert mix.true_peak_db(y) <= -1.6 + 0.02               # the click sits at the ceiling by the 4x meter
    assert oversampled_peak_db(y) <= -1.5 + 0.02            # and the spec's -1.5 dBTP holds at 8x
    assert g(2.30, 2.50) > -0.1                             # recovered 300-500 ms later
    assert g(2.5, 3.5) > -0.01                              # and stays recovered: no hold, no pumping


# ------------------------------------------------------------------------------------------------ the mix chain's other promises
def test_master_file_is_24bit_48k_stereo_and_fades_out(tmp_path):
    pd = project(tmp_path, 12.0, [(1.0, peaky_voice(seconds=9.0, click=0.0))], music=noise_music(12.0))
    mix.mixdown(pd, "long")
    info = sf.info(pd / "assets/audio/mix.long.wav")
    assert (info.samplerate, info.channels, info.subtype) == (SR, 2, "PCM_24")
    y, _ = sf.read(pd / "assets/audio/mix.long.wav")
    assert rms_db(y, 11.99 - 0.005, 11.99) < rms_db(y, 10.0, 11.0) - 30  # the last 5 ms are in the 0.45 s fade-out


def test_narration_lands_where_the_timeline_says(tmp_path):
    """A 1 s noise burst 0.5 s into a line that starts at 4.0 s must be heard from 4.5 to 5.5 s, and nowhere near 0 s."""
    line = np.zeros(int(3.0 * SR))
    line[int(0.5 * SR):int(1.5 * SR)] = 0.1 * np.random.default_rng(4).standard_normal(SR)
    pd = project(tmp_path, 10.0, [(4.0, line)])
    mix.mixdown(pd, "long")
    y, _ = sf.read(pd / "assets/audio/mix.long.wav")
    assert rms_db(y, 4.6, 5.4) > rms_db(y, 0.0, 3.9) + 40
    assert rms_db(y, 4.6, 5.4) > rms_db(y, 6.5, 9.0) + 40


def test_effects_bus_reaches_the_master(tmp_path):
    sfx = np.zeros((int(12.0 * SR), 2))
    sfx[int(9.0 * SR):int(9.5 * SR)] = 0.2 * np.random.default_rng(6).standard_normal((SR // 2, 2))
    pd = project(tmp_path, 12.0, [(1.0, peaky_voice(seconds=3.0, click=0.0))], sfx=sfx)
    mix.mixdown(pd, "long")
    y, _ = sf.read(pd / "assets/audio/mix.long.wav")
    assert rms_db(y, 9.05, 9.45) > rms_db(y, 6.0, 8.5) + 40


def test_duck_key_is_already_down_when_the_voice_starts():
    vo = np.zeros(8 * SR)
    vo[3 * SR:5 * SR] = 0.1 * np.random.default_rng(7).standard_normal(2 * SR)
    key = mix.duck_key(vo)
    assert key[int(2.0 * SR)] < 0.01                 # music at full level well before
    assert key[int(2.9 * SR)] > 0.5                  # 100 ms ahead of the voice the duck is more than half down
    assert key[int(3.0 * SR)] > 0.9                  # fully down at onset
    assert key[int(5.0 * SR) + int(0.1 * SR)] > 0.7  # held through the end of the line, released over about a second
    assert key[int(6.5 * SR)] < 0.1


def test_duck_key_holds_through_the_gap_between_lines():
    vo = np.zeros(10 * SR)
    for s0 in (2.0, 4.3):                           # two 2 s lines with the timeline's 0.3 s GAP between them
        vo[int(s0 * SR):int((s0 + 2) * SR)] = 0.1 * np.random.default_rng(int(s0 * 10)).standard_normal(2 * SR)
    key = mix.duck_key(vo)
    assert key[int(4.0 * SR):int(4.3 * SR)].min() > 0.95


# ------------------------------------------------------------------------------------------------ score placement (impulses)
LEVEL = {"bed_calm": 0.02, "bed_groove": 0.05, "bed_tension": 0.08}
IMPULSE_SCENES = [
    {"id": "a", "type": "opening", "chapter": "cold_open", "start": 0.0, "end": 7.0, "transition": "cut"},
    {"id": "b", "type": "chapter", "chapter": "result", "start": 7.0, "end": 9.5, "transition": "page"},
    {"id": "c", "type": "number_card", "chapter": "result", "start": 9.5, "end": 70.0, "transition": "page"},
    {"id": "d", "type": "chapter", "chapter": "bears", "start": 70.0, "end": 72.5, "transition": "page"},
    {"id": "e", "type": "line_chart", "chapter": "bears", "start": 72.5, "end": 100.0, "transition": "page"},
    {"id": "f", "type": "end_card", "chapter": "close", "start": 100.0, "end": 110.0, "transition": "page"},
]
IMPULSE_DURATION = 110.0


def impulse_stems(tmp_path, sting_lufs=(-18.4, -18.4, False), card_lufs=(-18.0, -18.0, False)):
    out = {}
    spec = {"sting_open": (0.30, 1.0, sting_lufs), "card_sting": (0.40, 1.0, card_lufs), "button_end": (0.50, 1.0, (-23.0, -23.0, False))}
    for name, (amp, length, (lufs, target, limited)) in spec.items():
        y = np.zeros((int(length * SR), 2)); y[0] = amp
        p = tmp_path / f"{name}.wav"
        sf.write(p, y.astype(np.float32), SR, subtype="FLOAT")
        p.with_suffix(".json").write_text(json.dumps({"lufs": lufs, "target_lufs": target, "peak_limited": limited, "loop_seconds": None}))
        out[name] = p
    for name, level in LEVEL.items():                                # constant beds, exactly one loop long: any seam or gap shows
        y = np.full((10 * SR, 2), level)
        p = tmp_path / f"{name}.wav"
        sf.write(p, y.astype(np.float32), SR, subtype="FLOAT")
        p.with_suffix(".json").write_text(json.dumps({"lufs": -20.0, "target_lufs": -20.0, "peak_limited": False, "loop_seconds": 10.0}))
        out[name] = p
    return out


def impulse_sfx(tmp_path):
    p = tmp_path / "click.wav"
    y = np.zeros(2400); y[0] = 1.0
    sf.write(p, y.astype(np.float32), SR, subtype="FLOAT")
    return {"page-flip": [p], "book-open": [p], "book-close": [p]}


@pytest.fixture
def built(tmp_path):
    music, fx, cues = score.build_score(IMPULSE_SCENES, IMPULSE_DURATION, impulse_stems(tmp_path), impulse_sfx(tmp_path))
    return music, fx, cues


def jump(y, t):
    a = int(round(t * SR))
    return float(y[a, 0] - y[a - 1, 0])


def test_opening_sting_is_at_zero_and_first_bed_waits_for_five_seconds(built):
    music, _, _ = built
    assert music[0, 0] == pytest.approx(0.30, abs=1e-3)
    assert np.abs(music[1:int(4.99 * SR)]).max() == 0.0          # nothing else under the sting's two bars
    assert music[int(5.5 * SR), 0] == pytest.approx(0.5 * LEVEL["bed_calm"], abs=1e-3)   # bed_calm halfway through its 1 s fade-in from 5.0


def test_card_stings_sit_on_chapter_cards_only(built):
    music, _, cues = built
    for t in (7.0, 70.0):
        assert jump(music, t) == pytest.approx(0.40 * 0.9, abs=0.02)
    assert jump(music, 9.5) < 0.01 and jump(music, 72.5) < 0.01   # number_card and line_chart start with no sting
    assert [c["t"] for c in cues if c["name"] == "card_sting"] == [7.0, 70.0]


def test_end_button_sits_on_the_end_card(built):
    music, _, cues = built
    assert jump(music, 100.0) == pytest.approx(0.50, abs=0.02)
    assert [c["t"] for c in cues if c["name"] == "button_end"] == [100.0]


def test_beds_loop_without_gaps_and_crossfade_without_steps(built):
    music, _, cues = built
    # 'result' bed_groove runs 6.75 .. 70.25 s (six passes of a 10 s stem) and 'bears' bed_tension 69.75 .. 102.0:
    # flat at their own level between the fades, whatever the loop seams do
    assert np.abs(music[int(7.5 * SR):int(69.0 * SR), 0] - LEVEL["bed_groove"]).max() < 2e-3
    assert np.abs(music[int(70.6 * SR):int(99.0 * SR), 0] - LEVEL["bed_tension"]).max() < 2e-3
    # the crossfade between them at 70.0: a ramp, not a step (the card sting's single-sample click at 70.0 removed)
    seam = np.diff(music[int(69.9 * SR):int(70.6 * SR), 0])
    seam[np.abs(seam) > 0.3] = 0
    assert np.abs(seam).max() < 1e-3
    assert music[int(round(70.0 * SR)) - 5, 0] == pytest.approx((LEVEL["bed_groove"] + LEVEL["bed_tension"]) / 2, abs=3e-3)
    assert [(c["name"], c["t"]) for c in cues if c["kind"] == "bed"] == [("bed_calm", 5.0), ("bed_groove", 6.75), ("bed_tension", 69.75), ("bed_groove", 99.75)]


def test_music_stops_two_seconds_into_the_end_card_and_fades_over_one_and_a_half(built):
    music, _, _ = built
    assert np.abs(music[int(102.01 * SR):, :]).max() == 0.0
    assert music[int(101.25 * SR), 0] == pytest.approx(0.5 * LEVEL["bed_groove"], abs=4e-3)   # halfway down the 1.5 s fade from 100.5 to 102.0
    assert music[int(100.4 * SR), 0] == pytest.approx(LEVEL["bed_groove"], abs=2e-3)


def test_book_open_and_book_close_are_where_the_cue_sheet_puts_them(built):
    _, fx, cues = built
    assert fx[int(round(0.15 * SR)), 0] == pytest.approx(10 ** (-9 / 20), abs=1e-3)
    assert fx[int(round(100.3 * SR)), 0] == pytest.approx(10 ** (-6 / 20), abs=1e-3)
    assert [c["t"] for c in cues if c["name"] == "book-open"] == [0.15]
    assert [c["t"] for c in cues if c["name"] == "book-close"] == [100.3]


def test_stem_gain_is_trimmed_to_target_unless_peak_limited(tmp_path):
    # unflagged stem 3 dB under its target is lifted 3 dB; a peak_limited one plays as rendered (the controller's ruling)
    music, _, _ = score.build_score(IMPULSE_SCENES, IMPULSE_DURATION, impulse_stems(tmp_path, sting_lufs=(-21.4, -18.4, False)), impulse_sfx(tmp_path))
    assert music[0, 0] == pytest.approx(0.30 * 10 ** (3 / 20), abs=2e-3)
    music, _, _ = score.build_score(IMPULSE_SCENES, IMPULSE_DURATION, impulse_stems(tmp_path, sting_lufs=(-21.4, -18.4, True)), impulse_sfx(tmp_path))
    assert music[0, 0] == pytest.approx(0.30, abs=1e-3)


# ------------------------------------------------------------------------------------------------ page flips follow the fold
def loudest_window(y, a, b, win=0.010):
    """(centre time in s, RMS in dBFS) of the loudest sliding 10 ms window of y[a s : b s], both channels."""
    w = int(round(win * SR))
    e = (y[int(a * SR): int(b * SR)] ** 2).mean(axis=1)
    c = np.concatenate([[0.0], np.cumsum(e)])
    ms = (c[w:] - c[:-w]) / w
    i = int(np.argmax(ms))
    return a + (i + w / 2) / SR, 10 * np.log10(ms[i])


def energy_centroid(y, a, b):
    e = (y[int(a * SR): int(b * SR)] ** 2).sum(axis=1)
    return a + float((e * np.arange(len(e))).sum() / e.sum()) / SR


def first_sound(y, a, b):
    seg = np.abs(y[int(a * SR): int(b * SR)]).max(axis=1)
    return a + int(np.flatnonzero(seg > 1e-9)[0]) / SR


def click_flip(seed=11):
    """A hot click with a tail: its loudest 10 ms is at the very start (centred 6 ms in) but its energy is spread over 0.3 s
    (centroid near 49 ms), so it is the centroid, not the loudest window, that the middle of the fold must take."""
    t = np.arange(int(0.3 * SR)) / SR
    return 0.5 * np.random.default_rng(seed).standard_normal((len(t), 2)) * np.exp(-t / 0.1)[:, None]


def thud_flip(thud_at=0.6, seed=12):
    """A faint rustle, then a landing thud at thud_at s (a 70 Hz burst decaying over 25 ms) some 28 dB under the click's level."""
    n = int((thud_at + 0.2) * SR)
    y = 0.004 * np.random.default_rng(seed).standard_normal((n, 2))
    k = int(thud_at * SR)
    t = np.arange(n - k) / SR
    y[k:] += (0.03 * np.sin(2 * np.pi * 70 * t) * np.exp(-t / 0.025))[:, None]
    return y


def write_flips(tmp_path, *clips):
    paths = []
    for i, y in enumerate(clips):
        p = tmp_path / f"flip{i}.wav"
        sf.write(p, y.astype(np.float32), SR, subtype="FLOAT")
        paths.append(p)
    return {"page-flip": paths, "book-open": paths[:1], "book-close": paths[:1]}


FLIP_SCENES = [
    {"id": "a", "type": "opening", "chapter": "cold_open", "start": 0.0, "end": 10.0, "transition": "cut"},
    {"id": "b", "type": "number_card", "chapter": "result", "start": 10.0, "end": 20.0, "transition": "page"},
    {"id": "c", "type": "number_card", "chapter": "result", "start": 20.0, "end": 30.0, "transition": "page"},
]


def test_flips_land_on_the_fold_and_play_at_one_level(tmp_path):
    """The flips rotate by scene index, so scene b (index 1) gets the thud and scene c (index 2) the click. The fold takes
    0.45 s (TURN, eased in and out): a landing thud meets its end, the rest is centred on its middle at 0.225 s. Whatever
    their source levels (the click is some 28 dB hotter), both play with the same loudest 10 ms window."""
    flips = write_flips(tmp_path, click_flip(), thud_flip())
    _, fx, cues = build_score(FLIP_SCENES, 30.0, impulse_stems(tmp_path), flips)
    thud_t, thud_db = loudest_window(fx, 9.0, 11.5)
    assert thud_t == pytest.approx(10.0 + 0.45, abs=0.002)
    _, click_db = loudest_window(fx, 19.5, 21.0)
    assert energy_centroid(fx, 19.5, 21.0) == pytest.approx(20.0 + 0.225, abs=0.002)
    assert thud_db == pytest.approx(score.FLIP_EVENT_DBFS, abs=0.1) and click_db == pytest.approx(score.FLIP_EVENT_DBFS, abs=0.1)
    assert abs(thud_db - click_db) < 0.05
    # each cue is where its sample really starts, so the sheet can be trusted to place a flip
    flip_cues = [c for c in cues if c["name"] == "page-flip"]
    assert len(flip_cues) == 2
    for cue, (a, b) in zip(flip_cues, ((9.0, 11.5), (19.5, 21.0))):
        assert first_sound(fx, a, b) == pytest.approx(cue["t"], abs=0.001)
    assert flip_cues[0]["t"] < 10.0 < 20.0 < flip_cues[1]["t"]  # the thud starts before its scene, the click after its


def test_a_flip_is_never_placed_before_the_start_of_the_cut(tmp_path):
    """A thud 0.9 s into its sample, for a page turning in at 0.3 s, would have to start 0.15 s before the cut does: it starts at 0."""
    scenes = [{"id": "a", "type": "opening", "chapter": "cold_open", "start": 0.0, "end": 0.3, "transition": "cut"},
              {"id": "b", "type": "number_card", "chapter": "result", "start": 0.3, "end": 10.0, "transition": "page"}]
    _, fx, cues = build_score(scenes, 10.0, impulse_stems(tmp_path), write_flips(tmp_path, thud_flip(thud_at=0.9)))
    assert fx.shape == (10 * SR, 2)
    assert [c["t"] for c in cues if c["name"] == "page-flip"] == [0.0]
    assert np.abs(fx[:int(0.14 * SR)]).max() > 0       # the sample starts at sample 0


def test_a_silent_flip_sample_stays_silent(tmp_path):
    flips = write_flips(tmp_path, np.zeros((int(0.2 * SR), 2)))
    _, fx, cues = build_score(FLIP_SCENES, 30.0, impulse_stems(tmp_path), flips)
    assert np.isfinite(fx).all() and np.abs(fx[int(9.0 * SR):int(21.0 * SR)]).max() == 0.0
    assert [c["name"] for c in cues].count("page-flip") == 2


def test_page_flips_sit_on_the_middle_of_the_fold_and_the_cue_sheet_says_so(built):
    _, fx, cues = built
    middles = [t + score.TURN / 2 for t in (7.0, 9.5, 70.0, 72.5, 100.0)]
    for t in middles:
        assert fx[int(round(t * SR)), 0] > 0.5            # a single-sample click: its energy sits on that sample
    assert [c["t"] for c in cues if c["name"] == "page-flip"] == pytest.approx(middles, abs=1e-3)


def test_the_cue_sheet_is_in_time_order(tmp_path, built):
    (tmp_path / "fake").mkdir()
    fake = build_score(SCENES, 38.0, fake_stems(tmp_path / "fake"), fake_sfx(tmp_path / "fake"))[2]
    for cues in (built[2], fake):
        times = [c["t"] for c in cues]
        assert times == sorted(times) and len(times) > 8


def test_the_flip_level_is_page_flip_3_as_it_played_under_minus_6_db():
    """FLIP_EVENT_DBFS was measured on the kit's page-flip-3: its loudest 10 ms window less the 6 dB the flips used to get."""
    from tools.shorted.kit import kit_dir

    path = kit_dir() / "sfx" / "page-flip-3.ogg"
    if not path.exists():
        pytest.skip("no kit/sfx/page-flip-3.ogg: run the kit seed")
    _, _, level = score._flip_event(score._read(path))
    assert score.FLIP_EVENT_DBFS == pytest.approx(level - 6.0, abs=0.05)


# ------------------------------------------------------------------------------------------------ the score is 48 kHz and float
@pytest.mark.parametrize("stem", ["sting_open", "bed_groove", "button_end"])
def test_a_stem_at_another_sample_rate_is_an_error_naming_the_file(tmp_path, stem):
    stems = fake_stems(tmp_path)
    y, _ = sf.read(stems[stem])
    sf.write(stems[stem], y, 44100, subtype="PCM_24")
    with pytest.raises(ValueError, match=rf"{stem}\.flac.*44100"):
        build_score(SCENES, 38.0, stems, fake_sfx(tmp_path))


@pytest.mark.parametrize("where", ["assets/audio/lines/l0.wav", "assets/music/long/music.wav", "assets/music/long/sfx.wav"])
def test_a_line_or_bus_at_another_sample_rate_is_an_error_naming_the_file(tmp_path, where):
    pd = project(tmp_path, 6.0, [(1.0, peaky_voice(seconds=2.0, click=0.0))], music=noise_music(6.0))
    y, _ = sf.read(pd / where)
    sf.write(pd / where, y, 44100)
    with pytest.raises(ValueError, match=rf"{re.escape(where)}.*44100"):
        mix.mixdown(pd, "long")


def test_a_sound_effect_at_another_sample_rate_is_resampled(tmp_path):
    """Effects are third-party files, so unlike our own stems they are converted: a 0.2 s flip at 24 kHz plays for 0.2 s."""
    p = tmp_path / "slow.wav"
    sf.write(p, (0.2 * np.random.default_rng(3).standard_normal((4800, 2))).astype(np.float32), 24000, subtype="FLOAT")
    _, fx, _ = build_score(FLIP_SCENES, 30.0, impulse_stems(tmp_path), {"page-flip": [p], "book-open": [p], "book-close": [p]})
    heard = np.flatnonzero(np.abs(fx[int(9.0 * SR):int(11.5 * SR), 0]) > 0.01 * np.abs(fx[int(9.0 * SR):int(11.5 * SR), 0]).max())
    assert (heard[-1] - heard[0]) / SR == pytest.approx(0.2, abs=0.01)


def test_the_score_keeps_whatever_sums_past_full_scale(tmp_path):
    """The buses are float files: a sting above full scale is stored as it is, not clipped as a 16-bit file would."""
    pd = tmp_path / "EXM-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    (pd / "artifacts/timeline.long.json").write_text(json.dumps({"scenes": SCENES}))
    (pd / "artifacts/timeline.long.meta.json").write_text(json.dumps({"duration": 38.0}))
    stems = impulse_stems(tmp_path)
    hot = np.zeros((SR, 2)); hot[0] = 1.5
    sf.write(stems["sting_open"], hot, SR, subtype="FLOAT")
    score_cut(pd, "long", stems=stems, sfx=impulse_sfx(tmp_path))
    y, _ = sf.read(pd / "assets/music/long/music.wav")
    assert y[0, 0] == pytest.approx(1.5, abs=1e-4)


# ------------------------------------------------------------------------------------------------ the shorted_score tool
def timeline_project(tmp_path, cuts=("long",), meta=True):
    pd = tmp_path / "EXM-2026-10-07"
    (pd / "artifacts").mkdir(parents=True)
    for cut in cuts:
        (pd / f"artifacts/timeline.{cut}.json").write_text(json.dumps({"scenes": SCENES}))
        if meta:
            (pd / f"artifacts/timeline.{cut}.meta.json").write_text(json.dumps({"duration": 38.0}))
    return pd


@pytest.mark.parametrize("inputs", [{}, {"project_dir": ""}, {"project_dir": None}, {"project_dir": 7}])
def test_the_tool_needs_a_project_folder(inputs):
    res = score.ShortedScore().execute(inputs)
    assert not res.success and res.error == "project_dir is required" and res.data == {} and res.artifacts == []


def test_the_tool_refuses_a_missing_folder_and_a_project_with_no_timeline(tmp_path):
    res = score.ShortedScore().execute({"project_dir": str(tmp_path / "nowhere")})
    assert not res.success and "does not exist" in res.error and str(tmp_path / "nowhere") in res.error
    assert not (tmp_path / "nowhere").exists()
    (tmp_path / "empty" / "artifacts").mkdir(parents=True)
    res = score.ShortedScore().execute({"project_dir": tmp_path / "empty"})  # a Path works as well as a string
    assert not res.success
    assert res.error == "no timeline.long.json or timeline.short.json in artifacts/; run the timeline stage first"
    assert res.data == {} and res.artifacts == [] and not (tmp_path / "empty" / "assets").exists()


def test_the_tool_reports_a_missing_kit_instead_of_raising(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTED_KIT_DIR", str(tmp_path / "no-kit"))
    res = score.ShortedScore().execute({"project_dir": str(timeline_project(tmp_path))})
    assert res.success is False and res.artifacts == []
    assert res.error.startswith("long score failed: ") and "no SoundFont in the kit" in res.error
    assert not (tmp_path / "no-kit").exists()  # failing wrote nothing to the kit


def test_the_tool_reports_a_kit_without_the_sound_effects(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTED_KIT_DIR", str(tmp_path / "no-kit"))
    with pytest.raises(RuntimeError, match="no sfx tagged"):
        score.kit_sfx()
    monkeypatch.setattr("tools.shorted.music_theme.ensure_stems", lambda *a, **k: fake_stems(tmp_path))  # stems are fine; the effects are not
    res = score.ShortedScore().execute({"project_dir": str(timeline_project(tmp_path))})
    assert res.success is False and res.error.startswith("long score failed: ") and "no sfx tagged" in res.error


def test_the_tool_reports_a_timeline_without_its_meta(tmp_path):
    res = score.ShortedScore().execute({"project_dir": str(timeline_project(tmp_path, meta=False))})  # a FileNotFoundError
    assert res.success is False and res.error.startswith("long score failed: ") and "timeline.long.meta.json" in res.error


def test_the_tool_reports_a_timeline_that_lacks_its_scenes_or_is_torn(tmp_path):
    pd = timeline_project(tmp_path)
    (pd / "artifacts/timeline.long.json").write_text("{}")
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert res.success is False
    assert res.error == "long score failed: an artifact lacks the entry 'scenes'; re-run the stage that wrote it"
    (pd / "artifacts/timeline.long.json").write_text('{"scenes": [')
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert res.success is False and res.error.startswith("long score failed: ")


def test_the_tool_reports_a_mix_failure_naming_the_file(tmp_path, monkeypatch):
    pd = project(tmp_path, 6.0, [(1.0, peaky_voice(seconds=2.0, click=0.0))], music=noise_music(6.0))
    y, _ = sf.read(pd / "assets/audio/lines/l0.wav")
    sf.write(pd / "assets/audio/lines/l0.wav", y, 44100)
    (pd / "artifacts/timeline.long.json").write_text("{}")
    monkeypatch.setattr(score, "score_cut", lambda *a, **k: {})  # the score is not what fails here
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert res.success is False and res.error.startswith("long score failed: ")
    assert "assets/audio/lines/l0.wav" in res.error and "44100" in res.error


def test_the_tool_reports_a_narration_file_that_is_missing(tmp_path, monkeypatch):
    """soundfile raises a RuntimeError subclass (LibsndfileError), not an OSError, for a file it cannot open."""
    pd = project(tmp_path, 6.0, [(1.0, peaky_voice(seconds=2.0, click=0.0))], music=noise_music(6.0))
    (pd / "assets/audio/lines/l0.wav").unlink()
    (pd / "artifacts/timeline.long.json").write_text("{}")
    monkeypatch.setattr(score, "score_cut", lambda *a, **k: {})
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert res.success is False and res.error.startswith("long score failed: ") and "l0.wav" in res.error


@pytest.mark.parametrize("lufs, peak, ok", [(-14.0, -1.6, True), (-13.0, -1.4, True), (-15.0, -1.4, True), (-12.99, -1.6, False),
                                           (-15.01, -1.6, False), (-14.0, -1.39, False), (-14.0, -1.0, False)])
def test_the_tool_passes_a_mix_within_1_lu_of_14_and_at_or_under_minus_1_4_dbtp(tmp_path, monkeypatch, lufs, peak, ok):
    pd = timeline_project(tmp_path, cuts=("long", "short"))
    run = []
    monkeypatch.setattr(score, "score_cut", lambda p, cut, *a, **k: run.append(("score", cut)))
    monkeypatch.setattr(mix, "mixdown", lambda p, cut: run.append(("mix", cut)) or {"integrated_lufs": lufs, "true_peak_dbtp": peak})
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert run == [("score", "long"), ("mix", "long"), ("score", "short"), ("mix", "short")]  # each cut, scored before it is mixed
    assert res.success is ok and (res.error is None) == ok
    assert set(res.data) == {"long", "short"} and res.error == (None if ok else "mix out of spec: ['long', 'short']")
    assert res.artifacts == [str(pd / "assets/audio/mix.long.wav"), str(pd / "assets/audio/mix.short.wav")]


def test_the_tool_scores_and_mixes_a_project(tmp_path, monkeypatch):
    """Everything real but the kit: the stems and effects come from the fixtures, the mix is the module's."""
    pd = project(tmp_path, 24.0, [(1.0, peaky_voice()), (9.0, peaky_voice(seed=5)), (16.0, peaky_voice(seed=6))], music=noise_music(24.0))
    (pd / "artifacts/timeline.long.json").write_text(json.dumps({"scenes": [
        {"id": "a", "type": "opening", "chapter": "cold_open", "start": 0.0, "end": 12.0, "transition": "cut"},
        {"id": "b", "type": "end_card", "chapter": "close", "start": 12.0, "end": 24.0, "transition": "page"}]}))
    monkeypatch.setattr("tools.shorted.music_theme.ensure_stems", lambda *a, **k: fake_stems(tmp_path))
    monkeypatch.setattr(score, "kit_sfx", lambda: fake_sfx(tmp_path))
    res = score.ShortedScore().execute({"project_dir": str(pd)})
    assert res.success, res.error
    assert set(res.data) == {"long"} and res.data["long"]["integrated_lufs"] == pytest.approx(-14.0, abs=0.3)
    assert (pd / "assets/audio/mix.long.wav").exists() and (pd / "artifacts/score.long.json").exists()
    assert res.artifacts == [str(pd / "assets/audio/mix.long.wav")]
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_score_mix.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.mixdown'`.

- [ ] **Step 3: Implement `score.py`**

```python
"""The score for a cut: chapter beds from the signature theme, a sting to open, a card sting on every
chapter card, the button on the end card, and paper effects on page turns. Arranged from the
timeline, like the film's music.py, from stems rendered once into the kit (music_theme.py).

A page flip follows the fold of the page turning: a landing thud meets the end of the turn, and anything else is
centred on its middle. Every flip is also scaled to one level, so which of the kit's variants a turn gets does not
change how loud it is."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from tools.base_tool import BaseTool, ToolResult, ToolTier

SR = 48000
CHAPTER_BEDS = {"cold_open": "bed_calm", "company": "bed_calm", "result": "bed_groove", "cash": "bed_groove",
                "outlook": "bed_groove", "bears": "bed_tension", "news": "bed_groove", "watch": "bed_calm", "close": "bed_groove"}
XFADE = 0.5
FIRST_BED = 5.0  # the opening sting has the first two bars to itself
TURN = 0.45  # seconds a page takes to turn in, from its scene's start, eased in and out (ShortedVideo.tsx: TURN, inOutCubic): half open at TURN / 2
FLIP_WINDOW = 0.010  # a flip's event is its loudest 10 ms
FLIP_THUD_AFTER = 0.4  # a loudest window later than this into the sample is a landing thud, not the rustle
# Every flip is scaled so its loudest 10 ms window has this RMS. It is page-flip-3's under the -6 dB gain that every flip used to get.
# Measured on the kit's kit/sfx/page-flip-3.ogg (48 kHz stereo) with _flip_event: -20.61 dBFS at unity gain, so -26.61 dBFS at -6 dB.
FLIP_EVENT_DBFS = -26.61


def _read(path: Path, resample: bool = False) -> np.ndarray:
    """A stem or effect as 48 kHz stereo. The stems are our own renders at 48 kHz, so one at another rate is an error naming the
    file (a stale or foreign kit). A third-party effect (resample=True) is converted instead."""
    import soundfile as sf
    from scipy import signal

    y, sr = sf.read(path, always_2d=True)
    if sr != SR:
        if not resample:
            raise ValueError(f"{path} is {sr} Hz, not {SR} Hz; the score is built at {SR} Hz")
        g = math.gcd(int(sr), SR)
        y = signal.resample_poly(y, SR // g, int(sr) // g, axis=0)
    return y if y.shape[1] == 2 else np.repeat(y[:, :1], 2, axis=1)


def _flip_event(clip: np.ndarray) -> tuple[float, float, float]:
    """Where a page-flip sample's event is: the centre of its loudest 10 ms window (s), the centroid of its energy (s) and that
    window's RMS (dBFS, the mean square across both channels). The window slides a sample at a time, so the answer does not
    depend on where the windows happen to fall. A silent sample is (0, 0, -inf)."""
    w = int(round(FLIP_WINDOW * SR))
    e = (clip ** 2).mean(axis=1)
    total = float(e.sum())
    if total <= 0:
        return 0.0, 0.0, -math.inf
    c = np.concatenate([[0.0], np.cumsum(np.pad(e, (0, max(0, w - len(e)))))])
    ms = (c[w:] - c[:-w]) / w
    i = int(np.argmax(ms))
    return (i + w / 2) / SR, float((e * np.arange(len(e))).sum()) / total / SR, 10 * math.log10(ms[i])


def _gain(path: Path) -> float:
    """Trim a stem to its target loudness, but never above its own peak ceiling: a stem whose render was held
    under the ceiling (peak_limited) plays as rendered."""
    meta = json.loads(path.with_suffix(".json").read_text())
    if meta.get("peak_limited"):
        return 1.0
    return 10 ** ((meta["target_lufs"] - meta["lufs"]) / 20)


def _place(buf: np.ndarray, clip: np.ndarray, t: float, gain: float = 1.0) -> None:
    a = int(round(t * SR))
    if a >= len(buf):
        return
    n = min(len(clip), len(buf) - max(a, 0))
    buf[max(a, 0): max(a, 0) + n] += clip[:n] * gain


def chapter_segments(scenes: list[dict]) -> list[dict]:
    segs: list[dict] = []
    for sc in scenes:
        bed = CHAPTER_BEDS.get(sc["chapter"], "bed_calm")
        if segs and segs[-1]["bed"] == bed:
            segs[-1]["end"] = sc["end"]
        else:
            segs.append({"bed": bed, "start": sc["start"], "end": sc["end"]})
    return segs


def _loop(stem: np.ndarray, loop_s: float, length: int) -> np.ndarray:
    out = np.zeros((length + len(stem), 2))
    step = int(round(loop_s * SR))
    for a in range(0, length, step):
        out[a: a + len(stem)] += stem
    return out[:length]


def _fades(x: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    a, b = min(len(x), int(fade_in * SR)), min(len(x), int(fade_out * SR))
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None]
    if b:
        x[-b:] *= np.linspace(1, 0, b)[:, None]
    return x


def build_score(scenes: list[dict], duration: float, stems: dict[str, Path], sfx: dict[str, list[Path]]):
    n = int(round(duration * SR))
    music, fx = np.zeros((n, 2)), np.zeros((n, 2))
    cues = []
    end_card = next((s for s in scenes if s["type"] == "end_card"), None)
    music_end = end_card["start"] + 2.0 if end_card else duration
    _place(music, _read(stems["sting_open"]), 0.0, _gain(stems["sting_open"]))
    cues.append({"t": 0.0, "kind": "music", "name": "sting_open"})
    for seg in chapter_segments(scenes):
        a = max(seg["start"] - XFADE / 2, FIRST_BED)
        b = min(seg["end"] + XFADE / 2, music_end)
        if b - a < 1.0:
            continue
        path = stems[seg["bed"]]
        loop_s = json.loads(path.with_suffix(".json").read_text())["loop_seconds"]
        bed = _loop(_read(path), loop_s, int((b - a) * SR))
        fade_out = 1.5 if b >= music_end else XFADE
        _place(music, _fades(bed, 1.0 if a == FIRST_BED else XFADE, fade_out), a, _gain(path))
        cues.append({"t": round(a, 3), "kind": "bed", "name": seg["bed"]})
    for sc in scenes:
        if sc["type"] == "chapter":
            _place(music, _read(stems["card_sting"]), sc["start"], _gain(stems["card_sting"]) * 0.9)
            cues.append({"t": sc["start"], "kind": "music", "name": "card_sting"})
    if end_card:
        _place(music, _read(stems["button_end"]), end_card["start"], _gain(stems["button_end"]))
        cues.append({"t": end_card["start"], "kind": "music", "name": "button_end"})
    flips = [_read(p, resample=True) for p in sfx["page-flip"]]
    events = [_flip_event(f) for f in flips]
    for i, sc in enumerate(scenes):
        if i and sc["transition"] == "page":
            k = i % len(flips)
            loud, centroid, level = events[k]
            anchor, want = (loud, TURN) if loud > FLIP_THUD_AFTER else (centroid, TURN / 2)  # a thud meets the fold's end, a rustle its middle
            t = max(0.0, sc["start"] + want - anchor)  # never before the cut begins
            _place(fx, flips[k], t, 10 ** ((FLIP_EVENT_DBFS - level) / 20) if level > -100 else 1.0)
            cues.append({"t": round(t, 3), "kind": "sfx", "name": "page-flip"})  # where the sample starts
    _place(fx, _read(sfx["book-open"][0], resample=True), 0.15, 10 ** (-9 / 20))
    cues.append({"t": 0.15, "kind": "sfx", "name": "book-open"})
    if end_card:
        _place(fx, _read(sfx["book-close"][0], resample=True), end_card["start"] + 0.3, 10 ** (-6 / 20))
        cues.append({"t": end_card["start"] + 0.3, "kind": "sfx", "name": "book-close"})
    cues.sort(key=lambda c: c["t"])
    return music, fx, cues


def kit_sfx() -> dict[str, list[Path]]:
    from tools.shorted.kit import resolve

    out = {tag: sorted(Path(a["file"]) for a in resolve("sfx", sfx=tag)) for tag in ("page-flip", "book-open", "book-close")}
    missing = [k for k, v in out.items() if not v]
    if missing:
        raise RuntimeError(f"kit has no sfx tagged {missing}; run the kit seed (Task 10)")
    return out


def score_cut(project_dir: Path, cut: str, stems: dict[str, Path] | None = None, sfx: dict[str, list[Path]] | None = None) -> dict:
    import soundfile as sf

    from tools.shorted.music_theme import ensure_stems

    pd = Path(project_dir)
    scenes = json.loads((pd / "artifacts" / f"timeline.{cut}.json").read_text())["scenes"]
    duration = json.loads((pd / "artifacts" / f"timeline.{cut}.meta.json").read_text())["duration"]
    music, fx, cues = build_score(scenes, duration, stems or ensure_stems(), sfx or kit_sfx())
    out = pd / "assets" / "music" / cut
    out.mkdir(parents=True, exist_ok=True)
    sf.write(out / "music.wav", music.astype(np.float32), SR, subtype="FLOAT")  # a 16-bit WAV would clip whatever sums past full scale
    sf.write(out / "sfx.wav", fx.astype(np.float32), SR, subtype="FLOAT")
    report = {"cut": cut, "duration": duration, "cues": cues}
    (pd / "artifacts" / f"score.{cut}.json").write_text(json.dumps(report, indent=1))
    return report


class ShortedScore(BaseTool):
    name = "shorted_score"
    version = "1.0.0"
    tier = ToolTier.CORE
    capability = "music_and_mix"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        from tools.shorted.mixdown import mixdown

        project_dir = inputs.get("project_dir")
        if not project_dir or not isinstance(project_dir, (str, Path)):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(project_dir)
        if not pd.is_dir():
            return ToolResult(success=False, error=f"project folder {pd} does not exist")
        cuts = [c for c in ("long", "short") if (pd / "artifacts" / f"timeline.{c}.json").exists()]
        if not cuts:
            return ToolResult(success=False, error="no timeline.long.json or timeline.short.json in artifacts/; "
                                                   "run the timeline stage first")
        reports = {}
        for cut in cuts:
            try:
                score_cut(pd, cut)
                reports[cut] = mixdown(pd, cut)
            except (RuntimeError, OSError, KeyError, ValueError) as err:  # a missing kit, a missing file, a torn JSON (a ValueError), a bad sample rate
                why = f"an artifact lacks the entry {err}; re-run the stage that wrote it" if isinstance(err, KeyError) else str(err)
                return ToolResult(success=False, error=f"{cut} score failed: {why}")
        bad = [c for c, r in reports.items() if abs(r["integrated_lufs"] + 14) > 1 or r["true_peak_dbtp"] > -1.4]
        return ToolResult(success=not bad, data=reports, error=f"mix out of spec: {bad}" if bad else None,
                          artifacts=[str(pd / "assets" / "audio" / f"mix.{c}.wav") for c in cuts])
```

- [ ] **Step 4: Implement `mixdown.py`**

```python
"""Mix narration, music and effects into the master for one cut.

The film's mix.py chain, with every gain computer at a 1 kHz control rate so a five-minute mix
stays quick:
  voice   lines on the timeline; high-pass 75 Hz, +2.5 dB at 3.2 kHz, gentle 2:1 compression
  music   three-band ducking under the voice (low -4, mid -8, high -5 dB), 90 ms look-ahead, 420 ms release
  effects -2 dB under the voice
  master  -14 LUFS integrated, true-peak limited to -1.6 dBTP by the 4x-oversampled meter. That meter reads clicks about
          0.1 dB under an 8x estimate, so the spec's -1.5 dBTP holds at 8x (AAC encodes then measure about -1.4 dBTP)

Every file it reads (narration lines and the score's two buses) must be 48 kHz: it never resamples, so one at another
rate raises a ValueError naming the file rather than playing at the wrong speed.

The report, artifacts/mix.<cut>.json:
  integrated_lufs, true_peak_dbtp, max_limiter_reduction_db   the master, by the 4x meter; the deepest of the two limiter passes
  vo_lufs_during_speech, music_lufs_during_speech             each bus where the speech key is above 0.95 (null with a second or less)
  duck_depth_db       how far the ducking takes the music down under that speech: the un-ducked music's loudness less the
                      ducked music's, in LU. Numeric whenever there is more than a second of speech.
  music_lufs_without_speech   the music where the key is under 0.05. Null when the voice is never silent for 1.4 s or more (the key
                      takes that long to fall that far after the voice stops), as in a cut without chapter cards: read duck_depth_db
                      instead, which needs no quiet gap.
  speech_to_music_db  voice less music during speech; absent when either is null
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

SR = 48000
CTRL = 48  # samples per control block: 1 kHz
GAIN = {"vo": 0.0, "music": -4.0, "sfx": -3.0}
DUCK = {"low": -4.0, "mid": -8.0, "high": -5.0, "sfx": -2.0}
TARGET_LUFS = -14.0
CEILING_DBTP = -1.6  # by the 4x meter, which under-reads clicks by about 0.1 dB: the spec's -1.5 dBTP then holds at 8x


def _blocks(x: np.ndarray, fn=np.max) -> np.ndarray:
    pad = (-len(x)) % CTRL
    return fn(np.pad(x, (0, pad)).reshape(-1, CTRL), axis=1)


def _to_samples(g: np.ndarray, n: int) -> np.ndarray:
    return np.interp(np.arange(n), (np.arange(len(g)) + 0.5) * CTRL, g)


def _follow(x: np.ndarray, attack: float, release: float, attack_when_rising: bool) -> np.ndarray:
    rate = SR / CTRL
    a, r = math.exp(-1 / (attack * rate)), math.exp(-1 / (release * rate))
    out = np.empty_like(x)
    cur = float(x[0]) if len(x) else 0.0
    for i, v in enumerate(x):
        c = a if (v > cur) == attack_when_rising else r
        cur = c * cur + (1 - c) * v
        out[i] = cur
    return out


def _peaking(f0: float, gain_db: float, q: float):
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    b = np.array([1 + alpha * A, -2 * np.cos(w0), 1 - alpha * A])
    a = np.array([1 + alpha / A, -2 * np.cos(w0), 1 - alpha / A])
    return b / a[0], a / a[0]


def compress(x: np.ndarray, thresh_db=-24.0, ratio=2.0, attack=0.008, release=0.14) -> np.ndarray:
    level = 20 * np.log10(np.maximum(_blocks(np.abs(x)), 1e-6))
    g = _follow(-np.maximum(0.0, level - thresh_db) * (1 - 1 / ratio), attack, release, attack_when_rising=False)
    return x * 10 ** (_to_samples(g, len(x)) / 20)


def duck_key(vo: np.ndarray) -> np.ndarray:
    """1 while the voice speaks (gaps under 250 ms bridged, 90 ms look-ahead), 0 otherwise, smoothed."""
    from scipy.ndimage import minimum_filter1d

    rms = np.sqrt(np.convolve(_blocks(vo ** 2, np.mean), np.ones(20) / 20, mode="same"))
    gate = (20 * np.log10(np.maximum(rms, 1e-9)) > -46).astype(float)
    gate = 1 - minimum_filter1d(1 - gate, size=250)
    ahead = np.concatenate([gate[90:], np.zeros(90)])
    return _to_samples(_follow(np.maximum(gate, ahead), 0.06, 0.42, attack_when_rising=True), len(vo))


def _true_peak_blocks(x: np.ndarray) -> np.ndarray:
    """Per control block, the 4x-oversampled absolute peak across channels; ten seconds at a time."""
    from scipy import signal

    n = len(x)
    out = np.zeros(math.ceil(n / CTRL))
    chunk, pad = CTRL * 10000, CTRL * 4
    for a in range(0, n, chunk):
        lo, b = max(0, a - pad), min(n, a + chunk)
        up = signal.resample_poly(x[lo: min(n, b + pad)], 4, 1, axis=0)
        pk = np.abs(up).max(axis=1)[(a - lo) * 4: (b - lo) * 4]
        blocks = np.pad(pk, (0, (-len(pk)) % (CTRL * 4))).reshape(-1, CTRL * 4).max(axis=1)
        out[a // CTRL: a // CTRL + len(blocks)] = blocks
    return out


def true_peak_db(x: np.ndarray) -> float:
    x = x if x.ndim == 2 else x[:, None]
    return float(20 * np.log10(_true_peak_blocks(x).max() + 1e-12))


def limit(x: np.ndarray, ceiling_db: float = CEILING_DBTP, release: float = 0.08) -> tuple[np.ndarray, float]:
    """Look-ahead true-peak limiter: instant attack (5 ms look-ahead), exponential release."""
    from scipy.ndimage import minimum_filter1d

    req = np.minimum(1.0, 10 ** (ceiling_db / 20) / np.maximum(_true_peak_blocks(x), 1e-9))
    req = minimum_filter1d(req, size=11, mode="nearest")
    r = math.exp(-1 / (release * SR / CTRL))
    g = np.empty_like(req)
    cur = 1.0
    for i, v in enumerate(req):
        cur = v if v < cur else r * cur + (1 - r) * v
        g[i] = cur
    return x * _to_samples(g, len(x))[:, None], float(20 * np.log10(g.min()))


def _fit(y: np.ndarray, n: int) -> np.ndarray:
    y = y if y.ndim == 2 else np.stack([y, y], axis=1)
    out = np.zeros((n, 2))
    out[: min(n, len(y))] = y[:n]
    return out


def _load(path: Path) -> np.ndarray:
    """A 48 kHz file as float64. The mix never resamples, so a file at another rate (which would play at the wrong speed) is an
    error naming it."""
    import soundfile as sf

    y, sr = sf.read(path)
    if sr != SR:
        raise ValueError(f"{path} is {sr} Hz, not {SR} Hz; the mix is built at {SR} Hz")
    return y


def mixdown(project_dir: Path, cut: str) -> dict:
    """Mix one cut into assets/audio/mix.<cut>.wav and write artifacts/mix.<cut>.json (the report's fields are in the module docstring).

    music_lufs_without_speech is null when the voice is never silent for 1.4 s or more, e.g. a cut without chapter cards;
    duck_depth_db is numeric whenever there is more than a second of speech. A file at a rate other than 48 kHz is a ValueError."""
    import pyloudnorm as pyln
    import soundfile as sf
    from scipy import signal

    pd = Path(project_dir)
    meta = json.loads((pd / "artifacts" / f"timeline.{cut}.meta.json").read_text())
    n = int(round(meta["duration"] * SR))
    vo = np.zeros(n)
    for ln in meta["lines"]:
        x = _load(pd / ln["file"])
        x = x if x.ndim == 1 else x.mean(axis=1)
        p = int(round(ln["start"] * SR))
        k = min(len(x), n - p)
        if k > 0:
            vo[p: p + k] += x[:k]
    vo = signal.sosfilt(signal.butter(2, 75, "highpass", fs=SR, output="sos"), vo)
    vo = compress(signal.lfilter(*_peaking(3200, 2.5, 0.9), vo))
    key = duck_key(vo)
    voice = np.stack([vo, vo], axis=1) * 10 ** (GAIN["vo"] / 20)
    music = _fit(_load(pd / "assets" / "music" / cut / "music.wav"), n) * 10 ** (GAIN["music"] / 20)
    low = signal.sosfiltfilt(signal.butter(4, 250, "lowpass", fs=SR, output="sos"), music, axis=0)
    high = signal.sosfiltfilt(signal.butter(4, 4500, "highpass", fs=SR, output="sos"), music, axis=0)
    ducked = (low * (10 ** (DUCK["low"] * key / 20))[:, None] + (music - low - high) * (10 ** (DUCK["mid"] * key / 20))[:, None]
              + high * (10 ** (DUCK["high"] * key / 20))[:, None])
    fx = _fit(_load(pd / "assets" / "music" / cut / "sfx.wav"), n) * 10 ** (GAIN["sfx"] / 20) * (10 ** (DUCK["sfx"] * key / 20))[:, None]
    mix = voice + ducked + fx
    meter = pyln.Meter(SR)
    gain = 10 ** ((TARGET_LUFS - meter.integrated_loudness(mix)) / 20)
    master, red1 = limit(mix * gain)
    fade = int(0.45 * SR)
    master[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    trim = 10 ** ((TARGET_LUFS - meter.integrated_loudness(master)) / 20)
    master, red2 = limit(master * trim)
    out = pd / "assets" / "audio" / f"mix.{cut}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, master.astype(np.float32), SR, subtype="PCM_24")

    def loud(x: np.ndarray, mask: np.ndarray) -> float | None:
        """Integrated loudness of x where mask holds; None when that is a second of audio or less."""
        y = x[mask]
        return float(meter.integrated_loudness(y)) if len(y) > SR else None

    def r2(v: float | None) -> float | None:
        return None if v is None else round(v, 2)

    g = gain * trim
    speaking = key > 0.95
    vo_in, bare, under, quiet = loud(voice * g, speaking), loud(music * g, speaking), loud(ducked * g, speaking), loud(ducked * g, key < 0.05)
    report = {"integrated_lufs": round(float(meter.integrated_loudness(master)), 2),
              "true_peak_dbtp": round(true_peak_db(master), 2), "max_limiter_reduction_db": round(min(red1, red2), 2),
              "vo_lufs_during_speech": r2(vo_in), "music_lufs_during_speech": r2(under),
              # null when the voice is never silent for 1.4 s or more (the key needs that long to fall under 0.05), as in a cut without
              # chapter cards: the music is then never measured bare, and duck_depth_db is the figure that still reads
              "music_lufs_without_speech": r2(quiet),
              # un-ducked less ducked music under the same speech: numeric whenever there is more than a second of it
              "duck_depth_db": None if bare is None or under is None else round(bare - under, 2),
              "duration": meta["duration"]}
    if report["vo_lufs_during_speech"] is not None and report["music_lufs_during_speech"] is not None:
        report["speech_to_music_db"] = round(report["vo_lufs_during_speech"] - report["music_lufs_during_speech"], 2)
    (pd / "artifacts" / f"mix.{cut}.json").write_text(json.dumps(report, indent=1))
    return report
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_score_mix.py -q`
Expected: PASS (55 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/score.py tools/shorted/mixdown.py tests/shorted/test_score_mix.py
git commit -m "feat(shorted): chapter-aligned score and the ducked, limited -14 LUFS mix"
```

---

## Part F: render, QA, reflection and the entry point

### Task 22: Render and mux

**Files:**
- Create: `tools/shorted/render.py`
- Modify: `tests/shorted/sample.py` (append the render stand-ins)
- Test: `tests/shorted/test_render.py`

**Interfaces:**
- Consumes: `timeline.<cut>.json`, `thumb.json`, `chapters.long.ffmeta` (Task 20); `assets/audio/mix.<cut>.wav` (Task 21); the Remotion compositions (Tasks 16–17).
- Produces:
  - `remotion_cli(args)`, which runs `npx remotion …` in `remotion-composer/`.
  - `mux(video, audio, out, ffmeta=None)`: H.264 stream copy with the BT.709 VUI and container tags, AAC 256 kb/s at 48 kHz, chapters, and faststart.
  - `render_cut(project_dir, cut, remotion)` writes `renders/<T>_<cut>_<W>x<H>_{captioned,clean}.mp4`.
  - `render_stills(project_dir, remotion)` writes `renders/<T>_thumb_1920x1080.png`, `<T>_cover_1080x1920.png` and `<T>_thumb_1280x720.jpg`.
  - `render_all(project_dir, remotion) -> report` renders the stills before the videos and writes `artifacts/render.json` (`{videos, stills, subtitles, chapters}`, with paths relative to the project).
  - Tool `shorted_render`. It never raises for an incomplete run. Without a `project_dir` folder, or without `artifacts/timeline.long.json` or `artifacts/timeline.short.json`, it returns `success=False` (a missing timeline: "run the timeline stage first"). It catches `RenderError`, `subprocess.CalledProcessError`, `OSError`, `KeyError` and `ValueError` into `success=False`.
  - `sample.py` gains `fake_stems`, `fake_sfx`, `fake_remotion` and `mix_run`.

- [ ] **Step 1: Add the stand-ins to the sample**

Append to `tests/shorted/sample.py`:

```python
def fake_stems(folder: Path) -> dict[str, Path]:
    """Noise stand-ins for the score stems, with the metadata score.py reads."""
    import soundfile as sf

    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    out = {}
    for name, bars in {"sting_open": 2, "card_sting": 1, "bed_groove": 8, "bed_calm": 8, "bed_tension": 8, "button_end": 2}.items():
        p = folder / f"{name}.flac"
        sf.write(p, (0.05 * rng.standard_normal((int((bars * 2.5 + 2.5) * 48000), 2))).astype(np.float32), 48000, subtype="PCM_24")
        p.with_suffix(".json").write_text(json.dumps({"bars": bars, "lufs": -20.0, "target_lufs": -20.0,
                                                      "loop_seconds": bars * 2.5 if name.startswith("bed") else None}))
        out[name] = p
    return out


def fake_sfx(folder: Path) -> dict[str, list[Path]]:
    import soundfile as sf

    folder.mkdir(parents=True, exist_ok=True)
    p = folder / "paper.wav"
    sf.write(p, (0.3 * np.hanning(4800)).astype(np.float32), 48000)
    return {"page-flip": [p], "book-open": [p], "book-close": [p]}


def fake_remotion(args: list[str]) -> None:
    """Stand-in for the Remotion CLI: a solid-colour H.264 file (or a PNG) of the right size and length."""
    import subprocess

    from PIL import Image

    props = json.loads(Path(next(a for a in args if a.startswith("--props="))[8:]).read_text())
    out = Path(args[3])
    if args[0] == "still":
        Image.new("RGB", (1920, 1080) if args[2] == "ShortedThumb" else (1080, 1920), (31, 59, 51)).save(out)
        return
    seconds = props["durationInFrames"] / props["fps"]
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=0x1F3B33:s={props['width']}x{props['height']}:r={props['fps']}:d={seconds}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(out)], check=True)


def mix_run(pd: Path, stems: dict[str, Path], sfx: dict[str, list[Path]]) -> None:
    """Timeline, score and mix for both cuts, with stand-in stems."""
    from tools.shorted.mixdown import mixdown
    from tools.shorted.score import score_cut
    from tools.shorted.timeline import write_cut

    for cut in ("long", "short"):
        write_cut(cut, pd)
        score_cut(pd, cut, stems=stems, sfx=sfx)
        mixdown(pd, cut)
```

- [ ] **Step 2: Write the failing tests**

`tests/shorted/test_render.py`:

```python
import json
import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from tests.shorted import sample
from tools.shorted.render import REMOTION, RenderError, ShortedRender, mux, render_all


def probe(path) -> dict:
    res = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_chapters", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def test_mux_tags_colour_audio_and_chapters(tmp_path):
    video = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=4",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True)
    sf.write(tmp_path / "a.wav", (0.1 * np.random.default_rng(0).standard_normal((4 * 48000, 2))).astype(np.float32), 48000)
    (tmp_path / "c.ffmeta").write_text(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n"
                                       "[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Two\n")
    mux(video, tmp_path / "a.wav", tmp_path / "out.mp4", tmp_path / "c.ffmeta")
    info = probe(tmp_path / "out.mp4")
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (v["color_primaries"], v["color_transfer"], v["color_space"]) == ("bt709", "bt709", "bt709")
    assert a["codec_name"] == "aac" and a["sample_rate"] == "48000"
    assert [c["tags"]["title"] for c in info["chapters"]] == ["One", "Two"]


def test_the_tool_refuses_a_missing_or_empty_project(tmp_path, monkeypatch):
    assert not ShortedRender().execute({}).success
    res = ShortedRender().execute({"project_dir": str(tmp_path / "no-such-run")})
    assert not res.success and "no-such-run" in res.error
    res = ShortedRender().execute({"project_dir": str(tmp_path)})
    assert not res.success and "run the timeline stage first" in res.error
    (tmp_path / "artifacts").mkdir()
    (tmp_path / "artifacts/timeline.short.json").write_text("{")  # half-written: render_all raises a JSONDecodeError
    res = ShortedRender().execute({"project_dir": str(tmp_path)})
    assert not res.success and "JSONDecodeError" in res.error

    def raising(err):
        def fake_render_all(pd):
            raise err
        return fake_render_all

    for err in (RenderError("remotion render failed"), subprocess.CalledProcessError(1, ["ffmpeg"]), OSError("disk full"),
                KeyError("ticker")):
        monkeypatch.setattr("tools.shorted.render.render_all", raising(err))
        assert not ShortedRender().execute({"project_dir": str(tmp_path)}).success, err


@pytest.fixture(scope="module")
def mixed(tmp_path_factory):
    root = tmp_path_factory.mktemp("render")
    pd = sample.make_run(root)
    sample.mix_run(pd, sample.fake_stems(root / "stems"), sample.fake_sfx(root / "sfx"))
    return pd


def test_render_all_with_a_stand_in_renderer(mixed):
    report = render_all(mixed, remotion=sample.fake_remotion)
    assert sorted(report["videos"]) == sorted([
        "renders/EXM_long_1920x1080_captioned.mp4", "renders/EXM_long_1920x1080_clean.mp4",
        "renders/EXM_short_1080x1920_captioned.mp4", "renders/EXM_short_1080x1920_clean.mp4"])
    assert len(report["stills"]) == 3 and report["chapters"] == "renders/EXM_long_chapters.txt"
    info = probe(mixed / "renders/EXM_long_1920x1080_captioned.mp4")
    assert any(s["codec_type"] == "audio" for s in info["streams"]) and info["chapters"]
    assert json.loads((mixed / "artifacts/render.json").read_text())["videos"] == report["videos"]


@pytest.mark.slow
def test_real_render_of_the_short(tmp_path):
    public = REMOTION / "public"
    pd = sample.make_run(tmp_path, public_root=public)
    try:
        sample.mix_run(pd, sample.fake_stems(tmp_path / "stems"), sample.fake_sfx(tmp_path / "sfx"))
        (pd / "artifacts/timeline.long.json").unlink()  # the short is enough to prove the contract
        render_all(pd)
        video = pd / "renders/EXM_short_1080x1920_captioned.mp4"
        res = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=nb_read_frames", "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True)
        assert int(res.stdout.strip()) == json.loads((pd / "artifacts/timeline.short.json").read_text())["durationInFrames"]
        assert (pd / "renders/EXM_thumb_1920x1080.png").exists() and (pd / "renders/EXM_cover_1080x1920.png").exists()
    finally:
        shutil.rmtree(public / "shorted-runs" / pd.name, ignore_errors=True)
```

- [ ] **Step 3: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_render.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.render'`.

- [ ] **Step 4: Implement `render.py`**

```python
"""Render both cuts (captioned and clean), the thumbnail and the cover with Remotion, then mux the
mix with BT.709 colour tags, AAC 256 kb/s and, for the long cut, chapter metadata."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolTier

REPO = Path(__file__).resolve().parents[2]
REMOTION = REPO / "remotion-composer"
ENTRY = "src/shorted/index.tsx"
COMPOSITION = {"long": "ShortedLong", "short": "ShortedShort"}
COLOR = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
VUI = "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"
Remotion = Callable[[list[str]], None]


class RenderError(RuntimeError):
    pass


def remotion_cli(args: list[str]) -> None:
    res = subprocess.run(["npx", "remotion", *args], cwd=REMOTION, capture_output=True, text=True, timeout=7200)
    if res.returncode != 0:
        raise RenderError(f"remotion {args[0]} failed:\n{(res.stderr or res.stdout)[-3000:]}")


def mux(video: Path, audio: Path, out: Path, ffmeta: Path | None = None) -> None:
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(audio)]
    if ffmeta:
        cmd += ["-i", str(ffmeta), "-map_chapters", "2"]
    cmd += ["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-bsf:v", VUI, *COLOR,
            "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)


def render_cut(project_dir: Path, cut: str, remotion: Remotion = remotion_cli) -> list[Path]:
    pd = Path(project_dir)
    props = json.loads((pd / "artifacts" / f"timeline.{cut}.json").read_text())
    raw_dir = pd / "renders" / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    ffmeta = pd / "artifacts" / "chapters.long.ffmeta"
    outs = []
    for kind, show in (("captioned", True), ("clean", False)):
        props_file = raw_dir / f"{cut}.{kind}.props.json"
        props_file.write_text(json.dumps({**props, "showCaptions": show}))
        raw = raw_dir / f"{cut}.{kind}.mp4"
        remotion(["render", ENTRY, COMPOSITION[cut], str(raw), f"--props={props_file}", "--codec=h264", "--crf=16",
                  "--color-space=bt709", "--pixel-format=yuv420p", "--muted"])
        out = pd / "renders" / f"{props['ticker']}_{cut}_{props['width']}x{props['height']}_{kind}.mp4"
        mux(raw, pd / "assets" / "audio" / f"mix.{cut}.wav", out, ffmeta if cut == "long" and ffmeta.exists() else None)
        outs.append(out)
    return outs


def render_stills(project_dir: Path, remotion: Remotion = remotion_cli) -> list[Path]:
    from PIL import Image

    pd = Path(project_dir)
    thumb = pd / "artifacts" / "thumb.json"
    ticker = json.loads(thumb.read_text())["ticker"]
    outs = []
    for comp, name in (("ShortedThumb", "thumb_1920x1080"), ("ShortedCover", "cover_1080x1920")):
        out = pd / "renders" / f"{ticker}_{name}.png"
        remotion(["still", ENTRY, comp, str(out), f"--props={thumb}"])
        outs.append(out)
    jpg = pd / "renders" / f"{ticker}_thumb_1280x720.jpg"
    Image.open(outs[0]).convert("RGB").resize((1280, 720), Image.LANCZOS).save(jpg, quality=90)
    return outs + [jpg]


def render_all(project_dir: Path, remotion: Remotion = remotion_cli) -> dict:
    pd = Path(project_dir)
    cuts = [c for c in ("long", "short") if (pd / "artifacts" / f"timeline.{c}.json").exists()]
    rel = lambda p: str(Path(p).relative_to(pd))
    # Stills first: a headline row the cover refuses fails in seconds, not after four video renders.
    stills = [rel(p) for p in render_stills(pd, remotion)]
    videos = [rel(p) for cut in cuts for p in render_cut(pd, cut, remotion)]
    shutil.rmtree(pd / "renders" / "_raw", ignore_errors=True)
    chapters = next((rel(p) for p in (pd / "renders").glob("*_long_chapters.txt")), None)
    report = {"videos": videos, "stills": stills, "chapters": chapters,
              "subtitles": sorted(rel(p) for p in (pd / "renders").iterdir() if p.suffix in (".srt", ".vtt"))}
    (pd / "artifacts" / "render.json").write_text(json.dumps(report, indent=1))
    return report


class ShortedRender(BaseTool):
    name = "shorted_render"
    version = "1.0.0"
    tier = ToolTier.CORE
    capability = "video_render"
    provider = "shorted"
    resource_profile = ResourceProfile(cpu_cores=8, ram_mb=8192, disk_mb=4000)
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        if not inputs.get("project_dir"):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(inputs["project_dir"])
        if not pd.is_dir():
            return ToolResult(success=False, error=f"no project folder at {pd}")
        if not any((pd / "artifacts" / f"timeline.{cut}.json").exists() for cut in COMPOSITION):
            return ToolResult(success=False, error="no timeline.long.json or timeline.short.json in artifacts/; "
                                                   "run the timeline stage first")
        try:
            report = render_all(pd)
        # a failed render or mux, or an earlier stage's output missing, half-written or out of step
        except (RenderError, subprocess.CalledProcessError, OSError, KeyError, ValueError) as err:
            return ToolResult(success=False, error=f"{type(err).__name__}: {str(err)[-3000:]}")
        return ToolResult(success=True, data=report, artifacts=report["videos"] + report["stills"])
```

- [ ] **Step 5: Run the tests (fast, then the real render)**

Run: `.venv/bin/python -m pytest tests/shorted/test_render.py -q && .venv/bin/python -m pytest tests/shorted/test_render.py -q -m slow`
Expected: 3 tests pass, then the slow one (a real Remotion render of the sample's short cut, about 2 minutes). Play `renders/EXM_short_1080x1920_captioned.mp4` from the test's temporary folder (pytest prints its path on failure; add `-s` and `print(pd)` to keep it). Watch for page turns on each scene change, the caption underline moving with the voice track, and the caveat label on the chart scene.

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/render.py tests/shorted/sample.py tests/shorted/test_render.py
git commit -m "feat(shorted): Remotion renders, stills and BT.709 mux with chapters"
```

### Task 23: QA

**Files:**
- Create: `tools/shorted/qa.py`
- Modify: `skills/pipelines/shorted-results/review-director.md` (the QA table's `spoken_figures` and `wer` rows)
- Test: `tests/shorted/test_qa.py`

**Interfaces:**
- Consumes:
  - `build_cut`, `BOUNDS`, `split_lines` (Task 20); `ending_heard`, `figures`, `normalize`, `wer`, `transcribe_words` (Task 19); `resolve_text` (Task 7);
  - `timeline.<cut>.meta.json` `lines` (Task 20: `{id, start, end, ...}` in seconds from the start of the cut); `narration.json` (Task 19: each line's `spoken` and `wer`); `assets/audio/mix.<cut>.wav` (Task 21);
  - `artifacts/render.json` (Task 22).
- Produces:
  - Checks, each returning `{ok, detail, fix_in}`:
    - `number_audit(pd, cut)`: the shipped timeline props equal a fresh resolution from the storyboard and dossier, and the narration's spoken text is current;
    - `speech_checks(pd, cut, asr) -> (spoken_figures, wer)`. Each line is cut out of the final mix at its own window: its span padded 0.1 s before and 0.25 s after (`PAD_BEFORE`, `PAD_AFTER`, so the take's tail is in it), stopping `CLEARANCE` 0.05 s short of the lines either side and kept inside the mix (the timeline's 0.3 s gaps hold both pads). The window is written to a temporary WAV and heard by `asr(clip, spoken)`, where `spoken` is the line's take text in `narration.json`. Whether the takes still match the script stays `number_audit`'s job:
      - `spoken_figures`: each line carries its take's figures exactly (sign, digits and scale). Its detail is `{lines: [{id, missing, extra, heard}]}` for the failing lines, with figures shown as the voice stage shows them ("216.5 million", "-73", "up 73"); fix_in `score`;
      - `wer`: no line is unheard (its WER over `UNHEARD_WER` 0.5) or cut short (`ending_heard(spoken, heard)` is false; a line not heard at all is listed only as unheard), and the cut's WER (each line's WER weighted by its words) is within `MAX_WER_GAIN` 0.03 of the takes' own WER, weighted the same way. Its detail is `{wer, takes_wer, unheard, ending_missing, worst}`; fix_in `score`;
    - `caption_check(pd, cut)`;
    - `video_checks(pd, cut, render)`, covering duration, A/V sync, BT.709 tags, loudness and true peak for each video. A video with no audio stream is not measured: its `loudness:<name>` fails with "no audio stream" (fix_in `render`), and its `av_sync` fails too;
    - `contact_sheet(pd, cut, video) -> Path`.
  - `run_qa(pd, asr=whisper_asr) -> report`, which writes `artifacts/qa.json` `{overall: pass|fail, cuts: {cut: {check: {...}}}}`. With no `timeline.<cut>.json` at all, `overall` is `fail` and `cuts` holds one entry, `run`, with the check `cuts`: `no timeline.<cut>.json in artifacts/`, fix_in `timeline`.
  - Thresholds: each line's figures exactly; every line heard (WER ≤ 0.5 in its window) and heard to its end; the cut's WER ≤ the takes' WER + 0.03; ≤ 20 characters/s, ≤ 42 characters per line, ≤ 4 words per short-cut page, −14 ± 1 LUFS, ≤ −1.0 dBTP, durations within `BOUNDS`, A/V within 0.1 s.
  - Tool `shorted_qa` (its `success` is the overall pass). It never raises for an incomplete run: with no `project_dir` folder, or with an artefact missing, half-written or unreadable, it returns `success=False` and an error that names the artefact. It catches `OSError`, `KeyError`, `ValueError`, `RuntimeError` (soundfile's `LibsndfileError`) and `subprocess.CalledProcessError` (ffprobe on a corrupt file).

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_qa.py`:

```python
import json
import subprocess

import numpy as np
import pytest
import soundfile as sf

from tests.shorted import sample
from tools.shorted.asr import normalize
from tools.shorted.narration import MAX_LINE_WER
from tools.shorted.qa import ShortedQA, caption_check, number_audit, run_qa, speech_checks, video_checks


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    root = tmp_path_factory.mktemp("qa")
    pd = sample.make_run(root)
    sample.mix_run(pd, sample.fake_stems(root / "stems"), sample.fake_sfx(root / "sfx"))
    return pd


def heard_as(edit):
    """A stand-in recogniser that hears each line as edit(the take's spoken text)."""
    return lambda path, spoken: sample.fake_asr(path, edit(spoken))


def test_number_audit_passes_then_catches_an_edit(run):
    assert number_audit(run, "long")["ok"]
    path = run / "artifacts/timeline.long.json"
    original = path.read_text()
    try:
        path.write_text(original.replace("A$216.5M", "A$216.4M", 1))
        res = number_audit(run, "long")
        assert not res["ok"] and res["fix_in"] == "timeline"
    finally:
        path.write_text(original)


def test_spoken_figures_catch_a_dropped_figure(run):
    figs, _ = speech_checks(run, "short", heard_as(lambda s: s.replace("216.5", "", 1)))
    assert not figs["ok"] and figs["fix_in"] == "score"
    assert "216.5 million" in [f for ln in figs["detail"]["lines"] for f in ln["missing"]]
    figs, score = speech_checks(run, "short", sample.fake_asr)
    assert figs["ok"] and score["ok"]


def test_spoken_figures_catch_a_changed_scale_or_sign(run):
    figs, _ = speech_checks(run, "short", heard_as(lambda s: s.replace(" million", " billion")))
    revenue = next(ln for ln in figs["detail"]["lines"] if ln["missing"] == ["216.5 million"])
    assert not figs["ok"] and revenue["extra"] == ["216.5 billion"]
    figs, _ = speech_checks(run, "short", heard_as(lambda s: s.replace("up 73.1", "down 73.1")))
    assert [(ln["missing"], ln["extra"]) for ln in figs["detail"]["lines"]] == [(["up 73.1"], ["down 73.1"])]


def test_a_line_lost_in_the_mix_fails_wer(run):
    lost = json.loads((run / "artifacts/narration.json").read_text())["long"]["L001"]["spoken"]  # said once in the long cut
    _, score = speech_checks(run, "long", lambda path, spoken: [] if spoken == lost else sample.fake_asr(path, spoken))
    assert not score["ok"] and score["detail"]["unheard"] == ["L001"]
    assert score["detail"]["wer"] <= score["detail"]["takes_wer"] + 0.03  # the cut's own average would have passed
    assert score["detail"]["worst"] == [{"id": "L001", "wer": 1.0, "heard": ""}]
    assert score["detail"]["ending_missing"] == []  # a line not heard at all is listed once, as unheard


def test_a_line_cut_short_in_the_mix_fails_wer(run):
    cut_short = heard_as(lambda s: " ".join(s.split()[:-2]) if s.startswith("Short interest stands") else s)
    _, score = speech_checks(run, "short", cut_short)
    assert not score["ok"] and score["detail"]["ending_missing"] == ["L001"] and score["detail"]["unheard"] == []
    assert score["detail"]["wer"] <= score["detail"]["takes_wer"] + 0.03  # two words of the cut's 184: within tolerance


def test_wer_allows_a_word_but_not_a_word_a_line(run):
    every = heard_as(lambda s: s + " indeed")
    _, score = speech_checks(run, "short", every)
    assert not score["ok"] and score["detail"]["unheard"] == []
    lines = json.loads((run / "artifacts/timeline.short.meta.json").read_text())["lines"]
    takes = json.loads((run / "artifacts/narration.json").read_text())["short"]
    words = sum(len(normalize(takes[ln["id"]]["spoken"])) for ln in lines)
    assert score["detail"]["wer"] == round(len(lines) / words, 4)  # every line's edits over every line's words
    _, score = speech_checks(run, "short", heard_as(lambda s: s + " indeed" if s.startswith("Short interest stands") else s))
    assert score["ok"] and score["detail"]["wer"] > 0
    path = run / "artifacts/narration.json"
    original = path.read_text()
    try:
        narration = json.loads(original)
        for take in narration["short"].values():
            take["wer"] = MAX_LINE_WER  # every take at the voice stage's own limit: the mix is judged against that
        path.write_text(json.dumps(narration))
        _, score = speech_checks(run, "short", every)
        assert score["ok"]
    finally:
        path.write_text(original)


def test_each_line_is_heard_in_its_own_padded_window(run):
    mix, sr = sf.read(run / "assets/audio/mix.short.wav")
    path = run / "artifacts/timeline.short.meta.json"
    original = path.read_text()

    def clips(meta):
        path.write_text(json.dumps(meta))
        out = []
        speech_checks(run, "short", lambda p, spoken: out.append(sf.read(p)[0]) or sample.fake_asr(p, spoken))
        return out

    def holds(clip, a, b):  # the clip is the mix from a to b seconds
        want = mix[round(a * sr): round(b * sr)]
        return clip.shape == want.shape and np.abs(clip - want).max() < 1e-3

    try:
        meta = json.loads(original)
        lines = meta["lines"]
        got = clips(meta)  # the timeline's 0.3 s gaps hold both pads: 0.1 s before, and the take's tail 0.25 s after
        assert len(got) == len(lines) and all(holds(c, ln["start"] - 0.1, ln["end"] + 0.25) for c, ln in zip(got, lines))
        lines[0]["start"], lines[1]["start"], lines[-1]["end"] = 0.05, lines[0]["end"] + 0.1, len(mix) / sr  # squeezed
        got = clips(meta)  # no window comes within 0.05 s of a neighbour's line, starts before 0 or ends past the mix
        assert holds(got[0], 0.0, lines[1]["start"] - 0.05) and holds(got[1], lines[0]["end"] + 0.05, lines[1]["end"] + 0.25)
        assert holds(got[-1], lines[-1]["start"] - 0.1, len(mix) / sr)
    finally:
        path.write_text(original)


def test_captions_flag_fast_cues(run):
    path = run / "artifacts/timeline.short.meta.json"
    original = path.read_text()
    try:
        meta = json.loads(original)
        meta["cues"][0] = {"start": 0.0, "end": 1.0, "text": "x" * 60}
        path.write_text(json.dumps(meta))
        assert not caption_check(run, "short")["ok"]
    finally:
        path.write_text(original)
    assert caption_check(run, "short")["ok"]


def test_the_tool_reports_an_incomplete_run_instead_of_raising(run, tmp_path):
    assert not ShortedQA().execute({}).success
    res = ShortedQA().execute({"project_dir": str(tmp_path / "no-such-run")})
    assert not res.success and "no-such-run" in res.error
    render, mix = run / "artifacts/render.json", run / "assets/audio/mix.long.wav"
    away = mix.with_name("mix.long.wav.away")
    saved = render.read_text() if render.exists() else None  # the slow test renders into this run
    try:
        render.unlink(missing_ok=True)
        no_render = ShortedQA().execute({"project_dir": str(run)})
        render.write_text('{"videos": [')
        half_written = ShortedQA().execute({"project_dir": str(run)})
        render.write_text('{"videos": []}')
        mix.rename(away)
        no_mix = ShortedQA().execute({"project_dir": str(run)})
    finally:
        if away.exists():
            away.rename(mix)
        render.unlink(missing_ok=True)
        if saved is not None:
            render.write_text(saved)
    assert not no_render.success and "render.json" in no_render.error
    assert not half_written.success and "render.json" in half_written.error
    assert not no_mix.success and "no assets/audio/mix.long.wav; run the score stage" in no_mix.error


def test_the_tool_reports_unreadable_media_instead_of_raising(run, tmp_path, monkeypatch):
    render, mix = run / "artifacts/render.json", run / "assets/audio/mix.long.wav"
    away = mix.with_name("mix.long.wav.away")
    saved = render.read_text() if render.exists() else None  # the slow test renders into this run
    try:
        render.write_text('{"videos": []}')
        mix.rename(away)
        mix.write_bytes(b"not audio")  # soundfile raises LibsndfileError, a RuntimeError
        bad_mix = ShortedQA().execute({"project_dir": str(run)})
    finally:
        if away.exists():
            away.rename(mix)
        render.unlink(missing_ok=True)
        if saved is not None:
            render.write_text(saved)
    assert not bad_mix.success and "mix.long.wav" in bad_mix.error
    (tmp_path / "renders").mkdir()
    (tmp_path / "renders/EXM_long_bad.mp4").write_bytes(b"not a video")  # ffprobe exits 1: CalledProcessError
    monkeypatch.setattr("tools.shorted.qa.run_qa", lambda pd: video_checks(pd, "long", {"videos": ["renders/EXM_long_bad.mp4"]}))
    bad_video = ShortedQA().execute({"project_dir": str(tmp_path)})
    assert not bad_video.success and "EXM_long_bad.mp4" in bad_video.error


def test_a_run_with_no_cut_fails(tmp_path):
    (tmp_path / "artifacts").mkdir()
    (tmp_path / "artifacts/render.json").write_text('{"videos": []}')
    report = run_qa(tmp_path, asr=sample.fake_asr)
    assert report == {"overall": "fail", "cuts": {"run": {"cuts": {
        "ok": False, "detail": "no timeline.<cut>.json in artifacts/", "fix_in": "timeline"}}}}
    res = ShortedQA().execute({"project_dir": str(tmp_path)})
    assert not res.success and "run/cuts (fix in timeline)" in res.error


def test_a_video_without_audio_fails_loudness_and_sync(tmp_path):
    video = tmp_path / "renders/EXM_short_1080x1920_captioned.mp4"
    video.parent.mkdir()
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=30:d=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True)
    checks = video_checks(tmp_path, "short", {"videos": [str(video.relative_to(tmp_path))]})
    assert checks[f"loudness:{video.stem}"] == {"ok": False, "detail": "no audio stream", "fix_in": "render"}
    assert not checks[f"av_sync:{video.stem}"]["ok"] and checks[f"av_sync:{video.stem}"]["detail"]["audio"] is None


@pytest.mark.slow
def test_full_qa_passes_on_a_stand_in_render(run):
    from tools.shorted.render import render_all

    render_all(run, remotion=sample.fake_remotion)
    report = run_qa(run, asr=sample.fake_asr)
    assert report["overall"] == "pass", json.dumps(report, indent=1)[:3000]
    assert (run / "renders/contact.long.jpg").exists()
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_qa.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.qa'`.

- [ ] **Step 3: Implement `qa.py`**

```python
"""QA for a rendered run. Each check returns {ok, detail, fix_in}: the stage to re-run when it fails.

number_audit    every rendered string equals a fresh resolution of its binding; narration is current
spoken_figures  each line, heard in its own window of the final mix, carries its take's figures (sign, digits, scale)
wer             every line heard (WER <= 0.5 in its window) and heard to its end; the cut's WER within 0.03 of the takes' own
captions        at most 20 characters a second, 42 per line, 4 words per short-cut page
video           duration in bounds, A/V within 0.1 s, BT.709 tags, -14 LUFS +/-1, true peak <= -1 dBTP
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolTier
from tools.shorted.asr import ending_heard, figures, normalize, wer
from tools.shorted.bindings import resolve_text
from tools.shorted.timeline import BOUNDS, build_cut, split_lines

UNHEARD_WER, MAX_WER_GAIN, MAX_CPS, MAX_LINE, MAX_PAGE_WORDS = 0.5, 0.03, 20.0, 42, 4
LUFS, LUFS_TOL, MAX_TP, MAX_SYNC = -14.0, 1.0, -1.0, 0.1
PAD_BEFORE, PAD_AFTER, CLEARANCE = 0.1, 0.25, 0.05  # a line's window, in seconds; the timeline's 0.3 s gaps hold both


def _check(ok: bool, detail, fix_in: str) -> dict:
    return {"ok": bool(ok), "detail": detail, "fix_in": fix_in}


def _load(pd: Path, name: str):
    """artifacts/<name>, parsed. A missing or half-written file raises an error that names it."""
    try:
        return json.loads((pd / "artifacts" / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise FileNotFoundError(f"no artifacts/{name}; run the stage that writes it") from None
    except ValueError as err:
        raise ValueError(f"artifacts/{name} is not valid JSON: {err}") from None


def _figure(f: tuple[str, str, str]) -> str:
    """A figure as the voice stage reports it: "216.5 million", "-73", "up 73"."""
    sign, digits, scale = f
    return " ".join(p for p in (f"{sign}{digits}" if sign == "-" else f"{sign} {digits}".strip(), scale) if p)


def whisper_asr(path: Path, prompt: str) -> list[dict]:
    from tools.shorted.asr import transcribe_words

    return transcribe_words(path, prompt)


def number_audit(pd: Path, cut: str) -> dict:
    shipped = _load(pd, f"timeline.{cut}.json")
    dossier, sb = _load(pd, "dossier.json"), _load(pd, f"storyboard.{cut}.json")
    narration = _load(pd, "narration.json")[cut]
    fresh, _ = build_cut(cut, pd)
    differ = [a["id"] for a, b in zip(fresh["scenes"], shipped["scenes"]) if a["props"] != b["props"]]
    if len(fresh["scenes"]) != len(shipped["scenes"]):
        differ.append("scene count")
    stale = [ln["id"] for ch in sb["chapters"] for sc in ch["scenes"] for ln in sc.get("lines", [])
             if resolve_text(ln["text"], dossier, "spoken")[0] != narration[ln["id"]]["spoken"]]
    return _check(not differ and not stale, {"props_differ": differ, "narration_stale": stale},
                  "timeline" if differ else "voice")


def speech_checks(pd: Path, cut: str, asr) -> tuple[dict, dict]:
    """Each line, cut from the final mix at its own window, heard against what its take said. The window pads the line
    by PAD_BEFORE and PAD_AFTER, so the take's tail is in it, but stops CLEARANCE short of the lines either side and stays
    inside the mix. The take passed the voice stage on its own, so a figure lost here, a line gone unheard or one cut
    short is the mix's doing. Whether the takes still say what the script says is number_audit's question."""
    import soundfile as sf

    lines = _load(pd, f"timeline.{cut}.meta.json")["lines"]
    takes = _load(pd, "narration.json").get(cut, {})
    mix = pd / "assets" / "audio" / f"mix.{cut}.wav"
    if not mix.is_file():
        raise FileNotFoundError(f"no assets/audio/mix.{cut}.wav; run the score stage")
    info = sf.info(str(mix))
    sr, length = info.samplerate, info.frames / info.samplerate
    wrong, rows = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for i, ln in enumerate(lines):
            if ln["id"] not in takes:
                raise ValueError(f"artifacts/narration.json has no {cut} line {ln['id']}; re-run voice, then timeline")
            spoken = takes[ln["id"]]["spoken"]
            lo = max(0.0, ln["start"] - PAD_BEFORE, lines[i - 1]["end"] + CLEARANCE if i else 0.0)
            hi = min(length, ln["end"] + PAD_AFTER, lines[i + 1]["start"] - CLEARANCE if i + 1 < len(lines) else length)
            clip = Path(tmp) / f"line{i:03d}.wav"
            sf.write(clip, sf.read(str(mix), start=round(lo * sr), stop=round(hi * sr))[0], sr)
            heard = " ".join(w["w"] for w in asr(clip, spoken))
            want, got = Counter(figures(spoken)), Counter(figures(heard))
            if want != got:
                wrong.append({"id": ln["id"], "missing": [_figure(f) for f in (want - got).elements()],
                              "extra": [_figure(f) for f in (got - want).elements()], "heard": heard[:160]})
            rows.append({"id": ln["id"], "e": wer(spoken, heard), "n": len(normalize(spoken)),
                         "take": takes[ln["id"]]["wer"], "ended": ending_heard(spoken, heard), "heard": heard[:160]})
    words = sum(r["n"] for r in rows) or 1
    cut_wer = sum(r["e"] * r["n"] for r in rows) / words
    takes_wer = sum(r["take"] * r["n"] for r in rows) / words
    unheard = [r["id"] for r in rows if r["e"] > UNHEARD_WER]
    cut_short = [r["id"] for r in rows if r["e"] <= UNHEARD_WER and not r["ended"]]  # an unheard line is listed once
    worst = sorted((r for r in rows if r["e"] > 0), key=lambda r: r["e"], reverse=True)[:5]
    detail = {"wer": round(cut_wer, 4), "takes_wer": round(takes_wer, 4), "unheard": unheard, "ending_missing": cut_short,
              "worst": [{"id": r["id"], "wer": round(r["e"], 4), "heard": r["heard"]} for r in worst]}
    return (_check(not wrong, {"lines": wrong}, "score"),
            _check(not unheard and not cut_short and cut_wer <= takes_wer + MAX_WER_GAIN, detail, "score"))


def caption_check(pd: Path, cut: str) -> dict:
    meta = _load(pd, f"timeline.{cut}.meta.json")
    pages = _load(pd, f"timeline.{cut}.json")["captions"]
    fast = [round(len(c["text"]) / max(0.01, c["end"] - c["start"]), 1) for c in meta["cues"]
            if len(c["text"]) / max(0.01, c["end"] - c["start"]) > MAX_CPS]
    wide = [ln for c in meta["cues"] for ln in split_lines(c["text"]) if len(ln) > MAX_LINE]
    crowded = [p["text"] for p in pages if cut == "short" and len(p["text"].split()) > MAX_PAGE_WORDS]
    return _check(not fast and not wide and not crowded,
                  {"too_fast_cps": fast[:10], "too_long": wide[:5], "too_many_words": crowded[:5]}, "timeline")


def ffprobe(path: Path) -> dict:
    res = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def ebur128(path: Path) -> tuple[float, float]:
    res = subprocess.run(["ffmpeg", "-nostats", "-i", str(path), "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True)
    summary = res.stderr[res.stderr.rfind("Summary:"):]
    lufs = float(re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary).group(1))
    peak = float(re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary).group(1))
    return lufs, peak


def video_checks(pd: Path, cut: str, render: dict) -> dict:
    lo, hi = BOUNDS[cut]
    out = {}
    for rel in [v for v in render["videos"] if f"_{cut}_" in v]:
        info = ffprobe(pd / rel)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
        duration = float(info["format"]["duration"])
        name = Path(rel).stem
        out[f"duration:{name}"] = _check(lo <= duration <= hi, {"seconds": round(duration, 2), "bounds": [lo, hi]}, "storyboard")
        out[f"av_sync:{name}"] = _check(a is not None and abs(float(v["duration"]) - float(a["duration"])) <= MAX_SYNC,
                                        {"video": v.get("duration"), "audio": a and a.get("duration")}, "render")
        out[f"colour:{name}"] = _check((v.get("color_primaries"), v.get("color_transfer"), v.get("color_space")) == ("bt709",) * 3,
                                       {k: v.get(k) for k in ("color_primaries", "color_transfer", "color_space")}, "render")
        if a is None:  # nothing for ebur128 to measure: the mux lost the mix
            out[f"loudness:{name}"] = _check(False, "no audio stream", "render")
            continue
        lufs, peak = ebur128(pd / rel)
        out[f"loudness:{name}"] = _check(abs(lufs - LUFS) <= LUFS_TOL and peak <= MAX_TP,
                                         {"lufs": lufs, "true_peak_dbtp": peak}, "score")
    return out


def contact_sheet(pd: Path, cut: str, video: Path) -> Path:
    from PIL import Image

    scenes = _load(pd, f"timeline.{cut}.json")["scenes"]
    frames = []
    tmp = pd / "renders" / "_contact"
    tmp.mkdir(parents=True, exist_ok=True)
    for i, sc in enumerate(scenes):
        f = tmp / f"{i:03d}.jpg"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{(sc['start'] + sc['end']) / 2:.3f}", "-i", str(video),
                        "-frames:v", "1", "-vf", "scale=480:-2", str(f)], check=True)
        frames.append(Image.open(f).convert("RGB"))
    cols = 5
    w, h = frames[0].size
    sheet = Image.new("RGB", (cols * w, ((len(frames) + cols - 1) // cols) * h), "white")
    for i, im in enumerate(frames):
        sheet.paste(im, ((i % cols) * w, (i // cols) * h))
    out = pd / "renders" / f"contact.{cut}.jpg"
    sheet.save(out, quality=85)
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()
    return out


def run_qa(project_dir: Path, asr=whisper_asr) -> dict:
    pd = Path(project_dir)
    render = _load(pd, "render.json")
    cuts = {}
    for cut in ("long", "short"):
        if not (pd / "artifacts" / f"timeline.{cut}.json").exists():
            continue
        spoken, score = speech_checks(pd, cut, asr)
        checks = {"number_audit": number_audit(pd, cut), "spoken_figures": spoken, "wer": score,
                  "captions": caption_check(pd, cut), **video_checks(pd, cut, render)}
        captioned = next((pd / v for v in render["videos"] if f"_{cut}_" in v and v.endswith("_captioned.mp4")), None)
        if captioned:
            checks["contact_sheet"] = _check(True, str(contact_sheet(pd, cut, captioned).relative_to(pd)), "render")
        cuts[cut] = checks
    if not cuts:  # nothing checked is a failure, never a pass
        cuts["run"] = {"cuts": _check(False, "no timeline.<cut>.json in artifacts/", "timeline")}
    ok = all(c["ok"] for checks in cuts.values() for c in checks.values())
    report = {"overall": "pass" if ok else "fail", "cuts": cuts}
    (pd / "artifacts" / "qa.json").write_text(json.dumps(report, indent=1))
    return report


class ShortedQA(BaseTool):
    name = "shorted_qa"
    version = "1.0.0"
    tier = ToolTier.ANALYZE
    capability = "quality_assurance"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        if not inputs.get("project_dir"):
            return ToolResult(success=False, error="project_dir is required")
        pd = Path(inputs["project_dir"])
        if not pd.is_dir():
            return ToolResult(success=False, error=f"no project folder at {pd}")
        try:
            report = run_qa(pd)
        # a stage not yet run, a half-written file, artefacts out of step, or media soundfile or ffprobe cannot read
        except (OSError, KeyError, ValueError, RuntimeError, subprocess.CalledProcessError) as err:
            return ToolResult(success=False, error=f"QA could not run: {type(err).__name__}: {err}")
        failed = [f"{cut}/{name} (fix in {c['fix_in']})" for cut, checks in report["cuts"].items()
                  for name, c in checks.items() if not c["ok"]]
        return ToolResult(success=not failed, data=report, error="; ".join(failed) or None,
                          artifacts=[str(pd / "artifacts" / "qa.json")])
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted/test_qa.py -q && .venv/bin/python -m pytest tests/shorted/test_qa.py -q -m slow`
Expected: 12 tests pass (the slow one is skipped), then the slow full QA on a stand-in render passes.

- [ ] **Step 5: Update the review director's QA table**

Task 2 wrote `skills/pipelines/shorted-results/review-director.md` with the old `spoken_numbers` and `wer` rows. In its QA table, replace those two rows with these two, in the same place (after `number_audit`, before `loudness`):

```markdown
| spoken_figures | each line, heard in its window of the final mix, carries its take's figures exactly (sign, digits, scale) | score (ducking); voice (rephrase) when the take reads ambiguously |
| wer | every line heard (WER <= 0.5 in its window) and heard to its end; the cut's WER within 0.03 of the takes' own | score |
```

- [ ] **Step 6: Commit**

```bash
git add tools/shorted/qa.py tests/shorted/test_qa.py skills/pipelines/shorted-results/review-director.md
git commit -m "feat(shorted): QA: number audit, per-line speech checks, captions, loudness, sync, colour, contact sheets"
```

### Task 24: Reflection, the CLI, the manifest's tools and the end-to-end run

**Files:**
- Create: `tools/shorted/reflect.py`, `tools/shorted/cli.py`, `shorted-gaps/.gitkeep`
- Modify: `pipeline_defs/shorted-results.yaml` (fill `tools_available`), `tests/shorted/test_pack.py` (append)
- Test: `tests/shorted/test_reflect.py`, `tests/shorted/test_cli.py`, `tests/shorted/test_e2e.py`

**Interfaces:**
- Consumes: every stage function above; OpenMontage `init_project`, `write_checkpoint`, `read_checkpoint`, `PROJECTS_DIR`, `ToolRegistry`.
- Produces:
  - `reflect.classify(pd) -> [gap]`, where a gap is `{run, ticker, date, class, key, detail, impact}`. Classes: `missing_field`, `missing_endpoint`, `surface_mismatch`, `mcp_gap`, `pipeline_gap`, `unused_source`, `stale_sync`, `low_trust_extraction`, `kit_miss` and `unavailable_by_law`. MCP findings come from `artifacts/mcp.json` (Task 9).
  - `reflect.update_ledger(ledger, run, gaps)`: a re-run replaces its own rows.
  - `reflect.backlog(rows) -> markdown`: ranked by runs × impact, excluding `unavailable_by_law`.
  - `reflect.reflect(pd, ledger=…) -> gaps`, which writes `artifacts/reflect.md`, `shorted-gaps/gaps.jsonl` and `shorted-gaps/backlog.md`.
  - `cli.run(stage, ticker, project=None, deps=None, root=None) -> exit code`.
    - `Deps(api, fetch, tts, asr, capture, remotion, mcp, public_root, today)`; any field left `None` gets the real provider.
    - `dossier` also runs the MCP pass (Task 9), which prints parity and coverage and never fails the stage.
    - Exit codes: 0 ok, 1 stage failed, 2 the video cannot be made honestly, 3 out of order.
    - `cli.STAGES` lists the stages in order.
  - Tool `shorted_reflect`.

- [ ] **Step 1: Write the failing tests**

`tests/shorted/test_reflect.py`:

```python
import json

from tests.shorted import sample
from tools.shorted.reflect import backlog, classify, reflect, update_ledger


def test_gaps_are_classified(tmp_path):
    pd = sample.make_run(tmp_path)
    d = json.loads((pd / "artifacts/dossier.json").read_text())
    d["calls"] = [{"label": "GetStockNews", "ok": False, "status": 503, "error": "HTTP 503"}, {"label": "GetStock", "ok": True},
                  {"label": "GetCompanyTaxProfile", "ok": False, "status": 404, "error": "no tax profile"}]
    d["coverage"]["outlook"] = {"ok": False, "missing": ["any of: results.guidance, dividends.history"], "stale": []}
    d["short"]["pct"]["trust"] = "stale"
    d["results"]["net_income"].update({"trust": "untrusted", "note": "extraction confidence 0.52"})
    (pd / "artifacts/dossier.json").write_text(json.dumps(d))
    sb = json.loads((pd / "artifacts/storyboard.long.json").read_text())
    sb["data_wishes"] = [{"chapter": "outlook", "wanted": "FY27 revenue guidance", "why": "nothing to quote"},
                         {"chapter": "bears", "wanted": "Which funds are shorting", "why": "viewers ask"}]
    (pd / "artifacts/storyboard.long.json").write_text(json.dumps(sb))
    brand = json.loads((pd / "artifacts/brand.json").read_text())
    brand["logo"] = None
    (pd / "artifacts/brand.json").write_text(json.dumps(brand))
    gaps = classify(pd)
    found = {(g["class"], g["key"]) for g in gaps}
    assert ("missing_endpoint", "GetStockNews") in found
    assert next(g for g in gaps if g["key"] == "GetCompanyTaxProfile")["class"] == "missing_field"
    assert next(g for g in gaps if g["key"] == "GetCompanyTaxProfile")["impact"] == 1
    assert ("missing_field", "any of: results.guidance, dividends.history") in found
    assert ("stale_sync", "short.pct") in found
    assert ("low_trust_extraction", "results.net_income") in found
    assert ("kit_miss", "company logo") in found
    assert ("unavailable_by_law", "which funds are shorting") in found
    assert ("missing_field", "fy27 revenue guidance") in found


def test_mcp_findings_are_classified(tmp_path):
    pd = sample.make_run(tmp_path)
    (pd / "artifacts/mcp.json").write_text(json.dumps({
        "ticker": "EXM", "calls": [],
        "parity": [{"check": "short.pct", "ok": False, "dossier": 15.07, "mcp": 15.1, "detail": ""},
                   {"check": "price.close", "ok": True, "dossier": 2.41, "mcp": 2.41, "detail": ""}],
        "coverage": [{"section": "dividends", "tool": None, "ok": False, "note": "no MCP tool returns dividend history"},
                     {"section": "short", "tool": "get_stock_history", "ok": False, "note": "HTTP 503"},
                     {"section": "news", "tool": "get_stock_news", "ok": True, "note": None}],
        "extras": {"politicians": {"count": 2}}}))
    sb = json.loads((pd / "artifacts/storyboard.long.json").read_text())
    sb["data_wishes"] = [{"chapter": "news", "wanted": "the weekly report's mention (MCP get_report)", "why": "context"}]
    (pd / "artifacts/storyboard.long.json").write_text(json.dumps(sb))
    gaps = {(g["class"], g["key"]): g for g in classify(pd)}
    assert gaps[("surface_mismatch", "short.pct")]["impact"] == 3
    assert ("surface_mismatch", "price.close") not in gaps
    assert gaps[("mcp_gap", "dividends")]["impact"] == 1  # no scene binds dividends
    assert gaps[("mcp_gap", "short")]["impact"] == 2  # the bears scenes bind short.*
    assert ("mcp_gap", "news") not in gaps
    assert ("unused_source", "politicians' declared holdings") in gaps
    assert ("pipeline_gap", "the weekly report's mention (mcp get_report)") in gaps


def test_ledger_replaces_a_rerun_and_ranks_the_backlog(tmp_path):
    ledger = tmp_path / "gaps.jsonl"

    def g(run, key, cls="missing_field", impact=2):
        return {"run": run, "ticker": run[:3], "date": "2026-10-07", "class": cls, "key": key, "detail": "", "impact": impact}

    update_ledger(ledger, "AAA-1", [g("AAA-1", "results.guidance")])
    update_ledger(ledger, "AAA-1", [g("AAA-1", "results.guidance"), g("AAA-1", "who is short", "unavailable_by_law")])
    update_ledger(ledger, "BBB-1", [g("BBB-1", "results.guidance"), g("BBB-1", "company logo", "kit_miss", 1)])
    rows = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert len(rows) == 4
    md = backlog(rows)
    assert md.index("results.guidance") < md.index("company logo") and "who is short" not in md


def test_reflect_writes_the_run_note(tmp_path):
    pd = sample.make_run(tmp_path)
    gaps = reflect(pd, ledger=tmp_path / "gaps" / "gaps.jsonl")
    assert (pd / "artifacts/reflect.md").read_text().startswith("# What this run lacked")
    assert (tmp_path / "gaps/backlog.md").exists() and isinstance(gaps, list)
```

`tests/shorted/test_cli.py`:

```python
from datetime import date

from lib.checkpoint import init_project, write_checkpoint
from tests.shorted import sample
from tools.shorted.cli import Deps, run

TODAY = date(2026, 10, 7)


def staged(tmp_path):
    """A project that has passed dossier and brand, with gated storyboards written by the sample."""
    root = tmp_path / "projects"
    pd = sample.make_run(root)
    init_project(pd.name, title="EXM results video", pipeline_type="shorted-results", pipeline_dir=root,
                 style_playbook="shorted-field-guide")
    for stage in ("dossier", "brand"):
        write_checkpoint(root, pd.name, stage, "completed", {}, pipeline_type="shorted-results")
    return root, pd


def test_approval_is_refused_after_an_edit(tmp_path):
    root, pd = staged(tmp_path)
    deps = Deps(today=TODAY)
    assert run("storyboard", "EXM", deps=deps, root=root) == 0
    path = pd / "artifacts/storyboard.short.json"
    path.write_text(path.read_text().replace("Cold open", "The cold open"))
    assert run("approve", "EXM", deps=deps, root=root) == 1
    assert run("storyboard", "EXM", deps=deps, root=root) == 0
    assert run("approve", "EXM", deps=deps, root=root) == 0


def test_approval_is_refused_after_the_dossier_changes(tmp_path):
    root, pd = staged(tmp_path)
    deps = Deps(today=TODAY)
    assert run("storyboard", "EXM", deps=deps, root=root) == 0
    path = pd / "artifacts/dossier.json"
    path.write_text(path.read_text() + "\n")  # any re-run of the dossier stage changes its bytes
    assert run("approve", "EXM", deps=deps, root=root) == 1
    assert run("storyboard", "EXM", deps=deps, root=root) == 0
    assert run("approve", "EXM", deps=deps, root=root) == 0


def test_stages_out_of_order_are_refused_before_any_work(tmp_path):
    root, _ = staged(tmp_path)

    def boom(*a, **k):
        raise AssertionError("a provider was called")

    assert run("voice", "EXM", deps=Deps(tts=boom, asr=boom, today=TODAY), root=root) == 3


def test_status_prints_the_rail(tmp_path, capsys):
    root, _ = staged(tmp_path)
    assert run("status", "EXM", deps=Deps(today=TODAY), root=root) == 0
    out = capsys.readouterr().out
    assert "dossier" in out and "completed" in out and "voice" in out
```

`tests/shorted/test_e2e.py`:

```python
"""End to end on the recorded DRO dossier with every paid or networked provider stood in."""

import io
import json
import shutil
from datetime import date

import pytest
from PIL import Image

from tests.shorted import sample
from tests.shorted.conftest import fixture_api, fixture_mcp
from tools.shorted.cli import STAGES, Deps, run
from tools.shorted.render import REMOTION


def png(_url: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (256, 256), (217, 132, 42, 255)).save(buf, "PNG")
    return buf.getvalue()


def go(root, deps):
    assert run("dossier", "DRO", deps=deps, root=root) == 0
    pd = next(root.glob("DRO-*"))
    assert run("brand", "DRO", deps=deps, root=root) == 0
    d = json.loads((pd / "artifacts/dossier.json").read_text())
    for cut in ("long", "short"):
        (pd / f"artifacts/storyboard.{cut}.json").write_text(json.dumps(sample.storyboard(cut, d), indent=1))
    assert run("storyboard", "DRO", deps=deps, root=root) == 0
    assert run("approve", "DRO", deps=deps, root=root) == 0
    for stage in STAGES[3:]:
        assert run(stage, "DRO", deps=deps, root=root) == 0, stage
    return pd


def stand_ins(tmp_path, monkeypatch):
    stems = sample.fake_stems(tmp_path / "stems")
    monkeypatch.setattr("tools.shorted.music_theme.ensure_stems", lambda root=None: stems)
    monkeypatch.setattr("tools.shorted.score.kit_sfx", lambda: sample.fake_sfx(tmp_path / "sfx"))
    monkeypatch.setattr("tools.shorted.reflect.LEDGER", tmp_path / "gaps" / "gaps.jsonl")


@pytest.mark.slow
def test_end_to_end_with_stand_ins(tmp_path, monkeypatch):
    stand_ins(tmp_path, monkeypatch)
    deps = Deps(api=fixture_api("DRO"), fetch=png, tts=sample.fake_tts, asr=sample.fake_asr, capture=sample.fake_capture,
                remotion=sample.fake_remotion, mcp=fixture_mcp("DRO"), public_root=tmp_path / "public",
                today=date(2026, 10, 7))
    pd = go(tmp_path / "projects", deps)
    qa = json.loads((pd / "artifacts/qa.json").read_text())
    assert qa["overall"] == "pass", json.dumps(qa, indent=1)[:3000]
    assert (pd / "artifacts/reflect.md").exists()
    assert json.loads((pd / "artifacts/mcp.json").read_text())["parity"]


@pytest.mark.slow
def test_end_to_end_real_render(tmp_path, monkeypatch):
    stand_ins(tmp_path, monkeypatch)
    deps = Deps(api=fixture_api("DRO"), fetch=png, tts=sample.fake_tts, asr=sample.fake_asr, capture=sample.fake_capture,
                mcp=fixture_mcp("DRO"), today=date(2026, 10, 7))
    pd = None
    try:
        pd = go(tmp_path / "projects", deps)
        assert json.loads((pd / "artifacts/qa.json").read_text())["overall"] == "pass"
    finally:
        if pd:
            shutil.rmtree(REMOTION / "public" / "shorted-runs" / pd.name, ignore_errors=True)
```

Append to `tests/shorted/test_pack.py`:

```python
def test_manifest_tools_are_registered():
    from tools.tool_registry import ToolRegistry

    reg = ToolRegistry()
    reg.discover("tools.shorted")
    names = {t for s in load_pipeline("shorted-results")["stages"] for t in s["tools_available"]}
    assert names and not sorted(n for n in names if reg.get(n) is None)
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/python -m pytest tests/shorted/test_reflect.py tests/shorted/test_cli.py tests/shorted/test_pack.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.shorted.reflect'`.

- [ ] **Step 3: Implement `reflect.py`**

```python
"""Reflection: what this run lacked, as gaps Shorted can fix, kept in a ledger and ranked into a backlog.

Classes:
- missing_field, missing_endpoint: product gaps (the API had nothing, or the call failed);
- surface_mismatch: the API and the MCP server disagree on a figure (a Shorted defect);
- mcp_gap: a dossier section no MCP tool serves, so an AI client on the connector could not make the video;
- pipeline_gap: data Shorted has (named through MCP) that the dossier does not collect yet;
- unused_source: data collected that no scene shows yet;
- stale_sync, low_trust_extraction, kit_miss;
- unavailable_by_law (e.g. who holds a short position: ASIC publishes aggregates by law). Recorded so
  nobody asks again, but never a gap and never in the backlog.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolTier
from tools.shorted.bindings import placeholders

REPO = Path(__file__).resolve().parents[2]
LEDGER = REPO / "shorted-gaps" / "gaps.jsonl"
SECTION_CALLS = {"company": ["GetStock", "GetStockDetails"], "short": ["GetStockData", "GetTopShorts"],
                 "price": ["GetStockPrices"], "results": ["GetStockFundamentals", "GetStockFinancialHighlights"],
                 "dividends": ["GetDividendHistory"], "news": ["GetStockNews"], "events": ["GetEventTimeline"],
                 "insiders": ["GetDirectorTrades"], "peers": ["GetPeerComparison"], "strategy": ["GetStockStrategyFit"],
                 "signals": ["GetStockSignals"]}
RAW_ONLY = {"GetStockGraph", "GetCompanyTaxProfile", "GetStockVerdict", "GetBattlegroundStocks",
            "GetShortCampaignScoreboard", "GetIndexSeries", "GetRelatedNews"}  # read, but no scene binds them yet
LAW = re.compile(r"\b(who (is|are) (short|shorting)|which (funds?|firms?|investors?|hedge funds?) (is|are|were) (short|shorting)"
                 r"|holders? of (the )?short|identity of)", re.I)
SECTIONS = list(SECTION_CALLS)


def _key(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())[:80]


def _bound_paths(art: Path) -> set[str]:
    """Every dossier path the storyboards bind, e.g. short.pct, news.items, results.filing.title."""
    return {re.sub(r"\[\d+\]", "", path) for p in art.glob("storyboard.*.json") for path, _ in placeholders(p.read_text())}


def _mcp_gaps(art: Path, base: dict) -> list[dict]:
    path = art / "mcp.json"
    if not path.exists():
        return [{**base, "class": "mcp_gap", "key": "mcp pass", "detail": "artifacts/mcp.json missing: the MCP pass did not run",
                 "impact": 1}]
    mcp = json.loads(path.read_text())
    bound = _bound_paths(art)
    gaps = [{**base, "class": "surface_mismatch", "key": c["check"],
             "detail": f"API {c['dossier']} vs MCP {c['mcp']} {c.get('detail') or ''}".strip(), "impact": 3}
            for c in mcp.get("parity", []) if not c["ok"]]
    for c in mcp.get("coverage", []):
        if not c["ok"]:
            used = any(p == c["section"] or p.startswith(c["section"] + ".") for p in bound)
            gaps.append({**base, "class": "mcp_gap", "key": c["section"], "detail": c.get("note") or "", "impact": 2 if used else 1})
    politicians = (mcp.get("extras") or {}).get("politicians") or {}
    if politicians.get("count"):
        gaps.append({**base, "class": "unused_source", "key": "politicians' declared holdings",
                     "detail": f"{politicians['count']} politicians declare an interest (MCP list_stock_politicians); no scene shows it",
                     "impact": 1})
    return gaps


def classify(project_dir: Path) -> list[dict]:
    pd = Path(project_dir)
    art = pd / "artifacts"
    d = json.loads((art / "dossier.json").read_text())
    failed = {c["label"].split("#")[0] for c in d.get("calls", []) if not c["ok"] and c.get("status") != 404}
    base = {"run": pd.name, "ticker": d["ticker"], "date": date.today().isoformat()}
    gaps = []
    for c in d.get("calls", []):
        if not c["ok"]:
            # a 404 means the endpoint exists but has nothing for this stock: a field gap
            gaps.append({**base, "class": "missing_field" if c.get("status") == 404 else "missing_endpoint", "key": c["label"],
                         "detail": c.get("error", ""), "impact": 1 if c["label"].split("#")[0] in RAW_ONLY else 2})
    for chapter, cov in d.get("coverage", {}).items():
        for miss in [] if cov["ok"] else cov["missing"]:
            sections = {p.split(".")[0] for p in re.findall(r"[a-z_]+\.[a-z0-9_]+", miss)}
            endpoint_down = sections and all(set(SECTION_CALLS.get(s, [])) <= failed for s in sections)
            gaps.append({**base, "class": "missing_endpoint" if endpoint_down else "missing_field", "key": miss,
                         "detail": f"chapter {chapter} dropped", "impact": 3})
    for section in SECTIONS:
        for field, v in (d.get(section) or {}).items():
            if isinstance(v, dict) and v.get("trust") == "stale":
                gaps.append({**base, "class": "stale_sync", "key": f"{section}.{field}", "detail": v.get("note") or "", "impact": 2})
            elif isinstance(v, dict) and v.get("trust") == "untrusted":
                gaps.append({**base, "class": "low_trust_extraction", "key": f"{section}.{field}", "detail": v.get("note") or "", "impact": 2})
    for sb_path in sorted(art.glob("storyboard.*.json")):
        for wish in json.loads(sb_path.read_text()).get("data_wishes", []):
            said = f"{wish['wanted']} {wish.get('why', '')}"
            cls = ("unavailable_by_law" if LAW.search(wish["wanted"])
                   else "pipeline_gap" if re.search(r"\bMCP\b", said) else "missing_field")
            gaps.append({**base, "class": cls, "key": _key(wish["wanted"]), "detail": f"{wish.get('chapter')}: {wish.get('why', '')}", "impact": 1})
    brand = json.loads((art / "brand.json").read_text()) if (art / "brand.json").exists() else {}
    if not brand.get("logo"):
        gaps.append({**base, "class": "kit_miss", "key": "company logo", "detail": brand.get("note") or "", "impact": 1})
    manifest = json.loads((art / "asset_manifest.json").read_text()) if (art / "asset_manifest.json").exists() else {}
    for miss in manifest.get("metadata", {}).get("missing", []):
        gaps.append({**base, "class": "kit_miss", "key": f"plate {miss['key']}", "detail": miss.get("error") or "", "impact": 1})
    gaps += _mcp_gaps(art, base)
    seen, out = set(), []
    for g in gaps:
        if (g["class"], g["key"]) not in seen:
            seen.add((g["class"], g["key"]))
            out.append(g)
    return out


def update_ledger(ledger: Path, run: str, gaps: list[dict]) -> list[dict]:
    ledger.parent.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()] if ledger.exists() else []
    rows = [r for r in rows if r["run"] != run] + gaps
    ledger.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return rows


def backlog(rows: list[dict]) -> str:
    agg: dict[tuple, dict] = defaultdict(lambda: {"runs": set(), "tickers": set(), "impact": 0, "last": ""})
    for r in rows:
        if r["class"] == "unavailable_by_law":
            continue
        a = agg[(r["class"], r["key"])]
        a["runs"].add(r["run"])
        a["tickers"].add(r["ticker"])
        a["impact"] = max(a["impact"], r["impact"])
        a["last"] = max(a["last"], r["date"])
    ranked = sorted(agg.items(), key=lambda kv: (-len(kv[1]["runs"]) * kv[1]["impact"], kv[0]))
    out = ["# Shorted data backlog (from video runs)", "",
           "Ranked by runs affected × impact (3 = a chapter dropped or the API and MCP disagree, 2 = a value unusable "
           "or a section MCP cannot serve that the video used, 1 = a wish, a kit miss or an unused source).", "",
           "| rank | score | class | gap | runs | tickers | last seen |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for i, ((cls, key), a) in enumerate(ranked, 1):
        out.append(f"| {i} | {len(a['runs']) * a['impact']} | {cls} | {key} | {len(a['runs'])} | "
                   f"{', '.join(sorted(a['tickers']))} | {a['last']} |")
    return "\n".join(out) + "\n"


def reflect(project_dir: Path, ledger: Path | None = None) -> list[dict]:
    pd = Path(project_dir)
    ledger = Path(ledger or LEDGER)
    gaps = classify(pd)
    rows = update_ledger(ledger, pd.name, gaps)
    (ledger.parent / "backlog.md").write_text(backlog(rows))
    lines = ["# What this run lacked", "", f"Run `{pd.name}`. Ledger: `{ledger}`.", ""]
    real = [g for g in gaps if g["class"] != "unavailable_by_law"]
    lines += [f"- **{g['class']}** `{g['key']}`: {g['detail']}" for g in real] or ["- Nothing: every chapter had its data."]
    law = [g for g in gaps if g["class"] == "unavailable_by_law"]
    if law:
        lines += ["", "Recorded, not gaps (ASIC publishes aggregates only):"] + [f"- {g['key']}" for g in law]
    (pd / "artifacts" / "reflect.md").write_text("\n".join(lines) + "\n")
    return gaps


class ShortedReflect(BaseTool):
    name = "shorted_reflect"
    version = "1.0.0"
    tier = ToolTier.ANALYZE
    capability = "data_gap_reflection"
    provider = "shorted"
    input_schema = {"type": "object", "required": ["project_dir"], "properties": {"project_dir": {"type": "string"}}}

    def execute(self, inputs: dict) -> ToolResult:
        gaps = reflect(Path(inputs["project_dir"]))
        return ToolResult(success=True, data={"gaps": len(gaps)},
                          artifacts=[str(Path(inputs["project_dir"]) / "artifacts" / "reflect.md"), str(LEDGER)])
```

- [ ] **Step 4: Implement `cli.py`**

```python
"""The pipeline from the command line, one stage at a time:

    .venv/bin/python -m tools.shorted.cli <stage> --ticker DRO [--project DRO-2026-10-07]

Stages in order: dossier, brand, storyboard, approve, assets, voice, timeline, score, render, qa,
reflect; and status. Each reads and writes files under projects/<TICKER>-<YYYY-MM-DD>/ and writes
an OpenMontage checkpoint, so any stage can be re-run on its own.
Exit codes: 0 ok, 1 the stage failed, 2 the video cannot be made honestly, 3 out of order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable, Optional

from lib.checkpoint import CheckpointValidationError, init_project, read_checkpoint, write_checkpoint
from lib.paths import PROJECTS_DIR

REPO = Path(__file__).resolve().parents[2]
PIPELINE, PLAYBOOK = "shorted-results", "shorted-field-guide"
STAGES = ["dossier", "brand", "storyboard", "assets", "voice", "timeline", "score", "render", "qa", "reflect"]


@dataclass
class Deps:
    api: object = None
    fetch: Optional[Callable] = None
    tts: Optional[Callable] = None
    asr: Optional[Callable] = None
    capture: Optional[Callable] = None
    remotion: Optional[Callable] = None
    mcp: object = None
    public_root: Optional[Path] = None
    today: date = field(default_factory=date.today)


def _real(d: Deps) -> Deps:
    """Fill every unset provider with the real one. Constructing them touches no network."""
    from tools.shorted.api import ShortedAPI
    from tools.shorted.assets import node_capture
    from tools.shorted.brand import _get
    from tools.shorted.mcp import ShortedMCP
    from tools.shorted.narration import gemini_tts, whisper_asr
    from tools.shorted.render import remotion_cli

    return Deps(api=d.api or ShortedAPI(), fetch=d.fetch or _get, tts=d.tts or gemini_tts, asr=d.asr or whisper_asr,
                capture=d.capture or node_capture, remotion=d.remotion or remotion_cli, mcp=d.mcp or ShortedMCP(),
                public_root=d.public_root, today=d.today)


def load_env(path: Path = REPO / ".env") -> None:
    """KEY=VALUE lines into the environment; existing values win and nothing is printed."""
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def _cp(pd: Path, stage: str, status: str, artifacts: dict, **kw) -> None:
    # Keys that are OpenMontage artifact names (e.g. "review", "script") must hold schema-valid objects,
    # so file paths go under other keys ("review_sheet").
    write_checkpoint(pd.parent, pd.name, stage, status, artifacts, pipeline_type=PIPELINE, style_playbook=PLAYBOOK, **kw)


def _status(pd: Path, stage: str) -> str | None:
    cp = read_checkpoint(pd.parent, pd.name, stage)
    return cp["status"] if cp else None


def _digests(pd: Path) -> dict:
    return {cut: hashlib.sha256(p.read_bytes()).hexdigest()
            for cut in ("long", "short") if (p := pd / "artifacts" / f"storyboard.{cut}.json").exists()}


def _changed_since_gates(pd: Path) -> list[str]:
    """Storyboards (by cut) and the dossier changed since the gates ran: props re-resolve at timeline time, so a
    re-run dossier changes what was approved."""
    gates_path = pd / "artifacts" / "gates.json"
    gates = json.loads(gates_path.read_text(encoding="utf-8")) if gates_path.exists() else {}
    changed = [cut for cut, sha in _digests(pd).items() if gates.get(cut, {}).get("sha256") != sha]
    dossier = pd / "artifacts" / "dossier.json"
    sha = hashlib.sha256(dossier.read_bytes()).hexdigest() if dossier.exists() else None
    if any(g.get("dossier_sha256") != sha for g in gates.values()):
        changed.append("dossier")
    return changed


def find_project(ticker: str, project: str | None, root: Path, create: bool, today: date) -> Path:
    if project:
        return root / project
    if create:
        return init_project(f"{ticker}-{today.isoformat()}", title=f"{ticker} results video", pipeline_type=PIPELINE,
                            pipeline_dir=root, style_playbook=PLAYBOOK)
    runs = sorted(p for p in root.glob(f"{ticker}-*") if (p / "project.json").exists())
    if not runs:
        raise SystemExit(f"no {ticker} run under {root}; start with: cli dossier --ticker {ticker}")
    return runs[-1]


def _dossier(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.dossier import build_dossier

    d = build_dossier(t, deps.api, deps.today)
    art = pd / "artifacts"
    (art / "dossier.json").write_text(json.dumps(d, indent=1))
    (art / "coverage.json").write_text(json.dumps(d["coverage"], indent=1))
    for ch, c in d["coverage"].items():
        print(f"{'ok' if c['ok'] else 'NO':3} {ch:10} {'; '.join(c['missing'])}")
    failed = [c["label"] for c in d["calls"] if not c["ok"]]
    if failed:
        print("failed calls:", ", ".join(failed))
    _mcp_pass(pd, deps)
    _cp(pd, "dossier", "completed", {"dossier": "artifacts/dossier.json", "coverage": "artifacts/coverage.json"})
    if not (d["coverage"]["company"]["ok"] and d["coverage"]["bears"]["ok"]):
        print("The company or bears chapter has no data, so this video cannot be made honestly. Tell the user.")
        return 2
    print(f"dossier ready: {pd}")
    return 0


def _mcp_pass(pd: Path, deps: Deps) -> None:
    """Read the ticker through the MCP server too. It informs reflection and never blocks a run."""
    from tools.shorted.mcp_pass import run_mcp_pass

    try:
        rep = run_mcp_pass(pd, deps.mcp)
    except Exception as err:  # recorded for reflection: a missing artifacts/mcp.json is itself a gap
        print(f"mcp pass did not run: {str(err)[:200]}")
        return
    agree = sum(c["ok"] for c in rep["parity"])
    print(f"mcp: {agree}/{len(rep['parity'])} headline figures agree across the API and MCP; MCP cannot serve "
          + ", ".join(c["section"] for c in rep["coverage"] if c["tool"] is None))
    for c in rep["parity"]:
        if not c["ok"]:
            print(f"  MISMATCH {c['check']}: API {c['dossier']} vs MCP {c['mcp']} {c['detail']}".rstrip())


def _brand(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.brand import build_brand

    brand = build_brand(json.loads((pd / "artifacts" / "dossier.json").read_text()), pd, fetch=deps.fetch)
    print(f"logo: {'yes' if brand['logo'] else 'no (' + str(brand['note']) + ')'}; accent: {brand['accent']}")
    _cp(pd, "brand", "completed", {"brand": "artifacts/brand.json"})
    return 0


def _storyboard(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.gates import ShortedScriptGates

    absent = [c for c in ("long", "short") if not (pd / "artifacts" / f"storyboard.{c}.json").exists()]
    if absent:
        print(f"write artifacts/storyboard.{absent[0]}.json first (the storyboard-director skill)")
        return 1
    res = ShortedScriptGates().execute({"project_dir": str(pd)})
    print(f"review sheet: {pd / 'artifacts' / 'review.md'}")
    if not res.success:
        print(res.error)
        return 1
    _cp(pd, "storyboard", "awaiting_human", {"gates": "artifacts/gates.json", "review_sheet": "artifacts/review.md"},
        human_approval_required=True)
    print("Gates passed. Show artifacts/review.md to the user and stop. Run `approve` only after they say yes.")
    return 0


def _approve(pd: Path, t: str, deps: Deps) -> int:
    gates_path = pd / "artifacts" / "gates.json"
    if not gates_path.exists():
        print("run `storyboard` first")
        return 1
    errors = sum(len(g["errors"]) for g in json.loads(gates_path.read_text()).values())
    changed = _changed_since_gates(pd)
    if errors or changed:
        print(f"cannot approve: {errors} gate errors; changed since the gates ran: {changed or 'none'}. Re-run `storyboard`.")
        return 1
    _cp(pd, "storyboard", "completed", {"gates": "artifacts/gates.json", "review_sheet": "artifacts/review.md",
                                        "storyboards": _digests(pd)}, human_approved=True)
    print("storyboard approved")
    return 0


def _unchanged(pd: Path) -> bool:
    changed = _changed_since_gates(pd)
    if changed:
        print(f"changed after approval ({', '.join(changed)}): re-run `storyboard`, then `approve`")
    return not changed


def _assets(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.assets import run_assets

    out = run_assets(pd, capture=deps.capture, public_root=deps.public_root)
    for m in out["missing"]:
        print(f"not captured: {m['key']} ({m['error']}); the timeline drops that plate")
    _cp(pd, "assets", "completed", {"asset_manifest": out["asset_manifest"], "images": "artifacts/images.json"})
    return 0


def _voice(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.narration import NarrationError, narrate

    if not _unchanged(pd):
        return 1
    try:
        out = narrate(pd, tts=deps.tts, asr=deps.asr)
    except NarrationError as err:
        print(err)
        return 1
    print({cut: len(lines) for cut, lines in out.items()}, "lines voiced")
    _cp(pd, "voice", "completed", {"narration": "artifacts/narration.json"})
    return 0


def _timeline(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.timeline import write_cut

    if not _unchanged(pd):
        return 1
    for cut in ("long", "short"):
        meta = write_cut(cut, pd)
        print(f"{cut}: {meta['duration']:.1f} s (target {meta['bounds'][0]:.0f}-{meta['bounds'][1]:.0f})")
        for w in meta["warnings"]:
            print("  warning:", w)
    _cp(pd, "timeline", "completed", {"timeline_long": "artifacts/timeline.long.json", "timeline_short": "artifacts/timeline.short.json"})
    return 0


def _score(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.mixdown import mixdown
    from tools.shorted.score import score_cut

    reports = {}
    for cut in ("long", "short"):
        score_cut(pd, cut)
        reports[cut] = mixdown(pd, cut)
        print(f"{cut}: {reports[cut]['integrated_lufs']} LUFS, {reports[cut]['true_peak_dbtp']} dBTP, "
              f"speech over music {reports[cut].get('speech_to_music_db')} dB")
    if any(abs(r["integrated_lufs"] + 14) > 1 or r["true_peak_dbtp"] > -1.4 for r in reports.values()):
        print("mix out of spec")
        return 1
    _cp(pd, "score", "completed", {"mix": reports})
    return 0


def _render(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.render import render_all

    report = render_all(pd, remotion=deps.remotion)
    print("\n".join(report["videos"] + report["stills"]))
    _cp(pd, "render", "completed", {"renders": "artifacts/render.json"})
    return 0


def _qa(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted.qa import run_qa

    report = run_qa(pd, asr=deps.asr)
    for cut, checks in report["cuts"].items():
        for name, c in checks.items():
            if not c["ok"]:
                print(f"FAIL {cut}/{name}: {c['detail']} (fix in: {c['fix_in']})")
    if report["overall"] != "pass":
        return 1
    _cp(pd, "qa", "completed", {"qa": "artifacts/qa.json"})
    print("QA passed")
    return 0


def _reflect(pd: Path, t: str, deps: Deps) -> int:
    from tools.shorted import reflect as rf

    gaps = rf.reflect(pd)
    print(f"{len(gaps)} items recorded; backlog: {rf.LEDGER.parent / 'backlog.md'}")
    _cp(pd, "reflect", "completed", {"reflect": "artifacts/reflect.md"})
    return 0


RUNNERS = {"dossier": _dossier, "brand": _brand, "storyboard": _storyboard, "approve": _approve, "assets": _assets,
           "voice": _voice, "timeline": _timeline, "score": _score, "render": _render, "qa": _qa, "reflect": _reflect}


def _ready(pd: Path, stage: str) -> bool:
    """Every earlier stage completed (approve needs a gated storyboard): checked before any work or spend."""
    if stage == "approve":
        ok = _status(pd, "storyboard") in ("awaiting_human", "completed")
        if not ok:
            print("run `storyboard` first")
        return ok
    for prev in STAGES[: STAGES.index(stage)]:
        if _status(pd, prev) != "completed":
            print(f"`{prev}` has not completed; run the stages in order: {' -> '.join(STAGES)}")
            return False
    return True


def run(stage: str, ticker: str, project: str | None = None, deps: Deps | None = None, root: Path | None = None) -> int:
    from tools.shorted.calls import normalise_ticker

    t = normalise_ticker(ticker)
    root = Path(root or PROJECTS_DIR)
    deps = _real(deps or Deps())
    pd = find_project(t, project, root, create=stage == "dossier", today=deps.today)
    if stage == "status":
        for s in STAGES:
            print(f"{s:11} {_status(pd, s) or '-'}")
        return 0
    if stage != "dossier" and not _ready(pd, stage):
        return 3
    try:
        return RUNNERS[stage](pd, t, deps)
    except CheckpointValidationError as err:
        print(f"checkpoint refused: {err}")
        return 3


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m tools.shorted.cli", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=list(RUNNERS) + ["status"])
    p.add_argument("--ticker", required=True)
    p.add_argument("--project")
    a = p.parse_args(argv)
    load_env()
    return run(a.stage, a.ticker, a.project)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Fill the manifest's tools and create the ledger folder**

```bash
cd /Users/benebsworth/projects/shorted-studio
mkdir -p shorted-gaps && touch shorted-gaps/.gitkeep
.venv/bin/python - <<'EOF'
import re
from pathlib import Path
TOOLS = {"dossier": ["shorted_dossier", "shorted_mcp_pass"], "brand": ["shorted_brand", "shorted_kit"], "storyboard": ["shorted_script_gates"],
         "assets": ["shorted_assets", "shorted_kit"], "voice": ["shorted_narration"], "timeline": ["shorted_timeline"],
         "score": ["shorted_score", "shorted_kit"], "render": ["shorted_render"], "qa": ["shorted_qa"], "reflect": ["shorted_reflect"]}
p = Path("pipeline_defs/shorted-results.yaml")
out, stage = [], None
for line in p.read_text().splitlines():
    m = re.match(r"  - name: (\w+)", line)
    stage = m.group(1) if m else stage
    if line.strip() == "tools_available: []" and stage in TOOLS:
        line = line.replace("[]", "[" + ", ".join(TOOLS[stage]) + "]")
    out.append(line)
p.write_text("\n".join(out) + "\n")
EOF
grep -c "tools_available: \[shorted" pipeline_defs/shorted-results.yaml
```
Expected: `10`.

- [ ] **Step 6: Run the tests**

Run: `.venv/bin/python -m pytest tests/shorted -q && .venv/bin/python -m pytest tests/shorted/test_e2e.py -q -m slow -k stand_ins`
Expected: the whole fast suite passes, then the stand-in end-to-end run on the recorded DRO dossier passes QA (about a minute). Then run `.venv/bin/python -m pytest tests/shorted -q -m slow` once: every slow test, including `test_end_to_end_real_render`, which renders both cuts for real and takes 10–15 minutes. Finally confirm the upstream suite against `.shorted-baseline.txt`:

```bash
.venv/bin/python -m pytest tests/contracts -q -p no:cacheprovider | tail -1
```

- [ ] **Step 7: Commit**

```bash
git add tools/shorted/reflect.py tools/shorted/cli.py pipeline_defs/shorted-results.yaml shorted-gaps/.gitkeep tests/shorted
git commit -m "feat(shorted): reflection ledger, stage CLI with checkpoints, manifest tools, end-to-end tests"
```

### Task 25: The entry-point skill in shorted.com.au

**Files:**
- Create: `shorted.com.au/.claude/skills/stock-report-video/SKILL.md`
- Also commit: `docs/superpowers/specs/2026-10-07-stock-report-video-design.md`, this plan, and `docs/superpowers/notes/2026-10-08-stock-video-data-collection.md`

**Interfaces:**
- Consumes: the studio CLI (Task 24) by absolute path. No OpenMontage code enters this repository.
- Produces: the `stock-report-video` skill, invoked as `/stock-report-video <TICKER>`.

- [ ] **Step 1: Work on a branch off main**

The shorted.com.au checkout carries unrelated work, and `main` may be checked out in another worktree:

```bash
cd /Users/benebsworth/projects/shorted.com.au && git fetch origin
git worktree add ../shorted-stock-report-video -b feat/stock-report-video-skill origin/main
cp docs/superpowers/specs/2026-10-07-stock-report-video-design.md ../shorted-stock-report-video/docs/superpowers/specs/
cp docs/superpowers/plans/2026-10-07-stock-report-video-phase1.md ../shorted-stock-report-video/docs/superpowers/plans/
mkdir -p ../shorted-stock-report-video/docs/superpowers/notes
cp docs/superpowers/notes/2026-10-08-stock-video-data-collection.md ../shorted-stock-report-video/docs/superpowers/notes/
```

- [ ] **Step 2: Write the skill**

`../shorted-stock-report-video/.claude/skills/stock-report-video/SKILL.md`:

````markdown
---
name: stock-report-video
description: Turn an ASX ticker into a results walkthrough video (about 5 minutes, 16:9) and a 60-90 second 9:16 short, built from Shorted's data in the paper-collage "Field Guide to the Bears" style. Use for "/stock-report-video DRO", "make a results video for BHP", or a short clip about a company's report and its short interest.
---

# Stock report video

One ticker in, two videos out. A **long cut** (16:9, 4:30–5:30, chapters) walks through the latest financial report with Shorted's short-interest, price, news and insider data. A **short** (9:16, 60–90 s, word captions) carries the three numbers that matter.

Each cut ships captioned and clean, with SRT and VTT. Each run also produces a thumbnail and a cover.

Every figure is bound to Shorted's API through a dossier. Nothing publishes.

The studio is `/Users/benebsworth/projects/shorted-studio`, an OpenMontage fork with the `shorted-results` pipeline pack. It is AGPL, so its code never enters this repository; drive it by path. Design: `docs/superpowers/specs/2026-10-07-stock-report-video-design.md`.

## Run it

All commands run from the studio root. `X` is the ticker.

```bash
cd /Users/benebsworth/projects/shorted-studio
.venv/bin/python -m tools.shorted.cli dossier --ticker X     # Shorted API -> dossier.json, coverage
.venv/bin/python -m tools.shorted.cli brand --ticker X       # logo + accent colour
```

Then write `projects/<X>-<date>/artifacts/storyboard.long.json` and `storyboard.short.json`. Follow the studio skill `skills/pipelines/shorted-results/storyboard-director.md`: scene types, bindings, formats and voice. Every figure must be a `{{path|format}}` binding; never type a number.

```bash
.venv/bin/python -m tools.shorted.cli storyboard --ticker X  # gates; writes artifacts/review.md
```

Show the user `artifacts/review.md` and **end your turn**. Only after they approve:

```bash
.venv/bin/python -m tools.shorted.cli approve --ticker X
for s in assets voice timeline score render qa reflect; do .venv/bin/python -m tools.shorted.cli $s --ticker X || break; done
```

`status` prints the stage rail. Any stage can be re-run alone; it reads files, not memory.

## The rules that make it honest

- **Bindings only.** The gates refuse a typed numeral in narration, props or the thumbnail. A `missing`, `withheld` or `untrusted` value shows as `n/a`, `n/m` or nothing, and can never be spoken.
- **No advice, no prediction, no causation.** The lint refuses buy/sell/hold calls, targets, "cheap" or "undervalued", "will rally", and any "because" or "driven by" in a sentence about the price or short interest. Say what happened and when, never why.
- **ASIC caveat.** Every scene showing short data carries "ASIC data shows the size of short positions, not who holds them or why." The timeline adds it.
- **Reporting currency.** BHP is US$; AUD shows as `A$`.
- **Dropped chapters.** A chapter without data is dropped and logged as a gap, never padded.
- **The end card is fixed** (`gates.END_CARD`): free to explore, the Premium offer at A$4/month, the data source, and "General information only. Not financial advice."

## Shorted's MCP server and the data-collection notes

`cli dossier` also reads the ticker through Shorted's MCP server (`https://api.shorted.com.au/mcp`,
anonymous, paced under 30 calls a minute) and writes `artifacts/mcp.json`. That file records whether
the API and MCP agree on the headline figures, and which dossier sections MCP cannot serve. A
mismatch is a Shorted defect to report; it never blocks the video.

If the Shorted connector is connected in this session, use its tools and its
`short_interest_briefing` prompt to find the story while you write the storyboard. Figures still
come only from dossier bindings. When MCP has something the dossier lacks, name the tool in a
`data_wishes` entry.

When `reflect` finds something new about how Shorted collects or serves data, add it to
`docs/superpowers/notes/2026-10-08-stock-video-data-collection.md` in this repository.

## When something fails

| Stage | Exit / symptom | Do |
| --- | --- | --- |
| dossier | exit 2 | The company or bears chapter has no data. Tell the user; do not make the video. |
| storyboard | gate errors | Fix the storyboard JSON and re-run `storyboard`. Edits after approval need a new approval. |
| voice | a line fails its check (`NarrationError` names the line and why: a figure heard wrong, the ending not heard, or WER over 0.10) | Rephrase it (awkward numbers are the usual cause), re-run `storyboard`, `approve`, `voice`. Lines that passed are kept and not re-voiced. |
| timeline | duration warning | Long too short: add a scene from an unused chapter. Too long: trim lines. |
| assets | plate not captured | Fine: the timeline drops that plate and its lines move to a neighbouring scene in the same chapter. If the plate was its chapter's only scene, `timeline` fails: re-run `assets`, or give that chapter another scene. |
| qa | a failed check | `qa.json` names the stage to re-run (`fix_in`). |
| any | exit 1 | The stage failed and printed `<stage> failed: <why>`; fix what it names and re-run that stage. |
| any | exit 3 | A stage ran out of order; run the earlier one. |

Before calling a run done, look at `renders/contact.long.jpg` and `renders/contact.short.jpg` yourself: legibility, nothing under the captions, no blank frames.

## Outputs (`projects/<X>-<date>/`)

- `renders/<X>_long_1920x1080_{captioned,clean}.mp4` and `renders/<X>_short_1080x1920_{captioned,clean}.mp4`
- `renders/<X>_{long,short}.{srt,vtt}` and `renders/<X>_long_chapters.txt` (paste into YouTube)
- `renders/<X>_thumb_1920x1080.png`, `<X>_thumb_1280x720.jpg`, `<X>_cover_1080x1920.png`
- `artifacts/dossier.json`, the storyboards, `qa.json`, `reflect.md`
- `shorted-gaps/backlog.md`: the ranked list of data Shorted lacked across runs. Mention its top three to the user.

## Cost and time

About 30 minutes of wall time plus review. The only paid call is Gemini TTS, a few cents a run.

Phase 2 adds ComfyUI and brandbrain art (with a $2 budget cap), the `bb` brand crawl and GitHub gap issues. Phase 3 adds batch runs.
````

- [ ] **Step 3: Check the skill against a dry run**

From the worktree, confirm every command in the skill exists:

```bash
cd /Users/benebsworth/projects/shorted-studio && .venv/bin/python -m tools.shorted.cli --help | head -20
```
Expected: usage that lists the stages `dossier brand storyboard approve assets voice timeline score render qa reflect status`.

- [ ] **Step 4: Commit (in the worktree)**

```bash
cd /Users/benebsworth/projects/shorted-stock-report-video
git add .claude/skills/stock-report-video/SKILL.md docs/superpowers/specs/2026-10-07-stock-report-video-design.md docs/superpowers/plans/2026-10-07-stock-report-video-phase1.md docs/superpowers/notes/2026-10-08-stock-video-data-collection.md
git commit -m "docs(skill): stock-report-video entry point, design, phase 1 plan and data-collection notes"
```
Opening a PR, and making a first real run (`/stock-report-video DRO`), are for the user to ask for.
