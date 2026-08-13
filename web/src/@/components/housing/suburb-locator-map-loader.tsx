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
    loading: () => (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="h-[200px] w-full animate-pulse rounded-lg bg-muted" />
      </div>
    ),
  },
);
