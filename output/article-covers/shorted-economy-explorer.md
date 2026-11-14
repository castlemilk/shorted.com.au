# shorted-economy-explorer — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec` (the `$imagegen` skill in its default built-in tool mode; not the CLI fallback, an API script or `scripts/image-gen`). New generation, no input or reference images, opaque background, 16:9. Codex noted that the tool has no separate size setting, so it took the 16:9 landscape format from the prompt.
- Run: Codex CLI 0.165.0, `codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -C <empty temp dir> --json -o last-message.txt -`, instructions on stdin (reproduced below), session `01a1c177-cca5-7350-aac9-d04dc38968e8` (2026-11-09 18:00–18:01 UTC, 10 November AEDT). One `image_gen` call: the session's image folder holds a single image, and the prompt Codex echoed back diffs identical to the prompt below.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a1c177-cca5-7350-aac9-d04dc38968e8/exec-ed9891cb-84ca-42e2-8ebd-0f705f037ec5.png` (SHA-256 `9d7f80f63c89e4845303e768204211edcae1887737ebb061645e8a08035df095`, identical to the workspace copy).
- Workspace original: `output/article-covers/shorted-economy-explorer.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/shorted-economy-explorer/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox).
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=shorted-economy-explorer`.
- Inspected before commissioning:
  - the collection, `output/article-covers/review-sheet.jpg`;
  - `docs/blog-thumbnail-directions.md` and the `shorted-editorial-art` skill;
  - the provenance of `shorted-ownership-explorer` and `why-short-interest-falls-without-covering`;
  - how the explorer links companies to states (operations-weighted, estimated exposure);
  - the subjects of the five covers commissioned alongside this one (short-interest alerts, stock pages, data centres, rate hikes, commodity shorts).
- Generations: first cover for this slug; four generations, the third selected. All four used the same prompt except the Composition paragraph, and every one placed the top of the mouth hoop above the central-80% line:
  - Attempt 1 (session `01a1c172-14eb-78a1-ab08-67faa160fa37`) was rejected on framing. The hoop top reached 5.4% of the height and the tail 92.6% of the width.
  - Attempt 2 (`01a1c175-4df0-7f53-971d-91dcde5de940`) moved the tail inside (88.3%), but the hoop top stayed at 7.8% and the lowest box ran off the left and bottom edges.
  - Attempt 3 is selected (below).
  - Attempt 4 (`01a1c17a-64b0-7dc0-aa48-3fe2b95bb383`), made after attempt 3 to clear the top margin, still reached 7.6%, with a slimmer windsock kinked before the tail. It was weaker than attempt 3.

## Editorial brief

Finding → subject → action → caveat: Shorted's free economy explorer sets each state's economic data, from public ABS, RBA and other series refreshed monthly, beside the listed companies that operate there → a burnt-orange windsock on a short brass mast fixed to the lid of a small stack of plain cream card boxes → a gust has just filled the windsock, so it streams out taut over the still boxes and makes the local conditions visible → the windsock reads the conditions where the companies stand. It does not move the boxes, forecast anything or say how any company's shares will do, and the boxes are no particular companies.

Subject: A classic windsock of burnt-orange waxed canvas, held open by a brass mouth hoop on a brass swivel at the top of a short brass mast. The mast is screwed by a small brass flange to the lid of a short stack of three plain lidded cream card boxes, largest at the bottom: the businesses on the ground under the local weather.

Action: A gust has just filled the windsock. It streams out to the right, taut and nearly level, tapering to its open tail, while the boxes beneath stay still.

Hook: The only saturated shape in a pale, still frame: the burnt-orange windsock flying out on a long, slight diagonal from the top of the mast, large against the modest stack beneath it. Its brass mouth hoop, seen as an ellipse, is the focal point.

Large shapes: One saturated burnt-orange tapered shape across the upper centre; a light cream stack with clear grey shadow planes low and left of centre; one thin brass vertical joining them; a plain pale grey-blue field around both.

Colour field: Pale grey-blue like a clear pale sky. This is a light composition, the field a step darker than the cream card, with cream card, brushed brass and one burnt-orange element. The collection's other pale grey-blue cover is institutional-vs-retail's dark cable reel on the floor; this one is a soft, airborne shape.

Material: Materially believable editorial still life on a seamless paper backdrop: cream card boxes with crisp edges, folded corners and visible card thickness; brushed brass rod, hoops, pivot and a screwed flange; waxed canvas with stitched seams and soft folds. A windsock, soft canvas and an airborne focal shape are new to the collection.

Caveat: An editorial metaphor for local conditions read beside the companies that work there, not a forecast, a live feed, a chart, a map or an interface. The weather is a steady breeze, not a storm, and nothing reads as good or bad conditions. The windsock does not lift, push or topple the boxes: the explorer sets data beside companies without claiming the state's economy drives their share prices, and its company-to-state links are estimates of where each company operates. No map, Australian outline, airport, runway, landscape, clouds, arrows, compass letters, dials, gauges or trays; no text, letters, numbers, logos, watermark, people or hands.

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
Primary request: Shorted's free economy explorer sets each state's economic data, from public statistical series refreshed monthly, beside the listed companies that operate there. Show a classic windsock on a short brass mast that is fixed to the lid of a small stack of plain cream card boxes. The windsock is one solid burnt-orange waxed-canvas sleeve, sewn at its mouth around a brass hoop that turns on a brass swivel at the top of the mast, with one thinner brass hoop partway along its body. A gust has just filled it: it streams out to the right, taut and nearly level, tapering to its open tail, whose last short section still ripples. The stack beneath it is three plain lidded cream card boxes of slightly different sizes, largest at the bottom, sitting still. The filled burnt-orange windsock flying out over the still boxes, and its brass mouth hoop, are the focal point.
Composition: Seen from a level three-quarter view at about the height of the top box, so the windsock flies against the backdrop and its mouth hoop reads as an ellipse. The camera stands well back: the whole stack stands on the floor of the paper sweep, fully in frame with a narrow strip of floor below it, and a clear band of plain backdrop runs above the windsock, about half as deep as the mouth hoop is tall. The stack sits left of centre; the mast rises from a small brass flange screwed to the lid of the top box; the windsock flies out to the right on a slight downward diagonal, about half the frame's width long and large against the modest stack, its open tail ending well short of the right edge. The whole windsock, its mouth hoop, the mast top and the flange sit well inside the central 80% of the image. Subject and action fill about two thirds of the frame, with a quiet pocket of plain backdrop around the windsock. Build large simple value shapes first: a plain pale grey-blue field, a light cream stack with clear grey shadow planes, one thin brass vertical, one saturated burnt-orange windsock.
Style: Materially believable editorial still life, close and calm, on a seamless pale grey-blue paper backdrop the colour of a clear pale sky, a clear step darker than the cream card. Cream card boxes with crisp cut edges, folded corners and visible card thickness; brushed pale-gold brass rod, hoops, swivel and flange with small screws; burnt-orange waxed canvas with stitched seams and soft folds. Soft directional daylight from the upper left with gentle shadows falling to the right. Restrained colour: pale grey-blue, cream, brass and one burnt orange. No lens flare, haze, bloom, cinematic glow, neon or uniform distressed grain.
Construction: The mast is one straight brass rod, fixed to the top box's lid by the screwed flange. Each box sits flat and square on the one below. The windsock is one continuous canvas sleeve, sewn around its mouth hoop, which turns on the swivel at the mast top; it is attached only there, not fused to the mast or floating. Shadows and perspective agree with the light. Nothing else in the image is orange.
Caveat: An editorial metaphor for local conditions read beside the companies that work there, not a forecast, chart, map or interface. The windsock reads the conditions; it does not lift, push or topple the boxes, and the weather is a steady breeze, not a storm. The boxes are plain and unlabelled. No stripes on the windsock, no airport, runway, landscape, horizon, clouds, birds or aircraft, no compass letters, arrows, dials or gauges, no map, Australian outline or national symbols. No text, letters, numbers, logos, watermark, people or hands anywhere.
```

## Acceptance review

Selected, with one residual stated below. Inspected at full size, at 320 × 180 and 160 × 90, with 2x zooms of the pivot and the stack. Compared side by side with all four attempts and with institutional-vs-retail-short-selling v3 (the collection's other pale grey-blue field), shorted-ownership-explorer v1, shorted-mcp-server v2, shorted-2026-platform-update v2 and asx-stocks-under-fire-october-2026 v1, and against the full review sheet.

- Subject and action: a solid burnt-orange windsock, filled and streaming out to the right on a slight downward diagonal, tapering to an open hemmed tail. It hangs from a short brass mast screwed to the lid of three stacked cream card boxes, largest at the bottom, which stand still on the paper floor.
- Value at 160 × 90: the windsock is the only saturated shape and reads first, burnt orange against pale grey-blue. The brass mast leads the eye down to a stack that still reads as three boxes.
- Construction: the mast is straight and stands on a two-screw flange. A knuckle on its top (cross-head screw) carries a short horizontal stub into a collar on the side of the mouth hoop. The canvas is stitched round the hoop, and a second hoop rings the body. The paper-wrapped boxes show tucked corner folds and lid overlaps, each sitting flat on the one below. The floor shadow falls to the right, consistent with the light. Nothing is fused, floating or bent.
- Caveat: no text, numbers, logos, stripes, arrows, compass letters, people or hands. No map, outline, airport or landscape, and nothing stormy; the boxes are plain.
- Central 80%: measured on the 1600 × 900 export, the windsock and hoop span 27.6% to 86.4% of the width and 7.3% to 44.0% of the height. The mast-top knuckle starts at 11.4% and the flange sits at 49% of the height. The stack spans 9.6% to 42.4% of the width and 49.0% to 95.9% of the height; its base and left corner are incidental edges.
- Collection: the only windsock, the only soft airborne focal shape and the first canvas in the set, with no tray, gauge, dial, magnifier, spring, vice, house, envelope or strip through a frame. Institutional-vs-retail shares the pale grey-blue field but is a heavy dark cable reel and spool on the floor.
- Residuals, accepted:
  - The top of the brass mouth hoop rises about 24 px (2.7% of the height) above the central-80% line. It is untouched in the 16:9 card and thumbnail and in a centred 1.91:1 or 2:1 social crop, but a crop to the central 80% would clip the top of the ring. All four generations put the hoop top between 5.4% and 7.8% despite explicit framing in the prompt.
  - The prompt asked for a rippling tail; the tail shows soft folds rather than a distinct ripple.
  - The swivel is drawn as a knuckle pivot rather than a vertical bearing.
  - Neither difference shows at card size.

AI-generated editorial illustration, not a photograph or handmade construction.
