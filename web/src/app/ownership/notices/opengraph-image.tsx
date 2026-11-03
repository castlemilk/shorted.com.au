import { ImageResponse } from "next/og";

import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { loadNoticeFeed } from "~/app/actions/ownershipExplorer";

export const maxDuration = 15;

// Static on purpose, as the hub's card: a per-parameter alt needs
// generateImageMetadata, which also changes the image URL.
export const alt = "ASX substantial holding notices, on Shorted";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 3600;

const SUBTITLE =
  "Who became substantial, whose holding changed and who ceased, from the ASX notices we could read, newest release first.";

/**
 * The notices card: the default window's counts over the headline. It reads the
 * same default view the page does, so its figures are the page's own. A failed
 * read draws the card without a stat row, never a 500.
 */
export default async function Image() {
  const logoSrc = await getOgLogo();

  let stats: Array<{ label: string; value: string }> | undefined;
  let footer = "ASX substantial holding notices";
  try {
    const feed = await loadNoticeFeed({});
    if (feed.ok && feed.activityOk && feed.activity) {
      stats = [
        { label: "notices in the last 30 days", value: feed.total.toLocaleString("en-AU") },
        { label: "became substantial", value: feed.activity.became.toLocaleString("en-AU") },
        { label: "ceased", value: feed.activity.ceased.toLocaleString("en-AU") },
      ];
    }
    if (feed.asOf) footer = `ASX substantial holding notices to ${feed.asOf}`;
  } catch (err) {
    console.error("[opengraph-image] notices feed fetch failed:", err);
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Ownership"
        title="ASX substantial holding notices"
        subtitle={SUBTITLE}
        stats={stats}
        footer={footer}
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
