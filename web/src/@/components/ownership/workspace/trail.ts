/**
 * The inspector's trail (spec 14.1, backlog C2): the selections a reader has taken on
 * one page, in the order taken, so a drill (a sector, then a company, then its holder)
 * can be walked back without the browser's history. Each step is a label and the link
 * that restores it.
 *
 * The trail lives in sessionStorage, one key per page, never in the link: a shared URL
 * carries the selection, not the reader's path to it. A PURE MODULE. No React, no DOM;
 * the storage is an interface, so the tests pass a fake and the rail passes the window's.
 */

export interface TrailStep {
  /** The name the inspector gave the selection (its content heading), or the zoomed sector. */
  label: string;
  /** The link that restores the step: the page's path with the search it had then. */
  href: string;
}

/** Four steps: enough for a sector, a company, a holder and one more, and short enough to read on a phone. */
export const TRAIL_MAX = 4;

/** The part of the Web Storage API the trail needs. A fake in tests, sessionStorage in the rail. */
export interface TrailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The sessionStorage key for one page's trail. */
export function trailKey(pathname: string): string {
  return `ownership-trail:${pathname}`;
}

/**
 * The link that restores a page state: the path with its search, the parameters in a
 * fixed order so the same state always gives the same string (the cut-back compares hrefs).
 */
export function trailHref(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.sort();
  const query = params.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

/**
 * The trail after a step is taken. A step whose link is already the last is not repeated.
 * A step whose link is already in the trail cuts the trail back to it, so walking back and
 * then forward again does not grow it. Otherwise the step is appended, and the oldest steps
 * fall away once the trail is longer than `max`.
 */
export function pushTrail(trail: readonly TrailStep[], step: TrailStep, max: number = TRAIL_MAX): TrailStep[] {
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : TRAIL_MAX;
  const last = trail[trail.length - 1];
  if (last !== undefined && last.href === step.href) return [...trail];
  const at = trail.findIndex((existing) => existing.href === step.href);
  const kept = at >= 0 ? trail.slice(0, at + 1) : [...trail, step];
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/**
 * The stored trail for a key, or an empty trail when nothing is stored, the storage is
 * unavailable (a privacy mode that throws), or the value is not a trail this module wrote.
 * One malformed step makes the whole value an empty trail, never a partial one.
 */
export function readTrail(storage: TrailStorage | null | undefined, key: string, max: number = TRAIL_MAX): TrailStep[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const steps: TrailStep[] = [];
  for (const item of parsed) {
    if (!isTrailStep(item)) return [];
    steps.push({ label: item.label, href: item.href });
  }
  return steps.length > max ? steps.slice(steps.length - max) : steps;
}

/** Stores a trail under its key. A storage that refuses the write keeps the trail in memory only. */
export function writeTrail(storage: TrailStorage | null | undefined, key: string, trail: readonly TrailStep[]): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(trail.map((step) => ({ label: step.label, href: step.href }))));
  } catch {
    // A full or disabled store costs the reader the walk-back after a reload, not the page.
  }
}

/**
 * A step's label is text, and its href is a path on this site: a stored value that is not
 * a same-site path is not a step. A backslash counts as a slash in the URL parser, so "/\"
 * followed by a host would be an external link; it is refused with "//".
 */
function isTrailStep(value: unknown): value is TrailStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  if (typeof step.label !== "string" || step.label.trim() === "") return false;
  if (typeof step.href !== "string") return false;
  return /^\/(?![/\\])/.test(step.href);
}
