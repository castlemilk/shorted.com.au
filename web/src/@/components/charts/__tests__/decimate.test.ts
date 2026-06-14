import { lttbIndices, decimate } from "../decimate";

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    t: i * 1000,
    v: Math.sin(i / 5) * 10 + i * 0.1,
  }));

describe("lttbIndices", () => {
  it("returns all indices when threshold >= length", () => {
    const pts = series(50);
    expect(lttbIndices(pts, 100)).toEqual(pts.map((_, i) => i));
  });
  it("downsamples to the threshold and keeps endpoints", () => {
    const pts = series(1000);
    const idx = lttbIndices(pts, 100);
    expect(idx).toHaveLength(100);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(999);
    for (let i = 1; i < idx.length; i++)
      expect(idx[i]).toBeGreaterThan(idx[i - 1]!);
  });
  it("is deterministic", () => {
    const pts = series(1000);
    expect(lttbIndices(pts, 120)).toEqual(lttbIndices(pts, 120));
  });
  it("handles tiny inputs (<=2) by returning all", () => {
    expect(lttbIndices(series(2), 100)).toEqual([0, 1]);
    expect(lttbIndices(series(1), 100)).toEqual([0]);
    expect(lttbIndices([], 100)).toEqual([]);
  });
});

describe("decimate", () => {
  it("returns points + indices below/above threshold", () => {
    const pts = series(50);
    const small = decimate(pts, 100);
    expect(small.points).toHaveLength(50);
    const big = decimate(series(5000), 500);
    expect(big.points.length).toBeLessThanOrEqual(500 + 2); // +extrema
    expect(big.points[0]!.t).toBe(0);
  });
  it("force-keeps the global max and min v indices when keepExtrema", () => {
    const pts = series(2000);
    pts[937] = { t: 937 * 1000, v: 9999 };
    pts[1450] = { t: 1450 * 1000, v: -9999 };
    const { indices } = decimate(pts, 80, { keepExtrema: true });
    expect(indices).toContain(937);
    expect(indices).toContain(1450);
    for (let i = 1; i < indices.length; i++)
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  });
});
