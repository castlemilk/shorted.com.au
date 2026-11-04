import { sparkline } from "../sparkline";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const at = (day: number, v: number) => ({ t: T0 + day * DAY, v });

const OPTS = { width: 100, height: 50, pad: 0 };

/** The [x, y] pairs of a path's `d`. */
function pairs(d: string): number[][] {
  return [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
}

describe("sparkline", () => {
  it("maps the first and last session to the left and right edges", () => {
    const g = sparkline({ ...OPTS, strategy: [at(0, 10), at(10, 20)] });
    expect(pairs(g.strategy)[0]![0]).toBe(0);
    expect(pairs(g.strategy)[1]![0]).toBe(100);
  });

  it("puts the highest value at the top and the lowest at the bottom", () => {
    const g = sparkline({ ...OPTS, strategy: [at(0, 10), at(10, 20)] });
    expect(pairs(g.strategy)[0]![1]).toBe(50);
    expect(pairs(g.strategy)[1]![1]).toBe(0);
  });

  it("shares one scale between the strategy and the benchmark", () => {
    const g = sparkline({
      ...OPTS,
      strategy: [at(0, 10), at(10, 20)],
      benchmark: [at(0, 10), at(10, 15)],
    });
    // The benchmark's top, 15, sits halfway between 10 (bottom) and 20 (top).
    expect(pairs(g.benchmark!)[1]![1]).toBe(25);
  });

  it("draws a flat series mid-height, not on an edge", () => {
    const g = sparkline({ ...OPTS, strategy: [at(0, 5), at(10, 5)] });
    expect(pairs(g.strategy)[0]![1]).toBe(25);
  });

  it("returns an empty path and no benchmark when there is no finite point", () => {
    const g = sparkline({ ...OPTS, strategy: [{ t: Number.NaN, v: 1 }] });
    expect(g).toEqual({ strategy: "", benchmark: null, live: null });
  });

  it("shades the recorded span from the freeze date to the right edge", () => {
    const g = sparkline({
      ...OPTS,
      strategy: [at(0, 10), at(10, 20)],
      liveFrom: T0 + 5 * DAY,
    });
    expect(g.live).toEqual({ x: 50, width: 50 });
  });

  it("shades nothing when the freeze date is after the series", () => {
    const g = sparkline({
      ...OPTS,
      strategy: [at(0, 10), at(10, 20)],
      liveFrom: T0 + 30 * DAY,
    });
    expect(g.live).toBeNull();
  });

  it("shades the whole plot when the freeze date is before the series", () => {
    const g = sparkline({
      ...OPTS,
      strategy: [at(0, 10), at(10, 20)],
      liveFrom: T0 - 5 * DAY,
    });
    expect(g.live).toEqual({ x: 0, width: 100 });
  });
});
