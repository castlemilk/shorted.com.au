/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { getHousingRanking } from "~/@/lib/housing-rankings/registry";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Australian Suburb House Price Ranking — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Registry-only card: Open Graph rendering never depends on the housing API. */
export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ranking = getHousingRanking(slug);
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Housing ranking"
        title={ranking?.h1 ?? "Australian suburb rankings"}
        subtitle={
          ranking?.dek ??
          "State-by-state suburb house price rankings from official housing and ABS data."
        }
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
