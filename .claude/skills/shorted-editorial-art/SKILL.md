---
name: shorted-editorial-art
description: Create, revise and review Shorted blog or newsroom covers and thumbnails in the approved tactile editorial style. Use for article artwork and thumbnail quality, including removing generic AI aesthetics; use the newsroom skill for reporting, citations or publication operations.
---

# Shorted editorial art

Work from the article's actual argument. Shorted's cover system is bold tactile editorial illustration: one idea, one decisive visual moment, a dominant silhouette and deliberate colour contrast. Read [art direction](../../../docs/blog-thumbnail-directions.md) for the construct and existing subjects and [article design](../../../docs/article-design.md) for the surrounding layout. Inspect [the collection](../../../output/article-covers/review-sheet.jpg) before commissioning another cover.

## Decide the image before writing the prompt

Write a one-sentence brief: **finding → concrete subject → one visible action → caveat**. The action must explain this particular story. A house is insufficient for housing; a shortened sale tag communicates asking-price revisions. A spring behind a closed latch communicates squeeze potential; a released spring communicates the mechanism. Preserve the distinction.

Choose the treatment intentionally: cut-paper illustration, spare printmaking, or a materially believable still life. Warm paper, charcoal and selective burnt amber connect the publication; the subject supplies other colours. Light and dark compositions are both valid. Match the approved character without copying its props into every image.

Record the cover brief before generating: **subject / action / compositional hook / light-and-dark shapes / colour field / material treatment / caveat**. The action and hook are related but different: a report strip is lifted; its oversized diagonal creates the visual pull. A resource comparison uses two reels; their dramatic scale difference creates the pull. This brief is part of the saved prompt provenance.

## Give the cover visual pull

Choose one compositional hook tied to the story: an unexpected difference in scale, a taut diagonal, a reveal, a bottleneck or a break at the decisive instant. Make the important action large enough to see immediately. A snapped cord needs a visible gap and separated ends; a data layer needs a clearly lifted edge.

Build broad light/dark shapes before adding texture. Use a close crop, asymmetric balance, purposeful cast shadow or one stronger colour field where it improves the idea. Keep a quiet pocket around the focal point. Warm paper can pair with deep ink green, mineral blue or oxblood when the subject earns it; the collection need not be a row of beige tabletop photographs. Colour alone does not replace a visible action.

As a starting composition, let the subject and action occupy about two thirds of the frame. Use one dominant visual mass or a tightly grouped comparison, with only enough supporting detail to explain the relationship. A close crop may trim incidental edges; preserve the mechanism and its important attachments inside the central safe area. Establish contrast in large shapes so the image works before texture is visible.

At 160 × 90, check that the eye lands on the intended focal moment first, then follows its relationship to the main subject. If a cover becomes a soft mass of similar midtones or its decisive action shrinks to a thin peripheral detail, correct contrast, crop or scale. Preserve the article's caveat and physical coherence. Boldness comes from the arrangement, not extra props, glow, explosions or exaggerated factual claims. Quiet inline art can support reading without competing with the cover.

## Make it feel art-directed

- Give one subject visual priority and use negative space. Remove objects that do not explain the idea. Prefer fewer, larger forms over intricate miniature scenes.
- Vary viewpoint, silhouette, light/dark balance and treatment across neighbouring stories. Do not repeat a magnifier, amber sun, torn mountain horizon, gum leaves, tokens or archive drawers merely to maintain consistency.
- Use material-specific detail: paper has cut edges, steel has plausible joints, glass has coherent refraction. A spring connects to its mounting; a rope reaches its anchor; scissors meet the tag. Shadows and perspective agree. Conceptual scale is welcome; accidental fused parts or impossible construction need revision.
- Imperfection should follow a chosen process: sparse ink registration, a few cut edges or visible fibres. Avoid uniform distressed noise, melted edges, oily softness, excessive faux patina, perfect toy renders and cinematic orange glow. Adding grain does not rescue a weak idea.
- Keep the subject readable at **160 × 90**. Inspect that size and the full image, then compare with at least two neighbouring covers. If the action disappears when small, simplify or reframe it.
- Reject fake writing, incoherent repeated objects, gratuitous ornament, stock finance clichés, invented interfaces or illustrations that imply stronger evidence than the article. Exact data goes in Shorted-owned accessible MDX figures.

The aim is convincing editorial craft. Retain generation provenance and existing AI credits; do not label generated art as handmade or as a verified news photograph. Captions begin **Illustration:**. Publisher photographs keep their source credits and are outside this art system.

## Review the collection as a publication

Before selecting a batch, inspect every image at full size and at 160 × 90, then inspect the complete contact sheet. Each cover must pass four checks: its subject and action are recognisable; the intended focal moment has clear value separation; the physical construction is coherent; the metaphor preserves the article's claim and uncertainty. A failure needs a specific correction before integration.

Look for runs of the same beige ground, camera angle, silhouette, prop or surface treatment. Change the arrangement or medium when the story allows it, rather than recolouring the same template. Keep a mix of light, charcoal, ink-green, mineral-blue and oxblood fields. The four approved impact revisions are [references](../../../output/article-covers/captivating-revisions.jpg), not layouts to copy into every story. Inline illustrations can remain quieter.

## Generate, review and integrate

Use `$imagegen` and the built-in image tool for interactive generation or editing. Read its skill instructions. For a local edit, inspect the target first; specify what must remain. Do not switch to an API/CLI generator just because there are several articles. Existing unattended newsroom jobs have their own configured generation path.

Compose **16:9** with the essential subject/action inside the central 80%. No baked-in titles, labels, numbers, logos, watermarks or decorative charts. Save a versioned original and the exact prompt, mode and source path in `output/article-covers/`. Inspect each result before selecting it. Revise the specific failure; do not append an ever-growing list of style adjectives.

Name first-version provenance `<slug>.png` and `<slug>.md`; later versions use `<slug>-vN.png` and `<slug>-vN.md`. The thumbnail exporter checks those files before refreshing the manifest, so the selected cover cannot silently point at an older prompt or original.

For a blog:

1. Export the selected cover as `web/public/assets/blog/<slug>/cover-editorial-vN.webp`, **1600 × 900**. Keep previous versions.
2. Set frontmatter `coverImage` and `ogImage.url` to the cover; write `coverAlt` describing the illustration rather than repeating the title.
3. From `web/`, run `node --import tsx scripts/editorial-thumbnails.mts --slug=<slug>` (or `--all`). It produces an **800 × 450** `thumbnail-editorial-vN.webp`, sets `thumbnailImage`, and preserves the full cover for mastheads/social previews. It refuses to silently replace differing thumbnail bytes. After selecting any replacement, run `--all` to refresh the collection sheet, [160 × 90 proof](../../../output/article-covers/thumbnail-proof.jpg) and manifest from current frontmatter, including cover, alternative, thumbnail, exact prompt and original.
4. Review the actual listing/related card and article at desktop/mobile widths, in both themes. Use static 16:9 crops with natural colours; keep text outside the illustration. Run `node --import tsx --test scripts/article-art.test.mts` to verify real asset paths, dimensions, alternatives and shared prompt policy.

For newsroom articles, follow [the newsroom workflow](../../../.claude/skills/newsroom/SKILL.md). Art planning and validation live in `scripts/take-writer/src/art-director.ts` and `validator.ts`; the other shared generator lives in `scripts/image-gen/src/brand-prompt.ts`. Update the corresponding prompts when changing the art policy. Integrating local art does not itself publish an article or regenerate stored remote images.
