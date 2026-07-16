"use client";

import dynamic from "next/dynamic";

import type { PropertyHistoryViewProps } from "./property-history-view";

// ssr:false — this view fetches over connect-web (client transport), so it must
// never render on the server (same rule as the other housing client components).
export const PropertyHistoryView = dynamic<PropertyHistoryViewProps>(
  () => import("./property-history-view").then((m) => m.PropertyHistoryView),
  { ssr: false, loading: () => <div className="h-[480px] w-full animate-pulse rounded-xl bg-muted" /> },
);

export type { PropertyHistoryViewProps };
