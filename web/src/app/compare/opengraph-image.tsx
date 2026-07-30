/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  getOgLogo,
} from "~/@/lib/og/card";

export const alt = 'Compare ASX Stocks';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the data-driven cards.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow={'Compare'}
        title={'Compare any two ASX stocks'}
        subtitle={'Short interest, price and momentum side by side.'}
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
