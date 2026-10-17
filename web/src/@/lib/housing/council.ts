/**
 * Council (LGA) helpers shared by every surface that names a council.
 *
 * Council pages live at /housing/<state>/council/<slug> (program decision 5),
 * with the state index at /housing/<state>/council. COUNCIL_PAGES_ENABLED is
 * the single switch every surface that links to one reads; turning it off
 * unlinks them all without touching the routes.
 */
import { STATE_NAMES, stateSlug } from "./states";

export const COUNCIL_PAGES_ENABLED = true;

/**
 * The council page URL, or null when there is no page to link to: pages off,
 * no slug (a pseudo-area, or a council loaded before slugs were minted), or a
 * state without a /housing/<state> route (Other Territories).
 */
export function councilHref(
  stateCode: string,
  slug: string,
  pagesEnabled: boolean = COUNCIL_PAGES_ENABLED,
): string | null {
  if (!pagesEnabled || !slug || !STATE_NAMES[stateCode]) return null;
  return `/housing/${stateSlug(stateCode)}/council/${encodeURIComponent(slug)}`;
}

/**
 * How a cross-border neighbour's jurisdiction reads on its chip: the state or
 * territory code (VIC, ACT) — except the ABS "Other Territories" pseudo-state
 * (OT), which no reader knows by its code. Of its members only Jervis Bay
 * Territory has a land border with any council (Shoalhaven), so that is the
 * name shown. OT has no /housing route either, so the chip stays unlinked.
 */
export function crossBorderJurisdiction(stateCode: string): string {
  return stateCode === "OT" ? "Jervis Bay Territory" : stateCode;
}

/**
 * A share of a suburb's residents as a whole percent, never "0%": the bridge
 * keeps every council above 1%, so anything shown is at least 1%.
 */
export function fmtCouncilShare(share: number): string {
  return `${Math.max(1, Math.round(share * 100))}%`;
}

/**
 * Residents per km², never a bare 0 for a council people live in: whole
 * numbers from 10 up, one decimal below that, "<0.1" under 0.05. Remote
 * councils run to 0.01/km² (Unincorporated NSW, 975 residents over 93,209 km²),
 * and a rounded "0" reads as empty land.
 */
export function fmtDensity(v: number): string {
  if (!(v > 0)) return "0";
  if (v >= 9.95) return Math.round(v).toLocaleString("en-AU");
  if (v >= 0.05) return v.toFixed(1);
  return "<0.1";
}
