"use client";

import dynamic from "next/dynamic";

export const SuburbProfile = dynamic(
  () => import("./suburb-profile").then((m) => m.SuburbProfile),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);
