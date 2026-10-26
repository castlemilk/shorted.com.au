import {
  VOLUME_BAR_FILL,
  VOLUME_BAR_MAX_W,
  VOLUME_BAR_MIN_W,
  volumeBarAt,
  volumeBarWidth,
  volumeBarsPath,
  type VolumeBarGeometry,
} from "../volume-bars";
import type { ChartPoint } from "../types";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday

// 10px a day keeps the numbers round and every bar under the cap.
const geometry = (width = 400): VolumeBarGeometry => ({
  x: (t) => ((t - T0) / DAY) * 10,
  y: (v) => 100 - v, // baseline 100, a volume of 40 reaches y = 60
  baseline: 100,
  width,
});

const at = (day: number, v: number): ChartPoint => ({ t: T0 + day * DAY, v });

/** The rectangles in a path `d`, as [left, top, right] triples. */
function rects(d: string): number[][] {
  return [...d.matchAll(/M([\d.]+),[\d.]+V([\d.]+)H([\d.]+)V[\d.]+Z/g)].map((m) =>
    [m[1], m[2], m[3]].map(Number),
  );
}

describe("volumeBarWidth", () => {
  it("takes its share of the gap to the NEARER neighbour, so a Monday is as wide as a Tuesday", () => {
    // Fri, then Mon (3 days on), then Tue (1 day on): 30px then 10px apart.
    const xs = [0, 30, 40];
    expect(volumeBarWidth(xs, 1)).toBeCloseTo(10 * VOLUME_BAR_FILL);
    expect(volumeBarWidth(xs, 2)).toBeCloseTo(10 * VOLUME_BAR_FILL);
  });

  it("is never wider than the cap however few sessions show", () => {
    expect(volumeBarWidth([0, 300], 0)).toBe(VOLUME_BAR_MAX_W);
  });

  it("is never narrower than a pixel however many sessions show", () => {
    expect(volumeBarWidth([0, 0.2, 0.4], 1)).toBe(VOLUME_BAR_MIN_W);
  });

  it("gives a lone session a bar of its own", () => {
    expect(volumeBarWidth([50], 0)).toBeGreaterThan(VOLUME_BAR_MIN_W);
  });
});

describe("volumeBarsPath", () => {
  it("draws one closed rectangle per session, all in one path", () => {
    const points = [at(0, 10), at(1, 40), at(2, 25)];
    const d = volumeBarsPath(points, geometry());
    const bars = rects(d);
    expect(bars).toHaveLength(3);
    // Each bar stands on the baseline and reaches its own volume.
    expect(bars.map(([, top]) => top)).toEqual([90, 60, 75]);
    // Centred on its session: day 1 is x = 10, its bar 7px wide.
    const [left, , right] = bars[1]!;
    expect((left! + right!) / 2).toBeCloseTo(10);
    expect(right! - left!).toBeCloseTo(10 * VOLUME_BAR_FILL);
  });

  it("cuts the end bars at the plot's edges instead of drawing over the axes", () => {
    // Bars at x = 0 and x = 10, 7px wide, on a plot 12px wide.
    const bars = rects(volumeBarsPath([at(0, 10), at(1, 10)], geometry(12)));
    expect(bars[0]![0]).toBe(0);
    expect(bars[1]![2]).toBe(12);
  });

  it("draws nothing for a session with no volume, and nothing at all for none", () => {
    expect(rects(volumeBarsPath([at(0, 0), at(1, 5)], geometry()))).toHaveLength(1);
    expect(volumeBarsPath([], geometry())).toBe("");
  });
});

describe("volumeBarAt", () => {
  const points = [at(0, 10), at(1, 40), at(2, 25), at(5, 30)];

  it("is the bar of the session nearest the time, as the reading's own point is", () => {
    const bar = volumeBarAt(points, T0 + 1.2 * DAY, geometry())!;
    expect(bar.y).toBe(60);
    expect(bar.x + bar.width / 2).toBeCloseTo(10);
    expect(bar.height).toBe(40);
  });

  it("is as wide as the same bar in the full path", () => {
    const bar = volumeBarAt(points, T0 + 5 * DAY, geometry())!;
    const full = rects(volumeBarsPath(points, geometry()))[3]!;
    expect(bar.x).toBeCloseTo(full[0]!);
    expect(bar.x + bar.width).toBeCloseTo(full[2]!);
  });

  it("takes the last session past the end and the first before the start", () => {
    expect(volumeBarAt(points, T0 + 30 * DAY, geometry())!.y).toBe(70);
    expect(volumeBarAt(points, T0 - 30 * DAY, geometry())!.y).toBe(90);
  });

  it("is null without volume", () => {
    expect(volumeBarAt([], T0, geometry())).toBeNull();
  });
});
