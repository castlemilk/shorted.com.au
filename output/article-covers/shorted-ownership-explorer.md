# shorted-ownership-explorer — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec` (the `$imagegen` skill in its default built-in tool mode; not the CLI fallback, an API script or `scripts/image-gen`). New generation, no input or reference images, opaque background, 16:9.
- Run: Codex CLI 0.165.0, `codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -`, instructions on stdin (reproduced below), session `01a1b05c-7b02-7081-9c67-ad81f5a8983b` (2026-11-06). One `image_gen` call; the prompt Codex echoed back diffs identical to the prompt below.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a1b05c-7b02-7081-9c67-ad81f5a8983b/exec-05f5c70e-c523-40f6-86ed-b08997262e51.png` (SHA-256 `cf6abb1557e47eb8b91975fa61c4adf45091185e04fe8c63b92f352fdd4e0458`, identical to the workspace copy).
- Workspace original: `output/article-covers/shorted-ownership-explorer.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/shorted-ownership-explorer/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox).
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=shorted-ownership-explorer`.
- Collection inspected before commissioning: `output/article-covers/review-sheet.jpg`. First cover for this slug; one generation, no revision.

## Editorial brief

Finding → subject → action → caveat: Shorted pieces together who holds each ASX company from separate public disclosures, and leaves clear what none of them shows → a modern geometric leadlight panel on a glazier's light table, mostly clear glass with a few muted coloured panes → the last pane, burnt amber, is being set into its opening, one edge seated in the lead came and the other lifted → the coloured panes stand for the holders of 5% or more that notices name; the clear glass is everyone no notice shows, and pane sizes measure nothing.

Subject: A modern rectilinear leadlight panel (lead came, textured glass) lying flat on a glazier's light table, a dark walnut workbench at one side.

Action: A burnt-amber pane is caught mid-placement, seated along one edge of its opening and lifted on the other, so it stands at a diagonal above the flat panel; the bright empty opening shows beneath it.

Hook: The only tilted shape in a flat, rectilinear panel: the amber pane's diagonal, the bright gap under it and the amber light it casts across the clear glass.

Large shapes: Dark lead lines over a bright warm-white field; a few mid-tone coloured panes at the edges; one saturated amber pane and its cast patch at the centre.

Colour field: Warm paper-white light (a light composition, after the charcoal Discord and dark-oak substantial-holder covers), deep ink green, mineral blue, oxblood and ochre panes, burnt amber.

Material: Materially believable still life: textured glass with faint seeds and coherent refraction, soft grey lead came with soldered joints, even backlight from the table. Glass and lead are new to the collection.

Caveat: An editorial metaphor for a register assembled from disclosures, not a chart, map or interface. Pane sizes are not stakes, and nothing implies a complete register, control or a recommendation. No church window, figures, ornament or Australian symbols; no text, numbers, logos, people or hands.

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
Primary request: Shorted pieces together who holds each listed company from separate public disclosures, and leaves clear what none of them shows. Show a modern geometric leadlight glass panel lying flat on a glazier's light table, seen from a high three-quarter angle. The panel is a modernist arrangement of irregular rectangles and a few angled quadrilaterals of different sizes, joined by soft grey lead came with small soldered joints. Most panes are clear, faintly textured glass that shows the even warm-white light beneath. Four or five panes are muted coloured glass: deep ink green, mineral blue, oxblood and ochre. One opening, slightly right of centre, is still being filled: a burnt-amber glass pane is caught mid-placement, its lower edge seated in the lead channel and its upper edge lifted, so it stands at a clear diagonal above the flat panel. The bright empty opening beneath it, and the amber patch of light the lifted pane casts across the clear glass, are the focal point.
Composition: The panel and the lifted amber pane fill about two thirds of the frame; the amber pane and its opening sit inside the central 80% of the image, with a quiet pocket of clear glass around them. A dark walnut workbench frames the light table at one side. The amber pane is the only tilted shape in an otherwise flat panel. Build large simple value shapes first: dark lead lines over a bright field, a few mid-tone coloured panes, one saturated amber pane.
Style: Materially believable editorial still life, close and calm. Real glass with coherent refraction and faint seeds, lead came with crisp soldered joints, soft even backlight from the table and one low daylight from the upper left. Warm paper-white light, charcoal lead, restrained colour. No lens flare, haze, bloom, cinematic glow or neon.
Construction: Every pane sits inside the lead came. The amber pane is one flat, unbroken piece of glass resting in the came channel along its lower edge, not floating, fused or bent. The came lines meet at plausible soldered joints, and reflections and the amber cast patch agree with the light.
Caveat: An editorial metaphor for a register assembled from disclosures, not a chart, map or interface; pane sizes measure nothing. No church window, arches, figures, flowers, ornament, religious imagery or Australian symbols. No text, letters, numbers, logos, watermark, people or hands anywhere.
```

## Acceptance review

Selected. Inspected at full size, at 320 × 180 and 160 × 90, and side by side with hello-world v2, substantial-holder-notices-explained v3, shorted-for-discord v1 and shorted-mcp-server v2.

- Subject and action: a modern geometric leadlight on a light table, most panes clear textured glass, four muted coloured panes (ink green, mineral blue, ochre, oxblood) at the edges, and one burnt-amber pane swung up out of its opening on a diagonal, the bright empty opening beneath it.
- Value at 160 × 90: the amber pane is the only saturated shape and reads first; the bright opening and the amber cast patch hold the eye on it; the lead lines give the panel its structure without competing.
- Construction: the amber pane is one flat piece of glass hinged along the left edge of its opening, which it shares with the lead came, and lifted along its right edge; its projected shape is consistent with that rotation and the opening it leaves. Joints carry solder; nothing is fused, floating or bent.
- Caveat: no text, numbers, logos, figures, arches or religious imagery; the panes are rectangles of no particular proportion, and most of the panel is clear.
- Central 80%: measured on the 1600 × 900 export, the amber pane spans 42.8% to 78.7% of the width and 19.1% to 64.3% of the height, and its opening reaches 81.9% of the width.
- Collection: the only glass-and-lead cover and a light field among dark neighbours. Its nearest motif is hello-world's grid of charcoal tiles with one amber tile on oxblood; this one is translucent glass on a light field, irregular rather than a grid, and its amber piece is lifted out of the plane rather than set flat in it.
- Residuals, accepted: the prompt asked for a pane seated along its lower edge and a daylight from the upper left; the pane is seated along its left edge, and the amber patch falls to the left, so the light reads as coming from the right. Nothing else in the image contradicts that light, and neither difference shows at card size.

AI-generated editorial illustration, not a photograph or handmade leadlight.
