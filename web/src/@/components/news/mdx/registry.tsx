import { StatGroup, Stat } from "./stat-group";
import { PullQuote } from "./pull-quote";
import { Figure } from "./figure";
import { Timeline, TimelineEvent } from "./timeline";
import { articleFigureComponents } from "~/@/components/mdx/article-figures";
// The charts are client-only (connect-web under the hood). Their next/dynamic
// calls, with ssr: false, live in chart-loaders.tsx, a "use client" module.
import {
  ShortInterestChart,
  PriceChart,
  BankShortBasket,
  ShortBasket,
  MultiSeriesChart,
  BarChart,
  FlowChart,
} from "./chart-loaders";

export const MDX_COMPONENTS = {
  ...articleFigureComponents,
  ShortInterestChart,
  PriceChart,
  BankShortBasket,
  ShortBasket,
  MultiSeriesChart,
  BarChart,
  FlowChart,
  StatGroup,
  Stat,
  PullQuote,
  Figure,
  Timeline,
  TimelineEvent,
} as const;
