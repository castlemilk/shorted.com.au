"use client";

import { type ReactNode, type ReactElement, Children, isValidElement } from "react";
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

export function StockTabsOverview({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function StockTabsFinancials({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

interface StockTabsProps {
  stockCode: string;
  children: ReactNode;
  /** @deprecated Use StockTabs.Overview and StockTabs.Financials children instead */
  overviewContent?: ReactNode;
  /** @deprecated Use StockTabs.Overview and StockTabs.Financials children instead */
  financialsContent?: ReactNode;
}

export function StockTabs({
  stockCode,
  children,
  overviewContent,
  financialsContent,
}: StockTabsProps) {
  // Extract Overview and Financials from children
  let resolvedOverview: ReactNode = overviewContent;
  let resolvedFinancials: ReactNode = financialsContent;

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === StockTabsOverview) {
      resolvedOverview = (child as ReactElement<{ children: ReactNode }>).props.children;
    } else if (child.type === StockTabsFinancials) {
      resolvedFinancials = (child as ReactElement<{ children: ReactNode }>).props.children;
    }
  });

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
        {resolvedOverview}
      </TabsContent>

      <TabsContent value="news">
        <StockNewsFeed stockCode={stockCode} limit={20} />
      </TabsContent>

      <TabsContent value="financials">
        {resolvedFinancials}
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

