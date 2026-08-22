"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the suburb locator inset.
 *
 * The map fetches a per-state TopoJSON and measures on the client, so there is
 * nothing to server render but its own skeleton. It gets its own ssr:false
 * boundary — rather than the whole profile sharing one — so the rest of the page
 * (heading, price, demographics) stays in the server HTML. Same posture as the
 * other housing maps.
 */
export const SuburbLocatorMap = dynamic(
  () => import("./suburb-locator-map").then((m) => m.SuburbLocatorMap),
  {
    ssr: false,
    // The skeleton must reproduce the real card's heading and footer link rows,
    // not just the 200px map body — it is the first item in the right rail, so
    // any height it under-reserves shifts everything below it on hydration.
    // `loading` gets no props, hence bars rather than the real text.
    loading: () => (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 h-[22px] w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-[200px] w-full animate-pulse rounded-lg bg-muted" />
        <div className="mt-2 h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    ),
  },
);
