/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, getOgLogo } from "~/@/lib/og/card";

export const alt = "Compare declared interests — Parliament's Portfolio";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Static copy, so the card can never fail on a flaky upstream, and cached for a
// day like every other card.
export const revalidate = 86400;

/**
 * NAMES NOBODY, BY DESIGN.
 *
 * A PNG cannot carry a citation a reader can click or a dispute path, so
 * editorial rule 8 is unsatisfiable on a share card. The trade the hub card
 * already makes applies here with more force: this route exists to put two
 * named parliamentarians beside each other, and a card that rendered the pair —
 * or their counts — would be exactly the un-disputable juxtaposition the
 * standards forbid. So the card describes the tool, cites the register, and
 * carries no name, no count and no comparison of any kind.
 */
export default async function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Register of interests"
        title="Compare what two parliamentarians declare"
        subtitle="Register categories, shared ASX-listed companies and coverage notes — counts of declared entries, never quantity or value."
        footer="Registers of Members' and Senators' Interests"
        logoSrc={await getOgLogo()}
      />
    ),
    size,
  );
}
