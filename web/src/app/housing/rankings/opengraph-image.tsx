/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Australian Suburb House Price Rankings";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Housing rankings"
        title="Australian suburbs, ranked state by state"
        subtitle="Cheapest, most expensive, fastest-changing and price-to-income rankings from official housing and ABS data."
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
