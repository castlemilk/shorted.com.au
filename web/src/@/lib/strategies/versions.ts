import type { StrategyVersionDef } from "~/@/lib/strategies/types";

/** How many characters of a rules hash a reader sees; the full hash is in the changelog. */
export const SHORT_HASH_LENGTH = 8;

/** The first eight characters of a rules hash, "" when the API sent none. */
export function shortRulesHash(rulesHash: string): string {
  return rulesHash.trim().slice(0, SHORT_HASH_LENGTH);
}

/**
 * The version as a reader quotes it: label, short hash, e.g. "v0 · 3f9a1c2e".
 * "" when the version names neither a label nor a hash, so a chip never shows
 * a guessed label.
 */
export function versionChipText(version: StrategyVersionDef): string {
  const hash = shortRulesHash(version.rulesHash);
  return [version.label.trim(), hash].filter(Boolean).join(" · ");
}

/** The version with its engine, for a title or an announcement. */
export function versionFullText(version: StrategyVersionDef): string {
  const parts = [versionChipText(version)];
  if (version.engineVersion) parts.push(`engine ${version.engineVersion}`);
  return parts.filter(Boolean).join(" · ");
}
