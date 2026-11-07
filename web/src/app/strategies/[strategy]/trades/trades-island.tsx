"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState, useTransition, type FormEvent } from "react";

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
  type TradesFilterError,
} from "~/app/actions/strategies/backtestTrades";

export interface TradesIslandProps {
  runId: number;
  /** The exit reasons the run took, for the filter. */
  exitReasons: readonly string[];
}

/** The filters the page is drawn with. Only Apply changes them; typing does not (applied, not live). */
interface Applied {
  stockCode: string;
  exitReason: string;
}

const FILTER_MESSAGE: Record<TradesFilterError, string> = {
  stock: "Enter a stock code of one to six letters or digits, such as BHP.",
  reason: "Choose an exit from the list.",
  token: "That page of trades could not be read. Apply the filters again.",
};

/** The sign-in link returns the reader to this page (callbackUrl). */
export function signInHref(pathname: string | null): string {
  const target = pathname && pathname.startsWith("/") ? pathname : "/";
  return `/signin?callbackUrl=${encodeURIComponent(target)}`;
}

/**
 * The trade list for signed-in readers (2.2). It shows nothing while the session loads, the
 * sign-in prompt to a signed-out reader (or whenever the server says the caller is signed
 * out), and the paged list otherwise. The list is drawn with the APPLIED filters only.
 */
export function TradesIsland({ runId, exitReasons }: TradesIslandProps) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && Boolean(session?.user?.id);
  const [draftStock, setDraftStock] = useState("");
  const [draftReason, setDraftReason] = useState("");
  const [applied, setApplied] = useState<Applied>({ stockCode: "", exitReason: "" });
  const [rows, setRows] = useState<BacktestTradeView[]>([]);
  const [total, setTotal] = useState(0);
  const [nextToken, setNextToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [serverSignedOut, setServerSignedOut] = useState(false);
  const [failure, setFailure] = useState<"unavailable" | TradesFilterError | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = (result: BacktestTradesResult, append: boolean) => {
    if (result.ok) {
      setFailure(null);
      setServerSignedOut(false);
      setLoaded(true);
      const page: BacktestTradesPageView = result.page;
      setRows((prev) => (append ? [...prev, ...page.trades] : page.trades));
      setTotal(page.total);
      setNextToken(page.nextPageToken);
      return;
    }
    if (result.reason === "signed-out") {
      setServerSignedOut(true);
      return;
    }
    if (result.reason === "invalid") {
      setFailure(result.error);
      return;
    }
    setFailure("unavailable");
  };

  const load = (filters: Applied, pageToken: string, append: boolean) => {
    startTransition(async () => {
      apply(
        await listBacktestTrades({
          runId,
          pageToken,
          pageSize: 50,
          stockCode: filters.stockCode,
          exitReason: filters.exitReason,
        }),
        append,
      );
    });
  };

  // The first page loads once the session says the reader is signed in: never while it loads.
  useEffect(() => {
    if (signedIn && !loaded && !pending) load(applied, "", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first page loads once per sign-in.
  }, [signedIn]);

  if (status === "loading") {
    return <div role="status" aria-busy="true" aria-label="Checking your sign-in" className="h-24 animate-pulse rounded-lg bg-muted/40" />;
  }

  if (!signedIn || serverSignedOut) {
    return (
      <section aria-labelledby="trades-list-heading" className="space-y-3 rounded-lg border border-border/60 bg-card p-5">
        <h2 id="trades-list-heading" className={sectionTitle}>Every trade</h2>
        <p className="text-sm text-muted-foreground">{TRADES_SIGN_IN_COPY}</p>
        <Link href={signInHref(pathname)} prefetch={false} className="text-sm font-medium text-primary hover:underline">
          Sign in
        </Link>
      </section>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Applied = { stockCode: draftStock.trim().toUpperCase(), exitReason: draftReason };
    if (next.stockCode !== "" && !/^[A-Z0-9]{1,6}$/.test(next.stockCode)) {
      setFailure("stock");
      return;
    }
    setApplied(next);
    setFailure(null);
    load(next, "", false);
  };

  return (
    <section aria-labelledby="trades-list-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="trades-list-heading" className={sectionTitle}>Every trade</h2>
        <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Stock
            <input
              value={draftStock}
              onChange={(e) => setDraftStock(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. BHP"
              className="w-24 rounded-sm border border-border/70 bg-background px-2 py-1 font-mono text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Exit
            <select
              value={draftReason}
              onChange={(e) => setDraftReason(e.target.value)}
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
          <button type="submit" aria-busy={pending || undefined} className="rounded-sm border border-border/70 px-3 py-1 text-sm hover:bg-muted/40">
            Apply
          </button>
        </form>
      </div>

      {failure ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {failure === "unavailable" ? "The trades are unavailable right now. Try again shortly." : FILTER_MESSAGE[failure]}
        </p>
      ) : null}

      {loaded && rows.length === 0 && !failure ? (
        <p className="text-sm text-muted-foreground">
          {applied.stockCode || applied.exitReason ? "No trades match these filters." : "This run has no closed trades."}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div
          role="region"
          aria-label="Trades of this run"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll region needs focus for arrow-key scrolling.
          tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <table className="w-full min-w-[820px] border-collapse text-xs">
            <caption className="sr-only">
              Trades of this run: {rows.length} of {total}
              {applied.stockCode ? `, stock ${applied.stockCode}` : ""}
              {applied.exitReason ? `, exit ${exitReasonLabel(applied.exitReason)}` : ""}
            </caption>
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
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Gross return</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Net return</th>
                <th scope="col" className="py-1.5 font-normal">Flags</th>
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
                  <td className="py-1.5 pr-3 text-right">{trade.grossReturnPct === null ? NOT_AVAILABLE : formatSigned(trade.grossReturnPct, "%")}</td>
                  <td className="py-1.5 pr-3 text-right">{trade.netReturnPct === null ? NOT_AVAILABLE : formatSigned(trade.netReturnPct, "%")}</td>
                  <td className="py-1.5 font-sans text-[11px] text-muted-foreground">{trade.flags.length > 0 ? trade.flags.join(", ").replace(/_/g, " ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {nextToken ? (
        <button
          type="button"
          aria-busy={pending || undefined}
          onClick={() => (pending ? undefined : load(applied, nextToken, true))}
          className="rounded-sm border border-border/70 px-3 py-1.5 text-sm hover:bg-muted/40"
        >
          Show more trades
        </button>
      ) : null}
    </section>
  );
}
