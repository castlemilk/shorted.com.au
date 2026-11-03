import {
  anchorQuery,
  chartPeriodPhrase,
  anchoredWindows,
  compactDay,
  dayBefore,
  expandDay,
  formatAnchorDay,
  isIsoDay,
  parseChartAnchor,
  periodWindow,
  readChartAnchor,
  sydneyDay,
} from "../chart-anchor";

describe("isIsoDay", () => {
  it.each(["2026-11-04", "2024-02-29", "2000-01-01"])("accepts %s", (d) => {
    expect(isIsoDay(d)).toBe(true);
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-1-4",
    "20261104",
    " 2026-11-04",
    "",
    null,
    42,
  ])("rejects %j", (d) => {
    expect(isIsoDay(d)).toBe(false);
  });
});

describe("parseChartAnchor", () => {
  it("keeps both days", () => {
    expect(parseChartAnchor("2026-11-04", "2026-10-29")).toEqual({
      day: "2026-11-04",
      shorts: "2026-10-29",
    });
  });

  it("takes the day for a missing or invalid shorts day", () => {
    const day = "2026-11-04";
    expect(parseChartAnchor(day)).toEqual({ day, shorts: day });
    expect(parseChartAnchor(day, "nope")).toEqual({ day, shorts: day });
  });

  it("pulls a shorts day after the day back to it", () => {
    expect(parseChartAnchor("2026-11-04", "2026-11-09")).toEqual({
      day: "2026-11-04",
      shorts: "2026-11-04",
    });
  });

  it.each([null, undefined, "", "yesterday", "2026-02-30", "1999-12-31"])(
    "is live for the day %j",
    (day) => {
      expect(parseChartAnchor(day, "2026-10-29")).toBeNull();
    },
  );

  it("reads and writes the query parameters", () => {
    const params = new URLSearchParams("asof=2026-11-04&shorts=2026-10-29");
    const anchor = readChartAnchor(params);
    expect(anchor).toEqual({ day: "2026-11-04", shorts: "2026-10-29" });
    expect(anchorQuery(anchor)).toEqual({
      asof: "2026-11-04",
      shorts: "2026-10-29",
    });
    expect(
      anchorQuery({ day: "2026-11-04", shorts: "2026-11-04" }),
    ).toEqual({ asof: "2026-11-04", shorts: undefined });
    expect(anchorQuery(null)).toEqual({});
  });
});

describe("compact days", () => {
  it("round-trips", () => {
    expect(compactDay("2026-11-04")).toBe("20261104");
    expect(expandDay("20261104")).toBe("2026-11-04");
  });

  it.each(["20260230", "2026110", "2026-11-04", "", undefined])(
    "rejects %j",
    (raw) => {
      expect(expandDay(raw)).toBeNull();
    },
  );
});

describe("sydneyDay", () => {
  it("is the Sydney calendar day, not the UTC one", () => {
    // 14:30 UTC on 3 Nov is 01:30 on 4 Nov in Sydney (AEDT, UTC+11).
    expect(sydneyDay(new Date("2026-11-03T14:30:00Z"))).toBe("2026-11-04");
    expect(sydneyDay(new Date("2026-11-03T12:30:00Z"))).toBe("2026-11-03");
  });
});

describe("formatAnchorDay", () => {
  it("prints the day as the site does", () => {
    expect(formatAnchorDay("2026-11-04")).toBe("4 Nov 2026");
  });
});

describe("periodWindow", () => {
  it.each([
    ["1m", "2026-11-04", "2026-10-05"],
    ["3m", "2026-11-04", "2026-08-05"],
    ["6m", "2026-11-04", "2026-05-05"],
    ["1y", "2026-11-04", "2025-11-05"],
    ["2y", "2026-11-04", "2024-11-05"],
    // A month end clamps to the shorter month, then starts the day after.
    ["1m", "2026-03-31", "2026-03-01"],
    ["1m", "2024-03-31", "2024-03-01"],
    ["1y", "2024-02-29", "2023-03-01"],
    ["3m", "2026-01-15", "2025-10-16"],
  ] as const)("%s to %s starts on %s", (period, to, from) => {
    expect(periodWindow(period, to)).toEqual({ from, to });
  });

  it("has no start for MAX", () => {
    expect(periodWindow("max", "2026-11-04")).toEqual({ to: "2026-11-04" });
  });

  it("ends prices the day before posting, shorts on the newest report", () => {
    expect(
      anchoredWindows("1m", { day: "2026-11-04", shorts: "2026-10-28" }),
    ).toEqual({
      prices: { from: "2026-10-04", to: "2026-11-03" },
      shorts: { from: "2026-09-29", to: "2026-10-28" },
    });
    expect(
      anchoredWindows("max", { day: "2026-03-01", shorts: "2026-02-23" }),
    ).toEqual({ prices: { to: "2026-02-28" }, shorts: { to: "2026-02-23" } });
  });

  it.each([
    ["2026-11-04", "2026-11-03"],
    ["2026-03-01", "2026-02-28"],
    ["2024-03-01", "2024-02-29"],
    ["2026-01-01", "2025-12-31"],
  ])("dayBefore(%s) is %s", (day, before) => {
    expect(dayBefore(day)).toBe(before);
  });
});

describe("chartPeriodPhrase", () => {
  it("is the live phrase without an anchor", () => {
    expect(chartPeriodPhrase("3m")).toBe("past 3 months");
  });

  it("names the posting day with one", () => {
    const anchor = { day: "2026-11-04", shorts: "2026-10-29" };
    expect(chartPeriodPhrase("3m", anchor)).toBe("3 months to 4 Nov 2026");
    expect(chartPeriodPhrase("max", anchor)).toBe("all history to 4 Nov 2026");
  });
});
