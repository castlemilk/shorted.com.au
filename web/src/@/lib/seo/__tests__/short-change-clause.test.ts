import {
  thirtyDayChange,
  thirtyDayChangeClause,
} from "~/@/lib/seo/short-change-clause";

const series = (spec: Array<[string, number]>) =>
  spec.map(([date, pct]) => ({ date, pct }));

describe("thirtyDayChange", () => {
  it("takes the last report on or before 30 days ago", () => {
    const points = series([
      ["2026-08-28", 9.63],
      ["2026-08-31", 9.81],
      ["2026-09-01", 9.94],
      ["2026-09-30", 13.58],
    ]);
    // 30 days before 30 Sep is 31 Aug: that report, not 1 Sep's.
    expect(thirtyDayChange(points)).toBeCloseTo(13.58 - 9.81, 6);
  });

  it("is null when the record does not reach back 30 days", () => {
    expect(thirtyDayChange(series([["2026-09-20", 1], ["2026-09-30", 2]]))).toBeNull();
    expect(thirtyDayChange(series([["2026-09-30", 2]]))).toBeNull();
    expect(thirtyDayChange([])).toBeNull();
  });
});

describe("thirtyDayChangeClause", () => {
  const base: Array<[string, number]> = [["2026-08-30", 10]];

  it("phrases a rise and a fall to two decimals, in points", () => {
    expect(thirtyDayChangeClause(series([...base, ["2026-09-30", 10.643]]))).toBe(
      ", up 0.64 points in 30 days",
    );
    expect(thirtyDayChangeClause(series([...base, ["2026-09-30", 8.8]]))).toBe(
      ", down 1.20 points in 30 days",
    );
  });

  it("calls a move under 0.05 points unchanged, and says nothing without a record", () => {
    expect(thirtyDayChangeClause(series([...base, ["2026-09-30", 10.04]]))).toBe(
      ", unchanged over 30 days",
    );
    expect(thirtyDayChangeClause(series([["2026-09-30", 10]]))).toBe("");
  });
});
