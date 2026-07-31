/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "ASX Short Positions Snapshot — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/** "2026-07-20" → "20 July 2026"; anything unparseable passes through. */
function prettyDate(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export default async function Image({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { date } = await params;
  const pretty = prettyDate(date);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Market snapshot"
        title={
          pretty
            ? `ASX short positions, ${pretty}`
            : "ASX short positions by day"
        }
        subtitle="Every reported short position for a single trading day, from official ASIC data."
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
