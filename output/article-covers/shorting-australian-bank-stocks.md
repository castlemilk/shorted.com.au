# shorting-australian-bank-stocks — editorial cover v1

- Mode: Codex built-in `image_gen` via `codex exec` (imagegen skill, default built-in mode, not the CLI fallback; model `gpt-6-astra`), new generation, opaque background, 16:9.
- Run: `codex exec -m gpt-6-astra -s workspace-write` in the blog worktree, instructions on stdin, one `image_gen` call, prompt passed verbatim (Codex's echoed prompt diffed identical). A first invocation without `-m` was refused before any tool call (the configured default `gpt-6.1-sol` "is not supported when using Codex with a ChatGPT account") and produced no image.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a15c85-4617-7522-bd78-ca1cd89c1696/exec-c2ce25da-d98b-475f-a651-5ac98e0d998b.png` (SHA-256 `9f2611a64499955c60894049fdfa20754c85957a85fb98518d6c937a10aa0d27`, identical to the workspace copy).
- Workspace original: `output/article-covers/shorting-australian-bank-stocks.png`, 1672 × 941.
- Final cover: not exported. v1 failed the central-80% check; the selected cover is its edit, v2 (`output/article-covers/shorting-australian-bank-stocks-v2.md`).

## Editorial brief

Finding → subject → action → caveat: big-four short positions have more than tripled in a year while the banks stand unchanged → four whole, upright fluted ivory columns → low raking light throws their charcoal shadows far longer than the columns → the shadows stand for positions, not a fall, and their lengths are not data.

Subject: Four fluted ivory column shafts and their bases, closely and low cropped, with no pediment or building icon, so it is not the generic bank symbol

Action: Low raking light throws each column's charcoal shadow far longer than the column itself across the ground towards the lower right, the nearest shadow longest

Hook: The surprising length of the shadows against unchanged columns, read as one taut set of parallel diagonals

Large shapes: Four tall pale verticals over four long dark diagonals, with the stone step's edge as the single horizontal

Colour field: Warm Sydney-sandstone ochre (new to the collection), with a thin burnt-amber rim light on each column's lit edge

Material: Spare two-colour linocut print with crisp carved edges and visible registration (printmaking is rare on the blog grid; the oxblood woodcut house belongs to the Widow-Maker feature)

Caveat: The columns are whole and upright, with no cracks, tilt, rubble, bank names, logos, coins or numbers. The shadows stand for positions, not for a fall, and their lengths are not data.

## Exact final prompt

```text
Use case: illustration-story
Asset type: 16:9 landscape editorial blog cover for Shorted, an Australian short-selling data publication; shown full width above the article and as small as 160 x 90 px on listing cards.
Primary request: an editorial linocut print for an article finding that reported short positions in Australia's four largest banks have more than tripled in a year while the banks themselves stand unchanged. Four whole, upright, fluted ivory columns stand on a broad sandstone step, and a low raking light throws each column's charcoal shadow far longer than the column itself. The long shadows, not the columns, carry the story.
Subject: four identical fluted column shafts, each on a simple classical base (a round moulding on a square plinth), cropped closely and low. Only the lower shafts and their bases are in the frame; every shaft runs straight out of the top edge, so no capital, beam, roof, pediment or building is visible. Keep the shafts as straight, parallel verticals. The flutes are a few clean carved charcoal lines on each shaft's shaded right side.
Action: a low light from the left throws each column's shadow across the step toward the lower right: a long, solid charcoal band as wide as its column, starting exactly at the foot of its own column and far longer than the visible shaft. The four shadows are exactly parallel, as from one distant light. Each passes in front of the bases of the columns to its right without touching them, and continues out of the frame at the right edge.
Composition/framing: seen from the front and moderately above, so the step's top surface is broad and the shadows read as bold bands. The step's top surface extends behind the columns to the top edge of the frame, so there is no wall, horizon or sky. The columns stand in one row across the left and centre of the frame (about 15% to 60% of the width). The row recedes only slightly, with the nearest column at the left, so the bases step up a little from left to right and the nearest column's shadow is the longest, sweeping lowest across the frame toward the lower-right corner. The step's front edge is one clean horizontal line at about 85% of the frame height, with a narrow riser in deeper ochre below it. The upper right stays a quiet pocket of flat ochre. The large shapes read as four tall pale verticals over four long dark parallel diagonals, and the hook is the surprising length of those shadows beside unchanged columns. Keep every column base, the start of every shadow and the step edge inside the central 80% of the frame.
Style/medium: a spare hand-pulled linocut print, essentially two ink colours, sandstone ochre and charcoal, on warm ivory paper, with one thin burnt-amber accent. Crisp carved edges, a few deliberate gouge marks in the ochre and inside the shadows, and slight visible registration: the charcoal block sits a hair off the ochre so a thin sliver of paper shows along some edges. Flat ink with the slight unevenness of a hand-pulled block. Full bleed: the print fills the whole frame with no paper margin or border.
Lighting/mood: one low raking light from the left; a thin burnt-amber rim line runs down the lit left edge of each shaft. Calm, steady and observational, not ominous.
Color palette: a warm Sydney-sandstone ochre field (honey-gold yellow ochre, mid-value; clearly more golden and deeper than cream paper, and not rust, terracotta or orange) for the whole step surface; ivory paper for the columns; charcoal for the shadows and flute lines; burnt amber only in the thin rim lines. No other colours.
Constraints: the columns are whole, smooth and perfectly upright, with no cracks, chips, tilt, lean, broken tops, rubble or ruins. The shadows are ordinary cast shadows from one light. They stand for positions, not for a fall, and their lengths are not data, so they must not look like a bar chart. Essential subject and action inside the central 80% of the frame.
Avoid: text, letters, numbers, logos, watermarks, signatures, pencil marks or edition numbers; coins, banknotes, bank names, charts or arrows; a sun disc, sky, clouds, horizon, sunset glow, skyline, trees, gum leaves, people, birds or statues; capitals, a pediment, a roof or any building facade; photographic shading, gradients, glow, a 3D-render look or uniform distressed noise.
```

## Acceptance review

Inspected at full size, in full-resolution crops and at 160 × 90, beside the collection sheet.

- Subject and action: pass. Four whole, upright fluted columns on a sandstone step; low light from the left throws each one's shadow far beyond its visible height in parallel bands toward the lower right.
- Value separation at 160 × 90: pass. Ivory columns, mid-value honey ochre and charcoal shadows stay three distinct values.
- Construction: pass. One light from the back-left (amber rims on the lit left edges, shaded flutes, plinth sides and riser); each shadow starts at its own plinth and passes in front of the farther bases.
- Caveat: pass. No cracks, tilt, rubble, names, logos, coins, numbers, sun or sky; the bands read as cast shadows, not a chart.
- No baked text or numbers: pass.
- Central 80%: fail. The nearest column's lit edge, amber rim and plinth sit at x 51–167 of 1672, inside the outer 10% margin, while the farthest column ends at x 1035, so the group is left-heavy.
- Correction for v2: move the whole arrangement 200 px right and fill the vacated strip with plain step, edge and riser, so a clear margin of sandstone separates the frame edge from the nearest plinth; change nothing else.
