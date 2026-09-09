import * as React from "react";
import { Skeleton, Card, CardHeader, CardTitle, CardDescription, CardContent } from "shorted";

/**
 * The primitive itself: Skeleton is a bare `bg-muted animate-pulse` div, so the
 * shape is entirely yours via className. These are the four shapes the rest of
 * this file composes from — text line, heading block, circle, pill.
 */
export const Shapes = () => (
  <div className="flex flex-col gap-4">
    <div className="flex items-center gap-3">
      <Skeleton className="h-4 w-48" />
      <span className="text-xs text-muted-foreground">h-4 w-48, text line</span>
    </div>
    <div className="flex items-center gap-3">
      <Skeleton className="h-8 w-24" />
      <span className="text-xs text-muted-foreground">h-8 w-24, figure</span>
    </div>
    <div className="flex items-center gap-3">
      <Skeleton className="h-10 w-10 rounded-full" />
      <span className="text-xs text-muted-foreground">rounded-full, logo</span>
    </div>
    <div className="flex items-center gap-3">
      <Skeleton className="h-5 w-20 rounded-full" />
      <span className="text-xs text-muted-foreground">pill, badge slot</span>
    </div>
  </div>
);

/**
 * The top-shorts table while the ASIC data loads. Column widths mirror the real
 * table (code / company / % short / change) so the layout does not jump when the
 * rows arrive — that stability is the whole point of a skeleton.
 */
export const TableRows = () => (
  <div className="w-full max-w-2xl overflow-hidden rounded-md border border-border">
    <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
      <span style={{ width: "4rem" }}>Code</span>
      <span className="flex-1">Company</span>
      <span className="text-right" style={{ width: "5rem" }}>
        Short
      </span>
      <span className="text-right" style={{ width: "4rem" }}>
        1w
      </span>
    </div>
    {[36, 52, 44, 60, 40].map((w, i) => (
      <div
        key={i}
        className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
      >
        <div style={{ width: "4rem" }}>
          <Skeleton className="h-4 w-10" />
        </div>
        <div className="flex-1">
          <Skeleton className="h-4" style={{ width: `${w}%` }} />
        </div>
        <div className="flex justify-end" style={{ width: "5rem" }}>
          <Skeleton className="h-4 w-12" />
        </div>
        <div className="flex justify-end" style={{ width: "4rem" }}>
          <Skeleton className="h-4 w-10" />
        </div>
      </div>
    ))}
  </div>
);

/**
 * The dashboard stat strip loading. Each tile keeps its label visible and
 * skeletons only the figure, which reads faster than blanking the whole tile.
 */
export const StatCards = () => (
  <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-3">
    {["Most shorted", "Biggest riser", "Reported"].map((label) => (
      <Card key={label}>
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-24" />
        </CardContent>
      </Card>
    ))}
  </div>
);

/**
 * A watchlist item loading: circular logo slot, ticker line, company line, and a
 * right-aligned figure. The canonical "avatar + two lines" list skeleton.
 */
export const ListItems = () => (
  <Card className="w-full max-w-md">
    <CardHeader className="pb-3">
      <CardTitle>Watchlist</CardTitle>
      <CardDescription>Loading ASIC positions…</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </CardContent>
  </Card>
);

/**
 * A time-series panel loading. The plot area is one tall Skeleton with tick
 * stubs beneath it, so the chart's footprint is reserved before Visx mounts.
 */
export const ChartPanel = () => (
  <Card className="w-full max-w-lg">
    <CardHeader className="pb-3">
      <CardTitle>PLS · short interest</CardTitle>
      <CardDescription>Rolling 6 months</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between py-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-3 w-8" />
          ))}
        </div>
        <Skeleton className="h-40 flex-1" />
      </div>
      <div className="flex justify-between pl-11">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-3 w-10" />
        ))}
      </div>
    </CardContent>
  </Card>
);
