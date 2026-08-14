/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Home loan and deposit calculators — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream, and cached for
// a day like every other card.
export const revalidate = 86400;

export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Housing tools"
        title="Home loan & deposit calculators"
        subtitle="Mortgage repayments, rate-shock scenarios, years to a deposit, stamp duty in every state, and rent vs buy."
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
