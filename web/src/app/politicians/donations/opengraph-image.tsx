/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Party funding and donations — AEC Transparency Register";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream, and cached for
// a day like every other card. No figures at all: the funding explorer is the
// one politician surface where currency amounts are in scope, and a share
// card is not the place to start rendering them.
export const revalidate = 86400;

/**
 * Names nobody and no party. The card describes the source and keeps the
 * register/funding distinction the page's own copy draws: party money is not
 * attributable to any individual member.
 */
export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="AEC Transparency Register"
        title="Party funding and donations"
        subtitle="What registered parties declared receiving, who the payers were, and which of them are ASX-listed companies, as lodged with the AEC. Party money is not attributable to any individual member."
        footer="AEC Transparency Register"
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
