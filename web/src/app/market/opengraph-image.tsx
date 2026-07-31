/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  getOgLogo,
} from "~/@/lib/og/card";

export const alt = 'ASX Market Snapshot';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the data-driven cards.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow={'Market'}
        title={'The ASX short selling snapshot'}
        subtitle={'Every reported short position for a single trading day.'}
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
