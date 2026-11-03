/// <reference types="jest" />

/**
 * The index fund window's change lists (spec 13.5): the rises and falls by weight,
 * the stocks new or dropped on one date, and the cap a list may show.
 */

import { partitionFundChanges, type FundChangeRow } from "../fund-changes";

function row(over: Partial<FundChangeRow> & { code: string }): FundChangeRow {
  return {
    name: `${over.code} Ltd`,
    weightFrom: 1,
    weightTo: 1,
    delta: 0,
    valueFrom: null,
    valueTo: null,
    funds: 1,
    state: "current",
    ...over,
  };
}

describe("partitionFundChanges", () => {
  it("ranks rises and falls by the size of the change, ties by code", () => {
    const lists = partitionFundChanges([
      row({ code: "BBB", delta: 0.5 }),
      row({ code: "AAA", delta: 0.5 }),
      row({ code: "CCC", delta: 2 }),
      row({ code: "DDD", delta: -1 }),
      row({ code: "EEE", delta: -3 }),
    ]);
    expect(lists.rises.map((r) => r.code)).toEqual(["CCC", "AAA", "BBB"]);
    expect(lists.falls.map((r) => r.code)).toEqual(["EEE", "DDD"]);
  });

  it("keeps a stock held on one date only in its own list, never as a change from zero", () => {
    const lists = partitionFundChanges([
      row({ code: "NEW", state: "new", weightFrom: null, weightTo: 4, delta: null }),
      row({ code: "OLD", state: "dropped", weightFrom: 2, weightTo: null, delta: null }),
    ]);
    expect(lists.added.map((r) => r.code)).toEqual(["NEW"]);
    expect(lists.dropped.map((r) => r.code)).toEqual(["OLD"]);
    expect(lists.rises).toEqual([]);
    expect(lists.falls).toEqual([]);
  });

  it("leaves a stock whose weight did not move in neither list", () => {
    const lists = partitionFundChanges([row({ code: "FLAT", delta: 0 })]);
    expect(lists).toEqual({ rises: [], falls: [], added: [], dropped: [] });
  });

  it("orders added and dropped by their weight on the date they are held", () => {
    const lists = partitionFundChanges([
      row({ code: "LOW", state: "new", weightTo: 0.5, delta: null }),
      row({ code: "HIGH", state: "new", weightTo: 3, delta: null }),
      row({ code: "GONE", state: "dropped", weightFrom: 1, delta: null }),
    ]);
    expect(lists.added.map((r) => r.code)).toEqual(["HIGH", "LOW"]);
    expect(lists.dropped.map((r) => r.code)).toEqual(["GONE"]);
  });

  it("shows ten rows by default, the limit it is given, and at most fifty", () => {
    const many = Array.from({ length: 60 }, (_, i) => row({ code: `S${String(i).padStart(2, "0")}`, delta: 1 + i }));
    expect(partitionFundChanges(many).rises).toHaveLength(10);
    expect(partitionFundChanges(many, 3).rises).toHaveLength(3);
    expect(partitionFundChanges(many, 500).rises).toHaveLength(50);
    expect(partitionFundChanges(many, Number.NaN).rises).toHaveLength(10);
  });
});
