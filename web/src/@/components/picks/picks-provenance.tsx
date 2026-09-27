import Link from "next/link";

import { formatCount, formatIsoDate } from "~/@/lib/strategies/format";

/**
 * Where the numbers come from, as one line: price date, fundamentals
 * coverage, the ASIC lag and the disclaimer. Props-only and server-safe.
 * Provenance is part of the composition on this site, not a footnote, so the
 * line sits directly under the H1.
 */
export function PicksProvenance({
  asOf,
  coverage,
  universe,
}: {
  /** YYYY-MM-DD of the latest price; "" when unknown. */
  asOf: string;
  coverage: number;
  universe: number;
}) {
  const priceDate = formatIsoDate(asOf);
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
        <>
          fundamentals for{" "}
          <span className="tabular-nums">{formatCount(coverage)}</span> of{" "}
          <span className="tabular-nums">{formatCount(universe)}</span> stocks
          {" · "}
        </>
      ) : null}
      ASIC shorts T+4
      {" · "}
      <Link href="/disclaimer" className="font-medium text-foreground hover:underline">
        Not financial advice
      </Link>
    </p>
  );
}
