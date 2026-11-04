/**
 * The notices by week (backlog C6): the Monday-started weeks ending with a date's week, each with
 * the count of the notice release dates that fall in it. The stock rail and the holder rail draw
 * the same strip, and the count bins are the heatmap's (week-strip-view.tsx).
 *
 * A PURE MODULE. No React, no DOM, no fetch. A quiet week is a real zero and is listed like any
 * other, so a strip always has its full span; a span the feed did not read whole is no strip at all
 * (weekNoticesFrom), never one that draws its unread weeks as zeros.
 */

import { isIsoDate, shiftDate } from "~/@/components/ownership/desk/desk-state";
import { mondayOf, weekDateLabel, weekList } from "~/@/components/ownership/desk/movement-heatmap-static";
import type { InspectorSection, WeekBar } from "./inspector-types";

/** The weeks a strip shows: 26, half a year, the span the stock and holder rails both read. */
export const WEEK_STRIP_WEEKS = 26;

/** The title of the section a strip is drawn under, on both rails. */
export const NOTICES_BY_WEEK_TITLE = "Notices by week";

/** The notice dates a strip counts, and the date it ends on (the desk's as-of). */
export interface WeekNotices {
  asOf: string;
  released: readonly string[];
}

/**
 * The notice window a strip reads (the feed's since and until): the Monday `weeks - 1` weeks before
 * asOf's week, through asOf. The span is at most 182 days, inside the feed's span cap. Null when
 * asOf is not a date.
 */
export function weekWindow(asOf: string, weeks: number = WEEK_STRIP_WEEKS): { since: string; until: string } | null {
  if (!isIsoDate(asOf) || weeks < 1) return null;
  return { since: shiftDate(mondayOf(asOf), -7 * (weeks - 1)), until: asOf };
}

/**
 * The weeks of a strip, oldest first: every Monday-started week from the first week of
 * `weekWindow` through asOf's week, each with the count of the dates that fall in it. A date
 * outside the span is not counted. `hrefFor` names each week's link from its Monday and its Sunday.
 * An empty list when asOf is not a date.
 */
export function weekStrip(
  dates: readonly string[],
  asOf: string,
  hrefFor: (weekStart: string, weekEnd: string) => string,
  weeks: number = WEEK_STRIP_WEEKS,
): WeekBar[] {
  const span = weekWindow(asOf, weeks);
  if (span === null) return [];
  const starts = weekList(span.since, mondayOf(asOf));
  const counts = new Map<string, number>(starts.map((start) => [start, 0]));
  for (const date of dates) {
    if (!isIsoDate(date)) continue;
    const start = mondayOf(date);
    const current = counts.get(start);
    // A Sunday counts in the week that starts on the Monday before it, as the heatmap's weeks do.
    if (current !== undefined) counts.set(start, current + 1);
  }
  return starts.map((weekStart) => ({
    weekStart,
    count: counts.get(weekStart) ?? 0,
    href: hrefFor(weekStart, shiftDate(weekStart, 6)),
  }));
}

/**
 * A feed page as a strip's dates: null when the page did not answer, or when it holds fewer rows
 * than the notices it matches (the page's own cap). A short page would count its oldest weeks as
 * quiet, so the strip is withheld instead.
 */
export function weekNoticesFrom(
  feed: { ok: boolean; total: number; rows: readonly { released: string }[] } | null | undefined,
  asOf: string,
): WeekNotices | null {
  if (feed === null || feed === undefined || !feed.ok || !isIsoDate(asOf)) return null;
  if (feed.total > feed.rows.length) return null;
  return { asOf, released: feed.rows.map((row) => row.released) };
}

/**
 * The feed pages one strip reads at most: ten pages of the feed's own cap, a thousand notices, which
 * a stock or a holder with a higher cadence than that has no strip for.
 */
export const WEEK_NOTICE_PAGES = 10;

/** One page of the notice feed, as a strip needs it: whether it answered, its total and its rows. */
export interface WeekFeedPage {
  ok: boolean;
  total: number;
  nextCursor: string;
  rows: readonly { released: string }[];
}

/**
 * The notice dates over a strip's span, read page by page. The loader is passed in, so this module
 * imports no server action. Each page is asked with the previous page's cursor, and the read stops
 * on the last page (nextCursor ""). Null when a page did not answer, when the pages run out before
 * the last one, or when the rows read fall short of the total, so a partial read is never drawn.
 */
export async function readWeekNotices<Q extends object>(
  load: (query: Q & { cursor?: string }) => Promise<WeekFeedPage | null | undefined>,
  query: Q,
  asOf: string,
): Promise<WeekNotices | null> {
  const rows: { released: string }[] = [];
  let total = 0;
  let cursor = "";
  for (let page = 0; page < WEEK_NOTICE_PAGES; page += 1) {
    const feed: WeekFeedPage | null | undefined =
      cursor === "" ? await load(query as Q & { cursor?: string }) : await load({ ...query, cursor });
    if (!feed || !feed.ok) return null;
    total = feed.total;
    rows.push(...feed.rows);
    if (feed.nextCursor === "") return weekNoticesFrom({ ok: true, total, rows }, asOf);
    cursor = feed.nextCursor;
  }
  return null;
}

/**
 * The "Notices by week" section for a rail, or null when there is no strip to draw (the notices did
 * not read, or the desk's as-of is not a date). The section is data: the rail draws it as a strip.
 */
export function noticesByWeekSection(
  weekNotices: WeekNotices | null,
  hrefFor: (weekStart: string, weekEnd: string) => string,
): InspectorSection | null {
  if (weekNotices === null) return null;
  const weeks = weekStrip(weekNotices.released, weekNotices.asOf, hrefFor);
  return weeks.length === 0 ? null : { title: NOTICES_BY_WEEK_TITLE, kind: "weeks", weeks };
}

/** A week's count in words: "3 notices", "1 notice", or "no notices" for a real zero. */
export function countPhrase(count: number): string {
  if (count === 0) return "no notices";
  return count === 1 ? "1 notice" : `${count} notices`;
}

/**
 * A week's title, which a reader sees on hover and hears in the list beside the strip: "Week of 26 Oct:
 * 3 notices". The date is the heatmap's short form; a value that is not a date is printed as it is.
 */
export function weekTitle(week: WeekBar): string {
  return `Week of ${weekDateLabel(week.weekStart)}: ${countPhrase(week.count)}`;
}
