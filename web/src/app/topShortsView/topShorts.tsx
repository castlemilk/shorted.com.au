"use client";

import React, { type FC, useEffect, useState, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Label } from "~/@/components/ui/label";
import { getTopShortsData } from "../actions/getTopShorts";
import { DataTable } from "./components/data-table";
import { columns } from "./components/columns";

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
}

export const TopShorts: FC<TopShortsProps> = ({ initialShortsData }) => {
  const [period, setPeriod] = useState<string>("3m");
  const [loading, setLoading] = useState<boolean>(false);
  const [limit, setLimit] = useState<number>(10);
  const [offset, setOffset] = useState<number>(1); // Added offset state
  const [shortsData, setShortsData] = useState<PlainMessage<TimeSeriesData>[] | null>(initialShortsData);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const newData = await getTopShortsData(period, limit, offset);
      setShortsData((prev) => [...(prev ?? []), ...newData.timeSeries]);
      setOffset((prevOffset) => prevOffset + limit); // Increment offset
    } catch (e) {
      console.error("Error fetching data: ", e);
    } finally {
      setLoading(false);
    }
  }, [period, limit, offset]);

  // useEffect(() => {
  //   const loadData = async () => {
  //     await fetchData(); // Trigger data fetch initially or when period/limit changes
  //   };

  //   loadData();

  //   return () => {
  //     // Cleanup function
  //   };
  // }, [period, limit]);

  return (
    <div className="p-5">
      <div className="flex flex-row-reverse m-2">
        <div className="p-2 w-48">
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
        <div className="p-2 w-48">
          <Label htmlFor="area">Limit</Label>
          <Select onValueChange={(e) => setLimit(Number(e))} defaultValue={"10"}>
            <SelectTrigger id="area">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5</SelectItem>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="40">40</SelectItem>
              <SelectItem value="80">80</SelectItem>
              <SelectItem value="max">max</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {shortsData ? (
        <DataTable loading={loading} data={shortsData} columns={columns} period={getPeriodString(period)} fetchMore={fetchData} />
      ) : (
        <div>Loading...</div>
      )}
    </div>
  );
};
