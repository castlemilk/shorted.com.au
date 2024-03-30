"use client";

import React, { FC, useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { Button } from "@/components/ui/button";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as d3 from "d3";
import { PlainMessage } from "@bufbuild/protobuf";
import {
  TimeSeriesData,
  TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
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
  const [shortsData, setShortsData] = useState<
    PlainMessage<TimeSeriesData>[] | null
  >(initialShortsData);
  return (
    <div className="p-5">
      <div className="flex flex-row-reverse m-2">
        <div className="p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">time</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>7d</DropdownMenuItem>
              <DropdownMenuItem>1m</DropdownMenuItem>
              <DropdownMenuItem>3m</DropdownMenuItem>
              <DropdownMenuItem>6m</DropdownMenuItem>
              <DropdownMenuItem>2y</DropdownMenuItem>
              <DropdownMenuItem>5y</DropdownMenuItem>
              <DropdownMenuItem>max</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="p-2">
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
              <Button variant="outline">limit</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>5</DropdownMenuItem>
              <DropdownMenuItem>10</DropdownMenuItem>
              <DropdownMenuItem>20</DropdownMenuItem>
              <DropdownMenuItem>40</DropdownMenuItem>
              <DropdownMenuItem>50</DropdownMenuItem>
              <DropdownMenuItem>80</DropdownMenuItem>
              <DropdownMenuItem>max</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div>
        {shortsData ? (
          shortsData.map((data) => {
            return (
              <div key={data.productCode}>
                <Card>
                  <CardHeader>
                    <CardTitle>{data.productCode}</CardTitle>
                    <CardDescription>
                      {data.name}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p>Card Content</p>
                  </CardContent>
                </Card>
              </div>
            );
          })
        ) : (
          <div>Loading...</div>
        )}
      </div>
    </div>
  );
};
