/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OgCard,
  OgSilhouetteCard,
  getOgLogo,
} from "~/@/lib/og/card";
import { getStateSilhouette } from "~/@/lib/og/state-silhouette";
import { STATE_NAMES, slugToState, titleCaseName } from "~/@/lib/housing/states";
import { fmtPriceShort } from "~/@/lib/housing/price-scale";
import { buildStateSuburbDirectory } from "~/@/lib/housing/state-suburb-directory";
import { getStateSuburbIndex } from "~/app/actions/getHousingStateIndex";

export const alt = "Australian house prices by suburb — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * Per-state housing card: the state's boundary silhouette beside the copy —
 * the same server-side geometry the economy state card reuses — and the
 * state's own numbers from the same 24h-cached suburb index the page's
 * directory reads. An unknown slug or an unavailable index degrades to the
 * templated copy / plain card, never a 500.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const logoSrc = await getOgLogo();
  const { state } = await params;
  const code = slugToState(state);
  const name = code ? STATE_NAMES[code] : undefined;
  const silhouette = getStateSilhouette(state);

  let subtitle =
    "Median prices, demographics and electoral drilldowns for every suburb, from ABS and RBA data.";
  if (code) {
    try {
      const d = buildStateSuburbDirectory(await getStateSuburbIndex(code));
      const dearest = d.mostExpensive[0];
      if (d.pricedCount > 0) {
        subtitle =
          `${d.pricedCount.toLocaleString("en-AU")} suburbs with a Valuer-General median` +
          (d.averageOfMedians ? ` · average ${fmtPriceShort(d.averageOfMedians)}` : "") +
          (dearest ? ` · dearest ${titleCaseName(dearest.salName)} ${fmtPriceShort(dearest.latestMedianPrice)}` : "");
      } else if (d.total > 0) {
        subtitle = `${d.total.toLocaleString("en-AU")} suburb profiles: ABS Census population, income, schools, electorates and amenities.`;
      }
    } catch (err) {
      console.error(`[opengraph-image] state index unavailable for ${state}:`, err);
    }
  }

  const copy = {
    eyebrow: "House prices",
    title: name ? `${name} house prices, suburb by suburb` : "Australian house prices",
    subtitle,
    logoSrc,
  };

  return new ImageResponse(
    silhouette ? (
      <OgSilhouetteCard {...copy} silhouette={silhouette} />
    ) : (
      <OgCard {...copy} />
    ),
    size,
  );
}
