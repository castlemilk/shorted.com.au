import * as React from "react";
import { Separator } from "shorted";

/** The default: a full-width 1px rule dividing a block of copy. */
export const Horizontal = () => (
  <div className="w-80">
    <div className="space-y-1">
      <h4 className="text-sm font-medium leading-none">Pilbara Minerals</h4>
      <p className="text-sm text-muted-foreground">
        PLS · Materials · ASX 200
      </p>
    </div>
    <Separator className="my-4" />
    <p className="text-sm text-muted-foreground">
      19.42% of shares on issue are held short, the highest reported short
      position on the ASX.
    </p>
  </div>
);

/**
 * `orientation="vertical"` is `h-full w-[1px]`, so the row must set the height
 * (here `h-5`) — a vertical separator in an auto-height flex row collapses to nothing.
 */
export const Vertical = () => (
  <div className="flex h-5 items-center space-x-4 text-sm">
    <div>Top shorts</div>
    <Separator orientation="vertical" />
    <div>Screener</div>
    <Separator orientation="vertical" />
    <div>Reports</div>
    <Separator orientation="vertical" />
    <div>API</div>
  </div>
);

/** Both orientations at once — the stat strip used on stock pages. */
export const StatStrip = () => (
  <div className="w-96 rounded-md border p-4">
    <div className="text-xs uppercase tracking-wide text-muted-foreground">
      BHP Group · latest ASIC report
    </div>
    <Separator className="my-4" />
    <div className="flex h-10 items-center justify-between">
      <div className="flex-1 text-center">
        <div className="text-lg font-semibold tabular-nums">0.81%</div>
        <div className="text-xs text-muted-foreground">Short</div>
      </div>
      <Separator orientation="vertical" />
      <div className="flex-1 text-center">
        <div className="text-lg font-semibold tabular-nums">1.4d</div>
        <div className="text-xs text-muted-foreground">To cover</div>
      </div>
      <Separator orientation="vertical" />
      <div className="flex-1 text-center">
        <div className="text-lg font-semibold tabular-nums">−0.02</div>
        <div className="text-xs text-muted-foreground">1w change</div>
      </div>
    </div>
  </div>
);

/** Separators as list rules — the divider pattern inside menus and result lists. */
export const ListRules = () => (
  <div className="w-80 rounded-md border">
    {[
      ["PLS", "19.42%"],
      ["LTR", "12.81%"],
      ["IEL", "11.06%"],
    ].map(([code, pct], i, arr) => (
      <React.Fragment key={code}>
        <div className="flex items-center justify-between px-4 py-2 text-sm">
          <span className="font-medium">{code}</span>
          <span className="tabular-nums text-muted-foreground">{pct}</span>
        </div>
        {i < arr.length - 1 ? <Separator /> : null}
      </React.Fragment>
    ))}
  </div>
);
