import { formatDividendYield } from "./format-dividend-yield";

describe("formatDividendYield", () => {
  it("treats values <= 1 as fractions (legacy yfinance convention)", () => {
    expect(formatDividendYield(0.032)).toBe("3.20%");
    expect(formatDividendYield(0.005)).toBe("0.50%");
    expect(formatDividendYield(1)).toBe("100.00%");
  });

  it("treats values in (1, 100] as percents (current yfinance convention)", () => {
    expect(formatDividendYield(3.2)).toBe("3.20%");
    expect(formatDividendYield(12.5)).toBe("12.50%");
    expect(formatDividendYield(100)).toBe("100.00%");
  });

  it("undoes double-scaling for values > 100 (fraction-era ×100 applied to a percent)", () => {
    // The CBA bug: stored 320 rendered as 32000.00%; must render 3.20%.
    expect(formatDividendYield(320)).toBe("3.20%");
    expect(formatDividendYield(450)).toBe("4.50%");
  });

  it("never renders yields above 100%", () => {
    // Still implausible after undoing one scaling → render nothing.
    expect(formatDividendYield(32000)).toBeNull();
    expect(formatDividendYield(10001)).toBeNull();
  });

  it("parses numeric strings", () => {
    expect(formatDividendYield("0.032")).toBe("3.20%");
    expect(formatDividendYield("3.2")).toBe("3.20%");
    expect(formatDividendYield("320")).toBe("3.20%");
  });

  it("returns null for missing, zero, negative, or non-numeric values", () => {
    expect(formatDividendYield(null)).toBeNull();
    expect(formatDividendYield(undefined)).toBeNull();
    expect(formatDividendYield(0)).toBeNull();
    expect(formatDividendYield(-3.2)).toBeNull();
    expect(formatDividendYield(NaN)).toBeNull();
    expect(formatDividendYield(Infinity)).toBeNull();
    expect(formatDividendYield("")).toBeNull();
    expect(formatDividendYield("0000")).toBeNull();
    expect(formatDividendYield("not a number")).toBeNull();
  });
});
