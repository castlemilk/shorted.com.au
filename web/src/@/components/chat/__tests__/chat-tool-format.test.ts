import {
  axisFormatter,
  formatCompactDollars,
  formatDay,
  formatDayMonth,
  formatNumber,
  formatPercent,
  formatPointsChange,
  formatTradeDate,
  readingSummary,
  seriesSubtitle,
  seriesTitle,
  shortPositionSummary,
  tickDecimals,
  tradeTypeLabel,
  valueFormatter,
} from "../chat-tool-format";

describe("number formatting", () => {
  it("shows a percentage to two decimals", () => {
    expect(formatPercent(8.9)).toBe("8.90%");
    expect(formatPercent(15.92826069)).toBe("15.93%");
  });

  it("signs a change in points, with the minus sign for a fall", () => {
    expect(formatPointsChange(1.234)).toBe("+1.23 pp");
    expect(formatPointsChange(0)).toBe("0.00 pp");
    expect(formatPointsChange(-0.4)).toMatch(/^[-−]0\.40 pp$/);
  });

  it("reads a unit as its words, prefix or suffix, never as the raw id", () => {
    expect(formatNumber(1234.5, "aud")).toBe("$1,234.5");
    expect(formatNumber(1.09, "usd_per_eur")).toBe("US$1.09 per euro");
    expect(formatNumber(412.5, "megalitres")).toBe("412.5 ML");
    expect(formatNumber(-2.5, "usd_millions")).toBe("-US$2.5 million");
    expect(formatNumber(101.2, "index")).toBe("101.2");
  });

  it("drops a unit it does not know, rather than printing its id", () => {
    expect(formatNumber(1234.5, "AUD million")).toBe("1,234.5");
    expect(formatNumber(7, "widgets_per_frob")).toBe("7");
    expect(formatNumber(7, "constructor")).toBe("7");
    expect(valueFormatter("widgets_per_frob")(7)).toBe("7");
  });

  it("shows a percentage reading to two decimals", () => {
    expect(valueFormatter("percent")(12.34)).toBe("12.34%");
  });
});

describe("axis ticks", () => {
  it("gives a whole-step axis no decimals, and a tenth step one", () => {
    expect(tickDecimals([0, 2, 4, 6])).toBe(0);
    expect(tickDecimals([10, 10.5, 11])).toBe(1);
    expect(tickDecimals([0.25, 0.5, 0.75])).toBe(2);
  });

  it("gives a step of a half-hundredth the three places that print it", () => {
    expect(tickDecimals([15.92, 15.925, 15.93, 15.935, 15.94])).toBe(3);
  });

  it("ignores ticks that are not numbers and a single tick", () => {
    expect(tickDecimals([NaN, 3])).toBe(0);
    expect(tickDecimals([3])).toBe(0);
  });

  it("prints adjacent percentage ticks apart, on a narrow range", () => {
    // Ticks a hundredth of a point apart: one decimal printed 15.9% twice.
    const ticks = [15.92, 15.93, 15.94];
    const labels = ticks.map(axisFormatter("percent")(ticks));
    expect(labels).toEqual(["15.92%", "15.93%", "15.94%"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every tick of a coarse axis the same decimals, for a column that lines up", () => {
    const ticks = [0, 2.5, 5, 7.5, 10];
    const format = axisFormatter("percent")(ticks);
    expect(ticks.map(format)).toEqual(["0.0%", "2.5%", "5.0%", "7.5%", "10.0%"]);
  });

  it("prints a unit's short symbol on an axis, never its words", () => {
    // The subtitle names the unit once; a tick repeating "per barrel" took 40% of a narrow chart.
    expect(axisFormatter("usd_per_barrel")([60, 70, 80])(70)).toBe("US$70");
    expect(axisFormatter("sgd_per_usd")([1.3, 1.35, 1.4])(1.35)).toBe("1.35");
    expect(axisFormatter("aud")([1000, 2000])(2000)).toBe("$2,000");
    expect(axisFormatter(undefined)([1, 2])(2)).toBe("2");
  });

  it("formats compact dollars for a narrow column", () => {
    expect(formatCompactDollars(1_234_000)).toBe("$1.2M");
    expect(formatCompactDollars(950)).toBe("$950");
  });
});

describe("dates", () => {
  it("shows a reading's day in the Sydney calendar", () => {
    expect(formatDay(Date.parse("2026-10-19T00:00:00Z"))).toBe("19 Oct 2026");
  });

  it("shows a day and month with no year, for a column that already names the period", () => {
    expect(formatDayMonth(Date.parse("2026-10-14T00:00:00Z"))).toBe("14 Oct");
  });

  it("shows a date-only trade date as the day it names", () => {
    expect(formatTradeDate("2026-09-11")).toBe("11 Sep 2026");
  });

  it("writes September as Sep in every chat date, never Sept, and does not pad the day", () => {
    // en-AU's own short month is "Sept"; the chat names its months from one list.
    const september = Date.parse("2026-09-02T12:00:00Z");
    expect(formatDay(september)).toBe("2 Sep 2026");
    expect(formatDayMonth(september)).toBe("2 Sep");
    expect(formatTradeDate("2026-09-02")).toBe("2 Sep 2026");
    expect(formatDay(Date.parse("2026-10-08T12:00:00Z"))).toBe("8 Oct 2026");
  });

  it("shows text that does not parse as it came", () => {
    expect(formatTradeDate("sometime in September")).toBe("sometime in September");
  });
});

describe("labels", () => {
  it("names a trade type in words, and sentence-cases an unknown one", () => {
    expect(tradeTypeLabel("buy")).toBe("Buy");
    expect(tradeTypeLabel("exercise_options")).toBe("Option exercise");
    expect(tradeTypeLabel("on_market_sale")).toBe("On market sale");
  });

  it("titles a series by its family, metric and place", () => {
    expect(seriesTitle("rates.cash_rate_target.aus", "Australia")).toBe(
      "Rates · Cash rate target · Australia",
    );
    expect(seriesTitle("cpi.annual_change.all_groups.aus", "Australia")).toBe(
      "CPI · Annual change · Australia",
    );
    expect(seriesTitle("labour.unemployment_rate.total.nsw.seasadj", "New South Wales")).toBe(
      "Labour · Unemployment rate · New South Wales",
    );
  });

  it("titles an unknown family by its own name", () => {
    expect(seriesTitle("widgets.output.aus")).toBe("Widgets · Output");
  });

  it("subtitles a series by unit and frequency", () => {
    expect(seriesSubtitle("percent", "monthly")).toBe("Percent · Monthly");
    expect(seriesSubtitle("usd_per_barrel", "monthly")).toBe("US dollars per barrel · Monthly");
    expect(seriesSubtitle(undefined, undefined)).toBe("");
  });

  it("leaves an unknown unit out of the subtitle, not its raw id", () => {
    expect(seriesSubtitle("widgets_per_frob", "annual")).toBe("Annual");
  });
});

describe("summaries", () => {
  const points = [
    { t: Date.parse("2026-10-01T00:00:00Z"), v: 5 },
    { t: Date.parse("2026-10-08T00:00:00Z"), v: 2 },
    { t: Date.parse("2026-10-15T00:00:00Z"), v: 9 },
  ];

  it("states the first, latest, low and high readings with their days", () => {
    expect(readingSummary(points, formatPercent)).toBe(
      "First 5.00% on 1 Oct 2026, latest 9.00% on 15 Oct 2026. Low 2.00% on 8 Oct 2026, high 9.00% on 15 Oct 2026.",
    );
  });

  it("is empty with no readings", () => {
    expect(readingSummary([], formatPercent)).toBe("");
  });

  it("says how many readings it shows when the period was thinned", () => {
    expect(
      shortPositionSummary({ points, totalObservations: 254, downsampled: true }),
    ).toMatch(/Showing 3 of 254 readings\.$/);
  });

  it("says nothing extra when every reading is shown", () => {
    const text = shortPositionSummary({ points, totalObservations: 3, downsampled: false });
    expect(text).not.toMatch(/Showing/);
  });
});
