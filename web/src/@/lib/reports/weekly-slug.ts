// Weekly report slug scheme.
//
// DB/API slug (weekly_reports.week_slug, RPC requests, cache tags):
//   "2026-W29"
// Canonical public URL slug (what search queries actually look like —
// Market Index's ranking series uses the same pattern):
//   "10-most-shorted-asx-stocks-week-29-2026"
//
// The /reports/weekly/[slug] route accepts BOTH forms; the ISO form 301s to
// the canonical path. Everything internal (fetches, revalidation tags,
// lastmod derivation) keeps using the DB slug.

const DB_SLUG_RE = /^(\d{4})-W(\d{2})$/;
const PATH_SLUG_RE = /^10-most-shorted-asx-stocks-week-(\d{1,2})-(\d{4})$/;

/** "2026-W29" → "10-most-shorted-asx-stocks-week-29-2026" (null if malformed). */
export function weekDbSlugToPathSlug(dbSlug: string): string | null {
  const m = DB_SLUG_RE.exec(dbSlug);
  if (!m?.[1] || !m[2]) return null;
  return `10-most-shorted-asx-stocks-week-${parseInt(m[2], 10)}-${m[1]}`;
}

/**
 * The DB slug of the ISO-8601 week a YYYY-MM-DD date falls in ("2026-W45"),
 * the scheme the report generator names weeks by (Go's time.ISOWeek). Null for
 * anything that is not a real calendar date.
 */
export function isoWeekDbSlug(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== isoDate) {
    return null;
  }
  // The ISO week is the one holding this week's Thursday, and so is its year.
  const weekday = day.getUTCDay() || 7;
  const thursday = new Date(day.getTime() + (4 - weekday) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(
    ((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Canonical page path for a DB slug: "/reports/weekly/10-most-shorted-…". */
export function weeklyReportPath(dbSlug: string): string {
  const pathSlug = weekDbSlugToPathSlug(dbSlug);
  // Malformed input falls back to the raw slug (route will 404 it).
  return `/reports/weekly/${pathSlug ?? dbSlug}`;
}

/**
 * Resolve a [slug] route param (either form) to the DB slug.
 * `canonical` is false when the request used the legacy ISO form and should
 * 301 to weeklyReportPath(dbSlug).
 */
export function resolveWeeklySlugParam(
  param: string,
): { dbSlug: string; canonical: boolean } | null {
  const path = PATH_SLUG_RE.exec(param);
  if (path?.[1] && path[2]) {
    const week = parseInt(path[1], 10);
    if (week < 1 || week > 53) return null;
    const dbSlug = `${path[2]}-W${String(week).padStart(2, "0")}`;
    return {
      dbSlug,
      // Zero-padded weeks ("week-05-2026") parse but are NOT the canonical
      // path — treating them as canonical served duplicate 200s.
      canonical: param === weekDbSlugToPathSlug(dbSlug),
    };
  }
  if (DB_SLUG_RE.test(param)) {
    return { dbSlug: param, canonical: false };
  }
  return null;
}
