/**
 * Picks the suburbs a state page lists in server HTML.
 *
 * Search Console's URL inspection showed suburb pages reachable only through
 * the sitemap: the state page's explorer is a client island, so its links never
 * reach a crawler, and the suburb corpus (15k pages) hung off nothing. These
 * lists are the fix — a few dozen real links per state, chosen by the same
 * floors the rankings pages use so a $0 or a privacy-thin median never leads.
 */
import type { SuburbLike } from "./suburb-stats";

/** Same floor as the rankings registry: tiny SA1-scale localities carry volatile medians. */
export const DIRECTORY_MIN_POPULATION = 200;

export interface StateSuburbDirectory {
  /** Suburbs that carry a Valuer-General median. */
  pricedCount: number;
  /** All suburbs in the index. */
  total: number;
  /** Mean of the latest suburb medians (the page calls this the state average). */
  averageOfMedians: number | null;
  mostExpensive: SuburbLike[];
  mostAffordable: SuburbLike[];
  fastestGrowing: SuburbLike[];
  largest: SuburbLike[];
}

export function buildStateSuburbDirectory(
  suburbs: readonly SuburbLike[],
  limit = 8,
): StateSuburbDirectory {
  const eligible = suburbs.filter(
    (s) => s.latestMedianPrice > 0 && (s.population ?? 0) >= DIRECTORY_MIN_POPULATION,
  );
  const priced = suburbs.filter((s) => s.latestMedianPrice > 0);
  const byPriceDesc = [...eligible].sort((a, b) => b.latestMedianPrice - a.latestMedianPrice);
  const byPriceAsc = [...eligible].sort((a, b) => a.latestMedianPrice - b.latestMedianPrice);
  const byGrowth = eligible.filter((s) => s.yoyPct !== 0).sort((a, b) => b.yoyPct - a.yoyPct);
  const byPopulation = suburbs
    .filter((s) => (s.population ?? 0) > 0)
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));

  const averageOfMedians = priced.length
    ? priced.reduce((sum, s) => sum + s.latestMedianPrice, 0) / priced.length
    : null;

  return {
    pricedCount: priced.length,
    total: suburbs.length,
    averageOfMedians,
    mostExpensive: byPriceDesc.slice(0, limit),
    mostAffordable: byPriceAsc.slice(0, limit),
    fastestGrowing: byGrowth.slice(0, limit),
    largest: byPopulation.slice(0, limit * 2),
  };
}
