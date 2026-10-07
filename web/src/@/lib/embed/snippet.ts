import { siteConfig } from "~/@/config/site";
import type {
  ChartPeriod,
  ChartViewId,
} from "~/@/components/charts/chart-views";

/**
 * Copyable embed snippets for the public /embed/* widgets.
 *
 * WHY THE SNIPPET IS A <figure>, NOT A BARE <iframe>:
 * /embed/* is `noindex, nofollow` (embed/layout.tsx) AND Disallow-ed in
 * robots.txt, so the attribution link rendered *inside* the iframe is invisible
 * to crawlers — an embed installed on a third-party site passed us nothing.
 * The credit has to live in the HOST page's markup to be a real backlink, so
 * the copied snippet pairs the iframe with a visible <figcaption> carrying:
 *
 *   1. a DEEP link to the source page with keyword-rich anchor text
 *      ("BHP short interest" → /shorts/BHP), which is worth more than a
 *      homepage link and matches the query we want to rank for; and
 *   2. a brand link to the site root.
 *
 * The credit is ordinary markup the publisher can edit or delete. That is
 * deliberate: making attribution undeletable (script-injected, or hidden text)
 * is cloaking-adjacent and risks a manual penalty. The goal is to make the
 * good behaviour the default and the easy path, not to force it.
 */

export type EmbedTarget =
  | {
      kind: "chart";
      code: string;
      /** Which StockChartPanel view to render. Default "short". */
      view?: ChartViewId;
      /** Initial period. Default "1y". */
      period?: ChartPeriod;
    }
  | { kind: "top-shorts"; limit?: number }
  | { kind: "treemap"; period?: string }
  | { kind: "basket"; basket?: string };

export interface EmbedSnippet {
  /** Absolute URL for the iframe `src`. */
  iframeSrc: string;
  /** Pixel height the widget needs. */
  height: number;
  /** iframe `title` — also the accessible name for screen readers. */
  title: string;
  /** Absolute URL of the page the widget was built from. */
  deepLink: string;
  /** Anchor text for the deep link. Keyword-rich by design. */
  deepLinkAnchor: string;
  /** Where the widget's data comes from, e.g. "ASIC short position reports". */
  source: string;
  /** The full copyable HTML. */
  html: string;
}

interface TargetSpec {
  path: string;
  height: number;
  title: string;
  deepLinkPath: string;
  deepLinkAnchor: string;
  /** Data provenance for the credit line. */
  source: string;
}

const ASIC_SOURCE = "ASIC short position reports";

function qs(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

/** The /embed/chart defaults — the URL omits a param that equals its default. */
export const DEFAULT_CHART_VIEW: ChartViewId = "short";
export const DEFAULT_CHART_PERIOD: ChartPeriod = "1y";

/** Keyword-rich subject per chart view, used in the iframe title and anchor. */
/** What each chart view's data actually comes from. */
const CHART_SOURCE: Record<ChartViewId, string> = {
  short: ASIC_SOURCE,
  price: "end-of-day ASX prices",
  combined: "ASIC short position reports and end-of-day ASX prices",
};

const CHART_SUBJECT: Record<ChartViewId, string> = {
  short: "short interest",
  price: "share price",
  combined: "share price and short interest",
};

function specFor(target: EmbedTarget): TargetSpec {
  switch (target.kind) {
    case "chart": {
      const code = target.code.trim().toUpperCase();
      const view = target.view ?? DEFAULT_CHART_VIEW;
      const period = target.period ?? DEFAULT_CHART_PERIOD;
      const subject = CHART_SUBJECT[view];
      return {
        // Defaults are OMITTED so every snippet copied before views existed
        // (`/embed/chart?code=BHP`, short interest, 1y) is byte-identical to
        // what the short view builds today.
        path: `/embed/chart${qs({
          code,
          view: view === DEFAULT_CHART_VIEW ? undefined : view,
          period: period === DEFAULT_CHART_PERIOD ? undefined : period,
        })}`,
        height: view === "combined" ? 520 : 480,
        title: `${code} ${subject} — Shorted.com.au`,
        deepLinkPath: `/shorts/${encodeURIComponent(code)}`,
        deepLinkAnchor: `${code} ${subject}`,
        source: CHART_SOURCE[view],
      };
    }
    case "top-shorts":
      return {
        path: `/embed/top-shorts${qs({ limit: target.limit })}`,
        height: 520,
        title: "Most shorted ASX stocks — Shorted.com.au",
        deepLinkPath: "/top",
        deepLinkAnchor: "most shorted ASX stocks",
        source: ASIC_SOURCE,
      };
    case "treemap":
      return {
        path: `/embed/treemap${qs({ period: target.period })}`,
        height: 540,
        title: "ASX short positions by industry — Shorted.com.au",
        deepLinkPath: "/industry-intelligence",
        deepLinkAnchor: "ASX short positions by industry",
        source: ASIC_SOURCE,
      };
    case "basket":
      return {
        path: `/embed/bank-basket${qs({ basket: target.basket })}`,
        height: 500,
        title: "ASX short basket — Shorted.com.au",
        deepLinkPath: "/statistics",
        deepLinkAnchor: "ASX short selling statistics",
        source: ASIC_SOURCE,
      };
  }
}

/**
 * Build the copyable embed HTML for a widget.
 *
 * `loading="lazy"` keeps the host page's Core Web Vitals intact — a publisher
 * whose LCP regresses because of our widget removes the widget.
 */
export function buildEmbedSnippet(target: EmbedTarget): EmbedSnippet {
  const spec = specFor(target);
  const iframeSrc = `${siteConfig.url}${spec.path}`;
  const deepLink = `${siteConfig.url}${spec.deepLinkPath}`;

  const html = [
    `<figure style="margin:0">`,
    `  <iframe src="${iframeSrc}" width="100%" height="${spec.height}" loading="lazy" frameborder="0" title="${spec.title}"></iframe>`,
    `  <figcaption style="font:14px/1.4 system-ui,sans-serif;margin-top:8px">`,
    `    <a href="${deepLink}">${spec.deepLinkAnchor}</a> — data from <a href="${siteConfig.url}">Shorted.com.au</a>, sourced from ${spec.source}`,
    `  </figcaption>`,
    `</figure>`,
  ].join("\n");

  return {
    iframeSrc,
    height: spec.height,
    title: spec.title,
    deepLink,
    deepLinkAnchor: spec.deepLinkAnchor,
    source: spec.source,
    html,
  };
}

/** Human label for the dialog copy, e.g. "chart" / "table". */
export function embedNoun(target: EmbedTarget): string {
  switch (target.kind) {
    case "chart":
      return "chart";
    case "top-shorts":
      return "table";
    case "treemap":
      return "heatmap";
    case "basket":
      return "chart";
  }
}
