"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { DataTableColumnDisplayHeader } from "./data-table-column-display-header";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { SparkLine } from "./sparkline";
import { Button } from "~/@/components/ui/button";
import { ArrowUpDown } from "lucide-react";

// Use semantic colors for min/max indicators - these stay red/green regardless of theme
const redColor = `var(--semantic-red)`;
const greenColor = `var(--semantic-green)`;

const truncateValue = (value: number, maxLength: number) => {
  const formatted = value.toFixed(2);
  if (formatted.length <= maxLength) return formatted;
  if (maxLength < 4) return "...";
  return (
    value.toFixed(0) + (value.toFixed(0).length > maxLength - 1 ? "..." : "")
  );
};

// Restore full columns
export const columns: ColumnDef<TimeSeriesData>[] = [
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
        <div className="h-full flex items-center justify-center">
          {" "}
          {/* Added wrapper div */}
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
    cell: ({ row }) => {
      const data = row.original;
      const minValue = data.min?.shortPosition ?? 0;
      const maxValue = data.max?.shortPosition ?? 0;
      const latestValue = data.latestShortPosition ?? 0;
      return (
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-2">
            {/* Min/Max indicators */}
            <div className="flex gap-3">
              {/* Min badge */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border/50">
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: greenColor }}
                />
                <span className="text-xs text-muted-foreground font-medium">
                  {minValue.toFixed(1)}%
                </span>
              </div>
              {/* Max badge */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border/50">
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: redColor }}
                />
                <span className="text-xs text-muted-foreground font-medium">
                  {maxValue.toFixed(1)}%
                </span>
              </div>
            </div>
            {/* Current value */}
            <div className="flex items-baseline gap-0.5">
              <span className="text-2xl font-bold tabular-nums">
                {latestValue.toFixed(2)}
              </span>
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>
      );
    },
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
      <div className="w-full h-full flex items-center justify-center px-1">
        <SparkLine data={row.original} strategy="observer" minWidth={160} />
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
    size: 200,
  },
];
