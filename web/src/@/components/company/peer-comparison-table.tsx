"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/@/registry/new-york/ui/avatar";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Skeleton } from "~/@/components/ui/skeleton";
import { GitCompare, RefreshCw } from "lucide-react";
import Link from "next/link";
import { cn } from "~/@/lib/utils";

interface PeerComparisonTableProps {
  stockCode: string;
  limit?: number;
}

export function PeerComparisonTable({
  stockCode,
  limit = 5,
}: PeerComparisonTableProps) {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["peer-comparison", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(StockService, transport);
      return client.getPeerComparison({ stockCode, limit });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Peer comparison
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-12" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <div className="ml-auto flex items-center gap-6">
                  <div className="space-y-1.5">
                    <Skeleton className="ml-auto h-3.5 w-12" />
                    <Skeleton className="ml-auto h-1 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-3.5 w-12" />
                  <Skeleton className="hidden h-3.5 w-14 md:block" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Peer comparison
          </CardTitle>
          <CardDescription>Failed to load peer comparison</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", isRefetching && "animate-spin")}
            />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data?.peers?.length) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Peer comparison
          </CardTitle>
          <CardDescription>No industry peers found</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const allStocks = [
    ...(data.subject ? [{ ...data.subject, isSubject: true }] : []),
    ...data.peers.map((p) => ({ ...p, isSubject: false })),
  ];

  const maxShortPercent = Math.max(
    ...allStocks.map((s) => s.shortPositionPercent),
    0,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <GitCompare className="h-5 w-5" />
          Peer comparison
        </CardTitle>
        <CardDescription>
          {data.peers.length} largest {data.industry} peer
          {data.peers.length !== 1 ? "s" : ""} by market cap
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead className="text-right">Short %</TableHead>
              <TableHead className="text-right">1M Change</TableHead>
              <TableHead className="text-right hidden sm:table-cell">
                Market Cap
              </TableHead>
              <TableHead className="text-right hidden md:table-cell">
                P/E
              </TableHead>
              <TableHead className="text-right hidden md:table-cell">
                Div Yield
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allStocks.map((stock) => (
              <TableRow
                key={stock.stockCode}
                className={stock.isSubject ? "bg-primary/5 font-medium" : ""}
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="h-7 w-7 shrink-0 ring-1 ring-black/10 dark:ring-white/10">
                      <AvatarImage
                        src={stock.logoUrl || undefined}
                        alt={`${stock.companyName || stock.stockCode} logo`}
                      />
                      <AvatarFallback className="text-[10px] font-medium">
                        {stock.stockCode.slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/shorts/${stock.stockCode}`}
                          className="text-primary hover:underline font-mono text-sm"
                        >
                          {stock.stockCode}
                        </Link>
                        {stock.isSubject && (
                          <Badge
                            variant="outline"
                            className="px-1.5 py-0 text-[10px] font-medium"
                          >
                            This stock
                          </Badge>
                        )}
                      </div>
                      <div className="max-w-[110px] truncate text-xs text-muted-foreground sm:max-w-[200px]">
                        {stock.companyName}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {stock.shortPositionPercent > 0 ? (
                    <>
                      {stock.shortPositionPercent.toFixed(2)}%
                      <span className="mt-1 flex w-16 ml-auto justify-end">
                        <span
                          className="h-1 rounded-full bg-primary/40"
                          style={{
                            width:
                              maxShortPercent > 0
                                ? `${Math.max(
                                    (stock.shortPositionPercent /
                                      maxShortPercent) *
                                      100,
                                    3,
                                  )}%`
                                : "0%",
                          }}
                        />
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-sm tabular-nums",
                    stock.priceChange1m > 0 &&
                      "text-emerald-700 dark:text-emerald-400",
                    stock.priceChange1m < 0 &&
                      "text-red-700 dark:text-red-400",
                  )}
                >
                  {stock.priceChange1m !== 0
                    ? `${stock.priceChange1m > 0 ? "+" : ""}${stock.priceChange1m.toFixed(1)}%`
                    : "—"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums hidden sm:table-cell">
                  {stock.marketCap > 0 ? formatMarketCap(stock.marketCap) : "—"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums hidden md:table-cell">
                  {stock.peRatio > 0 ? stock.peRatio.toFixed(1) : "—"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums hidden md:table-cell">
                  {stock.dividendYield > 0
                    ? `${stock.dividendYield.toFixed(2)}%`
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatMarketCap(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toLocaleString()}`;
}
