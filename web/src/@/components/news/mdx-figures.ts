/**
 * Injects art-directed layout images into MDX article source as <Figure />
 * components before compilation.
 *
 * Editorial takes with body_format='mdx' store generated layout images in
 * the layout_images JSONB column, but (unlike the legacy markdown path in
 * take-body.tsx) the MDX writer doesn't always place <Figure> tags itself.
 * This module weaves those images into the source at their anchorAfterBlock
 * positions so generated+validated art is never silently dropped.
 */

/** Structural subset of the LayoutImage proto / JSONB shape we need. */
export interface LayoutImageLike {
  url?: string;
  caption?: string;
  /** "full" | "left" | "right" | "inset" */
  placement?: string;
  /** Render after this 0-based top-level block. */
  anchorAfterBlock?: number;
  /** JSONB-only field — proto doesn't carry it. "hero" images are skipped. */
  role?: string;
}

/**
 * Captions become MDX string attributes. Double quotes would terminate the
 * attribute early and raw newlines break MDX JSX parsing, so swap quotes for
 * apostrophes and collapse all whitespace.
 */
function sanitizeCaption(caption: string): string {
  return caption.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

function figureLine(img: LayoutImageLike): string {
  const trimmed = img.placement?.trim();
  const placement = trimmed ? trimmed : "full";
  const caption = img.caption ? sanitizeCaption(img.caption) : "";
  const captionAttr = caption ? ` caption="${caption}"` : "";
  return `<Figure src="${img.url}" placement="${placement}"${captionAttr} credit="AI-generated illustration" />`;
}

/**
 * Inserts a <Figure /> block after each image's anchor block.
 *
 * - No-op if the source already contains a <Figure — writer-placed figures win.
 * - Skips hero-role images and any without a url.
 * - Anchors are clamped to [0, blocks.length - 1]; images missing an anchor
 *   fall back to alternating positions (i*2+1) so they spread through the body.
 * - Insertion happens highest-anchor-first so earlier insertions never shift
 *   the block indices that later (lower) anchors refer to.
 */
export function injectLayoutFigures(
  source: string,
  images: LayoutImageLike[],
): string {
  if (!images || images.length === 0) return source;
  if (source.includes("<Figure")) return source;

  const blocks = source.split(/\n\n+/);
  if (blocks.length === 0) return source;

  const placeable = images
    // Keep the original index for the fallback anchor BEFORE filtering.
    .map((img, i) => ({ img, fallbackAnchor: i * 2 + 1 }))
    .filter(({ img }) => Boolean(img.url) && img.role !== "hero")
    .map(({ img, fallbackAnchor }, order) => ({
      img,
      order,
      anchor: Math.min(
        Math.max(img.anchorAfterBlock ?? fallbackAnchor, 0),
        blocks.length - 1,
      ),
    }));
  if (placeable.length === 0) return source;

  // Highest anchor first keeps indices stable; within the same anchor,
  // inserting the later image first means the earlier one ends up above it,
  // preserving original order.
  placeable.sort((a, b) => b.anchor - a.anchor || b.order - a.order);
  for (const { img, anchor } of placeable) {
    blocks.splice(anchor + 1, 0, figureLine(img));
  }

  return blocks.join("\n\n");
}
