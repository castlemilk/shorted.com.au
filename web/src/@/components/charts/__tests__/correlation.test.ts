import { pearson } from "../correlation";

describe("pearson", () => {
  it("is 1 for perfectly correlated, -1 for anti, ~0 for none", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 5);
  });
  it("returns 0 (not NaN) for <2 points or zero variance", () => {
    expect(pearson([5], [5])).toBe(0);
    expect(pearson([1, 1, 1], [2, 3, 4])).toBe(0);
    expect(pearson([], [])).toBe(0);
  });
  it("returns 0 (not NaN) when any input value is non-finite", () => {
    expect(pearson([1, NaN, 3], [1, 2, 3])).toBe(0);
    expect(pearson([1, 2, 3], [1, Infinity, 3])).toBe(0);
  });
});
