import {
  isChartPeriod,
  isChartViewId,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";
import {
  DEFAULT_CHART_PERIOD,
  DEFAULT_CHART_VIEW,
} from "~/@/lib/embed/snippet";

export const DEFAULT_EMBED_CODE = "BHP";

const CODE_RE = /^[A-Z0-9]{2,6}$/;

/** Whether a raw code is shaped like an ASX code (case-insensitive). */
export function isChartCode(raw: string | null | undefined): boolean {
  return CODE_RE.test(raw?.trim().toUpperCase() ?? "");
}

export interface EmbedChartParams {
  code: string;
  view: ChartViewId;
  period: ChartPeriod;
}

/** Anything with URLSearchParams' `get` — ReadonlyURLSearchParams included. */
interface ParamSource {
  get(name: string): string | null;
}

/**
 * Parse /embed/chart's query. Every param falls back to its default rather
 * than erroring — an embed lives on someone else's page for years, and a
 * hand-edited or truncated URL should still draw a chart.
 *
 * Defaults match buildEmbedSnippet's omissions (view=short, period=1y), so a
 * snippet copied before views existed (`?code=BHP`) renders what it always did.
 */
export function parseEmbedChartParams(
  searchParams: ParamSource | null | undefined,
): EmbedChartParams {
  const rawCode = searchParams?.get("code")?.trim().toUpperCase() ?? "";
  const rawView = searchParams?.get("view")?.trim().toLowerCase();
  const rawPeriod = searchParams?.get("period")?.trim().toLowerCase();
  return {
    code: CODE_RE.test(rawCode) ? rawCode : DEFAULT_EMBED_CODE,
    view: isChartViewId(rawView) ? rawView : DEFAULT_CHART_VIEW,
    period: isChartPeriod(rawPeriod) ? rawPeriod : DEFAULT_CHART_PERIOD,
  };
}

type SearchParamsRecord = Record<string, string | string[] | undefined>;

/**
 * /chart/[code]'s params: the code from the path, view and period from the
 * query, with the same defaults and fallbacks as /embed/chart. A share link
 * and the embed it was copied beside always draw the same chart.
 */
export function parseChartShareParams(
  code: string | undefined,
  searchParams: SearchParamsRecord | null | undefined,
): EmbedChartParams {
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) ?? null;
  return parseEmbedChartParams({
    get: (name) =>
      name === "code" ? (code ?? null) : first(searchParams?.[name]),
  });
}
