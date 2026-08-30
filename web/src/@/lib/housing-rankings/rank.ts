export type RankingMetric =
  | "price-asc"
  | "price-desc"
  | "growth-desc"
  | "growth-asc"
  | "affordability";

/**
 * Suburbs below 200 residents are excluded because tiny ABS Statistical Areas
 * can produce volatile, privacy-affected medians that are not useful rankings.
 */
export const MIN_RANKING_POPULATION = 200;

export interface RankingSuburb {
  salCode: string;
  salName: string;
  stateCode: string;
  postcode: string;
  latestMedianPrice: number;
  yoyPct: number;
  population: number;
  medianWeeklyHhdIncome: number;
}

export interface RankedSuburb extends RankingSuburb {
  /** Median price divided by 52 weeks of median household income. */
  affordabilityRatio: number | null;
}

const byName = (a: RankedSuburb, b: RankedSuburb): number =>
  a.salName.localeCompare(b.salName, "en-AU") ||
  a.postcode.localeCompare(b.postcode) ||
  a.salCode.localeCompare(b.salCode);

/** Rank a state-wide suburb list without mutating the cached source array. */
export function rankSuburbs(
  suburbs: readonly RankingSuburb[],
  metric: RankingMetric,
): RankedSuburb[] {
  const rows = suburbs
    .filter(
      (suburb) =>
        Number.isFinite(suburb.latestMedianPrice) &&
        suburb.latestMedianPrice > 0 &&
        Number.isFinite(suburb.population) &&
        suburb.population >= MIN_RANKING_POPULATION,
    )
    .filter((suburb) => {
      if (metric === "affordability") {
        return (
          Number.isFinite(suburb.medianWeeklyHhdIncome) &&
          suburb.medianWeeklyHhdIncome > 0
        );
      }
      if (metric === "growth-asc" || metric === "growth-desc") {
        return Number.isFinite(suburb.yoyPct);
      }
      return true;
    })
    .map((suburb) => ({
      ...suburb,
      affordabilityRatio:
        suburb.medianWeeklyHhdIncome > 0
          ? suburb.latestMedianPrice / (suburb.medianWeeklyHhdIncome * 52)
          : null,
    }));

  return rows.sort((a, b) => {
    let difference = 0;
    switch (metric) {
      case "price-asc":
        difference = a.latestMedianPrice - b.latestMedianPrice;
        break;
      case "price-desc":
        difference = b.latestMedianPrice - a.latestMedianPrice;
        break;
      case "growth-desc":
        difference = b.yoyPct - a.yoyPct;
        break;
      case "growth-asc":
        difference = a.yoyPct - b.yoyPct;
        break;
      case "affordability":
        difference = a.affordabilityRatio! - b.affordabilityRatio!;
        break;
    }
    return difference || byName(a, b);
  });
}
