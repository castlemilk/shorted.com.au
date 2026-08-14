/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getTopShortsSummary } from "~/app/actions/getTopShorts";
import { filterEligibleTopShorts } from "~/@/lib/top-shorts-filter";
import { formatCompanyName } from "~/@/lib/company-name";

export const alt = "Most Shorted ASX Stocks — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Leads with the actual most-shorted stock, so the card changes as the
 * ranking does instead of being a static banner.
 *
 * summaryOnly keeps the payload small (no sparkline points) and bypasses the
 * action-layer eligibility filter, so filter here or an ETF can top the card.
 * Falls back to the static headline if the API is unavailable — a share fetch
 * must never 500.
 */
export default async function Image() {
  const [logoSrc, summary] = await Promise.all([
    getOgLogo(),
    getTopShortsSummary("3m", 20).catch(() => null),
  ]);

  const rows = filterEligibleTopShorts(summary?.timeSeries ?? []).slice(0, 3);
  const leader = rows[0];

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Most shorted ASX stocks"
        title={
          leader
            ? `${formatCompanyName(leader.name, leader.productCode) || leader.productCode} leads the ASX short list`
            : "The most shorted stocks on the ASX"
        }
        subtitle="Ranked by short interest from official ASIC reports, updated daily with a T+4 delay."
        stats={
          rows.length
            ? rows.map((r) => ({
                label: r.productCode,
                value: `${r.latestShortPosition.toFixed(1)}%`,
              }))
            : undefined
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
