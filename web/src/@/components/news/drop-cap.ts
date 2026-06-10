/**
 * Drop-cap styling for the first paragraph of an article body.
 *
 * The three body render paths nest paragraphs differently (the magazine
 * layout path wraps every block in its own div, and bodies can open with
 * an `## heading` block), so a single page-level descendant selector
 * can't reliably target "the first paragraph in document order". Each
 * body component instead applies these classes itself:
 *
 *  - take-body.tsx: renders the block at `firstProseBlockIndex` with a
 *    `p` override carrying DROP_CAP_FIRST_LETTER (element-level, immune
 *    to nesting);
 *  - mdx-take-body.tsx: puts DROP_CAP_CONTAINER on the body container —
 *    compiled MDX paragraphs are its direct children, so
 *    `> p:first-of-type` is exact (and skips a leading heading);
 *  - editorial-markdown.tsx: DROP_CAP_CONTAINER on the single prose div,
 *    or on the first prose block's div when images split the body.
 *
 * Keep these literal strings intact — Tailwind's JIT scanner needs the
 * complete class names in source.
 */

/** First-letter utilities applied directly to the paragraph element. */
export const DROP_CAP_FIRST_LETTER =
  "first-letter:float-left first-letter:pr-2 first-letter:font-serif first-letter:text-6xl first-letter:leading-[0.85] first-letter:font-semibold first-letter:text-primary";

/** Same effect for containers whose direct children are the paragraphs. */
export const DROP_CAP_CONTAINER =
  "[&>p:first-of-type]:first-letter:float-left [&>p:first-of-type]:first-letter:pr-2 [&>p:first-of-type]:first-letter:font-serif [&>p:first-of-type]:first-letter:text-6xl [&>p:first-of-type]:first-letter:leading-[0.85] [&>p:first-of-type]:first-letter:font-semibold [&>p:first-of-type]:first-letter:text-primary";

/**
 * Index of the first markdown block that renders as a plain paragraph
 * (skips headings, lists, quotes, images, tables, code fences, raw
 * HTML/MDX components). -1 when the body has no prose block.
 */
export function firstProseBlockIndex(blocks: readonly string[]): number {
  return blocks.findIndex((b) => {
    const t = b.trim();
    return (
      t.length > 0 && !/^(#{1,6}\s|>|[-*+]\s|\d+\.\s|!\[|\||```|<)/.test(t)
    );
  });
}
