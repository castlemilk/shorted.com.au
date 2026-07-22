"use client";

import dynamic from "next/dynamic";

/** Client-only boundary for the economy overlay chart and Connect browser client. */
export const IndustryEconomyContext = dynamic(
  () =>
    import("./industry-economy-context").then(
      (module) => module.IndustryEconomyContext,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-[380px] w-full animate-pulse rounded bg-muted"
        aria-hidden="true"
      />
    ),
  },
);
