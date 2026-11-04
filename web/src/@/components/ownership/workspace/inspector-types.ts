/**
 * The inspector's plain contract (spec 14.1): what a page's resolver returns for a
 * selection. Plain data only, so a server action can carry it across the boundary
 * and no island imports Connect or the generated protobuf.
 *
 * Every number arrives formatted (a `value` is the printed string, a `share` is a
 * plain 0 to 1 fraction for a bar), so the rail draws what it is given and never
 * formats or divides a figure itself.
 */

import type { Selection } from "./selection";

export interface InspectorRow {
  label: string;
  value: string;
}

/** One bar of a `bars` section: a printed figure and its share of the largest, 0 to 1. */
export interface InspectorBar {
  label: string;
  value: string;
  share: number;
  /** A line the bar carries on hover, e.g. the institution behind a fund (spec 14.7). */
  title?: string;
  /** The bar's label is a link when set, e.g. a company row to its register page (spec 14.8). */
  href?: string;
  /** A second line under the bar, e.g. a fund's shares beside its weight (spec 14.10). */
  detail?: string;
}

/**
 * One dated figure of a numeric series (spec 14.8): `value` is the plain number, null
 * for a file that does not state it (never 0); `read: false` is a file that could not
 * be read just now.
 */
export interface InspectorPoint {
  label: string;
  value: number | null;
  read?: boolean;
}

export type InspectorLogo =
  | { kind: "stock"; code: string }
  | {
      kind: "holder";
      name: string;
      holderKind: string;
      website?: string | null;
      /** The holder's key (spec 14.2): `asx:CODE` takes the company's logo, `name:` the monogram. */
      holderKey?: string | null;
    }
  | { kind: "sector"; industry: string };

export interface InspectorLink {
  label: string;
  href: string;
  /** A filtered list the search engines do not follow (spec 14.8): rendered with rel="nofollow". */
  nofollow?: boolean;
  /** True for a link that leaves the workspace (a source file or a notice). */
  external?: boolean;
  /**
   * Parameters merged into the link the reader is on (spec 14.8): the switch keeps the
   * window and the rest of the link. A null removes the name. `href` is the fallback.
   */
  params?: Record<string, string | null>;
}

/**
 * A titled block under the rows (spec 14.1): a list of label and value rows, bars
 * with a figure each, a list of links, or a dated series (activity, snapshots). A
 * series with `points` is drawn as a line with a dot per point, and its `items` are
 * the figures beneath it (spec 14.8); one without stays the dated text list.
 */
export type InspectorSection =
  | { title: string; kind: "rows"; items: InspectorRow[] }
  | { title: string; kind: "series"; items: InspectorRow[]; points?: InspectorPoint[] }
  | { title: string; kind: "bars"; items: InspectorBar[] }
  | { title: string; kind: "list"; items: InspectorLink[] };

export interface InspectorContent {
  /** The name, in the page-title serif. */
  heading: string;
  /** A line under the name, e.g. "PLS Group · Materials" or "Holdings as at {date}". */
  subtitle?: string;
  /**
   * The one computed sentence the rail leads with (spec 14.1, backlog C1): what is notable in
   * this selection, built from the figures the rail already shows. Never model prose. A figure
   * that is missing drops its clause, and with no clause left there is no reading at all.
   */
  reading?: string;
  logo?: InspectorLogo;
  /** Kind or status badges beside the name, e.g. "Company", "Substantial notices". */
  badges?: string[];
  /** The one big figure, with its caption beneath. */
  figure?: {
    value: string;
    caption: string;
    /** A change's direction: a rise takes the primary, a fall the ink, the whole figure (spec 14.9). */
    tone?: "up" | "down";
  };
  rows: InspectorRow[];
  /** Titled blocks, drawn in order after the rows. */
  sections?: InspectorSection[];
  /** A line above the primary action. */
  note?: string;
  /** The one primary action, full width; spec 14.1. */
  primary?: InspectorLink;
  links?: InspectorLink[];
  /** A line under "Clear selection", e.g. "Selection highlights this company and sector across the workspace." */
  footnote?: string;
}

/**
 * The URL's own parameters the resolver may read (spec 14.8): the lens of the stock
 * figure, the Connections view (positions or changes) and the notice window (days,
 * or a brushed pair). Plain strings, as they sit in the link; "" is unset.
 */
export interface InspectorQuery {
  lens: string;
  view: string;
  window: string;
  since: string;
  until: string;
  /** The fund page's file date (`as`): a holding resolves in the file the page shows. */
  asAt: string;
  /**
   * The index fund window's two snapshot dates (`from`, `to`, spec 13.1): a fund's change
   * in shares is read between them. Optional, so a link without them is still a query.
   */
  from?: string;
  to?: string;
}

/** One notice of the Activity rail's "Largest moves in the window" (spec 14.10), already printed. */
export interface LargestMoveLine {
  /** The company and the holder, as the line names them. */
  label: string;
  /** The stated change with its true minus and its unit, e.g. "+1.14 pp". */
  value: string;
  /** The notice on ASX; "" when it is not a safe link, and the line is text. */
  href: string;
}

/** The Activity rail's empty state, the window's largest moves (spec 14.10). */
export interface LargestMovesBlock {
  /** The window the notices were read over, in days. */
  windowDays: number;
  /** The first and last release dates of the window, YYYY-MM-DD; "" when not read. */
  from: string;
  to: string;
  lines: LargestMoveLine[];
}

/** A page's resolver: a server action from the page, given the selection and the link's parameters. */
export type InspectorResolver = (selection: Selection, query: InspectorQuery) => Promise<InspectorContent | null>;
