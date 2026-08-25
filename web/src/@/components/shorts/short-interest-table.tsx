import Link from "next/link";

/**
 * The screener-shaped short-interest table.
 *
 * Extracted verbatim from /scans/[slug] so /themes/[slug] renders the SAME
 * columns, formatting and responsive breakpoints — the two pages are different
 * cuts of one screener result set and had no business drifting apart. A plain
 * server component: rows arrive pre-fetched, every cell is text, and it ships
 * in the ISR HTML where crawlers read it.
 */
export interface ShortInterestRow {
  code: string;
  name: string;
  industry: string;
  shortPct: number;
  shortPctChange4w: number;
  latestPrice: number;
  priceChange1m: number;
  daysToCover: number;
}

export function formatPrice(v: number): string {
  if (v <= 0) return "—";
  return v >= 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(3).replace(/0$/, "")}`;
}

export function DeltaCell({
  value,
  suffix,
}: {
  value: number;
  suffix: string;
}) {
  if (!Number.isFinite(value) || value === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={
        value > 0 ? "font-medium text-red-500" : "font-medium text-emerald-500"
      }
    >
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}
      {suffix}
    </span>
  );
}

export function ShortInterestTable({
  rows,
  caption,
}: {
  rows: ShortInterestRow[];
  /** Screen-reader caption — the surface's own H1 text. */
  caption: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Code</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">
              Company
            </th>
            <th className="hidden px-3 py-2 font-medium md:table-cell">
              Industry
            </th>
            <th className="px-3 py-2 text-right font-medium">Short %</th>
            <th className="px-3 py-2 text-right font-medium">Δ 4w</th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
              Price
            </th>
            <th className="px-3 py-2 text-right font-medium">Δ 1m</th>
            <th className="px-3 py-2 text-right font-medium">Days to cover</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.code}>
              <td className="px-3 py-2 font-semibold">
                <Link
                  href={`/shorts/${r.code}`}
                  className="text-primary hover:underline"
                >
                  {r.code}
                </Link>
              </td>
              <td className="hidden max-w-[220px] truncate px-3 py-2 text-muted-foreground sm:table-cell">
                {r.name}
              </td>
              <td className="hidden max-w-[180px] truncate px-3 py-2 text-muted-foreground md:table-cell">
                {r.industry}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.shortPct.toFixed(2)}%
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                <DeltaCell value={r.shortPctChange4w} suffix="pp" />
              </td>
              <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                {formatPrice(r.latestPrice)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                <DeltaCell value={r.priceChange1m} suffix="%" />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.daysToCover > 0 ? r.daysToCover.toFixed(1) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
