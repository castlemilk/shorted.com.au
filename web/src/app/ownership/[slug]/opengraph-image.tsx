/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { formatAmount } from "~/@/lib/fundamentals/format";
import { isInstitutionSlug, kindInfo } from "~/@/lib/ownership/kinds";
import { getInstitution } from "~/app/actions/getOwnership";

export const maxDuration = 15;

export const alt = "Institution holdings — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The institution card: its name and kind over the page's summary counts
 * (current stakes of 5%+, notices read, APRA total assets). Reads the same
 * cached institution the page does; any failure degrades to a name derived
 * from the slug, never a 500.
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const logoSrc = await getOgLogo();
  const { slug } = await params;
  let data;
  try {
    data = isInstitutionSlug(slug) ? await getInstitution(slug) : undefined;
  } catch {
    data = undefined;
  }
  const inst = data?.institution;
  const name = inst?.name ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const stats = inst
    ? [
        { label: "current stakes of 5%+", value: inst.substantialPositions.toLocaleString("en-AU") },
        { label: "notices read", value: inst.notices.toLocaleString("en-AU") },
        ...(inst.hasAum ? [{ label: "total assets (APRA)", value: formatAmount(inst.aumAud, "AUD") }] : []),
      ].filter((s) => s.value !== "0")
    : undefined;
  return new ImageResponse(
    (
      <OgCard
        eyebrow={inst ? kindInfo(inst.kind).label : "Ownership"}
        title={name}
        subtitle={
          data && data.fundHoldings.length > 0
            ? "What it holds on the ASX: substantial holdings from its own notices, and the holdings files it publishes."
            : "What it holds on the ASX: substantial holdings from its own notices (Forms 603, 604 and 605)."
        }
        stats={stats && stats.length > 0 ? stats : undefined}
        footer="ASX substantial holding notices"
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
