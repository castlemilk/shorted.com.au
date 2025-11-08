"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { getTopShortsData } from "../actions/getTopShorts";
import { calculateMovers, type TimePeriod, type MoversData } from "~/@/lib/shorts-calculations";
import { TopShortsClient } from "./components/top-shorts-client";
import { Skeleton } from "~/@/components/ui/skeleton";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

const DEFAULT_PERIOD: TimePeriod = "3m";
const LOAD_CHUNK_SIZE = 20;

export default function TopShortsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [moversData, setMoversData] = useState<MoversData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "loading") return;

    if (!session) {
      router.push("/signin?callbackUrl=/shorts");
      return;
    }

    const fetchData = async () => {
      try {
        const data = await getTopShortsData(DEFAULT_PERIOD, LOAD_CHUNK_SIZE, 0);
        const calculatedMovers = calculateMovers(data.timeSeries, DEFAULT_PERIOD);
        setMoversData(calculatedMovers);
      } catch (error) {
        console.error("Error fetching shorts data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [session, status, router]);

  if (status === "loading" || loading || !moversData) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <TopShortsClient
      initialMoversData={moversData}
      initialPeriod={DEFAULT_PERIOD}
    />
  );
}
