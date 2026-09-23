// Pure classification rules for join-nbn.mjs, split out so they can be tested
// without staging 95MB of footprint polygons.
//
// The rule that matters: a technology is only ever asserted from a footprint
// that PUBLISHES it. The original join treated "outside the Fixed Line and
// Fixed Wireless footprints" as "Satellite", but the NBN Coverage Footprints
// 2024 MapServer publishes no satellite layer at all (layers 2 and 3 only),
// and its Fixed Line layer is patchy even in the CBDs: at full resolution it
// does not cover Sydney's CBD or Parramatta. So a miss was never evidence of
// satellite — it is evidence of nothing — and the fallback labelled 7,491 of
// 15,329 suburbs 'Satellite', including Bondi, Parramatta and Point Cook
// (66,781 people). A miss is now UNKNOWN, and only a staged satellite
// footprint can ever yield 'Satellite'.

export const TECHS = ["Fixed Line", "Fixed Wireless", "Satellite"];
export const UNKNOWN = "unknown";
export const SCORE = { "Fixed Line": 90, "Fixed Wireless": 55, "Satellite": 20 };

/**
 * Technology at one sample point. Each index is `{ locate(lon, lat) }` or null
 * when its footprint was not staged. Precedence follows service quality: a
 * point inside a Fixed Line footprint is Fixed Line even where a coarser
 * Fixed Wireless or satellite polygon also covers it.
 */
export function techAtPoint(lon, lat, { fixedLine, fixedWireless, satellite }) {
  if (fixedLine?.locate(lon, lat)) return "Fixed Line";
  if (fixedWireless?.locate(lon, lat)) return "Fixed Wireless";
  if (satellite?.locate(lon, lat)) return "Satellite";
  return UNKNOWN;
}

/**
 * Suburb-level result from per-point votes. The dominant technology is the
 * majority among points some footprint actually classified (ties break toward
 * the better tier, in TECHS order); unknown points abstain rather than vote.
 * A suburb where no point landed in any footprint has no technology — tech and
 * score are null, which the collector stores as NULL ("no source covers this"),
 * never as a guessed tier.
 */
export function classifySuburb(votes) {
  let tech = null, best = 0;
  for (const t of TECHS) {
    const v = votes[t] ?? 0;
    if (v > best) { best = v; tech = t; }
  }
  return { tech, score: tech ? SCORE[tech] : null };
}
