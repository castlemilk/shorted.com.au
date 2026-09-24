/**
 * Copy for the suburb Open Graph card: the stat row and the one-line subtitle.
 *
 * Kept as pure functions so the card's wording can be unit-tested without
 * rendering satori, and so the card only ever states figures the profile
 * actually carries — an unpriced suburb gets Census stats, never "$0 median".
 */

export interface SuburbCardStat {
  label: string;
  value: string;
  tone?: "up" | "down" | "flat";
}

export function suburbCardStats(input: {
  latestMedianPrice?: number | null;
  yoyPct?: number | null;
  population?: number | null;
  medianWeeklyHhdIncome?: number | null;
  medianAge?: number | null;
  seifaDecile?: number | null;
  fmtPrice: (aud: number) => string;
}): SuburbCardStat[] {
  const stats: SuburbCardStat[] = [];
  const price = input.latestMedianPrice ?? 0;
  if (price > 0) {
    stats.push({ label: "Median house", value: input.fmtPrice(price) });
    const yoy = input.yoyPct ?? 0;
    if (yoy !== 0) {
      stats.push({
        label: "Past year",
        value: `${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%`,
        // Rising prices read as growth here (green), the opposite of the
        // short-interest convention on the stock cards.
        tone: yoy > 0 ? "down" : "up",
      });
    }
  }
  if ((input.population ?? 0) > 0) {
    stats.push({ label: "Population", value: (input.population!).toLocaleString("en-AU") });
  }
  if (stats.length < 3 && (input.medianWeeklyHhdIncome ?? 0) > 0) {
    stats.push({
      label: "Household income",
      value: `$${Math.round(input.medianWeeklyHhdIncome!).toLocaleString("en-AU")}/wk`,
    });
  }
  if (stats.length < 3 && (input.medianAge ?? 0) > 0) {
    stats.push({ label: "Median age", value: `${input.medianAge}` });
  }
  if (stats.length < 3 && (input.seifaDecile ?? 0) > 0) {
    stats.push({ label: "SEIFA decile", value: `${input.seifaDecile}/10` });
  }
  return stats.slice(0, 3);
}

/** "Victoria · Inner terraces · City of Yarra" — the banner's own descriptors. */
export function suburbCardSubtitle(input: {
  stateName: string;
  archetype?: string;
  blurb?: string;
  lgaName?: string;
}): string {
  const blurb = input.blurb?.trim();
  if (blurb && blurb.length <= 120) return blurb;
  const parts = [input.stateName];
  if (input.archetype) {
    parts.push(input.archetype.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
  }
  if (input.lgaName) parts.push(input.lgaName);
  return parts.filter(Boolean).join(" · ");
}
