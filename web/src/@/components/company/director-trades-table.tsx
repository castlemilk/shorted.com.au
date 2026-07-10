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
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Users, ExternalLink } from "lucide-react";

interface DirectorTradesTableProps {
  stockCode: string;
  limit?: number;
}

const tradeTypeStyles: Record<string, string> = {
  buy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400",
  sell: "bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-400",
  exercise_options:
    "bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-400",
};

export function DirectorTradesTable({
  stockCode,
  limit = 20,
}: DirectorTradesTableProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["director-trades", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(ShortedStocksService, transport);
      return client.getDirectorTrades({ stockCode, limit });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Director trades
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

  if (isError || !data?.trades?.length) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Director trades
          </CardTitle>
          <CardDescription>No director trades found</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-5 w-5" />
          Director trades
        </CardTitle>
        <CardDescription>
          {data.totalCount} trade{data.totalCount !== 1 ? "s" : ""} recorded
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Director</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Shares</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.trades.map((trade) => (
              <TableRow key={trade.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {trade.tradeDate}
                </TableCell>
                <TableCell className="font-medium text-sm">
                  {trade.directorName}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-xs border-0 ${tradeTypeStyles[trade.tradeType] ?? ""}`}
                  >
                    {trade.tradeType.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.sharesTraded
                    ? Number(trade.sharesTraded).toLocaleString()
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.pricePerShare
                    ? `$${trade.pricePerShare.toFixed(3)}`
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.totalValue
                    ? `$${Number(trade.totalValue).toLocaleString()}`
                    : "-"}
                </TableCell>
                <TableCell>
                  {trade.announcementUrl && (
                    <a
                      href={trade.announcementUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
