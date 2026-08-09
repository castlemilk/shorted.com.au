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
import { STATE_NAMES, slugToState } from "~/@/lib/housing/states";

export const alt = "Australian house prices by suburb — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-state housing card: the state's boundary silhouette beside the copy —
 * the same server-side geometry the economy state card reuses (both route
 * families share the ABS slug registry, so the same slug resolves). The
 * suburb level below has its own richer scene card; an unknown slug degrades
 * to the plain text card, never a 500.
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
  const silhouette = getStateSilhouette(state);

  const copy = {
    eyebrow: "House prices",
    title: name
      ? `${name} house prices, suburb by suburb`
      : "Australian house prices",
    subtitle:
      "Median prices, demographics and electoral drilldowns for every suburb, from ABS and RBA data.",
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
