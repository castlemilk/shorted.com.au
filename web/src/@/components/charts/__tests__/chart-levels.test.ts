import { layoutLevels } from "../chart-levels";

// x: 10 ms per px over a 0..1000 ms domain (0..100 px); y: 100 - value.
const x = (t: number) => t / 10;
const yFor = () => (v: number) => 100 - v;
const base = { x, yFor, innerW: 100, innerH: 100, levels: [], bands: [], markers: [] };

describe("layoutLevels", () => {
  it("spans a level across the plot when it has no range, and clamps a ranged one", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 40, label: "SMA 200 $40", color: "#f00" },
        { axis: "left", value: 60, label: "Pivot $60", color: "#0f0", from: -500, to: 300, dash: "4,3" },
      ],
    });
    expect(levels).toEqual([
      { x1: 0, x2: 100, y: 60, label: "SMA 200 $40", color: "#f00", dash: undefined },
      { x1: 0, x2: 30, y: 40, label: "Pivot $60", color: "#0f0", dash: "4,3" },
    ]);
  });

  it("drops a level outside the plot or with no visible width", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 150, label: "above", color: "#000" },
        { axis: "left", value: 50, label: "before", color: "#000", from: -900, to: -100 },
        { axis: "left", value: 50, label: "after", color: "#000", from: 1200, to: 1400 },
      ],
    });
    expect(levels).toEqual([]);
  });

  it("clips a band that starts before the domain and drops one entirely outside", () => {
    const { bands } = layoutLevels({
      ...base,
      bands: [
        { axis: "left", low: 20, high: 30, from: -400, to: 400, color: "#00f", label: "base" },
        { axis: "left", low: 20, high: 30, from: 2000, to: 3000, color: "#00f" },
      ],
    });
    expect(bands).toEqual([{ x: 0, y: 70, width: 40, height: 10, color: "#00f", label: "base" }]);
  });

  it("keeps markers inside the plot only", () => {
    const { markers } = layoutLevels({
      ...base,
      markers: [
        { t: 250, label: "breakout", color: "#f90" },
        { t: 5000, label: "gone", color: "#f90" },
      ],
    });
    expect(markers).toEqual([{ x: 25, label: "breakout", color: "#f90" }]);
  });

  it("uses the right axis scale for right-axis levels", () => {
    const yRight = (v: number) => 200 - v;
    const { levels } = layoutLevels({
      ...base,
      yFor: (axis) => (axis === "right" ? yRight : (v: number) => 100 - v),
      innerH: 200,
      levels: [{ axis: "right", value: 50, label: "5% short", color: "#000" }],
    });
    expect(levels[0]!.y).toBe(150);
  });
});

// The rules the five tests above leave open: inclusive plot edges, the other
// side of each bound, bounds given the wrong way round, and the guards for a
// scale that cannot place a value.
describe("layoutLevels edges", () => {
  it("keeps a level on the plot edge and drops one below the plot or one the scale cannot place", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 100, label: "top edge", color: "#000" },
        { axis: "left", value: 0, label: "bottom edge", color: "#000" },
        { axis: "left", value: -20, label: "below", color: "#000" },
        { axis: "left", value: NaN, label: "unplaceable", color: "#000" },
      ],
    });
    expect(levels.map((l) => [l.label, l.y])).toEqual([
      ["top edge", 0],
      ["bottom edge", 100],
    ]);
  });

  it("lays out a band that starts inside the plot, whichever way round its bounds are given", () => {
    const band = { axis: "left" as const, from: 200, to: 600, color: "#00f" };
    const { bands } = layoutLevels({
      ...base,
      bands: [
        { ...band, low: 20, high: 30 },
        { ...band, low: 30, high: 20 },
      ],
    });
    const expected = { x: 20, y: 70, width: 40, height: 10, color: "#00f", label: undefined };
    expect(bands).toEqual([expected, expected]);
  });

  it("clips a band to the plot vertically, drops one with no height and reads its own axis", () => {
    const yRight = (v: number) => 200 - v;
    const { bands } = layoutLevels({
      ...base,
      yFor: (axis) => (axis === "right" ? yRight : (v: number) => 100 - v),
      innerH: 200,
      bands: [
        { axis: "left", low: 90, high: 250, from: 0, to: 500, color: "#00f" },
        { axis: "left", low: 300, high: 320, from: 0, to: 500, color: "#00f" },
        { axis: "right", low: 50, high: 60, from: 0, to: 500, color: "#00f" },
      ],
    });
    expect(bands.map((b) => [b.y, b.height])).toEqual([
      [0, 10],
      [140, 10],
    ]);
  });

  it("drops a marker before the domain and one the scale cannot place", () => {
    const { markers } = layoutLevels({
      ...base,
      x: (t) => (t === 7 ? NaN : t / 10),
      markers: [
        { t: -100, label: "before", color: "#f90" },
        { t: 7, label: "unplaceable", color: "#f90" },
        { t: 0, label: "first session", color: "#f90" },
      ],
    });
    expect(markers).toEqual([{ x: 0, label: "first session", color: "#f90" }]);
  });
});
