"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "@/types/dashboard";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { columns } from "~/app/topShortsView/components/columns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";

export function TopShortsWidget({ config }: WidgetProps) {
  const [loading, setLoading] = useState(true);
  const [shortsData, setShortsData] = useState<PlainMessage<TimeSeriesData>[]>([]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const router = useRouter();
  
  const period = (config.settings?.period as string) || "3m";
  const limit = (config.settings?.limit as number) || 10;

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const data = await getTopShortsData(period, limit, 0);
        setShortsData(data.timeSeries);
      } catch (error) {
        console.error("Error fetching top shorts data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
    
    // Set up refresh interval if configured
    if (config.dataSource.refreshInterval) {
      const interval = setInterval(() => void fetchData(), config.dataSource.refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [period, limit, config.dataSource.refreshInterval]);

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

  if (loading) {
    return <div className="animate-pulse">Loading top shorts...</div>;
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background">
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
                    `/shorts/${(row.original as { productCode: string }).productCode}`
                  )
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="text-xs p-2">
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