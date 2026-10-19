"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { parseEmbedChartParams } from "./params";

// 100dvh, not 100vh: opened on its own in a phone browser, 100vh is the height
// with the toolbars hidden, so the bottom of the chart (its time axis) sat
// under Safari's toolbar. In an iframe the two are the same.
const fallback = (
  <div className="h-[100dvh] w-full p-2">
    <div className="h-full w-full animate-pulse rounded bg-muted" />
  </div>
);

const StockChartEmbed = dynamic(
  () =>
    import("~/@/components/charts/StockChartEmbed").then(
      (m) => m.StockChartEmbed,
    ),
  { ssr: false, loading: () => fallback },
);

/** null until mounted: whether the page is framed by another page. */
function useFramed(): boolean | null {
  const [framed, setFramed] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setFramed(window.self !== window.top);
    } catch {
      setFramed(true); // a cross-origin parent that refuses even the compare
    }
  }, []);
  return framed;
}

function EmbedChartInner() {
  const { code, view, period } = parseEmbedChartParams(useSearchParams());
  const framed = useFramed();
  return (
    // The iframe IS the viewport: fill it, and let the chart take what is left.
    <div className="h-[100dvh] w-full overflow-auto">
      <StockChartEmbed
        // Remount on a param change so the period state resets with the URL.
        key={`${code}:${view}:${period}`}
        stockCode={code}
        defaultView={view}
        defaultPeriod={period}
        // Framed: a way out to the full-screen share page. Opened on its own
        // (a link to the iframe's src, as in a pasted snippet): landscape.
        expandable={framed === true}
        allowLandscape={framed === false}
      />
    </div>
  );
}

/**
 * Embeddable per-stock chart: short interest (default), share price, or both.
 *
 *   <iframe src="https://shorted.com.au/embed/chart?code=BHP" />
 *   <iframe src="https://shorted.com.au/embed/chart?code=BHP&view=combined&period=6m" />
 *
 * Snippets are built by ~/@/lib/embed/snippet; params are parsed by ./params.
 * The page to SHARE (in a chat, a post) is /chart/<code>, not this one.
 */
export default function EmbedChart() {
  return (
    <Suspense fallback={fallback}>
      <EmbedChartInner />
    </Suspense>
  );
}
