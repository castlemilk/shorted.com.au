/**
 * The desk's controls and its colour key (spec 13.1, 13.2): the window chips the
 * instruments share, the lens chips, and the lens's scale as a labelled bar.
 *
 * A PLAIN MODULE, no directive. The islands and the server's default view both
 * draw it, and it reaches neither protobuf, Connect nor an action.
 *
 * CHIPS ARE LINKS. A chip is a link (replace, no scroll, no prefetch, nofollow),
 * so a reader without JavaScript gets the same view. A click the island takes
 * (`onPick`) writes the link itself and does not navigate.
 *
 * NO FIGURE IS ZERO. A figure the page does not hold is "n/a"; a flow prints its
 * sign as a true minus and its unit as percentage points.
 */

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";
import { lensFill, type LensScale } from "./desk-scales";
import { DESK_LENSES, type DeskLens } from "./desk-state";

/**
 * What each lens's figures are (spec 13.8). The caption follows the colour: a fund
 * file's weight and a short position are not what a notice discloses, so no lens
 * borrows another's wording.
 */
const LENS_BASIS: Readonly<Record<DeskLens, string>> = {
  disclosed: "What the notices disclose, each interest counted once; not a share of the company.",
  institutional: "What the notices disclose, each interest counted once; not a share of the company.",
  hedge: "What the notices disclose, each interest counted once; not a share of the company.",
  flow: "What the notices disclose, each interest counted once; not a share of the company.",
  index: "Index fund holdings files; a weight is the fund's, of shares on issue, not a share of the company.",
  short: "ASIC short position report, published T+4; a short position is of shares on issue.",
};

/** The map's caption for one colour (spec 13.8): the area, the lens's own basis and the hatch. */
export function mapCaption(lens: DeskLens): string {
  return `Area is market cap; a stock with no market cap takes the median and is marked estimated. ${LENS_BASIS[lens]} A stock with no figure for this colour is hatched. On a stock, press z to zoom to its sector.`;
}

/** The name each lens is drawn under, in the chips, the legend and the table. */
export const LENS_LABELS: Readonly<Record<DeskLens, string>> = {
  disclosed: "Disclosed by notices",
  institutional: "Investors' interests",
  hedge: "Hedge funds",
  index: "Index funds, of shares on issue",
  short: "Short interest",
  flow: "Net change in disclosed voting power, pp",
};

/**
 * A net change in disclosed voting power, in percentage points: "+1.14 pp",
 * "−0.31 pp". A change that rounds to zero is "0.00 pp", a measured zero, and a
 * figure the page does not hold is "n/a".
 */
export function formatFlowPp(pp: number | null | undefined): string {
  if (pp == null || !Number.isFinite(pp)) return NOT_AVAILABLE;
  if (Math.abs(pp) < 0.005) return "0.00 pp";
  return `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(2)} pp`;
}

/** A lens's figure as text: a share, or a flow in percentage points. */
export function formatLensFigure(lens: DeskLens, value: number | null | undefined): string {
  if (lens === "flow") return formatFlowPp(value);
  return formatPct(value, { digits: 2 });
}

/** The link a chip or a crumb reads: its own plain link, one modifier-free click taken by the island. */
export interface DeskLinkProps {
  href: string;
  onPick?: () => void;
  className?: string;
  children: ReactNode;
  "aria-current"?: "true" | "location";
}

/**
 * A plain link that the island may take over. A click with a modifier (a new
 * tab, a download) keeps the browser's own handling, so the island takes only
 * the plain click.
 */
export function DeskLink({ href, onPick, className, children, ...aria }: DeskLinkProps) {
  const onClick = onPick
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        onPick();
      }
    : undefined;
  return (
    <Link
      href={href}
      replace
      scroll={false}
      prefetch={false}
      rel="nofollow"
      onClick={onClick}
      className={className}
      {...aria}
    >
      {children}
    </Link>
  );
}

/** A chip of the desk's controls: the active one carries the primary colour and aria-current. */
export function DeskChip({
  href,
  active,
  label,
  onPick,
}: {
  href: string;
  active: boolean;
  label: string;
  onPick?: () => void;
}) {
  return (
    <DeskLink
      href={href}
      onPick={onPick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-6 items-center rounded-sm border px-2 text-[11px] tabular-nums transition-colors",
        active
          ? "border-primary text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </DeskLink>
  );
}

/**
 * The lens's scale as a bar with its two ends printed. A diverging lens runs ink
 * to paper to amber, and the short-interest lens runs in the chart's short colour.
 * The bar is decoration for the eye: the two ends are printed beside it, and the
 * cells carry their own figures.
 */
export function LensLegend({ lens, scale }: { lens: DeskLens; scale: LensScale }) {
  const low = lensFill(scale.lo, scale) ?? "transparent";
  const mid = lensFill((scale.lo + scale.hi) / 2, scale) ?? "transparent";
  const high = lensFill(scale.hi, scale) ?? "transparent";
  const lowText = formatLensFigure(lens, scale.lo);
  const highText = formatLensFigure(lens, scale.hi);
  return (
    <div className="flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
      <span className="shrink-0">{lowText}</span>
      <div
        role="img"
        aria-label={`${LENS_LABELS[lens]}, from ${lowText} to ${highText}`}
        className="h-2.5 min-w-[4rem] flex-1 rounded-[1px] border border-muted-foreground"
        style={{ background: `linear-gradient(to right, ${low}, ${mid}, ${high})` }}
      />
      <span className="shrink-0">{highText}</span>
    </div>
  );
}

/** Every lens, in the order the desk lists them. */
export const LENS_ORDER: readonly DeskLens[] = DESK_LENSES;
