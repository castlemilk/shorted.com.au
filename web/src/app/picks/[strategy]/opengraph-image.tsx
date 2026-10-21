/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { strategyArt } from "~/@/lib/strategies/art";
import { getStrategy } from "~/@/lib/strategies/registry";
import { sceneStill } from "~/@/lib/strategies/scenes";

export const maxDuration = 15;

export const alt = "ASX stock picker strategy on Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The strategy's baked share-card scene (web/scripts/picks-art/bake.mjs) as a
 * data URI, or "" when the strategy has no art or the file cannot be read:
 * the card then draws its plain canvas, never a 500. Read off disk like the
 * logo; the manifest (lib/strategies/art.ts) says which strategies have one.
 */
async function getStrategyArt(slug: string): Promise<string> {
  const art = strategyArt(slug);
  if (!art) return "";
  try {
    const data = await readFile(join(process.cwd(), "public", "picks-art", "og", `${slug}.jpg`));
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  } catch {
    return "";
  }
}

/**
 * Per-strategy card. Copy comes from the strategy registry, so the card can
 * never drift from the page's own H1 and needs no data fetch: it cannot fail
 * on the API. The strategy's generative scene (its still, as plate-shaped
 * SVG) sits behind the copy; baked brandbrain art, where it exists, takes
 * its place.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ strategy: string }>;
}) {
  const { strategy: slug } = await params;
  const strategy = getStrategy(slug);
  const [logoSrc, backgroundSrc] = await Promise.all([
    getOgLogo(),
    strategy ? getStrategyArt(strategy.slug) : Promise.resolve(""),
  ]);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Stock picker"
        title={strategy?.h1 ?? "ASX Stock Picker"}
        subtitle={
          strategy?.dek ??
          "Named strategies applied to ASX stocks, with every rule shown pass or fail."
        }
        backgroundSrc={backgroundSrc}
        scene={strategy ? sceneStill(strategy.slug, "plate") : undefined}
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
