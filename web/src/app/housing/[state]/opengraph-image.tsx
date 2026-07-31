/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { STATE_NAMES, slugToState } from "~/@/lib/housing/states";

export const alt = "Australian house prices by suburb — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-state housing card. The suburb level already has its own (richer) card;
 * this fills the gap one level up. Static copy — no fetch to fail.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { state } = await params;
  const code = slugToState(state);
  const name = code ? STATE_NAMES[code] : undefined;

  return new ImageResponse(
    (
      <OgCard
        eyebrow="House prices"
        title={name ? `${name} house prices, suburb by suburb` : "Australian house prices"}
        subtitle="Median prices, demographics and electoral drilldowns for every suburb, from ABS and RBA data."
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
