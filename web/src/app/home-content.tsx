"use client";

import { TopShorts } from "./topShortsView/topShorts";

export function HomeContent() {
  return (
    <div className="container mx-auto px-4 py-4">
      <TopShorts initialPeriod="3m" />
    </div>
  );
}
