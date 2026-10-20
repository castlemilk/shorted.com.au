# shorted-for-discord — editorial v1 (commission, not yet generated)

- Status: **brief and prompt only.** Generate with the built-in `image_gen` tool
  (`$imagegen`, see `.claude/skills/shorted-editorial-art/SKILL.md`), then
  replace this status line with the mode, the source path and the review below.
- Mode: built-in `image_gen`, new generation.
- Original (to save): `output/article-covers/shorted-for-discord.png`.
- Cover (to export): `web/public/assets/blog/shorted-for-discord/cover-editorial-v1.webp`, 1600 × 900.
- Thumbnail: from `web/`, `node --import tsx scripts/editorial-thumbnails.mts --slug=shorted-for-discord`.
- Reference inputs: `output/article-covers/captivating-revisions.jpg` (craft and impact), `output/article-covers/review-sheet.jpg` (neighbours).

## Brief

Finding → subject → action → caveat: a chart posted into a conversation can be
redrawn in place by anyone in it → a split-flap panel (the departure-board kind)
→ its upper flap is mid-fall, revealing a different ink line, while one key in a
row beneath it is pressed down → it redraws from the latest published data, not
a live ticker.

- **Subject:** one large warm-paper split-flap panel, seen slightly from below
  at three-quarters, with a row of five chunky keys in front of it.
- **Action:** the upper flap is caught halfway through its fall; the line it
  carried is visibly different from the line on the panel it uncovers. One key,
  the only amber one, is pressed down.
- **Compositional hook:** the falling flap's taut diagonal across the centre,
  with its cast shadow on the panel behind.
- **Light and dark shapes:** warm paper panel and keys against a near-black
  charcoal field; the amber key and the gap behind the falling flap are the two
  focal points.
- **Colour field:** charcoal, the least used ground in the collection. The MCP
  cover (speech bubble on ink green) is its nearest neighbour in subject, so no
  speech bubble and no green here.
- **Material treatment:** cut-paper and card still life; flaps as thick card
  with visible cut edges, hinged on a plausible spindle; keys as card blocks
  with a believable pressed travel.
- **Caveat:** an editorial metaphor for a redraw, not a real interface, a live
  feed or a trading signal. The lines are plain ink strokes with no axes,
  numbers or labels.

## Exact prompt

```text
Use case: stylized-concept
Asset type: 16:9 Shorted editorial article cover.
Input images: Image 1 is the approved craft and visual impact reference.
Primary request: A chart shared in a conversation can be redrawn in place by anyone in it. Show one large warm-paper split-flap panel, the hinged-flap kind from an old departure board, seen slightly from below at three-quarters. Its upper flap is caught halfway through its fall on a visible metal spindle, and the single bold ink line printed across the falling flap is clearly different from the ink line on the panel it uncovers. In front of the panel, a row of five chunky card keys; one key, the only burnt-amber one, is pressed down.
Composition: The panel and the falling flap occupy about two thirds of the frame against a near-black charcoal field. The falling flap forms a taut diagonal through the centre with a clean cast shadow on the panel behind it. The pressed amber key and the gap behind the falling flap sit inside the central 80% with quiet dark space around them. Asymmetric crop; no speech bubble, phone, computer screen, people or hands.
Style: Graphic tactile editorial cut-paper still life. Thick card flaps with visible cut edges, sparse fibres, matte surfaces, one restrained steel spindle and consistent shadows. Large simple value shapes; no uniform distressed grain, neon, glow, glossy plastic or toy render.
Construction: The flap stays attached to its spindle along its whole edge; the panel halves meet at a plausible hinge line; the pressed key sits lower than its neighbours with its sides visible. Nothing fused, floating or duplicated.
Caveat: An editorial metaphor for redrawing a chart from the latest published data, not a live ticker, a trading signal or a real interface. The ink lines are plain strokes with no axes, gridlines, candlesticks, numbers or labels. No text, digits, letters, logos, app or brand symbols, watermark or writing anywhere.
```

## Review (to complete after generation)

Check at full size and at 160 × 90: the eye lands on the falling flap first and
reads the two different lines; the amber key reads as pressed; the spindle and
hinge are coherent; nothing implies a live feed or carries writing. Compare with
`shorted-mcp-server` and `shorted-2026-platform-update` for repetition.
