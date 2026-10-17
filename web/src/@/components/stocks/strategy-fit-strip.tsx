import Link from "next/link";
import { Crosshair } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { StatusPill } from "~/@/components/picks/picks-table";
import { formatDate } from "~/@/lib/fundamentals/format";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import type {
  StockStrategyFit,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

// The Overview's one-line-per-strategy digest. The full reading (rules,
// evidence, the levels chart) lives on the Strategy tab; this strip exists so
// the most-visited page still carries the crawlable status and the links.
// Props-only, so it imports nothing from protobuf or connect.

export const NOT_A_CANDIDATE = "Not a candidate";

/**
 * One strategy's reading of a stock on a single line: the status pill (or
 * "Not a candidate"), "Score N" and "rank N of M". A non-candidate never shows
 * a score or rank, and a figure the data does not have is left out, never
 * printed as 0. The strip's rows render it; it is exported so the Strategy
 * tab's panel headers can show the same line.
 */
export function FitStatusLine({ fit }: { fit: StockStrategyFitRow }) {
  // Destructured so that `candidate` narrows `status` for StatusPill, which
  // takes a PickStatus and has no "none": TypeScript follows an aliased
  // condition only for a const or a readonly property, and fit.status is
  // neither.
  const { status, score, rank, totalCount } = fit;
  const candidate = status !== "none";
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {candidate ? (
        <StatusPill status={status} />
      ) : (
        <span className="inline-flex items-center rounded-sm border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em]">
          {NOT_A_CANDIDATE}
        </span>
      )}
      {candidate && score !== null ? (
        <span className="tabular-nums">
          Score <span className="text-foreground">{Math.round(score)}</span>
        </span>
      ) : null}
      {candidate && rank !== null ? (
        <span className="tabular-nums">
          rank {rank}
          {totalCount !== null ? ` of ${totalCount}` : ""}
        </span>
      ) : null}
    </span>
  );
}

function Row({ fit }: { fit: StockStrategyFitRow }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
      <Link
        href={`/picks/${fit.strategyId}`}
        prefetch={false}
        className="font-medium text-primary hover:underline"
      >
        {fit.strategyName}
      </Link>
      <FitStatusLine fit={fit} />
    </li>
  );
}

export function StrategyFitStrip({ fit }: { fit: StockStrategyFit }) {
  if (fit.fits.length === 0) return null;
  const pricesTo = formatDate(fit.asOf);
  return (
    <Card role="region" aria-labelledby="strategy-fit-heading">
      <CardHeader className="pb-2">
        <CardTitle
          id="strategy-fit-heading"
          className="flex items-center gap-2 text-lg"
        >
          <Crosshair className="h-5 w-5" aria-hidden />
          Strategy fit
        </CardTitle>
        <CardDescription className="text-xs">
          How each stock picker strategy reads {fit.stockCode} today
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y">
          {fit.fits.map((row) => (
            <Row key={row.strategyId} fit={row} />
          ))}
        </ul>
        <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {pricesTo ? `Prices to ${pricesTo} · ` : ""}Mechanical readings of
            published rules, not recommendations ·{" "}
            <Link
              href="/disclaimer"
              prefetch={false}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Not financial advice
            </Link>
          </span>
          <Link
            href={stockTabHref(fit.stockCode, "strategy")}
            prefetch={false}
            className="text-xs text-primary hover:underline"
          >
            Full strategy readings →
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
