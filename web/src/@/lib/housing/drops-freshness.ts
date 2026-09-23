/**
 * Freshness and coverage rules for the price-drops surfaces, in one
 * server-safe module (no React, no Connect imports) so the static /price-drops
 * page, its client islands and the sitemap all apply the SAME rules.
 *
 * Why this exists: the crawl stopped on 2026-09-15 and every drops read kept
 * serving a "last 30 days" window frozen at that date with nothing on the
 * page, the API or the sitemap saying so. Migration 000124 records when each
 * view was refreshed (as_of) and the newest crawl observation it could see
 * (data_through); these helpers turn that into what a reader is shown.
 */

/** Structural mirror of google.protobuf.Timestamp as protobuf-es v2 emits it. */
export interface TimestampLike {
  seconds: bigint | number | string;
  nanos?: number;
}

/**
 * A price-drops read is flagged stale once its data is this old. The crawl
 * rotates the whole catalog every few days and refreshes the views after each
 * run, so three days without either is an outage, not a quiet spell.
 */
export const DROPS_STALE_AFTER_HOURS = 72;

/**
 * A state is RANKED on the map and board only when at least this share of its
 * catalog suburbs were swept in the last 14 days — the drop index's own
 * coverage gap threshold (indexGapThreshold in drop_index.go). Below it the
 * state's share of listings cut measures how much of it the crawl reached, not
 * how hard it is discounting (measured 2026-09-23: VIC 4.4% vs WA 1.2%, with
 * WA 3 of 67 suburbs swept in 30 days).
 */
export const STATE_COVERAGE_RANK_THRESHOLD = 0.6;

/** Timestamp -> Date; undefined for an unset or malformed stamp. */
export function timestampToDate(ts: TimestampLike | undefined | null): Date | undefined {
  if (!ts) return undefined;
  const seconds = Number(ts.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000 + Math.floor((ts.nanos ?? 0) / 1e6));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "15 Sep 2026" in Sydney time — the calendar day an Australian reader would
 * put on the moment. Month names come from a fixed table, not the runtime's
 * locale data: ICU spells September "Sept" for en-AU on some runtimes and
 * "Sep" on others, so server and client renders would disagree.
 */
export function fmtDropsDate(d: Date, opts: { withYear?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Australia/Sydney",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const month = MONTHS[Number(get("month")) - 1] ?? get("month");
  const day = `${Number(get("day"))} ${month}`;
  return opts.withYear === false ? day : `${day} ${get("year")}`;
}

export interface DropsFreshness {
  /** ISO instant of the view refresh, when known. */
  asOfIso?: string;
  /** ISO instant of the newest crawl observation behind the figures, when known. */
  dataThroughIso?: string;
  /** "Data to 15 Sep 2026" — undefined when no stamp is known. */
  dataToLabel?: string;
  /**
   * True when either stamp is older than DROPS_STALE_AFTER_HOURS. Either one
   * alone can lie: a monthly official-data refresh re-runs the views (fresh
   * as_of over frozen crawl data), and a crawl can land without a refresh.
   * Unknown stamps are not treated as stale — there is nothing to date.
   */
  stale: boolean;
}

export function dropsFreshness(
  stamps: { asOf?: TimestampLike; dataThrough?: TimestampLike } | undefined | null,
  now: Date = new Date(),
): DropsFreshness {
  const asOf = timestampToDate(stamps?.asOf);
  const through = timestampToDate(stamps?.dataThrough);
  const staleBefore = now.getTime() - DROPS_STALE_AFTER_HOURS * 3_600_000;
  const shown = through ?? asOf;
  return {
    asOfIso: asOf?.toISOString(),
    dataThroughIso: through?.toISOString(),
    dataToLabel: shown ? `Data to ${fmtDropsDate(shown)}` : undefined,
    stale: [asOf, through].some((d) => d !== undefined && d.getTime() < staleBefore),
  };
}

export interface StateCoverage {
  /** swept / catalog, or undefined when the catalog size is unknown (0). */
  ratio?: number;
  /** Whether the state's share may be ranked against the others. */
  ranked: boolean;
}

/**
 * Coverage of one state row. A zero catalog means coverage is unknown (a
 * response from before migration 000124), which keeps the old behaviour —
 * ranked — rather than greying out every state.
 */
export function stateCoverage(s: { suburbsSwept14d: number; catalogSuburbs: number }): StateCoverage {
  if (!s.catalogSuburbs || s.catalogSuburbs <= 0) return { ranked: true };
  const ratio = s.suburbsSwept14d / s.catalogSuburbs;
  return { ratio, ranked: ratio >= STATE_COVERAGE_RANK_THRESHOLD };
}
