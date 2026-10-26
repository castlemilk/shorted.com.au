# what-happens-after-asx-short-interest-peaks (v1)

- Mode: Codex built-in `image_gen` via `codex exec` (the `$imagegen` skill in its default built-in tool mode; not the CLI fallback, an API script or `scripts/image-gen`). New generation, no input or reference images.
- Run: Codex CLI 0.153.4, `codex exec -m gpt-5.6-sol -s workspace-write`, session `01a15c85-970d-7021-ab7f-bfd4da14cc0a`; `image_gen` received the prompt below as its only argument. An earlier invocation without `-m` was refused before anything was generated: the CLI's configured default model is not available to this client on a ChatGPT account.
- Original tool source: `/Users/benebsworth/.codex/generated_images/01a15c85-970d-7021-ab7f-bfd4da14cc0a/exec-213bd11a-1fa3-4e2c-9afe-7f65ce70361b.png`.
- Workspace original: `output/article-covers/what-happens-after-asx-short-interest-peaks.png`, 1672 × 941, a byte-identical copy of the tool source.
- Final cover: `web/public/assets/blog/what-happens-after-asx-short-interest-peaks/cover-editorial-v1.webp`, 1600 × 900, WebP quality 88 (sharp `fit: 'cover'` from the 16:9 original, trimming under one pixel; no letterbox).
- First cover for this slug. One generation; no revision needed.

## Editorial brief

Finding → subject → action → caveat: a short-interest peak is only visible afterwards, and what followed it ran both ways → a burnt-amber ceramic ball on a folded ivory card ridge → the ball rests exactly on the crest, the one point of balance → it is balanced, not falling, so the image says neither which way the price went nor that the peak could be recognised on the day.

Subject: A single burnt-amber glazed ceramic ball and a tall, sharply folded ivory card ridge.

Action: The ball rests exactly on the ridge's knife-edge crest at the instant before it could roll either way; the contact point is the only place they touch.

Hook: The apex sits high and slightly right of centre, and the slopes fall away unequally (long and shallow to the left, short and steep to the right), so the eye goes straight to the single point of balance.

Large shapes: A large pale ivory ridge and one charcoal cast shadow raking across the left slope against a darker ground; the amber ball is the only saturated note.

Colour field: Smoky slate grey, new to a collection that leans on ink green, mineral blue and oxblood.

Material: A physically coherent sculptural still life: heavyweight cut card with a crisp crease and visible fibre at the fold, a ceramic ball with one soft reflection, low raking daylight.

Caveat: The ball is balanced, not falling. No motion blur, arrows, chart lines, mountain horizon, numbers or text. It must not suggest which way prices go after a peak, or that a peak can be recognised on the day. It differs from the analysis-shelf neighbours: the October cream brass gauge, the ink-green trays and gates, the mineral-blue oil and tanker covers.

## Exact final prompt

```text
Use case: stylized-concept
Asset type: wide 16:9 landscape editorial cover for a Shorted.com.au data study of what happened to ASX stocks after their short interest peaked. The title is set outside the image.
Subject: one burnt-amber glazed ceramic ball and one tall, sharply folded ivory card ridge. The ridge is a single sheet of heavyweight ivory card folded once into an asymmetric tent, standing on a matte surface. It is seen from the front and slightly above, so its front cut edge draws one bold, unequal peak and both faces recede only a short way behind it: the left face is long and shallow, the right face short and steep. The ball is about the size of a large marble relative to the card.
Action: the ball rests exactly on the knife-edge crest of the fold, at the instant before it could roll either way. It sits centred on the crease, leaning toward neither side, and the single contact point is the only place ball and card touch.
Compositional hook: the apex sits high and slightly right of centre, about 58% across the frame, and the two slopes fall away unequally, the long shallow one toward the lower left and the short steep one to a foot about three quarters across, so the eye goes straight to the one point of balance. Quiet dark negative space surrounds the ball.
Light-and-dark shapes: a large pale ivory ridge as the dominant silhouette against a darker ground; one elongated charcoal shadow cast by the ball rakes down across the long left slope; the amber ball is the only saturated note.
Colour field: smoky slate grey. A seamless matte slate-grey paper sweep serves as both tabletop and backdrop, deepening toward the top of the frame, with no horizon line, no room and no landscape.
Material treatment: a physically coherent sculptural still life. The card has crisp cut edges and visible thickness, and a sharp crease along the crest where the fold has cracked slightly and a few paper fibres lift. The ceramic ball has a smooth glaze with one soft window reflection. Low raking daylight comes from the right, just high enough to graze the long left face: the steep right face is the brightest plane, the left face a paler grazed ivory carrying the ball's shadow. Small contact shadows where the card's feet meet the surface and where the ball meets the crest.
Framing: the ridge and ball fill about two thirds of the frame as one dominant mass. The ball, the crest and the contact point sit well inside the central 80% of the frame, the top of the ball about a fifth of the frame height below the top edge; nothing essential near any edge.
Caveat: the ball is balanced, not falling. The image must not suggest which way the price went after a peak, or that a peak can be recognised on the day. It is an object on a surface, clearly not a mountain, a sunset or a sun.
Avoid: text, letters, numbers, logos, watermarks, charts, chart lines, arrows, motion blur, a second ball, extra props, hands, mountain or landscape horizon, sun, glow, cinematic orange haze, uniform grunge, faux patina, toy-like 3D render.
```

## Acceptance review

Inspected at full size (1672 × 941, with zoomed crops of the contact point, the base of the fold and the long left face) and at 160 × 90 in colour and greyscale, beside six neighbouring covers and this round's two other new covers.

- Subject and action: one ivory card peak with an amber ball seated on its apex, touching the crest at a single point, centred and still. No motion cue.
- Value separation at 160 × 90: the eye lands first on the ball at the tip of the pale ridge. The ridge (luma about 160–206) stands against a ground that falls from about 36 at the top of the frame to about 111 on the floor; the ball separates from the backdrop by saturation and a lighter rim, and in greyscale still reads as a disc on the brightest point of the frame.
- Construction: crisp cut edges with visible card thickness, an even paper tooth and a cracked-fibre crease at the apex. The ball's window highlight and the soft shadow down the long face agree with light from the right, and the ball reflects the pale card beneath it. At the base of the fold the two faces part just above the floor and show the hollow interior, like a notched fold; nothing is fused.
- Caveat: balanced, not falling; no arrows, chart lines, text, numbers, logos or watermark. The card's tooth, cut edges and hollow interior keep it a tabletop object, not a mountain under a sun. The unequal slopes are composition; their proportions are not the study's build or unwind times.
- Safe area: the ball spans 56–68% across with its top 13% below the top edge, and the crest and contact point sit well inside the central 80%. Only the far end of the long left face runs off the frame.
- Collection: the only peak silhouette and the only sphere in the set. Its graduated smoky-grey field differs from the charcoal, ink-green, mineral-blue, oxblood and cream covers; it also differs from its nearest material neighbour (`days-to-cover-asx`, a folded ivory channel on mineral blue) and from this round's ochre linocut columns and charcoal-timber card frame.
- One brief element is lighter than asked: the ball's shadow on the left face is a soft grey band, not charcoal. Kept deliberately: a darker streak running from the ball down the long slope reads at card size as a roll path, which would break the caveat.
