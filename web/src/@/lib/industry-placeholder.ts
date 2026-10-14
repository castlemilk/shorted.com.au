import { createSlug } from "./industry-slug";

/**
 * What stands in the industry field of a security that has no industry. The
 * ASX writes "Not Applic" (or "Not Applicable") for one it does not classify,
 * an ETF or a trust, and "Class Pend" while a classification is pending.
 * "Other" is the bucket the industry pages gather all of them in. None of them
 * is an industry: printed, they read "operates in the Not Applic industry", and
 * linked, /industry/not-applic was a 200 shell that Google crawled from stock
 * pages and then canonicalised to a spam domain (Search Console, 2026-09).
 *
 * The one list. Every surface that shows, links or groups by industry asks
 * here instead of keeping its own copy.
 */
const PLACEHOLDER_INDUSTRIES: ReadonlySet<string> = new Set([
  "not applic",
  "not applicable",
  "class pend",
  "other",
]);

const PLACEHOLDER_SLUGS: ReadonlySet<string> = new Set(
  [...PLACEHOLDER_INDUSTRIES].map(createSlug),
);

/**
 * The industry to print: the name, trimmed, or "" when there is none or it is a
 * placeholder. Matched whole and in any case, so "Not Applic Holdings" is an
 * industry. A caller that groups stocks puts "" in its catch-all:
 * `industryLabel(name) || "Other"`.
 */
export function industryLabel(industry: string | null | undefined): string {
  const name = industry?.trim() ?? "";
  return PLACEHOLDER_INDUSTRIES.has(name.toLowerCase()) ? "" : name;
}

/** The same test for a caller that holds only the slug (createSlug's output). */
export function isPlaceholderIndustrySlug(slug: string | null | undefined): boolean {
  return !slug || PLACEHOLDER_SLUGS.has(slug);
}
