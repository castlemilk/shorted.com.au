import type { ReactElement } from "react";

import { getStock } from "~/app/actions/getStock";
import {
  chartPeriodPhrase,
  type ChartAnchor,
} from "~/@/components/charts/chart-anchor";
import type { ChartPeriod, ChartViewId } from "~/@/components/charts/chart-views";
import { formatCompanyName } from "~/@/lib/company-name";
import { CHART_SOURCE, chartSubject } from "~/@/lib/embed/snippet";
import { NO_LOGO, getCompanyLogo, getOgLogo } from "~/@/lib/og/card";
import { ogImageFetchUrl } from "~/@/lib/og/image-fetch";
import { OgChartCard } from "~/@/lib/og/chart-card";
import type { SeriesPoint } from "~/@/lib/og/chart-image";
import { getChartPrices, getChartShorts, withTimeout } from "./chart-data";

export interface ChartCardState {
  code: string;
  view: ChartViewId;
  period: ChartPeriod;
  /** A chart kept as posted: its windows end on the anchor, and its period reads so. */
  anchor?: ChartAnchor;
}

export interface LoadedChartCard {
  /** The card, for an ImageResponse at OG_SIZE. */
  card: ReactElement;
  /** Every series the VIEW needs arrived in time. */
  complete: boolean;
  /**
   * Whether the card has everything it can have: the company name was read,
   * and the logo, when the company has one, was read too. Only a complete,
   * resolved card of a settled anchor may be held at the CDN for a month; a
   * name or logo that failed to arrive is a transient gap, and is not cached
   * that long.
   */
  resolved: boolean;
  /**
   * On an anchored chart, the newest close and the newest short report the
   * card read (YYYY-MM-DD), when it read any. The Discord bot records them in
   * a new message's button ids, so every redraw ends where this drawing did.
   * The image route sends them as x-chart-prices-through and
   * x-chart-shorts-through.
   */
  pricesThrough?: string;
  shortsThrough?: string;
}

/** The calendar day (YYYY-MM-DD) of a series' newest point, or undefined. */
function throughDay(points: SeriesPoint[]): string | undefined {
  if (points.length === 0) return undefined;
  const newest = Math.max(...points.map((p) => p.t));
  return new Date(newest).toISOString().slice(0, 10);
}

/**
 * The chart card's data and drawing, shared by the image route (what a share
 * link unfurls into) and the Discord bot (which uploads the card with its
 * chart messages). Each read gives up after `readTimeoutMs`, and the card
 * draws whatever arrived: a failed read leaves that series out, never throws.
 *
 * Kept as posted, both series are always read, whatever the view draws: the
 * bot records both dates from every drawing, so a short-view post needs the
 * newest close too. Only the series the view draws are drawn.
 */
export async function loadChartCard(
  { code, view, period, anchor }: ChartCardState,
  readTimeoutMs: number,
): Promise<LoadedChartCard> {
  const none: SeriesPoint[] = [];
  const readShorts = Boolean(anchor) || view !== "price";
  const readPrices = Boolean(anchor) || view !== "short";
  const [shortRead, priceRead, stock, logoSrc] = await Promise.all([
    readShorts
      ? withTimeout(getChartShorts(code, period, anchor), readTimeoutMs, none)
      : none,
    readPrices
      ? withTimeout(getChartPrices(code, period, anchor), readTimeoutMs, none)
      : none,
    withTimeout(getStock(code), readTimeoutMs, undefined),
    getOgLogo(),
  ]);
  const short = view === "price" ? none : shortRead;
  const price = view === "short" ? none : priceRead;

  // A company with no logo URL, or one we never fetch (ogImageFetchUrl), has
  // no logo for good. A URL we do fetch that yields none has failed.
  // getCompanyLogo answers NO_LOGO for both, so the flag reads the URL too.
  // A null here means the read itself threw.
  const logoUrl = stock?.logoUrl;
  const logo = await getCompanyLogo(logoUrl).catch(() => null);
  const logoFailed =
    Boolean(logoUrl) &&
    ogImageFetchUrl(logoUrl) !== undefined &&
    (logo === null || logo.src === "");
  const brand = logo ?? NO_LOGO;
  const complete =
    (view === "price" || short.length > 0) &&
    (view === "short" || price.length > 0);

  const subject = chartSubject(view);
  return {
    complete,
    resolved: Boolean(stock?.name) && !logoFailed,
    ...(anchor
      ? { pricesThrough: throughDay(priceRead), shortsThrough: throughDay(shortRead) }
      : {}),
    card: (
      <OgChartCard
        code={code}
        company={stock?.name ? formatCompanyName(stock.name, code) : undefined}
        view={view}
        subject={subject.charAt(0).toUpperCase() + subject.slice(1)}
        periodPhrase={chartPeriodPhrase(period, anchor)}
        source={CHART_SOURCE[view]}
        short={short}
        price={price}
        logoSrc={logoSrc}
        brand={brand}
      />
    ),
  };
}
