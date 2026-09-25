/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { getIndustryData } from "~/app/actions/industry/getIndustryData";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "ASX Industry Intelligence — which sectors are being shorted";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Data-driven copy, refreshed daily. The static fallback below is what a flaky
// upstream gets — never a 500.
export const revalidate = 86400;

export default async function Image() {
  let subtitle = "Sector-level short positioning across the ASX, with the evidence behind each move.";
  let stats: Array<{ label: string; value: string; tone?: "up" | "down" | "flat" }> = [];
  try {
    const industries = (await getIndustryData())
      .filter((i) => i.stockCount > 0 && i.avgShortPercent > 0)
      .sort((a, b) => b.avgShortPercent - a.avgShortPercent);
    if (industries.length) {
      const top = industries.slice(0, 3);
      subtitle = `Most crowded now: ${top.map((i) => i.name).join(", ")}. ${industries.length} industries, ranked by average short interest.`;
      stats = top.map((i) => ({ label: i.name, value: `${i.avgShortPercent.toFixed(1)}%`, tone: "up" as const }));
    }
  } catch (err) {
    console.error("[opengraph-image] industry-intelligence data unavailable:", err);
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Industry intelligence"
        title="Which sectors are being shorted"
        subtitle={subtitle}
        stats={stats}
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
