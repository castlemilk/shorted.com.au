"use client";

// The signed-in viewer's status changes for a strategy, newest first: the
// Signals tab's "Recent changes" and, for one stock, the evidence panel's
// "This stock's signal history". Only a signed-in viewer's read reaches the API
// (getSignalEventsForViewer, per request); an anonymous visitor sees the sign-in
// row and no call is made. The first page is read when the list mounts, and
// "Show more" reads the next one, appended in order.

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import { cn } from "~/@/lib/utils";
import { formatDate } from "~/@/lib/fundamentals/format";
import type { StrategySignalEventView } from "~/@/lib/strategies/types";
import {
  getSignalEventsForViewer,
  type SignalEventsResult,
} from "~/app/actions/strategies/signalEvents";

/** Rows per page; the API's default. */
const PAGE = 20;

export interface SignalChangesProps {
  /** The strategy's id, e.g. "canslim". */
  strategyId: string;
  /** Set for one stock's history; omitted for the strategy's recent changes. */
  stockCode?: string;
  /** The heading. */
  title: string;
  /** The sign-in row's return path is the strategy's Signals tab. */
  returnPath: string;
  /** Printed when the read answers with no change at all. */
  emptyCopy: string;
  /** A tighter layout for the evidence panel. */
  compact?: boolean;
}

type ListState =
  | { phase: "loading" }
  | { phase: "failed" }
  | {
      phase: "ready";
      events: StrategySignalEventView[];
      nextPageToken: string;
      moreFailed: boolean;
    };

/** A status word the reader can scan; never a colour. */
export function statusWord(status: string): string {
  switch (status) {
    case "triggered":
      return "Triggered";
    case "setup":
      return "Setup";
    case "watch":
      return "Watch";
    case "unknown":
      return "Unknown";
    case "none":
      return "Off the list";
    default:
      return status || "n/a";
  }
}

export function SignalChanges({
  strategyId,
  stockCode,
  title,
  returnPath,
  emptyCopy,
  compact = false,
}: SignalChangesProps) {
  const { status } = useSession();
  const signedIn = status === "authenticated";
  const pending = status === "loading";

  return (
    <section
      aria-labelledby={`changes-${stockCode ?? "strategy"}`}
      className={cn("space-y-3", compact ? "" : "rounded-lg border border-border/60 bg-card p-4")}
      data-signal-changes={stockCode ?? strategyId}
    >
      {/* A sibling of the matrix (h2) on the tab, and a subsection of the evidence panel (h3 there, so h4). */}
      {compact ? (
        <h4
          id={`changes-${stockCode ?? "strategy"}`}
          className="text-sm font-semibold"
        >
          {title}
        </h4>
      ) : (
        <h2
          id={`changes-${stockCode ?? "strategy"}`}
          className="text-sm font-semibold"
        >
          {title}
        </h2>
      )}
      {pending ? (
        <p role="status" aria-busy="true" className="text-xs text-muted-foreground">
          Checking your session…
        </p>
      ) : !signedIn ? (
        <SignInRow returnPath={returnPath} />
      ) : (
        <SignedInHistory
          strategyId={strategyId}
          stockCode={stockCode}
          emptyCopy={emptyCopy}
          compact={compact}
        />
      )}
    </section>
  );
}

function SignInRow({ returnPath }: { returnPath: string }) {
  return (
    <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Link
        href={`/signin?callbackUrl=${encodeURIComponent(returnPath)}`}
        prefetch={false}
        className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
      >
        Sign in
      </Link>{" "}
      to see when stocks moved between statuses, kept for three years.
    </p>
  );
}

function SignedInHistory({
  strategyId,
  stockCode,
  emptyCopy,
  compact,
}: {
  strategyId: string;
  stockCode?: string;
  emptyCopy: string;
  compact: boolean;
}) {
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    getSignalEventsForViewer({
      strategyId,
      stockCode,
      pageSize: PAGE,
    })
      .then((result) => {
        if (live) setState(toListState(result));
      })
      .catch(() => {
        if (live) setState({ phase: "failed" });
      });
    return () => {
      live = false;
    };
  }, [strategyId, stockCode, attempt]);

  if (state.phase === "loading") {
    return (
      <p role="status" aria-busy="true" className="text-xs text-muted-foreground">
        Loading the status changes…
      </p>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>The status changes are unavailable right now.</p>
        <button
          type="button"
          onClick={() => setAttempt((count) => count + 1)}
          className="rounded-md border border-border px-2.5 py-1 font-medium text-foreground hover:bg-muted/50"
        >
          Try again
        </button>
      </div>
    );
  }
  if (state.events.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyCopy}</p>;
  }

  async function showMore(token: string) {
    setLoadingMore(true);
    const result = await getSignalEventsForViewer({
      strategyId,
      stockCode,
      pageToken: token,
      pageSize: PAGE,
    }).catch((): SignalEventsResult => ({ ok: false, reason: "unavailable" }));
    setLoadingMore(false);
    setState((current) => {
      if (current.phase !== "ready") return current;
      if (!result.ok) return { ...current, moreFailed: true };
      return {
        phase: "ready",
        events: [...current.events, ...result.page.events],
        nextPageToken: result.page.nextPageToken,
        moreFailed: false,
      };
    });
  }

  return (
    <div className="space-y-2">
      <ol className={cn("divide-y text-xs", compact ? "" : "text-sm")}>
        {state.events.map((event, index) => (
          <li
            key={`${event.stockCode}-${event.sessionDate}-${event.toStatus}-${index}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2"
          >
            <time dateTime={event.sessionDate} className="tabular-nums text-muted-foreground">
              {formatDate(event.sessionDate) || event.sessionDate}
            </time>
            {stockCode ? null : (
              <span className="font-mono font-medium">{event.stockCode}</span>
            )}
            <span>
              {statusWord(event.fromStatus)} to {statusWord(event.toStatus)}
            </span>
          </li>
        ))}
      </ol>
      {state.nextPageToken ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void showMore(state.nextPageToken)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-60"
        >
          {loadingMore ? "Loading…" : "Show more changes"}
        </button>
      ) : null}
      {state.moreFailed ? (
        <p className="text-xs text-muted-foreground">
          The next page is unavailable right now.
        </p>
      ) : null}
    </div>
  );
}

function toListState(result: SignalEventsResult): ListState {
  if (!result.ok) return { phase: "failed" };
  return {
    phase: "ready",
    events: result.page.events,
    nextPageToken: result.page.nextPageToken,
    moreFailed: false,
  };
}
