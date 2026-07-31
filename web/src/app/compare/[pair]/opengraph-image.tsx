/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  OgVersus,
  getOgLogo,
} from "~/@/lib/og/card";
import { getStock } from "~/app/actions/getStock";
import { formatCompanyName } from "~/@/lib/company-name";

export const alt = "Compare ASX stocks by short interest — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

const PAIR_RE = /^([A-Z0-9]{1,4})-vs-([A-Z0-9]{1,4})$/i;

/**
 * The head-to-head card. A "X vs Y" comparison is the most inherently
 * shareable page we have, so it gets the real numbers rather than a banner.
 *
 * Every failure path degrades to a card instead of throwing: a bad slug, a
 * missing stock, or an API wobble all still produce a valid 1200x630 PNG,
 * because a crawler or a chat unfurl must never get a 500.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ pair: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { pair } = await params;
  const m = PAIR_RE.exec(pair ?? "");

  const generic = (
    <OgCard
      eyebrow="Compare"
      title="Compare any two ASX stocks"
      subtitle="Short interest, price and momentum side by side, from official ASIC data."
      logoSrc={logoSrc}
    />
  );

  if (!m) return new ImageResponse(generic, size);

  const a = m[1]!.toUpperCase();
  const b = m[2]!.toUpperCase();

  const [stockA, stockB] = await Promise.all([
    getStock(a).catch(() => undefined),
    getStock(b).catch(() => undefined),
  ]);

  if (!stockA || !stockB) return new ImageResponse(generic, size);

  const pct = (n: number | undefined) =>
    typeof n === "number" && n > 0 ? `${n.toFixed(2)}%` : "—";

  return new ImageResponse(
    (
      <OgVersus
        eyebrow="ASX short interest"
        left={{
          code: a,
          name: formatCompanyName(stockA.name, a) || undefined,
          value: pct(stockA.percentageShorted),
          caption: "shorted",
        }}
        right={{
          code: b,
          name: formatCompanyName(stockB.name, b) || undefined,
          value: pct(stockB.percentageShorted),
          caption: "shorted",
        }}
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
