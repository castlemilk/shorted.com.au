"use client";

import dynamic from "next/dynamic";

import type { DropIndexHeroProps } from "./drop-index-hero";

// Charts cannot SSR in this codebase; keep the chart runtime out of the
// server render and load it client-side only.
export const DropIndexHero = dynamic<DropIndexHeroProps>(
  () => import("./drop-index-hero").then((module) => module.DropIndexHero),
  {
    ssr: false,
    loading: () => (
      <div className="h-[160px] w-full animate-pulse rounded-xl bg-muted" />
    ),
  },
);

export type { DropIndexHeroProps };
