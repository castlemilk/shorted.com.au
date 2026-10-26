/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getOwnershipOverview } from "~/app/actions/getOwnership";

export const maxDuration = 15;

export const alt = "Who owns the ASX — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The hub card: the hub's headline over its coverage counts, with the tiles'
 * own labels. Reads the same cached overview the page does; a failed read,
 * or a database the first collection has not filled, degrades to the card
 * without the stat row, never a 500.
 */
export default async function Image() {
  const logoSrc = await getOgLogo();

  let stats: Array<{ label: string; value: string }> | undefined;
  try {
    const overview = await getOwnershipOverview();
    if (overview && overview.noticesParsed > 0) {
      stats = [
        { label: "substantial holding notices read", value: overview.noticesParsed.toLocaleString("en-AU") },
        { label: "APRA-regulated super funds", value: overview.superFunds.toLocaleString("en-AU") },
        { label: "ASX exchange-traded products", value: overview.etfs.toLocaleString("en-AU") },
      ].filter((s) => s.value !== "0");
    }
  } catch (err) {
    console.error("[opengraph-image] ownership overview fetch failed:", err);
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Ownership"
        title="Who owns the ASX"
        subtitle="Super funds, index funds, hedge funds and banks: every substantial holding notice read from its PDF, and the holdings files of the largest index ETFs and super funds."
        stats={stats}
        footer="ASX substantial holding notices"
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
