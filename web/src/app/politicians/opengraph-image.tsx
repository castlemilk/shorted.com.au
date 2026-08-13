/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getRegisterExplorer } from "~/app/actions/getPoliticians";

export const alt = "Australian Politicians' Share Register";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The hub card. Rule 1: cite the source on the surface. A PNG cannot carry a
 * clickable dispute path, which is why this card names nobody — its figures
 * are register-wide COUNTS with the hub's own tile labels, and a fetch
 * failure degrades to the copy-only card, never a 500.
 */
export default async function Image() {
  const logoSrc = await getOgLogo();

  let stats: Array<{ label: string; value: string }> | undefined;
  try {
    const explorer = await getRegisterExplorer();
    if (explorer && explorer.politicianCount > 0) {
      stats = [
        {
          label: "parliamentarians",
          value: explorer.politicianCount.toLocaleString("en-AU"),
        },
        {
          label: "entries currently declared",
          value: explorer.currentDeclaredCount.toLocaleString("en-AU"),
        },
        {
          label: "ASX-listed companies declared",
          value: explorer.distinctCompanyCount.toLocaleString("en-AU"),
        },
      ].filter((s) => s.value !== "0");
    }
  } catch (err) {
    console.error(
      "[opengraph-image] politicians hub aggregate fetch failed:",
      err,
    );
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow={"Register of interests"}
        title={"What Australian politicians declare"}
        subtitle={
          "Declared interests in the federal Registers of Members' and Senators' Interests, matched to ASX codes — what is held, never quantity or value."
        }
        stats={stats}
        footer="Registers of Members' and Senators' Interests"
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
