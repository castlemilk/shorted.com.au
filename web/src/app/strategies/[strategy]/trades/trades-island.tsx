"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState, useTransition } from "react";

import { TRADES_SIGN_IN_COPY, shortDate } from "~/@/lib/strategies/backtest-copy";
import { exitReasonLabel } from "~/@/components/strategies/trades-summary";
import { NOT_AVAILABLE, formatSigned } from "~/@/lib/strategies/format";
import type {
  BacktestTradeView,
  BacktestTradesPageView,
} from "~/@/lib/strategies/map-backtest";
import { sectionTitle } from "~/@/lib/typography";
import {
  listBacktestTrades,
  type BacktestTradesResult,
} from "~/app/actions/strategies/backtestTrades";

export interface TradesIslandProps {
  runId: number;
  /** The exit reasons the run took, for the filter. */
  exitReasons: readonly string[];
}

/**
 * The trade list for signed-in readers (2.2): paged, filtered by stock and exit
 * reason. An anonymous visitor sees the sign-in line in place of the list; the
 * summary above it is public and already rendered on the server.
 */
export function TradesIsland({ runId, exitReasons }: TradesIslandProps) {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && Boolean(session?.user?.id);
  const [stock, setStock] = useState("");
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<BacktestTradeView[]>([]);
  const [total, setTotal] = useState(0);
  const [nextToken, setNextToken] = useState("");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(false);

  const apply = (result: BacktestTradesResult, append: boolean) => {
    if (!result.ok) {
      setError(result.reason !== "signed-out");
      return;
    }
    setError(false);
    setLoaded(true);
    const page: BacktestTradesPageView = result.page;
    setRows((prev) => (append ? [...prev, ...page.trades] : page.trades));
    setTotal(page.total);
    setNextToken(page.nextPageToken);
  };

  const load = (pageToken: string, append: boolean) => {
    startTransition(async () => {
      apply(
        await listBacktestTrades({
          runId,
          pageToken,
          pageSize: 50,
          stockCode: stock,
          exitReason: reason,
        }),
        append,
      );
    });
  };

  // A signed-in reader gets the first page at mount; the filters ask again on Apply.
  useEffect(() => {
    if (signedIn && !loaded) load("", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first page loads once per sign-in.
  }, [signedIn]);

  if (!signedIn) {
    return (
      <section aria-labelledby="trades-list-heading" className="space-y-3 rounded-lg border border-border/60 bg-card p-5">
        <h2 id="trades-list-heading" className={sectionTitle}>Every trade</h2>
        <p className="text-sm text-muted-foreground">{TRADES_SIGN_IN_COPY}</p>
        <Link href="/signin" prefetch={false} className="text-sm font-medium text-primary hover:underline">
          Sign in
        </Link>
      </section>
    );
  }

  return (
    <section aria-labelledby="trades-list-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="trades-list-heading" className={sectionTitle}>Every trade</h2>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            load("", false);
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Stock
            <input
              value={stock}
              onChange={(e) => setStock(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. BHP"
              className="w-24 rounded-sm border border-border/70 bg-background px-2 py-1 font-mono text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Exit
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-sm border border-border/70 bg-background px-2 py-1 text-foreground"
            >
              <option value="">Any exit</option>
              {exitReasons.map((r) => (
                <option key={r} value={r}>
                  {exitReasonLabel(r)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending} className="rounded-sm border border-border/70 px-3 py-1 text-sm hover:bg-muted/40">
            Apply
          </button>
        </form>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-muted-foreground">The trades are unavailable right now. Try again shortly.</p>
      ) : null}

      {loaded && rows.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No trades match these filters.</p>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <caption className="sr-only">Trades of this run, {rows.length} of {total}</caption>
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-normal">#</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Stock</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Signal</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Entry</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Price</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Exit</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Price</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Held</th>
                <th scope="col" className="py-1.5 text-right font-normal">Net return</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((trade) => (
                <tr key={`${trade.seq}-${trade.stockCode}`} className="border-b border-border/40 align-top font-mono tabular-nums">
                  <td className="py-1.5 pr-3">{trade.seq}</td>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{trade.stockCode}</span>
                    <span className="block font-sans text-[11px] text-muted-foreground">{trade.companyName}</span>
                  </td>
                  <td className="py-1.5 pr-3">{shortDate(trade.signalDate) || NOT_AVAILABLE}</td>
                  <td className="py-1.5 pr-3">{shortDate(trade.entryDate) || NOT_AVAILABLE}</td>
                  <td className="py-1.5 pr-3 text-right">{trade.entryPrice === null ? NOT_AVAILABLE : trade.entryPrice.toFixed(2)}</td>
                  <td className="py-1.5 pr-3">
                    {trade.open ? "Open" : shortDate(trade.exitDate) || NOT_AVAILABLE}
                    <span className="block font-sans text-[11px] text-muted-foreground">{exitReasonLabel(trade.exitReason)}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right">{trade.exitPrice === null ? NOT_AVAILABLE : trade.exitPrice.toFixed(2)}</td>
                  <td className="py-1.5 pr-3 text-right">{trade.sessionsHeld}</td>
                  <td className="py-1.5 text-right">{trade.netReturnPct === null ? NOT_AVAILABLE : formatSigned(trade.netReturnPct, "%")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {nextToken ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => load(nextToken, true)}
          className="rounded-sm border border-border/70 px-3 py-1.5 text-sm hover:bg-muted/40"
        >
          Show more trades
        </button>
      ) : null}
    </section>
  );
}
