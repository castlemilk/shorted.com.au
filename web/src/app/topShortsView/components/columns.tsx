"use client";

import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { DataTableColumnDisplayHeader } from "./data-table-column-display-header";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import Sparkline from "./sparkline";
import { Button } from "~/@/components/ui/button";
import { ArrowUpDown, Circle } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "~/@/components/ui/badge";

const redColor = `var(--red)`;
const greenColor = `var(--green)`;

export const columns: ColumnDef<PlainMessage<TimeSeriesData>>[] = [
  {
    id: "name",
    accessorKey: "productCode",
    header: ({ column }) => (
      <DataTableColumnDisplayHeader className="self-center" column={column} title="Name" />
    ),
    cell: ({ row }) => {
      return (
        <Card className="border-hidden bg-transparent shadow-none">
          <CardHeader>
            <CardTitle>{row.original.productCode}</CardTitle>
            <CardDescription>{row.original.name}</CardDescription>
          </CardHeader>
        </Card>
      );
    },
    enableSorting: false,
    enableHiding: false,
  },
  {
    id: "shorted",
    accessorKey: "latestShortPosition",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          className="self-center"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Short
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => (
      <div className="self-center w-m-60">
        <div className="">
          <Badge className="flex mb-1 mr-1 p-0 pl-1 items-center text-xs text-nowrap">
            <Circle strokeWidth={0} size={10} fill={greenColor} />
            <p className="pl-1">{`Min: ${row.original.min?.shortPosition.toFixed(2)}`}</p>
          </Badge>
          <Badge className="flex mr-1 p-0 pl-1 items-center text-xs text-nowrap">
            <Circle strokeWidth={0} size={10} fill={redColor} />
            <p className="pl-1">{`Max: ${row.original.max?.shortPosition.toFixed(2)}`}</p>
          </Badge>
        </div>
        <div className="flex items-end">
          <div className="text-3xl font-bold">
            {row.original.latestShortPosition.toFixed(2)}
          </div>
          <div className="text-lg ">%</div>
        </div>
      </div>
    ),
    enableSorting: true,
    enableHiding: false,
  },
  {
    id: "sparkline",
    header: ({}) => <div className="self-center">last 6 months</div>,
    cell: ({ row }) =>
      flexRender(Sparkline, {
        data: row.original,
        key: `${row.id}-sparkline-chart`,
      }),
    enableSorting: false,
    enableHiding: false,
  },
];