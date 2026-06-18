import { z } from "zod";

const WINDOWS = ["1m", "3m", "6m", "1y"] as const;
const BASKET_WINDOWS = ["3m", "6m", "1y"] as const;

export const MDX_COMPONENT_SCHEMAS = {
  ShortInterestChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
  PriceChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
  BankShortBasket: z.object({
    banks: z.string().regex(/^[A-Z0-9]{2,5}(,[A-Z0-9]{2,5}){0,5}$/).optional(),
    window: z.enum(BASKET_WINDOWS).default("1y"),
    mode: z.enum(["dollar", "percent"]).default("dollar"),
    title: z.string().optional(),
  }),
  ShortBasket: z.object({
    basket: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/).optional(),
    window: z.enum(BASKET_WINDOWS).default("1y"),
    mode: z.enum(["dollar", "percent"]).default("dollar"),
    title: z.string().optional(),
  }),
  StatGroup: z.object({}),
  Stat: z.object({ label: z.string().min(1), value: z.string().min(1), context: z.string().optional(), cite: z.string().regex(/^ref-\d+$/).optional() }),
  PullQuote: z.object({}),
  Figure: z.object({ src: z.string().url(), caption: z.string().optional(), credit: z.string().optional(), placement: z.enum(["full", "left", "right", "inset"]).default("full") }),
  Timeline: z.object({}),
  TimelineEvent: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().min(1), cite: z.string().regex(/^ref-\d+$/).optional() }),
} as const;

export type MdxComponentName = keyof typeof MDX_COMPONENT_SCHEMAS;
export const MDX_COMPONENT_NAMES = Object.keys(MDX_COMPONENT_SCHEMAS) as MdxComponentName[];

/** Plain-JSON palette description injected into the writer prompt. */
export const MDX_PALETTE_DOC = `
<ShortInterestChart code="BHP" window="6m" /> — short interest vs price chart. One per article, after the data discussion.
<PriceChart code="BHP" window="3m" /> — price/volume only; use when price action is the story.
<BankShortBasket banks="CBA,WBC,NAB,ANZ" window="1y" mode="dollar" /> — interactive comparison of short positions across a BASKET of stocks, with a $/% toggle (stacked dollar value vs overlaid percent). Only for multi-stock/sector stories; window one of 3m|6m|1y. One per article.
<ShortBasket basket="lithium" window="1y" mode="dollar" /> — same interactive $/% basket chart for a named SECTOR. basket one of: banks | lithium | ironore. Use for sector/thematic stories; one per article.
<StatGroup><Stat label="Short interest" value="12.4%" context="up 3.1pp in 90 days" cite="ref-2" /></StatGroup> — 2-4 key numbers, every value must appear in your sources or the provided data.
<PullQuote>One striking sentence from your own prose.</PullQuote>
<Timeline><TimelineEvent date="2026-04-02" label="CEO sells $1.2M" cite="ref-3" /></Timeline> — only for genuine sequences (3+ events).
Rules: components on their own lines, never inside markdown headings/lists; window one of 1m|3m|6m|1y; cite only [ref-N] ids from CITABLE SOURCES; no other components, no imports, no HTML.
`.trim();
