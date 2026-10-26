# Art direction and motion language

## Choose a direction, then keep visual grammar coherent

Inspect Shorted's current editorial assets and read `shorted-editorial-art`. Tactile paper/ink and carefully chosen conceptual still lifes fit the publication; a cinematic technology treatment may fit a data-centre story. Choose deliberately rather than copying the previous video's copper glow onto every subject. Use the real approved logo, a restrained palette, a consistent type scale, tabular figures and generous negative space. Add texture only if it supports the chosen material language.

Create a small direction board before batch generation: an opening frame, a chart frame and a concluding frame. Establish composition, value contrast, font pairing, safe areas and caption region. Inspect at intended viewing size, including a phone-sized preview. Portrait is a recomposition, not a centre crop of landscape labels.

## Imagegen stage briefs

Use the installed imagegen skill and its supported tool. If unavailable, report the missing capability and continue with storyboard/native diagrams; do not silently claim generated assets. Generate scene artwork for the hook, explanatory mechanism and conclusion as needed, then targeted variants rather than indiscriminate regeneration.

Save per selected asset: scene ID, exact prompt, tool/model when returned, original filename and hash, reference image provenance, generation/edit mode, dimensions, crop, version, selection rationale and illustration disclosure. Do not put exact labels, financial numbers, charts or logos into the prompt: typeset these accurately in code.

Prompt structure: “Editorial illustration for [verified idea]. [Concrete subject] is [visible action]. [Compositional hook and focal hierarchy]. [Materials, lighting and palette]. Leave [region] clear for native overlays. Preserve [physical/logical constraint]. This is conceptual, not a documentary photograph. No text, numbers, charts, logos or watermark.”

Prepare separate foreground/background or transparent elements only when they will actually be animated. Inspect cutout edges and depth order; do not invent geometry behind occluded objects. Generated multi-layer imagery is not a verified 3D reconstruction.

Review each image at full resolution and intended crop, then all selected images as a contact sheet. Reject melted details, fake writing, broken mechanisms, repetitive silhouettes and images implying a stronger factual claim. Correct the specific problem, not a growing list of style adjectives.

## Motion that explains

- Evidence reveal: introduce context, reveal one metric or highlight, then hold long enough to read it.
- Comparison: keep scales aligned; animate old/new values from the same baseline. Label forecast vs actual and show ranges, not fabricated precision.
- Mechanism: use a restrained flow/path reveal to explain dependencies such as power → usable capacity → billing. Do not imply measured flows unless sourced.
- Chronology: place report/position/event/publication dates on separate markers. Let timing explain why one cannot establish reaction to the other.
- Editorial art: use slow camera drift or subtle parallax as atmosphere, not the only animation for an entire film.
- Transition: motivate cuts by changes of argument. Use short crossfades or match cuts between related shapes; reserve harder cuts for a genuine contrast. Avoid continuous zooms and decorative motion on every element.

Starting ranges, not fixed requirements: micro-reveals 0.25–0.5s, scene transitions 0.35–0.8s, small camera movement over 6–12s. Adjust to narration and complexity. Give charts a settled reading period before the next transition. Avoid bouncing financial values, flashes, abrupt camera movement and motion that competes with captions.

Use named motion tokens and shared primitives for headings, source/date lines, bars/ranges, captions and chapter markers. Keep deterministic seeded animation and stable clip IDs. Animate native layout/geometry rather than repeatedly rasterising the whole UI. Render previews at reduced scale; preserve final export quality.

## Visual acceptance

Check first/last frames of every scene, midpoints of transitions, dense chart moments and caption changes. No empty frames, clipped text, late chart labels, misleading axes, obscured caveats or overflowing captions. Check exact encoded output, not just a canvas preview. Track specific deficiencies in hierarchy, coherence, pacing, legibility or evidence; passing lint does not make the art direction good.
