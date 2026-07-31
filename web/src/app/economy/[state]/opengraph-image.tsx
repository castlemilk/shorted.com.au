/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { STATE_NAMES, type StateSlug } from "~/@/lib/economy/map-metrics";

export const alt = "Australian state economy — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-state economy card. Static copy off the state map — no fetch, so it
 * cannot fail on the ABS/RBA series being slow.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { state } = await params;
  const name = STATE_NAMES[state as StateSlug];

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Macro dashboard"
        title={name ? `The ${name} economy` : "The Australian economy"}
        subtitle="Unemployment, trade, state final demand and fuel — from ABS, RBA and DCCEEW open data."
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
