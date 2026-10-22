/**
 * Which /ownership/[slug] pages search engines may index, shared by the
 * page's robots metadata and the ownership sitemap so the two can never
 * disagree. The ownership counterpart of lib/seo/stock-indexability.ts.
 *
 * An institution page is worth indexing when it says what the institution
 * holds: a current substantial holding (5% or more, from its latest notices),
 * or the holdings files it publishes (an index ETF's file, a super fund
 * option's portfolio holdings disclosure). The rest of the map (an APRA fund
 * whose disclosure we cannot read, a manager whose stakes have all ceased)
 * renders a heading, "No current substantial holding on record" and the
 * method: /ownership/ophir was 358 words, indexable and self-canonical
 * (SEO review, 2026-10-21).
 *
 * ONE PREDICATE, TWO CALLERS. The page knows both signals. The sitemap reads
 * ListInstitutions, whose OwnershipInstitution carries the stake count but not
 * the holdings files, so it passes no `fundHoldings` and an unknown count
 * never qualifies a slug. The sitemap therefore lists the institutions with a
 * current stake, each of which the page indexes whatever its files say: a
 * strict subset of the indexable set. One that qualifies on its holdings files
 * alone (HESTA, Betashares) is indexable and linked from the /ownership
 * directory, but not listed until OwnershipInstitution carries its file count.
 */

export interface InstitutionIndexInput {
  /** Current substantial holdings: OwnershipInstitution.substantialPositions. */
  substantialPositions: number;
  /**
   * Rows of its latest holdings files (GetInstitutionResponse.fundHoldings).
   * Absent where the caller cannot see them; absent is not zero, and it never
   * makes a page indexable.
   */
  fundHoldings?: number;
}

export function institutionIsIndexable({ substantialPositions, fundHoldings }: InstitutionIndexInput): boolean {
  return substantialPositions > 0 || (fundHoldings !== undefined && fundHoldings > 0);
}
