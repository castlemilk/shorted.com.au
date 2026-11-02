/**
 * How long a holding has gone without a notice we could read.
 *
 * A reading up to 90 days old is the current state of play and carries no
 * label. Past that, the label says how long the holding has gone without a
 * notice we could read. A figure can drift by less than a point without any
 * new notice, so the age is the honest thing to print beside it. Dates are
 * YYYY-MM-DD and count in UTC, so a timezone never moves a notice by a day.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.44;
const FRESH_DAYS = 90;

/** Days since 1970-01-01 for a YYYY-MM-DD date, or null for anything else. */
export function dayOf(date: string): number | null {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  // Date.parse can roll 2026-02-31 over into March, so a date that does not
  // survive the round trip is not a date.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms / MS_PER_DAY;
}

/** The YYYY-MM-DD date a day count falls on. */
export function dateOf(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Whole months between a reading and the as-at date, or null when there is no
 * label to print: the reading is recent, or either date does not read.
 */
export function ageMonths(asAt: string, asOf: string): number | null {
  const reading = dayOf(asAt);
  const asOfDay = dayOf(asOf);
  if (reading === null || asOfDay === null) return null;
  const days = asOfDay - reading;
  if (days <= FRESH_DAYS) return null;
  return Math.round(days / DAYS_PER_MONTH);
}

/** The age label: "13 mo", or "" for a reading that is recent or undated. */
export function ageLabel(asAt: string, asOf: string): string {
  const months = ageMonths(asAt, asOf);
  return months === null ? "" : `${months} mo`;
}
