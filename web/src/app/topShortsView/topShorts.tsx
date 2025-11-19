"use client";

import React, {
  type FC,
  useEffect,
  useState,
  useCallback,
  Suspense,
  useRef,
} from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Label } from "~/@/components/ui/label";
import { getTopShortsDataClient } from "../actions/client/getTopShorts";
import { DataTable } from "./components/data-table";
import { columns } from "./components/columns";
import { Card, CardTitle } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";

const getPeriodString = (period: string) => {
  switch (period) {
    case "1m":
      return "1 month";
    case "3m":
      return "3 months";
    case "6m":
      return "6 months";
    case "1y":
      return "1 year";
    case "2y":
      return "2 years";
    case "5y":
      return "5 years";
    case "max":
      return "maximum window";
    default:
      return "6 months";
  }
};

interface TopShortsProps {
  initialShortsData?: TimeSeriesData[]; // Data for multiple series (optional)
  initialPeriod?: string; // Add initial period prop
}

const LOAD_CHUNK_SIZE = 10;

export const TopShorts: FC<TopShortsProps> = ({
  initialShortsData,
  initialPeriod = "3m",
}) => {
  const [period, setPeriod] = useState<string>(initialPeriod);
  const [displayPeriod, setDisplayPeriod] = useState<string>(initialPeriod);
  const [isInitialLoading, setIsInitialLoading] =
    useState<boolean>(!initialShortsData);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [shortsData, setShortsData] = useState<TimeSeriesData[]>(
    initialShortsData ?? [],
  );
  const requestIdRef = useRef(0);
  const offsetRef = useRef<number>(initialShortsData?.length ?? 0);
  const [refreshKey, setRefreshKey] = useState<number>(() => Date.now());

  const getTimeSeriesForPeriod = useCallback(
    async (nextPeriod: string, opts: { keepExisting: boolean }) => {
      requestIdRef.current += 1;
      const currentRequestId = requestIdRef.current;

      if (opts.keepExisting) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }

      try {
        const result = await getTopShortsDataClient(
          nextPeriod,
          LOAD_CHUNK_SIZE,
          0,
        );

        if (requestIdRef.current !== currentRequestId) {
          return;
        }

        const timeSeriesData: TimeSeriesData[] = result.timeSeries ?? [];
        setShortsData(timeSeriesData);
        setDisplayPeriod(nextPeriod);
        offsetRef.current = timeSeriesData.length;
        setRefreshKey(Date.now());
      } catch (e) {
        if (requestIdRef.current === currentRequestId) {
          console.error("Error fetching data: ", e);
        }
      } finally {
        if (requestIdRef.current !== currentRequestId) {
          return;
        }

        if (opts.keepExisting) {
          setIsRefreshing(false);
        } else {
          setIsInitialLoading(false);
        }
      }
    },
    [],
  );

  const fetchMoreData = useCallback(async () => {
    if (isInitialLoading || isRefreshing) {
      return;
    }

    try {
      const result = await getTopShortsDataClient(
        period,
        LOAD_CHUNK_SIZE,
        offsetRef.current,
      );

      const timeSeriesData: TimeSeriesData[] = result.timeSeries ?? [];
      if (timeSeriesData.length === 0) {
        return;
      }

      offsetRef.current += timeSeriesData.length;
      setShortsData((prev) => [...prev, ...timeSeriesData]);
    } catch (e) {
      console.error("Error fetching data: ", e);
    }
  }, [isInitialLoading, isRefreshing, period]);

  useEffect(() => {
    if (!initialShortsData || initialShortsData.length === 0) {
      void getTimeSeriesForPeriod(initialPeriod, { keepExisting: false });
      return;
    }

    offsetRef.current = initialShortsData.length;
    setDisplayPeriod(initialPeriod);
    setIsInitialLoading(false);
    setRefreshKey(Date.now());
  }, [getTimeSeriesForPeriod, initialPeriod, initialShortsData]);

  const handlePeriodChange = useCallback(
    (nextPeriod: string) => {
      if (nextPeriod === period && !isRefreshing) {
        return;
      }
      setPeriod(nextPeriod);
      void getTimeSeriesForPeriod(nextPeriod, { keepExisting: true });
    },
    [getTimeSeriesForPeriod, period, isRefreshing],
  );

  return (
    <Suspense fallback={loadingPlaceholder}>
      <Card className="m-2">
        <div className="flex align-middle justify-between">
          <CardTitle className="self-center m-5">Top Shorts</CardTitle>
          <div className="flex flex-row-reverse m-2">
            <div className="w-48">
              <Label htmlFor="area">Time</Label>
              <Select value={period} onValueChange={handlePeriodChange}>
                <SelectTrigger id="area">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3m">3 months</SelectItem>
                  <SelectItem value="6m">6 months</SelectItem>
                  <SelectItem value="1y">1 year</SelectItem>
                  <SelectItem value="2y">2 years</SelectItem>
                  <SelectItem value="5y">5 years</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DataTable
          loading={isInitialLoading && shortsData.length === 0}
          isRefreshing={isRefreshing}
          data={shortsData}
          columns={columns}
          period={getPeriodString(displayPeriod)}
          fetchMore={fetchMoreData}
          refreshKey={refreshKey}
        />
      </Card>
    </Suspense>
  );
};

const loadingPlaceholder = (
  <div className="">
    <Card className="w-[500px] overflow-y-auto">
      <div className="flex justify-between h-[80px]">
        <Skeleton className="h-[40px] w-[200px] rounded-xl m-3"></Skeleton>
        <Skeleton className="h-[40px] w-[200px] rounded-xl m-3"></Skeleton>
      </div>
      <div className="h-[700px]">
        {Array.from({ length: 10 }).map((_, i) => (
          <div className="m-3" key={i}>
            <Skeleton
              key={i}
              className="h-[186px] w-full rounded-xl"
            ></Skeleton>
          </div>
        ))}
      </div>
    </Card>
  </div>
);
