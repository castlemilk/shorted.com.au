import {
  axisFormatter,
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

  it("shows a percentage reading with its unit, and any other unit after the number", () => {
    expect(formatNumber(4.35, "percent")).toBe("4.35");
    expect(formatNumber(1234.5, "AUD million")).toBe("1,234.5 AUD million");
  });

  it("uses one decimal on a percentage axis", () => {
    expect(axisFormatter("percent")(12.34)).toBe("12.3%");
    expect(valueFormatter("percent")(12.34)).toBe("12.34%");
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
    expect(formatTradeDate("2026-09-11")).toBe("11 Sept 2026");
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
    expect(seriesSubtitle(undefined, undefined)).toBe("");
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
