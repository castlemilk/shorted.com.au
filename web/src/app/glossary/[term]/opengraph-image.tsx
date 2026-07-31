/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getTermBySlug } from "~/@/data/glossary-terms";

export const alt = "ASX Short Selling Glossary — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** Satori does not hyphenate, so trim rather than let a definition overflow. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max).trimEnd()}…`;
}

export default async function Image({
  params,
}: {
  params: Promise<{ term: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { term: slug } = await params;
  const term = getTermBySlug(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Glossary"
        title={term?.term ?? "The short selling glossary"}
        subtitle={
          term
            ? clamp(term.definition, 190)
            : "Plain-English definitions for every term in ASX short selling and market structure."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
