import { formatIsoDate } from "~/@/lib/strategies/format";
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

/**
 * What a version's entry says of its status when it is not the live one: a
 * draft is "draft: not yet live" until the job promotes it, a superseded one
 * "superseded 3 November 2026". "" for the live version, which carries its own
 * mark, and for a status with no reader-facing words.
 */
export function versionStatusNote(
  version: Pick<StrategyVersionDef, "status">,
  supersededOn?: string,
): string {
  switch (version.status) {
    case "draft":
      return "draft: not yet live";
    case "superseded": {
      const day = formatIsoDate(supersededOn);
      return day ? `superseded ${day}` : "superseded";
    }
    default:
      return "";
  }
}

/** The version with its engine, for a title or an announcement. */
export function versionFullText(version: StrategyVersionDef): string {
  const parts = [versionChipText(version)];
  if (version.engineVersion) parts.push(`engine ${version.engineVersion}`);
  return parts.filter(Boolean).join(" · ");
}
