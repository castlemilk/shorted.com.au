/**
 * The MDX component map for the blog — one definition shared by the index
 * (which renders the hero post in full) and /blog/[slug], so a component
 * added for a post cannot render on one route and vanish on the other.
 *
 * Three families:
 *  - the HTML element overrides (heading demotion, typography classes);
 *  - the site's own islands: Info, RegisterEmail, HousingChart, ScrollReveal,
 *    CountUp — client components already wrapped so they are safe to hand to
 *    next-mdx-remote from a server component (see CLAUDE.md on connect-web);
 *  - the vendored mdxcn figures (src/@/registry/default): ASCII-framed,
 *    lightly animated callouts, steps, ranks, slopes and tables.
 *
 * WHY THE FIGURES ARE LAZY, AND WHY FROM A CLIENT MODULE. Importing them
 * statically put every figure and `motion` into the first-load JS of every
 * blog page, used or not — measured +66 kB gzipped on /blog and /blog/[slug]
 * against the July baseline — and `next/dynamic` from THIS (server) module
 * changed nothing. `mdxcn-figures.tsx` is a "use client" module whose
 * `dynamic()` exports are true async chunks: downloaded only when a post
 * renders the figure, still server-rendered so the text is crawlable.
 *
 * WHY THE CHILD ITEMS ARE LOCAL MARKERS. `<Stat>`, `<Rank>`, `<Slope>` … are
 * null-rendering placeholders whose props the parent reads; mdxcn matches
 * them by NAME (`graphItem` / `displayName`, see `typeName` in graph-frame),
 * not by identity, precisely so a React Server client reference still
 * resolves. Defining the markers here keeps the parent modules out of the
 * static graph; `mdx-components.test.tsx` pins the name contract.
 *
 * `h1` deliberately renders as <h2>: both routes already carry the page's
 * single <h1>. The August crawl flagged /blog for two H1s.
 */
import type { ComponentType, ReactNode } from "react";

import Info from "~/@/components/ui/info";
import RegisterEmailClient from "~/@/components/ui/register-email-client";
import { HousingSeriesChart } from "~/@/components/housing/housing-charts";
import * as lazy from "./mdxcn-figures";

type H = React.HTMLAttributes<HTMLHeadingElement>;

/**
 * A child-item marker with mdxcn's naming contract. Never renders; the parent
 * figure reads `props` off the element.
 */
export function graphItem<P extends object>(name: string): ComponentType<P> & { graphItem: string } {
  const Item = (() => null) as unknown as ComponentType<P> & { graphItem: string; displayName?: string };
  Item.displayName = name;
  Item.graphItem = name;
  return Item;
}

/** Names a post may use as JSX. Kept as a list so a test can pin it. */
export const BLOG_MDX_FIGURES = [
  "Callout", "Quote", "Steps", "Step",
  "GraphStat", "Stat", "GraphKpi", "GraphSlope", "Slope", "GraphRank", "Rank",
  "GraphTimeline", "Event", "GraphTable", "Head", "Row", "Cell", "Foot",
  "GraphSpark", "GraphMeter", "GraphWaterfall", "Delta", "GraphCompare", "Col",
  "GraphFlow", "Path", "ScrollReveal", "CountUp", "HousingChart", "Info", "RegisterEmail",
] as const;

/** The child-item names mdxcn parents look for; each marker's `graphItem` must equal its key. */
export const BLOG_MDX_ITEM_MARKERS = [
  "Step", "Stat", "Slope", "Rank", "Event", "Head", "Row", "Cell", "Foot", "Delta", "Col", "Path",
] as const;

const items = Object.fromEntries(BLOG_MDX_ITEM_MARKERS.map((name) => [name, graphItem<Record<string, unknown>>(name)])) as Record<
  (typeof BLOG_MDX_ITEM_MARKERS)[number],
  ReturnType<typeof graphItem<Record<string, unknown>>>
>;

export const blogMdxComponents = {
  h1: ({ children, ...props }: H) => <h2 className="text-4xl font-bold mt-8 mb-4" {...props}>{children}</h2>,
  h2: ({ children, ...props }: H) => <h2 className="text-3xl font-semibold mt-6 mb-3" {...props}>{children}</h2>,
  h3: ({ children, ...props }: H) => <h3 className="text-2xl font-medium mt-4 mb-2" {...props}>{children}</h3>,
  h4: ({ children, ...props }: H) => <h4 className="text-xl font-medium mt-3 mb-2" {...props}>{children}</h4>,
  h5: ({ children, ...props }: H) => <h5 className="text-lg font-medium mt-2 mb-1" {...props}>{children}</h5>,
  h6: ({ children, ...props }: H) => <h6 className="text-base font-medium mt-2 mb-1" {...props}>{children}</h6>,
  a: ({ children, ...props }: React.HTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary hover:underline" {...props}>{children}</a>
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mt-4 mb-4" {...props} />,
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="list-disc list-inside mt-2 mb-2" {...props} />,
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => <ol className="list-decimal list-inside mt-2 mb-2" {...props} />,
  li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="mt-1 mb-1" {...props} />,
  table: (props: React.HTMLAttributes<HTMLTableElement>) => <table className="w-full mt-4 mb-4" {...props} />,
  tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr className="border-b border-border" {...props} />,
  th: (props: React.HTMLAttributes<HTMLTableCellElement>) => <th className="px-4 py-2 text-left" {...props} />,
  td: (props: React.HTMLAttributes<HTMLTableCellElement>) => <td className="px-4 py-2 text-left" {...props} />,

  RegisterEmail: (props: Record<string, unknown>) => <RegisterEmailClient {...props} />,
  Info: (props: { title: string; children: ReactNode }) => <Info {...props} />,
  HousingChart: (props: {
    regionCode: string; measure: string; dwellingType?: string;
    format?: "aud" | "percent" | "index"; ariaLabel: string; height?: number;
  }) => <HousingSeriesChart {...props} />,
  ScrollReveal: lazy.ScrollReveal,
  CountUp: lazy.CountUp,

  // mdxcn figures — async chunks from the "use client" module (see its comment)
  Callout: lazy.Callout,
  Quote: lazy.Quote,
  Steps: lazy.Steps,
  GraphStat: lazy.GraphStat,
  GraphKpi: lazy.GraphKpi,
  GraphSlope: lazy.GraphSlope,
  GraphRank: lazy.GraphRank,
  GraphTimeline: lazy.GraphTimeline,
  GraphTable: lazy.GraphTable,
  GraphSpark: lazy.GraphSpark,
  GraphMeter: lazy.GraphMeter,
  GraphWaterfall: lazy.GraphWaterfall,
  GraphCompare: lazy.GraphCompare,
  GraphFlow: lazy.GraphFlow,

  // mdxcn child items — local markers matched by name
  ...items,
};
