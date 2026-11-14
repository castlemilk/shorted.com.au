# asx-data-centres-deep-dive — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec`: Codex's own image tool called directly, as instructed; not a CLI fallback, an API script or `scripts/image-gen`. New generation, no input or reference images, opaque background, 16:9.
- Run: Codex CLI 0.165.0 (`codex-cli 0.165.0`), `codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -C <empty temp dir> --json -o last-message.txt - < instructions.txt`, with the instructions on stdin (reproduced below), session (thread) `01a1c17f-7d3f-7dd3-b17f-ce1aa89eeab0`. Run 2026-11-10 05:08–05:09 AEDT (2026-11-09 18:08:40–18:09:54 UTC) through the session's `gen-cover.sh` wrapper (`gen-cover.sh prompt-v4.txt v4.png run-v4`). The session's `generated_images` folder holds exactly one image (one `image_gen` call), and the prompt Codex echoed back is byte-identical to the prompt below.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a1c17f-7d3f-7dd3-b17f-ce1aa89eeab0/exec-42dad37e-3f03-4226-bdff-628ef30541ea.png` (SHA-256 `e8e111a66fc4399d8a7bea857aab367fc22ca9dd0e7a24761df8b92d1e0f57be`, identical to the workspace copy).
- Workspace original: `output/article-covers/asx-data-centres-deep-dive.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/asx-data-centres-deep-dive/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox). It is published as v1 and was the fourth generation.
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=asx-data-centres-deep-dive`.
- Inspected before commissioning:
  - The collection, `output/article-covers/review-sheet.jpg` and `thumbnail-proof.jpg`.
  - `docs/blog-thumbnail-directions.md` and the `shorted-editorial-art` skill.
  - The provenance of `shorted-ownership-explorer` (format) and `why-short-interest-falls-without-covering`.
  - The NXT newsroom cover's provenance, `nxt-shorts-8pc-into-40pc-fall-jemena-m3-delay.md`: an ivory server-slat building on mineral blue with a plug stopping short of its socket. Its plug, socket, air gap and blue are avoided here.
  - The post's research notes: AEMO's 2026 ESOO connection-capacity utilisation, NEXTDC's 21 October M3 update on Jemena's suspended 66kV works, and the RBA's November Statement.
- Generations: four, one direction refined in three revisions. v1–v3 were rejected (below), and v4 was selected.

## Generations

1. **v1, rejected.** Session `01a1c173-e804-7fd3-b09e-087f45d7ac1d`, SHA-256 `574e051645e234dad99063bf0f3fe5aea1cc56d09029047b8d4dd092081cf61d`. Four squat, cube-like cabinets with a sturdy bushing about 60% of their height: it read as a lamp on a sideboard, not a load fed through a narrow neck. The thin rigid copper rod shrank to a hairline at 160 × 90.
2. **v2, passed but superseded.** Session `01a1c178-6ae6-7c43-a92e-70d39147fa07`, SHA-256 `0855a01b1ffb30c761357fe41884356bc6c2dc47aeec29da804cf37938ce944b`. A towering row of full-height racks ran past the right and bottom edges, with a long slender bushing and a heavy stranded cable. It passed every check, but the racks sat in a low band and plain ground filled about half the frame (racks about 29% of it).
3. **v3, rejected.** Session `01a1c17c-e5cd-7200-a590-ee98b512c2f6`, SHA-256 `3cebc9ff8b264ee8cab1fde5ad8492201e6e7c0c15cd6e1fb1138f8cd17f6b83`. The prompt asked for the roofline just below the middle of the frame. The model kept it at about 64% of the height and set the row almost square-on, which flattened v2's depth and left as much empty ground.
4. **v4, selected.** The camera moved a little above the roofline, looking down the row. The row climbs diagonally toward the top right (racks about 42% of the frame, the whole subject about 47%), and its receding roofline leads the eye back to the neck.

## Editorial brief

Finding → subject → action → caveat: Data-centre investment is the one boom in the RBA's November forecasts, but grid connections set its pace. Operating sites draw about a quarter (AEMO: about 27%) of the connection capacity they hold, because that capacity is secured years before the halls fill, and NEXTDC lost a year at M3 waiting on one 66kV network upgrade → a long row of full-height server racks in matte steel whose whole supply enters through one slender glazed-white porcelain high-voltage bushing on its roof → a single bright copper cable is drawn taut into the top of that narrow neck, the only way power gets in → the connection paces a real build-out. Nothing fails, sparks or is cut, and no real site or company is shown.

Subject: A long row of full-height data-centre server racks bolted side by side (matte bead-blasted steel in mid steel-grey, fronts of flat unlit graphite server units with fine vent slots), running out past the right and bottom edges. On the roof at its near left corner stands one slender glazed-white porcelain high-voltage bushing with many thin ribbed sheds, rising from a broad burnt-orange enamelled steel flange. v1 commissioned a block of four cabinets; from v2 onward the subject was this row.

Action: A single heavy, bright stranded copper cable runs in one straight, taut diagonal from beyond the top-left corner into a clamp on the bushing's top. Everything the row will draw has to pass through that one narrow porcelain neck.

Hook: An extreme difference in scale between a steel mass bigger than the frame and one slender white neck. Two diagonals converge on the neck: the receding roofline leads up to its base, and the copper cable leads down to its top.

Large shapes: A dark warm-graphite field. A mid-grey steel mass climbs from the lower left of centre to the top right, with a lit roof plane and a lit near end. One tall, bright-white vertical (the bushing) stands at its near corner, with a burnt-orange spot at its base and one copper line crossing the upper left.

Colour field: Warm graphite and charcoal (assigned), glazed porcelain white, bright copper, matte steel grey and one burnt-orange accent. The collection's other charcoal covers (beginner guide, caliper, platform update, peaks, rosette) are paper and small steel objects, while this is a rising industrial mass with a ceramic neck. No navy or blue, after the NXT newsroom cover.

Material: A materially believable studio still life. Glazed porcelain has a crisp glaze highlight and round, coaxial sheds. Stranded copper has warm reflections. Bead-blasted steel has bolted seams, and the flange is burnt-orange enamel. Porcelain and copper are new to the collection.

Caveat: The connection sets the pace of a real build-out. It is not an outage, an overload or failed demand, and the narrow neck says nothing about how much of a connection is used. No sparks, glow, smoke, breaks, gaps, plugs or sockets. No glowing screens, indicator lights, data streams or sci-fi light. It is not NEXTDC's or any real facility, and the bushing's size measures nothing. Not a chart, map or interface. No text, letters, numbers, rack markings, logos, watermark, people or hands.

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
Primary request: Data-centre investment is booming, but grid connections set its pace: the buildings can grow only as fast as their power connections arrive. Show a towering block of full-height data-centre server racks bolted side by side into one continuous wall of matte bead-blasted steel in a mid steel-grey, each rack more than twice as tall as it is wide, its front made of rows of flat, unlit graphite server units with fine ventilation slots. The block is so large that it runs past the right edge and the bottom edge of the frame. It stands against a plain warm graphite backdrop. The whole block's power supply enters through one slender high-voltage bushing standing upright on its roof at the near left corner: a long, narrow column of glazed white porcelain with many thin ribbed sheds, no wider than a third of one rack, rising from a broad burnt-orange enamelled steel flange bolted to the roof. A single heavy stranded copper cable, bright and about as thick as a thumb, is drawn taut from a plain clamp on top of the bushing in one straight diagonal up and out past the top-left corner of the frame. The narrow white porcelain neck, with the copper cable entering its top, is the focal point: everything the massive block will use has to pass through it.
Composition: Three-quarter view from the front left and a little above the roofline, looking slightly down along the row, so the roof is a long receding plane, the flange is fully visible and the racks fall away below the frame. The row runs diagonally from its near corner, a little left of centre and a little below the middle of the frame, up toward the top-right corner and out past the right edge, so steel fills the right half and the lower part of the frame. The bushing rises from that near corner to about an eighth of the frame below the top edge, so one huge steel mass against one slender white neck makes an extreme difference in scale, and the receding roofline leads the eye back to the neck. The bushing, its burnt-orange flange and the cable clamp sit inside the central 80% of the image, with a quiet pocket of plain graphite around the bushing; the open graphite stays smaller than the block. Build large simple value shapes first: a dark graphite field, a mid-grey steel mass, one bright white porcelain neck, one heavy copper line and one small burnt-orange flange.
Style: Materially believable editorial still life, like a studio photograph of real objects rather than a render. Glossy glazed porcelain with a crisp highlight along its sheds, bright copper strands with warm reflections, bead-blasted steel with crisp bolted seams. One low warm key light from the left that rakes the porcelain and the near end of the block and falls off along the block to the right, with soft fill. Warm graphite, porcelain white, copper, steel grey and one burnt-orange accent; restrained colour. No lens flare, haze, bloom, glow, neon or cinematic orange light.
Construction: Exactly one bushing and exactly one cable. The bushing is vertical and sits squarely on its flange, which is bolted flat to the roof; its sheds are round, evenly spaced and share one axis. The copper cable is one continuous straight length clamped into the bushing's top terminal. There are no other cables, wires, poles, towers, plugs or sockets anywhere. The racks share one roofline, with straight edges and plausible seams; nothing is melted, fused, bent or floating. Shadows and reflections agree with the one light.
Caveat: An editorial metaphor for a build-out paced by its grid connection, not an outage, overload or failure: no sparks, lightning, smoke, glow, breaks, gaps or warning signs. Not a depiction of any real company or facility; the bushing's size measures nothing. No glowing screens, indicator lights, data streams, light trails or sci-fi light; no navy or blue. Not a chart, map or interface. No text, letters, numbers, rack-unit markings, labels, logos, watermark, people or hands anywhere.
```

## Acceptance review

Selected. Inspected at full size, with the central-80% overlay, at 320 × 180 and 160 × 90, and in 2× detail crops of the clamp, the whole bushing, the flange and roof corner, the mid-roof seams and the far end. It was compared side by side with v1–v3 and with short-squeeze-explained v3, how-to-read-short-interest-data v2, shorted-2026-platform-update v2, what-happens-after-asx-short-interest-peaks v1, institutional-vs-retail-short-selling v3 and days-to-cover-asx v2.

- **Subject and action.** A long row of full-height steel server racks climbs from its near corner toward the top right and runs out of frame. At that corner, one tall, slender glazed-white porcelain bushing stands on a burnt-orange flange, with one taut stranded copper cable clamped to its top from beyond the top-left corner.
- **Value at 160 × 90.** The white ribbed column reads first, then its orange base, the copper line into its top and the grey diagonal block. Measured on the 1600 × 900 export:
  - Ground: L≈49–53 of 255.
  - Porcelain: median L 151, highlights L 216.
  - Flange: saturated burnt orange (L 109).
  - Copper: L 100–170 along its run.
  - Lit roof and near side panel: L 96.
  - The vented rack fronts (L 39) sit slightly darker than the ground, so the block reads by its bright roof edge and near end.
- **Construction.**
  - About 17 sheds are evenly spaced, coaxial and slightly tapered toward the top, seated in the flange collar.
  - Eight nuts on studs bolt the flange flat to the near rack's roof. Its shadow falls to the right, consistent with the left key light.
  - The cable is seated in a steel block clamp with a hex bolt.
  - The roof's cross seams meet the front edge at the rack posts, and the row recedes consistently toward an eye level above the roof.
  - Nothing is fused, floating, bent or melted.
- **Caveat.** There are no sparks, glow, breaks, gaps, plugs, sockets, screens or indicator lights, and no text, numbers, rack markings, logos, people or hands. It is not a chart, map or interface, has no blue, and shows no recognisable facility.
- **Central 80%.** Measured on the 1600 × 900 export, the clamp spans 30.1–33.5% of the width and 14.9–21.0% of the height. The porcelain spans 28.6–35.4% of the width, from the clamp down to the flange collar at about 62% of the height, and the flange spans 25.4–37.3% and 61.6–69.0%. Only the cable's run to the corner and the rack row's continuation leave the box, by design.
- **Collection.** It is the only porcelain, copper or server cover, and the only rising diagonal mass on graphite. The straight ribbed column does not read as the squeeze cover's helical steel spring on oxblood. The bottleneck is a vertical ceramic neck, unlike days-to-cover's paper chute on blue.
- **Residuals, accepted.**
  - Plain graphite remains above the receding roofline, and the whole subject covers about 47% of the frame, under the two-thirds starting point. That open ground is the quiet pocket that isolates the slender neck.
  - Like every attempt, the finish is close to a clean product photograph, with uniform server faces, as on the collection's backtests and platform-update covers.

AI-generated editorial illustration, not a photograph of any real data centre, substation or company asset.
