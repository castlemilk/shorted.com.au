"use client";

import React from "react";
import Script from "next/script";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { useSession } from "next-auth/react";
import { TopShorts } from "./topShortsView/topShorts";
import { IndustryTreeMapView } from "./treemap/treeMap";

type IndustryTreeMapData = IndustryTreeMap | null | undefined;
type TimeSeriesDataArray = TimeSeriesData[] | undefined;

interface ClientPageProps {
  initialTopShortsData?: TimeSeriesDataArray;
  initialTreeMapData?: IndustryTreeMapData;
}

/**
 * Client component for the homepage
 * Handles all client-side interactivity while receiving SSR data as props
 */
export function ClientPage({
  initialTopShortsData,
  initialTreeMapData,
}: ClientPageProps) {
  const { data: session } = useSession();

  return (
    <>
      {/* Google Analytics */}
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=G-X85RLQ4N2N`}
        strategy="afterInteractive"
        id="google-analytics"
      />
      <Script
        id="google-analytics-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-X85RLQ4N2N');
          `,
        }}
      />

      {/* Login prompt banner for non-authenticated users */}
      {!session && <LoginPromptBanner />}

      {/* Main dashboard view */}
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts
            initialPeriod="3m"
            initialShortsData={initialTopShortsData}
          />
        </div>
        <div className="lg:w-3/5">
          <IndustryTreeMapView
            initialPeriod="3m"
            initialViewMode={ViewMode.CURRENT_CHANGE}
            initialTreeMapData={initialTreeMapData ?? undefined}
          />
        </div>
      </div>
    </>
  );
}

