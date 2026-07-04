"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the housing calculators — the dynamic(ssr:false)
 * wrapper keeps the measure-on-mount @visx chart out of SSR (same pattern as
 * housing-charts.tsx). Props from the server page must stay serializable.
 */
const skeleton = (h: number) =>
  function CalcSkeleton() {
    return <div className="w-full animate-pulse rounded-xl bg-muted" style={{ height: h }} />;
  };

export const MortgageSimulator = dynamic(
  () => import("./mortgage-simulator").then((m) => m.MortgageSimulator),
  { ssr: false, loading: skeleton(560) },
);

export const DepositCalculator = dynamic(
  () => import("./deposit-calculator").then((m) => m.DepositCalculator),
  { ssr: false, loading: skeleton(420) },
);

export const StampDutyCalculator = dynamic(
  () => import("./stamp-duty-calculator").then((m) => m.StampDutyCalculator),
  { ssr: false, loading: skeleton(320) },
);

export const RentVsBuyCalculator = dynamic(
  () => import("./rent-vs-buy-calculator").then((m) => m.RentVsBuyCalculator),
  { ssr: false, loading: skeleton(620) },
);
