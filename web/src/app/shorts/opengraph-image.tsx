/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "ASX Short Positions — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Short positions"
        title="Every short position on the ASX"
        subtitle="Official ASIC short position data for every listed company, updated daily with a T+4 delay."
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
