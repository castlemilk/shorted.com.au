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
