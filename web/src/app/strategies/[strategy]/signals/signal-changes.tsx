"use client";

// The signed-in viewer's status changes for a strategy, newest first: the
// Signals tab's "Recent changes" and, for one stock, the evidence panel's
// "This stock's signal history". Only a signed-in viewer's read reaches the API
// (getSignalEventsForViewer, per request); an anonymous visitor sees the sign-in
// row and no call is made. The first page is read when the list mounts, and
// "Show more" reads the next one, appended in order. A server that finds no
// session answers the sign-in row too, never an outage.

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import { cn } from "~/@/lib/utils";
import { formatIsoDate } from "~/@/lib/strategies/format";
import type { StrategySignalEventView } from "~/@/lib/strategies/types";
import {
  getSignalEventsForViewer,
  type SignalEventsResult,
} from "~/app/actions/strategies/signalEvents";

/** Rows per page: this list's own page size (the API's default is 50). */
const PAGE = 20;

export interface SignalChangesProps {
  /** The strategy's id, e.g. "canslim". */
  strategyId: string;
  /** Set for one stock's history; omitted for the strategy's recent changes. */
  stockCode?: string;
  /**
   * The rules version the matrix shows (its 64-hex hash). The history is read
   * under that version so the two agree; omitted reads the live version.
   */
  versionHash?: string;
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
  | { phase: "signed-out" }
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
  versionHash,
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
      className={cn(
        "space-y-3",
        compact ? "" : "rounded-lg border border-border/60 bg-card p-4",
      )}
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
        // The same box as the sign-in row, so the slot keeps its height.
        <p
          role="status"
          aria-busy="true"
          className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
        >
          Checking your session…
        </p>
      ) : !signedIn ? (
        <SignInRow returnPath={returnPath} />
      ) : (
        <SignedInHistory
          strategyId={strategyId}
          stockCode={stockCode}
          versionHash={versionHash}
          emptyCopy={emptyCopy}
          returnPath={returnPath}
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
  versionHash,
  emptyCopy,
  returnPath,
  compact,
}: {
  strategyId: string;
  stockCode?: string;
  versionHash?: string;
  emptyCopy: string;
  returnPath: string;
  compact: boolean;
}) {
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    // The read starts one task later. Next runs server actions one at a time,
    // and the island's own reads (the first page, the selected stock's fit) are
    // queued by its effects, which run after these children's: deferring keeps
    // them ahead of this history.
    setState({ phase: "loading" });
    const timer = setTimeout(() => {
      getSignalEventsForViewer({
        strategyId,
        stockCode,
        versionHash,
        pageSize: PAGE,
      })
        .then((result) => {
          if (live) setState(toListState(result));
        })
        .catch(() => {
          if (live) setState({ phase: "failed" });
        });
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [strategyId, stockCode, versionHash, attempt]);

  if (state.phase === "signed-out") {
    return <SignInRow returnPath={returnPath} />;
  }
  if (state.phase === "loading") {
    return (
      <p
        role="status"
        aria-busy="true"
        className="text-xs text-muted-foreground"
      >
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
    // aria-disabled, not disabled: a disabled button drops focus to the body.
    if (loadingMore) return;
    setLoadingMore(true);
    const result = await getSignalEventsForViewer({
      strategyId,
      stockCode,
      versionHash,
      pageToken: token,
      pageSize: PAGE,
    }).catch((): SignalEventsResult => ({ ok: false, reason: "unavailable" }));
    setLoadingMore(false);
    setState((current) => {
      if (current.phase !== "ready") return current;
      if (!result.ok) {
        return result.reason === "signed-out"
          ? { phase: "signed-out" }
          : { ...current, moreFailed: true };
      }
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
            <time
              dateTime={event.sessionDate}
              className="tabular-nums text-muted-foreground"
            >
              {formatIsoDate(event.sessionDate) || event.sessionDate}
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
          aria-disabled={loadingMore}
          onClick={() => void showMore(state.nextPageToken)}
          className={cn(
            "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/50",
            loadingMore && "opacity-60",
          )}
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
  if (!result.ok) {
    return result.reason === "signed-out"
      ? { phase: "signed-out" }
      : { phase: "failed" };
  }
  return {
    phase: "ready",
    events: result.page.events,
    nextPageToken: result.page.nextPageToken,
    moreFailed: false,
  };
}
