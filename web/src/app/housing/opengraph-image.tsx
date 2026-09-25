/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { getHousingOverview } from "~/app/actions/getHousing";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { OG_CONTENT_TYPE, OG_SIZE, OgSceneCard, getOgLogo } from "@/lib/og/card";

export const alt = "Australian House Prices Tracker — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Refreshed daily like the data-driven cards; the copy below is the fallback
// a flaky upstream gets, never a 500.
export const revalidate = 86400;

/**
 * The housing HUB card on the same scene canvas as the per-suburb cards. The
 * hub has no suburb to key an archetype from, so it borrows the most
 * representative bake (leafy-suburban) — the same committed asset the suburb
 * cards embed — and carries the three biggest capital medians from the same
 * ABS series the page's tiles render.
 */
function sceneDataUri(): string {
  // INLINE LITERAL paths: Vercel's tracer bundles only what it can statically
  // resolve (next.config outputFileTracingIncludes covers this route too).
  for (const base of [process.cwd(), join(process.cwd(), "web")]) {
    try {
      const p = join(base, "public", "housing-banners", "og", "leafy-suburban.jpg");
      return `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;
    } catch {
      // try the next candidate
    }
  }
  return "";
}

const CAPITALS: Record<string, string> = {
  "1GSYD": "Sydney",
  "2GMEL": "Melbourne",
  "3GBRI": "Brisbane",
  "4GADE": "Adelaide",
  "5GPER": "Perth",
  "6GHOB": "Hobart",
  "7GDAR": "Darwin",
  "8ACTE": "Canberra",
};

export default async function Image() {
  let subtitle = "Capital-city medians, suburb profiles, price cuts and rankings from ABS, RBA and Valuer-General open data.";
  let stats: Array<{ label: string; value: string; tone?: "up" | "down" | "flat" }> = [];
  try {
    const overview = await getHousingOverview("gccsa");
    const medians = (overview?.metrics ?? [])
      .filter((m) => m.measure === "median_price" && m.dwellingType === "established_house" && CAPITALS[m.regionCode])
      .sort((a, b) => b.value - a.value);
    if (medians.length) {
      stats = medians.slice(0, 3).map((m) => ({
        label: `${CAPITALS[m.regionCode]} · ${m.yoyPct >= 0 ? "+" : ""}${m.yoyPct.toFixed(1)}% yr`,
        value: fmtPriceShort(m.value),
        // Rising prices read as growth here (green), the opposite of the
        // short-interest convention on the stock cards.
        tone: m.yoyPct >= 0 ? "down" : "up",
      }));
      const period = medians[0]?.period?.seconds;
      if (period) {
        const d = new Date(Number(period) * 1000);
        subtitle = `Established-house medians for the ${d.toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })} quarter, with every suburb's profile, price cuts and rankings beneath.`;
      }
    }
  } catch (err) {
    console.error("[opengraph-image] housing overview unavailable:", err);
  }

  return new ImageResponse(
    (
      <OgSceneCard
        eyebrow="Australian house prices"
        title="House prices, suburb by suburb"
        subtitle={subtitle}
        stats={stats}
        sceneSrc={sceneDataUri()}
        footer="shorted.com.au/housing"
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
