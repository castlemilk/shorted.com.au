"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";
import { StockNewsFeed } from "./stock-news-feed";
import { RelatedNewsRail } from "./related-news-rail";
import { StockConnections } from "./stock-connections";
import { StockSignals } from "./stock-signals";
import { StockVerdict } from "./stock-verdict";
import { CompanyTaxCard } from "./company-tax-card";
import { DirectorTradesTable } from "./director-trades-table";
import { DividendHistory } from "./dividend-history";
import { PeerComparisonTable } from "./peer-comparison-table";
import { EventTimeline } from "./event-timeline";

interface StockTabsProps {
  stockCode: string;
  /** Main insight column of the overview tab (server-rendered slot). */
  overviewMain?: ReactNode;
  /** Compact profile rail of the overview tab (server-rendered slot). */
  overviewRail?: ReactNode;
  financialsContent?: ReactNode;
  communityContent?: ReactNode;
}

export function StockTabs({
  stockCode,
  overviewMain,
  overviewRail,
  financialsContent,
  communityContent,
}: StockTabsProps) {
  const searchParams = useSearchParams();
  const availableTabs = useMemo(
    () =>
      [
        "overview",
        communityContent ? "community" : null,
        "news",
        "timeline",
        "financials",
        "directors",
        "dividends",
        "peers",
      ].filter((tab): tab is string => Boolean(tab)),
    [communityContent],
  );

  const requestedTab = searchParams.get("tab");
  const initialTab =
    requestedTab && availableTabs.includes(requestedTab)
      ? requestedTab
      : "overview";
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    if (requestedTab && availableTabs.includes(requestedTab)) {
      setActiveTab(requestedTab);
    }
  }, [availableTabs, requestedTab]);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        {communityContent ? (
          <TabsTrigger value="community">Community</TabsTrigger>
        ) : null}
        <TabsTrigger value="news">News</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="financials">Financials</TabsTrigger>
        <TabsTrigger value="directors">Directors</TabsTrigger>
        <TabsTrigger value="dividends">Dividends</TabsTrigger>
        <TabsTrigger value="peers">Peers</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
          <div className="flex min-w-0 flex-col gap-4 md:gap-6">
            {overviewMain}
            <StockVerdict stockCode={stockCode} />
            <CompanyTaxCard stockCode={stockCode} />
            <StockSignals stockCode={stockCode} />
            <StockConnections stockCode={stockCode} />
          </div>
          <div className="flex min-w-0 flex-col gap-4 md:gap-6">
            {overviewRail}
          </div>
        </div>
      </TabsContent>

      {communityContent ? (
        <TabsContent value="community">
          {communityContent}
        </TabsContent>
      ) : null}

      <TabsContent value="news">
        <div className="space-y-4">
          <StockNewsFeed stockCode={stockCode} limit={20} />
          <RelatedNewsRail stockCode={stockCode} limit={6} />
        </div>
      </TabsContent>

      <TabsContent value="timeline">
        <EventTimeline stockCode={stockCode} />
      </TabsContent>

      <TabsContent value="financials">
        {financialsContent}
      </TabsContent>

      <TabsContent value="directors">
        <DirectorTradesTable stockCode={stockCode} />
      </TabsContent>

      <TabsContent value="dividends">
        <DividendHistory stockCode={stockCode} />
      </TabsContent>

      <TabsContent value="peers">
        <PeerComparisonTable stockCode={stockCode} />
      </TabsContent>
    </Tabs>
  );
}
