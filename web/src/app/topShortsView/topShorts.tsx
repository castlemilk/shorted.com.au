"use client";

import React, { type FC, useEffect, useState, useCallback } from "react";
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

const LOAD_CHUNK_SIZE = 10;

export const TopShorts: FC<TopShortsProps> = ({ initialShortsData }) => {
  const [period, setPeriod] = useState<string>("3m");
  const [loading, setLoading] = useState<boolean>(false);
  const [offset, setOffset] = useState<number>(1); // Added offset state
  const [shortsData, setShortsData] = useState<
    PlainMessage<TimeSeriesData>[] | null
  >(initialShortsData);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const newData = await getTopShortsData(period, LOAD_CHUNK_SIZE, offset);
      setShortsData((prev) => [...(prev ?? []), ...newData.timeSeries]);
      setOffset((prevOffset) => prevOffset + LOAD_CHUNK_SIZE); // Increment offset
    } catch (e) {
      console.error("Error fetching data: ", e);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    setLoading(true);
    getTopShortsData(period, offset, 0)
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
      {shortsData ? (
        <DataTable
          loading={loading}
          data={shortsData}
          columns={columns}
          period={getPeriodString(period)}
          fetchMore={fetchData}
        />
      ) : (
        <div>Loading...</div>
      )}
    </Card>
  );
};
