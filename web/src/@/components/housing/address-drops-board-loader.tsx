"use client";

import dynamic from "next/dynamic";

import type { AddressDropsBoardProps } from "./address-drops-board";

// ssr:false — this board fetches over connect-web (client transport), so it must
// never render on the server (same rule as the other housing client components).
export const AddressDropsBoard = dynamic<AddressDropsBoardProps>(
  () => import("./address-drops-board").then((m) => m.AddressDropsBoard),
  { ssr: false, loading: () => <div className="h-[480px] w-full animate-pulse rounded-xl bg-muted" /> },
);

export type { AddressDropsBoardProps };
