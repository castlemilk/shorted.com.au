import * as React from "react";
import { ScrollArea, ScrollBar, Separator, Badge } from "shorted";

const WATCHLIST = [
  ["PLS", "Pilbara Minerals", "19.42%"],
  ["LTR", "Liontown Resources", "12.81%"],
  ["IEL", "IDP Education", "11.06%"],
  ["BOE", "Boss Energy", "9.63%"],
  ["SYA", "Sayona Mining", "8.12%"],
  ["SLX", "Silex Systems", "5.94%"],
  ["CTT", "Cettire", "5.31%"],
  ["FLT", "Flight Centre", "4.02%"],
  ["DMP", "Domino's Pizza", "3.77%"],
  ["A2M", "The a2 Milk Company", "2.64%"],
  ["WBC", "Westpac", "1.18%"],
  ["BHP", "BHP Group", "0.81%"],
] as const;

/**
 * The canonical use: a fixed-height scrolling watchlist. The height is on the
 * root — without one the area grows to its content and never scrolls.
 * `type="always"` keeps the thumb painted at rest.
 */
export const Default = () => (
  <ScrollArea type="always" className="h-64 w-72 rounded-md border">
    <div className="p-3">
      <h4 className="mb-2 text-sm font-medium leading-none">Watchlist</h4>
      {WATCHLIST.map(([code, name, pct]) => (
        <React.Fragment key={code}>
          <div className="flex items-center justify-between py-2 text-sm">
            <span>
              <span className="font-medium">{code}</span>{" "}
              <span className="text-muted-foreground">{name}</span>
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}</span>
          </div>
          <Separator />
        </React.Fragment>
      ))}
    </div>
  </ScrollArea>
);

/** A scrolling prose block — the long-form company summary in a fixed panel. */
export const LongText = () => (
  <ScrollArea type="always" className="h-40 w-80 rounded-md border p-4 text-sm">
    <p className="mb-3">
      Pilbara Minerals is a Western Australian lithium producer and the most
      heavily shorted security on the ASX, with 19.42% of shares on issue held
      short as at the latest ASIC report.
    </p>
    <p className="mb-3">
      Short interest has stayed above 15% for 61 consecutive reporting days,
      the longest streak in the Materials sector since 2022.
    </p>
    <p className="mb-3">
      Days to cover, measured against 20-day average volume, sits at 8.4, high
      enough that an unwind would take more than a fortnight of ordinary trade.
    </p>
    <p>
      ASIC publishes reported short positions with a four-business-day lag, so
      the figures above describe the market as it stood on 9 May 2024.
    </p>
  </ScrollArea>
);

/**
 * Horizontal overflow: a wide row of industry filters. The root ships a
 * vertical ScrollBar only, so a horizontal axis needs an explicit
 * `<ScrollBar orientation="horizontal" />`.
 */
export const HorizontalScroll = () => (
  <ScrollArea type="always" className="w-80 rounded-md border pb-2">
    <div className="flex w-max gap-2 p-3">
      {[
        "Materials",
        "Energy",
        "Financials",
        "Consumer Discretionary",
        "Health Care",
        "Industrials",
        "Real Estate",
        "Utilities",
      ].map((industry) => (
        <Badge key={industry} variant="secondary" className="whitespace-nowrap">
          {industry}
        </Badge>
      ))}
    </div>
    <ScrollBar orientation="horizontal" />
  </ScrollArea>
);
