"use client";

import { type ColumnDef } from "@tanstack/react-table";
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
import { Badge } from "~/@/components/ui/badge";

const redColor = `var(--red)`;
const greenColor = `var(--green)`;

const truncateValue = (value: number, maxLength: number) => {
  const formatted = value.toFixed(2);
  if (formatted.length <= maxLength) return formatted;
  if (maxLength < 4) return '...';
  return value.toFixed(0) + (value.toFixed(0).length > maxLength - 1 ? '...' : '');
};

export const columns: ColumnDef<PlainMessage<TimeSeriesData>>[] = [
  {
    id: "name",
    accessorKey: "productCode",
    header: ({ column }) => (
      <DataTableColumnDisplayHeader
        className="self-center h-full flex items-center" // Added classes
        column={column}
        style={{ width: `${column.getSize()}px` }}
        title="Name"
      />
    ),
    cell: ({ row }) => {
      return (
        <Card className="border-hidden bg-transparent shadow-none ">
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
        <div className="h-full flex items-center justify-center"> {/* Added wrapper div */}
          <Button
            variant="ghost"
            className="self-center"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Short
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        </div>
      );
    },
    cell: ({ row }) => (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center">
          <div className="flex flex-col mb-2">
            <Badge className="flex mb-1 p-0 pl-1 items-center text-xs w-[85px] truncate">
              <Circle strokeWidth={0} size={10} fill={greenColor} />
              <p className="pl-1">{`Min: ${truncateValue(row.original.min?.shortPosition ?? 0, 5)}`}</p>
            </Badge>
            <Badge className="flex p-0 pl-1 items-center text-xs w-[85px] truncate">
              <Circle strokeWidth={0} size={10} fill={redColor} />
              <p className="pl-1">{`Max: ${truncateValue(row.original.max?.shortPosition ?? 0, 5)}`}</p>
            </Badge>
          </div>
          <div className="flex items-end">
            <div className="text-3xl font-bold">
              {truncateValue(row.original.latestShortPosition, 6)}
            </div>
            <div className="text-lg ">%</div>
          </div>
        </div>
      </div>
    ),
    enableSorting: true,
    enableHiding: false,
  },
  {
    id: "sparkline",
    header: ({}) => (
      <div className="h-full flex items-center justify-center">
        last 6 months
      </div>
    ),
    cell: ({ row }) => (
      <div className="w-full h-full flex items-center justify-center">
        <Sparkline data={row.original} />
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
    size: 200,
  },
];
