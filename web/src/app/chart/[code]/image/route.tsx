import { ImageResponse } from "next/og";
import { type NextRequest } from "next/server";

import { parseEmbedChartParams } from "~/app/embed/chart/params";
import { OG_SIZE } from "~/@/lib/og/card";
import { loadChartCard } from "./load-card";

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
 * rather than a generic site card. The card itself is ./load-card.tsx, which
 * the Discord bot also renders for the charts it posts.
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

  const { card, complete } = await loadChartCard(
    { code, view, period },
    READ_TIMEOUT_MS,
  );
  return new ImageResponse(card, {
    ...OG_SIZE,
    headers: {
      "cache-control": complete ? CACHE_COMPLETE : CACHE_INCOMPLETE,
    },
  });
}
