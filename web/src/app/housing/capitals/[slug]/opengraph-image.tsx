/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { getCapital } from "~/@/lib/housing/capitals";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Australian capital median house price — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Registry-only card: Open Graph rendering never loads a price snapshot. */
export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const capital = getCapital(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Capital house prices"
        title={capital?.h1 ?? "Australian capital house prices"}
        subtitle={
          capital?.dek ??
          "Quarterly ABS established-house transfer medians across Australia's eight capital regions."
        }
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
