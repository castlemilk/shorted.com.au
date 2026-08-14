import {
  METRIC_BY_KEY,
  STATE_SLUGS,
  type StateSlug,
} from "@/lib/economy/map-metrics";

/**
 * Per-state data availability, derived from the map-metric registry's
 * `unavailableStates` — one source of truth shared with the map fill + tooltip
 * notes. Extracted from the old state-dossier so both the state page and its
 * SSR chip strip can gate on the same lists.
 *
 * (Narrow to kind:"series" — only series metrics carry unavailableStates.)
 */
export const unavailableFor = (key: "unemployment" | "diesel_sales"): StateSlug[] => {
  const m = METRIC_BY_KEY[key];
  return m.kind === "series" ? m.unavailableStates ?? [] : [];
};

/** States with a seasonally-adjusted labour-force series (excludes NT, ACT). */
export const HAS_LABOUR: StateSlug[] = STATE_SLUGS.filter(
  (s) => !unavailableFor("unemployment").includes(s),
);

/** States with a diesel-sales series (excludes ACT — folded into NSW). */
export const HAS_DIESEL: StateSlug[] = STATE_SLUGS.filter(
  (s) => !unavailableFor("diesel_sales").includes(s),
);

export const hasLabour = (s: StateSlug): boolean => HAS_LABOUR.includes(s);
export const hasDiesel = (s: StateSlug): boolean => HAS_DIESEL.includes(s);
