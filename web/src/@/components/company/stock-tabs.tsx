"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";
import { StockNewsTab } from "./stock-news-tab";
import { StockConnections } from "./stock-connections";
import { StockSignals } from "./stock-signals";
import { StockVerdict } from "./stock-verdict";
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
  const pathname = usePathname();
  const tabsListRef = useRef<HTMLDivElement>(null);
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

  // Keep ?tab= in sync so tabs stay deep-linkable after client navigation.
  // Shallow history API, NOT router.replace: this page is force-dynamic, so a
  // router navigation would re-execute the entire server page (all stock RPCs)
  // on every tab click just to update a query param.
  const handleTabChange = useCallback(
    (value: string) => {
      setActiveTab(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value === "overview") {
        params.delete("tab");
      } else {
        params.set("tab", value);
      }
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        query ? `${pathname}?${query}` : pathname,
      );
    },
    [pathname, searchParams],
  );

  // The 8-trigger TabsList overflows horizontally on mobile; when a tab is
  // deep-linked (?tab=peers) make sure its trigger is scrolled into view.
  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    if (
      active.offsetLeft + active.offsetWidth >
        list.scrollLeft + list.clientWidth ||
      active.offsetLeft < list.scrollLeft
    ) {
      list.scrollTo({ left: active.offsetLeft - 16 });
    }
  }, [activeTab]);

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      <TabsList
        ref={tabsListRef}
        className="w-full justify-start overflow-x-auto"
      >
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

      {/* gap columns: widgets that resolve to null (verdict flag off, no
          signals/graph data) contribute no stray spacing. Tax card lives on
          the Financials tab. */}
      <TabsContent value="overview">
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
          <div className="flex min-w-0 flex-col gap-4 md:gap-6">
            {overviewMain}
            <StockVerdict stockCode={stockCode} />
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
        <StockNewsTab stockCode={stockCode} />
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
