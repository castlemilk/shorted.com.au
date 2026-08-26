/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { CAPITALS } from "~/@/lib/housing/capitals";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt =
  "Australian capital city median house prices — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Static card: no price snapshot or other live data is loaded. */
export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Australian housing"
        title="Median house prices by capital city"
        subtitle={`${CAPITALS.length} ABS capital regions ranked by established-house transfer medians, with house and unit comparisons.`}
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
