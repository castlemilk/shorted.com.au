// Shorted editorial art direction. See docs/article-design.md and
// docs/blog-thumbnail-directions.md. The subject supplies the idea;
// paper, ink and selective amber connect the publication's covers.

export const EDITORIAL_ART_DIRECTION = `
Create a commissioned editorial illustration for Shorted, an Australian
research publication. Build the image around the article's specific finding
or mechanism: one concrete subject and one legible visual action. Preserve
uncertainty; never imply a guaranteed outcome or a verdict.

Use tactile hand-cut paper collage, printmaking, a sculptural material still
life, or a close photograph of a relevant physical material. Warm ivory paper,
charcoal ink and selective burnt amber connect the collection. Let the subject
introduce restrained sage, rust, oil blue, brick or mineral tones. Choose a
light or dark composition to suit the story; do not force every cover into
black with an orange rim light. Use controlled shadows and visible texture.

Compose a strong silhouette and readable action at 160 x 90. Keep essential
objects in the central 80% so card and social crops remain useful. Relevant
Australian architecture, industrial subjects and landscape are welcome;
do not add a map, flag or gum tree to every ASX story.

Avoid generic finance icons, bulls, bears, rockets, money piles, handshakes,
suited figures, glossy isometric asset packs, glowing fintech wallpaper,
repeated fire effects and decorative dashboard fragments. No baked-in text,
letters, digits, tickers, percentages, logos, readable documents or watermarks.

This is conceptual editorial art, not measured data or a verified product
interface. Exact data belongs in the article's accessible custom MDX figures.
Do not invent a chart, provider UI, news photograph, real event or location.
An illustrative mechanism may use unlabelled tiles or qualitative shapes,
without axes, exact quantities, predictions or claimed measured comparisons.`;

export const EDITORIAL_CRAFT_RULES = `
Make the construction feel deliberately authored, not a reusable template.
Keep perspective, occlusion, joins, attachments and contact shadows internally
consistent; a mechanism's connection and action must be intelligible. No
fused or duplicated parts, impossible knots, detached handles or melted detail.
Conceptual scale and hand-cut imperfection are valid when construction is clear.
Use purposeful cut edges, ink variation and material scuffs, not uniform fake
grain, smooth plastic or glossy miniature-render polish. Avoid decorative icon
grids, miniature asset-pack districts, app-style map pins, blank title-card
placeholders and unrelated mountains, sunsets or foliage. A lens or share tile
must earn its role, never be a default finance prop. At 160 x 90 the subject
and action must read without tiny details or a title explaining the image.
Remove competing props; vary the idea and composition, not just accent colour.
Shorted covers follow one construct: one idea, one decisive visual moment,
one dominant silhouette and deliberate colour contrast. In the brief specify
subject, action, compositional hook, large light/dark shapes, colour field,
material treatment and the article-specific caveat. As a starting point let
the subject/action occupy about two thirds of the frame, keeping the mechanism
and important attachments in the central crop-safe area. For a cover choose
one story-specific visual hook: scale surprise, a taut
diagonal, a reveal, a bottleneck or the decisive instant of a break. Enlarge
the action and build broad light/dark shapes with a quiet pocket at the focal
moment. A close crop, asymmetry, purposeful cast shadow or stronger ink-green,
mineral-blue or oxblood field can create impact. Avoid a whole set of soft
beige tabletops. Correct weak silhouettes, similar midtones and tiny peripheral
actions through framing, contrast and scale; add no spectacle or stronger claim.`;

export interface PromptInput {
  topic: string;
  type: "hero" | "thumbnail" | "inline";
  additionalContext?: string;
}

/** Build the existing automated generator's prompt; no API call here. */
export function buildImagePrompt(input: PromptInput): string {
  const format = input.type === "inline"
    ? "Horizontal editorial illustration supporting this section's argument."
    : "Wide 16:9 editorial cover, image-led with one strong subject; legible at thumbnail size.";
  return [
    EDITORIAL_ART_DIRECTION.trim(),
    EDITORIAL_CRAFT_RULES.trim(),
    `Article-specific brief: ${input.topic.trim()}`,
    input.additionalContext ? `Additional context: ${input.additionalContext.trim()}` : "",
    `Format: ${format}`,
    "Final check: recognisable subject/action, a clearly separated focal moment, credible construction and an honest article-specific claim. No text, numbers, logos, fabricated data or product UI.",
  ].filter(Boolean).join("\n\n");
}

/** The existing API wrapper accepts landscape/square/portrait dimensions.
 * Hero and thumbnail both use landscape; briefs keep a 16:9-safe composition.
 * Export chosen blog artwork at 1600 x 900 after reviewing the crop. */
export function imageSizeFor(_type: PromptInput["type"]): "1536x1024" {
  return "1536x1024";
}
