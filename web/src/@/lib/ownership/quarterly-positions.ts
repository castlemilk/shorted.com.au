import type { Position, Snapshot } from "~/server/traders/sec-filings";

export interface ComparedPosition {
  current?: Position;
  previous?: Position;
}

export function adjacentQuarters(older: string, newer: string): boolean {
  const ends = ["03-31", "06-30", "09-30", "12-31"];
  const index = (date: string) => {
    const quarter = ends.indexOf(date.slice(5));
    return quarter < 0 ? NaN : Number(date.slice(0, 4)) * 4 + quarter;
  };
  return index(newer) - index(older) === 1;
}

// A class-specific CUSIP can appear on multiple lines for different managers or
// discretion. Aggregate only matching units and option type within that security.
function bySecurity(positions: Position[]): Map<string, Position> {
  const result = new Map<string, Position>();
  for (const position of positions) {
    const key = [position.cusip, position.unit, position.option].join("|");
    const existing = result.get(key);
    if (existing) {
      existing.quantity += position.quantity;
      existing.usd += position.usd;
    } else {
      result.set(key, { ...position });
    }
  }
  return result;
}

export function comparePositions(
  current: Snapshot,
  previous?: Snapshot,
): ComparedPosition[] {
  const after = bySecurity(current.positions);
  const before = bySecurity(previous?.positions ?? []);
  const keys = new Set([...after.keys(), ...before.keys()]);
  return [...keys]
    .map((key) => ({ current: after.get(key), previous: before.get(key) }))
    .sort(
      (a, b) =>
        (b.current?.usd ?? -1) - (a.current?.usd ?? -1) ||
        (b.previous?.usd ?? 0) - (a.previous?.usd ?? 0),
    );
}
