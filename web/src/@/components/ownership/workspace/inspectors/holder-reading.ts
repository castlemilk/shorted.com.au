/**
 * The holder's reading (spec 14.1, backlog C1): one plain sentence that leads the holder rail, from the
 * positions the register already serves. A pure builder in a module of its own, not in holder-inspector.tsx:
 * that file is a client component, and the holder's content is built on the server, which must be able to
 * call this without a client reference.
 */

import { shortSector } from "~/@/lib/ownership/kinds";

/** The window a "new this quarter" position is counted over, from the newest notice (spec 14.3). */
export const NEW_WINDOW_DAYS = 91;

const DAY_MS = 86_400_000;

/**
 * One position of the holder as the register states it. `form` and `eventDate` are read only when the rows
 * carry them: a position without both cannot be counted as new, so the clause is then left out.
 */
export interface HolderReadingPosition {
  industry: string;
  votingPowerPct: number | null;
  marketCap: number | null;
  /** The latest notice's form: "603" became substantial, "604" changed, "605" ceased, "nz" a New Zealand disclosure. */
  form?: string;
  /** The latest notice's date, YYYY-MM-DD: the event's date, read when the notice's release date is not stated. */
  eventDate?: string;
  /** The notice's release date, YYYY-MM-DD: the date a "new this quarter" position is counted by when stated. */
  announcedOn?: string;
}

/** The estimated exposure of a position, as the rail computes it: voting power of the market cap. Null when either is missing. */
function exposureOf(position: HolderReadingPosition): number | null {
  if (position.votingPowerPct === null || position.marketCap === null) return null;
  if (!Number.isFinite(position.votingPowerPct) || !Number.isFinite(position.marketCap)) return null;
  return (position.votingPowerPct / 100) * position.marketCap;
}

/** The date a position is counted by: its release date when stated, else its event's date. Undefined when neither is a date. */
function releaseDateOf(position: HolderReadingPosition): string | undefined {
  const date = position.announcedOn ?? position.eventDate;
  return date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/**
 * The positions that became substantial within the window of the newest notice. Null unless every position
 * carries its form and its date, so a partial count is never printed.
 */
function newThisQuarter(positions: readonly HolderReadingPosition[]): number | null {
  if (positions.length === 0) return null;
  const dates = positions.map(releaseDateOf);
  const dated = positions.every((position, index) => position.form !== undefined && dates[index] !== undefined);
  if (!dated) return null;
  const newest = Math.max(...dates.map((date) => Date.parse(`${date}T00:00:00Z`)));
  return positions.filter((position, index) => {
    if (position.form !== "603") return false;
    const age = (newest - Date.parse(`${dates[index]}T00:00:00Z`)) / DAY_MS;
    return age >= 0 && age <= NEW_WINDOW_DAYS;
  }).length;
}

/**
 * The sector of the largest position, ranked by estimated exposure when any position has one, else by voting
 * power: the measure the rail's connections are ranked by. Undefined when no position carries a figure.
 */
function largestSector(positions: readonly HolderReadingPosition[]): string | undefined {
  const exposures = positions.map(exposureOf);
  const byExposure = exposures.some((exposure) => exposure !== null);
  let best: { industry: string; value: number } | null = null;
  for (const [index, position] of positions.entries()) {
    const value = byExposure ? (exposures[index] ?? null) : position.votingPowerPct;
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || value > best.value) best = { industry: position.industry, value };
  }
  return best === null ? undefined : shortSector(best.industry);
}

/**
 * The holder reading: "172 positions, 14 new this quarter, largest in Banks." Each clause is left out when its
 * figure is not stated; with none left there is no reading.
 */
export function holderReading({
  count,
  positions,
}: {
  /** The positions the register counts for the holder (the rail's own figure). */
  count: number;
  positions: readonly HolderReadingPosition[];
}): string | undefined {
  const clauses: string[] = [];
  if (Number.isFinite(count) && count > 0) clauses.push(`${count} ${count === 1 ? "position" : "positions"}`);
  const fresh = newThisQuarter(positions);
  if (fresh !== null && fresh > 0) clauses.push(`${fresh} new this quarter`);
  const sector = largestSector(positions);
  if (sector !== undefined) clauses.push(`largest in ${sector}`);
  return clauses.length > 0 ? `${clauses.join(", ")}.` : undefined;
}
