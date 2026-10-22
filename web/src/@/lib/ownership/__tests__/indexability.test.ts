import { institutionIsIndexable } from "../indexability";

describe("institutionIsIndexable", () => {
  it("indexes an institution with a current stake or published holdings files", () => {
    expect(institutionIsIndexable({ substantialPositions: 88, fundHoldings: 100 })).toBe(true);
    expect(institutionIsIndexable({ substantialPositions: 1, fundHoldings: 0 })).toBe(true);
    // HESTA: no 5% stake, but its portfolio holdings disclosure.
    expect(institutionIsIndexable({ substantialPositions: 0, fundHoldings: 100 })).toBe(true);
  });

  it("noindexes one with neither (/ownership/ophir: 0 stakes, 358 words)", () => {
    expect(institutionIsIndexable({ substantialPositions: 0, fundHoldings: 0 })).toBe(false);
  });

  // The sitemap reads ListInstitutions, which carries no holdings-file count:
  // an unknown count never qualifies a slug, so whatever the sitemap lists,
  // the page indexes.
  it("never lets an unknown holdings-file count qualify an institution", () => {
    expect(institutionIsIndexable({ substantialPositions: 0 })).toBe(false);
    expect(institutionIsIndexable({ substantialPositions: 3 })).toBe(true);
    for (const substantialPositions of [0, 1, 5]) {
      for (const fundHoldings of [0, 1, 100]) {
        if (institutionIsIndexable({ substantialPositions })) {
          expect(institutionIsIndexable({ substantialPositions, fundHoldings })).toBe(true);
        }
      }
    }
  });
});
