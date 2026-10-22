/**
 * /economy/[state] metadata, built from what the page shows.
 *
 * The title promised "unemployment" on all eight state pages and the
 * description "diesel sales", but NT and ACT have no seasonally adjusted
 * labour series, so no unemployment chip, and ACT has no diesel series (it is
 * folded into NSW): availability.ts, from the map registry's
 * unavailableStates. The titles also rendered at 68-88 characters with the
 * root template's " | Shorted" (SEO review, 2026-10-21; its title budget is
 * 65).
 */
import { siteConfig } from "~/@/config/site";
import { hasDiesel, hasLabour } from "@/components/economy/availability";
import { STATE_NAMES, type StateSlug } from "@/lib/economy/map-metrics";

/** 65 rendered characters, less the root template's " | Shorted". */
export const STATE_TITLE_BUDGET = 65 - ` | ${siteConfig.name}`.length;

/**
 * "<State> economy — <topics>", with the state's full name where it fits the
 * budget and its code otherwise (the council titles' rule): "Victoria economy —
 * unemployment, final demand, trade", "NSW economy — ...".
 */
export function stateEconomyTitle(state: StateSlug): string {
  const tail = hasLabour(state)
    ? " economy — unemployment, final demand, trade"
    : " economy — state final demand, trade";
  const full = `${STATE_NAMES[state]}${tail}`;
  return full.length <= STATE_TITLE_BUDGET ? full : `${state.toUpperCase()}${tail}`;
}

/** The indicators the state page reads, in its chip order. */
export function stateEconomyIndicators(state: StateSlug): string[] {
  return [
    ...(hasLabour(state) ? ["unemployment"] : []),
    "state final demand",
    "goods exports and imports",
    ...(hasDiesel(state) ? ["diesel sales"] : []),
  ];
}

export function stateEconomyDescription(state: StateSlug): string {
  const sources = hasDiesel(state) ? "ABS and DCCEEW" : "ABS";
  return `${STATE_NAMES[state]} economic snapshot: ${stateEconomyIndicators(state).join(", ")} and the ASX companies operating there — from ${sources} open data.`;
}
