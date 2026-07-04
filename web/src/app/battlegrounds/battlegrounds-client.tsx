"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BattlegroundView } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getBattlegroundsClient } from "~/app/actions/client/getBattlegroundsClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "~/@/components/ui/tabs";
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { cn } from "~/@/lib/utils";
import { normalizedLogoUrl } from "~/@/lib/logo";
import { toBattlegroundRows, type BattlegroundRow } from "./types";

const PAGE_LIMIT = 25;

type ViewKey = "squeeze" | "divergence";

const VIEW_TO_ENUM: Record<ViewKey, BattlegroundView> = {
  squeeze: BattlegroundView.SQUEEZE,
  divergence: BattlegroundView.DIVERGENCE,
};

interface BattlegroundsClientProps {
  /** SSR-fetched squeeze view rows; undefined when the server fetch failed */
  initialRows?: BattlegroundRow[];
  initialTotalCount?: number;
}

interface ViewData {
  rows: BattlegroundRow[];
  totalCount: number;
}

function formatPercent(value: number, signed = false): string {
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatPrice(value: number): string {
  if (value <= 0) return "—";
  return `$${value.toFixed(2)}`;
}

function changeColor(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function ScoreBadge({ score }: { score: number }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono tabular-nums",
        score >= 70
          ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          : score >= 40
            ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {score.toFixed(1)}
    </Badge>
  );
}

function StockLogo({ stockCode }: { stockCode: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
        {stockCode.slice(0, 3)}
      </div>
    );
  }
  return (
    <Image
      src={normalizedLogoUrl(stockCode)}
      alt={`${stockCode} logo`}
      width={28}
      height={28}
      className="h-7 w-7 shrink-0 rounded bg-white object-contain"
      onError={() => setErrored(true)}
      unoptimized
    />
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 10 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function BattlegroundsClient({
  initialRows,
  initialTotalCount,
}: BattlegroundsClientProps) {
  const [view, setView] = useState<ViewKey>("squeeze");

  const initialData: ViewData | undefined =
    initialRows !== undefined
      ? { rows: initialRows, totalCount: initialTotalCount ?? initialRows.length }
      : undefined;

  const { data, isLoading, isError } = useQuery<ViewData>({
    queryKey: ["battlegrounds", view, PAGE_LIMIT],
    queryFn: async () => {
      const response = await getBattlegroundsClient(
        VIEW_TO_ENUM[view],
        PAGE_LIMIT,
        0,
      );
      return {
        rows: toBattlegroundRows(response.stocks),
        totalCount: response.totalCount,
      };
    },
    // Only the squeeze view is SSR-prefetched
    ...(view === "squeeze" && initialData ? { initialData } : {}),
    staleTime: 5 * 60 * 1000,
  });

  const isSqueeze = view === "squeeze";
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-4">
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as ViewKey)}
      >
        <TabsList>
          <TabsTrigger value="squeeze">Squeeze radar</TabsTrigger>
          <TabsTrigger value="divergence">Battlegrounds</TabsTrigger>
        </TabsList>
      </Tabs>

      <p className="text-sm text-muted-foreground max-w-3xl">
        {isSqueeze
          ? "Stocks ranked by squeeze risk — a 0-100 score combining days-to-cover, short interest, recent price momentum, and short-position crowding."
          : "Live bull-vs-bear conflicts — stocks where the price is rising while short sellers keep building positions. Ranked by divergence intensity (0-100)."}
      </p>

      {isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-muted-foreground">
          Failed to load battleground data. Please try again shortly.
        </div>
      ) : isLoading && rows.length === 0 ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">
          {isSqueeze
            ? "No stocks currently match the squeeze criteria."
            : "No divergences right now — no stocks with a rising price and building short positions."}
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stock</TableHead>
                <TableHead className="hidden md:table-cell">Industry</TableHead>
                <TableHead className="text-right">Short %</TableHead>
                <TableHead className="text-right">Δ Short 4w</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Δ Price 1m</TableHead>
                <TableHead className="text-right hidden sm:table-cell">
                  Days to cover
                </TableHead>
                <TableHead className="text-right">
                  {isSqueeze ? "Squeeze score" : "Divergence"}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.stockCode}>
                  <TableCell>
                    <Link
                      href={`/shorts/${row.stockCode}`}
                      className="flex items-center gap-2.5 group"
                    >
                      <StockLogo stockCode={row.stockCode} />
                      <span className="flex flex-col">
                        <span className="font-semibold group-hover:underline">
                          {row.stockCode}
                        </span>
                        <span className="text-xs text-muted-foreground line-clamp-1 max-w-[180px]">
                          {row.companyName}
                        </span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {row.industry || "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatPercent(row.shortPct)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono tabular-nums",
                      // Shorts building = bearish pressure = red
                      changeColor(-row.shortPctChange4w),
                    )}
                  >
                    {formatPercent(row.shortPctChange4w, true)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatPrice(row.latestPrice)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono tabular-nums",
                      changeColor(row.priceChange1m),
                    )}
                  >
                    {formatPercent(row.priceChange1m, true)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums hidden sm:table-cell">
                    {row.daysToCover > 0 ? row.daysToCover.toFixed(1) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <ScoreBadge
                      score={isSqueeze ? row.squeezeScore : row.divergenceScore}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.totalCount > rows.length && (
        <p className="text-xs text-muted-foreground">
          Showing top {rows.length} of {data.totalCount} matching stocks.
        </p>
      )}
    </div>
  );
}
