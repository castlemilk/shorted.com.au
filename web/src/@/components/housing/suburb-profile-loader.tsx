"use client";

import dynamic from "next/dynamic";

import type { SuburbProfileProps } from "./suburb-profile";

export const SuburbProfile = dynamic<SuburbProfileProps>(
  () => import("./suburb-profile").then((m) => m.SuburbProfile),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);

export type { SuburbProfileProps };
