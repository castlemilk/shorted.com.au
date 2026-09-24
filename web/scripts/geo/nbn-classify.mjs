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
 * Suburb-level result from per-point votes. A technology needs a strict
 * majority of covered points, and footprints must cover at least half of all
 * sampled points. Ties, pluralities and sparse coverage are unknown, including
 * sparse Fixed Line hits: Bondi's 3 hits and 13 misses cannot establish a tier.
 *
 * Coarse Fixed Wireless and satellite footprints need an additional safeguard:
 * the winning tier must cover at least half of ALL sampled points, with no
 * Fixed Line hit present. A coarse grid can reach over unmapped fixed-line
 * premises, so mixed evidence stays unknown. The former abstention rule let
 * one hit and 11 misses label Rouse Hill Fixed Wireless.
 *
 * Unknown suburbs have neither a technology nor a quality score; the collector
 * stores both as NULL.
 */
export function classifySuburb(votes) {
  const n = (t) => votes[t] ?? 0;
  const covered = TECHS.reduce((sum, t) => sum + n(t), 0);
  const total = covered + n(UNKNOWN);
  if (covered === 0 || covered * 2 < total) return { tech: null, score: null };

  let tech = TECHS.find((t) => n(t) * 2 > covered) ?? null;
  if (tech && tech !== "Fixed Line" && (n("Fixed Line") > 0 || n(tech) * 2 < total)) {
    tech = null;
  }
  return { tech, score: tech ? SCORE[tech] : null };
}
