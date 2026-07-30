/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  getOgLogo,
} from "~/@/lib/og/card";

export const alt = "Australian Politicians' Share Register";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the data-driven cards.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow={'Register of interests'}
        title={'What Australian politicians declare'}
        subtitle={"Shareholdings declared in the federal Register of Members' Interests, matched to ASX codes."}
        // Rule 1: cite the source on the surface. A PNG cannot carry a
        // clickable dispute path, which is why this card names nobody.
        footer="Register of Members' Interests"
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
