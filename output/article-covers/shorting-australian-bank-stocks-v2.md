# shorting-australian-bank-stocks — editorial cover revision 2

- Mode: Codex built-in `image_gen` via `codex exec` (imagegen skill, default built-in mode, not the CLI fallback; model `gpt-6-astra`), local image edit, opaque background, 16:9.
- Run: `codex exec -m gpt-6-astra -s workspace-write -i <prepared canvas>` in the blog worktree, instructions on stdin, one `image_gen` edit call, prompt passed verbatim (Codex's echoed prompt diffed identical).
- Edit target: `output/article-covers/shorting-australian-bank-stocks.png` (v1), inspected before editing. For the edit it was moved 200 px right inside the same 1672 × 941 frame with sharp, trimming the right-hand 200 px (plain ground and the ends of the outgoing shadows), and the vacated left strip was filled flat magenta as a placeholder. The prepared canvas was a scratch file and is not kept. Nothing was painted by hand: `image_gen` filled the strip and returned the whole image.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a15c8b-d1f6-7b40-a48a-96065e0ad8e4/exec-6528196c-439a-4b76-9bb2-4da3ffb7c298.png` (SHA-256 `5d2753223ce63801385de49e80bea1dc6fcab2a8b7165afc3564a56734a56d9d`, identical to the workspace copy).
- Workspace original: `output/article-covers/shorting-australian-bank-stocks-v2.png`, 1672 × 941.
- Final cover: `web/public/assets/blog/shorting-australian-bank-stocks/cover-editorial-v2.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, no letterbox).
- Prior version retained: v1's prompt and review (`output/article-covers/shorting-australian-bank-stocks.md`), which records its tool source. Like the collection's other unselected versions, its PNG is not committed.

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
Use case: precise-object-edit
Asset type: 16:9 landscape editorial blog cover for Shorted, an Australian short-selling data publication; shown full width and as small as 160 x 90 px.
Input images: Image 1: edit target, an approved linocut cover that has been moved right within its frame, leaving a flat magenta placeholder strip along the left edge.
Primary request: fill only the flat magenta strip at the left edge (about one eighth of the frame width) so the print continues seamlessly into it: the plain sandstone-ochre step surface with the same flat ink and carved linocut texture, the step's front edge continuing as the same single straight horizontal line at exactly the same height, and the same deeper-ochre riser below it. The strip holds nothing else, so a clear margin of plain sandstone separates the left edge of the frame from the nearest column's plinth.
Constraints: change only the magenta strip and its seam. Keep everything else in Image 1 exactly as it is: the four identical, whole, upright fluted ivory columns running out of the top edge, their classical bases on square plinths and their positions, the four parallel long charcoal shadows raking toward the lower right, the honey-gold sandstone-ochre field, the thin burnt-amber rim lines, the linocut texture with carved edges and slight registration, and the full-bleed 16:9 framing. No magenta or pink may remain anywhere, and there is no visible seam.
Avoid: a paper margin, border or blank strip; any new object, column or shadow; any text, letters, numbers, logos, watermarks or signatures; cracks, rubble, sky, horizon or sun.
```

The base image (v1) was generated from this prompt, unchanged by the edit:

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

Inspected at full size, in full-resolution crops of the filled strip, the columns and the shadows, and at 160 × 90, beside the collection sheet and the two other new cover briefs.

- Subject and action: pass. Four whole, upright fluted ivory columns on a sandstone step; low light from the left throws each one's charcoal shadow far beyond its visible height in parallel bands toward the lower right. Both read at 160 × 90 without zooming.
- Value separation at 160 × 90: pass. Three distinct values carry the image (ivory columns, mid-value honey ochre, charcoal shadows); the eye lands on the bases where the shadows begin and follows the diagonals right.
- Construction: pass. One light from the back-left gives amber rims on the lit left edges, shaded flutes and plinth sides, and a shaded riser. Each shadow starts at its own plinth, matches its column's width, runs parallel to the others and passes in front of the farther bases without touching them; the gentle recession makes the nearest shadow the longest. Shadows stop at the step edge, where the riser faces away from the light, or run out of the frame at the right. The filled strip continues the paving joints, the edge line and the riser with no visible seam; a pixel check found no magenta left, and outside the strip the edit stays within a mean 8.4/255 of the prepared canvas.
- Caveat: pass. The columns are whole and upright, with no cracks, tilt or rubble; there are no names, logos, coins or numbers; the bands read as cast shadows, not a fall or a bar chart; there is no sun, sky or sunset.
- No baked text or numbers: pass, at full size and in crops.
- Central 80%: pass. The columns span x 252–1234 of 1672 (safe area 167–1505); the lowest base reaches y 582 and the step edge sits at y 799 of 941 (safe area 94–847). The column tops leave the top edge and the shadows leave the right edge by design (the brief's close, low crop).
- Distinct from the collection: pass. It is the first sandstone-ochre field and the first linocut on the blog grid, with a verticals-over-diagonals silhouette no other cover uses. It differs from the four ivory gates of `asx-short-squeeze-candidates` (ink green, receding rectangular frames) and from the other two new briefs (a charcoal-timber card-frame still life; a slate-grey ball-on-ridge still life).
- Watch: seen close up, yellow ochre with black diagonals can recall hazard striping. In the whole frame the bands are anchored to the column bases and read as shadows; check it again on the listing grid.
