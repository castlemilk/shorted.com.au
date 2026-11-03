import {
  anchorQuery,
  chartPeriodPhrase,
  anchoredWindows,
  compactDay,
  expandDay,
  formatAnchorDay,
  isIsoDay,
  isSettledAnchor,
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
  const day = "2026-11-04";

  it("keeps all three days", () => {
    expect(
      parseChartAnchor({ day, shorts: "2026-10-28", prices: "2026-11-03" }),
    ).toEqual({ day, shorts: "2026-10-28", prices: "2026-11-03" });
  });

  it("takes the day for a missing, invalid or later shorts or prices day", () => {
    expect(parseChartAnchor({ day })).toEqual({ day, shorts: day, prices: day });
    expect(
      parseChartAnchor({ day, shorts: "nope", prices: "2026-11-09" }),
    ).toEqual({ day, shorts: day, prices: day });
    expect(parseChartAnchor({ day, shorts: "2009-12-31" })?.shorts).toBe(day);
  });

  it.each([null, undefined, "", "yesterday", "2026-02-30", "2009-12-31"])(
    "is live for the day %j",
    (d) => {
      expect(parseChartAnchor({ day: d, shorts: "2026-10-28" })).toBeNull();
    },
  );

  it("is live for a day after today", () => {
    expect(parseChartAnchor({ day: "2026-11-05" }, "2026-11-04")).toBeNull();
    expect(parseChartAnchor({ day }, "2026-11-04")?.day).toBe(day);
  });

  it("reads and writes the query parameters", () => {
    const params = new URLSearchParams(
      "asof=2026-11-04&shorts=2026-10-28&prices=2026-11-03",
    );
    const anchor = readChartAnchor(params, "2026-11-04");
    expect(anchor).toEqual({
      day: "2026-11-04",
      shorts: "2026-10-28",
      prices: "2026-11-03",
    });
    expect(anchorQuery(anchor)).toEqual({
      asof: "2026-11-04",
      shorts: "2026-10-28",
      prices: "2026-11-03",
    });
    expect(anchorQuery({ day, shorts: day, prices: day })).toEqual({
      asof: day,
      shorts: undefined,
      prices: undefined,
    });
    expect(anchorQuery(null)).toEqual({});
    expect(readChartAnchor(params, "2026-11-03")).toBeNull();
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

  it("counts the period back from the newest close, for both series", () => {
    expect(
      anchoredWindows("1m", {
        day: "2026-11-04",
        shorts: "2026-10-28",
        prices: "2026-11-03",
      }),
    ).toEqual({
      prices: { from: "2026-10-04", to: "2026-11-03" },
      shorts: { from: "2026-10-04", to: "2026-10-28" },
    });
  });

  it("draws no short window for a stock ASIC stopped reporting", () => {
    // Its last report is before the period starts: from > to, nothing to draw.
    const { shorts } = anchoredWindows("3m", {
      day: "2026-11-04",
      shorts: "2025-10-15",
      prices: "2026-11-03",
    });
    expect(shorts).toEqual({ from: "2026-08-04", to: "2025-10-15" });
  });

  it("counts back from the newest report when the prices stopped earlier", () => {
    // Suspended since March: the axis still ends on the newest report, so a
    // month is a month, and the price window is empty, as on the live chart.
    expect(
      anchoredWindows("1m", {
        day: "2026-11-04",
        shorts: "2026-10-28",
        prices: "2026-03-10",
      }),
    ).toEqual({
      prices: { from: "2026-09-29", to: "2026-03-10" },
      shorts: { from: "2026-09-29", to: "2026-10-28" },
    });
  });

  it("reaches prices back ten years on MAX, and short positions to the start", () => {
    expect(
      anchoredWindows("max", {
        day: "2026-03-01",
        shorts: "2026-02-23",
        prices: "2026-02-27",
      }),
    ).toEqual({
      prices: { from: "2016-02-28", to: "2026-02-27" },
      shorts: { to: "2026-02-23" },
    });
  });
});

describe("isSettledAnchor", () => {
  const today = "2026-11-12";

  it("is settled two days after posting with a report a week old", () => {
    expect(
      isSettledAnchor(
        { day: "2026-11-10", shorts: "2026-11-04", prices: "2026-11-09" },
        today,
      ),
    ).toBe(true);
  });

  it("is not settled while the evening sweep or ASIC may still add data", () => {
    expect(
      isSettledAnchor(
        { day: "2026-11-11", shorts: "2026-11-04", prices: "2026-11-10" },
        today,
      ),
    ).toBe(false);
    // A hand-made link with no shorts day reads reports up to the day itself.
    expect(
      isSettledAnchor(
        { day: "2026-11-10", shorts: "2026-11-10", prices: "2026-11-10" },
        today,
      ),
    ).toBe(false);
  });
});

describe("chartPeriodPhrase", () => {
  it("is the live phrase without an anchor", () => {
    expect(chartPeriodPhrase("3m")).toBe("past 3 months");
  });

  it("names the posting day with one", () => {
    const anchor = { day: "2026-11-04", shorts: "2026-10-28", prices: "2026-11-03" };
    expect(chartPeriodPhrase("3m", anchor)).toBe("3 months to 4 Nov 2026");
    expect(chartPeriodPhrase("max", anchor)).toBe("all history to 4 Nov 2026");
  });
});
