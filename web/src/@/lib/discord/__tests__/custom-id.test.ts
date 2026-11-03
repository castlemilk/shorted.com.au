import {
  activityCustomId,
  chartCustomId,
  normalizeCode,
  parseCustomId,
} from "../custom-id";

describe("normalizeCode", () => {
  it.each([
    ["bhp", "BHP"],
    [" PLS ", "PLS"],
    ["$wbt", "WBT"],
    ["ASX:CBA", "CBA"],
    ["asx:a2m", "A2M"],
    ["GSBW34", "GSBW34"],
  ])("reads %j as %s", (raw, code) => {
    expect(normalizeCode(raw)).toBe(code);
  });

  it.each(["", "B", "PILBARA", "BHP GROUP", "BH-P", null, undefined])(
    "rejects %j",
    (raw) => {
      expect(normalizeCode(raw)).toBeNull();
    },
  );
});

describe("chart and activity custom ids", () => {
  const state = { code: "BHP", view: "combined", period: "6m" } as const;

  it("round-trips a chart control", () => {
    expect(chartCustomId("view", state)).toBe("chart:v:BHP:combined:6m");
    expect(chartCustomId("period", state)).toBe("chart:p:BHP:combined:6m");
    expect(parseCustomId(chartCustomId("view", state))).toEqual({
      kind: "chart",
      state,
    });
    expect(parseCustomId(chartCustomId("period", state))).toEqual({
      kind: "chart",
      state,
    });
  });

  it("round-trips the Activity launcher", () => {
    expect(activityCustomId(state)).toBe("activity:BHP:combined:6m");
    expect(parseCustomId(activityCustomId(state))).toEqual({
      kind: "activity",
      state,
    });
  });

  it("gives the view and period controls for the same chart different ids", () => {
    // Discord refuses a message whose components share a custom_id.
    expect(chartCustomId("view", state)).not.toBe(
      chartCustomId("period", state),
    );
  });

  it("stays inside Discord's 100-character limit at the longest code and view", () => {
    const longest = {
      code: "GSBW34",
      view: "combined",
      period: "max",
    } as const;
    expect(chartCustomId("period", longest).length).toBeLessThanOrEqual(100);
    expect(activityCustomId(longest).length).toBeLessThanOrEqual(100);
  });

  describe("kept as posted", () => {
    const anchored = {
      ...state,
      anchor: { day: "2026-11-04", shorts: "2026-10-29" },
    } as const;

    it("carries the posting day and the newest short report", () => {
      expect(chartCustomId("period", anchored)).toBe(
        "chart:p:BHP:combined:6m:20261104:20261029",
      );
      expect(activityCustomId(anchored)).toBe(
        "activity:BHP:combined:6m:20261104:20261029",
      );
      expect(parseCustomId(chartCustomId("view", anchored))).toEqual({
        kind: "chart",
        state: anchored,
      });
      expect(parseCustomId(activityCustomId(anchored))).toEqual({
        kind: "activity",
        state: anchored,
      });
    });

    it("still reads a live id as live", () => {
      const parsed = parseCustomId("chart:p:BHP:combined:6m");
      expect(parsed).toEqual({ kind: "chart", state });
      expect(parsed?.kind === "chart" && parsed.state.anchor).toBeFalsy();
    });

    it("stays inside the 100-character limit", () => {
      const longest = {
        code: "GSBW34",
        view: "combined",
        period: "max",
        anchor: { day: "2026-11-04", shorts: "2026-10-29" },
      } as const;
      expect(chartCustomId("period", longest).length).toBeLessThanOrEqual(100);
      expect(activityCustomId(longest).length).toBeLessThanOrEqual(100);
    });

    it.each([
      "chart:p:BHP:short:3m:20261104",
      "chart:p:BHP:short:3m:20261104:20261029:x",
      "chart:p:BHP:short:3m:20261104:20261109",
      "chart:p:BHP:short:3m:20260230:20260201",
      "chart:p:BHP:short:3m:2026-11-04:2026-10-29",
      "activity:BHP:short:3m:20261104",
      "activity:BHP:short:3m:x:20261029",
    ])("rejects %j rather than drawing it live", (id) => {
      expect(parseCustomId(id)).toBeNull();
    });
  });

  it("reads the stock select menu", () => {
    expect(parseCustomId("pick")).toEqual({ kind: "pick" });
  });

  it.each([
    "",
    null,
    "chart",
    "chart:x:BHP:short:1y",
    "chart:v:BHP:short",
    "chart:v:BHP:short:1y:extra",
    "chart:v:BHP:candles:1y",
    "chart:v:BHP:short:10y",
    "chart:v:B:short:1y",
    "activity:BHP:short",
    "something-else",
  ])("rejects %j", (id) => {
    expect(parseCustomId(id)).toBeNull();
  });
});
