import { z } from "zod";

const WINDOWS = ["1m", "3m", "6m", "1y"] as const;

export const MDX_COMPONENT_SCHEMAS = {
  ShortInterestChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
  PriceChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
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
<StatGroup><Stat label="Short interest" value="12.4%" context="up 3.1pp in 90 days" cite="ref-2" /></StatGroup> — 2-4 key numbers, every value must appear in your sources or the provided data.
<PullQuote>One striking sentence from your own prose.</PullQuote>
<Timeline><TimelineEvent date="2026-04-02" label="CEO sells $1.2M" cite="ref-3" /></Timeline> — only for genuine sequences (3+ events).
Rules: components on their own lines, never inside markdown headings/lists; window one of 1m|3m|6m|1y; cite only [ref-N] ids from CITABLE SOURCES; no other components, no imports, no HTML.
`.trim();
