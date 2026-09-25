"use client";

/**
 * Client-side code-split entry for the vendored mdxcn figures (and the two
 * marketing animation islands the blog exposes).
 *
 * WHY THIS IS A "use client" MODULE. `next/dynamic` inside a *server* module
 * does not keep a client component out of the route's entry: every figure and
 * `motion` still landed in the first-load JS of both blog routes (measured:
 * 116 → 182 kB on /blog, 119 → 186 kB on /blog/[slug]). Inside a client
 * module, `dynamic()` becomes a real async chunk that only downloads when a
 * post renders the figure — the same posture `housing-charts.tsx` uses for
 * the connect-web charts. SSR stays on (default), so the figure text is in the
 * HTML for crawlers and nothing shifts on hydration.
 *
 * `ScrollReveal` pulls react-spring; it is lazy for the same reason.
 */
import dynamic from "next/dynamic";

function FigureSkeleton() {
  return <div aria-hidden className="my-6 h-40 w-full animate-pulse rounded bg-muted" />;
}

// next/dynamic requires an inline object literal for its options (a compile-
// time constraint), hence the repetition below.
export const Callout = dynamic(() => import("@/registry/default/callout/callout").then((m) => m.Callout), { loading: FigureSkeleton });
export const Quote = dynamic(() => import("@/registry/default/quote/quote").then((m) => m.Quote), { loading: FigureSkeleton });
export const Steps = dynamic(() => import("@/registry/default/steps/steps").then((m) => m.Steps), { loading: FigureSkeleton });
export const GraphStat = dynamic(() => import("@/registry/default/graph-stat/graph-stat").then((m) => m.GraphStat), { loading: FigureSkeleton });
export const GraphKpi = dynamic(() => import("@/registry/default/graph-kpi/graph-kpi").then((m) => m.GraphKpi), { loading: FigureSkeleton });
export const GraphSlope = dynamic(() => import("@/registry/default/graph-slope/graph-slope").then((m) => m.GraphSlope), { loading: FigureSkeleton });
export const GraphRank = dynamic(() => import("@/registry/default/graph-rank/graph-rank").then((m) => m.GraphRank), { loading: FigureSkeleton });
export const GraphTimeline = dynamic(() => import("@/registry/default/graph-timeline/graph-timeline").then((m) => m.GraphTimeline), { loading: FigureSkeleton });
export const GraphTable = dynamic(() => import("@/registry/default/graph-table/graph-table").then((m) => m.GraphTable), { loading: FigureSkeleton });
export const GraphSpark = dynamic(() => import("@/registry/default/graph-spark/graph-spark").then((m) => m.GraphSpark), { loading: FigureSkeleton });
export const GraphMeter = dynamic(() => import("@/registry/default/graph-meter/graph-meter").then((m) => m.GraphMeter), { loading: FigureSkeleton });
export const GraphWaterfall = dynamic(() => import("@/registry/default/graph-waterfall/graph-waterfall").then((m) => m.GraphWaterfall), { loading: FigureSkeleton });
export const GraphCompare = dynamic(() => import("@/registry/default/graph-compare/graph-compare").then((m) => m.GraphCompare), { loading: FigureSkeleton });
export const GraphFlow = dynamic(() => import("@/registry/default/graph-flow/graph-flow").then((m) => m.GraphFlow), { loading: FigureSkeleton });

export const ScrollReveal = dynamic(() => import("~/@/components/marketing/scroll-reveal").then((m) => m.ScrollReveal));
export const CountUp = dynamic(() => import("~/@/components/marketing/count-up").then((m) => m.CountUp));
