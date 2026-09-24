/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";

import { OG_SIZE, OG_CONTENT_TYPE, OgCard, OgSilhouetteCard, getOgLogo } from "~/@/lib/og/card";
import { getStateSilhouette } from "~/@/lib/og/state-silhouette";
import { STATE_NAMES, slugToState } from "~/@/lib/housing/states";
import { getCouncilProfile } from "~/app/actions/getHousing";

export const alt = "Council profile — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

/**
 * The council card: the state silhouette beside the council's name and its
 * ABS estimated resident population. Reads the same cached profile the page
 * does; any failure degrades to a name derived from the slug, never a 500.
 */
export default async function Image({ params }: { params: Promise<{ state: string; slug: string }> }) {
  const logoSrc = await getOgLogo();
  const { state, slug } = await params;
  const code = slugToState(state);
  const stateName = code ? STATE_NAMES[code] : undefined;
  let summary;
  try {
    summary = code ? (await getCouncilProfile(code, slug))?.profile?.summary : undefined;
  } catch {
    summary = undefined;
  }
  const name = summary?.displayName ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const copy = {
    eyebrow: summary?.kind === "unincorporated" ? "Unincorporated area" : "Council profile",
    title: stateName ? `${name}, ${stateName}` : name,
    subtitle: summary && summary.population > 0
      ? `${summary.population.toLocaleString("en-AU")} residents (ABS estimated resident population ${summary.erpYear}) — suburbs, housing, grants, hazards and representation.`
      : "Suburbs, housing, grants, hazards and representation for one local government area.",
    logoSrc,
  };
  const silhouette = getStateSilhouette(state);
  return new ImageResponse(silhouette ? <OgSilhouetteCard {...copy} silhouette={silhouette} /> : <OgCard {...copy} />, size);
}
