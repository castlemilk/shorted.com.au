"use client";

import dynamic from "next/dynamic";

import type { SuburbPriceDropsPanelProps } from "./suburb-price-drops-panel";

// ssr:false — the panel fetches over connect-web (client transport), so it must
// never render on the server (same rule as the other housing client components).
export const SuburbPriceDropsPanel = dynamic<SuburbPriceDropsPanelProps>(
  () => import("./suburb-price-drops-panel").then((m) => m.SuburbPriceDropsPanel),
  { ssr: false },
);

export type { SuburbPriceDropsPanelProps };
