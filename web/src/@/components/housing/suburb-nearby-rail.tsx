"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { listStateSuburbsClient } from "~/app/actions/client/getHousingClient";
import { suburbHref } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon } from "./housing-icon";

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * "Nearby & comparable" rail.
 *
 * This is the one part of the suburb profile that genuinely cannot be server
 * rendered as-is: it needs the whole state's suburb list to pick six neighbours,
 * which is a large client fetch deliberately deferred to idle so it never
 * competes with the page's own content. It is therefore an island — the rest of
 * the profile renders on the server, and this fills in afterwards.
 *
 * It renders nothing at all until the list arrives, so an empty result and a
 * still-loading state look identical (and cost no layout shift beyond their own
 * card appearing).
 */
export function SuburbNearbyRail({
  stateCode,
  salCode,
  postcode,
  latestMedianPrice,
}: {
  stateCode: string;
  salCode: string;
  postcode: string;
  latestMedianPrice: number;
}) {
  const [loadNearby, setLoadNearby] = useState(false);

  useEffect(() => {
    const start = () => setLoadNearby(true);
    const idleWindow = window as IdleWindow;
    if (idleWindow.requestIdleCallback) {
      const idleId = idleWindow.requestIdleCallback(start, { timeout: 2000 });
      return () => idleWindow.cancelIdleCallback?.(idleId);
    }
    const timeoutId = window.setTimeout(start, 1200);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const { data: stateList } = useQuery({
    queryKey: ["state-suburbs", stateCode],
    queryFn: () => listStateSuburbsClient(stateCode, "", 5000),
    enabled: !!stateCode && loadNearby,
    staleTime: 60 * 60 * 1000,
  });

  const nearby = useMemo(() => {
    const all = (stateList?.suburbs ?? []).filter((x) => x.salCode !== salCode);
    if (postcode) {
      const same = all.filter((x) => x.postcode === postcode);
      if (same.length) return same.slice(0, 6);
    }
    if (latestMedianPrice > 0) {
      return [...all]
        .filter((x) => x.latestMedianPrice > 0)
        .sort(
          (a, b) =>
            Math.abs(a.latestMedianPrice - latestMedianPrice) -
            Math.abs(b.latestMedianPrice - latestMedianPrice),
        )
        .slice(0, 6);
    }
    return [];
  }, [stateList, salCode, postcode, latestMedianPrice]);

  if (!nearby.length) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1.5 font-serif text-base text-foreground">
        <HousingIcon name="nearby" size={22} /> Nearby &amp; comparable
      </h2>
      <div className="flex flex-col">
        {nearby.map((n) => (
          <Link
            key={n.salCode}
            href={suburbHref(stateCode, n)}
            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span className="truncate capitalize">{n.salName.toLowerCase()}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              {n.latestMedianPrice > 0 ? fmtPriceShort(n.latestMedianPrice) : "—"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
