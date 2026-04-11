"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  type CommunityPulseItem,
  type CommunityThread,
} from "~/@/types/community";
import { CommunityPulseForm } from "./community-pulse-form";
import { CommunityPulseRail } from "./community-pulse-rail";
import { CommunityThreadForm } from "./community-thread-form";
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
  const { data: session } = useSession();
  const [threadItems, setThreadItems] = useState(threads);
  const [pulseItems, setPulseItems] = useState(pulse);

  return (
    <div className="space-y-6">
      {session?.user?.id ? (
        <div className="flex flex-wrap gap-3">
          <CommunityThreadForm
            stockCode={stockCode}
            onCreated={(thread) =>
              setThreadItems((current) => [thread, ...current])
            }
          />
          <CommunityPulseForm
            stockCode={stockCode}
            onCreated={(pulseItem) =>
              setPulseItems((current) => [pulseItem, ...current])
            }
          />
        </div>
      ) : (
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(
            `/shorts/${stockCode}?tab=community`,
          )}`}
          className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Sign in to post
        </Link>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
        <CommunityThreadList stockCode={stockCode} threads={threadItems} />
        <CommunityPulseRail pulse={pulseItems} />
      </div>
    </div>
  );
}
