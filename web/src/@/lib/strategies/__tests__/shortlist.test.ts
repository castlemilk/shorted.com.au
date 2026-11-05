import {
  SHORTLIST_MAX_ROWS,
  countByStatus,
  statusCountsOf,
  formatStatusCount,
  parsePickStatus,
  shortlistRows,
} from "~/@/lib/strategies/shortlist";
import type { PickRow, PickStatus } from "~/@/lib/strategies/types";

function rows(spec: Array<[PickStatus, number]>): PickRow[] {
  let rank = 0;
  return spec.flatMap(([status, n]) =>
    Array.from({ length: n }, () => {
      rank += 1;
      return { code: `C${rank}`, rank, status } as PickRow;
    }),
  );
}

describe("shortlistRows", () => {
  it("tops a short list up with watch names, to the shortlist size at most", () => {
    const list = shortlistRows(rows([["triggered", 2], ["setup", 3], ["watch", 40]]));
    expect(list).toHaveLength(SHORTLIST_MAX_ROWS);
    expect(list.filter((r) => r.status === "watch")).toHaveLength(SHORTLIST_MAX_ROWS - 5);
  });

  it("never pads a full list with watch names", () => {
    const list = shortlistRows(rows([["triggered", 5], ["setup", 25], ["watch", 40]]));
    expect(list).toHaveLength(SHORTLIST_MAX_ROWS);
    expect(list.some((r) => r.status === "watch")).toBe(false);
  });

  // A busy strategy (Minervini on a trending tape) can have 100 triggered or
  // setup names: the shortlist is bounded, in rank order, and the status
  // chips fetch the rest.
  it("caps a long list at SHORTLIST_MAX_ROWS, keeping the top of the rank order", () => {
    const list = shortlistRows(rows([["triggered", 60], ["setup", 30], ["watch", 10]]));
    expect(list).toHaveLength(SHORTLIST_MAX_ROWS);
    expect(list.map((r) => r.rank)).toEqual(
      Array.from({ length: SHORTLIST_MAX_ROWS }, (_, i) => i + 1),
    );
    expect(list.some((r) => r.status === "watch")).toBe(false);
  });

  it("is ten rows at most, the anonymous public depth", () => {
    expect(SHORTLIST_MAX_ROWS).toBe(10);
    const list = shortlistRows(rows([["watch", 40]]));
    expect(list).toHaveLength(10);
  });
});

describe("parsePickStatus", () => {
  it("accepts the three statuses, case-insensitively, and nothing else", () => {
    expect(parsePickStatus("setup")).toBe("setup");
    expect(parsePickStatus(" TRIGGERED ")).toBe("triggered");
    expect(parsePickStatus("all")).toBeNull();
    expect(parsePickStatus(null)).toBeNull();
  });
});

describe("countByStatus", () => {
  it("is exact when every pick was fetched", () => {
    const counts = countByStatus(rows([["triggered", 2], ["setup", 3]]), 5);
    expect(formatStatusCount(counts.triggered)).toBe("2");
    expect(formatStatusCount(counts.setup)).toBe("3");
    expect(formatStatusCount(counts.watch)).toBe("0");
  });

  it("marks the status the row limit cut off as a floor", () => {
    const counts = countByStatus(rows([["triggered", 4], ["watch", 96]]), 900);
    expect(formatStatusCount(counts.triggered)).toBe("4");
    expect(formatStatusCount(counts.watch)).toBe("96+");
  });
});

describe("statusCountsOf", () => {
  it("reads the API's status counts, exact, when the row list is clamped", () => {
    const rows = [{ status: "triggered" }, { status: "triggered" }] as PickRow[];
    const counts = statusCountsOf({
      picks: rows,
      totalCount: 151,
      statusCounts: { triggered: 9, setup: 60, watch: 82, unknown: 0 },
    });
    expect(counts.triggered).toEqual({ count: 9, atLeast: false });
    expect(counts.setup).toEqual({ count: 60, atLeast: false });
    expect(counts.watch).toEqual({ count: 82, atLeast: false });
  });

  it("falls back to counting the rows when the API sent no counts", () => {
    const rows = [{ status: "triggered" }, { status: "setup" }] as PickRow[];
    const counts = statusCountsOf({ picks: rows, totalCount: 2 });
    expect(counts.triggered).toEqual({ count: 1, atLeast: false });
    expect(counts.setup).toEqual({ count: 1, atLeast: false });
  });
});
