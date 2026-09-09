import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "shorted";

/** The canonical use — `defaultValue` selects the open panel; the active trigger lifts onto the card background. */
export const Default = () => (
  <Tabs defaultValue="short-interest" className="w-[400px]">
    <TabsList>
      <TabsTrigger value="short-interest">Short interest</TabsTrigger>
      <TabsTrigger value="price">Price</TabsTrigger>
      <TabsTrigger value="news">News</TabsTrigger>
    </TabsList>
    <TabsContent value="short-interest">
      <p className="text-sm text-muted-foreground">
        PLS has 19.42% of shares on issue held short, the highest on the ASX,
        up 0.38 points over the past week.
      </p>
    </TabsContent>
    <TabsContent value="price">
      <p className="text-sm text-muted-foreground">Last close $2.98, −1.6% on the day.</p>
    </TabsContent>
    <TabsContent value="news">
      <p className="text-sm text-muted-foreground">4 articles in the last 7 days.</p>
    </TabsContent>
  </Tabs>
);

/** Tabs as the period selector that sits above every chart in this product. */
export const PeriodSelector = () => (
  <Tabs defaultValue="6m" className="w-[400px]">
    <TabsList>
      <TabsTrigger value="1m">1M</TabsTrigger>
      <TabsTrigger value="3m">3M</TabsTrigger>
      <TabsTrigger value="6m">6M</TabsTrigger>
      <TabsTrigger value="1y">1Y</TabsTrigger>
      <TabsTrigger value="5y">5Y</TabsTrigger>
      <TabsTrigger value="max">Max</TabsTrigger>
    </TabsList>
    <TabsContent value="6m">
      <div className="rounded-md border p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Short interest · 6 months
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">19.42%</div>
        <div className="text-sm text-muted-foreground">Range 14.10% – 21.66%</div>
      </div>
    </TabsContent>
  </Tabs>
);

/** A disabled trigger — 50% opacity, pointer events removed. */
export const DisabledTrigger = () => (
  <Tabs defaultValue="positions" className="w-[400px]">
    <TabsList>
      <TabsTrigger value="positions">Positions</TabsTrigger>
      <TabsTrigger value="peers">Peers</TabsTrigger>
      <TabsTrigger value="filings" disabled>
        Filings
      </TabsTrigger>
    </TabsList>
    <TabsContent value="positions">
      <p className="text-sm text-muted-foreground">
        Filings are unavailable for this security. The tab is disabled rather
        than hidden so the shape of the page never changes.
      </p>
    </TabsContent>
  </Tabs>
);
