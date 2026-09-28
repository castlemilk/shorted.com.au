"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  PicksFilterView,
  type PicksFilterViewProps,
} from "~/@/components/picks/picks-filter-view";
import { parsePickStatus } from "~/@/lib/strategies/shortlist";
import {
  parsePickSort,
  type PickSortKey,
  type SortedPicks,
} from "~/@/lib/strategies/sort";
import type { PickStatus } from "~/@/lib/strategies/types";

/**
 * The client island behind `?status=` and `?sort=` on /picks/[strategy]
 * (docs/plans/fundamentals-coverage.md §7.2).
 *
 * It reads the query string with useSearchParams, which suspends on a static
 * page, so the page MUST mount it under a real <Suspense> boundary whose
 * fallback is <PicksFilterView status={null}>: that fallback is what lands in
 * the ISR HTML. Reading searchParams in the server page instead would
 * silently force the route dynamic and throw the ISR away.
 *
 * With no sort (or ?sort=score) it filters the server's rows as the page
 * always did, with no request. With a sort it asks the API for the top 100
 * within the status, sorted: a plain JSON POST through the same-origin
 * rewrite, from a module loaded on first use (no ~/gen, no @connectrpc in the
 * browser). While it loads, the server rows stay on screen, dimmed and
 * aria-busy; on a non-200 or after SORT_TIMEOUT_MS they stay, with "Sorting is
 * unavailable right now".
 */

/** Give up on a sort after this long and keep the rank order. */
export const SORT_TIMEOUT_MS = 10_000;

export interface PicksSortedViewProps
  extends Omit<
    PicksFilterViewProps,
    "status" | "sort" | "sorted" | "sortPhase" | "onSortIntent"
  > {
  /** StrategyService strategy_id, e.g. "quality-compounders". */
  strategyId: string;
}

type SortState =
  | { key: string; phase: "loading" }
  | { key: string; phase: "error" }
  | { key: string; phase: "ready"; sorted: SortedPicks };

function requestKey(
  strategyId: string,
  sort: PickSortKey,
  status: PickStatus | null,
) {
  return `${strategyId}|${sort}|${status ?? ""}`;
}

/** The fetch code, loaded once, on first use. */
function loadSortFetch() {
  return import("./picks-sort-fetch");
}

export function PicksSortedView({
  strategyId,
  ...props
}: PicksSortedViewProps) {
  const searchParams = useSearchParams();
  const status = parsePickStatus(searchParams?.get("status"));
  const sort = parsePickSort(searchParams?.get("sort"));
  const key = sort ? requestKey(strategyId, sort, status) : "";
  const [state, setState] = useState<SortState | null>(null);

  useEffect(() => {
    if (!sort) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SORT_TIMEOUT_MS);
    setState({ key, phase: "loading" });
    loadSortFetch()
      .then(({ fetchSortedPicks }) =>
        fetchSortedPicks({
          strategyId,
          sortBy: sort,
          status,
          signal: controller.signal,
        }),
      )
      .then((sorted) => {
        if (!cancelled) setState({ key, phase: "ready", sorted });
      })
      .catch(() => {
        if (!cancelled) setState({ key, phase: "error" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // `key` encodes strategyId, sort and status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Reaching for a sort chip starts loading the fetch code before the click.
  const warm = useCallback(() => {
    void loadSortFetch().catch(() => undefined);
  }, []);

  // A state left over from another sort or status is not this one's answer.
  const current = sort && state?.key === key ? state : null;
  return (
    <PicksFilterView
      {...props}
      status={status}
      sort={sort}
      sorted={current?.phase === "ready" ? current.sorted : null}
      sortPhase={
        sort
          ? current?.phase === "error"
            ? "error"
            : current?.phase === "ready"
              ? null
              : "loading"
          : null
      }
      onSortIntent={warm}
    />
  );
}
