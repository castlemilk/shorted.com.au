/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Declared interests in shorted ASX companies";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream, and cached for
// a day like every other card.
export const revalidate = 86400;

/**
 * Names nobody (the rule-8 OG exemption's condition). The subtitle carries
 * the page's own load-bearing caveat verbatim: short interest is a
 * market-wide ASIC figure for the company, never a claim about a member.
 */
export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Influence layer"
        title="Declared interests in companies carrying short interest"
        subtitle="Short interest is a market-wide ASIC figure for the company and says nothing about any member's holding."
        footer="Registers of Members' and Senators' Interests"
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
