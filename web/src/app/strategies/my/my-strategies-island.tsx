"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/@/components/ui/button";
import type { StatusCountsView } from "~/@/lib/strategies/types";
import {
  listSavedStrategies,
  unsaveStrategy,
  type SavedStrategyView,
} from "~/app/actions/strategies/saved";

/** The copy for a full list, from the API's limit. */
const LIMIT_NOTE = (saved: number, limit: number) =>
  `${saved} of ${limit} saved`;

const SIGN_IN_HREF = `/signin?callbackUrl=${encodeURIComponent("/strategies/my")}`;

type ListState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; strategies: SavedStrategyView[]; limit: number };

/**
 * The My strategies list. It reads the signed-in viewer's saves once the session is
 * known, and draws one of: a loading region, a sign-in prompt for an anonymous
 * visitor, a retryable unavailable note, an empty list, or the saves with today's
 * counts. A save is removed from the screen only after the API has removed it.
 */
export function MyStrategiesIsland() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && !!session?.user?.id;

  if (status === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label="Loading your strategies" className="text-sm text-muted-foreground">
        Loading your strategies…
      </div>
    );
  }
  if (!signedIn) {
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-base font-semibold">Sign in to see your strategies</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Save a strategy from its Signals tab and it appears here, with today&apos;s counts.
        </p>
        <Link
          href={SIGN_IN_HREF}
          prefetch={false}
          className="mt-3 inline-block text-sm font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          Sign in
        </Link>
      </section>
    );
  }
  return <SavedList />;
}

function SavedList() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    // A rejected action (a network failure, or a deploy that retired it) is the
    // same as an unavailable read: the retry state, never a stuck loading line.
    listSavedStrategies()
      .then((result) => {
        setState(
          result.ok
            ? { kind: "ready", strategies: result.strategies, limit: result.limit }
            : { kind: "unavailable" },
        );
      })
      .catch(() => setState({ kind: "unavailable" }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (ref: string) => {
    setRemoving(ref);
    setFailed(false);
    try {
      const result = await unsaveStrategy(ref);
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setState((prev) =>
        prev.kind === "ready"
          ? { ...prev, strategies: prev.strategies.filter((s) => s.strategyRef !== ref) }
          : prev,
      );
    } catch {
      setFailed(true);
    } finally {
      setRemoving(null);
    }
  };

  if (state.kind === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label="Loading your strategies" className="text-sm text-muted-foreground">
        Loading your strategies…
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <section className="rounded-lg border border-border p-5">
        <p className="text-sm">We could not load your saved strategies.</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={load}>
          Try again
        </Button>
      </section>
    );
  }
  if (state.strategies.length === 0) {
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-base font-semibold">No saved strategies yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a strategy and choose Save to keep it here.
        </p>
        <Link href="/strategies" prefetch={false} className="mt-3 inline-block text-sm font-medium underline underline-offset-2">
          Browse strategies
        </Link>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{LIMIT_NOTE(state.strategies.length, state.limit)}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {state.strategies.map((s) => (
          <li key={s.strategyRef} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              {s.strategyId ? (
                <Link
                  href={`/strategies/${s.strategyId}/signals`}
                  prefetch={false}
                  className="font-medium underline underline-offset-2"
                >
                  {s.name || s.strategyId}
                </Link>
              ) : (
                <span className="font-medium">Variant</span>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">
                Saved {formatSaved(s.savedAt)}
                {s.counts ? ` · ${countsLine(s.counts)}` : ""}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={removing !== null}
              onClick={() => void remove(s.strategyRef)}
              aria-label={`Remove ${s.name || "this strategy"} from My strategies`}
            >
              {removing === s.strategyRef ? "Removing…" : "Remove"}
            </Button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="status" className="text-xs text-muted-foreground">
          Could not remove that strategy. Try again.
        </p>
      ) : null}
    </section>
  );
}

/** "2 triggered · 1 setup · 9 watch": the three statuses a strategy's list carries. */
export function countsLine(counts: StatusCountsView): string {
  return `${counts.triggered} triggered · ${counts.setup} setup · ${counts.watch} watch`;
}

function formatSaved(savedAt: string): string {
  const when = new Date(savedAt);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}
