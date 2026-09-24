/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { getSuburbProfile, resolveSuburbSalCode } from "~/app/actions/getHousing";
import { STATE_NAMES, slugToState, titleCaseName } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { getSuburbGeometry } from "@/lib/housing/suburb-geometry.server";
import { suburbCardStats, suburbCardSubtitle } from "@/lib/housing/suburb-card-copy";
import { OG_CONTENT_TYPE, OG_SIZE, OgSceneCard, getOgLogo } from "@/lib/og/card";

export const alt = "Suburb house prices & demographics — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// nodejs (not edge): the profile fetch uses the same Connect-RPC server actions
// the page uses, and the boundary + scene assets are read off disk.
export const runtime = "nodejs";
// Regenerate daily — matches the page's own revalidate, so a later-arriving
// median price / archetype (or a transient RPC failure) doesn't freeze into
// the card for a full year (same rationale as the stock OG route).
export const revalidate = 86400;

// An empty list enables on-demand ISR for this dynamic metadata route without
// prebuilding the full suburb corpus.
export function generateStaticParams(): Array<{ state: string; suburb: string }> {
  return [];
}

/** kebab-slug -> Title Case, dropping a trailing postcode segment. The
 * guaranteed fallback name — it needs no DB access, so it renders even against
 * an empty local DB. */
function titleCase(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  if (parts.length > 1 && /^\d{3,4}$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const SCENES = new Set([
  "bushland", "coastal-beach", "farmland", "harbour", "hills-ranges",
  "inner-terraces", "leafy-suburban", "parkland", "river-valley", "urban-skyline",
]);

/**
 * The archetype's dark-toned scene JPEG as a data URI — the same art family the
 * page banner draws (the banner uses the AVIF band; satori cannot decode AVIF,
 * hence the JPEG bake). process.cwd() at runtime can resolve to either the repo
 * root or web/, so try both. Unknown archetypes fall back to the plain canvas.
 */
function sceneDataUri(archetype: string): string {
  const key = SCENES.has(archetype) ? archetype : "leafy-suburban";
  for (const base of [process.cwd(), join(process.cwd(), "web")]) {
    try {
      const p = join(base, "public", "housing-banners", "og", `${key}.jpg`);
      return `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;
    } catch {
      // try the next candidate
    }
  }
  return "";
}

export default async function Image({
  params,
}: {
  params: Promise<{ state: string; suburb: string }>;
}) {
  const { state, suburb } = await params;

  let name = titleCase(suburb);
  let stateName = "";
  let archetype = "leafy-suburban";
  let subtitle: string | undefined;
  let stats: ReturnType<typeof suburbCardStats> = [];
  let silhouette: ReturnType<typeof getSuburbGeometry> extends infer G
    ? G extends { locator: infer L } ? L | null : null
    : null = null;

  // Best-effort enrichment. The local DB is empty and prod must never 500 on a
  // crawler/share fetch, so any failure here just falls back to the
  // slug-derived name + defaults above.
  try {
    const code = slugToState(state);
    if (code) {
      stateName = STATE_NAMES[code] ?? code;
      const sal = await resolveSuburbSalCode(code, suburb);
      if (sal) {
        // Transient failures return undefined and real misses throw; either way
        // this best-effort card falls back to its slug-derived content.
        const profile = await getSuburbProfile(sal);
        if (profile?.summary?.salName) name = titleCaseName(profile.summary.salName);
        if (profile?.banner?.archetype) archetype = profile.banner.archetype;
        if (profile?.summary) {
          subtitle = suburbCardSubtitle({
            stateName,
            archetype,
            blurb: profile.banner?.blurb,
            lgaName: profile.council?.lgaName,
          });
          stats = suburbCardStats({
            latestMedianPrice: profile.summary.latestMedianPrice,
            yoyPct: profile.summary.yoyPct,
            population: profile.demographics?.population,
            medianWeeklyHhdIncome: profile.demographics?.medianWeeklyHhdIncome,
            medianAge: profile.demographics?.medianAge,
            seifaDecile: profile.summary.seifa?.irsad?.decileAus,
            fmtPrice: fmtPriceShort,
          });
        }
        // The same projected boundary the page's banner inset renders.
        silhouette = getSuburbGeometry(code, sal)?.locator ?? null;
      }
    }
  } catch (err) {
    console.error(`[opengraph-image] suburb profile fetch failed for ${state}/${suburb}:`, err);
  }

  const [logoSrc, sceneSrc] = [await getOgLogo(), sceneDataUri(archetype)];

  return new ImageResponse(
    (
      <OgSceneCard
        eyebrow={stateName ? `House prices · ${stateName}` : "House prices"}
        title={name}
        subtitle={subtitle ?? "Median house prices, ABS Census demographics and local context."}
        stats={stats}
        sceneSrc={sceneSrc}
        silhouette={silhouette}
        footer="shorted.com.au/housing"
        logoSrc={logoSrc}
      />
    ),
    { ...size },
  );
}
