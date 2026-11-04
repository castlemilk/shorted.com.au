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
import { kindInfo } from "~/@/lib/ownership/kinds";
import { serializeSelection } from "../selection";
import type { InspectorContent, InspectorLink, InspectorRow, InspectorSection } from "../inspector-types";

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
    figure: { value: `${total} ${total === 1 ? "notice" : "notices"}`, caption: "Notices released this week" },
    rows: [{ label: partial ? "Events in the listed notices" : "Events", value: weekCountLine(counts) }],
    sections: weekSections(notices, unlinked),
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
