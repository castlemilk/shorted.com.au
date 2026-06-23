"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry points for the feature's interactive dashboards. Defined in
 * a "use client" module so `dynamic(..., { ssr: false })` is permitted, then
 * imported by the server page — the same pattern the news MDX charts use to
 * stay clear of the connect-web / measure-on-client SSR landmines.
 */

const skeleton = (h: number) => () => (
  <div className="w-full animate-pulse rounded-lg bg-muted" style={{ height: h }} />
);

export const BankShortBasket = dynamic(
  () => import("~/@/components/news/mdx/bank-short-basket").then((m) => m.BankShortBasket),
  { ssr: false, loading: skeleton(440) },
);

export const PolicyPriceChart = dynamic(
  () => import("./charts/policy-price-chart").then((m) => m.PolicyPriceChart),
  { ssr: false, loading: skeleton(400) },
);

export const BuyingPowerChart = dynamic(
  () => import("./charts/buying-power-chart").then((m) => m.BuyingPowerChart),
  { ssr: false, loading: skeleton(400) },
);

export const BorrowingPowerSlider = dynamic(
  () => import("./charts/borrowing-power-slider").then((m) => m.BorrowingPowerSlider),
  { ssr: false, loading: skeleton(300) },
);

export const InternationalCorrectionsChart = dynamic(
  () =>
    import("./charts/international-corrections-chart").then(
      (m) => m.InternationalCorrectionsChart,
    ),
  { ssr: false, loading: skeleton(440) },
);
