import { queryKeys } from "../query-keys";

describe("query keys for a chart kept as posted", () => {
  it("leaves the live chart's keys exactly as they were", () => {
    expect(queryKeys.stock.timeSeries("BHP", "1y")).toEqual(["stock", "timeSeries", "BHP", "1y"]);
    expect(queryKeys.market.historical("BHP", "1y")).toEqual(["market", "historical", "BHP", "1y"]);
  });

  it("differs per window, so one anchor's data never answers another's", () => {
    const a = queryKeys.stock.timeSeries("BHP", "3m", { from: "2026-07-30", to: "2026-10-29" });
    const b = queryKeys.stock.timeSeries("BHP", "3m", { from: "2026-07-31", to: "2026-10-29" });
    const live = queryKeys.stock.timeSeries("BHP", "3m");
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(live);

    const p = queryKeys.market.historical("BHP", "3m", { from: "2026-08-04", to: "2026-11-03" });
    expect(p).not.toEqual(queryKeys.market.historical("BHP", "3m", { from: "2026-08-04", to: "2026-11-02" }));
    expect(p).not.toEqual(queryKeys.market.historical("BHP", "3m"));
  });

  it("is the same key for the same window, so it is shared", () => {
    expect(queryKeys.stock.timeSeries("BHP", "6m", { to: "2026-10-29" })).toEqual(
      queryKeys.stock.timeSeries("BHP", "6m", { to: "2026-10-29" }),
    );
  });
});
