/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { articlesData } from "./articles-data";

export const alt = "Short selling on the ASX, explained — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Satori does not hyphenate, so trim on a word boundary rather than overflow. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > 40 ? sp : max).trimEnd()}…`;
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { slug } = await params;
  const article = articlesData[slug];

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Learn"
        title={article ? clamp(article.title, 90) : "Short selling on the ASX"}
        subtitle={
          article
            ? clamp(article.description, 180)
            : "Guides to short interest, squeezes, ASIC reporting and how shorting actually works."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
