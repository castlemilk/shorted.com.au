"use client";

import dynamic from "next/dynamic";

/**
 * The compare island, loaded browser-only.
 *
 * `ssr: false` is LOAD-BEARING, not a bundle preference. The panel reaches the
 * generated protobuf runtime through the compare client action and through
 * `compliance.tsx`, and that runtime taking part in a Next prerender is the
 * documented "Element type is invalid: … got: undefined" failure that has
 * already taken the static build of /politicians down once. Keeping the panel
 * off the server render is what makes those imports safe, and it also keeps
 * politicians_pb out of the route's first-load bundle.
 *
 * `dynamic(…, { ssr: false })` may only be called from a client module, which is
 * the whole reason this two-line file exists.
 */
export const ComparePanel = dynamic(
  () => import("./compare-panel").then((m) => m.ComparePanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] w-full animate-pulse rounded-lg bg-muted" />
    ),
  },
);
