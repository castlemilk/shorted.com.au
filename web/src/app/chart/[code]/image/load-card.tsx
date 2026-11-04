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
  /** Every series the view draws arrived in time. */
  complete: boolean;
  /**
   * Whether the card has everything it can have: the site logo, the company
   * name, and the company's logo when it has one were all read. Only a
   * complete, resolved card of a settled anchor may be held at the CDN for a
   * month; a piece that failed to arrive is a transient gap, not a final
   * picture.
   */
  resolved: boolean;
}

/**
 * The chart card's data and drawing, shared by the image route (what a share
 * link unfurls into) and the Discord bot (which uploads the card with its
 * chart messages). Each read gives up after `readTimeoutMs`, and the card
 * draws whatever arrived: a failed read leaves that series out, never throws.
 *
 * Reads only the series the view draws, anchored or not, as the live card
 * always did.
 */
export async function loadChartCard(
  { code, view, period, anchor }: ChartCardState,
  readTimeoutMs: number,
): Promise<LoadedChartCard> {
  const none: SeriesPoint[] = [];
  const [short, price, stock, logoSrc] = await Promise.all([
    view === "price"
      ? none
      : withTimeout(getChartShorts(code, period, anchor), readTimeoutMs, none),
    view === "short"
      ? none
      : withTimeout(getChartPrices(code, period, anchor), readTimeoutMs, none),
    withTimeout(getStock(code), readTimeoutMs, undefined),
    getOgLogo(),
  ]);

  // The company's logo: a company with no logo URL, or one we never fetch
  // (ogImageFetchUrl), has none for good. A URL we do fetch that yields none,
  // or a read that threw, is a failure.
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
    resolved: Boolean(stock?.name) && !logoFailed && logoSrc !== "",
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
