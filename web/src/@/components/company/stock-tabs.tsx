"use client";

import { ReactNode } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";
import { StockNewsFeed } from "./stock-news-feed";
import { DirectorTradesTable } from "./director-trades-table";
import { DividendHistory } from "./dividend-history";
import { PeerComparisonTable } from "./peer-comparison-table";

interface StockTabsProps {
  stockCode: string;
  overviewContent: ReactNode;
  financialsContent: ReactNode;
}

export function StockTabs({
  stockCode,
  overviewContent,
  financialsContent,
}: StockTabsProps) {
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="news">News</TabsTrigger>
        <TabsTrigger value="financials">Financials</TabsTrigger>
        <TabsTrigger value="directors">Directors</TabsTrigger>
        <TabsTrigger value="dividends">Dividends</TabsTrigger>
        <TabsTrigger value="peers">Peers</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        {overviewContent}
      </TabsContent>

      <TabsContent value="news">
        <StockNewsFeed stockCode={stockCode} limit={20} />
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
