/**
 * The profile rail's factual sentences are EDITORIAL COPY, so they are locked
 * verbatim here rather than reviewed once and forgotten.
 *
 * Every sentence appears beside a named parliamentarian. Under
 * docs/influence-editorial-standards.md the risk is imputation — what a
 * reasonable reader takes the material to insinuate — so the assertions below
 * cover the exact wording, the grammar (a plural verb after a count of one is
 * how a typo becomes a contract), and the two claims this generator must never
 * make: a property tally, and anything about magnitude.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildProfileKeyFacts,
  type ProfileKeyFactsInput,
} from "../profile/key-facts";

const ITEM_COUNTS = [
  { itemNo: 1, label: "Shareholdings", currentCount: 8 },
  { itemNo: 3, label: "Real estate", currentCount: 6 },
  { itemNo: 6, label: "Liability", currentCount: 2 },
  // A category the member has nothing in must produce no sentence at all.
  { itemNo: 11, label: "Gift", currentCount: 0 },
];

const FULL: ProfileKeyFactsInput = {
  itemCounts: ITEM_COUNTS,
  holderCounts: [
    { key: "self", currentCount: 11 },
    { key: "spouse-partner", currentCount: 4 },
    { key: "not-stated", currentCount: 1 },
  ],
  industryCounts: [
    { industry: "Banks", companyCount: 3 },
    { industry: "Materials", companyCount: 1 },
  ],
  undatedCount: 5,
  latestChange: { date: "12 Mar 2026", href: "https://www.aph.gov.au/x.pdf" },
};

function textsOf(input: ProfileKeyFactsInput): string[] {
  return buildProfileKeyFacts(input).map((fact) => fact.text);
}

describe("profile key facts", () => {
  it("locks the sentence templates", () => {
    expect(textsOf(FULL)).toEqual([
      "16 entries are currently declared, across 3 register categories.",
      "Shareholdings is the most declared category, with 8 entries currently declared.",
      "6 entries in the real-estate category are currently declared. One entry can cover more than one property, so this is a floor rather than a count of properties.",
      "11 of 16 current entries (69%) are recorded in the member's own name.",
      "4 of 16 current entries (25%) are recorded as a spouse or partner's interest.",
      "1 of 16 current entries (6%) is lodged on a form that does not record whose interest it is.",
      "5 entries carry no stated start date, so they are not plotted on the timeline.",
      "Banks is the most declared industry, with 3 distinct listed companies.",
      "Most recent recorded register change: 12 Mar 2026.",
    ]);
  });

  it("agrees its verbs and nouns with a count of one", () => {
    expect(
      textsOf({
        itemCounts: [{ itemNo: 3, label: "Real estate", currentCount: 1 }],
        holderCounts: [{ key: "self", currentCount: 1 }],
        industryCounts: [{ industry: "Banks", companyCount: 1 }],
        undatedCount: 1,
      }),
    ).toEqual([
      "1 entry is currently declared, across 1 register category.",
      "Real estate is the most declared category, with 1 entry currently declared.",
      "1 entry in the real-estate category is currently declared. One entry can cover more than one property, so this is a floor rather than a count of properties.",
      "1 of 1 current entries (100%) is recorded in the member's own name.",
      "1 entry carries no stated start date, so it is not plotted on the timeline.",
      "Banks is the most declared industry, with 1 distinct listed company.",
    ]);
  });

  it("says nothing at all when there is nothing to say", () => {
    // EMPTY MEANS SILENCE. A fabricated negative ("declares no real estate") is
    // an absence claim about a named person, and the CoverageNote above the
    // lists is what explains which documents we have actually read.
    expect(
      buildProfileKeyFacts({ itemCounts: [], holderCounts: [], industryCounts: [] }),
    ).toEqual([]);
    expect(
      buildProfileKeyFacts({
        itemCounts: [{ itemNo: 1, label: "Shareholdings", currentCount: 0 }],
        holderCounts: [{ key: "self", currentCount: 0 }],
        industryCounts: [{ industry: "Banks", companyCount: 0 }],
        undatedCount: 0,
      }),
    ).toEqual([]);
  });

  it("never renders a property tally", () => {
    const text = textsOf(FULL).join(" ");
    // ~29% of item-3 rows merge two or more properties into one entry, so the
    // figure is a FLOOR on entries declared. "Owns 6 properties" would be false
    // about a named person, in the direction that invites a complaint.
    // "the member's own name" is the register's own attribution and is fine;
    // "owns" / "owned" is the claim the entry count cannot support.
    expect(text).not.toMatch(/\bown(?:s|ed|ership)\b/i);
    expect(text).not.toMatch(/\d+\s+properties\b/i);
    expect(text).toContain("floor rather than a count of properties");
  });

  it("states no magnitude and uses no accusatory verb", () => {
    const text = textsOf(FULL).join(" ");
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(
      /\b(worth|valued at|portfolio|profit\w*|insider|corrupt\w*|rigged|bribed|rorted|kickback|bet against|risk|exposure)\b/i,
    );
    // Concealment imputations, including the phrasing the wireframe used.
    expect(text).not.toMatch(/\b(hidden|undisclosed|secret\w*|via (?:their )?spouse)\b/i);
  });

  it("carries no currency, warning or trophy iconography", () => {
    const text = textsOf(FULL).join(" ");
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲🏆]/u);
  });

  it("keeps the holder vocabulary the compliance kit already froze", () => {
    // The badge on the row and the sentence in the rail describe the same
    // register attribute; two vocabularies for it would be two unreviewed
    // claims. HolderBadge's labels are locked by editorial-copy.test.ts.
    const compliance = readFileSync(
      join(__dirname, "..", "compliance.tsx"),
      "utf8",
    );
    expect(compliance).toContain("spouse or partner");
    expect(compliance).toContain("dependent child");
    const text = textsOf(FULL).join(" ");
    expect(text).toContain("spouse or partner's interest");
  });

  it("links a change sentence to the document it came from", () => {
    // Rule 1: every figure traceable to its source.
    const change = buildProfileKeyFacts(FULL).find((fact) =>
      fact.text.startsWith("Most recent recorded register change"),
    );
    expect(change?.href).toBe("https://www.aph.gov.au/x.pdf");
  });
});
