# asx-strategy-backtests — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec` (the `$imagegen` skill in its default built-in tool mode; not the CLI fallback, an API script or `scripts/image-gen`). New generation, no input or reference images, opaque background, 16:9.
- Run: Codex CLI, `codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -`, instructions on stdin (reproduced below), session `01a1b4c2-4ddc-7b20-be6a-3181fdd2f7d1` (2026-11-07). One `image_gen` call; the prompt Codex echoed back is identical to the prompt below.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a1b4c2-4ddc-7b20-be6a-3181fdd2f7d1/exec-34e7caca-6bd6-4ed7-902b-df91f1ec781d.png` (SHA-256 `08108a3a785d345593a03c25f982283f85f1450eef9661bb12201c0fe6bb927b`, identical to the workspace copy).
- Workspace original: `output/article-covers/asx-strategy-backtests.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/asx-strategy-backtests/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox).
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=asx-strategy-backtests`.
- Collection inspected before commissioning: `output/article-covers/review-sheet.jpg`. First cover for this slug; one generation, no revision. A punched paper tape with a wax seal was considered first and dropped: paper strips already carry five covers (reporting season, cost to short, short selling vs long investing, short squeeze explained, how to read short interest data).

## Editorial brief

Finding → subject → action → caveat: Shorted now replays each strategy's frozen rules over ASX history since 2019, after costs, and from the day the rules were frozen records them going forward → a wax phonograph cylinder on a steel mandrel, finely grooved along two thirds of its length and smooth beyond → the reproducer's needle rests exactly where the grooves end → the grooves are a replay of the past (a hypothetical, in-sample test), not a promise; the smooth wax is what has not happened yet.

Subject: A single burnt-amber wax phonograph cylinder sleeved over a slender steel mandrel, held by a bearing block at its left end; a slender steel reproducer arm on a post at the right.

Action: The needle rests on the cylinder's top at the boundary between the grooved section (the replayed history) and the smooth, unrecorded section (the forward record).

Hook: The arm's long taut diagonal down to the boundary, and the change from matte ribbed wax to glossy smooth wax under one raking light.

Large shapes: One long warm amber cylinder across the frame and one dark diagonal arm against a deep ink-green field.

Colour field: Deep ink green (a dark composition; its listing neighbours, the Zanger and ownership covers, are both light), charcoal steel, burnt-amber wax.

Material: Materially believable still life: wax with fine machined grooves, brushed steel with plausible joints and pivots. Wax and a cylinder silhouette are new to the collection.

Caveat: An editorial metaphor for a replayed historical record and a forward record, not a chart or a promise of returns. No gramophone horn, labels, musical notes, sound waves, money, arrows or rising lines; no text, numbers, logos, people or hands.

## Codex instructions (stdin, verbatim)

```text
Use your built-in image generation tool (image_gen) exactly once to create a NEW image from the prompt below. Pass the prompt to the tool verbatim, as the whole prompt, with a 16:9 landscape size and an opaque background. Do not use any CLI fallback, API script, Python or other generator. Do not edit, create or move any files, and do not run shell commands. When the tool returns, reply with the generated image's file path and the exact prompt you passed.

PROMPT (verbatim, between the markers):
<<<PROMPT
(the exact final prompt below)
PROMPT>>>
```

## Exact final prompt

```text
Use case: stylized-concept
Asset type: 16:9 landscape editorial article cover for Shorted, an Australian financial-data publication; it must also read clearly as a small thumbnail.
Primary request: Shorted now replays each trading strategy's fixed rules over seven years of share-market history, and from the day the rules were frozen it records them going forward. Show a single wax phonograph cylinder lying horizontally across the frame on a slender steel mandrel, seen from a low three-quarter angle and cropped close. The cylinder is solid burnt-amber wax. Its left two thirds are cut with very fine, evenly spaced grooves that give that part a matte, finely ribbed surface. Its right third is smooth, glossy and unrecorded, catching one clean specular highlight. A slender dark steel reproducer arm comes in from the upper right on a long taut diagonal, and its fine needle rests on the top of the cylinder exactly at the boundary where the grooves end and the smooth wax begins. That boundary, with the needle point on it, is the focal point.
Composition: The cylinder and the arm fill about two thirds of the frame; the needle point and the groove boundary sit inside the central 80% of the image, slightly right of centre, with a quiet pocket of dark background around them. The arm's diagonal is the strongest line. Build large simple value shapes first: one long warm amber cylinder and one dark diagonal arm against a deep ink-green field, with the matte grooved section and the glossy smooth section clearly different in value under a low raking light from the left.
Style: Materially believable editorial still life, close and calm. Real wax with fine machined grooves, brushed steel with plausible joints and a small pivot, a matte deep ink-green backdrop with a soft cast shadow beneath the cylinder. Restrained colour: ink green, charcoal steel, burnt-amber wax. No lens flare, haze, bloom, cinematic glow or neon.
Construction: The cylinder is one unbroken piece sleeved over the mandrel, which is held at its left end by a simple steel bearing block. The arm is one rigid piece pivoting from a small post at the upper right edge; the needle touches the wax at a single point and does not float or bend. Grooves run around the cylinder's circumference, parallel to its ends, and stop cleanly at the boundary.
Caveat: An editorial metaphor for a replayed historical record and a forward record, not a chart, interface or a promise of returns. No gramophone horn, record labels, musical notes, sound waves, coins, banknotes, arrows, rising lines or Australian symbols. No text, letters, numbers, logos, watermark, people or hands anywhere.
```

## Acceptance review

Selected. Inspected at full size, at 320 × 180 and 160 × 90, and side by side with asx-stock-picker-zanger-breakout-strategy v2 and shorted-ownership-explorer v1.

- Subject and action: one burnt-amber wax cylinder on a steel mandrel, grooved over its left two thirds and smooth and glossy over its right third; the reproducer's needle rests on the top surface exactly at the boundary.
- Value at 160 × 90: the amber cylinder separates cleanly from the ink-green field, the arm's diagonal leads to the boundary, and the smooth section reads lighter than the grooved one. The needle itself is too small to see at that size; the arm and the change of surface carry the moment.
- Construction: the cylinder is one piece sleeved over the mandrel, which runs from the bearing block on the left to the post on the right; the arm hinges at the top of the post through a short link and ends in a needle holder with a screw; the needle touches the wax at one point. The grooves run around the circumference and stop on one clean line.
- Caveat: no horn, labels, notes, waves, money, arrows or rising lines; no text, numbers or logos.
- Central 80%: the needle point sits at about 61% of the width and 44% of the height; the arm's pivot reaches the right edge, as the brief's post at the upper right asked.
- Collection: the only wax, cylinder and phonograph motif, and a dark field between two light neighbours in the strategies and ownership posts.
- Residual, accepted: the needle is a small detail at card size; the boundary is carried by the arm and the change of surface instead.

AI-generated editorial illustration, not a photograph.

