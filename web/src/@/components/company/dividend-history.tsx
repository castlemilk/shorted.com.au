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
import { DollarSign } from "lucide-react";

interface DividendHistoryProps {
  stockCode: string;
  years?: number;
}

const dividendTypeStyles: Record<string, string> = {
  ordinary: "bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-400",
  special:
    "bg-purple-100 text-purple-800 dark:bg-purple-950/30 dark:text-purple-400",
  interim:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-400",
  final:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400",
};

export function DividendHistory({
  stockCode,
  years = 5,
}: DividendHistoryProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dividend-history", stockCode, years],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(ShortedStocksService, transport);
      return client.getDividendHistory({ stockCode, years });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Dividends
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data?.dividends?.length) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Dividends
          </CardTitle>
          <CardDescription>No dividend history available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Dividends
        </CardTitle>
        <CardDescription>
          {data.totalCount} dividend{data.totalCount !== 1 ? "s" : ""} in last{" "}
          {years} years
          {data.trailingYield > 0 && (
            <span className="ml-2 font-medium text-emerald-700 dark:text-emerald-400">
              Trailing yield: ${data.trailingYield.toFixed(4)}/share
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ex-Date</TableHead>
              <TableHead>Payment Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount/Share</TableHead>
              <TableHead className="text-right">Franking</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.dividends.map((div) => (
              <TableRow key={div.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {div.exDate}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {div.paymentDate || "-"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-xs border-0 ${dividendTypeStyles[div.dividendType] ?? ""}`}
                  >
                    {div.dividendType}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-sm font-medium tabular-nums">
                  ${div.amountPerShare.toFixed(4)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {div.frankingPercentage > 0
                    ? `${div.frankingPercentage.toFixed(0)}%`
                    : "Unfranked"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
