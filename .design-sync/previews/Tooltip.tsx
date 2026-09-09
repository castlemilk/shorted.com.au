import * as React from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  Button,
  Badge,
} from "shorted";

/**
 * The canonical tooltip, forced `open` so it renders statically. `Tooltip`
 * must sit inside a `TooltipProvider`, so the provider is composed here.
 */
export const Default = () => (
  <TooltipProvider>
    <div className="flex min-h-[10rem] items-end justify-center p-8">
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline">Days to cover</Button>
        </TooltipTrigger>
        <TooltipContent>Shares short ÷ 20-day average volume</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

/**
 * `side="right"` — the placement axis, used beside inline metric labels.
 * The trigger wraps `Badge` in a `span`: `asChild` needs a child that
 * forwards a ref, and `Badge` is a plain function component.
 */
export const SideRight = () => (
  <TooltipProvider>
    <div className="flex min-h-[10rem] items-center p-8">
      <Tooltip open>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            <Badge variant="secondary">PLS 19.42%</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          Reported to ASIC on 5 September 2026
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

/**
 * Richer content — the panel wraps, so a full definition fits where a
 * one-line label would be too terse.
 */
export const RichContent = () => (
  <TooltipProvider>
    <div className="flex min-h-[12rem] items-end justify-center p-8">
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label="About this metric">
            ?
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">Percent of total product in issue</p>
          <p className="pt-1 text-muted-foreground">
            ASIC reports short positions against every share on issue, not the
            free float, so closely held stocks read lower than they trade.
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);
