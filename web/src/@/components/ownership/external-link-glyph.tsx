import { cn } from "~/@/lib/utils";

// No "use client": the server pages draw the symbol, and the table islands
// (ownership-tables.tsx) draw the glyph.

/** The id of the one external-link symbol a page draws. */
export const EXTERNAL_LINK_SYMBOL_ID = "ownership-external-link";

/**
 * lucide's ExternalLink, drawn once per page as an SVG <symbol>. Every ASX
 * link on the ownership tables points at it with <use> (ExternalLinkGlyph)
 * instead of carrying its own copy of the icon: the inline lucide SVG was
 * ~0.4 KB of HTML a row, and again in the RSC payload, 188 times on
 * /ownership/vanguard. A page that draws an ExternalLinkGlyph renders this
 * once; where in the document does not matter.
 *
 * The wrapper's `hidden` attribute, not a style: Tailwind's space-y skips
 * [hidden] children, so the sprite can sit first in a spaced column without
 * pushing the next element down by a gap.
 */
export function ExternalLinkSymbol() {
  return (
    <div hidden>
      <svg>
        <symbol id={EXTERNAL_LINK_SYMBOL_ID} viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" x2="21" y1="14" y2="3" />
          </g>
        </symbol>
      </svg>
    </div>
  );
}

/** One use of the page's external-link symbol, the size of the icon it replaces. */
export function ExternalLinkGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={cn("h-4 w-4", className)}>
      <use href={`#${EXTERNAL_LINK_SYMBOL_ID}`} />
    </svg>
  );
}
