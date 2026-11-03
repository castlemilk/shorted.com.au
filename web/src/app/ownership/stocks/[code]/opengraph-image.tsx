import { ImageResponse } from "next/og";

import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { OG_CONTENT_TYPE, OG_SIZE, OgCard, getOgLogo } from "~/@/lib/og/card";
import { REGISTER_CODE_PATTERN } from "~/@/lib/ownership/kinds";
import {
  disclosedOf,
  interestsOf,
  isUnknownRegister,
  readRegister,
  registerCompany,
  type RegisterResponse,
} from "./register-data";

export const maxDuration = 15;

// Static, as the other ownership cards: a route with a per-param alt would need
// generateImageMetadata, which changes the image URL.
export const alt = "Substantial holders from ASX notices, on Shorted";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 3600;

const SUBTITLE =
  "Substantial holders as their ASX notices state them, beside the index funds and super options that hold it.";

/**
 * The read the card draws from. The card never fails a render: a code the path
 * refuses, a failed read and a code the register knows nothing of all draw the
 * card without figures, so a 500 never reaches a social preview.
 */
async function cardData(code: string): Promise<RegisterResponse | undefined> {
  if (!REGISTER_CODE_PATTERN.test(code)) return undefined;
  try {
    const data = await readRegister(code);
    return isUnknownRegister(data) ? undefined : data;
  } catch {
    return undefined;
  }
}

/**
 * The card's figures, each "n/a" until the register holds it. The disclosed sum
 * and the interest count are the readout's; short interest stays its own figure.
 * The sum's label carries the caveat every sum on the site carries: it is what the
 * notices disclose, not a share of the company.
 */
function statsOf(data: RegisterResponse): Array<{ label: string; value: string }> {
  const { summary } = data;
  const current = summary.holders > 0;
  return [
    { label: "disclosed, not a share", value: current ? disclosedOf(summary) : NOT_AVAILABLE },
    {
      label: "interests counted once",
      value: current ? interestsOf(summary).toLocaleString("en-AU") : NOT_AVAILABLE,
    },
    ...(summary.hasShortPct ? [{ label: "short interest", value: formatPct(summary.shortPct, { digits: 2 }) }] : []),
  ];
}

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const logoSrc = await getOgLogo();
  const code = (await params).code.toUpperCase();
  const data = await cardData(code);
  const company = data ? registerCompany(code, data) : code;
  const footer = data && data.asOf ? `ASX substantial holding notices to ${data.asOf}` : "ASX substantial holding notices";
  return new ImageResponse(
    (
      <OgCard
        eyebrow={`ASX:${code} register`}
        title={`${company} substantial holders`}
        subtitle={SUBTITLE}
        stats={data ? statsOf(data) : undefined}
        footer={footer}
        logoSrc={logoSrc}
      />
    ),
    size,
  );
}
