/**
 * The two decisions the profile page makes before it renders a single number.
 *
 * Both were wrong in the same way and for the same reason — they trusted the
 * SHAPE of the analytics response instead of its CONTENT — and both published
 * the result beside a named parliamentarian and their photograph:
 *
 *   - THE FALLBACK NEVER FIRED. `itemCounts.length > 0` is true whenever the rpc
 *     succeeds, because it emits a row per register item whether or not anything
 *     is declared under it. A cold materialized view (prod applies migrations by
 *     hand) and the register kill switch both answer with fourteen ZEROED rows,
 *     which the length check read as healthy — so the tiles said "0 entries
 *     currently declared" directly above a declarations table full of entries.
 *     An absence claim about a named person, made on our own infrastructure
 *     failure, which is exactly what the documented fallback existed to prevent.
 *   - "REGISTER LAST UPDATED" WAS A REFRESH CLOCK. The chain fell through to the
 *     response's as-at, which is when the rollup was rebuilt — so roughly four
 *     profiles in five printed TODAY as the day that member last updated their
 *     register. The comment above it already said "Never today's date"; these
 *     tests are what make that true.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasExplorerCounts,
  registerLastUpdated,
  selectProfileAggregates,
  type DeclaredRowFacts,
  type ExplorerProfileAggregates,
} from "../profile/aggregates";

/** RegisterHolder values, as plain numbers — this module imports no proto. */
const SELF = 1;
const SPOUSE = 2;

function declaredRow(overrides: Partial<DeclaredRowFacts> = {}): DeclaredRowFacts {
  return {
    itemNo: 1,
    itemLabel: "Shareholdings in public and private companies",
    holder: SELF,
    currentlyDeclared: true,
    declaredFromKnown: true,
    ...overrides,
  };
}

/**
 * What the rpc actually returns when it has nothing to say.
 *
 * FOURTEEN ROWS, EVERY COUNT ZERO. Not an empty list — that is the entire point:
 * a cold view, a disabled register and a member with genuinely nothing current
 * are indistinguishable by length, and only by content.
 */
function zeroedExplorer(): ExplorerProfileAggregates {
  return {
    itemCounts: Array.from({ length: 14 }, (_, index) => ({
      itemNo: index + 1,
      itemLabel: `Item ${index + 1}`,
      currentCount: 0,
    })),
    holderCounts: [],
    undatedCount: 0,
  };
}

describe("profile aggregates — which numbers get published", () => {
  it("does not mistake fourteen zeroed rows for an answer", () => {
    expect(hasExplorerCounts(zeroedExplorer())).toBe(false);
    expect(hasExplorerCounts(undefined)).toBe(false);
    expect(
      hasExplorerCounts({
        itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 3 }],
      }),
    ).toBe(true);
  });

  it("falls back to the rows on the page when the rpc answers with zeros", () => {
    const rows = [
      declaredRow(),
      declaredRow(),
      declaredRow({ itemNo: 3, itemLabel: "Real estate", holder: SPOUSE }),
      // Not current: it belongs in the table below, never in a "currently
      // declared" tile.
      declaredRow({ itemNo: 6, currentlyDeclared: false }),
      declaredRow({ itemNo: 1, declaredFromKnown: false }),
    ];

    const aggregates = selectProfileAggregates(zeroedExplorer(), rows);

    expect(aggregates.source).toBe("rows");
    expect(aggregates.itemCounts).toEqual([
      { itemNo: 1, label: "Shareholdings", currentCount: 3 },
      { itemNo: 3, label: "Real estate", currentCount: 1 },
    ]);
    expect(aggregates.holderCounts).toEqual(
      expect.arrayContaining([
        { holder: SELF, currentCount: 3 },
        { holder: SPOUSE, currentCount: 1 },
      ]),
    );
    // The rows' own undated count, not the rpc's zero.
    expect(aggregates.undatedCount).toBe(1);
  });

  it("prefers the rpc's aggregates once they carry a count", () => {
    const aggregates = selectProfileAggregates(
      {
        itemCounts: [
          { itemNo: 1, itemLabel: "Shareholdings", currentCount: 9 },
          { itemNo: 3, itemLabel: "Real estate", currentCount: 0 },
        ],
        holderCounts: [{ holder: SELF, currentCount: 9 }],
        undatedCount: 7,
      },
      [declaredRow()],
    );

    expect(aggregates.source).toBe("explorer");
    expect(aggregates.itemCounts[0]?.currentCount).toBe(9);
    expect(aggregates.undatedCount).toBe(7);
  });

  it("takes all three measures from ONE side, never a mixture", () => {
    // The rpc answered with items but no holder split. Deriving the holders from
    // the rows instead would put a holder total of 1 beside an entry count of 9
    // — two denominators on one screen, and a reader resolving that difference
    // is resolving it about the member rather than about our pipeline.
    const aggregates = selectProfileAggregates(
      {
        itemCounts: [{ itemNo: 1, itemLabel: "Shareholdings", currentCount: 9 }],
        holderCounts: [],
        undatedCount: 0,
      },
      [declaredRow(), declaredRow()],
    );

    expect(aggregates.source).toBe("explorer");
    expect(aggregates.holderCounts).toEqual([]);
    expect(aggregates.undatedCount).toBe(0);
  });

  it("renders honest zeros for a member who genuinely declares nothing current", () => {
    // The fallback path is also the path a thin profile takes, so it has to be
    // right about emptiness too: previously-declared rows stay in the table and
    // are counted in NO current measure, and nothing is invented to fill a tile.
    const aggregates = selectProfileAggregates(zeroedExplorer(), [
      declaredRow({ currentlyDeclared: false }),
      declaredRow({ itemNo: 3, currentlyDeclared: false }),
    ]);

    expect(aggregates.source).toBe("rows");
    expect(aggregates.itemCounts).toEqual([]);
    expect(aggregates.holderCounts).toEqual([]);
    expect(aggregates.undatedCount).toBe(0);
    const total = aggregates.itemCounts.reduce((sum, item) => sum + item.currentCount, 0);
    expect(total).toBe(0);
  });

  it("labels an item number the taxonomy does not know rather than inventing one", () => {
    const aggregates = selectProfileAggregates(undefined, [
      declaredRow({ itemNo: 99, itemLabel: "" }),
    ]);
    expect(aggregates.itemCounts[0]?.label).toBe("Category not stated");
  });
});

describe("profile aggregates — register last updated", () => {
  const change = new Date("2026-06-01T00:00:00Z");
  const declaredFrom = new Date("2024-02-03T00:00:00Z");

  it("uses the member's own newest recorded change first", () => {
    expect(registerLastUpdated(change, declaredFrom)).toBe(change);
  });

  it("falls back to the newest date the member's own entries carry", () => {
    expect(registerLastUpdated(undefined, declaredFrom)).toBe(declaredFrom);
  });

  it("returns nothing rather than inventing a date", () => {
    // The caller renders no tile at all. A dash in a date tile still asserts we
    // know when this register last moved.
    expect(registerLastUpdated(undefined, undefined)).toBeUndefined();
  });
});

/**
 * The page is a server component and cannot be rendered here, so the two rules
 * above are pinned at their call site by reading it. Both defects were one
 * expression each, and both would come back the same way.
 */
describe("the profile page uses these rules", () => {
  const PAGE = readFileSync(
    join(__dirname, "..", "..", "..", "..", "app", "politicians", "[slug]", "page.tsx"),
    "utf8",
  );

  it("selects its aggregates through the guarded helper", () => {
    expect(PAGE).toMatch(/selectProfileAggregates\(/);
    // The predicate that never fired must not come back inline.
    expect(PAGE).not.toMatch(/itemCounts\s*\?\?\s*\[\]\)\.length\s*>\s*0/);
  });

  it("never derives 'register last updated' from a refresh clock", () => {
    const line = PAGE.match(/const lastUpdated = .*/)?.[0] ?? "";
    expect(line).toContain("latestChange?.changedOn");
    // `explorer` is the analytics response, and every date on it is a refresh
    // clock. Nothing from it may reach this tile — the member's own newest
    // declared date (`asAt`, computed from their own rows) is the only fallback.
    expect(line).not.toMatch(/explorer/);
    expect(line).toContain("asAt");
  });

  it("omits the date tile rather than rendering a placeholder date", () => {
    expect(PAGE).toMatch(/lastUpdated \? \(\s*<AsAtTile/);
  });
});
