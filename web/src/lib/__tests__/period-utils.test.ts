import { formatPeriodForAPI } from "../period-utils";

describe("formatPeriodForAPI", () => {
  it("should convert lowercase periods to uppercase", () => {
    expect(formatPeriodForAPI("3m")).toBe("3M");
    expect(formatPeriodForAPI("6m")).toBe("6M");
    expect(formatPeriodForAPI("1y")).toBe("1Y");
    expect(formatPeriodForAPI("2y")).toBe("2Y");
    expect(formatPeriodForAPI("max")).toBe("MAX");
  });

  it("should handle already uppercase periods", () => {
    expect(formatPeriodForAPI("3M")).toBe("3M");
    expect(formatPeriodForAPI("6M")).toBe("6M");
    expect(formatPeriodForAPI("1Y")).toBe("1Y");
  });

  it("should handle mixed case periods", () => {
    expect(formatPeriodForAPI("3M")).toBe("3M");
    expect(formatPeriodForAPI("6m")).toBe("6M");
    expect(formatPeriodForAPI("1Y")).toBe("1Y");
  });

  it("should handle valid backend periods", () => {
    const validPeriods = ["1D", "1W", "1M", "3M", "6M", "1Y"];

    validPeriods.forEach((period) => {
      expect(formatPeriodForAPI(period.toLowerCase())).toBe(period);
    });
  });
});
