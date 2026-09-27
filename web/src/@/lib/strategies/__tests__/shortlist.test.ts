import {
  countByStatus,
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
  it("fills a short list with watch names up to 20", () => {
    const list = shortlistRows(rows([["triggered", 2], ["setup", 3], ["watch", 40]]));
    expect(list).toHaveLength(20);
    expect(list.filter((r) => r.status === "watch")).toHaveLength(15);
  });

  it("never pads a full list with watch names", () => {
    const list = shortlistRows(rows([["triggered", 5], ["setup", 25], ["watch", 40]]));
    expect(list).toHaveLength(30);
    expect(list.some((r) => r.status === "watch")).toBe(false);
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
