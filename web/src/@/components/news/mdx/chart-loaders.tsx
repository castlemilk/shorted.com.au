"use client";

import dynamic from "next/dynamic";

// The newsroom palette's charts. registry.tsx keeps these seven names as the
// MDX components, so the writer's palette (manifest.ts) and the articles do not
// change. Each chart is client-only (connect-web under the hood), so each is
// loaded here with ssr: false. The call has to sit in a client module: next/dynamic
// with ssr: false is refused in a server component. Each chart sits after the
// article's data discussion, below the fold, so no chunk starts before it mounts.
export const ShortInterestChart = dynamic(
  () => import("./short-interest-chart").then((m) => m.ShortInterestChart),
  { ssr: false },
);
export const PriceChart = dynamic(
  () => import("./price-chart").then((m) => m.PriceChart),
  { ssr: false },
);
export const BankShortBasket = dynamic(
  () => import("./bank-short-basket").then((m) => m.BankShortBasket),
  { ssr: false },
);
export const ShortBasket = dynamic(
  () => import("./short-basket").then((m) => m.ShortBasket),
  { ssr: false },
);
export const MultiSeriesChart = dynamic(
  () => import("./multi-series-chart").then((m) => m.MultiSeriesChart),
  { ssr: false },
);
export const BarChart = dynamic(
  () => import("./bar-chart").then((m) => m.BarChart),
  { ssr: false },
);
export const FlowChart = dynamic(
  () => import("./flow-chart").then((m) => m.FlowChart),
  { ssr: false },
);
