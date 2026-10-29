"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowUpRight } from "lucide-react";

import { siteConfig } from "~/@/config/site";
import { Icons } from "~/@/components/ui/icons";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import type {
  ChartPeriod,
  ChartViewId,
} from "~/@/components/charts/chart-views";

const chartFallback = (
  <div className="h-full w-full p-2">
    <div className="h-full w-full animate-pulse rounded bg-muted" />
  </div>
);

// Client-only: the chart's data hooks reach @connectrpc, which cannot SSR.
const StockChartEmbed = dynamic(
  () =>
    import("~/@/components/charts/StockChartEmbed").then(
      (m) => m.StockChartEmbed,
    ),
  { ssr: false, loading: () => chartFallback },
);

export interface ChartShareViewProps {
  code: string;
  view: ChartViewId;
  period: ChartPeriod;
  company: string | null;
  /** Open turned sideways on a portrait phone (`?landscape=1`). */
  startLandscape?: boolean;
}

/**
 * The share page's body: a slim bar (brand, and the stock page the chart came
 * from) over the chart, which takes the rest of the screen. The page drops the
 * site header and footer (conditional-header.tsx) so the chart gets the room,
 * and on a portrait phone the chart offers a landscape mode.
 */
export function ChartShareView({
  code,
  view,
  period,
  company,
  startLandscape = false,
}: ChartShareViewProps) {
  // The short-only view came from the Short interest tab; the others from
  // the Overview, whose chart is the combined one.
  const stockHref = stockTabHref(
    code,
    view === "short" ? "short-interest" : "overview",
  );

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <Link
          href="/"
          prefetch={false}
          className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold"
        >
          <Icons.logo className="h-6 w-6" />
          {siteConfig.name}
        </Link>
        <Link
          href={stockHref}
          prefetch={false}
          className="inline-flex min-h-10 min-w-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="truncate">
            {company ? `${company} (${code})` : code}
          </span>
          <ArrowUpRight aria-hidden className="h-4 w-4 shrink-0" />
        </Link>
      </header>
      <main className="min-h-0 flex-1">
        <StockChartEmbed
          stockCode={code}
          defaultView={view}
          defaultPeriod={period}
          allowLandscape
          startLandscape={startLandscape}
        />
      </main>
    </div>
  );
}
