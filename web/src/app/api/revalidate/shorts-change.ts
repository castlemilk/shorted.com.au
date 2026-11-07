import { isoWeekDbSlug, weeklyReportPath } from "~/@/lib/reports/weekly-slug";
import {
  SHORTS_DATA_CACHE_TAG,
  SHORTS_LATEST_CACHE_TAG,
  stockCodeCacheTag,
} from "~/app/actions/stockPageCache";

/**
 * What a shorts sync changed, as it sends it in the /api/revalidate body:
 *
 *   {"shorts": {"codes": ["BHP", "CBA", ...], "dates": ["2026-11-03", ...]}}
 *
 * `codes` are the product codes on every row the run wrote, `dates` the report
 * dates those rows are for (the new file's date, plus any older date the
 * reconcile pass corrected).
 */
export interface ShortsChange {
  codes: string[];
  dates: string[];
}

/**
 * Past either ceiling a change set names too much to be worth naming and the
 * route revalidates broadly instead. A routine day writes one date of ~800
 * codes. The sync applies the same two ceilings before it sends a set
 * (services/jobs/internal/jobs/shortdatasync/changes.go: maxNarrowCodes,
 * maxNarrowDates).
 */
export const SHORTS_CHANGE_LIMITS = { codes: 2000, dates: 45 } as const;

export type ShortsChangeRead =
  | { kind: "none" }
  | { kind: "narrow"; change: ShortsChange }
  | { kind: "broad"; reason: string };

const CODE = /^[A-Z0-9]{1,10}$/;

/**
 * Reads the change set from a parsed request body. `none` when the body does
 * not carry one; `broad` when it carries one this route cannot trust in full,
 * because revalidating less than the sync wrote would leave pages stale for a
 * day, while revalidating everything only costs regenerations.
 */
export function parseShortsChange(body: unknown): ShortsChangeRead {
  if (body === null || typeof body !== "object") return { kind: "none" };
  const shorts = (body as { shorts?: unknown }).shorts;
  if (shorts === undefined) return { kind: "none" };
  if (shorts === null || typeof shorts !== "object") {
    return { kind: "broad", reason: "shorts is not an object" };
  }
  const { codes, dates } = shorts as { codes?: unknown; dates?: unknown };
  if (!Array.isArray(codes) || !Array.isArray(dates)) {
    return { kind: "broad", reason: "codes and dates must be arrays" };
  }
  if (codes.length > SHORTS_CHANGE_LIMITS.codes) {
    return { kind: "broad", reason: `more than ${SHORTS_CHANGE_LIMITS.codes} stocks` };
  }
  if (dates.length > SHORTS_CHANGE_LIMITS.dates) {
    return { kind: "broad", reason: `more than ${SHORTS_CHANGE_LIMITS.dates} dates` };
  }

  const codeSet = new Set<string>();
  for (const code of codes) {
    const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!CODE.test(normalized)) {
      return { kind: "broad", reason: "a stock code is unreadable" };
    }
    codeSet.add(normalized);
  }
  const dateSet = new Set<string>();
  for (const date of dates) {
    if (typeof date !== "string" || isoWeekDbSlug(date) === null) {
      return { kind: "broad", reason: "a date is not YYYY-MM-DD" };
    }
    dateSet.add(date);
  }
  if (codeSet.size === 0 || dateSet.size === 0) {
    return { kind: "broad", reason: "the change set names no stock or no date" };
  }
  return {
    kind: "narrow",
    change: { codes: [...codeSet].sort(), dates: [...dateSet].sort() },
  };
}

export interface ShortsRevalidation {
  /** Tags other than the per-stock ones. */
  tags: string[];
  /** One stockCodeCacheTag per changed stock. */
  stockTags: string[];
  /** Concrete paths, revalidated as pages. */
  paths: string[];
  /** Dynamic route patterns, revalidated as every page of the route. */
  patterns: string[];
}

/**
 * Everything a narrow change expires:
 *   - each changed stock's pages and data (stock:<CODE>);
 *   - reads built from the newest snapshot across stocks (shorts-latest);
 *   - the market index, and each changed date's market page, including one
 *     that was a cached 404 before the date existed;
 *   - the weekly, monthly and yearly report covering each changed date, by
 *     data tag and by path (a report page can be a cached 404 too).
 * Every other stock's pages, and every other date and report, are left alone.
 */
export function narrowShortsRevalidation(change: ShortsChange): ShortsRevalidation {
  const tags = new Set<string>([SHORTS_LATEST_CACHE_TAG, "market-index"]);
  const paths = new Set<string>(["/market"]);
  for (const date of change.dates) {
    tags.add(`market-date:${date}`);
    paths.add(`/market/${date}`);
    const week = isoWeekDbSlug(date);
    if (week) {
      tags.add(`report-${week}`);
      paths.add(weeklyReportPath(week));
    }
    const month = date.slice(0, 7);
    const year = date.slice(0, 4);
    tags.add(`report-${month}`);
    paths.add(`/reports/monthly/${month}`);
    tags.add(`report-${year}`);
    paths.add(`/reports/yearly/${year}`);
  }
  return {
    tags: [...tags],
    stockTags: change.codes.map(stockCodeCacheTag),
    paths: [...paths],
    patterns: [],
  };
}

/**
 * The broad revalidation, unchanged from before narrow syncs: an ASIC ingest
 * can correct any historical snapshot, including a date that previously had no
 * data, and negative route entries have no data-tag dependency, so the route
 * patterns are invalidated as well as the shared data tag.
 */
export function broadShortsRevalidation(): ShortsRevalidation {
  return {
    tags: [SHORTS_DATA_CACHE_TAG, "market-index"],
    stockTags: [],
    paths: ["/market"],
    patterns: [
      "/market/[date]",
      "/reports/weekly/[slug]",
      "/reports/monthly/[slug]",
      "/reports/yearly/[slug]",
    ],
  };
}
