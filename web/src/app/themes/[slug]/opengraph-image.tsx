/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getTheme } from "~/@/lib/themes/registry";

export const alt = "ASX Stock Theme — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-theme card. Copy comes from the theme registry, so a new theme gets a
 * correct card for free and the card can never drift from the page's own H1.
 * No data fetch — the registry is static, so this cannot fail on the API.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { slug } = await params;
  const theme = getTheme(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Theme"
        title={theme?.h1 ?? "ASX stock themes"}
        subtitle={
          theme?.dek ??
          "Curated ASX baskets ranked by short interest, from official ASIC data."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
