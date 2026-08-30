import Link from "next/link";

import { suburbHref, titleCaseName } from "~/@/lib/housing/states";
import type {
  RankedSuburb,
  RankingMetric,
} from "~/@/lib/housing-rankings/rank";

const aud = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("en-AU", {
  maximumFractionDigits: 0,
});

export function formatHousingMoney(value: number): string {
  return Number.isFinite(value) && value > 0
    ? aud.format(Math.round(value))
    : "—";
}

export function formatHousingPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function GrowthCell({ value }: { value: number }) {
  const colour =
    value > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : value < 0
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  return <span className={colour}>{formatHousingPercent(value)}</span>;
}

/** Server-rendered suburb ranking table; every cell ships in the ISR HTML. */
export function HousingRankingTable({
  rows,
  caption,
  metric,
}: {
  rows: RankedSuburb[];
  caption: string;
  metric: RankingMetric;
}) {
  const showAffordability = metric === "affordability";
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="w-12 px-3 py-2 text-right font-medium">
              Rank
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Suburb
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 font-medium sm:table-cell"
            >
              Postcode
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Median price
            </th>
            {showAffordability ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Price / income
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 text-right font-medium">
              YoY
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-right font-medium md:table-cell"
            >
              Population
            </th>
            <th
              scope="col"
              className="hidden px-3 py-2 text-right font-medium lg:table-cell"
            >
              Income / wk
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, index) => (
            <tr key={row.salCode}>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </td>
              <th scope="row" className="px-3 py-2 text-left font-semibold">
                <Link
                  href={suburbHref(row.stateCode, row)}
                  className="text-primary hover:underline"
                >
                  {titleCaseName(row.salName)}
                </Link>
              </th>
              <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                {row.postcode || "—"}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatHousingMoney(row.latestMedianPrice)}
              </td>
              {showAffordability ? (
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {row.affordabilityRatio?.toFixed(1)}×
                </td>
              ) : null}
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                <GrowthCell value={row.yoyPct} />
              </td>
              <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                {integer.format(Math.round(row.population))}
              </td>
              <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground lg:table-cell">
                {formatHousingMoney(row.medianWeeklyHhdIncome)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
