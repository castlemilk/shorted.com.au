/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  OgSilhouetteCard,
  getOgLogo,
} from "~/@/lib/og/card";
import { getStateSilhouette } from "~/@/lib/og/state-silhouette";
import { STATE_NAMES, type StateSlug } from "~/@/lib/economy/map-metrics";

export const alt = "Australian state economy — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-state economy card: the state's own boundary silhouette beside the copy
 * — the same SVG path the page's banner hero renders, computed server-side
 * from the committed ABS topojson (no fetch, so the card cannot fail on a
 * slow upstream). An unknown slug or unreadable boundary file degrades to the
 * plain text card, never a 500.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { state } = await params;
  const name = STATE_NAMES[state as StateSlug];
  const silhouette = getStateSilhouette(state);

  const copy = {
    eyebrow: "Macro dashboard",
    title: name ? `The ${name} economy` : "The Australian economy",
    subtitle:
      "Unemployment, trade, state final demand and fuel — from ABS, RBA and DCCEEW open data.",
    logoSrc,
  };

  return new ImageResponse(
    silhouette ? (
      <OgSilhouetteCard {...copy} silhouette={silhouette} />
    ) : (
      <OgCard {...copy} />
    ),
    size,
  );
}
