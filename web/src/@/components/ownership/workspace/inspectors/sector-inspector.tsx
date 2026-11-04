/**
 * The inspector's content for a zoomed sector (backlog C4): who holds the sector, on the map's zoom.
 * The map zooms a sector through `?sector=`, and a zoomed sector with no company selected used to say
 * nothing of its holders. The rail now names the sector's largest holders by estimated exposure, the
 * kind it is largest in, and the net change of its notices in the window.
 *
 * Every figure is read from the flows the desk already reads (spec 14.10): a band's exposure and its
 * ten largest holders, and the window's change rows. A holder that sits in two kinds' bands is summed
 * once, under its slug. The sums are what the notices disclose, never a share of the sector.
 *
 * A PURE MODULE. No React, no DOM, no Connect: the resolver reads the flows and passes them here, so the
 * page and the tests share one answer.
 */

import type {
  FlowChangeRow,
  FlowPositionRow,
} from "~/@/components/ownership/desk/flows-layout";
import { OTHER_SECTOR } from "~/@/components/ownership/desk/map-layout";
import { formatAmount, MINUS, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import {
  FOLDED_SECTOR_LABEL,
  KIND_ORDER,
  kindInfo,
  kindRank,
  shortSector,
} from "~/@/lib/ownership/kinds";
import { serializeSelection } from "../selection";
import type { InspectorBar, InspectorContent, InspectorLink, InspectorRow, InspectorSection } from "../inspector-types";
import { HOLDER_LIMIT, type ConnectionSpan } from "./connection-inspector";

/** The flows the rail reads for one sector: the bands, the window's changes and the span they cover. */
export interface SectorFlows {
  positions: readonly FlowPositionRow[];
  changes: readonly FlowChangeRow[];
  /** The span the flows were read over, as the API served it; "" when unknown. */
  from: string;
  to: string;
}

/** One holder of the sector, summed over the sector's bands. */
export interface SectorHolder {
  /** The holder's page key (an institution slug, or a `name:` key); the sum is keyed by it. */
  slug: string;
  name: string;
  /** The holder's estimated exposure summed over its bands; null when no band states one. */
  exposureAud: number | null;
  /** The kind the holder is largest in here: the connection its bar opens. */
  holderKind: string;
}

const DISCLOSED_NOTE = "Disclosed exposure, estimated: voting power x market cap; what the notices disclose.";
const NO_HOLDER_NOTE = "No holder disclosed in this sector in the window.";

/** Whether a sector is a placeholder or a fold: no register is filtered by it, so it has no register link. */
function isRegisterSector(sector: string): boolean {
  return sector !== OTHER_SECTOR && sector !== FOLDED_SECTOR_LABEL;
}

/**
 * The sector's holders (backlog C4): each holder's exposure summed over the sector's bands, the
 * sum taken over the bands that state one, so a holder with no figure in any band has none. Sorted
 * by exposure, largest first, a holder with none after the ranked ones, then by name; at most the
 * band's own limit. Each holder is named under the kind it is largest in.
 */
export function sectorHolders(positions: readonly FlowPositionRow[], sector: string): SectorHolder[] {
  const byHolder = new Map<
    string,
    { name: string; total: number | null; kinds: Array<{ kind: string; exposure: number | null }> }
  >();
  for (const band of positions) {
    if (band.industry !== sector) continue;
    for (const holder of band.topHolders) {
      const entry = byHolder.get(holder.slug) ?? { name: holder.name, total: null, kinds: [] };
      if (holder.exposureAud !== null) entry.total = (entry.total ?? 0) + holder.exposureAud;
      entry.kinds.push({ kind: band.kind, exposure: holder.exposureAud });
      byHolder.set(holder.slug, entry);
    }
  }
  const holders: SectorHolder[] = [];
  for (const [slug, entry] of byHolder) {
    // The kind the holder is largest in: its biggest figure, then the vocabulary's order on a tie.
    const largest = [...entry.kinds].sort(
      (a, b) => (b.exposure ?? -1) - (a.exposure ?? -1) || kindRank(a.kind) - kindRank(b.kind),
    )[0];
    holders.push({ slug, name: entry.name, exposureAud: entry.total, holderKind: largest?.kind ?? "unclassified" });
  }
  return holders
    .sort(
      (a, b) =>
        (b.exposureAud ?? -1) - (a.exposureAud ?? -1) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
    )
    .slice(0, HOLDER_LIMIT);
}

/** The window's net change of one sector, up less down, in AUD; null unless every change row states its exposure. */
function sectorNet(changes: readonly FlowChangeRow[]): number | null {
  if (changes.length === 0) return null;
  let net = 0;
  for (const change of changes) {
    if (change.exposureAud === null) return null;
    net += change.direction === "up" ? change.exposureAud : -change.exposureAud;
  }
  return net;
}

/** A signed AUD figure for a sentence: "+$0.4B", "−$0.4B", "$0". */
function signedAmount(value: number): string {
  if (value === 0) return formatAmount(0, "AUD");
  return value > 0 ? `+${formatAmount(value, "AUD")}` : formatAmount(value, "AUD");
}

/**
 * The sector's reading (spec 14.1, backlog C1): the kind that holds the most, its estimated exposure and
 * how many holders it names; the largest holder; the net change in the window. Each clause drops when its
 * figure is missing, and with no clause left there is no reading at all.
 */
export function sectorReading({
  positions,
  holders,
  changes,
}: {
  positions: readonly FlowPositionRow[];
  holders: readonly SectorHolder[];
  changes: readonly FlowChangeRow[];
}): string | undefined {
  const clauses: string[] = [];
  const measured = positions.filter((band) => band.exposureAud !== null);
  if (measured.length > 0) {
    const top = [...measured].sort(
      (a, b) => (b.exposureAud ?? 0) - (a.exposureAud ?? 0) || kindRank(a.kind) - kindRank(b.kind),
    )[0];
    if (top?.exposureAud != null) {
      const count = top.topHolders.length;
      const across =
        count === 0
          ? ""
          : count >= HOLDER_LIMIT
            ? ` across ${HOLDER_LIMIT} or more holders`
            : ` across ${count} ${count === 1 ? "holder" : "holders"}`;
      clauses.push(
        `${kindInfo(top.kind).plural} hold the most, ${formatAmount(top.exposureAud, "AUD")} estimated${across}`,
      );
    }
  }
  const largest = holders[0];
  if (largest?.exposureAud != null) {
    clauses.push(`${largest.name} largest at ${formatAmount(largest.exposureAud, "AUD")}`);
  }
  const net = sectorNet(changes);
  if (net !== null) clauses.push(`net ${signedAmount(net)} in the window`);
  return clauses.length === 0 ? undefined : `${clauses.join("; ")}.`;
}

/**
 * One kind's window change, as "+$X in N notices" or "−$Y in M notices". Where a row states no exposure the
 * figure is "n/a" with no sign: a signed n/a reads as a figure that failed to format.
 */
function changePart(sign: "+" | typeof MINUS, rows: readonly FlowChangeRow[]): string {
  const notices = rows.reduce((sum, row) => sum + row.notices, 0);
  const count = `${notices} ${notices === 1 ? "notice" : "notices"}`;
  if (rows.some((row) => row.exposureAud === null)) return `${NOT_AVAILABLE} in ${count}`;
  const total = rows.reduce((sum, row) => sum + (row.exposureAud ?? 0), 0);
  return `${sign}${formatAmount(total, "AUD")} in ${count}`;
}

/**
 * The window's change by holder type (backlog C4): one row per kind in the vocabulary's order that
 * has an up or a down change in the sector, its rises and falls in the same row. A kind with neither
 * is left out.
 */
export function sectorChangeRows(changes: readonly FlowChangeRow[]): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const kind of KIND_ORDER) {
    const up = changes.filter((change) => change.kind === kind && change.direction === "up");
    const down = changes.filter((change) => change.kind === kind && change.direction === "down");
    if (up.length === 0 && down.length === 0) continue;
    const parts: string[] = [];
    if (up.length > 0) parts.push(changePart("+", up));
    if (down.length > 0) parts.push(changePart(MINUS, down));
    rows.push({ label: kindInfo(kind).plural, value: parts.join(" · ") });
  }
  return rows;
}

/**
 * The link a holder's bar opens: the connection of the holder's kind to this sector, on the same
 * sector and the same notice window, so the connection inspector reads the window the reader chose.
 * `keep` carries the reader's other parameters the link names (the lens, the Connections view, the fund
 * dates); an empty value is not written. The sort is not among them: the inspector's query does not
 * carry it, so a bar's link drops it until the query does.
 */
export function sectorConnectionHref(
  holderKind: string,
  sector: string,
  span: ConnectionSpan,
  keep: Readonly<Record<string, string>> = {},
): string {
  const params = new URLSearchParams({ sector });
  for (const [name, value] of Object.entries(keep)) {
    if (value !== "") params.set(name, value);
  }
  params.set("sel", serializeSelection({ kind: "connection", holderKind, sector }));
  if (span.window !== "") params.set("window", span.window);
  if (span.since !== "" && span.until !== "") {
    params.set("since", span.since);
    params.set("until", span.until);
  }
  return `?${params.toString()}`;
}

/** The sector's largest holders as bars, each bar linking to the connection it belongs to. */
function holderBars(
  holders: readonly SectorHolder[],
  sector: string,
  span: ConnectionSpan,
  keep: Readonly<Record<string, string>>,
): InspectorBar[] {
  const largest = Math.max(0, ...holders.map((holder) => holder.exposureAud ?? 0));
  return holders.map((holder) => ({
    label: holder.name,
    // The bar merges its selection into the reader's link, so the sort, lens and window it carries survive the
    // click; the href is the fallback the bar keeps for a reader without the page's query.
    params: { sel: serializeSelection({ kind: "connection", holderKind: holder.holderKind, sector }) },
    href: sectorConnectionHref(holder.holderKind, sector, span, keep),
    title: kindInfo(holder.holderKind).label,
    value: formatAmount(holder.exposureAud, "AUD"),
    share: largest > 0 && holder.exposureAud !== null ? holder.exposureAud / largest : 0,
  }));
}

/**
 * The inspector's content for a zoomed sector (backlog C4). `flows` is the desk's flows over the link's
 * window, and `window` is that window as the link names it, which the holders' links keep. `keep` is the
 * reader's other parameters (see sectorConnectionHref). A sector with no band returns the heading and a
 * note, with no reading and no list.
 */
export function sectorInspectorContent({
  sector,
  flows,
  window,
  keep = {},
}: {
  sector: string;
  flows: SectorFlows;
  window: ConnectionSpan;
  keep?: Readonly<Record<string, string>>;
}): InspectorContent {
  const heading = shortSector(sector);
  const subtitle = sector !== heading ? sector : undefined;
  const span: InspectorRow[] =
    flows.from !== "" && flows.to !== "" ? [{ label: "Notices released", value: `${flows.from} to ${flows.to}` }] : [];
  const primary: InspectorLink | undefined = isRegisterSector(sector)
    ? {
        label: "View the registers →",
        href: `/ownership/stocks?${new URLSearchParams({ industry: sector }).toString()}`,
        nofollow: true,
      }
    : undefined;
  const common = {
    heading,
    subtitle,
    logo: { kind: "sector" as const, industry: sector },
    primary,
    footnote: DISCLOSED_NOTE,
  };

  const positions = flows.positions.filter((band) => band.industry === sector);
  if (positions.length === 0) {
    return { ...common, rows: span, note: NO_HOLDER_NOTE };
  }

  const changes = flows.changes.filter((change) => change.industry === sector);
  const holders = sectorHolders(positions, sector);
  const sections: InspectorSection[] = [];
  if (holders.length > 0) {
    sections.push({
      title: "Largest holders by disclosed exposure",
      kind: "bars",
      items: holderBars(holders, sector, window, keep),
    });
  }
  const changeRows = sectorChangeRows(changes);
  if (changeRows.length > 0) {
    sections.push({ title: "Net change in the window, by holder type", kind: "rows", items: changeRows });
  }
  return {
    ...common,
    reading: sectorReading({ positions, holders, changes }),
    rows: span,
    sections,
  };
}
