import { ImageResponse } from "next/og";
import { type NextRequest } from "next/server";

import { getStock } from "~/app/actions/getStock";
import { parseEmbedChartParams } from "~/app/embed/chart/params";
import { CHART_PERIOD_PHRASE } from "~/@/components/charts/chart-views";
import { formatCompanyName } from "~/@/lib/company-name";
import { CHART_SOURCE, chartSubject } from "~/@/lib/embed/snippet";
import { NO_LOGO, OG_SIZE, getCompanyLogo, getOgLogo } from "~/@/lib/og/card";
import { OgChartCard } from "~/@/lib/og/chart-card";
import type { SeriesPoint } from "~/@/lib/og/chart-image";
import { getChartPrices, getChartShorts, withTimeout } from "./chart-data";

export const maxDuration = 15;

/** Each read gets this long; the card draws whatever arrived in time. */
const READ_TIMEOUT_MS = 8000;

const CACHE_COMPLETE =
  "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
/**
 * A card missing a series it asked for (a read failed or timed out) is cached
 * for minutes, not hours, so one bad read does not pin a blank chart on every
 * unfurl for six. An unfurler caches its own copy anyway; this is the CDN's.
 */
const CACHE_INCOMPLETE = "public, max-age=60, s-maxage=300";

/**
 * The og:image of a shared chart link (/chart/CODE?view=&period=): the chart
 * itself, so a link pasted into Discord, Slack or X unfurls into the picture
 * rather than a generic site card.
 *
 *   /chart/BHP/image                          short interest, 1y
 *   /chart/BHP/image?view=combined&period=1m  price + short, past month
 *
 * Parameters are /embed/chart's and fall back the same way (an unknown code
 * draws the default stock, as the embed does). It never answers 500: a failed
 * read draws the card without that series, and with no series at all the card
 * says the data is unavailable.
 *
 * Cache-Control is set lowercase on purpose: ImageResponse spreads caller
 * headers over its own lowercase `cache-control` (immutable, a year), and a
 * capitalised key would be appended to it rather than replace it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> | { code: string } },
) {
  const { code: rawCode } = await params;
  const { code, view, period } = parseEmbedChartParams({
    get: (k) => (k === "code" ? rawCode : req.nextUrl.searchParams.get(k)),
  });

  const none: SeriesPoint[] = [];
  const [short, price, stock, logoSrc] = await Promise.all([
    view === "price"
      ? none
      : withTimeout(getChartShorts(code, period), READ_TIMEOUT_MS, none),
    view === "short"
      ? none
      : withTimeout(getChartPrices(code, period), READ_TIMEOUT_MS, none),
    withTimeout(getStock(code), READ_TIMEOUT_MS, undefined),
    getOgLogo(),
  ]);
  const brand = await getCompanyLogo(stock?.logoUrl).catch(() => NO_LOGO);
  const complete =
    (view === "price" || short.length > 0) &&
    (view === "short" || price.length > 0);

  const subject = chartSubject(view);
  return new ImageResponse(
    (
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
    {
      ...OG_SIZE,
      headers: {
        "cache-control": complete ? CACHE_COMPLETE : CACHE_INCOMPLETE,
      },
    },
  );
}
