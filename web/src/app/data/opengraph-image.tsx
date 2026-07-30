/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  getOgLogo,
} from "~/@/lib/og/card";

export const alt = 'Open ASX Short Selling Data';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the data-driven cards.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow={'Open data'}
        title={'Every ASIC short position, 2010 to today'}
        subtitle={'Free, CC BY 4.0. Bulk downloads, an API, and the full historical time series.'}
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
