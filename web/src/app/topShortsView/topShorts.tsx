"use client";

import React, { type FC, useEffect, useState } from "react";
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
/**
 * TopShortsChart
 * Responsible for rendering a stylish chart in d3 which shows the top x short positions for period y
 * the number of short positions to show (x) should be configurable
 * the period (y) should be configurable
 * @param data - the data to render, formatted as a PlainMessage<TimeSeriesData>[]
 *               where TimeSeriesData is the data for a single stock with the format:
 *              {
 *                 productCode: string,
 *                 points: TimeSeriesPoint[]
 *              }
 *            where TimeSeriesPoint is the data for a single point in time with the format:
 *             {
 *                timestamp: Timestamp,
 *               shortPosition: number
 *              }
 *
 * @returns a styled chart showing the top x short positions for period y
 */

interface TopShortsProps {
  initialShortsData: PlainMessage<TimeSeriesData>[]; // Data for multiple series
}

export const TopShorts: FC<TopShortsProps> = ({ initialShortsData }) => {
  const [period, setPeriod] = useState<string>("3m");
  const [limit, setLimit] = useState<number>(10);

  useEffect(() => {
    console.log("fetching data, for period: ", period, "limit: ", limit);
    // fetch data
    const data = getTopShortsData(period, limit);
    data
      .then((data) => {
        return setShortsData(data.timeSeries);
      })
      .catch((e) => {
        console.error("Error fetching data: ", e);
      });
  }, [period, limit]);

  const [shortsData, setShortsData] = useState<
    PlainMessage<TimeSeriesData>[] | null
  >(initialShortsData);
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
              <SelectItem value="2y">2 year</SelectItem>
              <SelectItem value="5y">5 year</SelectItem>
              <SelectItem value="max">max</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="p-2 w-48">
          <Label htmlFor="area">Limit</Label>
          <Select
            onValueChange={(e) => setLimit(Number(e))}
            defaultValue={"10"}
          >
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
      <div>
        {shortsData ? (
          // shortsData.map((data) => {
          //   return (
          //     <div key={data.productCode}>
          //       <Card>
          //         <CardHeader className="grid grid-cols-3 items-start gap-4 space-y-0">
          //           <div className="col-span-2 space-y-1">
          //             <CardTitle>{data.productCode}</CardTitle>
          //             <CardDescription>{data.name}</CardDescription>
          //             <CardContent>
          //               <p>Card Content</p>
          //             </CardContent>
          //           </div>
          //           <div className="flex items-center space-x-1 justify-center">
          //             <Sparkline data={data} />
          //           </div>
          //         </CardHeader>
          //       </Card>
          //     </div>
          //   );
          // })
          <DataTable data={shortsData} columns={columns} />
        ) : (
          <div>Loading...</div>
        )}
      </div>
    </div>
  );
};
