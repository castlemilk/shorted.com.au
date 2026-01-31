"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/@/components/ui/skeleton";

const TopShorts = dynamic(
  () => import("./topShortsView/topShorts").then((mod) => mod.TopShorts),
  {
    loading: () => (
      <div className="p-4">
        <Skeleton className="h-[700px] w-full rounded-xl" />
      </div>
    ),
    ssr: false,
  }
);

export function HomeContent() {
  return (
    <div className="container mx-auto px-4 py-4">
      <TopShorts initialPeriod="3m" />
    </div>
  );
}
