/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getAuthorBySlug } from "~/@/data/authors";

export const alt = "Author — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

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
  const author = getAuthorBySlug(slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Author"
        title={author?.name ?? "Shorted authors"}
        subtitle={
          author
            ? clamp(author.bio, 190)
            : "Who writes the analysis behind Shorted.com.au."
        }
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
