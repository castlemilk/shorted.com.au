import * as React from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Button,
  Badge,
} from "shorted";

const Chevron = ({ className = "" }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`h-4 w-4 shrink-0 ${className}`}
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * Open state. Collapsible ships unstyled (it is Radix passthrough), so the
 * trigger borrows Button and the panel carries the DS's own border/muted
 * tokens. `open` is held so the content renders statically.
 */
export const Open = () => (
  <Collapsible open className="w-80 rounded-md border">
    <CollapsibleTrigger asChild>
      <Button variant="ghost" className="flex w-full justify-between px-3">
        Reporting details
        <Chevron className="rotate-180" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 border-t px-3 py-3 text-sm text-muted-foreground">
      <p>Source: ASIC aggregated short positions, 4 business day lag.</p>
      <p>Last report: 2026-09-03. Next sync: 2am AEST.</p>
    </CollapsibleContent>
  </Collapsible>
);

/** Closed state — only the trigger is rendered. */
export const Closed = () => (
  <Collapsible className="w-80 rounded-md border">
    <CollapsibleTrigger asChild>
      <Button variant="ghost" className="flex w-full justify-between px-3">
        Reporting details
        <Chevron />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 border-t px-3 py-3 text-sm text-muted-foreground">
      <p>Source: ASIC aggregated short positions, 4 business day lag.</p>
    </CollapsibleContent>
  </Collapsible>
);

/** A "show more" disclosure over a list — the peer-comparison pattern. */
export const ShowMore = () => (
  <Collapsible open className="w-80 space-y-2">
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>PLS · Pilbara Minerals</span>
      <Badge variant="secondary">19.4%</Badge>
    </div>
    <CollapsibleContent className="space-y-2">
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>LTR · Liontown Resources</span>
        <Badge variant="secondary">14.8%</Badge>
      </div>
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>IEL · IDP Education</span>
        <Badge variant="secondary">12.1%</Badge>
      </div>
    </CollapsibleContent>
    <CollapsibleTrigger asChild>
      <Button variant="outline" size="sm" className="w-full">
        Show fewer peers
      </Button>
    </CollapsibleTrigger>
  </Collapsible>
);

/** Trigger without `asChild` — the raw Radix button, styled inline. */
export const PlainTrigger = () => (
  <Collapsible open className="w-80">
    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-sm font-medium">
      Filters
      <Chevron className="rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="px-3 py-2 text-sm text-muted-foreground">
      Sector: Materials · Period: 6 months · Min short: 5%
    </CollapsibleContent>
  </Collapsible>
);
