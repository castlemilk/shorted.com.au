import { formatDividendYield } from "./format-dividend-yield";

describe("formatDividendYield", () => {
  describe("with an explicit unit (no guessing)", () => {
    it("reads fractions as fractions", () => {
      expect(formatDividendYield(0.032, "fraction")).toBe("3.20%");
      expect(formatDividendYield(0.008, "fraction")).toBe("0.80%");
    });

    it("reads percents as percents, including sub-1% yields", () => {
      // The defect the unit fixes: a genuine 0.8% yield read as 80%.
      expect(formatDividendYield(0.8, "percent")).toBe("0.80%");
      expect(formatDividendYield(1, "percent")).toBe("1.00%");
      expect(formatDividendYield(3.2, "percent")).toBe("3.20%");
      expect(formatDividendYield(0.2, "percent")).toBe("0.20%");
    });

    it("never undoes a scaling it was told is correct, and caps at 100%", () => {
      expect(formatDividendYield(320, "percent")).toBeNull();
      expect(formatDividendYield(2, "fraction")).toBeNull();
    });
  });

  describe("auto (the legacy mixed-unit field)", () => {
    it("treats small values (< 0.25, a < 25% yield) as fractions", () => {
      expect(formatDividendYield(0.032)).toBe("3.20%");
      expect(formatDividendYield(0.005)).toBe("0.50%");
    });

    it("treats 0.25 to 1 as a percent: a 25-100% yield is not an ASX yield", () => {
      expect(formatDividendYield(0.8)).toBe("0.80%");
      expect(formatDividendYield(0.5)).toBe("0.50%");
      expect(formatDividendYield(1)).toBe("1.00%");
    });

    it("treats values in (1, 100] as percents (current yfinance convention)", () => {
      expect(formatDividendYield(3.2)).toBe("3.20%");
      expect(formatDividendYield(12.5)).toBe("12.50%");
      expect(formatDividendYield(100)).toBe("100.00%");
    });

    it("undoes double-scaling for values > 100 (fraction-era x100 applied to a percent)", () => {
      // The CBA bug: stored 320 rendered as 32000.00%; must render 3.20%.
      expect(formatDividendYield(320)).toBe("3.20%");
      expect(formatDividendYield(450)).toBe("4.50%");
    });

    it("never renders yields above 100%", () => {
      // Still implausible after undoing one scaling: render nothing.
      expect(formatDividendYield(32000)).toBeNull();
      expect(formatDividendYield(10001)).toBeNull();
    });

    it("parses numeric strings", () => {
      expect(formatDividendYield("0.032")).toBe("3.20%");
      expect(formatDividendYield("3.2")).toBe("3.20%");
      expect(formatDividendYield("320")).toBe("3.20%");
    });
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
    expect(formatDividendYield(null, "percent")).toBeNull();
  });
});
