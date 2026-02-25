"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
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
import { Skeleton } from "~/@/components/ui/skeleton";
import { GitCompare } from "lucide-react";
import Link from "next/link";

interface PeerComparisonTableProps {
  stockCode: string;
  limit?: number;
}

export function PeerComparisonTable({
  stockCode,
  limit = 5,
}: PeerComparisonTableProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["peer-comparison", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(ShortedStocksService, transport);
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
            Peer Comparison
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data?.peers?.length) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Peer Comparison
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <GitCompare className="h-5 w-5" />
          Peer Comparison
        </CardTitle>
        <CardDescription>
          {data.industry} sector &mdash; {data.peers.length} peer
          {data.peers.length !== 1 ? "s" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Company</TableHead>
              <TableHead className="text-right">Short %</TableHead>
              <TableHead className="text-right">Market Cap</TableHead>
              <TableHead className="text-right">P/E</TableHead>
              <TableHead className="text-right">Div Yield</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allStocks.map((stock) => (
              <TableRow
                key={stock.stockCode}
                className={
                  stock.isSubject
                    ? "bg-primary/5 font-medium"
                    : ""
                }
              >
                <TableCell>
                  <Link
                    href={`/shorts/${stock.stockCode}`}
                    className="text-primary hover:underline font-mono text-sm"
                  >
                    {stock.stockCode}
                  </Link>
                </TableCell>
                <TableCell className="text-sm max-w-[200px] truncate">
                  {stock.companyName}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {stock.shortPositionPercent > 0
                    ? `${stock.shortPositionPercent.toFixed(2)}%`
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {stock.marketCap > 0
                    ? formatMarketCap(stock.marketCap)
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {stock.peRatio > 0 ? stock.peRatio.toFixed(1) : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {stock.dividendYield > 0
                    ? `${stock.dividendYield.toFixed(2)}%`
                    : "-"}
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
