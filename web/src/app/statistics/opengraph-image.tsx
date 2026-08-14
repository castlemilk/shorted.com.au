/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getShortStatistics } from "~/app/actions/getShortStatistics";

export const alt = "ASX Short Selling Statistics — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

function aud(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n).toLocaleString("en-AU")}`;
}

/**
 * The live citation figure as a share card — this is the number journalists
 * quote, so it belongs on the image.
 *
 * Degrades to the static headline when stats are unavailable: a crawler or a
 * share fetch must never get a 500, and `skipForBuild` makes null a real
 * state at build time, not a theoretical one.
 */
export default async function Image() {
  const [logoSrc, stats] = await Promise.all([
    getOgLogo(),
    getShortStatistics().catch(() => null),
  ]);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="ASX short selling statistics"
        title={
          stats
            ? `${aud(stats.totalDollarsShorted)} is short-sold on the ASX`
            : "How much of the ASX is short-sold"
        }
        subtitle={
          stats
            ? `Across ${stats.stockCount.toLocaleString("en-AU")} companies, from official ASIC data as at ${stats.asOfDate}.`
            : "Total dollars shorted, the bank basket and sector totals — from official ASIC data."
        }
        stats={
          stats
            ? [
                { label: "Total shorted", value: aud(stats.totalDollarsShorted) },
                { label: "Big four banks", value: aud(stats.bankBasketTotal) },
                {
                  label: "Avg short interest",
                  value: `${stats.avgShortPct.toFixed(2)}%`,
                },
              ]
            : undefined
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
