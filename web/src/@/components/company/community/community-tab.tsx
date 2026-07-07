"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  threads?: CommunityThread[];
  pulse?: CommunityPulseItem[];
}

function parseCommunityDate(value: CommunityThread["createdAt"] | string) {
  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function normalizeThread(thread: CommunityThread): CommunityThread {
  return {
    ...thread,
    createdAt: parseCommunityDate(thread.createdAt),
    updatedAt: parseCommunityDate(thread.updatedAt),
    lastActivityAt: parseCommunityDate(thread.lastActivityAt),
  };
}

function normalizePulseItem(item: CommunityPulseItem): CommunityPulseItem {
  return {
    ...item,
    createdAt: parseCommunityDate(item.createdAt),
    updatedAt: parseCommunityDate(item.updatedAt),
  };
}

async function fetchCommunityJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Community request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function CommunityTab({
  stockCode,
  threads,
  pulse,
}: CommunityTabProps) {
  const { data: session } = useSession();
  const shouldFetchThreads = threads === undefined;
  const shouldFetchPulse = pulse === undefined;
  const [threadItems, setThreadItems] = useState<CommunityThread[]>(
    () => threads ?? [],
  );
  const [pulseItems, setPulseItems] = useState<CommunityPulseItem[]>(
    () => pulse ?? [],
  );
  const [isLoading, setIsLoading] = useState(
    shouldFetchThreads || shouldFetchPulse,
  );
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!shouldFetchThreads && !shouldFetchPulse) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function loadCommunityActivity() {
      setIsLoading(true);
      setLoadError(false);

      try {
        const [threadsPayload, pulsePayload] = await Promise.all([
          shouldFetchThreads
            ? fetchCommunityJson<{ threads?: CommunityThread[] }>(
                `/api/community/${stockCode}/threads`,
                controller.signal,
              )
            : Promise.resolve({ threads }),
          shouldFetchPulse
            ? fetchCommunityJson<{ pulse?: CommunityPulseItem[] }>(
                `/api/community/${stockCode}/pulse`,
                controller.signal,
              )
            : Promise.resolve({ pulse }),
        ]);

        if (cancelled) {
          return;
        }

        if (shouldFetchThreads) {
          setThreadItems((threadsPayload.threads ?? []).map(normalizeThread));
        }

        if (shouldFetchPulse) {
          setPulseItems((pulsePayload.pulse ?? []).map(normalizePulseItem));
        }
      } catch (error) {
        if (!cancelled && (error as Error).name !== "AbortError") {
          setLoadError(true);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadCommunityActivity();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    pulse,
    shouldFetchPulse,
    shouldFetchThreads,
    stockCode,
    threads,
  ]);

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

      {isLoading ? (
        <div
          role="status"
          className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
        >
          Loading community activity...
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Unable to load community activity right now.
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
        <CommunityThreadList stockCode={stockCode} threads={threadItems} />
        <CommunityPulseRail pulse={pulseItems} />
      </div>
    </div>
  );
}
