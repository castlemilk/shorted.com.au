/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  getCompanyLogo,
  getOgLogo,
} from "~/@/lib/og/card";
import { getStock } from "~/app/actions/getStock";
import { formatCompanyName } from "~/@/lib/company-name";

export const alt = "ASX Director Trades — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-stock director-trades card, carrying the company's own mark on a light
 * chip (see lib/og/card for why the chip exists). A missing stock or logo
 * degrades to the generic headline — a share fetch must never 500.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ stockCode: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  const stock = await getStock(code).catch(() => undefined);
  const brand = await getCompanyLogo(stock?.logoUrl);
  const name = stock ? formatCompanyName(stock.name, code) : "";

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Director trades"
        title={
          name ? `Who's buying and selling ${name}` : `${code} director trades`
        }
        subtitle="Director transactions and substantial holder notices, from ASX filings."
        brand={brand}
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
