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
import { ToolbarSelect } from "~/@/components/workspace/toolbar";
import { BIN_COUNT, lensFill, type LensScale } from "./desk-scales";
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
  index_flow:
    "Index fund holdings files: each fund's shares at its start and end files, valued at the later file's price; a change is not a share of the company.",
};

/** The map's caption for one colour (spec 13.8): the area, the lens's own basis and the hatch. */
export function mapCaption(lens: DeskLens): string {
  return `Area is market cap; a stock with no market cap takes the median and is marked estimated. ${LENS_BASIS[lens]} A stock with no figure for this colour is hatched. On a stock, press z to zoom to its sector.`;
}

/** The name each lens is drawn under, in the chips, the legend and the table. */
/** The Colour select's short names (spec 14.9): the toolbar's one row holds them; the legend keeps the full names. */
export const LENS_SELECT_LABELS: Readonly<Record<DeskLens, string>> = {
  disclosed: "Notices",
  institutional: "Investors",
  hedge: "Hedge funds",
  index: "Index funds",
  short: "Short interest",
  flow: "Net change, pp",
  index_flow: "Fund shares",
};

export const LENS_LABELS: Readonly<Record<DeskLens, string>> = {
  disclosed: "Disclosed by notices",
  institutional: "Investors' interests",
  hedge: "Hedge funds",
  index: "Index funds, of shares on issue",
  short: "Short interest",
  flow: "Net change in disclosed voting power, pp",
  index_flow: "Change in index fund shares",
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

/**
 * A change in index fund shares, as a percentage of the funds' starting shares: "+1.20%",
 * "−0.31%". A change that rounds to zero is "0.00%", a measured zero; a figure the page
 * does not hold is "n/a".
 */
export function formatFundChangePct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return NOT_AVAILABLE;
  if (Math.abs(pct) < 0.005) return "0.00%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}

/** A lens's figure as text: a share, a flow in percentage points, or an index fund change in percent. */
export function formatLensFigure(lens: DeskLens, value: number | null | undefined): string {
  if (lens === "flow") return formatFlowPp(value);
  if (lens === "index_flow") return formatFundChangePct(value);
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
 * The five bins' edges, as the legend prints them (spec 14.9): the bin's lower bound
 * under each swatch, and the top bin reads "and above". A diverging scale's bins are
 * "-2s and below", "-2s to -s", "-s to s", "s to 2s" and "2s and above".
 */
export function legendLabels(
  lens: DeskLens,
  scale: LensScale,
  format: (edge: number) => string = (edge) => formatLensFigure(lens, edge),
): string[] {
  const at = format;
  const s = scale.step;
  if (scale.mode === "diverging") {
    return [`${at(-2 * s)} and below`, `${at(-2 * s)} to ${at(-s)}`, `${at(-s)} to ${at(s)}`, `${at(s)} to ${at(2 * s)}`, `${at(2 * s)} and above`];
  }
  return [0, 1, 2, 3, 4].map((bin) => (bin === BIN_COUNT - 1 ? `${at(bin * s)} and above` : at(bin * s)));
}

/**
 * The lens's scale as five stepped swatches with their thresholds printed beneath
 * (spec 14.9): a bin's colour is the figure's bin, never a gradient between two. The
 * swatches are decoration for the eye: the thresholds are printed, and the cells carry
 * their own figures.
 */
export function LensLegend({
  lens,
  scale,
  name = LENS_LABELS[lens],
  format,
  caption,
}: {
  lens: DeskLens;
  scale: LensScale;
  /** The name the legend's aria label gives the scale; the lens's own name by default. */
  name?: string;
  /** How an edge prints; a lens's own figure by default. */
  format?: (edge: number) => string;
  /** A line under the scale, such as the files a comparison reads (spec 14.10). */
  caption?: string;
}) {
  const labels = legendLabels(lens, scale, format);
  return (
    <div className="space-y-1">
      <div
        role="img"
        aria-label={`${name}, five steps: ${labels.join("; ")}`}
        className="grid max-w-xl grid-cols-5 gap-x-1 text-[11px] tabular-nums text-muted-foreground"
      >
        {labels.map((label, bin) => (
          <div key={bin} className="min-w-0">
            <span
              aria-hidden="true"
              className="block h-2.5 rounded-[1px] border border-muted-foreground"
              style={{ background: lensFill(legendFigure(scale, bin), scale) ?? "transparent" }}
            />
            <span aria-hidden="true" className="mt-1 block leading-tight">
              {label}
            </span>
          </div>
        ))}
      </div>
      {caption ? <p className="max-w-xl text-[11px] text-muted-foreground">{caption}</p> : null}
    </div>
  );
}

/** A figure that falls in a bin: the middle of the bin, so the swatch takes the bin's own fill. */
function legendFigure(scale: LensScale, bin: number): number {
  if (scale.mode === "diverging") {
    const s = scale.step;
    return [-2.5 * s, -1.5 * s, 0, 1.5 * s, 2.5 * s][bin] ?? 0;
  }
  return bin * scale.step + scale.step / 2;
}

/** Every lens, in the order the desk lists them. */
export const LENS_ORDER: readonly DeskLens[] = DESK_LENSES;

/**
 * The Colour control of the map's toolbar (spec 14.9): a labelled select, one of the
 * lenses. Without a handler (the server's default view) it is drawn disabled, the
 * row keeping its height until the island mounts.
 */
export function LensSelect({ lens, onPick }: { lens: DeskLens; onPick?: (lens: DeskLens) => void }) {
  return (
    <ToolbarSelect
      label="Colour"
      value={lens}
      onChange={onPick === undefined ? undefined : (value) => onPick(value as DeskLens)}
    >
      {LENS_ORDER.map((option) => (
        <option key={option} value={option}>
          {LENS_SELECT_LABELS[option]}
        </option>
      ))}
    </ToolbarSelect>
  );
}
