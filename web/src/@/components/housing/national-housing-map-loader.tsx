"use client";

import dynamic from "next/dynamic";

export const NationalHousingMap = dynamic(
  () => import("./national-housing-map").then((m) => m.NationalHousingMap),
  { ssr: false, loading: () => <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" /> },
);
