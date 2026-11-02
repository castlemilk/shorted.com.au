"use client";

import dynamic from "next/dynamic";

// Client-only: it fetches the ATO tax profile through a Connect-RPC client module.
// It is the last card on the Financials tab, below the fold, so it has no preload.
export const CompanyTaxCard = dynamic(
  () => import("./company-tax-card").then((m) => m.CompanyTaxCard),
  { ssr: false },
);
