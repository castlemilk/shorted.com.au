/**
 * The MDX component map for the blog — one definition shared by the index
 * (which renders the hero post in full) and /blog/[slug], so a component
 * added for a post cannot render on one route and vanish on the other.
 *
 * Article figures are site-owned server components. Their content is
 * rendered directly in the HTML, without animation or chart hydration.
 * Use Markdown children or literal JSON string attributes for figure data:
 * next-mdx-remote v6 blocks expression attributes such as items={[...]} by
 * default. The site's optional marketing animations remain lazy islands.
 *
 * `h1` deliberately renders as <h2>: both routes already carry the page's
 * single <h1>. The August crawl flagged /blog for two H1s.
 */
import type { ReactNode } from "react";

import Info from "~/@/components/ui/info";
import RegisterEmailClient from "~/@/components/ui/register-email-client";
import { HousingSeriesChart } from "~/@/components/housing/housing-charts";
import { articleFigureComponents } from "~/@/components/mdx/article-figures";
import { articleHtmlComponents } from "~/@/components/mdx/article-html";
import * as lazy from "./marketing-islands";

/** Names a post may use as JSX. Kept as a list so a test can pin it. */
export const BLOG_MDX_FIGURES = [
  "Callout", "Quote", "Steps",
  "GraphStat", "GraphKpi", "GraphSlope", "GraphRank", "GraphTimeline", "GraphTable",
  "GraphSpark", "GraphMeter", "GraphWaterfall", "GraphCompare", "GraphFlow",
  "ScrollReveal", "CountUp", "HousingChart", "Info", "RegisterEmail",
] as const;

export const blogMdxComponents = {
  ...articleHtmlComponents,

  RegisterEmail: (props: Record<string, unknown>) => <RegisterEmailClient {...props} />,
  Info: (props: { title: string; children: ReactNode }) => <Info {...props} />,
  HousingChart: (props: {
    regionCode: string; measure: string; dwellingType?: string;
    format?: "aud" | "percent" | "index"; ariaLabel: string; height?: number;
  }) => <HousingSeriesChart {...props} />,
  ScrollReveal: lazy.ScrollReveal,
  CountUp: lazy.CountUp,

  ...articleFigureComponents,
};
