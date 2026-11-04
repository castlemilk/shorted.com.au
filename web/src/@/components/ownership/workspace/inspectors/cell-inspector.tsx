/**
 * The inspector's content for one cell of the movement grid (spec 14.3, Activity):
 * a sector in one week. It names the week's notices through the feed's own rows
 * (the feed loader is the same one the feed page reads), counts them by what each
 * notice did, and links the feed filtered to the sector and the week.
 *
 * A pure builder. The week is the Monday the grid starts it on; the feed is asked
 * for the seven days from that Monday, so the count is the week the cell draws.
 */

import type { NoticeFeedPage, NoticeFeedRow } from "~/@/components/ownership/notice-feed-explorer";
import { shiftDate } from "~/@/components/ownership/desk/desk-state";
import { OTHER_SECTOR } from "~/@/components/ownership/desk/map-layout";
import { noticeEventLabel } from "~/@/lib/ownership/events";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { KIND_ORDER, formatPointChange, kindInfo } from "~/@/lib/ownership/kinds";
import { serializeSelection } from "../selection";
import type { InspectorContent, InspectorLink, InspectorRow, InspectorSection } from "../inspector-types";
import { windowNetText } from "./window-net";

/** The week's events, in the order the wireframe counts them: new, changed, ceased. */
export interface WeekCounts {
  became: number;
  changed: number;
  ceased: number;
  nz: number;
}

/** A notice's event as the cell's count names it: increases and decreases are changes to a holding. */
export function countWeek(rows: readonly NoticeFeedRow[]): WeekCounts {
  const counts: WeekCounts = { became: 0, changed: 0, ceased: 0, nz: 0 };
  for (const row of rows) {
    if (row.event === "became") counts.became += 1;
    else if (row.event === "ceased") counts.ceased += 1;
    else if (row.event === "nz") counts.nz += 1;
    else counts.changed += 1;
  }
  return counts;
}

/** The count line, in the wireframe's words: "6 new · 7 changed · 1 ceased". Zero counts are left out. */
export function weekCountLine(counts: WeekCounts): string {
  const parts: string[] = [];
  if (counts.became > 0) parts.push(`${counts.became} new`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed`);
  if (counts.ceased > 0) parts.push(`${counts.ceased} ceased`);
  if (counts.nz > 0) parts.push(`${counts.nz} NZ disclosure${counts.nz === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "No notices this week";
}

/**
 * The feed filtered to a sector over the week: the seven days from the Monday, and the
 * holder kind when the cell is one kind's (spec 14.7). The count and the list are that kind's.
 */
export function cellNoticesHref(sector: string, weekStart: string, kind = ""): string {
  const params = new URLSearchParams();
  if (sector !== OTHER_SECTOR) params.set("industry", sector);
  if (kind !== "") params.set("kind", kind);
  params.set("since", weekStart);
  params.set("until", shiftDate(weekStart, 6));
  return `/ownership/notices?${params.toString()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The week's header in the grid's words: "Week of 26 Oct" (spec 14.3). */
export function weekHeading(weekStart: string): string {
  const [, month, day] = weekStart.split("-");
  const index = Number(month) - 1;
  const monthName = MONTHS[index];
  if (monthName === undefined || !/^\d{2}$/.test(day ?? "")) return `Week of ${weekStart}`;
  return `Week of ${Number(day)} ${monthName}`;
}

/**
 * The cell's reading (spec 14.1, backlog C1): the week's notice count, then its rises and falls, then the week's
 * net change. The rises, falls and net are counted over the rows, so they are printed only when the rows are the
 * whole week; a partial page keeps the count alone. The net is printed only when every row states its own change
 * in points (the grid's sum); a row with none drops the net and nothing else.
 */
export function cellReading({
  sector,
  weekStart,
  feed,
  kind = "",
}: {
  sector: string;
  weekStart: string;
  feed: NoticeFeedPage | null;
  kind?: string;
}): string | undefined {
  if (sector === OTHER_SECTOR || feed === null) return undefined;
  const total = feed.total;
  const week = weekHeading(weekStart).replace(/^Week of /, "the week of ");
  const kindWord = kind === "" ? "" : `${kindInfo(kind).label.toLowerCase()} `;
  if (total === 0) return `No ${kindWord}notices in ${week}.`;
  const head = `${total} ${kindWord}${total === 1 ? "notice" : "notices"} in ${week}`;
  if (feed.rows.length < total) return `${head}.`;
  const rises = feed.rows.filter((row) => row.event === "became" || row.event === "increased").length;
  const falls = feed.rows.filter((row) => row.event === "decreased" || row.event === "ceased").length;
  const net = windowNetText(feed.rows, total);
  return `${head}, ${rises} ${rises === 1 ? "rise" : "rises"} and ${falls} ${falls === 1 ? "fall" : "falls"}${net === undefined ? "" : `, net ${net}`}.`;
}

/**
 * The link that switches the grid to the reported voting-power change (spec 14.3). It names the cell and
 * the holder type; the grid reads `measure` from the link, so the switch is one click from the rail.
 */
export function measureSwitchHref(sector: string, weekStart: string, kind = ""): string {
  const sel = serializeSelection({
    kind: "cell",
    sector,
    date: weekStart,
    holderKind: kind === "" ? undefined : kind,
  });
  return `?${new URLSearchParams({ sel, measure: "pp" }).toString()}`;
}

/** The week's notices as sections: the linked list, then any notice whose URL is not a usable link. */
function weekSections(notices: InspectorLink[], unlinked: InspectorRow[]): InspectorSection[] | undefined {
  const sections: InspectorSection[] = [];
  if (notices.length > 0) sections.push({ title: "Selected week's notices", kind: "list", items: notices });
  if (unlinked.length > 0) sections.push({ title: "Notices without a usable link", kind: "rows", items: unlinked });
  return sections.length > 0 ? sections : undefined;
}

/**
 * A holder kind as the cell groups it: one of the vocabulary's kinds, or "unclassified" for an empty
 * or unknown one. The list is a fixed set, so a name that is not in it (even "constructor") is unclassified.
 */
function groupKind(kind: string): string {
  return (KIND_ORDER as readonly string[]).includes(kind) ? kind : "unclassified";
}

/**
 * The week's notices counted by holder kind, in the vocabulary's display order, zero counts left out
 * (backlog C7). A kind-filtered cell has one row: the feed is asked for that kind alone.
 */
export function holderKindRows(rows: readonly NoticeFeedRow[]): InspectorRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const group = groupKind(row.holderKind);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const out: InspectorRow[] = [];
  for (const kind of KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    out.push({ label: kindInfo(kind).plural, value: `${count} ${count === 1 ? "notice" : "notices"}` });
  }
  return out;
}

/** How many of the largest moves the cell names (backlog C7). */
const MOVES_LIMIT = 10;

/** A listed notice that states its change in points: both of its figures are stated. */
type MoveRow = NoticeFeedRow & { changePp: number };

/**
 * The cell's largest moves: the rows that state their change, by its size (the larger of a rise or a fall),
 * the newer first on a tie. A row that states only one of its figures has no change and is not a move.
 */
export function largestMoves(rows: readonly NoticeFeedRow[]): MoveRow[] {
  return rows
    // A change under half a hundredth of a point prints as 0.00 pp: a move of nothing is not a largest move.
    .filter(
      (row): row is MoveRow =>
        typeof row.changePp === "number" && Number.isFinite(row.changePp) && Math.abs(row.changePp) >= 0.005,
    )
    .sort(
      (a, b) =>
        Math.abs(b.changePp) - Math.abs(a.changePp) ||
        b.released.localeCompare(a.released) ||
        a.code.localeCompare(b.code),
    )
    .slice(0, MOVES_LIMIT);
}

/**
 * The moves as sections. A move whose notice has a safe link is a list item; one without is a row, as
 * the week's notices are. A list item has no value of its own, so its change and date go in its label.
 */
function moveSections(moves: MoveRow[], suffix: string): InspectorSection[] {
  const linked: InspectorLink[] = [];
  const unlinked: InspectorRow[] = [];
  for (const row of moves) {
    const change = formatPointChange(0, row.changePp);
    const href = safeExternalHref(row.url);
    if (href === undefined) {
      unlinked.push({ label: `${row.code} · ${row.holder}`, value: `${change} · ${row.released}` });
    } else {
      linked.push({ label: `${row.code} · ${row.holder} · ${change} · ${row.released}`, href, external: true });
    }
  }
  const sections: InspectorSection[] = [];
  if (linked.length > 0) sections.push({ title: `Largest moves${suffix}`, kind: "list", items: linked });
  if (unlinked.length > 0) {
    sections.push({ title: `Largest moves${suffix}, without a usable link`, kind: "rows", items: unlinked });
  }
  return sections;
}

/**
 * The cell's sections in the order a reader needs them (backlog C7): who moved the sector, by holder kind,
 * then the largest moves, then the week's notices. Every block counts the rows listed, so a partial page
 * says so in its titles.
 */
function cellSections(
  rows: readonly NoticeFeedRow[],
  partial: boolean,
  notices: InspectorLink[],
  unlinked: InspectorRow[],
): InspectorSection[] | undefined {
  const suffix = partial ? " of the listed notices" : "";
  const sections: InspectorSection[] = [];
  const kinds = holderKindRows(rows);
  if (kinds.length > 0) sections.push({ title: `By holder type${suffix}`, kind: "rows", items: kinds });
  sections.push(...moveSections(largestMoves(rows), suffix));
  sections.push(...(weekSections(notices, unlinked) ?? []));
  return sections.length > 0 ? sections : undefined;
}

/**
 * The cell's rail. The count is the feed's total for the week (the rows are the
 * first page of it, so the list says how many are shown beside the total).
 *
 * The Other row is withheld: the feed rows carry no sector, so its notices cannot
 * be told apart from the market's, and a count of the whole week would contradict
 * the cell the reader clicked. The feed is not read for it (`feed` is null).
 */
export function cellInspectorContent({
  sector,
  weekStart,
  feed,
  kind = "",
}: {
  sector: string;
  weekStart: string;
  feed: NoticeFeedPage | null;
  /** The holder kind the grid was showing; "" for every kind. */
  kind?: string;
}): InspectorContent {
  // The kind the count is of, named beside the week (spec 14.3): "" is every holder.
  const subtitle = [weekHeading(weekStart), kind === "" ? "" : kindInfo(kind).plural]
    .filter((part) => part !== "")
    .join(" · ");
  if (sector === OTHER_SECTOR || feed === null) {
    return {
      heading: sector,
      subtitle,
      figure: { value: "n/a", caption: "Notices released this week" },
      rows: [],
      note: "Other's notices are not filtered by sector, so the count is withheld.",
    };
  }
  // The counts are of the rows the feed returned: a partial page says so, rather than
  // presenting its first rows as the whole week.
  const partial = feed.rows.length < feed.total;
  const counts = countWeek(feed.rows);
  // A stored notice URL passes safeExternalHref before it is any href (spec 14.7). One that
  // does not is drawn as its label alone, in a rows block, never as a link.
  const label = (row: NoticeFeedRow) =>
    `${row.released} · ${row.code} · ${row.holder}, ${noticeEventLabel(row.event).toLowerCase()}`;
  const notices: InspectorLink[] = [];
  const unlinked: InspectorRow[] = [];
  for (const row of feed.rows) {
    const href = safeExternalHref(row.url);
    if (href === undefined) unlinked.push({ label: label(row), value: "no link" });
    else notices.push({ label: label(row), href, external: true });
  }
  const total = feed.total;
  return {
    heading: sector,
    subtitle,
    reading: cellReading({ sector, weekStart, feed, kind }),
    figure: { value: `${total} ${total === 1 ? "notice" : "notices"}`, caption: "Notices released this week" },
    rows: [{ label: partial ? "Events in the listed notices" : "Events", value: weekCountLine(counts) }],
    sections: cellSections(feed.rows, partial, notices, unlinked),
    note:
      feed.rows.length < total
        ? `The first ${feed.rows.length} of ${total} notices are listed; the feed has the rest.`
        : undefined,
    primary: {
      label: total === 1 ? "View 1 notice →" : `View ${total} notices →`,
      href: cellNoticesHref(sector, weekStart, kind),
    },
    links: [
      {
        label: "Switch to reported voting-power change",
        href: measureSwitchHref(sector, weekStart, kind),
        params: { measure: "pp" },
      },
    ],
  };
}
