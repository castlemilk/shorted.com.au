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
import { DirectorTradesTable } from "./director-trades-table";
import { DividendHistory } from "./dividend-history";
import { PeerComparisonTable } from "./peer-comparison-table";
import { EventTimeline } from "./event-timeline";

interface StockTabsProps {
  stockCode: string;
  overviewContent?: ReactNode;
  financialsContent?: ReactNode;
  communityContent?: ReactNode;
}

export function StockTabs({
  stockCode,
  overviewContent,
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
        {overviewContent}
        <div className="mt-4 md:mt-6">
          <StockVerdict stockCode={stockCode} />
        </div>
        <div className="mt-4 md:mt-6">
          <StockSignals stockCode={stockCode} />
        </div>
        <div className="mt-4 md:mt-6">
          <StockConnections stockCode={stockCode} />
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
