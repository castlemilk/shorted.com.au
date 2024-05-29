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
} from "@/components/ui/select";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Label } from "~/@/components/ui/label";
import { getTopShortsData } from "../actions/getTopShorts";
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
    case "max":
      return "maximum window";
    default:
      return "6 months";
  }
};

interface TopShortsProps {
  initialShortsData: PlainMessage<TimeSeriesData>[]; // Data for multiple series
  token?: string;
}

const LOAD_CHUNK_SIZE = 10;

export const TopShorts: FC<TopShortsProps> = ({ initialShortsData, token }) => {
  const [period, setPeriod] = useState<string>("3m");
  const [loading, setLoading] = useState<boolean>(false);
  const [offset, setOffset] = useState<number>(0); // Added offset state
  const [shortsData, setShortsData] =
    useState<PlainMessage<TimeSeriesData>[]>(initialShortsData);
  const firstUpdate = useRef(true);
  const fetchMoreData = useCallback(async () => {
    setLoading(true);
    try {
      const newData = await getTopShortsData(
        period,
        LOAD_CHUNK_SIZE,
        LOAD_CHUNK_SIZE + offset,
        token
      );
      setShortsData((prev) => [...(prev ?? []), ...newData.timeSeries]);
      setOffset((prevOffset) => prevOffset + LOAD_CHUNK_SIZE); // Increment offset
    } catch (e) {
      console.error("Error fetching data: ", e);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    if (firstUpdate.current) {
      firstUpdate.current = false;
      return;
    }
    setLoading(true);
    getTopShortsData(period, Math.max(LOAD_CHUNK_SIZE, offset), 0, token)
      .then((data) => {
        setShortsData(data.timeSeries);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Error fetching data: ", e);
        setLoading(false);
      });
  }, [period]);

  return (
    <Suspense fallback={loadingPlaceholder}>
      <Card className="m-3 w-[500px]">
        <div className="flex align-middle justify-between">
          <CardTitle className="self-center m-5">Top Shorts</CardTitle>
          <div className="flex flex-row-reverse m-2">
            <div className="w-48">
              <Label htmlFor="area">Time</Label>
              <Select onValueChange={(e) => setPeriod(e)} defaultValue={"3m"}>
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
          loading={loading}
          data={shortsData}
          columns={columns}
          period={getPeriodString(period)}
          fetchMore={fetchMoreData}
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
          <div className="m-3">
            <Skeleton key={i} className="h-[186px] w-full rounded-xl"></Skeleton>
          </div>
        ))}
      </div>
    </Card>
  </div>
);
