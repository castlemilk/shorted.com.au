/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getStrategy } from "~/@/lib/strategies/registry";

export const alt = "ASX stock picker strategy on Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-strategy card. Copy comes from the strategy registry, so the card can
 * never drift from the page's own H1 and needs no data fetch: it cannot fail
 * on the API.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ strategy: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { strategy: slug } = await params;
  const strategy = getStrategy(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Stock picker"
        title={strategy?.h1 ?? "ASX Stock Picker"}
        subtitle={
          strategy?.dek ??
          "Named strategies applied to ASX stocks, with every rule shown pass or fail."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
