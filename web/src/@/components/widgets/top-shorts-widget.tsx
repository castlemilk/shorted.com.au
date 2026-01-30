"use client";

import { useState } from "react";
import { type WidgetProps, type TopShortsSettings, WidgetType } from "~/@/types/dashboard";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { columns } from "~/app/topShortsView/components/columns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { Skeleton } from "~/@/components/ui/skeleton";
import { cn } from "~/@/lib/utils";
import { useTopShorts } from "~/@/hooks/use-stock-queries";
import { getTypedSettings } from "~/@/lib/widget-settings";
import { useWidgetVisibility } from "~/@/hooks/use-widget-visibility";
import { ScrollArea, ScrollBar } from "~/@/components/ui/scroll-area";
import { Card } from "~/@/components/ui/card";
import { TrendingDown, TrendingUp } from "lucide-react";

export function TopShortsWidget({ config, sizeVariant = "standard" }: WidgetProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const router = useRouter();
  const { ref, hasBeenVisible } = useWidgetVisibility();

  // Get typed settings with defaults
  const settings = getTypedSettings(WidgetType.TOP_SHORTS, config.settings as Partial<TopShortsSettings>);
  const { period, limit } = settings;

  // Use TanStack Query for data fetching
  const { data: shortsData = [], isLoading, isError } = useTopShorts(
    period,
    limit
  );

  // Only fetch when visible (lazy loading)
  const shouldFetch = hasBeenVisible;

  const table = useReactTable({
    data: shortsData,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Compact mode: horizontal scrollable cards
  if (sizeVariant === "compact") {
    if (isLoading || !shouldFetch) {
      return (
        <div ref={ref} className="h-full p-2">
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Card key={i} className="p-3 min-w-[140px]">
                  <Skeleton className="h-4 w-12 mb-2" />
                  <Skeleton className="h-6 w-16 mb-1" />
                  <Skeleton className="h-3 w-8" />
                </Card>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
      );
    }

    return (
      <div ref={ref} className="h-full p-2">
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex gap-2">
            {shortsData.slice(0, 8).map((stock, index) => {
              const stockData = stock as TimeSeriesData & { percentageShorted?: number; shortPercentageChange?: number };
              const percentageShorted = stockData.percentageShorted ?? 0;
              const change = stockData.shortPercentageChange ?? 0;
              const isUp = change > 0;

              return (
                <Card
                  key={stock.productCode ?? index}
                  className="p-3 min-w-[140px] cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => router.push(`/shorts/${stock.productCode}`)}
                >
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-xs text-muted-foreground">#{index + 1}</span>
                    <span className="font-semibold text-sm">{stock.productCode}</span>
                  </div>
                  <div className="text-lg font-bold">{percentageShorted.toFixed(1)}%</div>
                  <div className={cn(
                    "flex items-center gap-0.5 text-xs",
                    isUp ? "text-red-500" : "text-green-500"
                  )}>
                    {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                  </div>
                </Card>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    );
  }

  // Standard/Expanded mode: table view
  if (isLoading || !shouldFetch) {
    return (
      <div ref={ref} className="h-full overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              <TableHead className="text-xs w-12">Rank</TableHead>
              <TableHead className="text-xs">Company</TableHead>
              <TableHead className="text-xs">Short %</TableHead>
              <TableHead className="text-xs">Last {period}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: limit }).map((_, index) => (
              <TableRow key={index}>
                <TableCell className="text-xs p-2">
                  <Skeleton className="h-4 w-8" />
                </TableCell>
                <TableCell className="text-xs p-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-10 w-10 rounded" />
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-xs p-2">
                  <div className="flex items-center justify-center">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-20 mb-1" />
                      <Skeleton className="h-4 w-20 mb-2" />
                      <Skeleton className="h-8 w-24" />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-xs p-2">
                  <Skeleton className="h-[140px] w-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (isError) {
    return (
      <div ref={ref} className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Failed to load data</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="h-full overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="text-xs">
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.id === "sparkline"
                          ? () => `Last ${period}`
                          : header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() =>
                  router.push(
                    `/shorts/${(row.original as { productCode: string }).productCode}`,
                  )
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      "text-xs p-2",
                      cell.column.id === "sparkline" && "overflow-hidden",
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
