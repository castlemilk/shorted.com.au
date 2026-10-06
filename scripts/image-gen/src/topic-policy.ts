import type { AssetPlan } from "./planner.js";

// Reject concrete stock-finance clichés without broad substring bans such
// as "city" (which also matched "capacity") or bans on relevant housing.
const BANNED_TOPIC_TERMS = [
  "handshake", "rocket", "bull market", "bear market", "dollar sign",
  "thumbs up", "thumbs down", "money stack", "gold bar", "businessman",
  "businesswoman", "trading floor", "pie chart", "bar chart", "line graph",
];

export function scrubTopic(asset: AssetPlan, headline = "the article's research"): AssetPlan {
  const lower = asset.topic.toLowerCase();
  const hits = BANNED_TOPIC_TERMS.filter((term) =>
    new RegExp(`\\b${term.replace(/ /g, "\\s+")}s?\\b`, "i").test(lower),
  );
  if (hits.length === 0) return asset;
  console.warn(`[planner] topic contained clichés (${hits.join(", ")}); using the article-specific fallback`);
  return {
    type: asset.type,
    topic: `Conceptual editorial illustration about ${headline}: choose one relevant physical subject and one visual action that explains the article's specific mechanism. Use tactile paper and ink; preserve its uncertainty.`,
    rationale: `Original topic rejected for clichés: ${hits.join(", ")}. ${asset.rationale}`,
  };
}
