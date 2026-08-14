/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getScan } from "~/@/lib/scans/registry";

export const alt = "ASX Short Interest Scan — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-scan card. Copy comes from the scan registry, so a new scan gets a
 * correct card for free and the card can never drift from the page's own H1.
 * No data fetch — the registry is static, so this cannot fail on the API.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { slug } = await params;
  const scan = getScan(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Daily scan"
        title={scan?.h1 ?? "ASX short interest scans"}
        subtitle={
          scan?.dek ??
          "Crowded shorts, fast risers, squeezes and covering — refreshed with every ASIC report."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
