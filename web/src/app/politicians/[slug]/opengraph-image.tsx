/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { getRegisterExplorer } from "~/app/actions/getPoliticians";

export const alt = "Parliament's Portfolio — Register of Interests";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// nodejs (default) so the aggregate fetch below can use the same Connect-RPC
// server action the hub page uses; regenerated daily like every other card.
export const revalidate = 86400;

/**
 * NAMES NOBODY, BY DESIGN — on the one route that is entirely about a person.
 *
 * A PNG cannot carry a citation a reader can click or a dispute path, so
 * editorial rule 8 is unsatisfiable on a share card, and the exemption the
 * hub and compare cards trade on requires the card to render NO individual's
 * data: no name, no holding, no portrait (a CC BY portrait would also need a
 * credit hyperlink a PNG cannot carry). The og:title/og:description already
 * name the member in the page's own reviewed words; the IMAGE stays a
 * register-layer card. Its figures are register-wide COUNTS — reused verbatim
 * from the hub's tile labels — and every fetch failure degrades to the card
 * without the stat row, never a 500.
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
      "[opengraph-image] politician slug aggregate fetch failed:",
      err,
    );
  }

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Register of interests"
        title="Every parliamentarian, and what they declare"
        subtitle="Counts of declared entries in the federal registers — what is held, never quantity or value."
        stats={stats}
        footer="Registers of Members' and Senators' Interests"
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
