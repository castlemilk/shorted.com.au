import Link from "next/link";

import { fundamentalsHeld } from "~/@/lib/strategies/coverage";
import { formatCount, formatIsoDate } from "~/@/lib/strategies/format";

/**
 * Where the numbers come from, as one line: price date, fundamentals
 * coverage, the ASIC lag and the disclaimer. Props-only and server-safe.
 * Provenance is part of the composition on this site, not a footnote, so the
 * line sits directly under the H1.
 *
 * Coverage (docs/plans/fundamentals-coverage.md §7.2) counts stocks with any
 * fundamentals row, with the growth-figure count beside it, but only when the
 * API reports the row count and it is consistent (fundamentalsHeld).
 * Otherwise the line says what the one count it has actually counts: growth
 * figures, never "fundamentals".
 */
export function PicksProvenance({
  asOf,
  coverage,
  rowsCount = 0,
  universe,
}: {
  /** YYYY-MM-DD of the latest price; "" when unknown. */
  asOf: string;
  /** Evaluated stocks with at least one growth figure. */
  coverage: number;
  /** Evaluated stocks with any fundamentals row; 0 from an older API. */
  rowsCount?: number;
  universe: number;
}) {
  const priceDate = formatIsoDate(asOf);
  const held = fundamentalsHeld(rowsCount, coverage);
  return (
    <p className="text-sm text-muted-foreground">
      {priceDate ? (
        <>
          Prices to{" "}
          <time dateTime={asOf} className="font-medium text-foreground tabular-nums">
            {priceDate}
          </time>
          {" · "}
        </>
      ) : null}
      {universe > 0 ? (
        held ? (
          <>
            fundamentals for{" "}
            <span className="tabular-nums">{formatCount(rowsCount)}</span> of{" "}
            <span className="tabular-nums">{formatCount(universe)}</span> stocks
            (growth figures for{" "}
            <span className="tabular-nums">{formatCount(coverage)}</span>)
            {" · "}
          </>
        ) : (
          <>
            growth figures for{" "}
            <span className="tabular-nums">{formatCount(coverage)}</span> of{" "}
            <span className="tabular-nums">{formatCount(universe)}</span> stocks
            {" · "}
          </>
        )
      ) : null}
      ASIC shorts T+4
      {" · "}
      <Link href="/disclaimer" className="font-medium text-foreground hover:underline">
        Not financial advice
      </Link>
    </p>
  );
}
