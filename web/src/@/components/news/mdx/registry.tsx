import dynamic from "next/dynamic";
import { StatGroup, Stat } from "./stat-group";
import { PullQuote } from "./pull-quote";
import { Figure } from "./figure";
import { Timeline, TimelineEvent } from "./timeline";

// Charts are client-only (connect-web under the hood) — never SSR them.
const ShortInterestChart = dynamic(
  () => import("./short-interest-chart").then((m) => m.ShortInterestChart),
  { ssr: false },
);
const PriceChart = dynamic(() => import("./price-chart").then((m) => m.PriceChart), {
  ssr: false,
});
const BankShortBasket = dynamic(
  () => import("./bank-short-basket").then((m) => m.BankShortBasket),
  { ssr: false },
);
const ShortBasket = dynamic(
  () => import("./short-basket").then((m) => m.ShortBasket),
  { ssr: false },
);

export const MDX_COMPONENTS = {
  ShortInterestChart,
  PriceChart,
  BankShortBasket,
  ShortBasket,
  StatGroup,
  Stat,
  PullQuote,
  Figure,
  Timeline,
  TimelineEvent,
} as const;
