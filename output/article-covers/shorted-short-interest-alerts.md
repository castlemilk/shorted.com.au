# shorted-short-interest-alerts — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec` (Codex's own image tool, called directly; not a CLI fallback, an API script or `scripts/image-gen`). New generation, no input or reference images, opaque background, 16:9.
- Run: Codex CLI 0.165.0, `codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -C <empty temp dir> --json -o last-message.txt -`, instructions on stdin (reproduced below), session `01a1c183-5e4e-7e31-ba67-84064fd68f65` (2026-11-10 AEDT; 18:12–18:14 UTC on 9 November). One `image_gen` call and one image in the session; the prompt Codex echoed back diffs identical to the prompt below.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a1c183-5e4e-7e31-ba67-84064fd68f65/exec-15d2b110-7133-409c-93f6-f3d0f989b193.png` (SHA-256 `6997ef8b94be903f7d4ee6e7e1f8c74664180196ba16e2fb3dc5b49f573b82ab`, identical to the workspace copy).
- Workspace original: `output/article-covers/shorted-short-interest-alerts.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/shorted-short-interest-alerts/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox).
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=shorted-short-interest-alerts`.
- Inspected before commissioning:
  - the whole collection in `output/article-covers/review-sheet.jpg`;
  - `docs/blog-thumbnail-directions.md` and `.claude/skills/shorted-editorial-art/SKILL.md`;
  - the provenance of `shorted-ownership-explorer`, `why-short-interest-falls-without-covering`, `shorted-for-discord` and `what-happens-after-asx-short-interest-peaks`;
  - every published `coverAlt`;
  - the subjects of the five covers commissioned in the same round (economy explorer, stock pages, data centres, rate rises, commodity stocks).
- First cover for this slug. There were three generations; the third was selected and is published as v1.

## Generations

All three went through the same command, one image per session, with no reference images.

1. **v1** (session `01a1c17c-b984-7871-9e25-c6bdf49b5d0b`, SHA-256 `d0b0ce348421dca6e243dc2f6a54c6d4f6f808340d497aa70cfe90fc8e33f409`): rejected.
   - The generator ran the line through the kraft tag's eyelet, so the tag was tied onto the line rather than crossing it.
   - With twisted red twine and a polished jingle-shaped bell, the picture read as a gift tag on a Christmas bell.
   - Both anchors fell outside the central 80%: the pin at about 7–10% across, the bracket post at about 89–100%.
2. **v2** (session `01a1c17f-d99e-79c0-9870-128c2cd98369`, SHA-256 `1506a7b7a4639844c1ecf1ff27d5cf473806f5c8a534be9d5dfdbc890e3f0f67`): passed the action and material checks but was not selected.
   - It fixed the action: a charcoal card with no hole pushed a braided line into a V, and the bell was plain and worn.
   - The pin straddled the safe area's left edge, the bracket's top rose above it and the bell's lip crossed its right edge.
   - The octagonal card was larger than the bell and read as a slate at card size.
3. **v3**: this cover. It keeps v2's action and materials, with the tag cut like a shipping tag and smaller than the bell, and wider framing.

The rejected originals, their prompts and their reviews were working files in the session scratchpad; only the selected original is kept here.

## Editorial brief

Finding → subject → action → caveat: Shorted Premium emails you when short interest in a stock or industry you watch crosses a line you set, soon after ASIC publishes (four trading days after the position date) → a taut vermilion line strung as a tripwire across a loose cream ledger page to a plain cast-brass bell → a blank charcoal tag has slid into the line and pushed it into a sharp V, and the pull tips the bell so it rings → the bell answers a line that has already been crossed: it reports a level after the fact, not a forecast, and implies no live feed or trading signal.

Subject: One smooth, heavy braided vermilion line (a mason's line) stretched taut across a large loose sheet of heavy cream ledger paper. It is knotted at the left around a domed brass pin and at the right around the shoulder of a plain, teacup-sized cast-brass bell, which hangs from a small rigid brass bracket standing on the petrol surface just beyond the page. One blank charcoal card cut like a shipping tag, with no hole or string, stands for the stock being watched.

Action: The tag has just slid into the line and pushed it into a sharp V at the tag's clipped end. The pull has tipped the bell about twenty degrees off vertical on its pivot, toward the line, and its clapper has swung against the inside of the lip at the moment it rings.

Hook: The long taut vermilion diagonal across the cream page, broken by one sharp V where the dark tag meets it, leads the eye to the tilted bell, the only off-vertical form in an otherwise still scene.

Large shapes: A big pale cream page lying at an angle across a dark smoky petrol-teal field; a dark charcoal tag on the page; the bright brass bell silhouetted against the dark field beyond the page edge; one saturated vermilion line joining them.

Colour field: Deep smoky petrol teal, a muted dark blue-green that sits between the collection's ink-green and mineral-blue covers and is used by none of them; cream paper, charcoal card and brass. The vermilion line is the one warm accent, the house burnt-amber note pushed toward red for contrast with the teal.

Material: Materially believable still life with the matter-of-fact look of a working desk, not gift wrap or a product shot. Heavy cream ledger paper has a cleanly cut edge, visible fibres and a few faint, widely spaced ruled lines with nothing written on them. The cast brass has a soft polish, honest wear and coherent reflections of the teal. The smooth braided line casts a thin crisp shadow on the paper, and the charcoal card is matte with crisp cut edges. A bell and a tripwire are new to the collection, and the page is a single loose sheet, not the bound ledger of this round's commodities cover.

Caveat: An editorial metaphor for an alert that reports a crossing after it has happened, not a forecast, trading signal, chart, map or interface. The line is one the reader sets, not a price line. No arrows, axes, chart lines, envelopes, phones, screens, alarm lights, sound waves or motion lines; no gauge, dial, magnifier, spring, vice, house or strip through a frame; no bow, ribbon or gift wrapping; no text, letters, numbers, logos, watermark, people or hands.

## Codex instructions (stdin, verbatim)

The block between the markers is the exact final prompt below, byte for byte.

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
Primary request: Shorted alerts a reader when short interest in a stock they watch crosses a line they have set, and the alert reports a level after the fact, not a forecast. Show a single taut tripwire on a desk: one smooth, heavy braided vermilion string line, like a mason's line, stretched tight across a large loose sheet of heavy cream ledger paper that lies at an angle on a deep smoky petrol-teal surface. The left end of the line is knotted around a domed brass pin pushed into the paper about a fifth of the way in from the left edge of the image, well clear of that edge. The right end runs off the page's right edge and is tied to the shoulder of a plain, heavy cast-brass bell with straight flared sides and a thick lip, like a small ship's bell, about the size of a teacup. The bell hangs mouth-down by its crown from the arm of a small rigid brass bracket (an upright post on a round foot with one short horizontal arm) standing on the teal surface just beyond the paper. One blank charcoal-grey card tag lies flat on the page on the near side of the line: it is shaped like a shipping tag, with its corners clipped only at the end that meets the line and square corners at the other end, and it has no hole, no eyelet and no string. It is modest in size, about two thirds of the bell's height. The tag has just slid into the line: its clipped end pushes the line into one deep, sharp V that points away from the viewer, the line pressing against the tag's edge only, not tied to it or threaded through it. The pull has tipped the bell about twenty degrees off vertical on its pivot, toward the line, and its clapper has swung against the inside of the lip at the moment it rings. The V in the line and the tilted bell are the focal point.
Composition: Three-quarter view from about thirty-five degrees above the desk, framed a little wider so the whole mechanism sits comfortably inside the image. The page fills the lower left and centre and runs out of the frame at the bottom left. The line is one long taut diagonal from the pin to the bell, so the eye runs from the tag and the V to the bell. The bell is large in the frame, about a third of the image height, and hangs against the dark teal surface, not over the paper. Keep clear margins on every side: the pin sits about a fifth of the way across; the bell's right lip ends no more than 85% of the way across; the top of the bracket post sits at least an eighth of the image height below the top edge; the tag stays clear of the bottom edge. The pin, the tag, the V, the bell and the whole bracket all sit inside the central 80% of the image, with a quiet pocket of dark teal around the bell. Build large simple value shapes first: a big pale cream page on a dark petrol-teal field, a dark charcoal tag on the cream page, a bright brass bell against the dark field, and one saturated vermilion line joining them.
Style: Materially believable editorial still life, calm and precise, with the matter-of-fact look of a working desk rather than a gift or a product shot. Heavy cream ledger paper with a cleanly cut edge, visible fibres and a few faint, widely spaced pale ruled lines with nothing written on them; cast brass with a soft polish, small honest wear and coherent reflections of the teal surroundings; a smooth braided line that casts a thin crisp shadow on the paper; a matte charcoal card tag with crisp cut edges. One low daylight from the upper left, soft contact shadows. Petrol teal, cream, brass, charcoal and one vermilion accent; no other strong colours. No lens flare, haze, bloom, cinematic glow, neon or uniform distressed grain.
Construction: The line is one continuous, unbroken length from the pin to the bell, knotted at both ends and straight and taut on either side of the V. The bell hangs from the bracket arm on a visible pivot pin; the bracket is rigid brass, with no coiled spring. Exactly one line, one tag, one bell and one pin; the tag and the pin are the only objects on the page. Nothing fused, floating, melted or duplicated. The paper is a single loose sheet, not a bound book.
Caveat: An editorial metaphor for an alert that reports a level after it has been crossed, not a forecast, trading signal, chart, map or interface. No arrows, axes, chart lines, envelopes, phones, screens, alarm lights, sound waves or motion lines. No gauge, dial, magnifier, spring or vice; no bow, ribbon, twine, decoration or gift wrapping. The tag and the page are blank: no text, letters, numbers, logos, watermark, people or hands anywhere.
```

## Acceptance review

Selected. Inspected at full size (1600 × 900, with zoomed crops of the bell, the contact point and the pin), at 160 × 90 in colour and greyscale, and in a 320 × 180 sheet beside v2, `asx-stocks-under-fire-october-2026` v1, `institutional-vs-retail-short-selling` v3, `shorted-mcp-server` v2, `what-happens-after-asx-short-interest-peaks` v1, `substantial-holder-notices-explained` v3 and `how-to-read-short-interest-data` v2.

- **Subject and action:** a blank charcoal card cut like a shipping tag has slid into a taut vermilion braided line and pushed it into a sharp V. The line is not tied to or threaded through the tag. The pull has tipped a plain cast-brass bell on its pivot, its mouth swung toward the line and its clapper against the inside of the lip.
- **Value at 160 × 90:** the brass bell is the largest bright shape and reads as a bell against the teal; the dark tag and the red V on the cream page carry the eye along the line to it. Mean luma on the 1600 × 900 frame: page 208, tag 80, teal field 44–52, bell body about 99 with brighter highlights.
- **Construction:** one continuous braided line, knotted around the pin's shank and around the bell's shoulder, straight and taut on both sides of the V. The bell hangs by its crown loop from a shackle on a pivot pin at the end of a rigid arm on an upright post with a round foot. The tilt is the one a pull at its upper shoulder would produce, and shadows agree with light from the upper left. The line sits in a slight dent at the tag's clipped end, plausible for card under tension. Nothing is fused, floating or duplicated.
- **Caveat:** no text, glyphs, numbers, logos, people, hands, chart, map or interface. The bell carries only pitting and scratches, and the page's faint rules are blank. There is one line, one tag, one bell and one pin.
- **Central 80%:** measured by colour on the 1600 × 900 frame (the export's geometry):
  - the V apex sits 39.4% across and 62.3% down;
  - the tag spans 25–44% across and 60–87% down;
  - the bell and its pivot span 64–85% across and 12–59% down.
- **Collection:** the only bell or tripwire and the only petrol-teal field in the collection. Its nearest material neighbour, the brass gauge ringed with paper tags on cream (`asx-stocks-under-fire-october-2026`), differs in field and silhouette and in having a single tag.
- **Residuals, accepted:**
  - The bracket's post and foot stand at about 86–95% across, outside the central 80%, and the pin's domed head begins at 8.9% across, its shank and knot inside. An 80% crop keeps the bell, its pivot and the whole action, and trims the post and the edge of the pin head.
  - The prompt asked for the pin about a fifth of the way across and the post within 85%; neither shows at card size.

AI-generated editorial illustration, not a photograph or a handmade still life.
