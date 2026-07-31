/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "The Shorted Blog — ASX short selling analysis";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Blog"
        title="Notes on shorting the ASX"
        subtitle="Analysis, data stories and what bearish positioning reveals about the Australian market."
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
