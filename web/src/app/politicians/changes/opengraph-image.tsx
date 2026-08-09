/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getRegisterExplorer } from "~/app/actions/getPoliticians";

export const alt = "Register of Interests — recent additions and removals";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The changes-feed card. Names nobody (the rule-8 OG exemption's condition);
 * its figures are the register-wide 30-day movement counts, UNSIGNED — the
 * two directions are counted together and neither is the good half of a
 * pair, same as the hub tile. Fetch failure degrades to the copy-only card.
 */
export default async function Image() {
  const logoSrc = await getOgLogo();

  let stats: Array<{ label: string; value: string }> | undefined;
  try {
    const explorer = await getRegisterExplorer();
    if (explorer && (explorer.changes30d ?? 0) > 0) {
      stats = [
        {
          label: "changes · 30 days",
          value: explorer.changes30d.toLocaleString("en-AU"),
        },
        {
          label: "members · 30 days",
          value: (explorer.membersChanged30d ?? 0).toLocaleString("en-AU"),
        },
      ].filter((s) => s.value !== "0");
    }
  } catch (err) {
    console.error("[opengraph-image] register changes fetch failed:", err);
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Register of interests"
        title="Recent additions and removals"
        subtitle="Entries added to or removed from the Registers of Members' and Senators' Interests, with the date each change appeared. A removal is not a transaction."
        stats={stats}
        footer="Registers of Members' and Senators' Interests"
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
