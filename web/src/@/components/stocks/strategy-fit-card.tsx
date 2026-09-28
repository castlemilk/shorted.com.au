import Link from "next/link";
import { Crosshair } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { RuleDots, RuleLegend, StatusPill } from "~/@/components/picks/picks-table";
import { formatDate } from "~/@/lib/fundamentals/format";
import type {
  StockStrategyFit,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

// Strategy fit (docs/plans/fundamentals-coverage.md §7.1, Overview). How each
// picker strategy reads this stock today, server-rendered with crawlable
// links to /picks/<id>: the status pill (or "Not a candidate"), the score,
// "rank N of M" and the rule dots with their legend. Props-only; the page
// renders it only when getStockStrategyFit resolved.

export const NOT_A_CANDIDATE = "Not a candidate";

function NotACandidatePill() {
  return (
    <span className="inline-flex items-center rounded-sm border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em] text-muted-foreground">
      {NOT_A_CANDIDATE}
    </span>
  );
}

function FitRow({ fit }: { fit: StockStrategyFitRow }) {
  const candidate = fit.status !== "none";
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <Link
          href={`/picks/${fit.strategyId}`}
          prefetch={false}
          className="font-medium text-primary hover:underline"
        >
          {fit.strategyName}
        </Link>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {fit.status === "none" ? <NotACandidatePill /> : <StatusPill status={fit.status} />}
          {candidate && fit.score !== null ? (
            <span className="tabular-nums">
              Score <span className="text-foreground">{Math.round(fit.score)}</span>
            </span>
          ) : null}
          {candidate && fit.rank !== null ? (
            <span className="tabular-nums">
              rank {fit.rank}
              {fit.totalCount !== null ? ` of ${fit.totalCount}` : ""}
            </span>
          ) : null}
        </p>
      </div>
      {fit.rules.length > 0 ? (
        <RuleDots rules={fit.ruleColumns} results={fit.rules} />
      ) : null}
    </li>
  );
}

export interface StrategyFitCardProps {
  fit: StockStrategyFit;
}

export function StrategyFitCard({ fit }: StrategyFitCardProps) {
  if (fit.fits.length === 0) return null;
  const pricesTo = formatDate(fit.asOf);
  return (
    <Card role="region" aria-labelledby="strategy-fit-heading">
      <CardHeader className="pb-3">
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
      <CardContent className="space-y-3">
        <RuleLegend rules={[]} />
        <ul className="divide-y">
          {fit.fits.map((row) => (
            <FitRow key={row.strategyId} fit={row} />
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          {pricesTo ? `Prices to ${pricesTo} · ` : ""}Mechanical readings of
          published rules, not recommendations ·{" "}
          <Link
            href="/disclaimer"
            prefetch={false}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Not financial advice
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
