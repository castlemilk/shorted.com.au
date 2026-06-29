import { cache } from "react";
import { listStateSuburbs } from "./getHousing";
import { ALL_STATES, stateSlug } from "@/lib/housing/states";

const slugifySuburb = (name: string, postcode: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${postcode}`;

/** State slugs for the sitemap. */
export const getHousingStateSlugs = cache(async (): Promise<string[]> => ALL_STATES.map(stateSlug));

/** Suburb URL tuples (state slug + suburb slug + sal) for the sitemap. Capped per state. */
export const getHousingSuburbUrls = cache(async (): Promise<{ state: string; suburb: string; sal: string }[]> => {
  const out: { state: string; suburb: string; sal: string }[] = [];
  for (const st of ALL_STATES) {
    try {
      const res = await listStateSuburbs(st, "", 5000);
      if (!res) continue;
      for (const s of res.suburbs) {
        if (s.latestMedianPrice > 0) { // only index suburbs with real price data (avoid thin pages)
          out.push({ state: stateSlug(st), suburb: slugifySuburb(s.salName, s.postcode), sal: s.salCode });
        }
      }
    } catch { /* soft-fail this state, like industrySlugs */ }
  }
  return out;
});
