import { formatNumber } from "~/@/lib/utils";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { TrendingDown, RefreshCwIcon } from "lucide-react";

/**
 * Shared presentational view for the "Short position" stats card.
 *
 * Rendered by BOTH the server component (companyStats.tsx) and the client
 * retry twin (company-stats-with-retry.tsx) so the markup lives in exactly
 * one place. Keep this module free of a "use client" directive and free of
 * any @connectrpc/connect imports — it must stay renderable from server
 * import chains.
 */
export function CompanyStatsView({ stock }: { stock: Stock }) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingDown className="h-5 w-5" />
          Short position
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between text-xs">
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            short percentage
          </span>
          <span className="font-bold text-sm tabular-nums">
            {stock.percentageShorted.toFixed(2)}%
          </span>
        </div>
        <Separator className="my-2 opacity-50" />
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            reported shorts
          </span>
          <span className="font-medium tabular-nums">
            {formatNumber(stock.reportedShortPositions)}
          </span>
        </div>
        <Separator className="my-2 opacity-50" />
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            shares on issue
          </span>
          <span className="font-medium tabular-nums">
            {formatNumber(stock.totalProductInIssue, 3)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Shared skeleton — the server placeholder AND the client loading state.
 * `isRetrying` adds the client-side retry spinner next to the title.
 */
export function CompanyStatsSkeleton({
  isRetrying,
}: {
  isRetrying?: boolean;
}) {
  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingDown className="h-5 w-5" />
          Short position
          {isRetrying && (
            <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs">
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            short percentage
          </span>
          <Skeleton className="w-[40px] h-[15px]" />
        </div>
        <Separator className="my-2 opacity-50" />
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            reported shorts
          </span>
          <Skeleton className="w-[40px] h-[15px]" />
        </div>
        <Separator className="my-2 opacity-50" />
        <div className="flex items-center justify-between">
          <span className="uppercase font-semibold text-muted-foreground">
            shares on issue
          </span>
          <Skeleton className="w-[40px] h-[15px]" />
        </div>
      </CardContent>
    </Card>
  );
}
