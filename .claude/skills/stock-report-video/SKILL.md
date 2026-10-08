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
