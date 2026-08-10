import { cache } from "react";
import { ALL_STATES, stateSlug } from "@/lib/housing/states";

/** State slugs for the sitemap. */
export const getHousingStateSlugs = cache(async (): Promise<string[]> => ALL_STATES.map(stateSlug));
