/**
 * The neutral factual sentences on a member's profile rail.
 *
 * THESE ARE EDITORIAL COPY, NOT UI STRINGS. Every sentence here appears beside a
 * named parliamentarian, so each one is written against
 * docs/influence-editorial-standards.md and locked verbatim by
 * profile-key-facts.test.ts. Changing a template re-triggers editorial review;
 * that is the point of the lock.
 *
 * The rules that shaped the wording:
 *
 *   - COUNTS AND PERCENTAGES OF COUNTS ONLY (rule 5). The registers record what
 *     is held and never quantity or value, so there is no magnitude to state and
 *     no "risk", "exposure" or score to derive. Nothing here is a judgement.
 *   - REAL ESTATE IS A FLOOR, NEVER A PROPERTY TALLY. An item-3 entry may cover
 *     more than one property (~29% of them do), so the sentence says "entries"
 *     and says out loud that it is a floor. It must never read "owns N
 *     properties".
 *   - THE HOLDER IS THE REGISTER'S OWN ATTRIBUTE, in the register's own words —
 *     the same vocabulary as HolderBadge, with no insinuation of concealment.
 *     "Declared as a spouse or partner's interest" is what the form records;
 *     anything about interests being held "via" someone is an imputation.
 *   - EMPTY MEANS SILENCE. A member with nothing in a section produces no
 *     sentence at all. A fabricated negative ("declares no real estate") is an
 *     absence claim about a named person, and the CoverageNote above the lists
 *     is what carries the explanation of what we have actually read.
 */

import type { KeyFact } from "@/components/politicians/explorer/key-facts";

export interface ProfileItemCount {
  itemNo: number;
  label: string;
  currentCount: number;
}

export interface ProfileHolderCount {
  /** One of the HOLDER_FILTER keys in declaration-rows.tsx. */
  key: string;
  currentCount: number;
}

export interface ProfileIndustryCount {
  industry: string;
  companyCount: number;
}

export interface ProfileKeyFactsInput {
  itemCounts: ProfileItemCount[];
  holderCounts: ProfileHolderCount[];
  industryCounts: ProfileIndustryCount[];
  /** Current entries with no stated start date — the timeline cannot plot them. */
  undatedCount?: number;
  /**
   * The most recent recorded change for this member. The date is formatted by
   * the caller: a locale-dependent formatter inside a locked copy template makes
   * the lock untestable and the sentence machine-dependent.
   */
  latestChange?: { date: string; href?: string };
}

/** The register's item number for real estate. */
const REAL_ESTATE_ITEM = 3;

/**
 * How the register attributes an entry, in the register's own vocabulary.
 *
 * Order is fixed so the card reads the same way for every member: the member's
 * own name first, then the family attributions the form provides for, then the
 * forms that record no attribution at all.
 */
const HOLDER_PHRASE: { key: string; phrase: string }[] = [
  { key: "self", phrase: "recorded in the member's own name" },
  { key: "spouse-partner", phrase: "recorded as a spouse or partner's interest" },
  { key: "dependent-child", phrase: "recorded as a dependent child's interest" },
  {
    key: "not-stated",
    phrase: "lodged on a form that does not record whose interest it is",
  },
];

function entries(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Neutral factual sentences for one member, computed from the explorer profile.
 *
 * Returns an empty list when there is nothing to say. The caller renders no card
 * at all in that case — an empty "Key facts" heading is itself a statement.
 */
export function buildProfileKeyFacts(input: ProfileKeyFactsInput): KeyFact[] {
  const facts: KeyFact[] = [];

  const populated = input.itemCounts.filter((item) => item.currentCount > 0);
  const total = populated.reduce((sum, item) => sum + item.currentCount, 0);

  if (total > 0) {
    facts.push({
      text: `${entries(total)} ${total === 1 ? "is" : "are"} currently declared, across ${
        populated.length === 1
          ? "1 register category"
          : `${populated.length} register categories`
      }.`,
    });

    const top = [...populated].sort(
      (a, b) => b.currentCount - a.currentCount || a.itemNo - b.itemNo,
    )[0];
    if (top) {
      facts.push({
        text: `${top.label} is the most declared category, with ${entries(
          top.currentCount,
        )} currently declared.`,
      });
    }

    const realEstate = populated.find((item) => item.itemNo === REAL_ESTATE_ITEM);
    if (realEstate) {
      // NEVER "owns N properties". One item-3 entry can cover more than one
      // property, so the number is a floor on what was declared.
      facts.push({
        text: `${entries(
          realEstate.currentCount,
        )} in the real-estate category ${realEstate.currentCount === 1 ? "is" : "are"} currently declared. One entry can cover more than one property, so this is a floor rather than a count of properties.`,
      });
    }

    for (const { key, phrase } of HOLDER_PHRASE) {
      const held = input.holderCounts.find((holder) => holder.key === key);
      if (!held || held.currentCount <= 0) continue;
      facts.push({
        // The verb agrees with the count. "1 of 16 current entries … are" is the
        // same typo the trend-area footnote once locked into a test; a copy lock
        // is only worth having when the copy is right.
        text: `${held.currentCount} of ${total} current entries (${percentOf(
          held.currentCount,
          total,
        )}%) ${held.currentCount === 1 ? "is" : "are"} ${phrase}.`,
      });
    }
  }

  const undated = Math.max(0, Math.trunc(input.undatedCount ?? 0));
  if (undated > 0) {
    facts.push({
      text: `${entries(undated)} ${
        undated === 1 ? "carries" : "carry"
      } no stated start date, so ${undated === 1 ? "it is" : "they are"} not plotted on the timeline.`,
    });
  }

  const industry = [...input.industryCounts]
    .filter((entry) => entry.companyCount > 0)
    .sort((a, b) => b.companyCount - a.companyCount || a.industry.localeCompare(b.industry))[0];
  if (industry) {
    facts.push({
      text: `${industry.industry} is the most declared industry, with ${
        industry.companyCount === 1
          ? "1 distinct listed company"
          : `${industry.companyCount} distinct listed companies`
      }.`,
    });
  }

  if (input.latestChange?.date) {
    facts.push({
      text: `Most recent recorded register change: ${input.latestChange.date}.`,
      href: input.latestChange.href,
    });
  }

  return facts;
}
