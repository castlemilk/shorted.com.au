import { cn } from "~/@/lib/utils";
import { GLYPH_VIEWBOX, STRATEGY_GLYPHS } from "~/@/lib/strategies/glyphs";

/**
 * A strategy's glyph, engraved: one inline SVG, stroke-only in currentColor,
 * with a non-scaling stroke so it is the same hairline at 20px (the
 * switcher) and at 40px (the rack rows and the strategy page's bezel) rather
 * than a bold icon at the larger size. 1.5px at the small size; the large
 * size takes 1.75px, because 1.5px reads faint on warm paper at 1x.
 * Decorative, always: aria-hidden, beside its text label, never the only
 * carrier of meaning.
 *
 * `draw` engraves it on load: each stroke draws from its start to its end
 * over 360ms (pathLength="1", so one dash keyframe fits every length), one
 * stroke 50ms after the last, so a five-stroke glyph is finished at 560ms,
 * under the 600ms entrance ceiling, like a burin cutting the plate. Under
 * prefers-reduced-motion the motion-safe class never applies and the glyph
 * is fully drawn from the first frame, which is also the animation's final
 * state. Only the one bezel on a page draws; a row of chips or a rack of
 * rows is never a set of things moving at once.
 *
 * Props-only and server-safe like the rest of the kit; nothing in the sort
 * island's client graph (picks-table, picks-filter-view, pick-fundamentals)
 * imports it, so it never ships to the browser.
 */
export function StrategyGlyph({
  slug,
  className,
  draw = false,
  strokeWidth = 1.5,
}: {
  slug: string;
  className?: string;
  draw?: boolean;
  /** CSS pixels, whatever the rendered size (non-scaling stroke). */
  strokeWidth?: number;
}) {
  const paths = STRATEGY_GLYPHS[slug];
  if (!paths) return null;
  return (
    <svg
      viewBox={GLYPH_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-strategy-glyph={slug}
      className={cn("shrink-0", className)}
    >
      {paths.map((d, index) => (
        <path
          key={d}
          d={d}
          vectorEffect="non-scaling-stroke"
          pathLength={draw ? 1 : undefined}
          strokeDasharray={draw ? 1 : undefined}
          className={draw ? "motion-safe:animate-trace-draw" : undefined}
          style={draw ? { animationDelay: `${index * 50}ms` } : undefined}
        />
      ))}
    </svg>
  );
}

/**
 * The faceplate: a 56px hairline bezel holding the 40px glyph, the one
 * hero-sized mark on a view (the strategy page header). Colour follows the
 * parent (`text-primary` for the current instrument).
 */
export function StrategyBezel({
  slug,
  className,
  draw = true,
}: {
  slug: string;
  className?: string;
  /** Engrave the glyph on load (see StrategyGlyph). */
  draw?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-background",
        className,
      )}
    >
      <StrategyGlyph slug={slug} className="h-10 w-10" draw={draw} strokeWidth={1.75} />
    </span>
  );
}
