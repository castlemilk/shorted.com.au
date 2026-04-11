"use client";

import {
  type CommunityPulseItem,
  type CommunityThread,
} from "~/@/types/community";
import { CommunityPulseRail } from "./community-pulse-rail";
import { CommunityThreadList } from "./community-thread-list";

interface CommunityTabProps {
  stockCode: string;
  threads: CommunityThread[];
  pulse: CommunityPulseItem[];
}

export function CommunityTab({
  stockCode,
  threads,
  pulse,
}: CommunityTabProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
      <CommunityThreadList stockCode={stockCode} threads={threads} />
      <CommunityPulseRail pulse={pulse} />
    </div>
  );
}
