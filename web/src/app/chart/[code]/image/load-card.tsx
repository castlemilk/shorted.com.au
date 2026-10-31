import type { ReactElement } from "react";

import { getStock } from "~/app/actions/getStock";
import {
  CHART_PERIOD_PHRASE,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";
import { formatCompanyName } from "~/@/lib/company-name";
import { CHART_SOURCE, chartSubject } from "~/@/lib/embed/snippet";
import { NO_LOGO, getCompanyLogo, getOgLogo } from "~/@/lib/og/card";
import { OgChartCard } from "~/@/lib/og/chart-card";
import type { SeriesPoint } from "~/@/lib/og/chart-image";
import { getChartPrices, getChartShorts, withTimeout } from "./chart-data";

export interface ChartCardState {
  code: string;
  view: ChartViewId;
  period: ChartPeriod;
}

export interface LoadedChartCard {
  /** The card, for an ImageResponse at OG_SIZE. */
  card: ReactElement;
  /** Every series the view asks for arrived in time. */
  complete: boolean;
}

/**
 * The chart card's data and drawing, shared by the image route (what a share
 * link unfurls into) and the Discord bot (which uploads the card with its
 * chart messages). Each read gives up after `readTimeoutMs`, and the card
 * draws whatever arrived: a failed read leaves that series out, never throws.
 */
export async function loadChartCard(
  { code, view, period }: ChartCardState,
  readTimeoutMs: number,
): Promise<LoadedChartCard> {
  const none: SeriesPoint[] = [];
  const [short, price, stock, logoSrc] = await Promise.all([
    view === "price"
      ? none
      : withTimeout(getChartShorts(code, period), readTimeoutMs, none),
    view === "short"
      ? none
      : withTimeout(getChartPrices(code, period), readTimeoutMs, none),
    withTimeout(getStock(code), readTimeoutMs, undefined),
    getOgLogo(),
  ]);
  const brand = await getCompanyLogo(stock?.logoUrl).catch(() => NO_LOGO);
  const complete =
    (view === "price" || short.length > 0) &&
    (view === "short" || price.length > 0);

  const subject = chartSubject(view);
  return {
    complete,
    card: (
      <OgChartCard
        code={code}
        company={stock?.name ? formatCompanyName(stock.name, code) : undefined}
        view={view}
        subject={subject.charAt(0).toUpperCase() + subject.slice(1)}
        periodPhrase={CHART_PERIOD_PHRASE[period]}
        source={CHART_SOURCE[view]}
        short={short}
        price={price}
        logoSrc={logoSrc}
        brand={brand}
      />
    ),
  };
}
