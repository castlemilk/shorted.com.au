"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";

// This shell SSRs ON PURPOSE (the stock page is ISR): the server-rendered
// overview slots (overviewMain/overviewRail — peers, short-interest history,
// headlines, hub links) must land in the served HTML for crawlers, and the
// default radix tab panel renders during SSR. The tab CHILDREN below import
// @connectrpc/connect (module init crashes SSR — see CLAUDE.md), so they are
// lazy client-only imports resolved after hydration; non-default tabs are
// client-data surfaces anyway.
const StockNewsTab = dynamic(
  () => import("./stock-news-tab").then((m) => m.StockNewsTab),
  { ssr: false },
);
const StockConnections = dynamic(
  () => import("./stock-connections").then((m) => m.StockConnections),
  { ssr: false },
);
const StockSignals = dynamic(
  () => import("./stock-signals").then((m) => m.StockSignals),
  { ssr: false },
);
const StockVerdict = dynamic(
  () => import("./stock-verdict").then((m) => m.StockVerdict),
  { ssr: false },
);
const DirectorTradesTable = dynamic(
  () => import("./director-trades-table").then((m) => m.DirectorTradesTable),
  { ssr: false },
);
const DividendHistory = dynamic(
  () => import("./dividend-history").then((m) => m.DividendHistory),
  { ssr: false },
);
const PeerComparisonTable = dynamic(
  () => import("./peer-comparison-table").then((m) => m.PeerComparisonTable),
  { ssr: false },
);
const EventTimeline = dynamic(
  () => import("./event-timeline").then((m) => m.EventTimeline),
  { ssr: false },
);

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
  const tabsListRef = useRef<HTMLDivElement>(null);
  // SSR always renders the overview panel (the crawlable default).
  // NOTE: deliberately NOT useSearchParams() — on this static/ISR route it
  // would force a CSR bailout that strips the overview HTML from the SSR
  // output, defeating the whole point of the SSR'd shell. The ?tab= deep
  // link is applied after mount instead.
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (!requested || requested === "overview") return;
    const available = [
      "overview",
      ...(communityContent ? ["community"] : []),
      "news",
      "timeline",
      "financials",
      "directors",
      "dividends",
      "peers",
    ];
    if (available.includes(requested)) {
      setActiveTab(requested);
    }
  }, [communityContent]);

  // Keep ?tab= in sync so tabs stay deep-linkable after client navigation.
  // Shallow history API, NOT router.replace: a router navigation would
  // re-execute the server page just to update a query param.
  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value);
    const params = new URLSearchParams(window.location.search);
    if (value === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
  }, []);

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
