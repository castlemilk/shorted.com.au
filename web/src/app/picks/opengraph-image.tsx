/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "ASX Stock Picker";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the /scans cards.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Stock picker"
        title="ASX Stock Picker"
        subtitle="Zanger breakouts, CAN SLIM, the Minervini Trend Template and crowded-short breakouts, with every rule shown pass or fail."
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
